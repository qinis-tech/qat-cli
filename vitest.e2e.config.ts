import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * The end-to-end suite, kept separate because it needs a built `dist/` and spawns real processes.
 *
 * Separate rather than included in the main config so that `npm test` stays runnable on a checkout
 * with no build. The trigger for this file was the first command that spawns the binary, which is
 * what the testing architecture document said to wait for.
 */
const fromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: { alias: { "~": fromRoot("./src") } },
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
