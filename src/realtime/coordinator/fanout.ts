/**
 * Batched shard calls.
 *
 * A Worker invocation has a hard cap on outgoing subrequests, and a room with
 * 60 shards would issue 60 of them for a single message. Firing them in bounded
 * batches keeps one publish well inside the budget while still overlapping the
 * latency of the calls in a batch.
 *
 * `Promise.allSettled` (never `Promise.all`) so one dead shard cannot take the
 * whole fanout down with it.
 */

/** Concurrent shard calls per batch. */
export const FANOUT_BATCH_SIZE = 32;

export interface BatchOutcome<T> {
  ok: Array<{ index: number; value: T }>;
  failed: Array<{ index: number; reason: unknown }>;
}

export async function callInBatches<T>(
  indexes: readonly number[],
  call: (index: number) => Promise<T>,
  batchSize: number = FANOUT_BATCH_SIZE,
): Promise<BatchOutcome<T>> {
  const outcome: BatchOutcome<T> = { ok: [], failed: [] };
  const size = Math.max(1, batchSize);
  for (let start = 0; start < indexes.length; start += size) {
    const batch = indexes.slice(start, start + size);
    const settled = await Promise.allSettled(batch.map((index) => call(index)));
    settled.forEach((result, i) => {
      const index = batch[i]!;
      if (result.status === "fulfilled") outcome.ok.push({ index, value: result.value });
      else outcome.failed.push({ index, reason: result.reason });
    });
  }
  return outcome;
}
