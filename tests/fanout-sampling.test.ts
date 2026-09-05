/**
 * Coalescing and sampling, end to end through a real room.
 *
 * This is the pair of behaviours that make a 300k-viewer room deliverable at
 * all, and neither can be proved from a unit test: coalescing only happens if
 * the coordinator really holds a window, and sampling only happens if the
 * shard really reads the room's config. So this crosses every slice on the
 * path — config, connect, pipeline, coordinator, shard — on purpose.
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RoomConfigPatch } from "../src/shared/room-config";
import { TestClient } from "./helpers/client";

const MODERATOR = {
  "x-moderator-key": env.MODERATOR_API_KEY!,
  "content-type": "application/json",
};

async function configure(room: string, patch: RoomConfigPatch): Promise<void> {
  const res = await SELF.fetch(`https://example.com/api/rooms/${room}/config`, {
    method: "PATCH",
    headers: MODERATOR,
    body: JSON.stringify(patch),
  });
  expect(res.status).toBe(200);
}

/** The gates are not what is under test here, so they are opened out of the way. */
const OPEN_GATES: RoomConfigPatch = {
  rateLimit: { capacity: 500, refillPerSecond: 500 },
  spam: {
    maxDuplicates: 500,
    duplicateWindowMs: 1,
    burstThreshold: 500,
    burstWindowMs: 1,
    maxLinks: 50,
    maxMentions: 50,
    maxCapsRatio: 1,
    minLengthForHeuristics: 10_000,
    strikesBeforeMute: 500,
    muteMs: 1,
  },
};

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("fanout coalescing", () => {
  it("delivers a window of messages as one batch frame instead of one frame each", async () => {
    const room = "fanout-coalesce";
    await configure(room, {
      ...OPEN_GATES,
      fanout: { scope: "room", batchWindowMs: 120, maxPerViewerPerSecond: 0, alwaysDeliverOwn: true },
    });

    const talker = await TestClient.connectAs(room, "coalesce-talker");
    const viewer = await TestClient.connectAs(room, "coalesce-viewer");
    await Promise.all([talker.waitFor("hello"), viewer.waitFor("hello")]);

    for (let i = 0; i < 5; i++) talker.send({ t: "send", cid: `c${i}`, body: `message ${i}` });
    await settle(600);

    // Every message still arrives — batching changes the framing, not the room.
    expect(viewer.all("msg")).toHaveLength(5);
    const batches = viewer.all("batch");
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.some((b) => b.events.length > 1)).toBe(true);
    // Nothing was withheld: the cap is off in this run.
    expect(batches.every((b) => b.dropped === undefined)).toBe(true);
  });

  it("acks the sender without waiting out the coalescing window", async () => {
    const room = "fanout-ack-latency";
    await configure(room, {
      ...OPEN_GATES,
      fanout: { scope: "room", batchWindowMs: 800, maxPerViewerPerSecond: 0, alwaysDeliverOwn: true },
    });

    const talker = await TestClient.connectAs(room, "ack-talker");
    await talker.waitFor("hello");

    const startedAt = Date.now();
    talker.send({ t: "send", cid: "fast", body: "the viewer pays for the window, not me" });
    await talker.waitFor("ack");
    // The whole point of queueing instead of awaiting: an 800ms window must not
    // become 800ms of ack latency for the person typing.
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});

describe("per-viewer sampling", () => {
  it("withholds messages from a viewer over its budget and says how many", async () => {
    const room = "fanout-sampled";
    await configure(room, {
      ...OPEN_GATES,
      fanout: { scope: "room", batchWindowMs: 120, maxPerViewerPerSecond: 2, alwaysDeliverOwn: true },
    });

    const talker = await TestClient.connectAs(room, "sample-talker");
    const viewer = await TestClient.connectAs(room, "sample-viewer");
    await Promise.all([talker.waitFor("hello"), viewer.waitFor("hello")]);

    const sent = 12;
    for (let i = 0; i < sent; i++) talker.send({ t: "send", cid: `s${i}`, body: `burst ${i}` });
    await settle(700);

    expect(talker.all("ack")).toHaveLength(sent);
    const seen = viewer.all("msg").length;
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeLessThan(sent);

    const dropped = viewer
      .all("batch")
      .reduce((total, batch) => total + (batch.dropped ?? 0), 0);
    expect(dropped).toBeGreaterThan(0);
    // The client can reconstruct the room's real rate from what it was told.
    expect(seen + dropped).toBe(sent);
  });

  it("never samples a sender out of their own message", async () => {
    const room = "fanout-own";
    await configure(room, {
      ...OPEN_GATES,
      fanout: { scope: "room", batchWindowMs: 120, maxPerViewerPerSecond: 1, alwaysDeliverOwn: true },
    });

    const talker = await TestClient.connectAs(room, "own-talker");
    await talker.waitFor("hello");

    const sent = 8;
    for (let i = 0; i < sent; i++) talker.send({ t: "send", cid: `o${i}`, body: `mine ${i}` });
    await settle(700);

    const mine = talker.all("msg").filter((m) => m.m.userId === "own-talker");
    expect(mine).toHaveLength(sent);
  });

  it("leaves a room alone when the knobs are at their defaults", async () => {
    const room = "fanout-default";
    await configure(room, OPEN_GATES);

    const talker = await TestClient.connectAs(room, "default-talker");
    const viewer = await TestClient.connectAs(room, "default-viewer");
    await Promise.all([talker.waitFor("hello"), viewer.waitFor("hello")]);

    for (let i = 0; i < 4; i++) talker.send({ t: "send", cid: `d${i}`, body: `plain ${i}` });
    await settle(400);

    expect(viewer.all("msg")).toHaveLength(4);
    // One message, one frame, no wrapper: exactly the wire an older client sees.
    expect(viewer.all("batch")).toHaveLength(0);
  });

  it("publishes the cap so a client can tell the viewer it is being sampled", async () => {
    const room = "fanout-public-config";
    await configure(room, {
      fanout: { scope: "room", batchWindowMs: 0, maxPerViewerPerSecond: 20, alwaysDeliverOwn: true },
    });
    const client = await TestClient.connectAs(room, "config-reader");
    const hello = await client.waitFor("hello");
    expect(hello.config.maxDeliveredPerSecond).toBe(20);
  });
});
