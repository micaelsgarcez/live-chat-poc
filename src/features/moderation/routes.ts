/**
 * Moderator HTTP surface.
 *
 * Every route is edge-side and authorised with the auth slice; none of them
 * touch a socket directly. Delete goes through the coordinator (one call, every
 * shard), mute goes straight to the one shard that owns the user — recomputing
 * the placement hash is cheaper than asking every shard whether it has them.
 */
import type { Env } from "../../env";
import { json, problem, readJson, type RouteDef } from "../../shared/http";
import { shardName } from "../../shared/ids";
import { authorizeModerator } from "../auth";
import { coordinatorStub } from "../room";
import { getShardCount, selectShardIndex } from "../routing";
import {
  listActions,
  lookupMessageAuthors,
  markMessagesDeleted,
  newActionRecord,
  recordActions,
} from "./store";

const DEFAULT_ACTION_LIMIT = 50;
const MAX_ACTION_LIMIT = 200;
const MAX_MUTE_MS = 24 * 60 * 60 * 1000;

interface DeleteBody {
  messageIds?: unknown;
  reason?: unknown;
}

interface MuteBody {
  userId?: unknown;
  ms?: unknown;
  reason?: unknown;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

function reasonOf(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : fallback;
}

export const moderationRoutes: RouteDef[] = [
  {
    method: "POST",
    path: "/api/rooms/:roomId/moderation/delete",
    async handler(req, env, _ctx, { params }) {
      const moderator = await authorizeModerator(req, env);
      if (!moderator) return problem(403, "forbidden", "moderator credentials required");

      const body = await readJson<DeleteBody>(req);
      const messageIds = stringList(body?.messageIds);
      if (messageIds.length === 0) {
        return problem(400, "malformed", "messageIds must be a non-empty array of strings");
      }
      const reason = reasonOf(body?.reason, "removed by a moderator");
      const roomId = params.roomId!;
      const now = Date.now();

      const authors = await lookupMessageAuthors(env, roomId, messageIds);
      const deleted = await markMessagesDeleted(env, roomId, messageIds, now);
      await recordActions(
        env,
        messageIds.map((messageId) =>
          newActionRecord({
            roomId,
            messageId,
            userId: authors.get(messageId) ?? null,
            action: "delete",
            reason,
            source: `manual:${moderator.userId}`,
            createdAt: now,
          }),
        ),
      );

      // The coordinator is the only thing that reaches every shard at once.
      const stub = coordinatorStub(env, roomId);
      await stub.init(roomId);
      await stub.deleteMessages(messageIds, reason);

      return json({ roomId, messageIds, deleted, reason });
    },
  },
  {
    method: "POST",
    path: "/api/rooms/:roomId/moderation/mute",
    async handler(req, env, _ctx, { params }) {
      const moderator = await authorizeModerator(req, env);
      if (!moderator) return problem(403, "forbidden", "moderator credentials required");

      const body = await readJson<MuteBody>(req);
      const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
      if (!userId) return problem(400, "malformed", "userId is required");
      const rawMs = typeof body?.ms === "number" && Number.isFinite(body.ms) ? body.ms : 0;
      if (rawMs <= 0) return problem(400, "malformed", "ms must be a positive number");
      const ms = Math.min(rawMs, MAX_MUTE_MS);
      const reason = reasonOf(body?.reason, "muted by a moderator");
      const roomId = params.roomId!;

      // Same placement the edge used at connect time, so this lands on the one
      // shard that holds the user's gate state.
      const shardCount = await getShardCount(env, roomId);
      const shardIndex = selectShardIndex(`${roomId}:${userId}`, shardCount);
      const shard = env.CHAT_SHARD.get(
        env.CHAT_SHARD.idFromName(shardName(roomId, shardIndex)),
      );

      const mutedUntil = Date.now() + ms;
      const muted = await shard.muteUsers([userId], mutedUntil, reason);
      await recordActions(env, [
        newActionRecord({
          roomId,
          messageId: null,
          userId,
          action: "mute",
          reason,
          source: `manual:${moderator.userId}`,
        }),
      ]);

      return json({ roomId, userId, shardIndex, mutedUntil, muted });
    },
  },
  {
    method: "GET",
    path: "/api/rooms/:roomId/moderation/actions",
    async handler(req, env, _ctx, { params }) {
      const moderator = await authorizeModerator(req, env);
      if (!moderator) return problem(403, "forbidden", "moderator credentials required");
      const parsed = Number.parseInt(new URL(req.url).searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_ACTION_LIMIT) : DEFAULT_ACTION_LIMIT;
      const actions = await listActions(env, params.roomId!, limit);
      return json({ roomId: params.roomId, actions });
    },
  },
];
