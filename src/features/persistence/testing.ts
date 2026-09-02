/**
 * Test-only D1 schema.
 *
 * `vitest.config.ts` is a frozen contract and does not run the migrations into
 * the test database, so the tables this slice reads and writes are created per
 * test file. Keep in sync with `migrations/0001_init.sql`.
 */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS messages (
     id          TEXT PRIMARY KEY,
     room_id     TEXT NOT NULL,
     user_id     TEXT NOT NULL,
     name        TEXT NOT NULL,
     body        TEXT NOT NULL,
     ts          INTEGER NOT NULL,
     shard_index INTEGER NOT NULL DEFAULT 0,
     masked      INTEGER NOT NULL DEFAULT 0,
     deleted_at  INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages (room_id, ts DESC)`,
  `CREATE TABLE IF NOT EXISTS reactions (
     message_id TEXT NOT NULL,
     room_id    TEXT NOT NULL,
     user_id    TEXT NOT NULL,
     emoji      TEXT NOT NULL,
     ts         INTEGER NOT NULL,
     PRIMARY KEY (message_id, user_id, emoji)
   )`,
];

/** Creates the tables and clears them, so each test starts from empty. */
export async function resetPersistenceSchema(db: D1Database): Promise<void> {
  for (const sql of STATEMENTS) await db.prepare(sql).run();
  await db.batch([db.prepare("DELETE FROM messages"), db.prepare("DELETE FROM reactions")]);
}
