/**
 * Test-only schema bootstrap.
 *
 * `@cloudflare/vitest-pool-workers` gives each run an empty D1 database — it
 * does not apply `migrations/`. This mirrors the `bans` table from
 * `migrations/0001_init.sql` so the slice's tests exercise the real SQL.
 */
import type { Env } from "../../env";

export async function ensureBanSchema(env: Env): Promise<void> {
  await env.CHAT_DB.exec(
    "CREATE TABLE IF NOT EXISTS bans (room_id TEXT NOT NULL, user_id TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL DEFAULT 0, banned_by TEXT NOT NULL DEFAULT 'system', created_at INTEGER NOT NULL, PRIMARY KEY (room_id, user_id))",
  );
}
