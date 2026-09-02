/**
 * SLICE: ranking — cron recompute into KV, read-only HTTP surface.
 *
 * OWNER CONTRACT:
 *   rankingSlice      : Slice (scheduled job + GET ranking route)
 *   refreshRoomRanking: (env, roomId) => Promise<RankingSnapshot>
 *   readRanking       : (env, roomId) => Promise<RankingSnapshot | null>
 *
 * STUB.
 */
import type { Env } from "../../env";
import type { Slice } from "../../shared/slice";
import type { RankingSnapshot } from "../../shared/ports";

export async function refreshRoomRanking(_env: Env, roomId: string): Promise<RankingSnapshot> {
  return { roomId, generatedAt: Date.now(), windowMs: 0, top: [] };
}

export async function readRanking(_env: Env, _roomId: string): Promise<RankingSnapshot | null> {
  return null;
}

export const rankingSlice: Slice = { name: "ranking" };
