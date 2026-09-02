/**
 * Producer side of `chat-moderation`.
 *
 * The shard calls this from `waitUntil` on every accepted message. It is the
 * one place in the slice that sits next to the hot path, so it never throws:
 * losing a review job degrades moderation, failing the send would degrade chat.
 */
import type { Env } from "../../env";
import { createLogger, type LogLevel } from "../../shared/logger";
import type { ModerationJob } from "../../shared/ports";

/** Cloudflare Queues caps a `sendBatch` at 100 messages. */
const MAX_QUEUE_BATCH = 100;

export const MODERATION_QUEUE_NAME = "chat-moderation";

export async function enqueueModeration(env: Env, jobs: ModerationJob[]): Promise<void> {
  if (jobs.length === 0) return;

  const log = createLogger("moderation-queue", (env.LOG_LEVEL as LogLevel) ?? "info");
  const queue = env.MODERATION_QUEUE;
  // Feature-detected rather than assumed: a Worker configured without the queue
  // producer binding must still serve chat.
  if (typeof queue?.sendBatch !== "function") {
    log.warn("moderation queue is not bound; skipping async review", { jobs: jobs.length });
    return;
  }

  for (let i = 0; i < jobs.length; i += MAX_QUEUE_BATCH) {
    const chunk = jobs.slice(i, i + MAX_QUEUE_BATCH);
    try {
      await queue.sendBatch(chunk.map((body) => ({ body })));
    } catch (error) {
      log.warn("moderation enqueue failed", { jobs: chunk.length, error: String(error) });
    }
  }
}

/** Narrows an untrusted queue payload; anything else is unprocessable. */
export function parseModerationJob(raw: unknown): ModerationJob | null {
  if (typeof raw !== "object" || raw === null) return null;
  const job = raw as Record<string, unknown>;
  if (
    typeof job.roomId !== "string" ||
    typeof job.messageId !== "string" ||
    typeof job.userId !== "string" ||
    typeof job.body !== "string" ||
    !job.roomId ||
    !job.messageId
  ) {
    return null;
  }
  return {
    roomId: job.roomId,
    messageId: job.messageId,
    userId: job.userId,
    body: job.body,
    ts: typeof job.ts === "number" ? job.ts : 0,
  };
}
