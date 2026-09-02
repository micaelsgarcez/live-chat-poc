import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { TestClient } from "../../../tests/helpers/client";
import { applyBan, checkBan, liftBan } from "./index";
import { banKey } from "./hot-list";
import { createBanStore } from "./store";
import { ensureBanSchema } from "./test-support";

// Read from the environment rather than hardcoded: the literal only matched the
// value that ships in `.dev.vars.example`, so anyone who put a real key there —
// to drive a load test, say — failed this suite for no reason of their own.
const MOD_HEADERS = {
  "content-type": "application/json",
  "x-moderator-key": env.MODERATOR_API_KEY!,
};

/** Raw upgrade attempt: `TestClient.connect` asserts 101, and we need the 403. */
function connect(room: string, token: string): Promise<Response> {
  return SELF.fetch(`https://example.com/ws/${room}?token=${token}`, {
    headers: { Upgrade: "websocket" },
  });
}

function banRequest(room: string, body: unknown, headers: Record<string, string> = MOD_HEADERS) {
  return SELF.fetch(`https://example.com/api/rooms/${room}/bans`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await ensureBanSchema(env);
  expect(env.MODERATOR_API_KEY).toBe(MOD_HEADERS["x-moderator-key"]);
});

describe("ban enforcement at connect", () => {
  it("rejects the upgrade of a banned user with 403 banned", async () => {
    expect((await banRequest("ban-connect", { userId: "villain", reason: "flooding" })).status).toBe(201);

    const res = await connect("ban-connect", await TestClient.token("villain"));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "banned", message: "flooding" },
    });
  });

  it("lets everyone else in", async () => {
    const res = await connect("ban-connect", await TestClient.token("bystander"));
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  it("lets a user whose ban has already lapsed connect", async () => {
    await createBanStore(env).ban({
      roomId: "ban-expired",
      userId: "reformed",
      reason: "old news",
      expiresAt: Date.now() - 1_000,
      bannedBy: "moderator",
      createdAt: Date.now() - 60_000,
    });

    const client = await TestClient.connectAs("ban-expired", "reformed");
    await expect(client.waitFor("hello")).resolves.toMatchObject({ userId: "reformed" });
    client.close();
  });

  it("restores access after an unban", async () => {
    expect((await banRequest("ban-lift", { userId: "returning", reason: "cooldown" })).status).toBe(201);
    expect((await connect("ban-lift", await TestClient.token("returning"))).status).toBe(403);

    const lifted = await SELF.fetch("https://example.com/api/rooms/ban-lift/bans/returning", {
      method: "DELETE",
      headers: MOD_HEADERS,
    });
    expect(lifted.status).toBe(204);
    // The DELETE must clear KV too, otherwise the cached ban survives its row.
    expect(await env.CHAT_KV.get(banKey("ban-lift", "returning"))).toBeNull();

    const res = await connect("ban-lift", await TestClient.token("returning"));
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  it("does not let the negative cache outlive a fresh ban", async () => {
    // Warms the "not banned" entry the way a first connect would.
    await expect(checkBan(env, "ban-negcache", "sleeper")).resolves.toEqual({ allowed: true });
    expect(await env.CHAT_KV.get(banKey("ban-negcache", "sleeper"))).not.toBeNull();

    await applyBan(env, {
      roomId: "ban-negcache",
      userId: "sleeper",
      reason: "caught",
      bannedBy: "moderator",
    });

    await expect(checkBan(env, "ban-negcache", "sleeper")).resolves.toMatchObject({
      allowed: false,
      code: "banned",
      reason: "caught",
    });

    await liftBan(env, "ban-negcache", "sleeper");
    await expect(checkBan(env, "ban-negcache", "sleeper")).resolves.toEqual({ allowed: true });
  });
});

describe("ban propagation to live sockets", () => {
  it("drops a connection that is already open when the ban lands", async () => {
    const victim = await TestClient.connectAs("ban-live", "loudmouth");
    const other = await TestClient.connectAs("ban-live", "innocent");
    await Promise.all([victim.waitFor("hello"), other.waitFor("hello")]);

    expect((await banRequest("ban-live", { userId: "loudmouth", reason: "spam" })).status).toBe(201);

    const sys = await victim.waitFor("sys");
    expect(sys).toMatchObject({ code: "banned", reason: "spam" });
    expect(other.all("sys")).toHaveLength(0);
    other.close();
  });
});

describe("moderator routes", () => {
  it("lists the active bans of a room", async () => {
    await banRequest("ban-list", { userId: "one", reason: "a" });
    await banRequest("ban-list", { userId: "two", reason: "b", expiresAt: Date.now() + 60_000 });

    const res = await SELF.fetch("https://example.com/api/rooms/ban-list/bans", { headers: MOD_HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bans: Array<{ userId: string; bannedBy: string }> };
    expect(body.bans.map((b) => b.userId).sort()).toEqual(["one", "two"]);
    expect(body.bans[0]!.bannedBy).toBe("moderator");
  });

  it("accepts a moderator JWT as well as the shared key", async () => {
    const token = await TestClient.token("mod-1", ["moderator"]);
    const res = await banRequest(
      "ban-jwt",
      { userId: "target", reason: "by jwt" },
      { "content-type": "application/json", authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ ban: { bannedBy: "mod-1" } });
  });

  it("refuses every route without moderator credentials", async () => {
    const plain = await TestClient.token("nobody");
    const cases = [
      SELF.fetch("https://example.com/api/rooms/ban-authz/bans"),
      banRequest("ban-authz", { userId: "x" }, { "content-type": "application/json" }),
      banRequest("ban-authz", { userId: "x" }, {
        "content-type": "application/json",
        authorization: `Bearer ${plain}`,
      }),
      SELF.fetch("https://example.com/api/rooms/ban-authz/bans/x", { method: "DELETE" }),
    ];
    for (const res of await Promise.all(cases)) expect(res.status).toBe(403);

    // …and nothing was written behind the 403s.
    expect(await createBanStore(env).list("ban-authz")).toEqual([]);
  });

  it("rejects a body without a userId", async () => {
    const res = await banRequest("ban-authz", { reason: "no subject" });
    expect(res.status).toBe(400);
  });
});
