import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { TestClient } from "../../../tests/helpers/client";
import { enqueueModeration } from "./queue";
import { applyLocalSchema } from "./test-support";

const BASE = "https://example.com";

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function asModerator(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await TestClient.token("mod-1", ["moderator"])}` };
}

describe("moderator routes", () => {
  beforeAll(() => applyLocalSchema(env.CHAT_DB));

  it("rejects every route without moderator credentials", async () => {
    const viewer = { authorization: `Bearer ${await TestClient.token("viewer")}` };
    for (const headers of [{}, viewer]) {
      expect((await post("/api/rooms/r/moderation/delete", { messageIds: ["a"] }, headers)).status).toBe(403);
      expect((await post("/api/rooms/r/moderation/mute", { userId: "u", ms: 1000 }, headers)).status).toBe(403);
      const listed = await SELF.fetch(`${BASE}/api/rooms/r/moderation/actions`, { headers });
      expect(listed.status).toBe(403);
    }
  });

  it("propagates a delete to connected clients and records it", async () => {
    const roomId = "mod-routes-delete";
    const client = await TestClient.connectAs(roomId, "viewer-1");
    await client.waitFor("hello");

    client.send({ t: "send", cid: "c1", body: "something regrettable" });
    const ack = await client.waitFor("ack");
    await env.CHAT_DB.prepare(
      `INSERT INTO messages (id, room_id, user_id, name, body, ts, shard_index)
       VALUES (?, ?, 'viewer-1', 'viewer-1', 'something regrettable', ?, 0)`,
    )
      .bind(ack.id, roomId, Date.now())
      .run();

    const res = await post(
      `/api/rooms/${roomId}/moderation/delete`,
      { messageIds: [ack.id], reason: "off topic" },
      await asModerator(),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ deleted: 1, reason: "off topic" });

    const event = await client.waitFor("delete");
    expect(event.ids).toContain(ack.id);
    expect(event.reason).toBe("off topic");

    const action = await env.CHAT_DB.prepare(
      "SELECT * FROM moderation_actions WHERE message_id = ?",
    )
      .bind(ack.id)
      .first<{ action: string; source: string; user_id: string }>();
    expect(action).toMatchObject({ action: "delete", source: "manual:mod-1", user_id: "viewer-1" });

    client.close();
  });

  it("silences a user on whichever shard holds them", async () => {
    const roomId = "mod-routes-mute";
    const client = await TestClient.connectAs(roomId, "noisy");
    await client.waitFor("hello");

    const res = await post(
      `/api/rooms/${roomId}/moderation/mute`,
      { userId: "noisy", ms: 60_000, reason: "take a breath" },
      { "x-moderator-key": env.MODERATOR_API_KEY! },
    );
    expect(res.status).toBe(200);
    // The route found the live socket, so the mute reached real gate state.
    await expect(res.json()).resolves.toMatchObject({ userId: "noisy", muted: 1 });
    expect((await client.waitFor("sys")).code).toBe("muted");

    client.send({ t: "send", cid: "c1", body: "still talking" });
    const rejected = await client.waitFor("rejected");
    expect(rejected.code).toBe("muted");
    expect(rejected.retryAfterMs).toBeGreaterThan(0);

    client.close();
  });

  it("validates its input", async () => {
    const headers = await asModerator();
    expect((await post("/api/rooms/r/moderation/delete", { messageIds: [] }, headers)).status).toBe(400);
    expect((await post("/api/rooms/r/moderation/mute", { userId: "u", ms: 0 }, headers)).status).toBe(400);
    expect((await post("/api/rooms/r/moderation/mute", { ms: 1000 }, headers)).status).toBe(400);
  });

  it("lists recent actions newest first", async () => {
    const roomId = "mod-routes-actions";
    const headers = await asModerator();
    await post(`/api/rooms/${roomId}/moderation/mute`, { userId: "u1", ms: 1000 }, headers);
    await post(`/api/rooms/${roomId}/moderation/mute`, { userId: "u2", ms: 1000 }, headers);

    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/moderation/actions?limit=1`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actions: Array<{ userId: string; action: string }> };
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]).toMatchObject({ action: "mute" });
  });
});

describe("enqueueModeration", () => {
  it("sends jobs to the queue binding", async () => {
    await expect(
      enqueueModeration(env, [
        { roomId: "r", messageId: "m1", userId: "u", body: "hello", ts: Date.now() },
      ]),
    ).resolves.toBeUndefined();
  });

  it("never throws when the queue is missing or failing", async () => {
    const broken = {
      ...env,
      MODERATION_QUEUE: {
        sendBatch: () => Promise.reject(new Error("queue down")),
      } as unknown as typeof env.MODERATION_QUEUE,
    };
    await expect(
      enqueueModeration(broken, [{ roomId: "r", messageId: "m", userId: "u", body: "x", ts: 0 }]),
    ).resolves.toBeUndefined();

    const unbound = { ...env, MODERATION_QUEUE: undefined as unknown as typeof env.MODERATION_QUEUE };
    await expect(
      enqueueModeration(unbound, [{ roomId: "r", messageId: "m", userId: "u", body: "x", ts: 0 }]),
    ).resolves.toBeUndefined();
  });
});
