/**
 * The per-user token bucket.
 *
 * Pure functions over `UserGateState.bucket` — no clock, no I/O, no config
 * lookup — so the gate stays cheap on the hot path and the maths can be tested
 * by moving `now` forward instead of sleeping.
 */
import type { UserGateState } from "../../shared/pipeline";
import type { RateLimitConfig } from "../../shared/room-config";

export type TokenBucket = UserGateState["bucket"];

export interface ConsumeResult {
  ok: boolean;
  /** 0 when `ok`; otherwise the exact wait until the next token accrues. */
  retryAfterMs: number;
}

interface Limits {
  capacity: number;
  refillPerSecond: number;
}

/**
 * A room config is patchable at runtime, so the gate has to survive nonsense
 * values. A non-positive refill rate is the dangerous one: it would make
 * `retryAfterMs` infinite, and infinity is not representable on the wire.
 */
function resolveLimits(config: RateLimitConfig): Limits {
  const capacity = config.capacity > 0 && Number.isFinite(config.capacity) ? config.capacity : 1;
  const refillPerSecond =
    config.refillPerSecond > 0 && Number.isFinite(config.refillPerSecond)
      ? config.refillPerSecond
      : 1;
  return { capacity, refillPerSecond };
}

/** Hands the user a full bucket, as if they had just connected. */
export function resetBucket(state: UserGateState, config: RateLimitConfig, now: number): void {
  state.bucket = { tokens: resolveLimits(config).capacity, updatedAt: now };
}

/** Accrues the tokens earned since `bucket.updatedAt`, capped at capacity. */
export function refill(bucket: TokenBucket, config: RateLimitConfig, now: number): void {
  const { capacity, refillPerSecond } = resolveLimits(config);

  // `newUserGateState` seeds the bucket with NaN because the shard has no room
  // config at that point: the first message is what decides the capacity.
  if (!Number.isFinite(bucket.tokens)) {
    bucket.tokens = capacity;
    bucket.updatedAt = now;
    return;
  }

  // A shrunken capacity must apply immediately, and a clock that went backwards
  // must never mint tokens.
  const elapsedMs = now - bucket.updatedAt;
  if (elapsedMs <= 0) {
    bucket.tokens = Math.min(bucket.tokens, capacity);
    return;
  }

  bucket.tokens = Math.min(capacity, bucket.tokens + (elapsedMs * refillPerSecond) / 1000);
  bucket.updatedAt = now;
}

/** Refills, then takes `cost` tokens if they are there. */
export function tryConsume(
  bucket: TokenBucket,
  config: RateLimitConfig,
  now: number,
  cost = 1,
): ConsumeResult {
  refill(bucket, config, now);

  if (bucket.tokens >= cost) {
    bucket.tokens -= cost;
    return { ok: true, retryAfterMs: 0 };
  }

  const { refillPerSecond } = resolveLimits(config);
  const missing = cost - bucket.tokens;
  return { ok: false, retryAfterMs: Math.ceil((missing / refillPerSecond) * 1000) };
}
