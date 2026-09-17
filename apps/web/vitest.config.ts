import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for the web app's pure logic.
 *
 * This config exists because these tests were silently not running at all: the package
 * had no `test` script, so `turbo run test` skipped it and the launch funding-plan
 * tests — which check money arithmetic — never executed in any run of `pnpm test`.
 *
 * Scope is deliberately narrow. Only modules that can be tested without a database, a
 * browser or the chain belong here; everything else is covered where it lives.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
