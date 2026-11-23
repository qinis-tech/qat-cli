/**
 * Public surface of diagnostics.
 *
 * Three things are exported, and they are the three a caller can legitimately need:
 *
 * - `diagnoseProject` — reads a directory and describes it. The entry point for a command.
 * - `diagnosisFrom` — describes evidence that already exists. The entry point for a layer that has gathered its own.
 * - `unreadableProjectDiagnosis` — the builder for the one condition detection refuses to classify.
 *
 * Plus the catalogue, which answers "what does this code mean", and the constant it needs to say so consistently.
 *
 * ## Why `diagnosisFrom` is part of the surface
 *
 * It looks like an internal step of `diagnoseProject`, and it is. It is exported because a second caller would
 * otherwise have to choose between re-running detection — two readings of one tree, which can disagree — and
 * re-implementing the mapping, which is the same drift with more code. Exporting the builder is what lets the
 * validation layer describe a project exactly as a report does.
 *
 * ## Why `unreadableProjectDiagnosis` is, and why that is a concession
 *
 * Detection throws when a manifest cannot be parsed, on the grounds that a broken file is a fault rather than an
 * answer. Two layers now catch that throw, and both need the same diagnosis. A private builder would force the
 * second catcher to write its own, and the second rendering is the one that lags.
 *
 * It is still a concession: a function whose stated purpose is to be called from a `catch` is a function that
 * documents a seam. The alternative is a result type for detection that has an `unreadable` variant, which would
 * make every consumer of the engine handle a case none of them can act on. The seam is the cheaper of the two, and
 * it is named so a reader meets it deliberately rather than by accident.
 *
 * ## The contract is deliberately not re-exported
 *
 * `ProjectDiagnosis`, `DiagnosticCode`, `DiagnosticSeverity` and the statuses live in
 * `core/application/diagnostics.ts`, and they are imported from there. Re-exporting them here would give every name
 * a second route, and a second route is the one that goes stale: a consumer importing `DiagnosticCode` from this
 * module would break the day the contract moves, having appeared to depend on an implementation.
 *
 * So the rule is the one the rest of this codebase already follows — a module exports what it declares, and a
 * consumer imports a name from the module that owns it.
 *
 * ## Why named exports rather than star exports
 *
 * `diagnose.ts` keeps ten functions private: the mapping for each section of the diagnosis, the four predicates the
 * finding set is built from, and the two helpers for the unreadable case. `catalogue.ts` keeps its `Guidance`
 * interface and its remedy helper private. A star export would publish all of them, and the first consumer to reach
 * for `isIncompatible` would have found a version comparison it was never offered — and would have used it, because
 * it is exactly the wrong place to answer "is this version supported".
 *
 * The names below are the surface. Everything else is reachable only from inside this directory, where a change to
 * it is a change to its own module.
 *
 * ## No logic in this file, ever
 *
 * `src/**\/index.ts` is excluded from coverage on the grounds that a barrel contains nothing to measure. A helper
 * placed here would be invisible to the coverage report without anyone noticing. Logic belongs in a sibling module.
 */

export {
  GUIDANCE,
  MINIMUM_CYPRESS_MAJOR,
  type DiagnosticFacts,
} from "./catalogue.js";
export {
  diagnoseProject,
  diagnosisFrom,
  unreadableProjectDiagnosis,
  type DiagnosticOptions,
} from "./diagnose.js";
