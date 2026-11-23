/**
 * Public surface of diagnostics.
 *
 * Two things are exported: the entry point that builds a diagnosis, and the catalogue that explains what a code
 * means. Everything else in this directory is the machinery behind them.
 *
 * ## The contract is deliberately not re-exported
 *
 * `ProjectDiagnosis`, `DiagnosticCode`, `DiagnosticSeverity` and the statuses live in
 * `core/application/diagnostics.ts`, and they are imported from there. Re-exporting them here would give every name a
 * second route, and a second route is the one that goes stale: a consumer importing `DiagnosticCode` from this module
 * would break the day the contract moves, having appeared to depend on an implementation.
 *
 * So the rule is the one the rest of this codebase already follows — a module exports what it declares, and a consumer
 * imports a name from the module that owns it.
 *
 * ## Why named exports rather than star exports
 *
 * `catalogue.ts` exports `majorOf`, which is an implementation detail of the version comparison. A star export would
 * publish it, and the first consumer to reach for it would have found a semver helper it was never offered. The names
 * below are the surface; the rest is not.
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
export { diagnoseProject, type DiagnosticOptions } from "./diagnose.js";
