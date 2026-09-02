/**
 * Test-only helper.
 *
 * `tests/apply-migrations.ts` already applies `migrations/` to every test
 * worker, so the tables exist; this only clears the slice's rows so each test
 * starts from a known state.
 */
import type { Env } from "../../env";

export async function ensureBanSchema(env: Env): Promise<void> {
  await env.CHAT_DB.prepare("DELETE FROM bans").run();
}
