/**
 * Test-only reset.
 *
 * `tests/apply-migrations.ts` applies `migrations/` to every test worker, so the
 * schema is already the real one; this only empties the two tables the slice
 * writes so each test starts from zero.
 */
export async function resetPersistenceSchema(db: D1Database): Promise<void> {
  await db.batch([db.prepare("DELETE FROM messages"), db.prepare("DELETE FROM reactions")]);
}
