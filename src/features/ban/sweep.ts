/**
 * `ban-sweep` — the maintenance half of the slice.
 *
 * Expired rows are never deleted on the read path (that would put a write in
 * front of a connect), so a cron reclaims them. It walks room by room with a
 * `LIMIT` so a room with thousands of lapsed bans cannot blow the subrequest or
 * CPU budget of a single cron invocation.
 */
import type { Env } from "../../env";
import { createLogger, type LogLevel } from "../../shared/logger";
import { dropHot } from "./hot-list";

const ROOMS_PER_RUN = 25;
const USERS_PER_BATCH = 100;
const MAX_BATCHES_PER_ROOM = 5;

export interface SweepResult {
  rooms: number;
  removed: number;
}

export async function sweepExpiredBans(env: Env, now: number = Date.now()): Promise<SweepResult> {
  const log = createLogger("ban-sweep", (env.LOG_LEVEL as LogLevel) ?? "info");
  const result: SweepResult = { rooms: 0, removed: 0 };

  try {
    const { results } = await env.CHAT_DB.prepare(
      `SELECT DISTINCT room_id FROM bans
       WHERE expires_at > 0 AND expires_at <= ? LIMIT ${ROOMS_PER_RUN}`,
    )
      .bind(now)
      .all<{ room_id: string }>();

    for (const { room_id: roomId } of results) {
      result.rooms++;
      result.removed += await sweepRoom(env, roomId, now);
    }
  } catch (error) {
    // A sweep is best-effort maintenance: it must never take the cron down for
    // the other slices' jobs, and locally it fires before `db:migrate:local`.
    log.warn("sweep aborted", { error: String(error), ...result });
  }

  if (result.removed > 0) log.info("expired bans reclaimed", { ...result });
  return result;
}

async function sweepRoom(env: Env, roomId: string, now: number): Promise<number> {
  let removed = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_ROOM; batch++) {
    const { results } = await env.CHAT_DB.prepare(
      `SELECT user_id FROM bans
       WHERE room_id = ? AND expires_at > 0 AND expires_at <= ? LIMIT ${USERS_PER_BATCH}`,
    )
      .bind(roomId, now)
      .all<{ user_id: string }>();
    if (results.length === 0) return removed;

    const userIds = results.map((row) => row.user_id);
    const placeholders = userIds.map(() => "?").join(",");
    await env.CHAT_DB.prepare(`DELETE FROM bans WHERE room_id = ? AND user_id IN (${placeholders})`)
      .bind(roomId, ...userIds)
      .run();

    // Reconcile the hot list: dropping the key forces the next connect to
    // re-derive the verdict from D1 instead of trusting a cached ban.
    await Promise.all(userIds.map((userId) => dropHot(env, roomId, userId)));
    removed += userIds.length;

    if (results.length < USERS_PER_BATCH) return removed;
  }
  return removed;
}
