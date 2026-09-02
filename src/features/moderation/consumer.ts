/**
 * Consumer side of `chat-moderation` — the retroactive delete.
 *
 * By the time a job arrives the message has already been broadcast, so removing
 * it means three things that must happen together: mark it deleted in D1, record
 * why, and tell the coordinator so every socket that already rendered it gets a
 * `delete` event. Jobs are grouped per room so a batch costs one coordinator
 * call per room instead of one per message.
 */
import type { Env } from "../../env";
import { createLogger, type LogLevel } from "../../shared/logger";
import type { ModerationJob } from "../../shared/ports";
import type { RoomConfig } from "../../shared/room-config";
import type { QueueConsumerDef } from "../../shared/slice";
import { coordinatorStub } from "../room";
import { getMatcher } from "./matcher";
import { MODERATION_QUEUE_NAME, parseModerationJob } from "./queue";
import { reviewBody, type ReviewVerdict } from "./review";
import { newActionRecord, markMessagesDeleted, recordActions } from "./store";

const DELETE_REASON = "removed by automated review";

interface Flagged {
  message: Message<ModerationJob>;
  job: ModerationJob;
  verdict: ReviewVerdict;
}

export const moderationConsumer: QueueConsumerDef<ModerationJob> = {
  queue: MODERATION_QUEUE_NAME,

  async handle(batch, env): Promise<void> {
    const log = createLogger("moderation-review", (env.LOG_LEVEL as LogLevel) ?? "info");
    const configs = new Map<string, RoomConfig>();
    const flagged = new Map<string, Flagged[]>();

    for (const message of batch.messages) {
      const job = parseModerationJob(message.body);
      if (!job) {
        // Unprocessable content: retrying cannot make it parse, so it is acked
        // rather than being cycled to the dead-letter queue.
        log.warn("dropping malformed moderation job", { id: message.id });
        message.ack();
        continue;
      }

      try {
        let config = configs.get(job.roomId);
        if (!config) {
          config = await coordinatorStub(env, job.roomId).init(job.roomId);
          configs.set(job.roomId, config);
        }
        const matcher = getMatcher(job.roomId, config.moderation, log);
        const verdict = reviewBody(job.body, config, matcher);
        if (!verdict.blocked) {
          message.ack();
          continue;
        }
        const bucket = flagged.get(job.roomId) ?? [];
        bucket.push({ message, job, verdict });
        flagged.set(job.roomId, bucket);
      } catch (error) {
        // Reaching the coordinator can fail transiently; let the queue retry.
        log.warn("moderation review failed", { id: message.id, error: String(error) });
        message.retry();
      }
    }

    for (const [roomId, items] of flagged) {
      const messageIds = items.map((item) => item.job.messageId);
      try {
        const now = Date.now();
        await markMessagesDeleted(env, roomId, messageIds, now);
        await recordActions(
          env,
          items.map((item) =>
            newActionRecord({
              roomId,
              messageId: item.job.messageId,
              userId: item.job.userId,
              action: "delete",
              reason: `score ${item.verdict.score}: ${item.verdict.reasons.join("; ")}`,
              source: "async",
              createdAt: now,
            }),
          ),
        );
        await coordinatorStub(env, roomId).deleteMessages(messageIds, DELETE_REASON);
        for (const item of items) item.message.ack();
        log.info("retroactive delete", { roomId, messages: messageIds.length });
      } catch (error) {
        // Partial failure is safe to replay: the D1 writes are idempotent and a
        // repeated `delete` event is a no-op for a client that already applied it.
        log.warn("retroactive delete failed", { roomId, error: String(error) });
        for (const item of items) item.message.retry();
      }
    }
  },
};
