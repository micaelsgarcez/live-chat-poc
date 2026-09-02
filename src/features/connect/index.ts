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
  type ConnectMetadata,
} from "../../shared/identity";
import { newConnectionId, shardName } from "../../shared/ids";
import type { Slice } from "../../shared/slice";
import { authenticate } from "../auth";
import { checkBan } from "../ban";
import { checkEdgeRateLimit, hasLoadTestBypass } from "../rate-limit";
import { getShardCount, selectShardIndex } from "../routing";

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
  // Placing by user id keeps a reconnecting user on the same shard, which keeps
  // their per-user gate state (slow-mode, token bucket) warm.
  const shardIndex = selectShardIndex(`${roomId}:${identity.userId}`, shardCount);

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
  return stub.fetch(forwarded);
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
