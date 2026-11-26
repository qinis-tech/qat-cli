/**
 * Public surface of project discovery.
 *
 * No exported singleton and no cached context: a context is a value produced by a call and passed to whatever needs it.
 * A module-level cache would make the result depend on what ran before it, which is the opposite of the determinism this
 * module exists to provide.
 *
 * ## What the layer answers, and in what order
 *
 * Five questions, each built on the last: is this a package (`package-discovery`), how is it installed
 * (`package-manager`), what shape is it (`cypress-detection`), what is wrong with it (`diagnostics`), may I act on it
 * (`validation`). A consumer should reach for the highest one that answers its question — a command that is about to run
 * something wants an assessment, not a verdict.
 *
 * `package-manager` sits second rather than last because it answers a *property of the tree* (which tool owns the
 * lockfile, and is that tool healthy) that the three questions after it do not depend on and must not absorb. It is
 * deliberately not folded into validation: a mismatched installer predicts a confusing `install` later, while validation
 * answers "may I run now". Two different moments, two different answers, two different severities.
 *
 * ## What is exported, and what is not
 *
 * **Lookup tables that encode *how* a scan runs stay internal.** `SPEC_DIRECTORIES` and `SUPPORT_FILES` describe the
 * mechanics of a search. Exporting one would make it look like something a caller may depend on, and the first caller to
 * read it would re-implement the scan it drives, with its own idea of the order.
 *
 * **Rule tables that encode *what the tool recognises* are exported.** `LEGACY_CONFIG_FILES`, `MISPLACED_CONFIG_FILES`,
 * `DetectionVerdict`, `ConfigurationPlacement`, `SpecsShape`, `REQUIREMENTS` and — since this layer gained the question —
 * `PACKAGE_MANAGER_POLICY` describe facts about the tool, not about a scan. A consumer that wants to say "this tool reads
 * `cypress.config.*`, including inside `cypress/`" or "QAT supports npm, pnpm and yarn but only recognises Bun" should
 * reach for the table rather than restate it; a test that wants to prove every requirement has a fixture should iterate
 * the table rather than keep its own copy. The distinction — a lookup versus a rule — is the one worth applying when
 * adding a constant here.
 *
 * **The contracts are not re-exported.** `ProjectDiagnosis`, `DiagnosticCode`, `DiagnosticSeverity`, the statuses and
 * `hasBlockingErrors` are declared in `core/application/diagnostics.ts`. `ProjectAssessment`, `QatOperation`,
 * `OperationReadiness`, `ValidationCode`, `RequirementOutcome`, `isExecutable` and `readinessFor` are declared in
 * `core/application/validation.ts`. A consumer imports them from there.
 *
 * Re-exporting any of them would give those names a second route, and the second route is the one that goes stale: a
 * command importing `ValidationCode` from an implementation barrel appears to depend on the implementation, and breaks the
 * day the contract moves — having looked correct in review. This matters most for validation, because the CLI reads an
 * assessment through the *contract's* predicates and never imports this file at all.
 *
 * The same rule holds for the domain types these signatures mention. `ProjectInfo` is exported from `core/domain`, and
 * nothing here re-exports it.
 *
 * The same rule also keeps the layout constants out. `PACKAGE_MANIFEST_FILE` and `NODE_MODULES_DIRECTORY` are imported
 * from `./contracts.js` by the readers inside this layer; they are not names a consumer should build behaviour on, and
 * re-exporting them here would invite exactly the second copy this file exists to prevent.
 */

/**
 * Which directory a command is looking at, decided before anything is read.
 *
 * Exported because every command needs it and neither the CLI nor the discovery port can answer it alone: the command
 * knows the flag and the argument, the layer knows the precedence and refuses a path that is not a directory. It is the
 * only export here that is purely about *arguments* rather than about a tree — which is why it is named for the
 * question, not for the module.
 */
export { resolveWorkingDirectory } from "./working-directory.js";

/** The shape a caller passes to `discoverProject`. Everything else in `contracts.ts` is internal. */
export type { ProjectDiscoveryOptions } from "./contracts.js";

export { discoverProject } from "./discovery.js";

