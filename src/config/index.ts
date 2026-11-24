/**
 * The configuration module's entry point.
 *
 * Everything outside `src/config` — the composition root, the CLI, reporting and
 * evidence — imports from here, so this file is a published surface rather than a
 * convenience. Two rules keep it honest.
 *
 * ## Curation happens at the submodule boundary, composition happens here
 *
 * Each submodule already owns an `index.ts` that decides what leaves it: the
 * resolver withholds `freeze.ts` and its shape predicates, validation withholds
 * the advice it gives itself, discovery withholds the filesystem probes. Those
 * decisions were made once, by the people who know what the module looks like
 * inside.
 *
 * Re-listing every name here would duplicate those decisions and go stale the
 * first time a submodule adds a diagnostic or a contract. So this file composes
 * curated surfaces rather than curating again — which is the one place a wildcard
 * export is the right tool, because there is no longer any internal detail left
 * for it to leak.
 *
 * ## The cost of that choice, stated rather than discovered later
 *
 * `export *` from two submodules that publish the same name does **not** raise an
 * error: TypeScript silently drops the ambiguous name, and the omission shows up
 * as "property does not exist" at a call site far from the cause. A guard test
 * pins the published names for exactly that reason — see the note at the bottom of
 * this file.
 *
 * ## Never import this file from inside the module
 *
 * A submodule that reaches back through `../../index.js` creates a cycle through
 * every sibling. Imports run downward only: discovery, loader, validation and the
 * resolver each import what they need from `contracts`, `schema` or a sibling's
 * `contracts`/`index` directly.
 */

/* -------------------------------------------------------------------------- */
/* Shared vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The file name a project is read from, and the vocabulary shared across the
 * stages. Small by design: anything that only one stage needs belongs in that
 * stage's own contracts.
 */
export * from "./contracts.js";

/* -------------------------------------------------------------------------- */
/* Schema: what a configuration may contain                                   */
/* -------------------------------------------------------------------------- */

/**
 * The rules, and the values of the fields that may be omitted.
 *
 * `output`'s defaults live here because a field's default is part of deciding
 * whether the field may be absent — so the resolution stage documents them but
 * never restates them.
 */
export * from "./schema/index.js";

/* -------------------------------------------------------------------------- */
/* Discovery: where the configuration file is                                 */
/* -------------------------------------------------------------------------- */

/** One name, at the project root, with no ascent into a parent directory. */
export * from "./discovery/index.js";

/* -------------------------------------------------------------------------- */
/* Loading: bytes to an outcome                                               */
/* -------------------------------------------------------------------------- */

/**
 * Six outcomes, none of them an error, and a branded document on the one that
 * succeeded. A caller that switches on the outcome gets exhaustiveness for free.
 */
export * from "./loader/index.js";

/* -------------------------------------------------------------------------- */
/* Validation: a parsed document to a verdict                                 */
/* -------------------------------------------------------------------------- */

/**
 * The diagnostics, the codes that make them traceable, and the two mappers that
 * present findings from other stages in the same shape.
 */
export * from "./validation/index.js";

/* -------------------------------------------------------------------------- */
/* Resolution: omitted values filled, paths anchored                          */
/* -------------------------------------------------------------------------- */

/**
 * The defaulting service, the defaults catalogue, the path policy per field, and
 * the one call that turns a loaded document into a configuration a writer can act
 * on: `resolveConfiguration`.
 */
export * from "./resolver/index.js";
