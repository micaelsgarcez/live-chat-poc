import { describe, expect, it } from "vitest";
import { newUserGateState } from "../../shared/pipeline";
import type { RateLimitConfig } from "../../shared/room-config";
import { refill, resetBucket, tryConsume } from "./token-bucket";

const T0 = 1_700_000_000_000;
const config: RateLimitConfig = { capacity: 5, refillPerSecond: 1 };

function bucketAt(now = T0) {
  return newUserGateState("u1", now).bucket;
}

describe("token bucket", () => {
  it("starts full: the NaN seeded by newUserGateState becomes the capacity", () => {
    const bucket = bucketAt();
    expect(Number.isNaN(bucket.tokens)).toBe(true);

    expect(tryConsume(bucket, config, T0).ok).toBe(true);
    expect(bucket.tokens).toBe(4);
  });

  it("lets a burst up to capacity through and rejects the next one", () => {
    const bucket = bucketAt();
    for (let i = 0; i < config.capacity; i++) {
      expect(tryConsume(bucket, config, T0).ok).toBe(true);
    }
    expect(tryConsume(bucket, config, T0).ok).toBe(false);
  });

  it("reports the exact wait until the next token", () => {
    const bucket = bucketAt();
    for (let i = 0; i < config.capacity; i++) tryConsume(bucket, config, T0);

    expect(tryConsume(bucket, config, T0).retryAfterMs).toBe(1000);
    // 400ms of refill leaves 0.4 tokens, so 600ms remain.
    expect(tryConsume(bucket, config, T0 + 400).retryAfterMs).toBe(600);
  });

  it("refills over elapsed time and never past the capacity", () => {
    const bucket = bucketAt();
    for (let i = 0; i < config.capacity; i++) tryConsume(bucket, config, T0);

    refill(bucket, config, T0 + 3_000);
    expect(bucket.tokens).toBe(3);

    refill(bucket, config, T0 + 60_000);
    expect(bucket.tokens).toBe(config.capacity);
  });

  it("refills at the configured rate, not one token per second", () => {
    const fast: RateLimitConfig = { capacity: 10, refillPerSecond: 4 };
    const bucket = bucketAt();
    for (let i = 0; i < fast.capacity; i++) tryConsume(bucket, fast, T0);

    expect(tryConsume(bucket, fast, T0).retryAfterMs).toBe(250);
    refill(bucket, fast, T0 + 1_000);
    expect(bucket.tokens).toBe(4);
  });

  it("does not mint tokens when the clock goes backwards", () => {
    const bucket = bucketAt();
    tryConsume(bucket, config, T0 + 10_000);
    expect(bucket.tokens).toBe(4);

    refill(bucket, config, T0);
    expect(bucket.tokens).toBe(4);
  });

  it("applies a shrunken capacity immediately", () => {
    const bucket = bucketAt();
    tryConsume(bucket, config, T0);
    expect(bucket.tokens).toBe(4);

    refill(bucket, { capacity: 2, refillPerSecond: 1 }, T0);
    expect(bucket.tokens).toBe(2);
  });

  it("keeps retryAfterMs finite when the room config is nonsense", () => {
    const broken: RateLimitConfig = { capacity: 0, refillPerSecond: 0 };
    const bucket = bucketAt();

    expect(tryConsume(bucket, broken, T0).ok).toBe(true);
    const result = tryConsume(bucket, broken, T0);
    expect(result.ok).toBe(false);
    expect(Number.isFinite(result.retryAfterMs)).toBe(true);
  });

  it("resetBucket hands the user a full bucket again", () => {
    const state = newUserGateState("u1", T0);
    for (let i = 0; i < config.capacity; i++) tryConsume(state.bucket, config, T0);
    expect(tryConsume(state.bucket, config, T0).ok).toBe(false);

    resetBucket(state, config, T0);
    expect(state.bucket.tokens).toBe(config.capacity);
    expect(tryConsume(state.bucket, config, T0).ok).toBe(true);
  });
});
