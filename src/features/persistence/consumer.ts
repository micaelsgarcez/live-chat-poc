/**
 * `chat-persist` consumer — the only writer of chat history into D1.
 *
 * Queues deliver at least once, so every statement is `INSERT OR IGNORE`:
 * replaying a redelivered batch is a no-op instead of a primary-key error, and
 * a row a moderator already soft-deleted is never resurrected.
 */
import type { Env } from "../../env";
import { createLogger, type LogLevel } from "../../shared/logger";
import type { PersistBatch } from "../../shared/ports";
import type { QueueConsumerDef } from "../../shared/slice";

export const PERSIST_QUEUE_NAME = "chat-persist";

/**
 * D1 caps how many statements one `batch()` may carry; chunking keeps a large
 * flush from being rejected as a whole.
 */
export const MAX_STATEMENTS_PER_BATCH = 20;

const INSERT_MESSAGE = `INSERT OR IGNORE INTO messages
  (id, room_id, user_id, name, body, ts, shard_index, masked)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_REACTION = `INSERT OR IGNORE INTO reactions
  (message_id, room_id, user_id, emoji, ts)
  VALUES (?, ?, ?, ?, ?)`;

/** Writes one flush to D1 and returns how many rows were offered. */
export async function writePersistBatch(env: Env, batch: PersistBatch): Promise<number> {
  const insertMessage = env.CHAT_DB.prepare(INSERT_MESSAGE);
  const insertReaction = env.CHAT_DB.prepare(INSERT_REACTION);

  const statements: D1PreparedStatement[] = [
    ...batch.messages.map((message) =>
      insertMessage.bind(
        message.id,
        message.roomId,
        message.userId,
        message.name,
        message.body,
        message.ts,
        batch.shardIndex,
        message.masked ? 1 : 0,
      ),
    ),
    ...batch.reactions.map((reaction) =>
      insertReaction.bind(
        reaction.messageId,
        reaction.roomId,
        reaction.userId,
        reaction.emoji,
        reaction.ts,
      ),
    ),
  ];

  for (let i = 0; i < statements.length; i += MAX_STATEMENTS_PER_BATCH) {
    await env.CHAT_DB.batch(statements.slice(i, i + MAX_STATEMENTS_PER_BATCH));
  }
  return statements.length;
}

function isPersistBatch(body: unknown): body is PersistBatch {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Partial<PersistBatch>;
  return (
    typeof candidate.roomId === "string" &&
    typeof candidate.shardIndex === "number" &&
    Array.isArray(candidate.messages) &&
    Array.isArray(candidate.reactions)
  );
}

export const persistQueueConsumer: QueueConsumerDef<PersistBatch> = {
  queue: PERSIST_QUEUE_NAME,

  async handle(batch: MessageBatch<PersistBatch>, env: Env): Promise<void> {
    const log = createLogger("persistence-consumer", (env.LOG_LEVEL as LogLevel) ?? "info");

    // One queue message per shard flush: ack independently so a single bad
    // batch cannot force the healthy ones to be replayed.
    for (const message of batch.messages) {
      if (!isPersistBatch(message.body)) {
        log.error("dropping malformed persist batch", { id: message.id });
        message.ack();
        continue;
      }
      try {
        const written = await writePersistBatch(env, message.body);
        log.debug("persisted batch", { roomId: message.body.roomId, written });
        message.ack();
      } catch (error) {
        // Transient D1 error: redelivery is safe because the writes are idempotent.
        log.error("persist batch failed, will retry", {
          roomId: message.body.roomId,
          attempts: message.attempts,
          error: String(error),
        });
        message.retry();
      }
    }
  },
};
