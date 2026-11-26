/**
 * Public surface of the Cypress health module.
 *
 * Everything about Cypress dependency, installation and compatibility health lives
 * under `src/project/cypress-health/`. This barrel is the module's contract: code
 * outside it imports from `…/cypress-health/index.js`, never from a deep file path.
 *
 * Why a barrel rather than deep imports:
 *
 *  • **One reviewable API.** Adding an export here is a deliberate, visible change
 *    to the module's promise; adding one to a deep file stays internal. That keeps
 *    the number of things other modules can depend on small, which is the cheapest
 *    form of technical-debt control available.
 *  • **Refactoring without ripple.** The four implementation modules can be split,
 *    merged or renamed as long as this file keeps exporting the same names, so
 *    callers do not churn.
 *  • **Explicit, never wildcard.** Re-exports are enumerated rather than
 *    `export *`, so nothing leaks into the public API by accident — an accidental
 *    export is a permanent compatibility obligation nobody agreed to.
 *
 * Typical use — the composition root wires a collector, the checks are registered,
 * and everything else only ever sees the resulting diagnostic findings:
 *
 * ```ts
 * const collector: CypressHealthCollectorPort = createCypressHealthCollector({
 *   resolver: createNodeCypressResolver({ ownInstallationRoot }),
 *   inspector: createCypressBinaryInspector({ fileSystem }),
 *   probe: createCypressVerifyProbe({ runProcess }),
 *   compatibility: { supportedRange: CYPRESS_SUPPORTED_RANGE, origin: '…' },
 * });
 * ```
 *
 * Layering rule: types and pure helpers may be imported anywhere; the ports are
 * re-exported by the application port surface for the composition root, so the
 * dependency direction still points inwards.
 *
 * Type-only exports use `export type` so the barrel stays erasable under
 * `isolatedModules` / `verbatimModuleSyntax` — importing this file must never pull
 * runtime code in just to satisfy a type annotation.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary and contracts                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Constants first, because they are the vocabulary the rest of the product keys
 * off: which diagnostic IDs exist, which six conditions are established, and how a
 * problem reason maps to its owning condition.
 */
export {
  CYPRESS_CONDITION_CHECK,
  CYPRESS_CONDITIONS,
  CYPRESS_DIAGNOSTIC_IDS,
  CYPRESS_PROBLEM_REASONS,
  CYPRESS_REASON_CONDITION,
} from "./contracts.js";

/**
 * Narrowing guards. Exported because *every* consumer that aggregates results must
 * use them: `isSkipped` and `indeterminate` are not health, and the obvious
 * `!isFailed(...)` check silently counts an unrun check as a clean one.
 */
export { isFailed, isHealthy, isSkipped } from "./contracts.js";

/** Result, evidence and port shapes. */
export type {
  CheckPrerequisite,
  CypressBinaryEvidence,
  CypressBinaryInspectorPort,
  CypressBinaryProbeInput,
  CypressBinaryProbePort,
  CypressBinaryProbeResult,
  CypressBinaryState,
  CypressBinaryVerification,
  CypressCompatibilityPolicy,
  CypressCondition,
  CypressConditionResult,
  CypressDeclaration,
  CypressDiagnosticId,
  CypressDiagnosticStatus,
  CypressEvidenceDetail,
  CypressEvidenceValue,
  CypressHealthCollectorPort,
  CypressHealthDependencies,
  CypressHealthEvidence,
  CypressPackageResolverPort,
  CypressProblemReason,
  CypressReason,
  CypressResolution,
  CypressResolutionFailure,
  DependencyField,
  DiagnosticSeverity,
} from "./contracts.js";

/* -------------------------------------------------------------------------- */
/* Declaration (condition 1)                                                   */
/* -------------------------------------------------------------------------- */

export {
  CYPRESS_MANIFEST_FIELDS,
  CYPRESS_PACKAGE_NAME,
  readCypressDeclaration,
  toDeclarationEvidence,
} from "./declaration.js";

