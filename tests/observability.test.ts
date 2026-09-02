import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TestClient } from "./helpers/client";
import {
  MAX_EVENTS_PER_SNAPSHOT,
  pseudonym,
  type RoomSnapshot,
} from "../src/features/observability";

async function snapshot(
  room: string,
  { since, token }: { since?: string; token?: string } = {},
): Promise<RoomSnapshot> {
  const url = new URL(`https://example.com/api/rooms/${room}/observability`);
  if (since) url.searchParams.set("since", since);
  const res = await SELF.fetch(url.toString(), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { snapshot: RoomSnapshot };
  return body.snapshot;
}

describe("observability console", () => {
  it("sees a connection the moment it lands on a shard", async () => {
    const room = "obs-connect";
    const client = await TestClient.connectAs(room, "watcher-one");
    await client.waitFor("hello");

    const snap = await snapshot(room);
    expect(snap.totals.shardsReachable).toBeGreaterThan(0);
    expect(snap.totals.connections).toBeGreaterThan(0);
    expect(snap.events.some((event) => event.kind === "connect")).toBe(true);
    expect(snap.health.level).toBe("ok");

    client.ws.close();
  });

  it("records which gate refused a message, not just that one did", async () => {
    const room = "obs-reject";
    const client = await TestClient.connectAs(room, "flooder");
    await client.waitFor("hello");

    // Longer than the default `maxMessageLength`, so base-guard is the one that
    // has to answer for it.
    client.send({ t: "send", cid: "too-long", body: "x".repeat(2_000) });
    await client.waitFor("rejected");

    const snap = await snapshot(room);
    const rejection = snap.events.find((event) => event.kind === "reject");
    expect(rejection).toBeDefined();
    expect(rejection?.gate).toBe("base-guard");
    expect(rejection?.code).toBeTruthy();
    expect(snap.totals.rejected).toBeGreaterThan(0);

    client.ws.close();
  });

  it("hides who was refused from anyone who is not a moderator", async () => {
    const room = "obs-privacy";
    const client = await TestClient.connectAs(room, "sensitive-user");
    await client.waitFor("hello");
    client.send({ t: "send", cid: "too-long", body: "x".repeat(2_000) });
    await client.waitFor("rejected");

    const anonymous = await snapshot(room);
    expect(anonymous.revealed).toBe(false);
    expect(anonymous.events.every((event) => event.userId !== "sensitive-user")).toBe(true);
    // Pseudonymous, not absent: the feed still shows the same actor twice.
    expect(anonymous.events.some((event) => event.userId === pseudonym("sensitive-user"))).toBe(
      true,
    );
    expect(anonymous.events.every((event) => event.name === undefined)).toBe(true);

    const moderator = await snapshot(room, {
      token: await TestClient.token("mod-one", ["moderator"]),
    });
    expect(moderator.revealed).toBe(true);
    expect(moderator.events.some((event) => event.userId === "sensitive-user")).toBe(true);

    client.ws.close();
  });

  it("answers a repeat poll with only what is new", async () => {
    const room = "obs-cursor";
    const client = await TestClient.connectAs(room, "poller");
    await client.waitFor("hello");

    const first = await snapshot(room);
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.cursor).not.toBe("");

    const second = await snapshot(room, { since: first.cursor });
    expect(second.events).toHaveLength(0);
    expect(second.dropped).toBe(0);
    // The panel still reports, even with nothing new in the feed.
    expect(second.totals.connections).toBe(first.totals.connections);

    client.ws.close();
  });

  it("caps one poll's payload and counts the overflow as a visible gap", async () => {
    const room = "obs-flood";
    const client = await TestClient.connectAs(room, "flooder-two");
    await client.waitFor("hello");

    // Every one of these trips a gate, so each is an audit event.
    for (let i = 0; i < MAX_EVENTS_PER_SNAPSHOT + 60; i++) {
      client.send({ t: "send", cid: `c${i}`, body: "x".repeat(2_000) });
    }
    await client.waitFor("rejected");
    // Let the shard work through the queued frames before asking.
    for (let i = 0; i < 40 && client.received.length < MAX_EVENTS_PER_SNAPSHOT; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const snap = await snapshot(room);
    expect(snap.events.length).toBeLessThanOrEqual(MAX_EVENTS_PER_SNAPSHOT);
    if (snap.events.length === MAX_EVENTS_PER_SNAPSHOT) {
      // Nothing is silently swallowed: what did not fit is counted.
      expect(snap.dropped).toBeGreaterThan(0);
    }

    client.ws.close();
  });

  it("reports a room nobody ever opened as down instead of failing", async () => {
    const snap = await snapshot("obs-never-existed");
    expect(snap.totals.shardsRegistered).toBe(0);
    expect(snap.health.level).toBe("down");
    expect(snap.health.checks.some((check) => check.id === "shards")).toBe(true);
  });

  it("always answers the analytics route, configured or not", async () => {
    // Deliberately does not assert which branch: whether a token exists is a
    // property of whoever's `.dev.vars` this runs against, and a test that
    // fails because someone configured their account is a broken test. The
    // unconfigured branch is pinned in `cloudflare.test.ts` instead.
    const res = await SELF.fetch(
      "https://example.com/api/rooms/demo/observability/cloudflare",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cloudflare: { available: boolean } };
    expect(typeof body.cloudflare.available).toBe("boolean");
  }, 15_000);
});
