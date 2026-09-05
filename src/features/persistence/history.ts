/**
 * Read side of the slice: paginated room history straight out of D1.
 *
 * Rows are mapped back into the protocol's `ChatMessage` so a client can render
 * history with exactly the code it already uses for live `msg` frames.
 */
import type { Env } from "../../env";
import { json, problem, type RouteDef } from "../../shared/http";
import { messageIdTimestamp } from "../../shared/ids";
import { err, ok, type Result } from "../../shared/result";
import { REPLY_EXCERPT_LENGTH, type ChatMessage } from "../../shared/protocol";

export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 200;

/**
 * The parent of a reply is joined in rather than copied into the child row, so
 * history quotes whatever the parent actually says today. A parent that was
 * soft-deleted resolves to nothing, which is the same thing a client sees live
 * when the reference has aged out of the shard's window.
 */
const SELECT_COLUMNS = `m.id, m.room_id, m.user_id, m.name, m.body, m.ts, m.masked,
  m.reply_to,
  p.user_id AS reply_user_id, p.name AS reply_name, p.body AS reply_body`;

const FROM_WITH_PARENT = `FROM messages m
  LEFT JOIN messages p ON p.id = m.reply_to AND p.deleted_at IS NULL`;

interface MessageRow {
  id: string;
  room_id: string;
  user_id: string;
  name: string;
  body: string;
  ts: number;
  masked: number;
  reply_to: string | null;
  reply_user_id: string | null;
  reply_name: string | null;
  reply_body: string | null;
}

/** Keyset cursor: `ts` alone is not unique, so the id breaks ties. */
export interface HistoryCursor {
  ts: number;
  id: string;
}

export interface HistoryPage {
  messages: ChatMessage[];
  /** Cursor to pass as `before` for the next, older page; null at the end. */
  nextBefore: string | null;
}

function toChatMessage(row: MessageRow): ChatMessage {
  const message: ChatMessage = {
    id: row.id,
    roomId: row.room_id,
    userId: row.user_id,
    name: row.name,
    body: row.body,
    ts: row.ts,
  };
  // `masked` and `roles` are optional in the protocol. Only `masked` survives
  // in D1 — roles belong to a live connection, not to history.
  if (row.masked) message.masked = true;
  if (row.reply_to && row.reply_user_id && row.reply_name !== null && row.reply_body !== null) {
    message.replyTo = {
      id: row.reply_to,
      userId: row.reply_user_id,
      name: row.reply_name,
      body: row.reply_body.slice(0, REPLY_EXCERPT_LENGTH),
    };
  }
  return message;
}

export function parseHistoryLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HISTORY_LIMIT;
  return Math.min(parsed, MAX_HISTORY_LIMIT);
}

/**
 * `before` is either a raw timestamp or a message id, so a caller can page
 * without having to know how ids are built.
 */
export async function resolveHistoryCursor(
  env: Env,
  roomId: string,
  before: string | null,
): Promise<Result<HistoryCursor | null, string>> {
  if (!before) return ok(null);
  // An empty id tiebreak keeps a pure timestamp cursor strictly exclusive.
  if (/^\d+$/.test(before)) return ok({ ts: Number.parseInt(before, 10), id: "" });

  const row = await env.CHAT_DB.prepare("SELECT ts FROM messages WHERE room_id = ? AND id = ?")
    .bind(roomId, before)
    .first<{ ts: number }>();
  if (row) return ok({ ts: row.ts, id: before });

  // The anchor row may have been deleted or trimmed; ids carry their own time.
  const ts = messageIdTimestamp(before);
  if (Number.isFinite(ts)) return ok({ ts, id: before });
  return err(`unusable "before" cursor: ${before}`);
}

export async function listRoomMessages(
  env: Env,
  roomId: string,
  limit: number,
  cursor: HistoryCursor | null,
  options: { shardIndex?: number } = {},
): Promise<HistoryPage> {
  // Soft-deleted rows stay in D1 for moderation audits but must never be read
  // back — a retroactive delete has to hold on reload too.
  const conditions = ["m.room_id = ?", "m.deleted_at IS NULL"];
  const bindings: Array<string | number> = [roomId];
  if (options.shardIndex !== undefined) {
    conditions.push("m.shard_index = ?");
    bindings.push(options.shardIndex);
  }
  if (cursor) {
    conditions.push("(m.ts < ? OR (m.ts = ? AND m.id < ?))");
    bindings.push(cursor.ts, cursor.ts, cursor.id);
  }
  bindings.push(limit);

  const { results } = await env.CHAT_DB.prepare(
    `SELECT ${SELECT_COLUMNS} ${FROM_WITH_PARENT} WHERE ${conditions.join(" AND ")} ORDER BY m.ts DESC, m.id DESC LIMIT ?`,
  )
    .bind(...bindings)
    .all<MessageRow>();

  const messages = results.map(toChatMessage);
  const last = messages[messages.length - 1];
  return {
    messages,
    nextBefore: last && messages.length === limit ? last.id : null,
  };
}

export async function getRoomMessage(
  env: Env,
  roomId: string,
  messageId: string,
): Promise<ChatMessage | null> {
  const row = await env.CHAT_DB.prepare(
    `SELECT ${SELECT_COLUMNS} ${FROM_WITH_PARENT} WHERE m.room_id = ? AND m.id = ? AND m.deleted_at IS NULL`,
  )
    .bind(roomId, messageId)
    .first<MessageRow>();
  return row ? toChatMessage(row) : null;
}

export const historyRoutes: readonly RouteDef[] = [
  {
    method: "GET",
    path: "/api/rooms/:roomId/messages",
    async handler(req, env, _ctx, { params }) {
      const roomId = params.roomId!;
      const url = new URL(req.url);
      const cursor = await resolveHistoryCursor(env, roomId, url.searchParams.get("before"));
      if (!cursor.ok) return problem(400, "malformed", cursor.error);
      const limit = parseHistoryLimit(url.searchParams.get("limit"));
      return json(await listRoomMessages(env, roomId, limit, cursor.value));
    },
  },
  {
    method: "GET",
    path: "/api/rooms/:roomId/messages/:messageId",
    async handler(_req, env, _ctx, { params }) {
      const roomId = params.roomId!;
      const messageId = params.messageId!;
      const message = await getRoomMessage(env, roomId, messageId);
      if (!message) return problem(404, "not_found", `no message ${messageId} in room ${roomId}`);
      return json({ message });
    },
  },
];
