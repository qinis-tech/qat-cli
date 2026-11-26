/**
 * Contracts for the package-manager health check.
 *
 * This module is deliberately *types only* — no imports, no I/O, no constants
 * with behaviour. Everything downstream (the snapshot collector, the detection
 * step, the executable probe, the assessment and the diagnostic rule) depends on
 * these shapes, so keeping them dependency-free is what allows the whole feature
 * to be reasoned about, reviewed and tested from a single page.
 *
 * Vocabulary used throughout:
 *
 *   declaration  what the project *claims* it installs with ("packageManager")
 *   lockfile     what the project *actually used* (a file on disk at the root)
 *   observation  what we can prove from the filesystem
 *   executable   the binary that would perform an install, if it exists at all
 *   install state how far a previous install got, and by whose hand
 *
 * The check never writes. Every type below is therefore read-only by
 * construction: there is no shape in this file that can represent "the result
 * after we fixed it", because fixing is not something a diagnostic may do.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Package-manager identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Package managers the codebase is capable of *recognising*.
 *
 * Recognised is not the same as supported: `bun` appears here so that a project
 * using it receives "recognised but not supported" rather than the much more
 * confusing "no package manager found". The supported/unsupported decision lives
 * in policy, not in this union, so widening the union never silently widens
 * support.
 */
export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

/**
 * One entry of the approved package-manager policy.
 *
 * Kept as a plain data shape (rather than a class or a registry of callbacks)
 * because policy must be inspectable, diffable in review and comparable against
 * the published documentation by a contract test.
 */
export interface PackageManagerPolicyEntry {
  /** Lockfile basenames that identify this manager at the project root. */
  readonly lockfiles: readonly string[];

  /** Command names that would perform an install for this manager. */
  readonly executables: readonly string[];

  /**
   * A path, relative to the project root, whose presence proves this manager
   * created `node_modules`.
   *
   * `null` means the manager leaves no distinguishable marker, so install state
   * for it can only ever be `unknown` — never guessed.
   */
  readonly installMarker: string | null;

  /**
   * Whether QAT supports projects installed with this manager.
   *
   * Unsupported managers are still detected and reported precisely, because
   * "your tool is not on our list" and "we cannot see your tool" are different
   * messages to different people.
   */
  readonly supported: boolean;
}

/** The complete policy, keyed by manager, resolved once at composition time. */
export type PackageManagerPolicy = Readonly<
  Record<PackageManagerName, PackageManagerPolicyEntry>
>;

// ─────────────────────────────────────────────────────────────────────────────
// Declared metadata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A successfully parsed `packageManager` declaration.
 *
 * `version` is optional on purpose: a bare name is legal input but not a usable
 * declaration, and the caller needs to distinguish the two. The raw string is
 * preserved so diagnostics can quote exactly what the user wrote instead of a
 * normalised paraphrase they will not recognise in their own file.
 */
export interface PackageManagerDeclaration {
  readonly name: PackageManagerName;
  /** Exact version requested, with any Corepack hash suffix already stripped. */
  readonly version: string | undefined;
  readonly raw: string;
}

/** Why a declaration could not be used as written. */
export type DeclarationProblem =
  /** A name alone: nothing to verify against, so nothing is claimed. */
  | "missing-version"
  /** Syntactically not `name@version` at all. */
  | "malformed"
  /** A real manager QAT does not recognise — reported as unsupported, not invalid. */
  | "unknown-manager";

/**
 * Outcome of reading the `packageManager` field.
 *
 * A discriminated union rather than `declaration | undefined` because the three
 * cases lead to three different findings, and collapsing "absent" into
 * "unparsable" is exactly how users end up being told their valid project is
 * broken.
 */
