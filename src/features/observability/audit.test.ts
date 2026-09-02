import { describe, expect, it } from "vitest";
import {
  AuditRing,
  decodeAuditCursor,
  encodeAuditCursor,
  mergeAuditEvents,
  type AuditEvent,
} from "./audit";

const reject = (userId: string, ts: number) =>
  ({ kind: "reject", userId, gate: "rate-limit", code: "rate_limited", ts }) as const;

describe("AuditRing", () => {
  it("stamps a monotonic sequence and the shard that observed it", () => {
    const ring = new AuditRing(4);
    ring.record(3, reject("u1", 10));
    const second = ring.record(3, reject("u2", 11));
    expect(second.seq).toBe(2);
    expect(second.shardIndex).toBe(3);
    expect(ring.cursor).toBe(2);
  });

  it("returns only what the caller has not seen", () => {
    const ring = new AuditRing(10);
    for (let i = 0; i < 5; i++) ring.record(0, reject(`u${i}`, i));
    const slice = ring.since(3);
    expect(slice.events.map((event) => event.seq)).toEqual([4, 5]);
    expect(slice.cursor).toBe(5);
    expect(slice.dropped).toBe(0);
  });

  it("overwrites the oldest entries instead of growing", () => {
    const ring = new AuditRing(3);
    for (let i = 1; i <= 6; i++) ring.record(0, reject(`u${i}`, i));
    expect(ring.size).toBe(3);
    const slice = ring.since(0);
    expect(slice.events.map((event) => event.seq)).toEqual([4, 5, 6]);
  });

  it("tells a reader how much it missed rather than faking a continuous window", () => {
    const ring = new AuditRing(3);
    for (let i = 1; i <= 6; i++) ring.record(0, reject(`u${i}`, i));
    // The reader last saw #1; #2 and #3 fell out of the ring in between.
    const slice = ring.since(1);
    expect(slice.dropped).toBe(2);
    expect(slice.events.map((event) => event.seq)).toEqual([4, 5, 6]);
  });

  it("reports nothing new when the cursor is already current", () => {
    const ring = new AuditRing(5);
    ring.record(1, reject("u1", 1));
    expect(ring.since(1).events).toHaveLength(0);
    expect(ring.since(1).dropped).toBe(0);
  });
});

describe("cursor encoding", () => {
  it("round-trips one sequence per shard", () => {
    const cursors = new Map([
      [2, 88],
      [0, 120],
    ]);
    expect(encodeAuditCursor(cursors)).toBe("0:120,2:88");
    expect(decodeAuditCursor("0:120,2:88")).toEqual(cursors);
  });

  it("drops shards that have produced nothing", () => {
    expect(encodeAuditCursor(new Map([[1, 0]]))).toBe("");
  });

  it("ignores garbage instead of throwing at a hand-edited query string", () => {
    expect(decodeAuditCursor("nonsense,,1:x,-2:5,3:9")).toEqual(new Map([[3, 9]]));
    expect(decodeAuditCursor(null)).toEqual(new Map());
  });
});

describe("mergeAuditEvents", () => {
  it("interleaves shards by timestamp so the feed reads as one room", () => {
    const a: AuditEvent[] = [
      { seq: 1, shardIndex: 0, ts: 100, kind: "connect", userId: "a" },
      { seq: 2, shardIndex: 0, ts: 300, kind: "disconnect", userId: "a" },
    ];
    const b: AuditEvent[] = [{ seq: 1, shardIndex: 1, ts: 200, kind: "connect", userId: "b" }];
    expect(mergeAuditEvents([a, b]).map((event) => event.ts)).toEqual([100, 200, 300]);
  });
});
