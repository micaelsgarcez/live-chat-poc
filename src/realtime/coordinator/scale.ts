/**
 * Shard count planning.
 *
 * The edge places a connection with `hash(roomId:userId) % shardCount`, so the
 * shard count is the only knob that decides how many sockets land on one
 * Durable Object. Growing it is safe: already-connected users keep their socket
 * on the shard that holds it. Shrinking it is not — it remaps live users to a
 * shard that has none of their gate state, so this module never returns a
 * smaller count. Shrinking is a deliberate, operator-driven `updateConfig`.
 */

/**
 * Grow once the average shard is 70% full. Deliberately below 100%: hashing is
 * only roughly uniform, KV placement reads are cached at the edge for up to a
 * minute, and a shard that hits `maxSocketsPerShard` rejects connections
 * outright — the headroom pays for all three.
 */
export const SCALE_UP_LOAD_FACTOR = 0.7;

/** After growing, aim for a half-full room so we do not scale every alarm. */
export const SCALE_TARGET_LOAD_FACTOR = 0.5;

/** At most double per alarm tick, so a presence spike cannot run away. */
export const MAX_GROWTH_FACTOR = 2;

/** Ceiling; ~60 shards already covers the 300k-socket target in PLAN.md. */
export const MAX_SHARD_COUNT = 256;

export interface ScaleInput {
  shardCount: number;
  connections: number;
  maxSocketsPerShard: number;
}

/** Returns the shard count to use — always >= `shardCount`. */
export function planShardCount(input: ScaleInput): number {
  const current = Math.max(1, input.shardCount);
  const capacity = Math.max(1, input.maxSocketsPerShard);
  if (input.connections <= 0) return current;

  const averageLoad = input.connections / current / capacity;
  if (averageLoad <= SCALE_UP_LOAD_FACTOR) return current;

  const wanted = Math.ceil(input.connections / (capacity * SCALE_TARGET_LOAD_FACTOR));
  const capped = Math.min(wanted, current * MAX_GROWTH_FACTOR, MAX_SHARD_COUNT);
  return Math.max(current, capped);
}