export type {
  CypressDeclarationDefect,
  CypressDeclarationMention,
  CypressDeclarationReading,
  CypressDeclaringManifest,
  CypressMentionField,
} from "./declaration.js";

/* -------------------------------------------------------------------------- */
/* Resolution (condition 2)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `createNodeCypressResolver` is the production entry point. `resolveCypressPackage`
 * is exported for integration tests that need to drive one project root directly
 * without building a port, and for future callers that already own a filesystem
 * abstraction.
 *
 * Note the deliberate omission of the internal containment helper: it stays module
 * private. Exposing it would invite use as a general-purpose path utility, where its
 * platform-specific case handling and real-path assumptions may not hold.
 */
export {
  createNodeCypressResolver,
  resolveCypressPackage,
} from "./resolution.js";

export type {
  CypressResolutionDetail,
  ModulePathResolver,
  ResolutionFileSystem,
  ResolveCypressPackageOptions,
} from "./resolution.js";

/* -------------------------------------------------------------------------- */
/* Binary (conditions 4 and 5)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The timeout and argument constants are exported so the prohibition on running
 * the user's tests is testable from outside: a test can assert that no probe
 * invocation ever carries anything but `CYPRESS_VERIFY_ARGUMENTS`.
 */
export {
  BINARY_PROBE_MAX_OUTPUT_BYTES,
  BINARY_VERIFY_TIMEOUT_MS,
  CYPRESS_VERIFY_ARGUMENTS,
  applyProbeResult,
  createCypressBinaryInspector,
  createCypressVerifyProbe,
  expectedBinaryPath,
  resolveCacheLocation,
  toDisplayPath,
} from "./binary.js";

export type {
  BinaryFileSystem,
  CreateBinaryInspectorOptions,
  CreateBinaryProbeOptions,
  CypressCacheLocation,
  ProbeProcessResult,
  ProbeProcessRunner,
} from "./binary.js";

/* -------------------------------------------------------------------------- */
/* Assessment (conditions 3 and 6, plus the prerequisite rule)                  */
/* -------------------------------------------------------------------------- */

/**
 * `defaultCompatibilityEvaluator` is exported for standalone use and for tests that
 * want to assert the fallback behaviour. Production wiring must inject the shared
 * version engine instead, so that "supported range" has exactly one implementation
 * across the runtime, package-manager and Cypress checks.
 */
export {
  assessCypressHealth,
  defaultCompatibilityEvaluator,
  overallCypressStatus,
} from "./assess.js";

export type {
  AssessCypressHealthOptions,
  CompatibilityEvaluation,
  CompatibilityEvaluator,
} from "./assess.js";

/* -------------------------------------------------------------------------- */
/* Deliberately not exported                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Kept internal so the module can evolve without breaking callers:
 *
 *  • `readEntry`, `readManifest`, `readVersion` — parsing internals of declaration
 *    and resolution. Callers want the reading, not the steps.
 *  • `inspectPath` and `summarise` — filesystem and output-handling details whose
 *    behaviour is already asserted through the public inspector and probe.
 *  • `classifyIncompatibility`, `explainResolutionFailure`, `prerequisiteReasonFor`,
 *    `declarationEvidence`, `binaryEvidence` — mapping helpers inside the assessor.
 *    Exporting them would let a caller reproduce assessment logic out of order, which
 *    is exactly the divergence the single-decision-point design prevents.
 *  • `result`, `skipped`, `notInstalled` — constructors that enforce frozen shapes.
 *    Public factories would multiply the number of ways to build an unfrozen result.
 *  • The `CACHE_ROOTS` / `BINARY_ENTRIES` tables — platform facts, consumed through
 *    `resolveCacheLocation` and `expectedBinaryPath`. Exposing the tables invites
 *    callers to hardcode a second copy of Cypress's layout.
 */
