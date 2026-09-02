/**
 * KV side of the ban slice: the hot list read at the edge on every connect.
 *
 * A D1 query per WebSocket upgrade would put a database round trip in front of
 * every reconnect storm, so the answer — banned *or* not banned — is cached in
 * KV and read with `cacheTtl` so a colo that has seen the key recently answers
 * from its own cache.
 *
 * Two details drive the shape of the entry:
 *   - KV refuses an `expirationTtl` below 60s, but a useful negative cache is
 *     shorter than that. So freshness is carried *inside* the value (`f`) and
 *     the KV expiration is only a backstop that keeps stale keys from leaking.
 *   - The record carries its own absolute `expiresAt`, so a cached positive can
 *     be aged out by the reader without waiting for KV to drop the key.
 */
import type { Env } from "../../env";
import type { BanRecord } from "../../shared/ports";

/** How long a "not banned" answer may be trusted before D1 is consulted again. */
export const NEGATIVE_TTL_MS = 30_000;

/** How long an active ban may be trusted before D1 is consulted again. */
export const POSITIVE_TTL_MS = 60_000;

const KV_MIN_EXPIRATION_SECONDS = 60;

/** Backstop expiry for permanent bans; `liftBan` is what normally removes them. */
const PERMANENT_EXPIRATION_SECONDS = 24 * 60 * 60;

/** Matches the freshness window above; KV's own minimum is 60s anyway. */
const READ_CACHE_TTL_SECONDS = 60;

/**
 * Cached verdict. Field names are single letters because this value is read on
 * every single connection attempt.
 */
export interface HotBanEntry {
  /** The active ban; absent means "known to be allowed". */
  r?: BanRecord;
  /** Epoch ms after which this verdict must be re-derived from D1. */
  f: number;
}

export function banKey(roomId: string, userId: string): string {
  return `ban:${roomId}:${userId}`;
}

/** Builds the entry to cache for a D1 answer (`null` = not banned). */
export function entryFor(record: BanRecord | null, now: number): HotBanEntry {
  if (!record) return { f: now + NEGATIVE_TTL_MS };
  // Never claim freshness past the moment the ban lapses.
  const until = record.expiresAt > 0 ? Math.min(now + POSITIVE_TTL_MS, record.expiresAt) : now + POSITIVE_TTL_MS;
  return { r: record, f: until };
}

export function isFresh(entry: HotBanEntry, now: number): boolean {
  return entry.f > now;
}

export async function readHot(env: Env, roomId: string, userId: string): Promise<HotBanEntry | null> {
  const raw = await env.CHAT_KV.get(banKey(roomId, userId), { cacheTtl: READ_CACHE_TTL_SECONDS });
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HotBanEntry;
  } catch {
    // A corrupt entry is treated as a miss rather than as a verdict.
    return null;
  }
}

export async function writeHot(
  env: Env,
  roomId: string,
  userId: string,
  entry: HotBanEntry,
  now: number,
): Promise<void> {
  await env.CHAT_KV.put(banKey(roomId, userId), JSON.stringify(entry), {
    expirationTtl: expirationSecondsFor(entry, now),
  });
}

/** Removes the cached verdict — positive *or* negative — for a user. */
export async function dropHot(env: Env, roomId: string, userId: string): Promise<void> {
  await env.CHAT_KV.delete(banKey(roomId, userId));
}

function expirationSecondsFor(entry: HotBanEntry, now: number): number {
  if (!entry.r) return KV_MIN_EXPIRATION_SECONDS;
  if (entry.r.expiresAt === 0) return PERMANENT_EXPIRATION_SECONDS;
  const remaining = Math.ceil((entry.r.expiresAt - now) / 1000);
  return Math.max(KV_MIN_EXPIRATION_SECONDS, remaining);
}
