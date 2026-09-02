import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { TestClient } from "../../../tests/helpers/client";
import type { ModerationJob } from "../../shared/ports";
import { moderationConsumer } from "./consumer";
import { MODERATION_QUEUE_NAME, parseModerationJob } from "./queue";
import { applyLocalSchema, fakeBatch } from "./test-support";

/** Trips several soft signals at once without needing a configured wordlist. */
const SPAM = "FREE CRYPTO CLICK HERE http://bit.ly/a http://bit.ly/b http://bit.ly/c";

async function seedMessage(roomId: string, id: string, userId: string, body: string) {
  await env.CHAT_DB.prepare(
    `INSERT INTO messages (id, room_id, user_id, name, body, ts, shard_index)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(id, roomId, userId, userId, body, Date.now())
    .run();
}

const job = (roomId: string, messageId: string, userId: string, body: string): ModerationJob => ({
  roomId,
  messageId,
  userId,
  body,
  ts: Date.now(),
});

describe("chat-moderation consumer", () => {
  beforeAll(() => applyLocalSchema(env.CHAT_DB));

  it("deletes a flagged message everywhere it already landed", async () => {
    const roomId = "mod-consumer";
    const author = await TestClient.connectAs(roomId, "spammer");
    const bystander = await TestClient.connectAs(roomId, "watcher");
    await Promise.all([author.waitFor("hello"), bystander.waitFor("hello")]);

    author.send({ t: "send", cid: "c1", body: SPAM });
    const ack = await author.waitFor("ack");
    await seedMessage(roomId, ack.id, "spammer", SPAM);

    const { batch, acked, retried } = fakeBatch(MODERATION_QUEUE_NAME, [
      job(roomId, ack.id, "spammer", SPAM),
    ]);
    await moderationConsumer.handle(batch, env, {} as ExecutionContext);

    expect(acked).toHaveLength(1);
    expect(retried).toHaveLength(0);

    // 1. the retroactive delete reaches a client that already rendered it
    const deleted = await author.waitFor("delete");
    expect(deleted.ids).toContain(ack.id);
    expect((await bystander.waitFor("delete")).ids).toContain(ack.id);

    // 2. the row is soft-deleted in D1
    const row = await env.CHAT_DB.prepare("SELECT deleted_at FROM messages WHERE id = ?")
      .bind(ack.id)
      .first<{ deleted_at: number | null }>();
    expect(row?.deleted_at).toBeGreaterThan(0);

    // 3. the decision is auditable
    const action = await env.CHAT_DB.prepare(
      "SELECT * FROM moderation_actions WHERE message_id = ?",
    )
      .bind(ack.id)
      .first<{ action: string; source: string; user_id: string; reason: string }>();
    expect(action).toMatchObject({ action: "delete", source: "async", user_id: "spammer" });
    expect(action?.reason).toContain("score");

    author.close();
    bystander.close();
  });

  it("leaves a clean message alone", async () => {
    const roomId = "mod-consumer-clean";
    const id = "clean-1";
    await seedMessage(roomId, id, "user-a", "good game everyone");

    const { batch, acked, retried } = fakeBatch(MODERATION_QUEUE_NAME, [
      job(roomId, id, "user-a", "good game everyone"),
    ]);
    await moderationConsumer.handle(batch, env, {} as ExecutionContext);

    expect(acked).toHaveLength(1);
    expect(retried).toHaveLength(0);
    const row = await env.CHAT_DB.prepare("SELECT deleted_at FROM messages WHERE id = ?")
      .bind(id)
      .first<{ deleted_at: number | null }>();
    expect(row?.deleted_at).toBeNull();
  });

  it("acks unprocessable payloads instead of retrying them forever", async () => {
    const { batch, acked, retried } = fakeBatch(MODERATION_QUEUE_NAME, [
      { roomId: "x" },
      "not an object",
      null,
    ]);
    await moderationConsumer.handle(batch, env, {} as ExecutionContext);
    expect(acked).toHaveLength(3);
    expect(retried).toHaveLength(0);
  });

  it("narrows a job payload before trusting it", () => {
    expect(parseModerationJob({ roomId: "r", messageId: "m", userId: "u", body: "b", ts: 1 }))
      .toMatchObject({ roomId: "r", messageId: "m" });
    expect(parseModerationJob({ roomId: "", messageId: "m", userId: "u", body: "b" })).toBeNull();
    expect(parseModerationJob({ roomId: "r", messageId: "m", userId: "u" })).toBeNull();
  });
});
