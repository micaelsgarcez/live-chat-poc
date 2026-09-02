import { describe, expect, it } from "vitest";
import { evaluateHealth, FLUSH_STALL_MS, type ShardHealthInput } from "./health";

const NOW = 1_700_000_000_000;

function shard(overrides: Partial<ShardHealthInput> = {}): ShardHealthInput {
  return {
    shardIndex: 0,
    reachable: true,
    connections: 10,
    acceptedCount: 100,
    rejectedCount: 0,
    recentAccepted: 100,
    recentRejected: 0,
    recentWindowMs: 20_000,
    bufferedMessages: 0,
    lastFlushAt: NOW - 1_000,
    ...overrides,
  };
}

const base = { now: NOW, coordinatorReachable: true, registeredShards: [0] };

function checkFor(verdict: ReturnType<typeof evaluateHealth>, id: string) {
  return verdict.checks.find((check) => check.id === id);
}

describe("evaluateHealth", () => {
  it("is green when the room is simply working", () => {
    const verdict = evaluateHealth({ ...base, shards: [shard()], pingMs: 40 });
    expect(verdict.level).toBe("ok");
    expect(verdict.checks.every((check) => check.level === "ok")).toBe(true);
  });

  it("goes down when the coordinator does not answer", () => {
    const verdict = evaluateHealth({ ...base, coordinatorReachable: false, shards: [shard()] });
    expect(verdict.level).toBe("down");
    expect(checkFor(verdict, "coordinator")?.level).toBe("down");
  });

  it("goes down when no shard is registered at all", () => {
    const verdict = evaluateHealth({ ...base, registeredShards: [], shards: [] });
    expect(verdict.level).toBe("down");
    expect(checkFor(verdict, "shards")?.level).toBe("down");
  });

  it("warns — and names them — when only some shards are silent", () => {
    const verdict = evaluateHealth({
      ...base,
      registeredShards: [0, 1],
      shards: [shard(), shard({ shardIndex: 1, reachable: false })],
    });
    expect(verdict.level).toBe("warn");
    expect(checkFor(verdict, "shards")?.detail).toContain("#1");
  });

  it("treats an idle room as healthy rather than as a zero-traffic failure", () => {
    const verdict = evaluateHealth({
      ...base,
      shards: [shard({ recentAccepted: 0, recentRejected: 0 })],
    });
    expect(checkFor(verdict, "reject-rate")?.level).toBe("ok");
    expect(verdict.level).toBe("ok");
  });

  it("warns once refusals dominate the inbound traffic", () => {
    const verdict = evaluateHealth({
      ...base,
      shards: [shard({ recentAccepted: 10, recentRejected: 90 })],
    });
    expect(checkFor(verdict, "reject-rate")?.level).toBe("warn");
    expect(verdict.level).toBe("warn");
  });

  it("does not stay amber because of a burst that is already over", () => {
    // Lifetime counters remember a very bad minute; the window does not.
    const verdict = evaluateHealth({
      ...base,
      shards: [
        shard({
          acceptedCount: 100,
          rejectedCount: 9_000,
          recentAccepted: 40,
          recentRejected: 0,
        }),
      ],
    });
    expect(checkFor(verdict, "reject-rate")?.level).toBe("ok");
    expect(checkFor(verdict, "reject-rate")?.detail).toContain("últimos");
    expect(verdict.level).toBe("ok");
  });

  it("only calls a buffer stalled when it actually holds something", () => {
    const stale = { lastFlushAt: NOW - FLUSH_STALL_MS - 1 };
    const empty = evaluateHealth({ ...base, shards: [shard({ ...stale, bufferedMessages: 0 })] });
    expect(checkFor(empty, "persistence")?.level).toBe("ok");

    const stuck = evaluateHealth({ ...base, shards: [shard({ ...stale, bufferedMessages: 7 })] });
    expect(checkFor(stuck, "persistence")?.level).toBe("warn");
  });

  it("omits latency entirely when the browser has no socket to measure", () => {
    const verdict = evaluateHealth({ ...base, shards: [shard()], pingMs: null });
    expect(checkFor(verdict, "latency")).toBeUndefined();
  });

  it("takes the worst check as the verdict", () => {
    const verdict = evaluateHealth({
      ...base,
      coordinatorReachable: false,
      shards: [shard({ recentAccepted: 1, recentRejected: 99 })],
    });
    expect(verdict.level).toBe("down");
  });
});
