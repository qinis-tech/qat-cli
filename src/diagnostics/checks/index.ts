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
 * happens to match.
 *
 * That reasoning now covers two groups and three groups' worth of shapes, which is worth stating plainly rather than
 * leaving to inference. The runtime group needs `RuntimeRequirementFact` and `RuntimeFacts`; the package-manager group
 * needs `PackageManagerFacts` plus the four pieces it is assembled from — how identity was established, what the
 * executable probe found, how far an install got, and why a version could not be read. A gatherer produces all of them,
 * and a gatherer that had to deep-import `./contracts.js` to name its own output would be a caller of this layer
 * reaching around its surface for no reason.
 *
 * They are inputs, not decisions: nothing here reads them.
 *
 * ## Why `FactGroup` and `FACT_KEYS` are not
 *
 * `FactGroup` appears in `CheckDefinition.requires`, and a reader gets it structurally from a `CHECKS` entry without
 * naming it. `FACT_KEYS` maps a label to a property, and it exists for the runner — a consumer indexing the facts
 * object itself wants a group it declared, not a map it found.
 *
 * The rules import `FactGroup` from `./contracts.js` directly, which is the narrower route: a rule knows the group it
 * reads by name, and going through the barrel to reach a value the barrel deliberately withholds would make the
 * withholding look accidental.
 *
 * ## Why the rule definitions are not exported
 *
 * `CHECKS` is the register, and a definition reachable a second way is a definition that can be registered twice or
 * registered in the wrong order. The runtime pair and the package-manager ladder live in `./rules/*.js`, are pulled in
 * by `./rules.js`, and surface here only as entries in the table.
 *
 * A test that needs one definition finds it in `CHECKS` by identifier, which is also how the runner finds it — so the
 * test and the product agree about where a check comes from rather than the test having a private route.
 *
 * ## What is no longer exported, and why
 *
 * `MINIMUM_NODE_MAJOR` used to be re-exported from this barrel. It restated the supported Node floor so prose could
 * name a version without opening a manifest, and it was kept honest by a test comparing it to `engines.node`. The range
 * now travels as evidence in `RuntimeFacts.required`, so there is no restatement left to export — and a barrel that
 * kept exporting the old constant would have been the last place a stale copy survived, quoted by exactly the code
 * that was supposed to stop quoting it.
 *
 * The same fate applies to any name whose only purpose was migration. A deprecated alias re-exported here would be
 * reachable by every consumer, which is the opposite of narrowing a vocabulary: the compiler could no longer tell
 * anyone which call sites had moved, because they all still resolve.
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
  /** The runtime group, and the narrowed requirement a gatherer produces for it. */
  RuntimeFacts,
  VersionRequirementFact,
  /** The package-manager group, and the four shapes a gatherer assembles it from. */
  PackageManagerFacts,
  PackageManagerSelection,
  PackageManagerExecutableFact,
  PackageManagerInstallState,
  UnverifiedVersionReason,
  /** The configuration-file and environment groups. */
  EnvironmentFacts,
  /** The two output directories, and the values a prober reports for each. */
  OutputFacts,
  OutputTarget,
} from "./contracts.js";
