/**
 * Public surface of the environment module.
 *
 * Everything outside `src/config/environment` imports from here: the checks layer reads the
 * inspection type, the rules call the selector, the classifier and the evidence builder, and the
 * root `src/config/index.js` re-publishes a curated subset of this file by name.
 *
 * ## The module depends on nothing else in `src/config`
 *
 * Deliberately, and it is worth stating because the neighbouring modules do not share the property.
 * `environment` speaks about one section of a document that has *already* been validated by the time
 * anything here runs: the declared profiles arrive as data, the selection arrives as a value, and the
 * presence of a variable arrives as an enum from a port this module declares but does not implement.
 *
 * So there is no import of `./schema`, `./loader` or `./inspect` here, and none in the files below.
 * The consequence is testable in one sentence: the whole module can be exercised with literals and
 * three-function fakes, no filesystem, and no valid configuration file anywhere in sight.
 *
 * ## Why these exports are wildcards
 *
 * Each file in this directory decides what it exports, and those decisions were made with the file's
 * own invariants in view — `inspect.ts` exports its policy constant and its entry point but not its
 * private reference verification, `selectedProfileOf`-style narrowing stays in the prose catalogue
 * where it is read, and `diagnostics/` curates its own surface one level down. Re-listing every name
 * here would duplicate those decisions and go stale the first time a condition is added.
 *
 * The one hazard of a wildcard is that two files publish the same name and the ambiguous export is
 * dropped without an error. That is checked where it matters: the root barrel re-publishes this
 * module **by name**, and its guard test pins the list — so a collision inside this directory shows
 * up as a missing name at the root, which is the right place for it to fail.
 *
 * ## What the root withholds, and why that is not an accident
 *
 * `toProjectRelative` is exported here and is deliberately **not** re-published from
 * `src/config/index.js`, because `config/diagnostics/evidence.ts` exports a function of the same name
 * and a wildcard at the root would resolve that collision by dropping one of them. A caller that needs
 * the environment version imports this file directly and says so.
 *
 * That duplication is acknowledged debt rather than a design: two implementations of one idea is one
 * too many, and the eventual fix is for this module's evidence builder to reuse the stronger of the
 * two — after which the survivor is published once, from the root, and this note goes away.
 *
 * ## What is *not* here
 *
 * No port implementation. `EnvironmentPresencePort` is declared in `contracts.ts` because this module
 * is its consumer, and implemented in `core/environment` because that is where `process.env` lives.
 * Exporting an implementation from here would invert the direction the whole arrangement exists to
 * protect.
 */

// ─── Vocabulary and contracts ────────────────────────────────────────────────
//
// The six-way inspection, the per-reference verdicts, the reason codes and the two port interfaces.
// Types only, plus the two frozen policy constants that a caller must not restate: `declared` is
// what exists, `approved` is what is allowed, and both are quoted back in findings.
export * from "./contracts.js";

// ─── Selection ───────────────────────────────────────────────────────────────
//
// Precedence, and the reason it chose what it chose. Pure: the same three inputs always produce the
// same selection and the same origin, which is what makes environment resolution deterministic in
// the sense the requirement asks for.
export * from "./select.js";

// ─── Inspection ──────────────────────────────────────────────────────────────
//
// The state machine: not selected, unusable selection, undeclared profile, invalid profile, usable.
// Also exports the approved-source policy, because a check that renders "only `env` is supported"
// must be quoting the list that was actually applied.
export * from "./inspect.js";

// ─── Diagnostics ─────────────────────────────────────────────────────────────
//
// `classifyEnvironment` turns the inspection into findings; `buildEnvironmentEvidence` assembles the
// safe evidence; the sanitisers are the output gate, exported so the rule layer's human rendering
// uses one implementation of "safe to print" rather than a copy per renderer.
//
// Everything here is environment-shaped, not diagnostic-shaped: the shared `CheckFinding` type is
// constructed at the rule boundary, so this module stays reusable by `qat run`'s preflight, which
// needs the same verdicts without a doctor.
export * from "./diagnostics/index.js";
