/**
 * D1 access for moderation.
 *
 * None of this is on the WebSocket path: it runs from the queue consumer or
 * from a moderator HTTP route, which is why it is allowed to be a real write.
 */
import type { Env } from "../../env";
import { newMessageId } from "../../shared/ids";

/** D1 caps bound parameters per statement; ids are chunked well below it. */
const MAX_IDS_PER_STATEMENT = 50;

export interface ModerationActionRecord {
  id: string;
  roomId: string;
  messageId: string | null;
  userId: string | null;
  /** "delete" | "mute" — free-form so a later slice can add its own verbs. */
  action: string;
  reason: string;
  /**
   * "async" for the queue consumer, "manual:<moderatorId>" for a route. The
   * table has no actor column and is a frozen migration, so the actor rides
   * here rather than being lost.
   */
  source: string;
  createdAt: number;
}

export function newActionRecord(
  input: Omit<ModerationActionRecord, "id" | "createdAt"> & { createdAt?: number },
): ModerationActionRecord {
  const createdAt = input.createdAt ?? Date.now();
  return { ...input, id: newMessageId(createdAt), createdAt };
}

export async function recordActions(
  env: Env,
  records: readonly ModerationActionRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const insert = env.CHAT_DB.prepare(
    `INSERT OR REPLACE INTO moderation_actions
       (id, room_id, message_id, user_id, action, reason, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await env.CHAT_DB.batch(
    records.map((r) =>
      insert.bind(r.id, r.roomId, r.messageId, r.userId, r.action, r.reason, r.source, r.createdAt),
    ),
  );
}

/** Soft-deletes messages; returns how many rows actually changed. */
export async function markMessagesDeleted(
  env: Env,
  roomId: string,
  messageIds: readonly string[],
  at: number,
): Promise<number> {
  let changed = 0;
  for (const chunk of chunks(messageIds, MAX_IDS_PER_STATEMENT)) {
    const placeholders = chunk.map(() => "?").join(",");
    const result = await env.CHAT_DB.prepare(
      `UPDATE messages SET deleted_at = ?
        WHERE room_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
    )
      .bind(at, roomId, ...chunk)
      .run();
    changed += result.meta?.changes ?? 0;
  }
  return changed;
}

/** Authors of the given messages, for actions raised by a moderator by hand. */
export async function lookupMessageAuthors(
  env: Env,
  roomId: string,
  messageIds: readonly string[],
): Promise<Map<string, string>> {
  const authors = new Map<string, string>();
  for (const chunk of chunks(messageIds, MAX_IDS_PER_STATEMENT)) {
    const placeholders = chunk.map(() => "?").join(",");
    const { results } = await env.CHAT_DB.prepare(
      `SELECT id, user_id FROM messages WHERE room_id = ? AND id IN (${placeholders})`,
    )
      .bind(roomId, ...chunk)
      .all<{ id: string; user_id: string }>();
    for (const row of results) authors.set(row.id, row.user_id);
  }
  return authors;
}

export async function listActions(
  env: Env,
  roomId: string,
  limit: number,
): Promise<ModerationActionRecord[]> {
  const { results } = await env.CHAT_DB.prepare(
    `SELECT id, room_id, message_id, user_id, action, reason, source, created_at
       FROM moderation_actions WHERE room_id = ?
      ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(roomId, limit)
    .all<{
      id: string;
      room_id: string;
      message_id: string | null;
      user_id: string | null;
      action: string;
      reason: string;
      source: string;
      created_at: number;
    }>();
  return results.map((row) => ({
    id: row.id,
    roomId: row.room_id,
    messageId: row.message_id,
    userId: row.user_id,
    action: row.action,
    reason: row.reason,
    source: row.source,
    createdAt: row.created_at,
  }));
}

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
