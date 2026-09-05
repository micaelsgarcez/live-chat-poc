/**
 * Room configuration.
 *
 * The coordinator owns the authoritative copy, persists it in its own storage
 * and replicates it to every shard. Gates read it through `GateContext.config`
 * and must never mutate it.
 */
import type { PublicRoomConfig } from "./protocol";

export interface RateLimitConfig {
  /** Token bucket capacity (burst size), in messages. */
  capacity: number;
  /** Tokens refilled per second. */
  refillPerSecond: number;
}

export interface SpamConfig {
  /** Reject when the same fingerprint repeats this many times in the window. */
  maxDuplicates: number;
  duplicateWindowMs: number;
  /** Reject when more than this many messages arrive within `burstWindowMs`. */
  burstThreshold: number;
  burstWindowMs: number;
  maxLinks: number;
  maxMentions: number;
  /** 0..1 — reject when the ratio of uppercase letters exceeds this. */
  maxCapsRatio: number;
  /** Minimum message length before caps/link heuristics apply. */
  minLengthForHeuristics: number;
  /** Strikes before the user is muted by the spam gate. */
  strikesBeforeMute: number;
  muteMs: number;
}

export interface ModerationConfig {
  wordlistVersion: number;
  /** Lowercased literal terms that are always blocked. */
  blockedTerms: string[];
  /** Source strings for RegExp, compiled lazily and cached by version. */
  blockedPatterns: string[];
  /** When true a match is masked (****) instead of rejecting the message. */
  maskInsteadOfBlock: boolean;
  /** Send every accepted message to the async moderation queue. */
  asyncEnabled: boolean;
  /** Sampling rate 0..1 for the async queue. */
  asyncSampleRate: number;
}

export interface PersistenceConfig {
  enabled: boolean;
  /** Flush the shard buffer once it holds this many messages. */
  batchSize: number;
  /** …or after this long, whichever comes first. */
  flushIntervalMs: number;
  /** Hard cap so a wedged queue cannot exhaust shard memory. */
  maxBufferedMessages: number;
}

/**
 * How the room gets a message from the coordinator to a socket.
 *
 * Both knobs are off by default, so a room behaves exactly as it did before
 * they existed: one message, one RPC per shard, one frame per viewer. They earn
 * their keep only when the room is large enough that 1:N fanout stops being
 * deliverable — and being runtime config is the point, because the number where
 * that happens is what a load test is for.
 */
export interface FanoutConfig {
  /**
   * Room-wide preserves the original broadcast contract. Subroom keeps common
   * conversation on its shard so the coordinator is not the hot-path ceiling.
   */
  scope: "room" | "subroom";
  /**
   * Coalescing window at the coordinator, in ms. 0 publishes each message on
   * its own. The delay is paid by *viewers*, never by the sender: the shard
   * acks before the coordinator flushes.
   */
  batchWindowMs: number;
  /**
   * Chat messages a single socket may receive per second. 0 is unlimited.
   * Above this the shard samples: every viewer keeps a readable stream, no two
   * viewers see quite the same one, and the frame says how many were withheld.
   */
  maxPerViewerPerSecond: number;
  /** A sender always sees their own message, even when sampled out for others. */
  alwaysDeliverOwn: boolean;
}

export interface RoomConfig {
  roomId: string;
  /** Bumped by the coordinator on every change; shards ignore stale versions. */
  version: number;
  closed: boolean;
  slowModeMs: number;
  maxMessageLength: number;
  /** Number of shards the edge hashes connections across. */
  shardCount: number;
  maxSocketsPerShard: number;
  rateLimit: RateLimitConfig;
  spam: SpamConfig;
  moderation: ModerationConfig;
  persistence: PersistenceConfig;
  fanout: FanoutConfig;
  /** Roles exempt from slow-mode, rate-limit and spam gates. */
  privilegedRoles: string[];
}

/** Fields a moderator endpoint is allowed to change at runtime. */
export type RoomConfigPatch = Partial<
  Pick<
    RoomConfig,
    | "closed"
    | "slowModeMs"
    | "maxMessageLength"
    | "shardCount"
    | "maxSocketsPerShard"
    | "rateLimit"
    | "spam"
    | "moderation"
    | "persistence"
    | "fanout"
    | "privilegedRoles"
  >
>;

export function defaultRoomConfig(roomId: string, shardCount = 4): RoomConfig {
  return {
    roomId,
    version: 1,
    closed: false,
    slowModeMs: 0,
    maxMessageLength: 500,
    shardCount,
    maxSocketsPerShard: 5000,
    rateLimit: { capacity: 5, refillPerSecond: 1 },
    spam: {
      maxDuplicates: 3,
      duplicateWindowMs: 30_000,
      burstThreshold: 8,
      burstWindowMs: 5_000,
      maxLinks: 2,
      maxMentions: 5,
      maxCapsRatio: 0.8,
      minLengthForHeuristics: 12,
      strikesBeforeMute: 5,
      muteMs: 60_000,
    },
    moderation: {
      wordlistVersion: 1,
      blockedTerms: [],
      blockedPatterns: [],
      maskInsteadOfBlock: false,
      asyncEnabled: true,
      asyncSampleRate: 1,
    },
    persistence: {
      enabled: true,
      batchSize: 50,
      flushIntervalMs: 2_000,
      maxBufferedMessages: 5_000,
    },
    // Off: a room only pays for batching and sampling once it is big enough to
    // need them, and a default that changes delivery would be a surprise.
    fanout: {
      // Existing rooms stay room-wide until an operator opts into subrooms.
      scope: "room",
      batchWindowMs: 0,
      maxPerViewerPerSecond: 0,
      alwaysDeliverOwn: true,
    },
    privilegedRoles: ["moderator", "admin", "system"],
  };
}

/**
 * Fills in blocks a stored config predates.
 *
 * A `RoomConfig` is persisted in Durable Object storage, so a room that existed
 * before a field was added reads back without it — and a shard that then
 * dereferences that field throws on the *upgrade path*, taking down a room that
 * was working a moment earlier. Every read of a stored config goes through
 * here, so adding a field to `RoomConfig` stays a non-event for rooms that
 * already exist.
 */
export function normalizeRoomConfig(stored: RoomConfig): RoomConfig {
  const defaults = defaultRoomConfig(stored.roomId, stored.shardCount);
  return {
    ...defaults,
    ...stored,
    rateLimit: { ...defaults.rateLimit, ...stored.rateLimit },
    spam: { ...defaults.spam, ...stored.spam },
    moderation: { ...defaults.moderation, ...stored.moderation },
    persistence: { ...defaults.persistence, ...stored.persistence },
    fanout: { ...defaults.fanout, ...stored.fanout },
  };
}

export function mergeRoomConfig(base: RoomConfig, patch: RoomConfigPatch): RoomConfig {
  return {
    ...base,
    ...patch,
    roomId: base.roomId,
    version: base.version + 1,
    rateLimit: { ...base.rateLimit, ...patch.rateLimit },
    spam: { ...base.spam, ...patch.spam },
    moderation: { ...base.moderation, ...patch.moderation },
    persistence: { ...base.persistence, ...patch.persistence },
    fanout: { ...base.fanout, ...patch.fanout },
  };
}

export function toPublicConfig(config: RoomConfig): PublicRoomConfig {
  return {
    roomId: config.roomId,
    version: config.version,
    slowModeMs: config.slowModeMs,
    maxMessageLength: config.maxMessageLength,
    closed: config.closed,
    scope: config.fanout.scope,
    maxDeliveredPerSecond: config.fanout.maxPerViewerPerSecond,
  };
}
