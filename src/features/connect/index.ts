/**
 * SLICE: connect — the WebSocket upgrade path.
 *
 * This is the composition point for everything that must happen *before* a
 * socket exists, and it is deliberately the only place that knows the order:
 *
 *   authenticate -> ban check -> edge rate limit -> shard placement -> upgrade
 *
 * All of it runs on the edge Worker so the Durable Object receives a connection
 * that is already authenticated, un-banned and correctly placed.
 */
import type { Env } from "../../env";
import { problem, bearerToken, clientIp, type RouteDef } from "../../shared/http";
import {
  CONNECT_METADATA_HEADER,
  encodeConnectMetadata,
  hasRole,
  type ConnectMetadata,
} from "../../shared/identity";
import { newConnectionId, shardName } from "../../shared/ids";
import { defaultRoomConfig } from "../../shared/room-config";
import type { Slice } from "../../shared/slice";
import { authenticate } from "../auth";
import { checkBan } from "../ban";
import { checkEdgeRateLimit, hasLoadTestBypass } from "../rate-limit";
import { getShardCount, placementCandidates } from "../routing";

export async function handleConnect(
  req: Request,
  env: Env,
  roomId: string,
): Promise<Response> {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return problem(426, "upgrade_required", "expected a websocket upgrade");
  }

  const auth = await authenticate(req, env);
  if (!auth.ok || !auth.identity) {
    return problem(401, "unauthenticated", auth.reason ?? "invalid credentials");
  }
  const identity = auth.identity;

  const ban = await checkBan(env, roomId, identity.userId);
  if (!ban.allowed) {
    return problem(403, ban.code ?? "banned", ban.reason ?? "you are banned from this room");
  }

  // A load test opens thousands of sockets from a handful of IPs, which is the
  // exact shape the edge limit exists to stop. It skips the limit only when it
  // presents a fresh signature, and only while a bypass secret is configured at
  // all — so the people in the public room keep the limit they should have.
  if (!(await hasLoadTestBypass(req, env))) {
    const limitKey = `${clientIp(req)}|${identity.userId}`;
    const limited = await checkEdgeRateLimit(env, limitKey);
    if (!limited.allowed) {
      return problem(429, limited.code ?? "rate_limited", limited.reason ?? "too many connections", {
        retryAfterMs: limited.retryAfterMs,
      });
    }
  }

  const shardCount = await getShardCount(env, roomId);
  const connectionId = newConnectionId();
  const placementKey = `${roomId}:${identity.userId}`;
  const requestedSub = Number.parseInt(new URL(req.url).searchParams.get("sub") ?? "", 10);
  // Config lives in the coordinator and the edge deliberately does not ask it
  // on connect. Dynamic privileged roles therefore cannot select a subroom;
  // moderator, admin and system can because they are privileged by default.
  const mayChooseSub = hasRole(identity, defaultRoomConfig(roomId).privilegedRoles);
  const choseSub = mayChooseSub && Number.isInteger(requestedSub) && requestedSub >= 0;
  const candidates = choseSub ? [requestedSub] : placementCandidates(placementKey, shardCount);
  let lastResponse: Response | null = null;

  for (const shardIndex of candidates) {
    const meta: ConnectMetadata = {
      identity,
      roomId,
      shardIndex,
      connectionId,
      connectedAt: Date.now(),
    };
    const stub = env.CHAT_SHARD.get(env.CHAT_SHARD.idFromName(shardName(roomId, shardIndex)));
    const forwarded = new Request(req.url, req);
    forwarded.headers.set(CONNECT_METADATA_HEADER, encodeConnectMetadata(meta));
    const response = await stub.fetch(forwarded);
    if (response.status !== 503) return response;
    lastResponse = response;
  }

  return lastResponse ?? problem(503, "shard_full", "all shard placement candidates are full");
}

const routes: RouteDef[] = [
  {
    method: "GET",
    path: "/api/rooms/:roomId/connect",
    handler: (req, env, _ctx, { params }) => handleConnect(req, env, params.roomId!),
  },
  {
    // Convenience for the demo client / load tester: /ws/<room>?token=...
    method: "GET",
    path: "/ws/:roomId",
    handler: (req, env, _ctx, { params }) => handleConnect(req, env, params.roomId!),
  },
];

export const connectSlice: Slice = { name: "connect", routes };

export { bearerToken };
