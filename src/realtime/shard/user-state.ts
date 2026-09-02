/**
 * The slice of `UserGateState` that has to outlive a hibernated isolate.
 *
 * Hibernation evicts the shard's in-memory maps but keeps the sockets, and the
 * edge always places a user on the same shard, so without this a user coming
 * back — from an eviction or from a reconnect — would be handed a brand new
 * state: a full token bucket, no strikes, no mute. Everything that could be
 * *gained* by that reset is mirrored into storage.
 *
 * Everything that is only a few seconds wide is deliberately dropped instead:
 * `recentFingerprints` and `recentSendsAt` feed windows measured in seconds,
 * an isolate is only evicted after the shard has been idle for far longer than
 * that, and rebuilding them would put a storage write on the hot path for no
 * protection at all. That is the trade-off: duplicate/burst detection restarts
 * cold after hibernation, mutes, strikes and the token bucket do not.
 */
import { newUserGateState, type UserGateState } from "../../shared/pipeline";

export const USER_STATE_PREFIX = "u:";

export interface PersistedUserState {
  mutedUntil: number;
  strikes: number;
  lastAcceptedAt: number;
  acceptedCount: number;
  /** Token bucket level; null while the rate-limit gate has not seeded it. */
  tokens: number | null;
  bucketUpdatedAt: number;
  /** When the snapshot was written — the only input pruning needs. */
  updatedAt: number;
}

export function userStateKey(userId: string): string {
  return `${USER_STATE_PREFIX}${userId}`;
}

/** A user who never sent anything has nothing worth a storage write. */
export function hasPersistableState(state: UserGateState): boolean {
  return (
    state.mutedUntil > 0 ||
    state.strikes > 0 ||
    state.lastAcceptedAt > 0 ||
    Number.isFinite(state.bucket.tokens)
  );
}

export function snapshotUserState(state: UserGateState, now: number): PersistedUserState {
  return {
    mutedUntil: state.mutedUntil,
    strikes: state.strikes,
    lastAcceptedAt: state.lastAcceptedAt,
    acceptedCount: state.acceptedCount,
    tokens: Number.isFinite(state.bucket.tokens) ? state.bucket.tokens : null,
    bucketUpdatedAt: state.bucket.updatedAt,
    updatedAt: now,
  };
}

/**
 * Rebuild the in-memory state conservatively.
 *
 * `bucket.updatedAt` is restored as it was written, not reset to `now`: the
 * rate-limit gate then refills exactly the tokens the elapsed time earned and
 * not one more, so hibernating (or reconnecting) buys no burst.
 */
export function restoreUserState(
  userId: string,
  snapshot: PersistedUserState,
  now: number,
): UserGateState {
  const state = newUserGateState(userId, now);
  state.mutedUntil = snapshot.mutedUntil;
  state.strikes = snapshot.strikes;
  state.lastAcceptedAt = snapshot.lastAcceptedAt;
  state.lastSeenAt = snapshot.lastAcceptedAt;
  state.acceptedCount = snapshot.acceptedCount;
  state.bucket = {
    tokens: snapshot.tokens ?? Number.NaN,
    updatedAt: snapshot.bucketUpdatedAt || now,
  };
  return state;
}

/** Snapshots older than the TTL belong to users who are long gone. */
export function isExpiredSnapshot(
  snapshot: PersistedUserState,
  now: number,
  ttlMs: number,
): boolean {
  return snapshot.mutedUntil <= now && now - snapshot.updatedAt >= ttlMs;
}
