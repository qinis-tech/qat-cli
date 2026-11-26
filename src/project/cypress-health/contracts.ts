/**
 * Contracts for Cypress dependency and installation health checks.
 *
 * This module defines the *vocabulary* used to describe what QAT observed about
 * Cypress in a project. It contains types, exhaustively derived unions and a few
 * frozen lookup tables — no behaviour, no I/O, no imports from the rest of the
 * application. Everything downstream (declaration reading, project-local
 * resolution, binary inspection, assessment and the three diagnostic rules)
 * speaks these types, which means the six Cypress conditions can only ever be
 * described in one vocabulary.
 *
 * Design notes worth knowing before editing this file:
 *
 *  • Unions are derived from frozen tuples (`as const`) rather than written out
 *    twice. Adding a reason means adding it to one array; every `Record` keyed by
 *    that union then fails to compile until the new case is handled. Drift is a
 *    compile error, not a production surprise.
 *
 *  • The six Cypress facts are modelled separately and never merged:
 *    declared → installed → version identified → binary present → binary
 *    runnable → version compatible. Each one is independently observable, and a
 *    fact whose prerequisite was not established is reported as `skipped` with
 *    the prerequisite named — never as `fail`, and never as `pass`.
 *
 *  • Absent observations are `null`, not `undefined`. Every value here ends up in
 *    diagnostic evidence that is serialised to JSON and read by humans, and
 *    "we looked and found nothing" must be distinguishable from "we never
 *    looked". `undefined` disappears from JSON; `null` survives it.
 *
 *  • Evidence values are display-safe by contract. Paths are abbreviated (`~`),
 *    and no environment variable, token or registry credential may be placed in
 *    a `CypressEvidenceDetail`. Redaction upstream is a safety net, not a licence.
 *
 *  • Ports live here, next to the data they exchange, and are re-exported by the
 *    application port surface for the composition root. That keeps the module
 *    dependency-inverted without scattering Cypress knowledge across `core`.
 *
 *  • Nothing in this module permits mutation of a user project. There is no
 *    write port, no install port and no "repair" concept: these checks observe
 *    and report. Installing Cypress or its binary is suggested in remediation
 *    text and is always performed by the user's own tooling.
 */

/* -------------------------------------------------------------------------- */
/* Diagnostic identity                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The diagnostic identifiers owned by this work area.
 *
 * Three checks, because three of the six conditions have a different fix and a
 * different urgency:
 *   DEP-003 — is Cypress declared, and is the declared package actually here?
 *   DEP-004 — is the installed version identifiable and supported by QAT?
 *   DEP-008 — is the downloaded Cypress binary present and runnable?
 *
 * They are declared together so the catalogue, the rules and the contract tests
 * cannot disagree about which IDs exist.
 */
export const CYPRESS_DIAGNOSTIC_IDS = [
  "DEP-003",
  "DEP-004",
  "DEP-008",
] as const;

export type CypressDiagnosticId = (typeof CYPRESS_DIAGNOSTIC_IDS)[number];

/* -------------------------------------------------------------------------- */
/* The six conditions                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The six facts this work area establishes, in the order they must be
 * established. The order is not cosmetic: each fact is evidence for the next, and
 * a later fact cannot be judged once an earlier one has failed.
 */
export const CYPRESS_CONDITIONS = [
  /** 1. Cypress appears in the project's own manifest. */
  "declared",
  /** 2. The declared Cypress package resolves from the project. */
  "installed",
  /** 3. The resolved package reports a usable version. */
  "version-identified",
  /** 4. A binary for that version exists in the Cypress cache. */
  "binary-installed",
  /** 5. That binary exists and is executable. */
  "binary-accessible",
  /** 6. That version is inside the range this QAT adapter supports. */
  "version-compatible",
] as const;

export type CypressCondition = (typeof CYPRESS_CONDITIONS)[number];

/**
 * Which check owns which condition.
 *
 * Typed as a total `Record`, so adding a condition without deciding who reports
 * it is a compile error rather than a silently unreported fact.
 */
export const CYPRESS_CONDITION_CHECK: Readonly<
  Record<CypressCondition, CypressDiagnosticId>
> = Object.freeze({
  declared: "DEP-003",
  installed: "DEP-003",
  "version-identified": "DEP-004",
  "binary-installed": "DEP-008",
  "binary-accessible": "DEP-008",
  "version-compatible": "DEP-004",
});

/* -------------------------------------------------------------------------- */
/* Outcomes and reasons                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Result status of a single condition.
 *
 * `skipped` is deliberately distinct from `indeterminate`:
 *   skipped       — a prerequisite was not established, so we did not even look.
 *   indeterminate — we looked, and could not establish the fact.
 *   fail          — we looked, and the fact is false.
 * Conflating them would let "we never checked" hide behind "it might be fine".
 */
