/**
 * SLICE: ban — hot list in KV, source of truth in D1.
 *
 * OWNER CONTRACT:
 *   banSlice      : Slice            (moderator routes: list/ban/unban)
 *   checkBan      : (env, roomId, userId) => Promise<ConnectGuardResult>
 *   createBanStore: (env) => BanStore
 *   applyBan      : (env, input: BanInput) => Promise<BanRecord>
 *   liftBan       : (env, roomId, userId) => Promise<void>
 *
 * Two layers, because the two callers have opposite cost profiles: `checkBan`
 * runs at the edge on every WebSocket upgrade and reads KV, while moderation
 * writes are rare and go straight to D1 before refreshing KV.
 *
 * A ban applied *after* a socket exists is not visible to the edge at all, so
 * the POST route also asks the coordinator to kick the user's live connections.
 */
import type { Env } from "../../env";
import { RejectCode } from "../../shared/errors";
import { json, noContent, problem, readJson, type RouteDef } from "../../shared/http";
import { createLogger, type LogLevel } from "../../shared/logger";
import type { BanInput, BanRecord, BanStore, ConnectGuardResult } from "../../shared/ports";
import type { Slice } from "../../shared/slice";
import { authorizeModerator } from "../auth";
import { coordinatorStub } from "../room";
import { dropHot, entryFor, isFresh, readHot, writeHot } from "./hot-list";
import { createBanStore, isActive } from "./store";
import { sweepExpiredBans } from "./sweep";

const ALLOWED: ConnectGuardResult = { allowed: true };

function denied(record: BanRecord): ConnectGuardResult {
  return {
    allowed: false,
    code: RejectCode.BANNED,
    reason: record.reason || "you are banned from this room",
    // Only meaningful for a timed ban; a permanent one has nothing to retry.
    retryAfterMs: record.expiresAt > 0 ? Math.max(0, record.expiresAt - Date.now()) : undefined,
  };
}

/**
 * Edge guard called by the connect slice.
 *
 * Fails *open*: the KV hot list plus the coordinator kick already cover the
 * common cases, and a D1 hiccup must not lock every viewer out of every room.
 */
export async function checkBan(env: Env, roomId: string, userId: string): Promise<ConnectGuardResult> {
  const now = Date.now();

  const cached = await readHot(env, roomId, userId);
  if (cached && isFresh(cached, now)) {
    if (!cached.r) return ALLOWED;
    if (isActive(cached.r, now)) return denied(cached.r);
    return ALLOWED;
  }

  try {
    const record = await createBanStore(env).isBanned(roomId, userId);
    await writeHot(env, roomId, userId, entryFor(record, now), now);
    return record ? denied(record) : ALLOWED;
  } catch (error) {
    createLogger("ban", (env.LOG_LEVEL as LogLevel) ?? "info").warn("ban lookup failed", {
      roomId,
      userId,
      error: String(error),
    });
    return ALLOWED;
  }
}

/** Writes the ban to D1 and refreshes the hot list. Does not touch live sockets. */
export async function applyBan(env: Env, input: BanInput): Promise<BanRecord> {
  const now = Date.now();
  const record: BanRecord = {
    userId: input.userId,
    roomId: input.roomId,
    reason: input.reason,
    expiresAt: input.expiresAt ?? 0,
    bannedBy: input.bannedBy,
    createdAt: now,
  };
  await createBanStore(env).ban(record);
  // Overwrites any short-lived negative entry, so the very next connect is
  // rejected instead of riding out the 30s negative cache.
  await writeHot(env, input.roomId, input.userId, entryFor(record, now), now);
  return record;
}

/** Removes the ban from D1 and invalidates the cached verdict in KV. */
export async function liftBan(env: Env, roomId: string, userId: string): Promise<void> {
  await createBanStore(env).unban(roomId, userId);
  await dropHot(env, roomId, userId);
}

/* ------------------------------------------------------------------ */
/* moderator routes                                                    */
/* ------------------------------------------------------------------ */

function storageUnavailable(env: Env, error: unknown, op: string): Response {
  createLogger("ban", (env.LOG_LEVEL as LogLevel) ?? "info").error("ban storage failed", {
    op,
    error: String(error),
  });
  return problem(503, "internal", "ban storage unavailable; run `npm run db:migrate:local`");
}

const routes: RouteDef[] = [
  {
    method: "GET",
    path: "/api/rooms/:roomId/bans",
    async handler(req, env, _ctx, { params }) {
      const moderator = await authorizeModerator(req, env);
      if (!moderator) return problem(403, "forbidden", "moderator credentials required");
      const roomId = params.roomId!;
      try {
        return json({ bans: await createBanStore(env).list(roomId) });
      } catch (error) {
        return storageUnavailable(env, error, "list");
      }
    },
  },
  {
    method: "POST",
    path: "/api/rooms/:roomId/bans",
    async handler(req, env, _ctx, { params }) {
      const moderator = await authorizeModerator(req, env);
      if (!moderator) return problem(403, "forbidden", "moderator credentials required");

      const body = await readJson<{ userId?: string; reason?: string; expiresAt?: number }>(req);
      const userId = body?.userId?.trim();
      if (!userId) return problem(400, "malformed", "userId is required");
      if (body?.expiresAt !== undefined && !Number.isFinite(body.expiresAt)) {
        return problem(400, "malformed", "expiresAt must be epoch ms (0 = permanent)");
      }

      const roomId = params.roomId!;
      let record: BanRecord;
      try {
        record = await applyBan(env, {
          roomId,
          userId,
          reason: body?.reason ?? "",
          expiresAt: body?.expiresAt,
          bannedBy: moderator.userId,
        });
      } catch (error) {
        return storageUnavailable(env, error, "ban");
      }

      // The edge only consults the hot list on *new* connections, so already
      // open sockets are closed by the coordinator fanning the kick to shards.
      const stub = coordinatorStub(env, roomId);
      await stub.init(roomId);
      await stub.banUser({
        roomId,
        userId,
        reason: record.reason,
        expiresAt: record.expiresAt,
        bannedBy: record.bannedBy,
      });

      return json({ ban: record }, { status: 201 });
    },
  },
  {
    method: "DELETE",
    path: "/api/rooms/:roomId/bans/:userId",
    async handler(req, env, _ctx, { params }) {
      const moderator = await authorizeModerator(req, env);
      if (!moderator) return problem(403, "forbidden", "moderator credentials required");
      const roomId = params.roomId!;
      const userId = params.userId!;
      try {
        await liftBan(env, roomId, userId);
      } catch (error) {
        return storageUnavailable(env, error, "unban");
      }
      await coordinatorStub(env, roomId).unbanUser(roomId, userId);
      return noContent();
    },
  },
];

export const banSlice: Slice = {
  name: "ban",
  routes,
  scheduled: [
    {
      name: "ban-sweep",
      cron: "*",
      async run(_controller, env) {
        await sweepExpiredBans(env);
      },
    },
  ],
};

export { createBanStore };
export type { BanStore };