/**
 * Package metadata, as two independent facts.
 *
 * `readManifest` and `findDeclaration` are exported because they are cheap, pure and independently useful — a diagnostic
 * that only wants to describe a manifest should not have to perform an install lookup to do it. `findInstalledPackage`
 * is not exported: its behaviour is a property of the directory tree rather than of its arguments, so it is exercised
 * through `discoverPackages`, which is the call every consumer actually makes.
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
 * Package-manager identity and health.
 *
 * The export criteria are the ones stated above, applied honestly:
 *
 * **Rules are exported.** `PACKAGE_MANAGER_POLICY` is the authoritative statement of which lockfiles and executables
 * belong to which manager, and which managers are supported. A consumer explaining "your project installs with pnpm" — or
 * a test proving every supported manager has a fixture — must read it rather than restate it. `policyFor`,
 * `supportedManagers`, `isSupportedManager`, `installCommandFor`, `managerForLockfile`, `knownLockfiles` and
 * `findPolicyConflicts` are the same table in usable form; `PACKAGE_MANAGER_POLICY_DOC` is the pointer the
 * documentation-parity test follows.
 *
 * **Engines are exported.** `detectPackageManager` and `assessPackageManagerHealth` are the same kind of thing as
 * `detectCypress` and `assessDetection`: a pure answer plus its evidence, usable without a diagnosis or a verdict stacked
 * on top of it. `parseDeclaration` is exported for the same reason `readManifest` is — it is a pure function over a string
 * that a test or a future workflow can use on its own.
 *
 * **Plumbing is not.** `createSnapshotCollector` is exported because it is the unit of composition the application needs
 * in order to inject a project root; `createPackageManagerExecutablePort` and its two budgets are exported because
 * composition has to bind PATH and command execution to it from `core/application` ports. The two lower-level factories
 * behind that port — the PATH locator and the version probe — are deliberately *not* here: they are adapters exercised
 * directly by their own unit tests, and exporting them would present three ways to do one thing to any future reader.
 *
 * **Contracts come along because they are this module's vocabulary**, and the rule against re-exporting has a narrower
 * exception than it looks: `core/application/*` cannot declare them without importing this layer and inverting the
 * dependency direction, so the checks layer must get them from here. They are exported as types only; no behaviour travels
 * with them.
 */
export {
  assessPackageManagerHealth,
  createPackageManagerExecutablePort,
  createSnapshotCollector,
  detectPackageManager,
  determineInstallState,
  findPolicyConflicts,
  installCommandFor,
  isSupportedManager,
  knownLockfiles,
  managerForLockfile,
  PACKAGE_MANAGER_POLICY,
  PACKAGE_MANAGER_POLICY_DOC,
  parseDeclaration,
  policyFor,
  PROBE_MAX_OUTPUT_BYTES,
  PROBE_TIMEOUT_MS,
  supportedManagers,
  type DeclarationParseResult,
  type Detection,
  type DirectoryEntry,
  type ExecutableAvailability,
  type HealthIssue,
  type HealthIssueCode,
  type HealthOutcome,
  type InstallState,
  type PackageManagerAssessment,
  type PackageManagerAssessmentInput,
  type PackageManagerCheckDependencies,
  type PackageManagerExecutablePort,
  type PackageManagerName,
  type PackageManagerPolicy,
  type PackageManagerPolicyEntry,
  type PackageManagerSnapshotPort,
  type PolicyConflict,
  type ProjectSnapshot,
  type SnapshotFileSystem,
  type VersionEvidence,
} from "./package-manager/index.js";

/**
 * Configuration discovery and the verdict it produces.
 *
 * `detectCypress` is exported alongside `discoverPackages` because the two are the same kind of thing: an engine that
 * answers one question and returns evidence. A consumer that wants the evidence without a diagnosis or a verdict on top
 * of it — a future `qat init`, a test of one rule in isolation — asks this rather than reimplementing a scan.
 *
 * The two configuration name lists are the *only* pair here that differ in kind: `LEGACY_CONFIG_FILES` are names this tool
 * recognises and cannot use, `MISPLACED_CONFIG_FILES` are the supported names in the place Cypress does not load them from.
 * Both are exported because a reader explaining either condition should be able to name the files from one definition.
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
 * `diagnoseProject` reads a directory; `diagnosisFrom` describes evidence that already exists, which is what lets a layer
 * above describe a project without reading the tree twice. `unreadableProjectDiagnosis` is the builder for the single
 * condition detection throws on, exported because two layers now catch that same throw and both need the same rendering.
 *
 * The catalogue and its constant are exported for the same reason the verdict table is: a consumer explaining a code, or
 * saying why a version predates a format, should reach for one definition rather than restate it.
 *
 * `GUIDANCE` is named without a qualifier because it is this layer's only catalogue — it explains the codes a *project
 * diagnosis* carries. The validation layer's catalogue is `VALIDATION_GUIDANCE`, and the two are not interchangeable: one
 * describes a tree, the other describes whether an operation may proceed over it.
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
 * `assessProject` is what a command binds to the discovery port. `assessDetection` is the same decision over evidence that
 * already exists, and the reason the whole rule set is testable without touching a disk: every requirement is a function
 * from a value to a set of codes.
 *
 * `classifyLayout`, `ConfigurationPlacement`, `SpecsShape` and `REQUIREMENTS` are exported because they are the policy
 * itself, in a form that a test and a reader can both use. `VALIDATION_GUIDANCE` and `CYPRESS_VERSION_POLICY` are exported
 * for the reason the detection catalogue is: anything explaining a code, or naming a supported version, should get the
 * words and the numbers from the module that owns them.
 *
 * `assertReadyFor` is the odd one out, and it is here temporarily. It is the one place a command is refused, and nothing in
 * `src/cli` may import this file — so the first command that gates will need it in `core/application/validation.ts`
 * instead. Moving it is a file move and one import, not a redesign; it is not done now because a gate with no gatekeeper
 * belongs beside the thing it guards rather than in the contract layer.
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
