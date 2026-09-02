import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { TestClient } from "./helpers/client";
import { getShardCount, selectShardIndex } from "../src/features/routing";
import { coordinatorName, shardName } from "../src/shared/ids";
import type { RoomCoordinator } from "../src/realtime/coordinator";
import type { ChatShard } from "../src/realtime/shard";

const ROOM = "integration-room";
const AUTHOR = "author-1";
const WATCHER = "watcher-1";

function coordinator() {
  return env.ROOM_COORDINATOR.get(env.ROOM_COORDINATOR.idFromName(coordinatorName(ROOM)));
}

async function shardFor(userId: string) {
  const count = await getShardCount(env, ROOM);
  const index = selectShardIndex(`${ROOM}:${userId}`, count);
  return env.CHAT_SHARD.get(env.CHAT_SHARD.idFromName(shardName(ROOM, index)));
}

async function moderatorFetch(path: string, method: string, body?: unknown): Promise<Response> {
  const token = await TestClient.token("mod-int", ["moderator"]);
  return SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * The whole product on one path: two clients on (likely) different shards, a
 * message that survives every gate, the batch that lands in D1, the ranking the
 * cron would build, and the two moderator actions that reach back into sockets
 * that are already open.
 */
describe("live chat end to end", () => {
  it("carries one message from a socket to history, ranking and moderation", async () => {
    const author = await TestClient.connectAs(ROOM, AUTHOR);
    const watcher = await TestClient.connectAs(ROOM, WATCHER);
    await Promise.all([author.waitFor("hello"), watcher.waitFor("hello")]);

    // 1. broadcast: the sender is acked and every other socket in the room sees it
    author.send({ t: "send", cid: "m1", body: "primeira mensagem da live" });
    const [ack, seen] = await Promise.all([author.waitFor("ack"), watcher.waitFor("msg")]);
    expect(seen.m.body).toBe("primeira mensagem da live");
    expect(seen.m.id).toBe(ack.id);

    // 2. presence is the ROOM total, published by the coordinator alone.
    // The shard alarms are what report each slice of it (and flush the buffer),
    // so drive them here instead of waiting out their deadlines.
    for (const userId of [AUTHOR, WATCHER]) {
      const shard = await shardFor(userId);
      await runInDurableObject(shard, (instance: ChatShard) => instance.alarm());
    }
    await runInDurableObject(coordinator(), (instance: RoomCoordinator) => instance.alarm());
    const presence = await watcher.waitFor("presence");
    expect(presence.count).toBe(2);

    // 3. persistence: the shard buffered, the queue drains into D1, history reads it
    await vi.waitFor(
      async () => {
        const res = await SELF.fetch(`https://example.com/api/rooms/${ROOM}/messages?limit=10`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { messages: Array<{ id: string }> };
        expect(body.messages.map((m) => m.id)).toContain(ack.id);
      },
      { timeout: 10_000, interval: 250 },
    );

    // 4. ranking is computed off the hot path and served ready-made
    const ranking = await SELF.fetch(
      `https://example.com/api/rooms/${ROOM}/ranking?refresh=1`,
    );
    expect(ranking.status).toBe(200);
    const rankingBody = (await ranking.json()) as {
      ranking: { top: Array<{ userId: string; messages: number }> };
    };
    expect(rankingBody.ranking.top[0]?.userId).toBe(AUTHOR);

    // 5. retroactive delete reaches sockets that already rendered the message
    const deleted = await moderatorFetch(`/api/rooms/${ROOM}/moderation/delete`, "POST", {
      messageIds: [ack.id],
      reason: "integration test",
    });
    expect(deleted.status).toBe(200);
    expect((await watcher.waitFor("delete")).ids).toContain(ack.id);

    // …and the message stops being served as history
    const afterDelete = await SELF.fetch(`https://example.com/api/rooms/${ROOM}/messages`);
    const remaining = (await afterDelete.json()) as { messages: Array<{ id: string }> };
    expect(remaining.messages.map((m) => m.id)).not.toContain(ack.id);

    // 6. a ban applied mid-live closes the socket that is already open
    const banned = await moderatorFetch(`/api/rooms/${ROOM}/bans`, "POST", {
      userId: AUTHOR,
      reason: "integration test",
    });
    expect(banned.status).toBe(201);
    const kicked = await author.waitFor("sys");
    expect(kicked.code).toBe("banned");

    // …and the same user can no longer get back in
    const reconnect = await SELF.fetch(
      `https://example.com/ws/${ROOM}?token=${await TestClient.token(AUTHOR)}`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(reconnect.status).toBe(403);

    watcher.close();
  }, 45_000);
});
