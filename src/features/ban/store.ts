/**
 * D1 side of the ban slice: the source of truth.
 *
 * Nothing here is on the connect hot path — `checkBan` goes through the KV hot
 * list and only falls back to these queries on a cache miss.
 */
import type { Env } from "../../env";
import type { BanRecord, BanStore } from "../../shared/ports";

interface BanRow {
  room_id: string;
  user_id: string;
  reason: string;
  expires_at: number;
  banned_by: string;
  created_at: number;
}

/** `expires_at = 0` is permanent; any other value is a deadline in epoch ms. */
const ACTIVE = "(expires_at = 0 OR expires_at > ?)";

/** Bounded so one pathological room cannot return an unbounded result set. */
const LIST_LIMIT = 500;

function toRecord(row: BanRow): BanRecord {
  return {
    roomId: row.room_id,
    userId: row.user_id,
    reason: row.reason,
    expiresAt: row.expires_at,
    bannedBy: row.banned_by,
    createdAt: row.created_at,
  };
}

/** True while `record` is still in force at `now`. */
export function isActive(record: BanRecord, now: number): boolean {
  return record.expiresAt === 0 || record.expiresAt > now;
}

export function createBanStore(env: Env): BanStore {
  const db = env.CHAT_DB;
  return {
    async isBanned(roomId: string, userId: string): Promise<BanRecord | null> {
      const row = await db
        .prepare(`SELECT * FROM bans WHERE room_id = ? AND user_id = ? AND ${ACTIVE}`)
        .bind(roomId, userId, Date.now())
        .first<BanRow>();
      return row ? toRecord(row) : null;
    },

    async ban(record: BanRecord): Promise<void> {
      // Re-banning an already banned user must extend the ban, not fail on the
      // (room_id, user_id) primary key.
      await db
        .prepare(
          `INSERT INTO bans (room_id, user_id, reason, expires_at, banned_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (room_id, user_id) DO UPDATE SET
             reason = excluded.reason,
             expires_at = excluded.expires_at,
             banned_by = excluded.banned_by,
             created_at = excluded.created_at`,
        )
        .bind(
          record.roomId,
          record.userId,
          record.reason,
          record.expiresAt,
          record.bannedBy,
          record.createdAt,
        )
        .run();
    },

    async unban(roomId: string, userId: string): Promise<void> {
      await db.prepare("DELETE FROM bans WHERE room_id = ? AND user_id = ?").bind(roomId, userId).run();
    },

    async list(roomId: string): Promise<BanRecord[]> {
      const { results } = await db
        .prepare(
          `SELECT * FROM bans WHERE room_id = ? AND ${ACTIVE}
           ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`,
        )
        .bind(roomId, Date.now())
        .all<BanRow>();
      return results.map(toRecord);
    },
  };
}
