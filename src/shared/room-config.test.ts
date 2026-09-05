import { describe, expect, it } from "vitest";
import {
  defaultRoomConfig,
  mergeRoomConfig,
  normalizeRoomConfig,
  toPublicConfig,
  type RoomConfig,
} from "./room-config";

/** A config as a room that predates the `fanout` block reads back from storage. */
function legacyStoredConfig(): RoomConfig {
  const { fanout: _dropped, ...legacy } = defaultRoomConfig("legacy", 4);
  return legacy as RoomConfig;
}

describe("normalizeRoomConfig", () => {
  it("fills in a block a stored config predates", () => {
    const normalized = normalizeRoomConfig(legacyStoredConfig());
    expect(normalized.fanout).toEqual({
      scope: "room",
      batchWindowMs: 0,
      maxPerViewerPerSecond: 0,
      alwaysDeliverOwn: true,
    });
  });

  it("keeps every value the stored config did have", () => {
    const stored = defaultRoomConfig("kept", 9);
    stored.slowModeMs = 4_000;
    stored.version = 17;
    stored.rateLimit = { capacity: 42, refillPerSecond: 7 };
    const normalized = normalizeRoomConfig(stored);
    expect(normalized.slowModeMs).toBe(4_000);
    expect(normalized.version).toBe(17);
    expect(normalized.shardCount).toBe(9);
    expect(normalized.rateLimit).toEqual({ capacity: 42, refillPerSecond: 7 });
  });

  it("fills in a partially written nested block without discarding it", () => {
    const stored = defaultRoomConfig("partial", 4) as RoomConfig;
    stored.fanout = { maxPerViewerPerSecond: 25 } as RoomConfig["fanout"];
    const normalized = normalizeRoomConfig(stored);
    expect(normalized.fanout.maxPerViewerPerSecond).toBe(25);
    expect(normalized.fanout.batchWindowMs).toBe(0);
    expect(normalized.fanout.alwaysDeliverOwn).toBe(true);
  });

  it("makes a legacy config safe to publish, which is where it used to throw", () => {
    // `toPublicConfig` reads `fanout.maxPerViewerPerSecond`; on a stored config
    // without the block that threw during the WebSocket upgrade, taking down a
    // room that had been working a moment earlier.
    expect(() => toPublicConfig(legacyStoredConfig())).toThrow();
    expect(toPublicConfig(normalizeRoomConfig(legacyStoredConfig())).maxDeliveredPerSecond).toBe(0);
  });
});

describe("mergeRoomConfig", () => {
  it("merges the fanout block instead of replacing it", () => {
    const base = defaultRoomConfig("merge", 4);
    const merged = mergeRoomConfig(base, { fanout: { batchWindowMs: 100 } as never });
    expect(merged.fanout.batchWindowMs).toBe(100);
    expect(merged.fanout.alwaysDeliverOwn).toBe(true);
  });

  it("bumps the version so a shard can reject a stale config", () => {
    const base = defaultRoomConfig("version", 4);
    expect(mergeRoomConfig(base, {}).version).toBe(base.version + 1);
  });
});
