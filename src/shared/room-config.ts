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
    | "rateLimit"
    | "spam"
    | "moderation"
    | "persistence"
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
    privilegedRoles: ["moderator", "admin", "system"],
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
  };
}

export function toPublicConfig(config: RoomConfig): PublicRoomConfig {
  return {
    roomId: config.roomId,
    version: config.version,
    slowModeMs: config.slowModeMs,
    maxMessageLength: config.maxMessageLength,
    closed: config.closed,
  };
}