export type DeclarationParseResult =
  | { readonly status: "absent" }
  | {
      readonly status: "parsed";
      readonly declaration: PackageManagerDeclaration;
    }
  | {
      readonly status: "unparsable";
      readonly raw: string;
      readonly problem: DeclarationProblem;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem snapshot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An immutable picture of the project root, captured in a single pass.
 *
 * Why a snapshot rather than live reads inside the check:
 *
 *   • every condition must be judged against one instant of the filesystem,
 *     otherwise a concurrent install can make the report contradict itself;
 *   • it turns I/O into plain data, so detection and assessment become pure
 *     functions that can be driven from fixtures with no mocking at all;
 *   • it makes the read-only guarantee obvious — a snapshot has no writer.
 *
 * Treat the value as frozen. `ReadonlySet` is a compile-time guarantee only, so
 * the collector constructs it once and never hands out a mutable reference.
 */
export interface ProjectSnapshot {
  /** Absolute project root, echoed into evidence so a report is reproducible. */
  readonly root: string;

  /**
   * Basenames present at the project root — root only, not recursive.
   *
   * A lockfile three directories down belongs to a different (possibly nested)
   * project; counting it would misreport a plain single-package repository.
   */
  readonly rootEntries: ReadonlySet<string>;

  /** Result of reading `packageManager`. */
  readonly declaration: DeclarationParseResult;

  /** `engines.npm` / `engines.pnpm` / `engines.yarn`, when declared. */
  readonly engineRanges: Readonly<Partial<Record<PackageManagerName, string>>>;

  /**
   * Whether `node_modules` exists at the root at all.
   *
   * This answers "has anything ever been installed here?", which is a different
   * question from "was it installed by the manager this project uses?".
   */
  readonly hasNodeModules: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The result of deciding which package manager a project actually uses.
 *
 * Each variant maps to a distinct piece of advice, which is why this is a union
 * rather than a single object with optional fields. `conflicting` in particular
 * carries both candidates: a check that silently picks a winner would let CI
 * rewrite a lockfile nobody meant to touch.
 */
export type Detection =
  | {
      readonly status: "detected";
      readonly manager: PackageManagerName;
      /** Lockfile that produced the identification, or '' when only declared. */
      readonly lockfile: string;
      /** True when `packageManager` agreed with, or supplied, the identity. */
      readonly declared: boolean;
    }
  | {
      readonly status: "conflicting";
      /** Sorted filenames, so reports are stable across directory orderings. */
      readonly lockfiles: readonly string[];
      /** Sorted, de-duplicated managers implicated by the conflict. */
      readonly managers: readonly PackageManagerName[];
    }
  | {
      readonly status: "undeclared";
      /** Usually empty; populated if lockfiles exist that map to no known manager. */
      readonly lockfiles: readonly string[];
    }
  | {
      readonly status: "unsupported";
      readonly manager: PackageManagerName;
      readonly lockfile: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Executable availability
// ─────────────────────────────────────────────────────────────────────────────

/** How the version of a located binary was established. */
export type VersionEvidence =
  /** A version string was captured from the binary. */
  | { readonly status: "read"; readonly value: string }
  /** The binary did not answer within the probe budget. */
  | { readonly status: "unreadable"; readonly reason: "timeout" }
  /** The binary answered, but not with anything we can use. */
  | {
      readonly status: "unreadable";
      readonly reason: "empty-output" | "failed";
    }
  /** Probing was skipped — declared version unknown, or probing disabled. */
  | { readonly status: "not-probed" };

/**
 * Whether the package manager's executable can be used.
 *
 * Separating "missing binary" from "binary present but silent" matters: the
 * first is a setup problem with a one-line fix, the second is an environment
 * quirk that must not be reported as a broken project.
 */
export type ExecutableAvailability =
  | {
      readonly status: "found";
      /** Absolute path, resolved from PATH only — never from node_modules. */
      readonly path: string;
      readonly version: VersionEvidence;
    }
  | { readonly status: "missing" };

// ─────────────────────────────────────────────────────────────────────────────
// Install state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How complete a previous dependency installation is, and who performed it.
 *
 * `foreign` is the interesting case: dependencies are installed, but the marker
 * says a *different* manager created the tree. That explains a whole class of
 * "works on my machine" failures without anyone having to read a log.
 */
export type InstallState =
  /** A marker belonging to the detected manager was found. */
  | { readonly status: "installed"; readonly marker: string }
  /** No dependencies are present. */
  | { readonly status: "absent" }
  /** Markers from another manager are present. */
  | {
      readonly status: "foreign";
      readonly marker: string;
      readonly createdBy: PackageManagerName;
    }
  /** State cannot be determined (manager leaves no marker, or reading failed). */
  | { readonly status: "unknown"; readonly reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// Health assessment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Named reasons something is wrong.
 *
 * One code per *fix*, not one code per symptom. These four are routinely
 * conflated and each sends the user somewhere different:
 *
 *   PM_UNSUPPORTED                change tooling, or expect reduced support
 *   PM_EXECUTABLE_MISSING         install the tool
 *   PM_DEPENDENCIES_NOT_INSTALLED install dependencies
 *   PM_UNDECLARED                 declare what the project uses
 */
export type HealthIssueCode =
  /** More than one lockfile, or declaration and lockfile disagree. */
  | "PM_LOCKFILES_CONFLICT"
  /** `packageManager` names a manager with no matching lockfile footprint. */
  | "PM_DECLARATION_MISMATCH"
  /** `packageManager` is present but unusable (bare name, malformed value). */
  | "PM_DECLARATION_UNPARSABLE"
  /** Nothing identifies the manager. */
  | "PM_UNDECLARED"
  /** A recognised manager outside the supported installation policy. */
  | "PM_UNSUPPORTED"
  /** The manager is supported, but its executable is not on PATH. */
  | "PM_EXECUTABLE_MISSING"
  /** The executable exists but its version differs from the declared one. */
  | "PM_EXECUTABLE_VERSION_MISMATCH"
  /** The executable was found but reported no usable version. */
  | "PM_VERSION_UNVERIFIED"
  /** The manager is fine; the installation never completed. */
  | "PM_DEPENDENCIES_NOT_INSTALLED"
  /** `node_modules` was created by a different manager than the project uses. */
  | "PM_FOREIGN_NODE_MODULES";

/**
 * Outcome of a single condition.
 *
 * `indeterminate` is a first-class result, not a soft failure: when a condition
 * cannot be established we must say so rather than let an unread value inherit
 * a green tick. `skipped` exists for the case where a precondition (such as
 * project discovery) failed, so the condition was never applicable.
 */
export type HealthOutcome = "pass" | "fail" | "indeterminate" | "skipped";

/** A value that is safe to serialise into persisted diagnostic evidence. */
export type HealthIssueDetailValue =
  string | number | boolean | null | readonly string[];

/**
 * A single named finding about package-manager health.
 *
 * `detail` holds the raw evidence that justified the outcome — filenames,
 * versions, marker paths. It must never carry environment contents, registry
 * credentials or absolute paths outside the project root.
 */
export interface HealthIssue {
  readonly code: HealthIssueCode;
  readonly outcome: HealthOutcome;
  readonly manager: PackageManagerName | undefined;
  readonly detail: Readonly<Record<string, HealthIssueDetailValue>>;
}

/**
 * The complete judgement for a project, ready to be shaped into a diagnostic.
 *
 * `outcome` is the worst outcome across `issues`; keeping it on the assessment
 * means the aggregation rule lives in one pure function instead of being
 * re-implemented by every consumer that wants a headline status.
 */
export interface PackageManagerAssessment {
  readonly manager: PackageManagerName | undefined;
  readonly outcome: HealthOutcome;
  readonly issues: readonly HealthIssue[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Captures a {@link ProjectSnapshot} for an explicit root.
 *
 * The root is a parameter rather than an ambient `process.cwd()` lookup so that
 * the caller owns path resolution, the collector stays trivial, and tests can
 * point at a fixture without changing the working directory.
 */
export interface PackageManagerSnapshotPort {
  readonly capture: (root: string) => Promise<ProjectSnapshot>;
}

/**
 * Resolves a manager's executable on PATH and, when possible, its version.
 *
 * Implementations must:
 *   • search PATH only — never `node_modules/.bin`;
 *   • never use a shell;
 *   • bound the version probe and treat a non-zero exit as evidence, not error.
 *
 * Those constraints are part of the contract, not an implementation detail,
 * because violating any of them turns a read-only diagnostic into an execution
 * surface for project-controlled code.
 */
export interface PackageManagerExecutablePort {
  readonly resolve: (
    manager: PackageManagerName,
  ) => Promise<ExecutableAvailability>;
}

/** Locates a command on PATH. Exposed separately so it can be faked precisely. */
export interface ExecutableLocatorPort {
  readonly locateExecutable: (command: string) => Promise<string | undefined>;
}

/** Reads a binary's version under a fixed time budget. */
export interface PackageManagerProbePort {
  readonly probeVersion: (executablePath: string) => Promise<VersionEvidence>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the package-manager rule needs, injected.
 *
 * Policy arrives by injection rather than by import so that a test can assert
 * behaviour for an unsupported manager without editing a frozen global table,
 * and so the supported set can grow without touching the rule.
 */
export interface PackageManagerCheckDependencies {
  readonly snapshots: PackageManagerSnapshotPort;
  readonly executables: PackageManagerExecutablePort;
  readonly policy: PackageManagerPolicy;
  /** Root to inspect; resolved by the caller, never read from the environment. */
  readonly projectRoot: string;
}
