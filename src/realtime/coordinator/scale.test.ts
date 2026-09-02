import { describe, expect, it } from "vitest";
import {
  MAX_SHARD_COUNT,
  planShardCount,
  SCALE_UP_LOAD_FACTOR,
  SCALE_TARGET_LOAD_FACTOR,
} from "./scale";

describe("planShardCount", () => {
  const capacity = 1_000;

  it("holds steady below the load factor", () => {
    const connections = Math.floor(4 * capacity * SCALE_UP_LOAD_FACTOR);
    expect(planShardCount({ shardCount: 4, connections, maxSocketsPerShard: capacity })).toBe(4);
  });

  it("grows once the average shard passes the load factor", () => {
    const connections = 4 * capacity * SCALE_UP_LOAD_FACTOR + 4;
    const next = planShardCount({ shardCount: 4, connections, maxSocketsPerShard: capacity });
    expect(next).toBeGreaterThan(4);
    expect(connections / next / capacity).toBeLessThanOrEqual(SCALE_TARGET_LOAD_FACTOR + 0.01);
  });

  it("never shrinks, because shrinking remaps connected users", () => {
    expect(planShardCount({ shardCount: 16, connections: 0, maxSocketsPerShard: capacity })).toBe(16);
    expect(planShardCount({ shardCount: 16, connections: 10, maxSocketsPerShard: capacity })).toBe(16);
  });

  it("at most doubles per tick, even under an absurd spike", () => {
    expect(
      planShardCount({ shardCount: 4, connections: 10_000_000, maxSocketsPerShard: capacity }),
    ).toBe(8);
  });

  it("stops at the hard ceiling", () => {
    expect(
      planShardCount({
        shardCount: MAX_SHARD_COUNT,
        connections: 10_000_000,
        maxSocketsPerShard: capacity,
      }),
    ).toBe(MAX_SHARD_COUNT);
  });
});
