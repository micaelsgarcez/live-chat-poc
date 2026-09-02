import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Tests run against the same schema production does: the migrations are read
// here and applied to each test worker's D1 in `tests/apply-migrations.ts`.
const migrations = await readD1Migrations("migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["./tests/apply-migrations.ts"],
    // Durable Object alarms and open sockets outlive the test that created
    // them; running files in parallel tears workers down while that work is
    // still in flight, which surfaces as spurious teardown errors.
    fileParallelism: false,
  },
});
