import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// Every test worker starts with the real schema from `migrations/`, which
// `vitest.config.ts` injects as a test-only binding.
const { TEST_MIGRATIONS } = env as unknown as { TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(env.CHAT_DB, TEST_MIGRATIONS);
