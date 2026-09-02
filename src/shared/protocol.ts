/**
 * Wire protocol.
 *
 * Two hops share this file:
 *   browser  <-- WebSocket -->  ChatShard
 *   ChatShard <-- DO RPC -->    RoomCoordinator  (ServerEvent is the fanout unit)
 *
 * Keep it JSON-serialisable and additive-only: a shard may fan out an event a
 * slightly older client does not know about, and unknown `t` values must be
 * ignored rather than treated as an error.
 */
import type { RejectCode } from "./errors";

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ */
/* client -> server                                                    */
/* ------------------------------------------------------------------ */

export interface ClientSend {
  t: "send";
  /** Client-generated correlation id, echoed back on ack/reject. */
  cid: string;
  body: string;
  /**
   * Id of the message being replied to. Only the id travels: the shard
   * resolves the author and the excerpt from what it has actually seen, so a
   * client cannot put words in someone else's mouth.
   */
  replyTo?: string;
}

export interface ClientReact {
  t: "react";
  cid: string;
  messageId: string;
  emoji: string;
}

export interface ClientPing {
  t: "ping";
  ts?: number;
}

export type ClientMessage = ClientSend | ClientReact | ClientPing;

/* ------------------------------------------------------------------ */
/* server -> client                                                    */
/* ------------------------------------------------------------------ */

/** Server-resolved excerpt of the message a reply points at. */
export interface ReplyRef {
  id: string;
  userId: string;
  name: string;
  /** Truncated to `REPLY_EXCERPT_LENGTH`; it is a hint, not the message. */
  body: string;
}

export const REPLY_EXCERPT_LENGTH = 120;

export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  name: string;
  body: string;
  ts: number;
  /** Set when a sync moderation gate rewrote the body instead of blocking it. */
  masked?: boolean;
  roles?: string[];
  /** Absent when the parent is older than what the shard still remembers. */
  replyTo?: ReplyRef;
}

export interface ServerHello {
  t: "hello";
  v: number;
  userId: string;
  name: string;
  roles: string[];
  roomId: string;
  shardIndex: number;
  connectionId: string;
  serverTime: number;
  config: PublicRoomConfig;
}

export interface ServerChat {
  t: "msg";
  m: ChatMessage;
}

export interface ServerAck {
  t: "ack";
  cid: string;
  id: string;
  ts: number;
}

export interface ServerReject {
  t: "rejected";
  cid: string;
  code: RejectCode;
  reason: string;
  retryAfterMs?: number;
}

export interface ServerDelete {
  t: "delete";
  ids: string[];
  reason?: string;
}

export interface ServerReaction {
  t: "reaction";
  messageId: string;
  emoji: string;
  count: number;
}

export interface ServerPresence {
  t: "presence";
  count: number;
}

export interface ServerConfig {
  t: "config";
  config: PublicRoomConfig;
}

export interface ServerSystem {
  t: "sys";
  code: string;
  reason?: string;
}

export interface ServerPong {
  t: "pong";
  ts: number;
}

export type ServerMessage =
  | ServerHello
  | ServerChat
  | ServerAck
  | ServerReject
  | ServerDelete
  | ServerReaction
  | ServerPresence
  | ServerConfig
  | ServerSystem
  | ServerPong;

/**
 * Events the coordinator replicates to every shard.
 *
 * `ServerAck` / `ServerReject` / `ServerHello` / `ServerPong` are per-socket and
 * are never fanned out.
 */
export type ServerEvent =
  | ServerChat
  | ServerDelete
  | ServerReaction
  | ServerPresence
  | ServerConfig
  | ServerSystem;

/* ------------------------------------------------------------------ */
/* public (client-visible) room configuration                          */
/* ------------------------------------------------------------------ */

export interface PublicRoomConfig {
  roomId: string;
  version: number;
  slowModeMs: number;
  maxMessageLength: number;
  closed: boolean;
}

/* ------------------------------------------------------------------ */
/* parsing helpers                                                     */
/* ------------------------------------------------------------------ */

export const MAX_INBOUND_FRAME_BYTES = 8 * 1024;

/** Parse an untrusted client frame. Returns null when it is not usable. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "string") return null;
  if (raw.length > MAX_INBOUND_FRAME_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const msg = parsed as Record<string, unknown>;
  switch (msg.t) {
    case "send": {
      if (typeof msg.cid !== "string" || typeof msg.body !== "string") return null;
      const send: ClientSend = { t: "send", cid: msg.cid.slice(0, 64), body: msg.body };
      if (typeof msg.replyTo === "string" && msg.replyTo.length > 0) {
        send.replyTo = msg.replyTo.slice(0, 64);
      }
      return send;
    }
    case "react":
      if (
        typeof msg.cid !== "string" ||
        typeof msg.messageId !== "string" ||
        typeof msg.emoji !== "string"
      ) {
        return null;
      }
      return {
        t: "react",
        cid: msg.cid.slice(0, 64),
        messageId: msg.messageId.slice(0, 64),
        emoji: msg.emoji.slice(0, 16),
      };
    case "ping":
      return { t: "ping", ts: typeof msg.ts === "number" ? msg.ts : undefined };
    default:
      return null;
  }
}

export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}
