/**
 * Public surface of the doctor catalogue.
 *
 * A table and the function that walks it. Everything here is what a caller needs to *ask the question*; the answer's
 * vocabulary — `CheckId`, `CheckStatus`, `DoctorReport`, `HealthCode` — is declared in `core/application/checks.ts` and
 * imported from there, because a command will eventually receive a report through a port and a port may not name an
 * implementation type.
 *
 * ## Why `HEALTH_GUIDANCE` is exported and the renderers are not
 *
 * The table is **content this layer owns**: one entry per `QAT-H` code, with the sentence and the remedy behind it.
 * Anything explaining a code should get the words from the module that wrote them, and a documentation generator or a
 * report template is a plausible future consumer.
 *
 * `healthFinding` and `unwritableFinding` turn a code into a finding, and only the catalogue calls them. Exporting a
 * renderer would offer a second way to produce a `QAT-H` finding — one that skips the check that decided the condition
 * — and the second route is the one that eventually disagrees with the first. A test that wants to exercise a renderer
 * imports it from `./guidance.js` directly, which is the same allowance this codebase already makes for a layer's own
 * tests.
 *
 * ## Why the fact shapes are exported
 *
 * `CheckFacts` is an argument type, so a caller needs it. The groups are exported beside it because the caller is the
 * gatherer, and a function returning `OutputFacts` is clearer than one returning an anonymous object literal that
 * happens to match. `RuntimeRequirementFact` belongs in that list for the same reason: the gatherer is the one that
 * reads the declared range and has to produce the value the check compares against. They are inputs, not decisions:
 * nothing here reads them.
 *
 * ## Why `FactGroup` and `FACT_KEYS` are not
 *
 * `FactGroup` appears in `CheckDefinition.requires`, and a reader gets it structurally from a `CHECKS` entry without
 * naming it. `FACT_KEYS` maps a label to a property, and it exists for the runner — a consumer indexing the facts
 * object itself wants a group it declared, not a map it found.
 *
 * ## Why the runtime rules are not exported
 *
 * `CHECKS` is the register, and a definition reachable a second way is a definition that can be registered twice or
 * registered in the wrong order. The two runtime definitions live in `./rules/node-runtime.js`, are pulled in by
 * `./rules.js`, and surface here only as entries in the table.
 *
 * ## What is no longer exported, and why
 *
 * `MINIMUM_NODE_MAJOR` used to be re-exported from this barrel. It restated the supported Node floor so prose could
 * name a version without opening a manifest, and it was kept honest by a test comparing it to `engines.node`. The range
 * now travels as evidence in `RuntimeFacts.required`, so there is no restatement left to export — and a barrel that
 * kept exporting the old constant would have been the last place a stale copy survived, quoted by exactly the code
 * that was supposed to stop quoting it.
 *
 * ## No logic in this file, ever
 *
 * A barrel is excluded from coverage on the grounds that it contains nothing to measure. A helper placed here would be
 * invisible to the coverage report without anyone noticing. Logic belongs in a sibling module — and the siblings import
 * each other directly rather than through this file, so the barrel can never become part of an import cycle.
 */
export { runChecks } from "./run.js";

/**
 * Every check, in the order a report presents them.
 *
 * Exported because it is the register: a test iterates it to hold the catalogue to its own rules, and a documentation
 * table is compared against it so the two cannot drift.
 */
export { CHECKS } from "./rules.js";

export { HEALTH_GUIDANCE } from "./guidance.js";

export type {
  CheckDefinition,
  CheckFacts,
  EnvironmentFacts,
  OutputFacts,
  OutputTarget,
  PackageManagerFacts,
  RuntimeFacts,
  RuntimeRequirementFact,
} from "./contracts.js";
