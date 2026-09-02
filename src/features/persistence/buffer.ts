/**
 * In-shard write buffer — the reason this slice exists.
 *
 * A shard that wrote to D1 once per chat line would turn the free part of the
 * hot path (fanout) into a synchronous cross-service write. Instead accepted
 * messages, and the reactions ranking needs to count, pile up in shard memory
 * and leave once per flush as a single `PersistBatch` on `chat-persist`.
 */
import type { Env } from "../../env";
import { createLogger, type LogLevel } from "../../shared/logger";
import type { MessageBuffer, PersistBatch, PersistReaction } from "../../shared/ports";
import type { ChatMessage } from "../../shared/protocol";
import type { PersistenceConfig } from "../../shared/room-config";

export function createMessageBuffer(
  env: Env,
  roomId: string,
  shardIndex: number,
  config: PersistenceConfig,
): MessageBuffer {
  const log = createLogger("persistence", (env.LOG_LEVEL as LogLevel) ?? "info", {
    roomId,
    shardIndex,
  });
  const capacity = Math.max(1, config.maxBufferedMessages);
  const batchSize = Math.max(1, config.batchSize);
  const flushIntervalMs = Math.max(0, config.flushIntervalMs);

  let messages: ChatMessage[] = [];
  let reactions: PersistReaction[] = [];
  let lastFlushAt = Date.now();
  let inFlight: Promise<number> | null = null;
  let dropped = 0;

  const size = (): number => messages.length + reactions.length;

  /**
   * Explicit backpressure: losing the newest line is survivable, an unbounded
   * buffer inside a Durable Object is not.
   */
  const hasRoom = (): boolean => {
    if (size() < capacity) return true;
    dropped++;
    log.warn("buffer full, dropping newest item", { capacity, dropped });
    return false;
  };

  /** Puts a failed send back at the front so a transient error costs nothing. */
  const restore = (batch: PersistBatch): void => {
    messages = [...batch.messages, ...messages];
    reactions = [...batch.reactions, ...reactions];
    const overflow = size() - capacity;
    if (overflow <= 0) return;
    // Same rule `add` uses — the newest goes first, reactions before messages.
    const fromReactions = Math.min(overflow, reactions.length);
    reactions.length -= fromReactions;
    messages.length -= overflow - fromReactions;
    dropped += overflow;
    log.warn("buffer full after requeue, dropped newest items", { overflow, dropped });
  };

  const doFlush = async (): Promise<number> => {
    const batch: PersistBatch = {
      roomId,
      shardIndex,
      messages,
      reactions,
      flushedAt: Date.now(),
    };
    // Detach before awaiting so anything accepted mid-send joins the next
    // batch instead of being shipped twice.
    messages = [];
    reactions = [];
    lastFlushAt = batch.flushedAt;

    const count = batch.messages.length + batch.reactions.length;
    if (count === 0) return 0;

    try {
      await env.PERSIST_QUEUE.send(batch);
      log.debug("flushed batch", { count });
      return count;
    } catch (error) {
      restore(batch);
      log.error("persist queue send failed, items requeued", { count, error: String(error) });
      return 0;
    }
  };

  return {
    add(message: ChatMessage): boolean {
      if (!config.enabled) return true;
      if (!hasRoom()) return false;
      messages.push(message);
      return true;
    },

    addReaction(reaction: PersistReaction): boolean {
      if (!config.enabled) return true;
      if (!hasRoom()) return false;
      reactions.push(reaction);
      return true;
    },

    size,

    shouldFlush(now: number): boolean {
      if (!config.enabled || size() === 0) return false;
      return size() >= batchSize || now - lastFlushAt >= flushIntervalMs;
    },

    async flush(): Promise<number> {
      if (!config.enabled) return 0;
      if (inFlight) {
        // A concurrent flush already owns the current items; whatever arrived
        // since stays buffered for the next one. Never send the same twice.
        await inFlight;
        return 0;
      }
      inFlight = doFlush();
      try {
        return await inFlight;
      } finally {
        inFlight = null;
      }
    },
  };
}