export type CypressDiagnosticStatus =
  "pass" | "fail" | "skipped" | "indeterminate";

export type DiagnosticSeverity = "error" | "warning" | "information";

/**
 * Every *problem* this work area can report.
 *
 * `CYPRESS_OK` is intentionally not a member: a success is not a problem, and
 * granting it a reason code tends to invite `switch` statements that quietly
 * treat "no problem" as "an unhandled problem".
 */
export const CYPRESS_PROBLEM_REASONS = [
  /** Nothing in the manifest declares Cypress. Fix: add the dependency. */
  "CYPRESS_NOT_DECLARED",
  /** Declared, but the package is not resolvable from the project. Fix: install. */
  "CYPRESS_DECLARED_NOT_INSTALLED",
  /** Installed but not declared — a ghost install that no re-install would reproduce. */
  "CYPRESS_INSTALLED_BUT_UNDECLARED",
  /** Resolution landed outside the project root, so it is not *this* project's Cypress. */
  "CYPRESS_RESOLUTION_REJECTED_OUTSIDE_PROJECT",
  /** The resolved package manifest could not be read as data. */
  "CYPRESS_MANIFEST_UNREADABLE",
  /** Installed, but no usable version could be read. */
  "CYPRESS_VERSION_UNKNOWN",
  /** Version is older than the minimum this adapter supports — it cannot work. */
  "CYPRESS_VERSION_BELOW_MINIMUM",
  /** Version is newer than the highest tested release — probably fine, unproven. */
  "CYPRESS_VERSION_ABOVE_TESTED_MAXIMUM",
  /** A pre-release build; support is only ever claimed for released versions. */
  "CYPRESS_VERSION_PRERELEASE",
  /** The cache holds no binary for the installed version. */
  "CYPRESS_BINARY_NOT_INSTALLED",
  /** A binary exists but cannot be executed (permissions, wrong platform). */
  "CYPRESS_BINARY_INACCESSIBLE",
  /** A binary exists and looks runnable, but a bounded probe could not confirm it. */
  "CYPRESS_BINARY_UNVERIFIED",
  /** Nothing was observed about the binary, because a prerequisite failed. */
  "CYPRESS_BINARY_UNKNOWN",
] as const;

export type CypressProblemReason = (typeof CYPRESS_PROBLEM_REASONS)[number];

/** A problem reason, or the explicit absence of one. */
export type CypressReason = CypressProblemReason | "CYPRESS_OK";

/**
 * Which condition a problem reason belongs to.
 *
 * Keeping this total and exhaustive is what allows the assessor to stay small and
 * the documentation contract test to check that every reportable reason is
 * documented — in both directions.
 */
export const CYPRESS_REASON_CONDITION: Readonly<
  Record<CypressProblemReason, CypressCondition>
> = Object.freeze({
  CYPRESS_NOT_DECLARED: "declared",
  CYPRESS_DECLARED_NOT_INSTALLED: "installed",
  CYPRESS_INSTALLED_BUT_UNDECLARED: "installed",
  CYPRESS_RESOLUTION_REJECTED_OUTSIDE_PROJECT: "installed",
  CYPRESS_MANIFEST_UNREADABLE: "installed",
  CYPRESS_VERSION_UNKNOWN: "version-identified",
  CYPRESS_VERSION_BELOW_MINIMUM: "version-compatible",
  CYPRESS_VERSION_ABOVE_TESTED_MAXIMUM: "version-compatible",
  CYPRESS_VERSION_PRERELEASE: "version-compatible",
  CYPRESS_BINARY_NOT_INSTALLED: "binary-installed",
  CYPRESS_BINARY_INACCESSIBLE: "binary-accessible",
  CYPRESS_BINARY_UNVERIFIED: "binary-accessible",
  CYPRESS_BINARY_UNKNOWN: "binary-installed",
});

/* -------------------------------------------------------------------------- */
/* Observation: declaration (condition 1)                                      */
/* -------------------------------------------------------------------------- */

/** Where a dependency can legitimately be declared in a package manifest. */
export type DependencyField = "dependencies" | "devDependencies";

/**
 * How the project declares Cypress.
 *
 * `devDependencies` is the normal home for an automation repository and is
 * treated as a first-class declaration. The *range* is captured rather than a
 * resolved version because the range is the only Cypress fact available when
 * nothing is installed yet, and it is what a future install would honour.
 */
