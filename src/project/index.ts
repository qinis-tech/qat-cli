/**
 * Public surface of project discovery.
 *
 * No exported singleton and no cached context: a context is a value produced by a call and passed to whatever needs
 * it. A module-level cache would make the result depend on what ran before it, which is the opposite of the
 * determinism this module exists to provide.
 *
 * ## What the layer answers, and in what order
 *
 * Four questions, each built on the last: is this a package (package discovery), what shape is it (detection),
 * what is wrong with it (diagnostics), may I act on it (validation). A consumer should reach for the highest one
 * that answers its question — a command that is about to run something wants an assessment, not a verdict.
 *
 * ## What is exported, and what is not
 *
 * **Lookup tables stay internal.** `SPEC_DIRECTORIES`, `SUPPORT_FILES` and the lockfile order encode *how* a
 * question is answered. Exporting one would make it look like something a caller may depend on, and the first
 * caller to read it would re-implement the scan it drives, with its own idea of the order.
 *
 * **Rule tables are exported.** `LEGACY_CONFIG_FILES`, `MISPLACED_CONFIG_FILES`, `DetectionVerdict`,
 * `ConfigurationPlacement`, `SpecsShape` and `REQUIREMENTS` describe *what the tool recognises*, not how it looks.
 * A consumer that wants to say "this tool reads `cypress.config.*`, including inside `cypress/`" should reach for
 * the list rather than restate it; a test that wants to prove every requirement has a fixture should iterate the
 * table rather than keep its own copy. The distinction — a lookup versus a rule — is the one worth applying when
 * adding a constant here.
 *
 * **The contracts are not re-exported.** `ProjectDiagnosis`, `DiagnosticCode`, `DiagnosticSeverity`, the statuses
 * and `hasBlockingErrors` are declared in `core/application/diagnostics.ts`. `ProjectAssessment`, `QatOperation`,
 * `OperationReadiness`, `ValidationCode`, `RequirementOutcome`, `isExecutable` and `readinessFor` are declared in
 * `core/application/validation.ts`. A consumer imports them from there.
 *
 * Re-exporting any of them would give those names a second route, and the second route is the one that goes stale:
 * a command importing `ValidationCode` from an implementation barrel appears to depend on the implementation, and
 * breaks the day the contract moves — having looked correct in review. This matters more for validation than for
 * anything else here, because the CLI reads an assessment through the *contract's* predicates and never imports this
 * file at all.
 *
 * The same rule holds for the domain types these signatures mention. `ProjectInfo` is exported from `core/domain`,
 * and nothing here re-exports it.
 */

/** The shape a caller passes to `discoverProject`. Everything else in `contracts.ts` is internal. */
export type { ProjectDiscoveryOptions } from "./contracts.js";

export { discoverProject } from "./discovery.js";

/**
 * Package metadata, as two independent facts.
 *
 * `readManifest` and `findDeclaration` are exported because they are cheap, pure and independently useful — a
 * diagnostic that only wants to describe a manifest should not have to perform an install lookup to do it.
 * `findInstalledPackage` is not exported: its behaviour is a property of the directory tree rather than of its
 * arguments, so it is exercised through `discoverPackages`, which is the call every consumer actually makes.
 */
export {
  discoverPackages,
  findDeclaration,
  readManifest,
  type InstalledPackage,
  type PackageDiscovery,
  type PackageDiscoveryOptions,
  type ProjectManifest,
} from "./package-discovery/index.js";

/**
 * Configuration discovery and the verdict it produces.
 *
 * `detectCypress` is exported alongside `discoverPackages` because the two are the same kind of thing: an engine
 * that answers one question and returns evidence. A consumer that wants the evidence without a diagnosis or a
 * verdict on top of it — a future `qat init`, a test of one rule in isolation — asks this rather than
 * reimplementing a scan.
 *
 * The two configuration name lists are the *only* pair here that differ in kind: `LEGACY_CONFIG_FILES` are names
 * this tool recognises and cannot use, `MISPLACED_CONFIG_FILES` are the supported names in the place Cypress does
 * not load them from. Both are exported because a reader explaining either condition should be able to name the
 * files from one definition.
 */
export {
  detectCypress,
  DetectionVerdict,
  LEGACY_CONFIG_FILES,
  MISPLACED_CONFIG_FILES,
  type CypressDetection,
  type CypressLayout,
  type DetectedProject,
  type DetectionOptions,
  type UndetectedProject,
} from "./cypress-detection/index.js";

/**
 * The diagnosis, built from the evidence above.
 *
 * `diagnoseProject` reads a directory; `diagnosisFrom` describes evidence that already exists, which is what lets a
 * layer above describe a project without reading the tree twice. `unreadableProjectDiagnosis` is the builder for the
 * single condition detection throws on, exported because two layers now catch that same throw and both need the
 * same rendering.
 *
 * The catalogue and its constant are exported for the same reason the verdict table is: a consumer explaining a
 * code, or saying why a version predates a format, should reach for one definition rather than restate it.
 */
export {
  diagnoseProject,
  diagnosisFrom,
  GUIDANCE,
  MINIMUM_CYPRESS_MAJOR,
  unreadableProjectDiagnosis,
  type DiagnosticFacts,
  type DiagnosticOptions,
} from "./diagnostics/index.js";

/**
 * Validation: whether the recognised project may be used, per operation.
 *
 * `assessProject` is what a command binds to the discovery port. `assessDetection` is the same decision over
 * evidence that already exists, and the reason the whole rule set is testable without touching a disk: every
 * requirement is a function from a value to a set of codes.
 *
 * `classifyLayout`, `ConfigurationPlacement`, `SpecsShape` and `REQUIREMENTS` are exported because they are the
 * policy itself, in a form that a test and a reader can both use. `VALIDATION_GUIDANCE` and
 * `CYPRESS_VERSION_POLICY` are exported for the reason the detection catalogue is: anything explaining a code, or
 * naming a supported version, should get the words and the numbers from the module that owns them.
 *
 * `assertReadyFor` is the odd one out, and it is here temporarily. It is the one place a command is refused, and
 * nothing in `src/cli` may import this file — so the first command that gates will need it in
 * `core/application/validation.ts` instead. Moving it is a file move and one import, not a redesign; it is not done
 * now because a gate with no gatekeeper belongs beside the thing it guards rather than in the contract layer.
 */
export {
  assessDetection,
  assessProject,
  assertReadyFor,
  classifyLayout,
  ConfigurationPlacement,
  CYPRESS_VERSION_POLICY,
  REQUIREMENTS,
  SpecsShape,
  VALIDATION_GUIDANCE,
  type AssessmentOptions,
  type LayoutAssessment,
  type RequirementVerdict,
  type ValidationFacts,
  type ValidationInput,
  type ValidationRequirement,
} from "./validation/index.js";

export { resolveWorkingDirectory } from "./working-directory.js";
