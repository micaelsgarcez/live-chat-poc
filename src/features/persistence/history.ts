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
import type { ChatMessage } from "../../shared/protocol";

export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 200;

const SELECT_COLUMNS = "id, room_id, user_id, name, body, ts, masked";

interface MessageRow {
  id: string;
  room_id: string;
  user_id: string;
  name: string;
  body: string;
  ts: number;
  masked: number;
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
): Promise<HistoryPage> {
  // Soft-deleted rows stay in D1 for moderation audits but must never be read
  // back — a retroactive delete has to hold on reload too.
  const where = cursor
    ? "room_id = ? AND deleted_at IS NULL AND (ts < ? OR (ts = ? AND id < ?))"
    : "room_id = ? AND deleted_at IS NULL";
  const bindings: Array<string | number> = cursor
    ? [roomId, cursor.ts, cursor.ts, cursor.id, limit]
    : [roomId, limit];

  const { results } = await env.CHAT_DB.prepare(
    `SELECT ${SELECT_COLUMNS} FROM messages WHERE ${where} ORDER BY ts DESC, id DESC LIMIT ?`,
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
    `SELECT ${SELECT_COLUMNS} FROM messages WHERE room_id = ? AND id = ? AND deleted_at IS NULL`,
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
