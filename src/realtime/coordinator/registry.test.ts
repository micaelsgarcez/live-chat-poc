import { describe, expect, it } from "vitest";
import {
  decodeShardRecords,
  MAX_CONSECUTIVE_FAILURES,
  ShardRegistry,
  type ShardRecord,
} from "./registry";

const T0 = 1_700_000_000_000;

describe("ShardRegistry", () => {
  it("registers a shard once and keeps it deliverable", () => {
    const registry = new ShardRegistry();
    registry.register(2, T0);
    registry.register(2, T0 + 10);
    expect(registry.all()).toEqual([2]);
    expect(registry.deliverable()).toEqual([2]);
    expect(registry.size).toBe(1);
  });

  it("isolates a shard only after consecutive failures", () => {
    const registry = new ShardRegistry();
    registry.register(0, T0);
    registry.register(1, T0);

    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) {
      expect(registry.markFailure(1)).toBe(false);
    }
    expect(registry.deliverable()).toEqual([0, 1]);
    expect(registry.markFailure(1)).toBe(true);
    expect(registry.deliverable()).toEqual([0]);
    expect(registry.isSuspect(1)).toBe(true);
  });

  it("forgets a failure run as soon as one call succeeds", () => {
    const registry = new ShardRegistry();
    registry.register(0, T0);
    registry.markFailure(0);
    registry.markFailure(0);
    registry.markSuccess(0);
    expect(registry.markFailure(0)).toBe(false);
    expect(registry.isSuspect(0)).toBe(false);
  });

  it("clears suspicion on re-registration but not on a heartbeat", () => {
    const registry = new ShardRegistry();
    registry.register(0, T0);
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) registry.markFailure(0);

    registry.touch(0, T0 + 1_000, 5);
    expect(registry.deliverable()).toEqual([]);

    registry.register(0, T0 + 2_000);
    expect(registry.deliverable()).toEqual([0]);
  });

  it("expires shards whose last signal is older than the deadline", () => {
    const registry = new ShardRegistry();
    registry.register(0, T0);
    registry.register(1, T0 + 90_000);
    expect(registry.expire(T0 + 30_000)).toEqual([0]);
    expect(registry.all()).toEqual([1]);
  });

  it("aggregates presence across shards and drops it with the shard", () => {
    const registry = new ShardRegistry();
    registry.register(0, T0);
    registry.register(1, T0);
    registry.touch(0, T0, 120);
    registry.touch(1, T0, 80);
    expect(registry.connections()).toBe(200);

    registry.unregister(1);
    expect(registry.connections()).toBe(120);
  });

  it("round-trips through a snapshot and tolerates the legacy number[] shape", () => {
    const registry = new ShardRegistry();
    registry.register(3, T0);
    registry.touch(3, T0, 7);
    const restored = new ShardRegistry(registry.snapshot() satisfies ShardRecord[]);
    expect(restored.connections()).toBe(7);

    const legacy = new ShardRegistry(decodeShardRecords([0, 1], T0));
    expect(legacy.deliverable()).toEqual([0, 1]);
    expect(decodeShardRecords(undefined, T0)).toEqual([]);
  });
});
