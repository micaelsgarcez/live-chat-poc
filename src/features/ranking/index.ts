/**
 * SLICE: ranking — cron recompute into KV, read-only HTTP surface.
 *
 * Ranking is never computed on the hot path. A cron trigger aggregates D1 once
 * per room per minute and leaves a finished snapshot in KV; the read route only
 * hands that snapshot over, so a room with 300k viewers costs one KV read each
 * instead of one aggregation each.
 *
 * OWNER CONTRACT:
 *   rankingSlice      : Slice (scheduled job + GET ranking route)
 *   refreshRoomRanking: (env, roomId) => Promise<RankingSnapshot>
 *   readRanking       : (env, roomId) => Promise<RankingSnapshot | null>
 */
import type { Env } from "../../env";
import { json, problem, type RouteDef } from "../../shared/http";
import { createLogger, type Logger, type LogLevel } from "../../shared/logger";
import type { RankingSnapshot } from "../../shared/ports";
import type { ScheduledJobDef, Slice } from "../../shared/slice";
import { MINUTE } from "../../shared/time";
import { listActiveRooms, queryTopUsers, writeSnapshot } from "./query";

/** Rolling window a snapshot covers. */
export const RANKING_WINDOW_MS = 15 * MINUTE;

/**
 * KV lifetime of a snapshot. Comfortably longer than the one-minute cron so a
 * slow tick never leaves a room without a ranking, short enough that a room
 * that went quiet stops serving a stale leaderboard forever.
 */
export const RANKING_KV_TTL_SECONDS = 120;

/** Edge cache for the read path; the data is a minute old by design anyway. */
const RANKING_CACHE_TTL_SECONDS = 60;

/** Snapshots kept per room in D1, enough to see how a ranking moved. */
export const RANKING_SNAPSHOTS_KEPT = 10;

/** Ceiling per cron invocation so one run cannot exhaust the CPU budget. */
const MAX_ROOMS_PER_RUN = 50;

/** Rooms recomputed at a time: enough to hide D1 latency, not enough to flood it. */
const REFRESH_CONCURRENCY = 4;

export function rankingKey(roomId: string): string {
  return `ranking:${roomId}`;
}

/** Recomputes the room's ranking and publishes it to KV and to D1 history. */
export async function refreshRoomRanking(env: Env, roomId: string): Promise<RankingSnapshot> {
  const generatedAt = Date.now();
  const top = await queryTopUsers(env, roomId, generatedAt - RANKING_WINDOW_MS);
  const snapshot: RankingSnapshot = { roomId, generatedAt, windowMs: RANKING_WINDOW_MS, top };

  // KV first: readers matter more than history, and the history write is the
  // one that can fail without anybody noticing.
  await env.CHAT_KV.put(rankingKey(roomId), JSON.stringify(snapshot), {
    expirationTtl: RANKING_KV_TTL_SECONDS,
  });
  await writeSnapshot(env, snapshot, RANKING_SNAPSHOTS_KEPT);
  return snapshot;
}

/** Reads the published snapshot. `null` means no refresh has landed yet. */
export async function readRanking(env: Env, roomId: string): Promise<RankingSnapshot | null> {
  return env.CHAT_KV.get<RankingSnapshot>(rankingKey(roomId), {
    type: "json",
    cacheTtl: RANKING_CACHE_TTL_SECONDS,
  });
}

/**
 * Recomputes every active room. A room that throws — malformed row, D1 hiccup —
 * must not cost the other rooms their refresh, so failures are counted and
 * logged rather than propagated.
 */
async function refreshActiveRooms(
  env: Env,
  log: Logger,
): Promise<{ refreshed: number; failed: number }> {
  const pending = await listActiveRooms(env, Date.now() - RANKING_WINDOW_MS, MAX_ROOMS_PER_RUN);
  let refreshed = 0;
  let failed = 0;

  const worker = async (): Promise<void> => {
    for (let roomId = pending.shift(); roomId !== undefined; roomId = pending.shift()) {
      try {
        await refreshRoomRanking(env, roomId);
        refreshed++;
      } catch (error) {
        failed++;
        log.error("ranking refresh failed", { roomId, error: String(error) });
      }
    }
  };

  const lanes = Math.min(REFRESH_CONCURRENCY, pending.length);
  await Promise.all(Array.from({ length: lanes }, worker));
  return { refreshed, failed };
}

const rankingRefreshJob: ScheduledJobDef = {
  name: "ranking-refresh",
  cron: "*",
  async run(_controller, env) {
    const log = createLogger("ranking", (env.LOG_LEVEL as LogLevel) ?? "info");
    const { refreshed, failed } = await refreshActiveRooms(env, log);
    log.info("ranking refresh finished", { refreshed, failed });
  },
};

const routes: RouteDef[] = [
  {
    method: "GET",
    path: "/api/rooms/:roomId/ranking",
    async handler(req, env, _ctx, { params }) {
      const roomId = params.roomId!;
      const refresh = new URL(req.url).searchParams.get("refresh");
      // Cloudflare's shortest cron is one minute, which is a long time to stare
      // at an empty leaderboard in the local demo — this forces the recompute.
      if (refresh === "1" || refresh === "true") {
        return json({ ranking: await refreshRoomRanking(env, roomId) });
      }
      const ranking = await readRanking(env, roomId);
      if (!ranking) {
        return problem(404, "not_found", `no ranking snapshot for room ${roomId} yet`);
      }
      return json({ ranking });
    },
  },
];

export const rankingSlice: Slice = { name: "ranking", routes, scheduled: [rankingRefreshJob] };
