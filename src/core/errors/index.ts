/**
 * Public surface of the error model.
 *
 * This is the only file outside `core/errors` that may be imported. Everything else in the
 * directory is an implementation detail of how errors are constructed, classified and
 * rendered, and reaching past this file couples a consumer to that arrangement.
 *
 * The practical reason is the same one that justified the domain barrel: a file may be
 * renamed, a class may move from `errors.ts` to its own module, and none of that should be
 * visible from outside. Every consumer — the CLI, the application services, the adapters —
 * imports from here.
 *
 * ## No logic in this file, ever
 *
 * is excluded from coverage on the grounds that a barrel contains nothing
 * to cover. Add a helper function here and it becomes invisible to the coverage report
 * without anyone noticing. Logic belongs in a sibling module.
 *
 * ## No duplicate names
 *
 * `export *` from two modules that both export the same name is a `TS2308` ambiguity error
 * in this file — not a silent override, but a failure whose message points here rather than
 * at the real cause. If a name needs to live in two places, one of them is wrong. This is
 * the reason `primitives.ts` exists in the domain and why `execution.ts` does not re-export
 * from it.
 *
 * ## Star exports, for now
 *
 * An explicit list documents the contract and forces a decision each time something is
 * added. Star exports let any new export become public without review. Star is right while
 * the module is under construction and every export is intended to be public — which is
 * true today. Switch to explicit named exports when the first internal helper appears that
 * should not be visible outside.
 *
 * Order is alphabetical by convention. No installed rule enforces it — `import-x/order`
 * governs imports, not exports — so it is maintained by hand.
 */

export * from "./application-error.js";
export * from "./codes.js";
export * from "./describe.js";
export * from "./errors.js";
export * from "./exit-codes.js";
