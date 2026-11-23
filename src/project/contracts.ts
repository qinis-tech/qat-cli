/**
 * Discovery inputs, and the fixed lists that make discovery deterministic.
 *
 * Every lookup governed by this file is a check against an ordered list of candidate names rather than a
 * directory listing. That is deliberate: directory iteration order is filesystem-dependent, so a
 * listing-based search could return a different answer on two machines holding identical files. Candidates
 * in a fixed order give the same answer everywhere.
 *
 * Scope: how a project's *directory layout* is described — where the configuration lives, where specs live,
 * how far to climb. Lists that describe the *contents of a manifest* belong beside the reader that parses
 * it, in `./package-discovery/manifest.ts`, and follow the same determinism rule for the same reason. Two
 * files rather than one because the two questions are answered independently: a project can have a manifest
 * and no layout, or a layout and no manifest.
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

/**
 * Spec directories in the order Cypress has used them, newest convention first.
 *
 * `cypress/e2e` leads because it is the current convention; `cypress` is last because it matches only a
 * project predating both named directories, where everything sits directly under `cypress/`.
 */
export const SPEC_DIRECTORIES = [
  "cypress/e2e",
  "cypress/integration",
  "cypress",
] as const;

/**
 * Support-file locations, TypeScript before JavaScript and e2e before the legacy index.
 *
 * Both axes are conventions rather than preferences: `e2e` is Cypress 10 and later, `index` is earlier, and
 * a repository holding both is one that has been upgraded without deleting the old file.
 */
export const SUPPORT_FILES = [
  "cypress/support/e2e.ts",
  "cypress/support/e2e.js",
  "cypress/support/index.ts",
  "cypress/support/index.js",
] as const;

/** Conventional source roots, checked only to fill an optional field. */
export const SOURCE_DIRECTORIES = ["src", "lib", "app"] as const;

/**
 * Levels ascended when looking for a project root, or for an installed package.
 *
 * One number for two questions, which is a compromise worth stating: ascending to find a project root is
 * off by default and rarely goes far, while ascending to find a hoisted install routinely goes three or four
 * levels. Eight covers both without being so large that a mistaken starting directory can wander into an
 * unrelated tree, and each caller passes a bound rather than relying on a default, so raising one does not
 * silently widen the other.
 */
export const DEFAULT_MAX_PARENT_DEPTH = 8;

export interface ProjectDiscoveryOptions {
  /**
   * Directory to begin from. Defaults to the process working directory.
   *
   * A relative value is resolved against the process working directory, so a caller may pass a value
   * straight from a flag without normalising it first. Through the discovery port this has already been
   * absolutised by the working-directory resolver; a relative value still works for a direct call, which is
   * what the tests and the composition adapter do.
   */
  readonly cwd?: string;

  /**
   * Whether to ascend towards the filesystem root when the starting directory is not a project root.
   * **Defaults to false.**
   *
   * Off by default because ascending silently means a command run in the wrong place reports a project you
   * did not know you were inside. Being wrong loudly is cheaper than being helpful unexpectedly.
   *
   * Note that this governs the search for the *project root* only. The search for an installed package
   * always climbs, because a workspace that hoists its dependencies to the root is the ordinary case rather
   * than an unusual one.
   */
  readonly searchParents?: boolean;

  /** Levels to ascend when `searchParents` is true. Ignored otherwise. */
  readonly maxParentDepth?: number;
}
