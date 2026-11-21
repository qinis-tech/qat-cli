/**
 * Discovery inputs, and the fixed lists that make discovery deterministic.
 *
 * Every lookup in this module is a check against an ordered list of candidate names rather than a
 * directory listing. That is deliberate: directory iteration order is filesystem-dependent, so a
 * listing-based search could return a different answer on two machines holding identical files.
 * Candidates in a fixed order give the same answer everywhere.
 */

/** Configuration filenames Cypress recognises, most specific first. */
export const CYPRESS_CONFIG_FILES = [
  "cypress.config.ts",
  "cypress.config.mts",
  "cypress.config.cts",
  "cypress.config.js",
  "cypress.config.mjs",
  "cypress.config.cjs",
] as const;

/** Spec directories in the order Cypress has used them, newest convention first. */
export const SPEC_DIRECTORIES = [
  "cypress/e2e",
  "cypress/integration",
  "cypress",
] as const;

/** Support-file locations, TypeScript before JavaScript and e2e before the legacy index. */
export const SUPPORT_FILES = [
  "cypress/support/e2e.ts",
  "cypress/support/e2e.js",
  "cypress/support/index.ts",
  "cypress/support/index.js",
] as const;

/** Conventional source roots, checked only to fill an optional field. */
export const SOURCE_DIRECTORIES = ["src", "lib", "app"] as const;

/** Lockfiles, in precedence order when more than one is present. */
export const LOCKFILES = [
  { file: "package-lock.json", manager: "npm" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lockb", manager: "bun" },
] as const satisfies readonly {
  readonly file: string;
  readonly manager: string;
}[];

/** Levels ascended when looking for a project root or a workspace install. */
export const DEFAULT_MAX_PARENT_DEPTH = 8;

export interface ProjectDiscoveryOptions {
  /**
   * Directory to begin from. Defaults to the process working directory.
   *
   * A relative value is resolved against the process working directory, so a caller may pass a
   * value straight from a flag without normalising it first.
   */
  readonly cwd?: string;

  /**
   * Whether to ascend towards the filesystem root when the starting directory is not a project
   * root. **Defaults to false.**
   *
   * Off by default because ascending silently means a command run in the wrong place reports a
   * project you did not know you were inside. Being wrong loudly is cheaper than being helpful
   * unexpectedly.
   */
  readonly searchParents?: boolean;

  /** Levels to ascend when `searchParents` is true. Ignored otherwise. */
  readonly maxParentDepth?: number;
}
