/**
 * Structured detection results.
 *
 * What QAT knows about a directory, including what is wrong with it, as a value. Every consumer — a command, a
 * report, a future automation service — reads the same shape, so a condition cannot be described one way in a
 * terminal and another way in a JSON document.
 *
 * ## Why this is not the CLI's business
 *
 * Nothing here mentions a stream, a colour, a column or a sentence written for a terminal. The findings carry prose,
 * because a machine consuming the result still needs to show it to somebody, but where that prose ends up is decided
 * by whoever renders it.
 *
 * ## Two statuses, deliberately separate
 *
 * `detection` answers *is this a Cypress project*, and `compatibility` answers *does the version match the
 * configuration format in use*. Neither implies the other: a project can be identified perfectly and still be
 * impossible to run. Collapsing them into one "ok" flag is how a tool reports a broken project as healthy.
 *
 * ## Two vocabularies, one finding shape
 *
 * The codes here are the ones **detection** can report. Validation adds its own, declared next door in
 * `./validation.js`, because whether a condition blocks depends on the operation about to run and this file must
 * not start describing operations.
 *
 * They are not merged into one union *here*, and the reason is mechanical before it is conceptual: the finding
 * shape is generic over its code set, so a consumer that handles both asks for
 * `DiagnosticFinding<DiagnosticCode | ValidationCode>` and gets one interface. Declaring the union here would
 * require importing `validation.js`, which imports this file — a cycle for the sake of one alias.
 */
import type {
  FrameworkDeclaration,
  FrameworkInstallation,
} from "../domain/index.js";

/**
 * How loudly a finding speaks.
 *
 * Three levels, matching the approved classification, and deliberately *not* the same thing as a check's status:
 * severity says what a condition means, status says what happened on this run. A failing check always carries `error`;
 * an `information` finding never blocks and never should — it exists so an observation worth printing is not silently
 * dropped or inflated into a warning.
 */
export const DiagnosticSeverity = {
  /** The condition prevents the requested work. */
  Error: "error",
  /** The condition is worth acting on but does not prevent the work. */
  Warning: "warning",
  /**
   * A non-blocking observation: an optional capability that is not configured, or a normal state worth naming.
   *
   * The level that keeps a doctor honest. Without it, a benign state is either hidden (and the reader never learns the
   * defaults are in use) or promoted to a warning (and the reader learns to ignore warnings).
   */
  Information: "information",
} as const;

