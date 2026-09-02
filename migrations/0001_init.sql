-- Live chat: source-of-truth schema (D1 / SQLite).
-- Everything on the hot path is written asynchronously from Queues; nothing in
-- here is on the WebSocket request path.

CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT '',
  closed        INTEGER NOT NULL DEFAULT 0,
  config_json   TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  body          TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  shard_index   INTEGER NOT NULL DEFAULT 0,
  masked        INTEGER NOT NULL DEFAULT 0,
  deleted_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages (room_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_messages_room_user_ts ON messages (room_id, user_id, ts DESC);

CREATE TABLE IF NOT EXISTS bans (
  room_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  reason        TEXT NOT NULL DEFAULT '',
  expires_at    INTEGER NOT NULL DEFAULT 0,
  banned_by     TEXT NOT NULL DEFAULT 'system',
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_bans_room ON bans (room_id, expires_at);

CREATE TABLE IF NOT EXISTS reactions (
  message_id    TEXT NOT NULL,
  room_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  emoji         TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_reactions_room_ts ON reactions (room_id, ts DESC);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL,
  message_id    TEXT,
  user_id       TEXT,
  action        TEXT NOT NULL,
  reason        TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'async',
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_moderation_room_created ON moderation_actions (room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ranking_snapshots (
  room_id       TEXT NOT NULL,
  generated_at  INTEGER NOT NULL,
  window_ms     INTEGER NOT NULL,
  payload_json  TEXT NOT NULL,
  PRIMARY KEY (room_id, generated_at)
);
