import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { selectShardIndex } from "../src/features/routing";
import { coordinatorName, shardName } from "../src/shared/ids";
import type { ChatMessage } from "../src/shared/protocol";
import { TestClient } from "./helpers/client";

const MOD_HEADERS = {
  "content-type": "application/json",
  "x-moderator-key": env.MODERATOR_API_KEY!,
};

function coordinator(room: string) {
  return env.ROOM_COORDINATOR.get(env.ROOM_COORDINATOR.idFromName(coordinatorName(room)));
}

function shard(room: string, index: number) {
  return env.CHAT_SHARD.get(env.CHAT_SHARD.idFromName(shardName(room, index)));
}

async function configure(room: string, maxSocketsPerShard = 100, shardCount = 2): Promise<void> {
  const response = await SELF.fetch(`https://example.com/api/rooms/${room}/config`, {
    method: "PATCH",
    headers: MOD_HEADERS,
    body: JSON.stringify({
      shardCount,
      maxSocketsPerShard,
      fanout: { scope: "subroom", batchWindowMs: 0 },
    }),
  });
  expect(response.status).toBe(200);
}

function differentSubroomUsers(room: string): [string, string] {
  const first = "viewer-0";
  const index = selectShardIndex(`${room}:${first}`, 2);
  for (let i = 1; i < 100; i++) {
    const candidate = `viewer-${i}`;
    if (selectShardIndex(`${room}:${candidate}`, 2) !== index) return [first, candidate];
  }
  throw new Error("could not find users in different subrooms");
}

async function connectAt(room: string, userId: string, sub: number): Promise<TestClient> {
  const token = await TestClient.token(userId, ["moderator"]);
  const response = await SELF.fetch(
    `https://example.com/ws/${room}?token=${encodeURIComponent(token)}&sub=${sub}`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  const client = new TestClient(response.webSocket!);
  client.ws.accept();
  return client;
}

async function moderatorPost(room: string, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://example.com/api/rooms/${room}/${path}`, {
    method: "POST",
    headers: MOD_HEADERS,
    body: JSON.stringify(body),
  });
}

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("automatic subrooms", () => {
  it("isolates common chat between different subrooms", async () => {
    const room = "subrooms-chat";
    await configure(room);
    const [first, second] = differentSubroomUsers(room);
    const a = await TestClient.connectAs(room, first);
    const b = await TestClient.connectAs(room, second);
    const [helloA, helloB] = await Promise.all([a.waitFor("hello"), b.waitFor("hello")]);
    expect(helloA.shardIndex).not.toBe(helloB.shardIndex);

    a.send({ t: "send", cid: "common", body: "only here" });
    const [ack, own] = await Promise.all([a.waitFor("ack"), a.waitFor("msg")]);
    expect(own.m.id).toBe(ack.id);
    await settle();
    expect(b.all("msg")).toHaveLength(0);
    expect((await coordinator(room).getStats()).messagesPublished).toBe(0);

    a.close();
    b.close();
  });

  it("carries a moderator announcement to every subroom", async () => {
    const room = "subrooms-announcement";
    await configure(room);
    const [first, second] = differentSubroomUsers(room);
    const a = await TestClient.connectAs(room, first);
    const b = await TestClient.connectAs(room, second);
    const moderator = await connectAt(room, "global-moderator", 0);
    await Promise.all([a.waitFor("hello"), b.waitFor("hello"), moderator.waitFor("hello")]);

    moderator.send({ t: "send", cid: "wide", body: "announcement" });
    const [seenA, seenB] = await Promise.all([a.waitFor("msg"), b.waitFor("msg")]);
    expect(seenA.m.body).toBe("announcement");
    expect(seenB.m.body).toBe("announcement");
    expect(seenA.m.roomWide).toBe(true);
    expect((await coordinator(room).getStats()).messagesPublished).toBe(1);

    a.close();
    b.close();
    moderator.close();
  });

  it("fans a retroactive delete out to every subroom", async () => {
    const room = "subrooms-delete";
    await configure(room);
    const [first, second] = differentSubroomUsers(room);
    const a = await TestClient.connectAs(room, first);
    const b = await TestClient.connectAs(room, second);
    await Promise.all([a.waitFor("hello"), b.waitFor("hello")]);
    a.send({ t: "send", cid: "delete-me", body: "temporary" });
    const ack = await a.waitFor("ack");

    const response = await moderatorPost(room, "moderation/delete", {
      messageIds: [ack.id],
      reason: "global removal",
    });
    expect(response.status).toBe(200);
    const [deletedA, deletedB] = await Promise.all([a.waitFor("delete"), b.waitFor("delete")]);
    expect(deletedA.ids).toContain(ack.id);
    expect(deletedB.ids).toContain(ack.id);
    a.close();
    b.close();
  });

  it("kicks a banned identity from connections in different subrooms", async () => {
    const room = "subrooms-ban";
    await configure(room);
    const a = await connectAt(room, "distributed-user", 0);
    const b = await connectAt(room, "distributed-user", 1);
    await Promise.all([a.waitFor("hello"), b.waitFor("hello")]);

    const response = await moderatorPost(room, "bans", {
      userId: "distributed-user",
      reason: "global ban",
    });
    expect(response.status).toBe(201);
    const [kickedA, kickedB] = await Promise.all([a.waitFor("sys"), b.waitFor("sys")]);
    expect(kickedA.code).toBe("banned");
    expect(kickedB.code).toBe("banned");
  });

  it("filters persisted history by subroom", async () => {
    const room = "subrooms-history";
    await configure(room);
    const [first, second] = differentSubroomUsers(room);
    const a = await TestClient.connectAs(room, first);
    const b = await TestClient.connectAs(room, second);
    const [helloA, helloB] = await Promise.all([a.waitFor("hello"), b.waitFor("hello")]);
    a.send({ t: "send", cid: "from-a", body: "history A" });
    b.send({ t: "send", cid: "from-b", body: "history B" });
    await Promise.all([a.waitFor("ack"), b.waitFor("ack")]);
    await Promise.all([shard(room, helloA.shardIndex).flushNow(), shard(room, helloB.shardIndex).flushNow()]);

    await vi.waitFor(
      async () => {
        const response = await SELF.fetch(
          `https://example.com/api/rooms/${room}/messages?sub=${helloA.shardIndex}`,
        );
        const page = (await response.json()) as { messages: ChatMessage[] };
        expect(page.messages.map((message) => message.body)).toContain("history A");
        expect(page.messages.map((message) => message.body)).not.toContain("history B");
      },
      { timeout: 10_000, interval: 250 },
    );
    a.close();
    b.close();
  });

  it("opens a third subroom and grows shardCount when the first two are full", async () => {
    const room = "subrooms-probing";
    await configure(room, 1, 1);
    const clients: TestClient[] = [];
    const indexes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const client = await TestClient.connectAs(room, `capacity-${i}`);
      clients.push(client);
      indexes.push((await client.waitFor("hello")).shardIndex);
    }

    expect(indexes).toEqual([0, 1, 2]);
    expect((await coordinator(room).getConfig()).shardCount).toBe(3);
    for (const client of clients) client.close();
  });
}, 45_000);
