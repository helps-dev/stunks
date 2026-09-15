import { defineConfig } from "vitest/config";

/**
 * Repository tests against a real Postgres instance.
 *
 * Separate from `pnpm test` because they need a database. Run with:
 *
 *   RUN_DB_TESTS=1 pnpm test:db
 *
 * No dotenv wrapper is needed: the generated Prisma client loads the root .env
 * itself, so DATABASE_URL is picked up from there.
 *
 * They create and delete their own rows under a fixed marker, so they are safe to
 * re-run and do not touch real indexed data.
 *
 * Expect them to be slow — roughly two minutes against a hosted Neon instance,
 * because each assertion is a real round trip over the network. That is the cost of
 * testing constraints that only exist in the database.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Serial: these share a database and assert on row counts.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
