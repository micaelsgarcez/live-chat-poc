CREATE INDEX IF NOT EXISTS idx_messages_room_shard_ts
  ON messages (room_id, shard_index, ts DESC);
