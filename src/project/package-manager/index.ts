/**
 * Public surface of the package-manager module.
 *
 * Import direction is one-way and enforced by review, not by tooling:
 *
 *   diagnostics/checks/rules/package-manager.ts  ──►  this module
 *   app/composition.ts                           ──►  this module
 *   this module                                  ──╳   nothing above it
 *
 * The module never imports the diagnostic layer, the CLI or the composition root,
 * so it can be exercised from a fixture in a unit test with no application shell
 * around it. That property is the main reason the feature is cheap to test and
 * safe to change.
 *
 * Exports are named and explicit — never `export *`. A wildcard barrel silently
 * widens the module's contract every time an internal file gains a helper, and
 * "is this public?" then becomes unanswerable in review. Adding something here is
 * a deliberate act.
 *
 * Types are re-exported with `export type` so the barrel erases cleanly at
 * compile time and no runtime import is created just to name a shape.
 *
 * ## One rule this file taught the hard way
 *
 * A barrel re-exports from the module that *declares* a type, never from the
 * module that merely imports it. A type-only import creates no export, so
 * `export type { X } from './importer.js'` fails even though `./importer.js`
 * mentions `X` — and the error reads as "no exported member", which invites the
 * wrong repair: adding a re-export to the importer. That repair is worse than the
 * bug, because it would make the importer a second route to the same name, which
 * is precisely what this file exists to prevent.
 *
 * So: shapes come from `./contracts.js`, the policy table and its helpers from
 * `./policy.js`, and each type appears exactly once below, beside the file that
 * owns it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Contracts — the vocabulary the rest of the product speaks
// ─────────────────────────────────────────────────────────────────────────────

export type {
  /** Managers we can recognise. Recognition is not support; see the policy. */
  PackageManagerName,
  /** Immutable picture of the project root, captured in one pass. */
  ProjectSnapshot,
  /** What the project claims it installs with, and whether that claim is usable. */
  DeclarationParseResult,
  PackageManagerDeclaration,
  /** Which manager the project actually uses, including the conflicting case. */
  Detection,
  /** Whether the manager's binary exists, and what version it reported. */
  ExecutableAvailability,
  VersionEvidence,
  /** How far a previous installation got, and by whose hand. */
  InstallState,
  /** One named reason something is wrong, with the evidence behind it. */
  HealthIssue,
  HealthIssueCode,
  HealthOutcome,
  /** The value union admissible inside `HealthIssue.detail`; used by evidence builders. */
  HealthIssueDetailValue,
  /** The complete judgement, ready to be shaped into a diagnostic finding. */
  PackageManagerAssessment,
  /**
   * Injected dependencies of the port-shaped rule.
   *
   * Exported while the rule is port-based. When it becomes a catalogue
   * `CheckDefinition` reading gathered facts, the rule stops taking dependencies
   * and this type — plus the two ports below it — leave the barrel in one visible
   * deletion rather than lingering as an unused export.
   */
  PackageManagerCheckDependencies,
  /** Ports, re-exported because the composition root binds them. */
  PackageManagerSnapshotPort,
  PackageManagerExecutablePort,
  ExecutableLocatorPort,
  PackageManagerProbePort,
  /**
   * The policy *shape*, declared in contracts and merely used by policy.ts.
   * Re-exported from here, not from `./policy.js`: that module imports these two
   * types rather than declaring them, and a re-export cannot pass through an
   * import.
   */
  PackageManagerPolicy,
  PackageManagerPolicyEntry,
} from "./contracts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Policy — the single source of truth
// ─────────────────────────────────────────────────────────────────────────────

export {
  /** The frozen policy table. Read it; do not copy it. */
  PACKAGE_MANAGER_POLICY,
  /** Documentation cross-reference asserted by a contract test. */
  PACKAGE_MANAGER_POLICY_DOC,
  /** Which managers are inside the supported installation policy. */
  supportedManagers,
  isSupportedManager,
  /** Total lookup for a closed union — never returns undefined. */
  policyFor,
  /** The install command that respects a committed lockfile. */
  installCommandFor,
  /** Lockfile basename → manager, case-insensitive. */
  managerForLockfile,
  knownLockfiles,
  /** Internal contradictions in a policy table; asserted clean by tests. */
  findPolicyConflicts,
} from "./policy.js";

/** Declared in `policy.ts` — this is one of the few types that genuinely lives there. */
export type { PolicyConflict } from "./policy.js";

// ─────────────────────────────────────────────────────────────────────────────
// Collection, decision, judgement — the three pure-ish steps
// ─────────────────────────────────────────────────────────────────────────────

export {
  /** The only writer-free filesystem reader in this module. */
  createSnapshotCollector,
  /** Parses the `packageManager` field; exported for focused unit tests. */
  parseDeclaration,
  MAX_MANIFEST_BYTES,
} from "./snapshot.js";

export type { DirectoryEntry, SnapshotFileSystem } from "./snapshot.js";

export {
  /** Pure: snapshot → which manager is this project? */
  detectPackageManager,
} from "./detect.js";

export {
  /** Pure: evidence → named, actionable issues. */
  assessPackageManagerHealth,
  /** Exported so a richer collector can supply attributed install state. */
  determineInstallState,
} from "./assess.js";

export type { PackageManagerAssessmentInput } from "./assess.js";

// ─────────────────────────────────────────────────────────────────────────────
// Executable resolution
// ─────────────────────────────────────────────────────────────────────────────

export {
  /** PATH-only locator. Never searches node_modules; refuses cwd segments. */
  createPathLocator,
  /**
   * The default filesystem probe: exists, is a regular file, and is executable by us.
   *
   * Exported because it is a seam, not an internal helper: a test that drives the locator's Windows/POSIX behaviour
   * supplies a fake, and a test of the probe itself supplies real files and an explicit platform — neither can do that
   * through `createPathLocator` alone.
   */
  createExecutableFileProbe,
  /** Bounded `--version` probe that treats failure as evidence, not an error. */
  createVersionProbe,
  /** Composes the two into the port the rule actually consumes. */
  createPackageManagerExecutablePort,
  PROBE_TIMEOUT_MS,
  PROBE_MAX_OUTPUT_BYTES,
} from "./executable.js";

export type {
  CommandOutcome,
  CommandRunnerPort,
  ExecutableFileProbe,
  PackageManagerExecutableOptions,
  PathLocatorOptions,
  /** Lets a test drive the Windows `.cmd` guard on a non-Windows runner. */
  VersionProbeOptions,
} from "./executable.js";
