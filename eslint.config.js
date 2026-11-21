// @ts-check
/**
 * ESLint flat configuration for QAT.
 *
 * Design principles:
 *   1. Type-aware linting everywhere it is possible. Type-aware rules catch the
 *      class of bug that a syntax-only linter cannot see.
 *   2. `error` blocks CI; `warn` is advisory only. No rule is set to `warn` unless
 *      the correct action genuinely depends on judgement.
 *   3. Prettier owns formatting. ESLint owns correctness. `eslint-config-prettier`
 *      is applied last so the two never disagree.
 */

import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import importX from "eslint-plugin-import-x";
import globals from "globals";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import vitest from "@vitest/eslint-plugin";

/**
 * Paths never linted or formatted.
 *
 * `tests/fixtures/` and `examples/` contain self-contained Cypress projects that
 * are deliberately written to third-party conventions. Linting them with QAT's
 * rules would fail on code QAT does not own and must not reformat.
 */
const IGNORED = [
  "**/dist/**",
  "**/node_modules/**",
  "**/coverage/**",
  "**/.qat/**",
  "tests/fixtures/**",
  "examples/**",
];

export default defineConfig(
  globalIgnores(IGNORED),

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Plain JavaScript — config files, scripts
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    linterOptions: {
      // A suppression comment that no longer suppresses anything is a stale lie.
      // Treat it as an error so it gets removed.
      reportUnusedDisableDirectives: "error",
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 2. TypeScript — the main rule set
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ["**/*.ts"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      importX.flatConfigs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        // `projectService` resolves the nearest tsconfig per file. Preferred over
        // `project: true` because it is faster and tolerates files outside src.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    settings: {
      "import-x/parsers": { "@typescript-eslint/parser": [".ts"] },
    },
    rules: {
      // ── Unused code ────────────────────────────────────────────────────────
      // Core rule does not understand type-only syntax; use the TS version.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          // A leading underscore is the agreed opt-out for intentionally
          // unused parameters, which adapter and middleware signatures need.
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      // ── Unsafe type usage ──────────────────────────────────────────────────
      // `any` disables the type system at the exact boundary where untrusted
      // data enters. For a tool that parses framework output, that boundary is
      // the most dangerous place in the codebase.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        {
          assertionStyle: "as",
          // `{ ... } as Config` asserts a shape the compiler never checked.
          objectLiteralTypeAssertions: "never",
        },
      ],
      // Non-null assertion is sometimes the honest answer after an explicit
      // check. Warn rather than ban.
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/no-deprecated": "warn",

      // ── Async correctness ──────────────────────────────────────────────────
      // An un-awaited promise in a CLI means a command exits before its work
      // finishes and the exit code is meaningless. These are errors, not hints.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],

      // ── Import consistency ─────────────────────────────────────────────────
      // `verbatimModuleSyntax` is enabled in tsconfig, so a value import of a
      // type is a runtime import of nothing. This rule keeps that honest and
      // is autofixable.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-require-imports": "error",
      "no-duplicate-imports": "off",
      "import-x/no-duplicates": "error",
      "import-x/newline-after-import": "error",
      "import-x/no-absolute-path": "error",
      "import-x/order": [
        "error",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index",
          ],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      // Resolution is already enforced by `tsc` with moduleResolution: nodenext,
      // which also understands the mandatory `.js` extension on TS imports.
      // The ESLint resolver does not, so duplicating the check here only
      // produces false positives.
      "import-x/no-unresolved": "off",
      "import-x/named": "off",
      "import-x/default": "off",

      // ── Error-prone patterns ───────────────────────────────────────────────
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-debugger": "error",
      "no-var": "error",
      "prefer-const": "error",
      "no-implicit-coercion": "error",
      "no-param-reassign": "error",
      "no-shadow": "off",
      "@typescript-eslint/no-shadow": "error",
      // Preserve the original error when wrapping it. Losing the cause is the
      // difference between an actionable diagnostic and "something failed".
      "preserve-caught-error": "error",
      // Exhaustiveness over discriminated unions. Directly relevant to the
      // exit-code and result-status unions, where a new member silently falling
      // through a switch produces a wrong exit code.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: false },
      ],
      // Exit codes are part of QAT's public contract and must be testable.
      // A raw process.exit() bypasses the exit-code abstraction and cannot be
      // asserted on in a unit test.
      "no-process-exit": "error",
      // Console output bypasses Pino, losing level filtering, redaction and
      // structured fields. CLI output goes through src/cli/output/.
      "no-console": "error",
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Tests — relax what only makes sense in production code
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ["tests/**/*.ts", "**/*.test.ts"],
    extends: [vitest.configs.recommended],
    rules: {
      // Tests build deliberately malformed input. Strict typing there tests the
      // compiler, not the code.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      // Vitest's expect() reads as an unused expression to the core rule.
      "@typescript-eslint/no-unused-expressions": "off",
      // Mock function type definitions use unbound method signatures.
      "@typescript-eslint/unbound-method": "off",
      "no-console": "off",

      // ── Test-specific conventions ──────────────────────────────────────────
      // A committed `.only` silently reduces the suite to one test while the
      // run still reports success. This is the highest-value test rule here.
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "warn",
      "vitest/expect-expect": "error",
      "vitest/valid-expect": "error",
      "vitest/prefer-strict-equal": "warn",
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Tool configuration files — no type information available
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ["**/*.config.ts", "vitest.config.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "no-console": "off",
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Narrow exemptions to the rules above
  // ───────────────────────────────────────────────────────────────────────────

  // The only module permitted to terminate the process.
  {
    files: ["src/core/process/**/*.ts"],
    rules: {
      "no-process-exit": "off",
      "no-console": "off",
    },
  },

  // The only module permitted to write directly to a stream.
  {
    files: ["src/cli/output/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // The `~` alias is not rewritten by tsc and would break the published build.
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['~/*'],
              message:
                'src/ must use relative imports. The ~ alias is not rewritten by tsc and would fail at runtime for package consumers.',
            },
          ],
        },
      ],
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Prettier — MUST be last. Disables every formatting-related ESLint rule.
  // ───────────────────────────────────────────────────────────────────────────
  prettier,
);