export type CypressDeclaration =
  | { readonly declared: false }
  | {
      readonly declared: true;
      readonly range: string;
      readonly field: DependencyField;
    };

/* -------------------------------------------------------------------------- */
/* Observation: resolution (condition 2)                                       */
/* -------------------------------------------------------------------------- */

/**
 * Why a project-local resolution did not produce a usable installation.
 *
 * These are reported separately because they need different messages: "not
 * installed" is a missing install, "outside project" is a resolver that escaped
 * into a parent directory or into QAT's own dependencies, and "unreadable" is a
 * damaged install that an install command will usually repair.
 */
export type CypressResolutionFailure =
  "not-resolvable" | "rejected-outside-project" | "unreadable-package-manifest";

/**
 * The result of resolving the Cypress package from the project root.
 *
 * Resolution is anchored at the project root on purpose: a globally installed
 * Cypress must never be able to satisfy this check, or every broken project on a
 * developer machine that happens to have Cypress would look healthy.
 *
 * Note that no project code is loaded to produce this: the package is located and
 * its manifest is read as data. Importing the package would execute it.
 */
export interface CypressResolution {
  readonly outcome: "resolved" | "not-installed";
  /** Absolute directory of the resolved package, or `null` when unresolved. */
  readonly packageDirectory: string | null;
  /** Version exactly as the package manifest states it, or `null`. */
  readonly version: string | null;
  /** Present only when `outcome` is `not-installed`. */
  readonly failure: CypressResolutionFailure | null;
}

/* -------------------------------------------------------------------------- */
/* Observation: binary (conditions 4 and 5)                                    */
/* -------------------------------------------------------------------------- */

/**
 * How the binary's usability was established, recorded in evidence.
 *
 * `static-cache-inspection` is the normal path: fast, offline, and needs no
 * cooperation from the project. `cypress-verify` is the bounded fallback used
 * only when static evidence is ambiguous. Reporting which one was used stops a
 * "looks fine in the cache" result from being read as "proven to run".
 */
export type CypressBinaryVerification =
  "static-cache-inspection" | "cypress-verify";

/** What was actually observed about the binary file. */
export type CypressBinaryState =
  "accessible" | "not-executable" | "absent" | "unknown";

/**
 * Evidence about the Cypress binary for the installed version.
 *
 * `cacheRoot` and `expectedPath` are display-safe: the user's home directory is
 * abbreviated to `~`, because an authoritative error message that leaks a full
 * home path into a CI log is a small but real privacy cost with no diagnostic
 * benefit.
 */
export interface CypressBinaryEvidence {
  /** Version the cache lookup was performed for. */
  readonly version: string;
  /** Cache root that was inspected, in display form. */
  readonly cacheRoot: string;
  /** Path the binary was expected at, in display form. */
  readonly expectedPath: string;
  readonly state: CypressBinaryState;
  readonly verifiedBy: CypressBinaryVerification;
  /**
   * Trimmed, length-capped output from a probe, when one was run.
   * Never raw environment content — the probe's stdout only, truncated upstream.
   */
  readonly probeDetail: string | null;
}

/* -------------------------------------------------------------------------- */
/* Observation: compatibility policy (condition 6)                             */
/* -------------------------------------------------------------------------- */

/**
 * The supported Cypress range, with its provenance.
 *
 * The range is supplied by the adapter's compatibility policy — the single place
 * that owns it — and carried here as data so the assessor stays pure. `origin`
 * exists so a diagnostic can tell the reader *where* the claim comes from
 * instead of asserting a number with no accountable source.
 */
export interface CypressCompatibilityPolicy {
  /** Semver range the adapter supports, e.g. ">=12.0.0 <14". */
  readonly supportedRange: string;
  /** Human-readable provenance, e.g. "adapters/cypress#supportedCypress". */
  readonly origin: string;
}

/* -------------------------------------------------------------------------- */
/* The whole observation set                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Everything observed about Cypress in one project, at one instant.
 *
 * Passing a single immutable snapshot to the assessor (rather than letting it
 * read the filesystem) is what makes every one of the mandatory installation
 * states testable from a fixture with no mocks, and what stops two facts in the
 * same report from describing two different moments in time.
 */
