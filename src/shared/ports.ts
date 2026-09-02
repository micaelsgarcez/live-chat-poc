/**
 * Cross-slice contracts.
 *
 * Nothing in here has an implementation; each slice owns exactly one side of
 * one of these interfaces. Freezing them up front is what lets the slices be
 * built independently.
 */
import type { Identity } from "./identity";
import type { ChatMessage, ServerEvent } from "./protocol";
import type { RoomConfig, RoomConfigPatch } from "./room-config";

/* ------------------------------------------------------------------ */
/* Durable Object RPC surfaces                                         */
/* ------------------------------------------------------------------ */

export interface PublishInput {
  message: ChatMessage;
  /** Shard that accepted the message; it already delivered nothing locally. */
  originShardIndex: number;
}

export interface PublishResult {
  delivered: number;
  failedShards: number[];
}

export interface RoomStats {
  roomId: string;
  shardCount: number;
  registeredShards: number[];
  connections: number;
  messagesPublished: number;
  configVersion: number;
  updatedAt: number;
}

export interface ShardStats {
  roomId: string;
  shardIndex: number;
  connections: number;
  bufferedMessages: number;
  configVersion: number;
  acceptedCount: number;
  rejectedCount: number;
}

export interface BanInput {
  userId: string;
  roomId: string;
  reason: string;
  /** Epoch ms; 0 or undefined means permanent. */
  expiresAt?: number;
  bannedBy: string;
}

/** RPC surface implemented by `RoomCoordinator`. */
export interface CoordinatorApi {
  init(roomId: string): Promise<RoomConfig>;
  getConfig(): Promise<RoomConfig>;
  updateConfig(patch: RoomConfigPatch): Promise<RoomConfig>;
  registerShard(roomId: string, shardIndex: number): Promise<RoomConfig>;
  unregisterShard(shardIndex: number): Promise<void>;
  publish(input: PublishInput): Promise<PublishResult>;
  broadcast(events: ServerEvent[]): Promise<PublishResult>;
  banUser(input: BanInput): Promise<void>;
  unbanUser(roomId: string, userId: string): Promise<void>;
  deleteMessages(messageIds: string[], reason: string): Promise<void>;
  reportPresence(shardIndex: number, count: number): Promise<void>;
  getStats(): Promise<RoomStats>;
}

/** RPC surface implemented by `ChatShard`. */
export interface ShardApi {
  fanout(events: ServerEvent[]): Promise<number>;
  applyConfig(config: RoomConfig): Promise<void>;
  kickUsers(userIds: string[], reason: string): Promise<number>;
  muteUsers(userIds: string[], untilMs: number, reason: string): Promise<number>;
  deleteMessages(messageIds: string[], reason: string): Promise<void>;
  getStats(): Promise<ShardStats>;
  flushNow(): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* Slice ports                                                         */
/* ------------------------------------------------------------------ */

export interface BanRecord {
  userId: string;
  roomId: string;
  reason: string;
  expiresAt: number;
  bannedBy: string;
  createdAt: number;
}

export interface BanStore {
  isBanned(roomId: string, userId: string): Promise<BanRecord | null>;
  ban(record: BanRecord): Promise<void>;
  unban(roomId: string, userId: string): Promise<void>;
  list(roomId: string): Promise<BanRecord[]>;
}

export interface PersistReaction {
  roomId: string;
  messageId: string;
  userId: string;
  emoji: string;
  ts: number;
}

/** Batch a shard hands to the persistence slice, once per flush. */
export interface PersistBatch {
  roomId: string;
  shardIndex: number;
  messages: ChatMessage[];
  reactions: PersistReaction[];
  flushedAt: number;
}

export interface ModerationJob {
  roomId: string;
  messageId: string;
  userId: string;
  body: string;
  ts: number;
}

export interface RankingEntry {
  userId: string;
  name: string;
  messages: number;
  reactions: number;
  score: number;
}

export interface RankingSnapshot {
  roomId: string;
  generatedAt: number;
  windowMs: number;
  top: RankingEntry[];
}

/* ------------------------------------------------------------------ */
/* Edge connect pipeline                                               */
/* ------------------------------------------------------------------ */

export interface AuthResult {
  ok: boolean;
  identity?: Identity;
  reason?: string;
}

export interface ConnectGuardResult {
  allowed: boolean;
  code?: string;
  reason?: string;
  retryAfterMs?: number;
}

/**
 * In-shard write buffer owned by the persistence slice and driven by the shard.
 * The shard calls `add` on every accepted message and `flush` from its alarm.
 */
export interface MessageBuffer {
  /** Returns false when the buffer is full and the message was dropped. */
  add(message: ChatMessage): boolean;
  /** Reactions ride the same batch so ranking can count them. */
  addReaction(reaction: PersistReaction): boolean;
  size(): number;
  shouldFlush(now: number): boolean;
  /** Ships the buffered messages to the queue; returns how many were sent. */
  flush(): Promise<number>;
}
