import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../env";
import type { PersistBatch, PersistReaction } from "../../shared/ports";
import type { ChatMessage } from "../../shared/protocol";
import { MAX_STATEMENTS_PER_BATCH, persistQueueConsumer } from "./consumer";
import { resetPersistenceSchema } from "./testing";

const ROOM = "consumer-room";

interface RecordedMessage extends Message<PersistBatch> {
  acked: number;
  retried: number;
}

function queueMessage(body: PersistBatch, id = "q1"): RecordedMessage {
  const message: RecordedMessage = {
    id,
    timestamp: new Date(0),
    body,
    attempts: 1,
    acked: 0,
    retried: 0,
    ack: () => {
      message.acked++;
    },
    retry: () => {
      message.retried++;
    },
  };
  return message;
}

function queueBatch(messages: RecordedMessage[]): MessageBatch<PersistBatch> {
  return {
    queue: "chat-persist",
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: () => {},
    retryAll: () => {},
  };
}

function chatMessage(id: string, patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    roomId: ROOM,
    userId: "u1",
    name: "User One",
    body: `body ${id}`,
    ts: 1_700_000_000_000,
    ...patch,
  };
}

function persistReaction(messageId: string, emoji = "🔥"): PersistReaction {
  return { roomId: ROOM, messageId, userId: "u2", emoji, ts: 1_700_000_000_001 };
}

function persistBatch(
  messages: ChatMessage[],
  reactions: PersistReaction[] = [],
): PersistBatch {
  return { roomId: ROOM, shardIndex: 2, messages, reactions, flushedAt: 1_700_000_000_002 };
}

async function handle(batch: MessageBatch<PersistBatch>, on: Env = env): Promise<void> {
  await persistQueueConsumer.handle(batch, on, {} as ExecutionContext);
}

async function countOf(table: "messages" | "reactions"): Promise<number> {
  const row = await env.CHAT_DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("chat-persist consumer", () => {
  beforeEach(async () => {
    await resetPersistenceSchema(env.CHAT_DB);
  });

  it("writes messages and reactions and acks the queue message", async () => {
    const message = queueMessage(
      persistBatch([chatMessage("m1"), chatMessage("m2", { masked: true })], [persistReaction("m1")]),
    );
    await handle(queueBatch([message]));

    expect(message.acked).toBe(1);
    expect(message.retried).toBe(0);

    const rows = await env.CHAT_DB.prepare(
      "SELECT id, room_id, user_id, name, body, ts, shard_index, masked FROM messages ORDER BY id",
    ).all<Record<string, unknown>>();
    expect(rows.results).toEqual([
      {
        id: "m1",
        room_id: ROOM,
        user_id: "u1",
        name: "User One",
        body: "body m1",
        ts: 1_700_000_000_000,
        shard_index: 2,
        masked: 0,
      },
      {
        id: "m2",
        room_id: ROOM,
        user_id: "u1",
        name: "User One",
        body: "body m2",
        ts: 1_700_000_000_000,
        shard_index: 2,
        masked: 1,
      },
    ]);
    expect(await countOf("reactions")).toBe(1);
  });

  it("is idempotent when the queue redelivers the same batch", async () => {
    const batch = persistBatch([chatMessage("m1")], [persistReaction("m1")]);
    await handle(queueBatch([queueMessage(batch)]));
    // A moderator soft-deletes it between deliveries.
    await env.CHAT_DB.prepare("UPDATE messages SET deleted_at = ? WHERE id = ?")
      .bind(1_700_000_000_500, "m1")
      .run();

    const redelivery = queueMessage({ ...batch, messages: [chatMessage("m1", { body: "tampered" })] });
    await handle(queueBatch([redelivery]));

    expect(redelivery.acked).toBe(1);
    expect(await countOf("messages")).toBe(1);
    expect(await countOf("reactions")).toBe(1);
    const row = await env.CHAT_DB.prepare("SELECT body, deleted_at FROM messages WHERE id = ?")
      .bind("m1")
      .first<{ body: string; deleted_at: number | null }>();
    expect(row).toEqual({ body: "body m1", deleted_at: 1_700_000_000_500 });
  });

  it("chunks a flush larger than one D1 batch", async () => {
    const total = MAX_STATEMENTS_PER_BATCH * 2 + 5;
    const messages = Array.from({ length: total }, (_, i) => chatMessage(`m${i}`));
    const message = queueMessage(persistBatch(messages, [persistReaction("m0"), persistReaction("m1")]));

    await handle(queueBatch([message]));

    expect(message.acked).toBe(1);
    expect(await countOf("messages")).toBe(total);
    expect(await countOf("reactions")).toBe(2);
  });

  it("retries the message when D1 fails", async () => {
    const broken = {
      ...env,
      CHAT_DB: {
        prepare: () => ({ bind: () => ({}) }),
        batch: async () => {
          throw new Error("D1_ERROR: connection lost");
        },
      },
    } as unknown as Env;

    const message = queueMessage(persistBatch([chatMessage("m1")]));
    await handle(queueBatch([message]), broken);

    expect(message.retried).toBe(1);
    expect(message.acked).toBe(0);
  });

  it("acks a malformed batch instead of retrying it forever", async () => {
    const message = queueMessage({ nope: true } as unknown as PersistBatch);
    await handle(queueBatch([message]));

    expect(message.acked).toBe(1);
    expect(message.retried).toBe(0);
  });

  it("acks the healthy batches even when one of them is malformed", async () => {
    const bad = queueMessage({ roomId: ROOM } as unknown as PersistBatch, "bad");
    const good = queueMessage(persistBatch([chatMessage("m9")]), "good");
    await handle(queueBatch([bad, good]));

    expect(bad.acked).toBe(1);
    expect(good.acked).toBe(1);
    expect(await countOf("messages")).toBe(1);
  });
});
