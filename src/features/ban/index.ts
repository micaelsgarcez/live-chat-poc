/**
 * SLICE: ban — hot list in KV, source of truth in D1.
 *
 * OWNER CONTRACT:
 *   banSlice      : Slice            (moderator routes: list/ban/unban)
 *   checkBan      : (env, roomId, userId) => Promise<ConnectGuardResult>
 *   createBanStore: (env) => BanStore
 *   applyBan      : (env, input: BanInput) => Promise<BanRecord>
 *   liftBan       : (env, roomId, userId) => Promise<void>
 *
 * STUB — replace with the KV/D1 two-layer implementation.
 */
import type { Env } from "../../env";
import type { Slice } from "../../shared/slice";
import type { BanInput, BanRecord, BanStore, ConnectGuardResult } from "../../shared/ports";

export async function checkBan(
  _env: Env,
  _roomId: string,
  _userId: string,
): Promise<ConnectGuardResult> {
  return { allowed: true };
}

export function createBanStore(_env: Env): BanStore {
  return {
    async isBanned() {
      return null;
    },
    async ban() {},
    async unban() {},
    async list() {
      return [];
    },
  };
}

export async function applyBan(_env: Env, input: BanInput): Promise<BanRecord> {
  return {
    userId: input.userId,
    roomId: input.roomId,
    reason: input.reason,
    expiresAt: input.expiresAt ?? 0,
    bannedBy: input.bannedBy,
    createdAt: Date.now(),
  };
}

export async function liftBan(_env: Env, _roomId: string, _userId: string): Promise<void> {}

export const banSlice: Slice = { name: "ban", routes: [] };
