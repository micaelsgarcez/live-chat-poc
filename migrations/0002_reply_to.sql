-- Replies. Only the parent id is stored: the author and the excerpt are read
-- back with a self-join, so an edited or deleted parent can never leave a stale
-- copy of itself quoted inside a child message.
ALTER TABLE messages ADD COLUMN reply_to TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages (reply_to);
