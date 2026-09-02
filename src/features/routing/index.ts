/**
 * SLICE: routing — decides which shard a connection lands on.
 *
 * The edge must not pay a Durable Object round trip per connect, so the shard
 * count is published to KV by the coordinator and read here with edge caching.
 * Placement itself is a pure hash, so it is stable and testable.
 */
import type { Env } from "../../env";
import { intVar } from "../../env";
import type { Slice } from "../../shared/slice";
import { bucketOf } from "../../shared/hash";

const SHARD_COUNT_TTL_SECONDS = 60;

export function shardCountKey(roomId: string): string {
  return `room:${roomId}:shard-count`;
}

/** Pure placement function: same key + same count always yields the same shard. */
export function selectShardIndex(placementKey: string, shardCount: number): number {
  return bucketOf(placementKey, Math.max(1, shardCount));
}

export async function getShardCount(env: Env, roomId: string): Promise<number> {
  const fallback = intVar(env.DEFAULT_SHARD_COUNT, 4);
  const raw = await env.CHAT_KV.get(shardCountKey(roomId), {
    cacheTtl: SHARD_COUNT_TTL_SECONDS,
  });
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function setShardCount(env: Env, roomId: string, count: number): Promise<void> {
  await env.CHAT_KV.put(shardCountKey(roomId), String(Math.max(1, count)));
}

export const routingSlice: Slice = { name: "routing" };
