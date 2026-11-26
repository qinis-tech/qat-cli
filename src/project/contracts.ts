/**
 * Discovery inputs, and the fixed lists that make discovery deterministic.
 *
 * Every lookup governed by this file is a check against an ordered list of candidate names rather than a directory
 * listing. That is deliberate: directory iteration order is filesystem-dependent, so a listing-based search could
 * return a different answer on two machines holding identical files. Candidates in a fixed order give the same
 * answer everywhere.
 *
 * Scope: how a project's *directory layout* is described — where the configuration lives, where specs live, how far
 * to climb. Three kinds of list are deliberately kept apart, each beside the code that owns it:
 *
 * | Question | Owner |
 * | --- | --- |
 * | What may a project layout contain? | this file |
 * | What may a manifest *contain*? | `./package-discovery/manifest.ts` |
 * | Which lockfile or marker means which package manager? | `./package-manager/policy.ts` |
 *
 * They are separate because the questions are answered independently: a project can have a manifest and no layout,
 * a layout and no manifest, and a lockfile with neither. Keeping them apart also keeps each list under one test —
 * the package-manager table in particular is asserted against its own documentation, and would immediately go out of
 * step if a second copy of "pnpm's lockfile is named…" lived here.
 *
 * The lists are *names*, and nothing more. Which name wins when several exist is a rule, and rules live where they
 * are applied — the layout reader for the legacy fallback, the validation classifier for whether a shape is
 * driveable. Putting a precedence here would make two callers share one answer they do not both want.
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
 * Spec directories Cypress has used, newest convention first.
 *
 * Named directories only. `cypress` is a fallback rather than a candidate — see `LEGACY_SPEC_DIRECTORY` — because it
 * exists in every project that has any Cypress directory at all. Counting it here makes every modern project report
 * its own parent as a spec location: two entries where the project has one, and a run pointed at `cypress/` would
 * collect the support files along with the specs.
 *
 * `cypress/component` is deliberately absent. Component testing is a real Cypress convention and QAT has no
 * execution path for it, so reporting that directory here would send a run at files anywhere the adapter cannot drive
 * them. It is reported separately, as evidence, and the validation layer is what decides that it is not enough.
 */
export const SPEC_DIRECTORIES = ["cypress/e2e", "cypress/integration"] as const;

/**
 * The specs root Cypress used before version 10, where specs sat directly under `cypress/`.
 *
 * A fallback, not a candidate, and the distinction is load-bearing: `cypress/` is present in a modern project too, so
 * a list that always contains it cannot say whether a project has named spec directories or only the legacy root. The
 * layout reader applies it when nothing more specific exists, which is the one layout it describes.
 *
 * It lives here, beside the candidate list, because the two are halves of one rule — the names that count, and the
 * one that only counts when the others do not.
 */
export const LEGACY_SPEC_DIRECTORY = "cypress";

/**
 * Support-file locations, TypeScript before JavaScript and e2e before the legacy index.
 *
 * Both axes are conventions rather than preferences: `e2e` is Cypress 10 and later, `index` is earlier, and a
 * repository holding both is one that has been upgraded without deleting the old file.
 */
export const SUPPORT_FILES = [
  "cypress/support/e2e.ts",
  "cypress/support/e2e.js",
  "cypress/support/index.ts",
  "cypress/support/index.js",
] as const;

/** Conventional source roots, checked only to fill an optional field. */
export const SOURCE_DIRECTORIES = ["src", "lib", "app"] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Manifest and install artefacts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The package manifest filename.
 *
 * Here rather than repeated at each call site because it is a *layout* fact, not a fact about the manifest's
 * contents: several readers need it — dependency discovery, the runtime requirement read, the package-manager
 * snapshot — and three copies of the same string is three chances for one of them to be typo'd into silence. The
 * reader in `./package-discovery/manifest.ts` imports this rather than declaring its own.
 *
 * Singular on purpose. npm has no alternative manifest name, and inventing a candidate list here would be inventing
 * a convention the ecosystem does not have.
 */
export const PACKAGE_MANIFEST_FILE = "package.json";

/**
 * The installed-dependency directory.
 *
 * Held beside the manifest name because "is this project installed?" and "what does this project declare?" are asked
 * about the same two artefacts, and because the package-manager snapshot must compare the *name* case-insensitively
 * and accept a symlinked directory: workspace layouts legitimately symlink it. Callers that treat presence as a
 * plain boolean tend to forget both of those, so the convention is documented where the name is defined.
 */
export const NODE_MODULES_DIRECTORY = "node_modules";

/**
 * Levels ascended when looking for a project root, or for an installed package.
 *
 * One number for two questions, which is a compromise worth stating: ascending to find a project root is off by
 * default and rarely goes far, while ascending to find a hoisted install routinely goes three or four levels. Eight
 * covers both without being so large that a mistaken starting directory can wander into an unrelated tree, and each
 * caller passes a bound rather than relying on a default, so raising one does not silently widen the other.
 */
export const DEFAULT_MAX_PARENT_DEPTH = 8;

export interface ProjectDiscoveryOptions {
  /**
   * Directory to begin from. Defaults to the process working directory.
   *
   * A relative value is resolved against the process working directory, so a caller may pass a value straight from a
   * flag without normalising it first. Through the discovery port this has already been absolutised by the
   * working-directory resolver; a relative value still works for a direct call, which is what the tests and the
   * composition adapter do.
   */
  readonly cwd?: string;

  /**
   * Whether to ascend towards the filesystem root when the starting directory is not a project root.
   * **Defaults to false.**
   *
   * Off by default because ascending silently means a command run in the wrong place reports a project you did not
   * know you were inside. Being wrong loudly is cheaper than being helpful unexpectedly.
   *
   * Note that this governs the search for the *project root* only. The search for an installed package always
   * climbs, because a workspace that hoists its dependencies to the root is the ordinary case rather than an unusual
   * one.
   */
  readonly searchParents?: boolean;

  /** Levels to ascend when `searchParents` is true. Ignored otherwise. */
  readonly maxParentDepth?: number;
}
