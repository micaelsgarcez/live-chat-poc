/**
 * The coarse half of the slice: connection attempts, counted at the edge.
 *
 * Its job is not fairness — that is the token bucket's — but making a connect
 * flood die before it costs a Durable Object anything. Cloudflare's native Rate
 * Limiting binding does this properly, but it only exists in staging and
 * production, so locally we count in KV instead.
 */
import type { Env } from "../../env";
import { RejectCode } from "../../shared/errors";
import { createLogger, type LogLevel } from "../../shared/logger";
import type { ConnectGuardResult } from "../../shared/ports";
import { MINUTE } from "../../shared/time";

/**
 * Connection attempts allowed per key per minute.
 *
 * A legitimate client opens one socket and keeps it: even a client stuck in a
 * reconnect loop with backoff stays far below one attempt per second. A flood
 * does thousands, so this cuts it by orders of magnitude while leaving local
 * load tests and a browser tab being refreshed in anger plenty of room. The key
 * combines IP and user id (see the connect slice), so a whole office behind one
 * NAT is not punished for one noisy member.
 */
export const EDGE_CONNECTIONS_PER_MINUTE = 60;

/** Fixed window length. Also the granularity of the KV key. */
export const EDGE_WINDOW_MS = MINUTE;

/**
 * KV refuses a TTL below 60s, and one window is exactly that: a counter written
 * at the start of its window dies no earlier than the window it belongs to.
 */
export const EDGE_WINDOW_TTL_SECONDS = 60;

const ALLOWED: ConnectGuardResult = { allowed: true };

/** `rl:{key}:{window}` — one counter per key per minute. */
export function edgeWindowKey(key: string, now: number): string {
  return `rl:${key}:${Math.floor(now / EDGE_WINDOW_MS)}`;
}

function denied(retryAfterMs: number): ConnectGuardResult {
  return {
    allowed: false,
    code: RejectCode.RATE_LIMITED,
    reason: "too many connection attempts",
    retryAfterMs,
  };
}

/**
 * KV-backed fixed window, used whenever `EDGE_RATE_LIMITER` is absent.
 *
 * Read-modify-write over an eventually consistent store is not an exact
 * counter, and two colos can each let a burst through. That is an accepted
 * trade-off: this limiter is the coarse outer wall, the per-user token bucket
 * inside the shard is the accurate one, and being approximately right locally
 * is worth more than a Durable Object round trip per connect.
 */
export async function checkKvRateLimit(
  env: Env,
  key: string,
  limit: number,
  now: number,
): Promise<ConnectGuardResult> {
  const windowKey = edgeWindowKey(key, now);
  const raw = await env.CHAT_KV.get(windowKey);
  const used = Number.parseInt(raw ?? "", 10);
  const count = Number.isFinite(used) && used > 0 ? used : 0;

  if (count >= limit) {
    // No write on the rejected path: under a flood that would turn every denied
    // connect into a KV write, which is the scarcer resource of the two.
    return denied(EDGE_WINDOW_MS - (now % EDGE_WINDOW_MS));
  }

  await env.CHAT_KV.put(windowKey, String(count + 1), {
    expirationTtl: EDGE_WINDOW_TTL_SECONDS,
  });
  return ALLOWED;
}

/**
 * Coarse per-key limit on connection attempts, called by the connect slice
 * before it places the socket on a shard.
 */
export async function checkEdgeRateLimit(env: Env, key: string): Promise<ConnectGuardResult> {
  const log = createLogger("rate-limit", (env.LOG_LEVEL as LogLevel) ?? "info");
  try {
    const limiter = env.EDGE_RATE_LIMITER;
    if (limiter) {
      const { success } = await limiter.limit({ key });
      // The binding does not report when the window rolls over, so the client
      // is told to wait a whole one.
      return success ? ALLOWED : denied(EDGE_WINDOW_MS);
    }
    return await checkKvRateLimit(env, key, EDGE_CONNECTIONS_PER_MINUTE, Date.now());
  } catch (error) {
    // Storage being unavailable must never cost a legitimate user their socket:
    // the shard's token bucket still bounds what they can do once connected.
    log.warn("edge rate limit unavailable, allowing connect", { key, error: String(error) });
    return ALLOWED;
  }
}
