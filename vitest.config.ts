// @ts-check
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Resolves a path relative to this configuration file, so the config does not
 * depend on the process working directory.
 */
const fromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    /**
     * `~` maps to `src/`, for use in tests only.
     *
     * Tests live outside `src/`, so a relative import of a deeply nested module
     * costs one `../` per directory level. Those imports break whenever a file
     * moves, and the failure is a module-not-found at test time rather than a
     * compile error.
     *
     * This alias MUST NOT be used inside `src/`. `tsc` does not rewrite module
     * specifiers, so `~/...` would be emitted verbatim into `dist/` and fail at
     * runtime for every consumer of the published package. An ESLint rule in
     * `eslint.config.js` enforces that.
     */
    alias: {
      "~": fromRoot("./src"),
    },
  },

  test: {
    /**
     * Node, not jsdom. QAT is a CLI: nothing under test touches a DOM, and
     * loading a browser-like environment would add startup cost and hide
     * accidental dependencies on browser globals.
     */
    environment: "node",

    /**
     * Globals are off deliberately. Every test imports `describe`, `it` and
     * `expect` from `vitest` explicitly, which keeps the source honest and
     * matches `tsconfig.json` restricting `types` to `node` only.
     */
    globals: false,

    /**
     * Test discovery. Only unit and integration tests run by default.
     *
     * `tests/fixtures/` is excluded because it holds self-contained Cypress
     * projects; collecting their files as QAT tests would execute third-party
     * code against QAT's own assertions.
     *
     * `tests/e2e/` is excluded because end-to-end tests spawn the built binary
     * and require `npm run build` first. They get their own configuration when
     * the first one is written; silently including slow process-spawning tests
     * in the default run is how a fast suite becomes one people stop running.
     */
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      "tests/contract/**/*.test.ts",
    ],
    exclude: [
      "tests/fixtures/**",
      "tests/e2e/**",
      "node_modules/**",
      "dist/**",
    ],

    /**
     * Forks rather than threads. Tests that spawn child processes or write to
     * the filesystem behave more predictably in separate processes, and the
     * isolation cost is negligible at this suite size.
     */
    pool: "forks",

    /**
     * Explicit timeouts. The default 5s is too short for integration tests that
     * start a real process, and an implicit default is worse than a stated one.
     */
    testTimeout: 10_000,
    hookTimeout: 10_000,

    /**
     * Reset state between tests so a mock or stubbed global defined in one test
     * cannot influence the next. Test order should never matter.
     */
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,

    /**
     * No test file should be able to pass by not existing. `test:integration`
     * overrides this with `--passWithNoTests` because that suite is legitimately
     * empty until the first adapter lands.
     */
    passWithNoTests: false,

    reporters: ["default"],

    coverage: {
      provider: "v8",

      /**
       * Report coverage even when tests fail. A failing run still produces the
       * most useful coverage signal there is.
       */
      reportOnFailure: true,

      reportsDirectory: "./coverage",

      /**
       * `html` for local inspection, `lcov` for CI tooling, `text` for the
       * terminal, `json-summary` so a later step can read one number without
       * parsing lcov.
       */
      reporter: ["text", "html", "lcov", "json-summary"],

      /**
       * Measure production source only. `tests/`, `dist/` and configuration
       * files are not product behaviour and would inflate the number.
       *
       * Setting `include` explicitly also means unimported source files count
       * as zero rather than being silently absent from the report.
       */
      include: ["src/**/*.ts"],

      exclude: [
        "src/**/*.d.ts",
        // Barrel files that only re-export. If an index.ts gains logic, delete
        // this entry rather than letting the logic go unmeasured.
        "src/**/index.ts",
        // Process bootstrap: creates a CLI, binds signals, exits. Covered by
        // end-to-end tests against the built binary, not by unit tests.
        "src/cli/index.ts",
      ],

      /**
       * THRESHOLDS ARE INTENTIONALLY NOT SET AT THIS STAGE.
       *
       * There is one production module, so any percentage target describes the
       * sample rather than the codebase. A number chosen now would be either
       * trivially satisfiable or arbitrary, and either way it would be revised
       * the moment real modules land — training people to treat thresholds as
       * noise.
       *
       * The plan, recorded in docs/development/testing-standards.md:
       *   1. Build the first real feature (Phase 2, Cypress adapter).
       *   2. Record the measured baseline as the threshold.
       *   3. Raise thresholds deliberately; never lower them to make CI pass.
       *
       * Shape to adopt once step 1 exists:
       *
       *   thresholds: {
       *     lines: <baseline>,
       *     functions: <baseline>,
       *     branches: <baseline>,
       *     statements: <baseline>,
       *   }
       *
       * A 100% requirement is explicitly rejected. It rewards assertion-free
       * tests written to touch lines, which raises the number while lowering
       * confidence — the opposite of what a coverage gate is for.
       */
    },
  },
});