export interface CypressHealthEvidence {
  readonly projectRoot: string;
  readonly declaration: CypressDeclaration;
  readonly resolution: CypressResolution;
  readonly binary: CypressBinaryEvidence | null;
  readonly compatibility: CypressCompatibilityPolicy;
  /** ISO 8601 UTC timestamp of capture, injected so reports stay reproducible. */
  readonly observedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                    */
/* -------------------------------------------------------------------------- */

/** A value safe to place in diagnostic evidence. */
export type CypressEvidenceValue =
  string | number | boolean | null | readonly string[];

/** Flat, display-safe detail for one condition. */
export type CypressEvidenceDetail = Readonly<
  Record<string, CypressEvidenceValue>
>;

/**
 * The prerequisite that was not established, named explicitly.
 *
 * `reason` says *why* the prerequisite failed, so a skipped check does not force
 * the reader to go and look it up: the skip line can say "skipped — DEP-003 not
 * established (Cypress is not installed)".
 */
export interface CheckPrerequisite {
  readonly checkId: CypressDiagnosticId;
  readonly reason: CypressProblemReason;
}

/**
 * The outcome for one condition, ready to be turned into a diagnostic finding.
 *
 * A single shape covers pass, fail, indeterminate and skipped: consumers must be
 * able to read all four without branching on the presence of fields, and a
 * skipped condition still needs a severity so that summaries and strict mode
 * behave predictably.
 */
export interface CypressConditionResult {
  readonly checkId: CypressDiagnosticId;
  readonly condition: CypressCondition;
  readonly status: CypressDiagnosticStatus;
  readonly severity: DiagnosticSeverity;
  readonly reason: CypressReason;
  /** `null` unless `status` is `skipped`. */
  readonly prerequisite: CheckPrerequisite | null;
  readonly evidence: CypressEvidenceDetail;
}

/* -------------------------------------------------------------------------- */
/* Ports                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the Cypress package belonging to a project.
 *
 * Implementations must use project-local resolution anchored at the given root,
 * must not fall back to a globally installed Cypress, and must not execute
 * project code. A resolution failure is returned, never thrown: "not installed"
 * is the expected answer we are here to report.
 */
export interface CypressPackageResolverPort {
  readonly resolve: (projectRoot: string) => Promise<CypressResolution>;
}

/**
 * Inspects the Cypress cache for a given version without running anything.
 *
 * Returns `null` when the cache location or platform layout is not understood,
 * which the assessor reports as `unknown` rather than inventing a path.
 */
export interface CypressBinaryInspectorPort {
  readonly inspect: (input: {
    readonly version: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
  }) => Promise<CypressBinaryEvidence | null>;
}

export interface CypressBinaryProbeInput {
  /** Absolute path to the resolved package's own CLI entry point. */
  readonly cypressCliPath: string;
  /** Hard upper bound; a doctor check must never be able to hang. */
  readonly timeoutMs: number;
  /** Cap on captured output, so a misbehaving binary cannot flood the log. */
  readonly maxOutputBytes: number;
}

/**
 * Bounded verification of an existing binary.
 *
 * `unverified` is a first-class outcome: a timeout or an unreadable probe tells us
 * nothing about the binary, and pretending otherwise is how a "probably fine"
 * becomes a "confirmed working".
 */
export type CypressBinaryProbeResult =
  | { readonly outcome: "usable" }
  | { readonly outcome: "unusable"; readonly detail: string }
  | { readonly outcome: "unverified"; readonly detail: string };

export interface CypressBinaryProbePort {
  readonly verify: (
    input: CypressBinaryProbeInput,
  ) => Promise<CypressBinaryProbeResult>;
}

/**
 * Captures the complete observation set for a project.
 *
 * One call, one snapshot: the collector is the only component allowed to touch
 * the filesystem, and it does so read-only.
 */
export interface CypressHealthCollectorPort {
  readonly capture: (projectRoot: string) => Promise<CypressHealthEvidence>;
}

/**
 * Everything the three Cypress rules need, injected at composition time.
 *
 * `now` is a function rather than a direct `new Date()` call so tests can pin the
 * timestamp and assertions on evidence remain byte-stable.
 */
export interface CypressHealthDependencies {
  readonly collector: CypressHealthCollectorPort;
  readonly compatibility: CypressCompatibilityPolicy;
  readonly now?: () => string;
}

/* -------------------------------------------------------------------------- */
/* Narrowing helpers                                                           */
/* -------------------------------------------------------------------------- */

/** True when a condition was never evaluated because a prerequisite failed. */
export function isSkipped(result: CypressConditionResult): boolean {
  return result.status === "skipped";
}

/** True when a condition produced a blocking or advisory failure. */
export function isFailed(result: CypressConditionResult): boolean {
  return result.status === "fail";
}

/**
 * True when the condition was evaluated and no problem was found.
 *
 * Note that `skipped` and `indeterminate` are *not* healthy: callers aggregating
 * results must use this rather than `!isFailed(...)`, or an unrun check will be
 * counted as a clean one.
 */
export function isHealthy(result: CypressConditionResult): boolean {
  return result.status === "pass";
}
