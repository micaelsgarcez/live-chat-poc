import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env, RateLimiterBinding } from "../../env";
import { RejectCode } from "../../shared/errors";
import { MINUTE } from "../../shared/time";
import {
  EDGE_CONNECTIONS_PER_MINUTE,
  EDGE_WINDOW_MS,
  EDGE_WINDOW_TTL_SECONDS,
  checkEdgeRateLimit,
  checkKvRateLimit,
  edgeWindowKey,
} from "./edge-limiter";

const T0 = 1_700_000_000_000; // 20s into a fixed window

function withBinding(limiter: RateLimiterBinding): Env {
  return { ...env, EDGE_RATE_LIMITER: limiter };
}

describe("edge rate limit — KV fallback", () => {
  it("counts attempts per key and rejects past the limit", async () => {
    const key = "1.2.3.4|alice";

    for (let i = 0; i < 3; i++) {
      await expect(checkKvRateLimit(env, key, 3, T0)).resolves.toEqual({ allowed: true });
    }

    const denied = await checkKvRateLimit(env, key, 3, T0);
    expect(denied).toMatchObject({ allowed: false, code: RejectCode.RATE_LIMITED });
    // 20s into the window, the client waits out the remaining 40s.
    expect(denied.retryAfterMs).toBe(40_000);
  });

  it("keeps a separate count per key", async () => {
    await checkKvRateLimit(env, "ip|alice", 1, T0);
    await expect(checkKvRateLimit(env, "ip|alice", 1, T0)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(checkKvRateLimit(env, "ip|bob", 1, T0)).resolves.toEqual({ allowed: true });
  });

  it("starts a fresh window every minute", async () => {
    const key = "1.2.3.4|carol";
    await checkKvRateLimit(env, key, 1, T0);
    await expect(checkKvRateLimit(env, key, 1, T0 + 5_000)).resolves.toMatchObject({
      allowed: false,
    });

    await expect(checkKvRateLimit(env, key, 1, T0 + MINUTE)).resolves.toEqual({ allowed: true });
    expect(edgeWindowKey(key, T0)).not.toBe(edgeWindowKey(key, T0 + MINUTE));
  });

  it("writes the counter under `rl:{key}:{window}` with a short ttl", async () => {
    const key = "1.2.3.4|dave";
    await checkKvRateLimit(env, key, 5, T0);
    await checkKvRateLimit(env, key, 5, T0);

    const windowKey = edgeWindowKey(key, T0);
    expect(windowKey).toBe(`rl:${key}:${Math.floor(T0 / EDGE_WINDOW_MS)}`);
    expect(await env.CHAT_KV.get(windowKey)).toBe("2");

    // KV refuses anything below 60s, and a counter never outlives its window.
    expect(EDGE_WINDOW_TTL_SECONDS).toBe(EDGE_WINDOW_MS / 1000);
  });

  it("does not spend a KV write on a rejected attempt", async () => {
    const key = "1.2.3.4|erin";
    await checkKvRateLimit(env, key, 1, T0);
    await checkKvRateLimit(env, key, 1, T0);

    expect(await env.CHAT_KV.get(edgeWindowKey(key, T0))).toBe("1");
  });
});

describe("checkEdgeRateLimit", () => {
  it("uses the native binding when it exists", async () => {
    const seen: string[] = [];
    const allowing = withBinding({
      limit: async ({ key }) => {
        seen.push(key);
        return { success: true };
      },
    });

    await expect(checkEdgeRateLimit(allowing, "ip|frank")).resolves.toEqual({ allowed: true });
    expect(seen).toEqual(["ip|frank"]);
    // The native path must not touch KV at all.
    expect(await env.CHAT_KV.get(edgeWindowKey("ip|frank", Date.now()))).toBeNull();
  });

  it("rejects when the native binding says so", async () => {
    const rejecting = withBinding({ limit: async () => ({ success: false }) });

    await expect(checkEdgeRateLimit(rejecting, "ip|grace")).resolves.toMatchObject({
      allowed: false,
      code: RejectCode.RATE_LIMITED,
      retryAfterMs: EDGE_WINDOW_MS,
    });
  });

  it("falls back to KV when the binding is absent", async () => {
    expect(env.EDGE_RATE_LIMITER).toBeUndefined();
    const key = "ip|heidi";

    await expect(checkEdgeRateLimit(env, key)).resolves.toEqual({ allowed: true });
    expect(await env.CHAT_KV.get(edgeWindowKey(key, Date.now()))).toBe("1");
  });

  it("allows the connect when KV is down instead of blocking a legitimate user", async () => {
    const broken: Env = {
      ...env,
      CHAT_KV: {
        get: () => Promise.reject(new Error("kv unavailable")),
        put: () => Promise.reject(new Error("kv unavailable")),
      } as unknown as KVNamespace,
    };

    await expect(checkEdgeRateLimit(broken, "ip|ivan")).resolves.toEqual({ allowed: true });
  });

  it("allows the connect when the native binding throws", async () => {
    const throwing = withBinding({
      limit: () => Promise.reject(new Error("limiter unavailable")),
    });

    await expect(checkEdgeRateLimit(throwing, "ip|judy")).resolves.toEqual({ allowed: true });
  });

  it("leaves headroom for a client reconnecting with backoff", () => {
    expect(EDGE_CONNECTIONS_PER_MINUTE).toBeGreaterThanOrEqual(10);
  });
});
