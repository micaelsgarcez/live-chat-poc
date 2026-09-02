/**
 * D1 side of the ranking slice.
 *
 * Everything here is deliberately set-based: a cron run may touch dozens of
 * rooms, and D1 is the one storage every slice shares, so a per-user query
 * would turn one refresh into hundreds of round trips.
 */
import type { Env } from "../../env";
import type { RankingEntry, RankingSnapshot } from "../../shared/ports";

/** Points for sending a message. */
export const MESSAGE_POINTS = 1;
/**
 * Points for a reaction received. Reacting costs another user an action, so a
 * reacted-to message is worth more than a message nobody answered.
 */
export const REACTION_POINTS = 3;

/** How many users a snapshot carries. */
export const RANKING_TOP_N = 50;

interface TopUserRow {
  user_id: string;
  name: string;
  messages: number;
  reactions: number;
  score: number;
}

/**
 * One aggregate pass per room.
 *
 * The two halves are unioned instead of joined because joining `reactions` onto
 * `messages` would multiply each message row by its reaction count and inflate
 * the message tally. Deleted messages are excluded on both sides: a retroactive
 * delete must take its reactions out of the score with it.
 */
const TOP_USERS_SQL = `
  SELECT
    user_id,
    MAX(name) AS name,
    SUM(messages) AS messages,
    SUM(reactions) AS reactions,
    SUM(messages) * ${MESSAGE_POINTS} + SUM(reactions) * ${REACTION_POINTS} AS score
  FROM (
    SELECT m.user_id AS user_id, m.name AS name, 1 AS messages, 0 AS reactions
      FROM messages m
     WHERE m.room_id = ? AND m.ts >= ? AND m.deleted_at IS NULL
    UNION ALL
    SELECT m.user_id AS user_id, m.name AS name, 0 AS messages, 1 AS reactions
      FROM reactions r
      JOIN messages m ON m.id = r.message_id
     WHERE m.room_id = ? AND r.ts >= ? AND m.deleted_at IS NULL
  )
  GROUP BY user_id
  ORDER BY score DESC, user_id ASC
  LIMIT ${RANKING_TOP_N}
`;

/**
 * Top scorers of `roomId` since `since` (epoch ms), highest first.
 *
 * `MAX(name)` keeps the aggregate deterministic when a user changed display
 * name inside the window — SQLite would otherwise pick an arbitrary row.
 */
export async function queryTopUsers(
  env: Env,
  roomId: string,
  since: number,
): Promise<RankingEntry[]> {
  const { results } = await env.CHAT_DB.prepare(TOP_USERS_SQL)
    .bind(roomId, since, roomId, since)
    .all<TopUserRow>();

  return results.map((row) => ({
    userId: row.user_id,
    name: row.name,
    messages: row.messages,
    reactions: row.reactions,
    score: row.score,
  }));
}

/**
 * Rooms that saw traffic since `since`. Capped so a single cron invocation
 * cannot run past the CPU budget on a busy deployment; the next tick a minute
 * later picks up where this one stopped being able to.
 */
export async function listActiveRooms(
  env: Env,
  since: number,
  limit: number,
): Promise<string[]> {
  const { results } = await env.CHAT_DB.prepare(
    "SELECT DISTINCT room_id FROM messages WHERE ts > ? ORDER BY room_id LIMIT ?",
  )
    .bind(since, limit)
    .all<{ room_id: string }>();
  return results.map((row) => row.room_id);
}

/**
 * Appends the snapshot to the durable history and trims the room back to its
 * `keep` most recent ones — the KV copy is what gets read, D1 only keeps enough
 * history to see how a ranking moved.
 */
export async function writeSnapshot(
  env: Env,
  snapshot: RankingSnapshot,
  keep: number,
): Promise<void> {
  await env.CHAT_DB.batch([
    env.CHAT_DB.prepare(
      `INSERT OR REPLACE INTO ranking_snapshots (room_id, generated_at, window_ms, payload_json)
       VALUES (?, ?, ?, ?)`,
    ).bind(snapshot.roomId, snapshot.generatedAt, snapshot.windowMs, JSON.stringify(snapshot.top)),
    env.CHAT_DB.prepare(
      `DELETE FROM ranking_snapshots
        WHERE room_id = ?
          AND generated_at NOT IN (
            SELECT generated_at FROM ranking_snapshots
             WHERE room_id = ? ORDER BY generated_at DESC LIMIT ?
          )`,
    ).bind(snapshot.roomId, snapshot.roomId, keep),
  ]);
}
