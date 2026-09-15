import { defineConfig } from "vitest/config";

/**
 * Live read-only tests against Robinhood Chain mainnet.
 *
 * Kept in a separate config and a separate file glob so that `pnpm test` never
 * depends on the network. Run with:
 *
 *   RUN_LIVE_TESTS=1 pnpm test:integration
 *
 * These are read-only: no transaction is ever signed or sent.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Serial: public endpoints rate-limit aggressively.
    fileParallelism: false,
  },
});