export type DiagnosticSeverity =
  (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

/**
 * Whether the directory was identified as a project QAT can drive.
 *
 * Four values rather than five verdicts, because a consumer needs to know what to do next, not how the engine
 * arrived there: *yes*, *no*, *I cannot tell*, and *what is here is not usable*. The reason behind a `not-detected`
 * is a diagnostic, which is where the detail belongs.
 */
export const DetectionStatus = {
  Detected: "detected",
  NotDetected: "not-detected",
  Ambiguous: "ambiguous",
  Invalid: "invalid",
} as const;

export type DetectionStatus =
  (typeof DetectionStatus)[keyof typeof DetectionStatus];

/**
 * Whether the installed version can work with the configuration format in use.
 *
 * **This is not a support policy.** The only comparison available without one is a fact about the configuration
 * format: `cypress.config.*` was introduced in Cypress 10, so an installation older than that cannot read the file
 * that was found. `Consistent` therefore means "not contradicted by that fact", which is a weaker claim than
 * "supported" and is the strongest one the project can currently make.
 *
 * `Undetermined` is not a failure. It is the honest answer when there is nothing to compare — no installation, or no
 * configuration.
 *
 * Whether a version is inside the range this tool will actually drive is a separate question, asked by the version
 * policy in the validation layer. Adding it here would put a decision in the type that carries a fact.
 */
export const CompatibilityStatus = {
  Consistent: "consistent",
  Incompatible: "incompatible",
  Undetermined: "undetermined",
} as const;

export type CompatibilityStatus =
  (typeof CompatibilityStatus)[keyof typeof CompatibilityStatus];

/**
 * What could be established about `package.json`.
 *
 * Four states rather than a boolean, because the three failures have three different consequences: an absent
 * manifest is legal, an incomplete one loses the project name, and an unreadable one stops everything.
 */
export const PackageMetadataStatus = {
  Present: "present",
  Absent: "absent",
  Incomplete: "incomplete",
  Unreadable: "unreadable",
} as const;

export type PackageMetadataStatus =
  (typeof PackageMetadataStatus)[keyof typeof PackageMetadataStatus];

/**
 * Every condition detection can report.
 *
 * Codes are permanent. A withdrawn condition leaves its code unused rather than reusing it, for the same reason the
 * error model's codes are permanent: a code is quoted in a bug report, and a code that has changed meaning makes the
 * report useless to whoever reads it later.
 *
 * The prefix distinguishes a diagnostic — a finding about a project — from an application error, which is a
 * condition that stopped a command. Validation's codes use a second prefix in `./validation.js` for the same
 * reason: which layer raised a finding should be readable from the code alone.
 */
export const DiagnosticCode = {
  /** Nothing identifying Cypress was found. */
  FrameworkNotDetected: "QAT-D001",
  /** Cypress is evidenced, but there is no configuration file. */
  ConfigurationMissing: "QAT-D002",
  /** More than one supported configuration file in one directory. */
  ConfigurationAmbiguous: "QAT-D003",
  /** A configuration file in a format QAT cannot read. */
  ConfigurationUnsupported: "QAT-D004",
  /** A configuration exists, but no installed package could be found. */
  DependencyNotInstalled: "QAT-D005",
  /** The installed version predates the configuration format in use. */
  VersionIncompatible: "QAT-D006",
  /** A manifest exists and could not be read. */
  ManifestUnreadable: "QAT-D007",
  /** No manifest. Legal, and worth knowing. */
  ManifestMissing: "QAT-D010",
  /** A manifest without a name or a version. */
  ManifestIncomplete: "QAT-D011",
  /** Cypress installed in the project itself, but not declared by it. */
  DependencyUndeclared: "QAT-D012",
} as const;

export type DiagnosticCode =
  (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

/**
 * One thing worth saying about a project.
 *
 * The text is carried rather than looked up, so a result is self-describing: a report generator given a diagnosis
 * does not need to import a catalogue, and a stored diagnosis still reads correctly after the catalogue's wording
 * has changed.
 *
 * ## Why the code set is a parameter
 *
 * Two vocabularies share this shape — detection's codes and validation's — and one interface means anything that
 * renders, sorts or stores findings handles both without a branch on which layer produced them. The parameter is
 * the union a caller accepts: `DiagnosticFinding<DiagnosticCode>` for a diagnosis, `DiagnosticFinding<ValidationCode>`
 * for validation's own findings, and `DiagnosticFinding<AnyDiagnosticCode>` for a gate that holds both.
 *
 * The default keeps every existing use unchanged, and the readonly `code` makes the parameter covariant — so a
 * narrower finding is assignable to a wider list without a cast.
 */
export interface DiagnosticFinding<Code extends string = DiagnosticCode> {
  readonly code: Code;
  readonly severity: DiagnosticSeverity;
  /** One sentence stating the condition. Never a stack, never a fragment. */
  readonly explanation: string;
  /** What to do next. Absent when no action is available. */
  readonly remediation?: string;
  /** The file or directory concerned, relative to `identity.root`. Absent when the finding is about the whole project. */
  readonly path?: string;
}

/** Who the project is, as far as it can be established. */
export interface ProjectIdentity {
  /** Absolute. The one absolute path in the diagnosis; every other path is relative to it. */
  readonly root: string;
  /** From the manifest where present, otherwise the directory name. */
  readonly name: string;
  readonly packageMetadata: PackageMetadataStatus;
  /**
   * Workspace patterns the manifest declares, exactly as written — `packages/*` and friends.
   *
   * Reported and never expanded, as before. They are carried here because one validation rule has to warn when a
   * project root is also a workspace container, and that warning is only useful if it can name the patterns. They
   * stay off the project description: a consumer handed a list of globs eventually expands one, and a warning is
   * the only thing that wants them.
   *
   * Always present, and frequently empty. An empty array means the manifest declared none, which is the ordinary
   * case and not the same as a field nobody filled in.
   */
  readonly declaredWorkspaces: readonly string[];
}

/** What was established about the framework, as facts rather than as a single yes or no. */
export interface FrameworkEvidence {
  /** Where the manifest declares it. Absent when it does not. */
  readonly declaration?: FrameworkDeclaration;
  /** The installed package. Absent when nothing is on disk. */
  readonly installation?: FrameworkInstallation;
  /** The single supported configuration file. Absent when there is none, or more than one. */
  readonly configuration?: string;
  /** Every supported configuration file found, in candidate order. */
  readonly configurationsFound: readonly string[];
  /** Configuration files recognised as Cypress but not usable. */
  readonly unsupportedConfigurations: readonly string[];
  /**
   * Whether the executable could be invoked — **only when something has verified it**.
   *
   * `undefined` means nobody looked, and is not the same as `false`. Passive detection deliberately never runs the
   * framework, so this is `undefined` throughout the current implementation; the field exists so that a separate
   * verification operation can fill it in without changing the shape every consumer already reads.
   *
   * Deliberately optional in neither direction: the field is always present and sometimes `undefined`, because
   * `exactOptionalPropertyTypes` distinguishes "absent" from "present and unknown", and this is the second.
   * The validation layer reads only an explicit `false`, so "nobody checked" can never block a run.
   */
  readonly binaryAvailable: boolean | undefined;
}

export interface ProjectDiagnosis {
  readonly identity: ProjectIdentity;
  readonly framework: FrameworkEvidence;
  readonly detection: DetectionStatus;
  readonly compatibility: CompatibilityStatus;
  /** Ordered: blocking findings first, then warnings. An empty array means nothing was wrong. */
  readonly findings: readonly DiagnosticFinding[];
}

/**
 * Whether anything in the diagnosis stops a command.
 *
 * A named function rather than `findings.some(...)` at each call site, so "blocking" is defined in one place — and
 * so a consumer that only supports warnings cannot invent its own definition of fatal.
 *
 * This answers for the project as a whole. Whether a *specific* operation may proceed is a different question with
 * a different answer, and it is not this one: a blocking finding stops an execution and never stops an inspection,
 * because reporting the blockers is what an inspection is for. The per-operation verdict is on the assessment's
 * gate, which is why this function takes a diagnosis rather than a list of findings — a caller holding a gate is
 * asking something else, and should be told so by the types rather than by a comment.
 */
export function hasBlockingErrors(diagnosis: ProjectDiagnosis): boolean {
  return diagnosis.findings.some(
    (finding) => finding.severity === DiagnosticSeverity.Error,
  );
}

/**
 * The detection codes whose severity is always error.
 *
 * A narrowing helper for a consumer that wants to `switch` over blocking conditions with exhaustiveness checking.
 * The guarantee is one-directional and worth stating plainly: **every member of this union is an error; this union
 * does not claim to be every error.**
 *
 * The catalogue remains the authority on severity. This alias is a convenience for callers that need a closed set,
 * and it is kept honest by a test in the catalogue's suite rather than by the type system — a contract file cannot
 * import the catalogue that would check it, because the dependency runs the other way. That test is the whole
 * enforcement, so it should be written before the union is relied on.
 *
 * Validation's codes are deliberately absent. Whether one of them blocks depends on the operation about to run, and
 * a union that cannot express "conditional" would be read as though it could. See the gate for that answer.
 */
export type ErrorDiagnosticCode =
  | typeof DiagnosticCode.FrameworkNotDetected
  | typeof DiagnosticCode.ConfigurationMissing
  | typeof DiagnosticCode.ConfigurationAmbiguous
  | typeof DiagnosticCode.ConfigurationUnsupported
  | typeof DiagnosticCode.DependencyNotInstalled
  | typeof DiagnosticCode.VersionIncompatible
  | typeof DiagnosticCode.ManifestUnreadable;
