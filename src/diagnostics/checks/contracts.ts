/**
 * The shapes the catalogue is written against.
 *
 * Internal to this layer. A check receives evidence and returns a verdict; it renders nothing
 * except through `guidance.ts`, so the prose still lives in one file and this one stays readable
 * as logic.
 *
 * ## Facts are grouped by source, not by check
 *
 * One source usually answers several checks: the assessment answers five, the composed
 * configuration verdict two, the environment inspection two, and the Cypress configuration snapshot
 * two. Grouping by check would mean reading the same tree twice, and two readings of one tree are
 * two readings that can disagree.
 *
 * The Cypress group is the clearest case of the rule: three checks read one assessment of one
 * installation, so the installation is captured once and the conditions are decided once. A group
 * per check would have meant three captures, three chances to see three different filesystems and
 * three findings that contradict each other about what is installed.
 *
 * ## Four near-identical names, four different subjects
 *
 * The vocabulary is close enough to be worth stating once, because choosing the wrong group is a
 * mistake the compiler cannot catch:
 *
 * | Group | Subject | Answers |
 * | --- | --- | --- |
 * | `configuration` | **QAT's** own configuration file | Can this file be trusted, what did it say, and did the schema accept it |
 * | `environment` | The **selected profile inside** that file | Which environment applies, and are the references it declares present |
 * | `cypress` | The **installed** Cypress package and binary | Is the framework healthy enough to run |
 * | `cypressConfiguration` | The **project's** Cypress configuration file | Can it be located, and can it be validated |
 *
 * `configuration` and `environment` are the pair most easily confused: the first is about a document,
 * the second about one named section of it. A finding that quoted the wrong one would tell a user to
 * fix a file that is fine.
 *
 * The last two are both "Cypress health" and neither subsumes the other: a project with a perfect
 * configuration and no installed binary is broken in one place, and a project with a healthy
 * installation and no configuration is broken in another. Merging them would produce one finding
 * per project instead of one finding per problem.
 *
 * ## Absent is not the same as empty
 *
 * A group being absent means *nobody gathered it* — a defect in the assembly, reported as a named
 * skip. Gathering it and finding nothing is a different thing entirely, which is why
 * `PackageManagerFacts` discriminates on its own `selection.status` rather than the group itself
 * being optional: "no package manager could be identified" is a finding, and a check that skipped
 * on it would have nothing to say about exactly the case it exists for.
 *
 * `RuntimeFacts.nodeVersion` follows the same rule for the same reason. Absence of the property is
 * itself an answer — "the host reported no version" — and never a quiet "the gatherer forgot".
 * Leaving it required would have forced the assembly to invent a string or throw, and both of
 * those hide the condition the check exists to describe. The convention holds because the gatherer
 * is the only writer: whoever builds `RuntimeFacts` has just asked the question, so a missing field
 * can only mean a missing answer.
 *
 * `ConfigurationFacts` is the third case and the easiest to get wrong. The group being absent means
 * nobody inspected the project at all. An inspection whose state is `missing` means we looked, found
 * nothing, and have something to say about it — informational when the operation can proceed on
 * documented defaults, blocking when it cannot. A check that skipped because the *group* was absent
 * would be silent on precisely the condition `CFG-001` exists to report.
 *
 * `EnvironmentFacts` is the fourth, and it fails in the more expensive direction. A configuration
 * that exists but selects no profile is a *result*: the run is fine on a laptop and wrong in CI, and
 * saying so is the whole job of `ENV-002`. Skipping because the group was missing and skipping
 * because no profile was selected would look identical in a report while meaning opposite things —
 * one is a bug in QAT, the other is a bug in the project.
 *
 * ## Why the runtime group carries a requirement as well as a version
 *
 * A check is data with one input: `evaluate(facts)`. It has no constructor, no injected dependency
 * bag, no second channel. So the supported range must arrive as evidence or not at all — and "not
 * at all" would mean the rule importing a constant, which is precisely how the same range ends up
 * written in a check, a README and a CI matrix, with three different values after the first release
 * that forgets two of them.
 *
 * Treating the policy as evidence is honest rather than convenient: the range is *gathered* from
 * the package's own declaration, exactly as the version is gathered from the running process. Both
 * are things the check is told and must not assume. The two are kept in the same group because they
 * are answered by the same question — "what is the runtime situation here?" — and splitting them
 * would add a group that no other check will ever read.
 *
 * ## Why gathering stays outside this layer
 *
 * Nothing here knows how evidence is obtained: no ports, no filesystem, no process. The workflow
 * that inspects a project reads the directory, resolves a binary on PATH and hands over the
 * results. That is what keeps every definition a pure function of a value, testable with literals,
 * and what stops a check from acquiring a second opinion about what "installed" or "supported"
 * means.
 *
 * Every field below is read by at least one check or by the sentence it produces. A fact nothing
 * reads is a fact the next person will assume is load-bearing.
 */
import type { EnvironmentInspection } from "../../config/environment/index.js";
import type { ConfigInspection } from "../../config/index.js";
import type {
  CheckCategory,
  CheckFinding,
  CheckId,
  CheckSeverity,
} from "../../core/application/checks.js";
import type { ProjectAssessment } from "../../core/application/validation.js";
import type { VersionRequirement } from "../../core/compatibility/index.js";
import type {
  ConfigDiscovery,
  ConfigValidation,
} from "../../project/cypress-config/index.js";
import type { CypressConditionResult } from "../../project/cypress-health/index.js";

/**
 * The evidence a check may declare that it needs.
 *
 * The values are labels rather than property names: a skip message reads "package-manager evidence
 * was not gathered", not "packageManager evidence", and a label quoted in a report should be the
 * words a reader would use. `FACT_KEYS` maps a label to the property that holds it, so the two can
 * differ without either being wrong.
 */
export const FactGroup = {
  Runtime: "runtime",
  PackageManager: "package-manager",
  Assessment: "assessment",
  Configuration: "configuration",
  /** The selected environment profile, and the references it declares. */
  Environment: "environment",
  Output: "output",
  /** The installed framework's health conditions, already decided. */
  Cypress: "cypress",
  /** The project's Cypress configuration, located and validated, already decided. */
  CypressConfiguration: "cypress-configuration",
} as const;

export type FactGroup = (typeof FactGroup)[keyof typeof FactGroup];

/**
 * A version requirement, as a check needs it: range and provenance only.
 *
 * Narrowed from core's requirement by `Pick`, so the two cannot drift about what a range is — and
 * so the fields that are deliberately *not* here stay visibly not-here rather than being quietly
 * present and unused.
 *
 * `severityWhenUnsatisfied` is the field that is dropped, and dropping it is the point. How badly a
 * failed requirement matters is declared once, on the check's `severity`, decided with every other
 * check in one catalogue. Carrying it here too would give the same decision two homes and leave a
 * reader guessing which one wins.
 *
 * Named for the shape rather than for the runtime because three different owners now supply one:
 * the runtime QAT requires, the bound a project's framework release declares, and the version a
 * project pins for its package manager. They are compared by the same engine, so they are described
 * by the same type — anything narrower would be three copies of one idea.
 */
export type VersionRequirementFact = Pick<
  VersionRequirement,
  "range" | "origin"
>;

/**
 * The Node runtime situation: what the host reports, and what is required of it.
 *
 * Both halves are needed to produce a finding a reader can act on. `detected` without `required` is
 * a number with no context; `required` without `detected` is a rule with no subject. A finding needs
 * the pair, which is why the group holds the pair rather than leaving the caller to join them.
 */
export interface RuntimeFacts {
  /**
   * The version as the host reports it, e.g. `v24.4.0`.
   *
   * Unparsed here, on purpose: parsing happens once, inside the comparison, so there is exactly one
   * opinion about what a version is. A layer that pre-parsed would be a second opinion, and the two
   * would eventually disagree about something like a pre-release suffix.
   *
   * Absent when the host reported nothing — reported as a warning finding rather than as a pass,
   * because "I could not read the runtime" must never be mistaken for "the runtime is fine" (see the
   * note at the top of this file).
   */
  readonly nodeVersion?: string;

  /**
   * What QAT itself requires.
   *
   * Required, not optional, because every run has an authority even when that authority declared
   * nothing: an absent `engines` field arrives here as an empty `range`, which the check reports as
   * unreadable policy. Modelling it as optional would make "no policy" indistinguishable from "policy
   * not gathered", and the check would then skip on the one condition it most needs to speak about.
   */
  readonly required: VersionRequirementFact;

  /**
   * An additional runtime bound declared by the project's framework release.
   *
   * Absent when nothing declares one, and absence emits nothing — an advisory invented from a missing
   * declaration is worse than no advisory. Deliberately named for the concept rather than for the
   * product, so the next adapter supplies the same field and no check changes: this is the *runtime*
   * bound, which is a property of any framework release, not of one vendor's.
   *
   * (The framework's own installation health is a different question and lives in `CypressFacts`,
   * where the conditions genuinely are framework-specific.)
   *
   * Reported separately from `required`, never merged into its finding, because the two have different
   * owners and different urgency. A file that said only "unsupported runtime" would not tell a reader
   * whose requirement failed.
   */
  readonly frameworkRequired?: VersionRequirementFact;
}

/**
 * How far a previous dependency installation got, and by whose hand.
 *
 * A closed vocabulary rather than a boolean because the four answers send a reader to four different
 * places, and `foreign` in particular is invisible to a boolean: dependencies *are* installed, by a
 * different tool, which explains a whole class of "works on my machine" failures without anyone
 * reading a log.
 */
export type PackageManagerInstallState =
  "installed" | "absent" | "foreign" | "unknown";

/** Why a version could not be obtained, when one was expected. Mirrors the executable probe's own vocabulary. */
export type UnverifiedVersionReason =
  "timeout" | "empty-output" | "failed" | "not-probed";

/** The manager's executable, as found — or not — on PATH. */
export interface PackageManagerExecutableFact {
  /** False means "install the tool"; it does not mean "install the dependencies". */
  readonly resolved: boolean;
  /** The reported version, unparsed, so the comparison parses once. */
  readonly version?: string;
  /** Present only when `version` is absent and a version was expected. */
  readonly reason?: UnverifiedVersionReason;
}

/**
 * What detection concluded, as four mutually exclusive answers.
 *
 * A discriminated union rather than optional fields, for the same reason the domain uses one: `status`
 * alone tells a reader which of the four stories applies, and no combination like "unsupported *and*
 * undeclared" can be built. The four are exactly the four fixes a user might be sent to — change tool,
 * install tool, declare a tool, or reconcile two lockfiles — which is why they are not collapsed into
 * "package manager problem".
 */
export type PackageManagerSelection =
  | {
      readonly status: "identified";
      readonly name: string;
      /** True when the project declared it, false when it was inferred from a lockfile. */
      readonly declared: boolean;
    }
  | {
      readonly status: "conflicting";
      readonly managers: readonly string[];
      readonly lockfiles: readonly string[];
    }
  | {
      readonly status: "unsupported";
      readonly name: string;
    }
  | {
      readonly status: "undeclared";
      /** An unusable `packageManager` value, quoted verbatim so the reader recognises their own text. */
      readonly declaration?: {
        readonly raw: string;
        readonly problem: "missing-version" | "malformed" | "unknown-manager";
      };
    };

/**
 * The package-manager situation: identity, tooling, declared expectation and installation state.
 *
 * Widened from identity alone, because identity alone cannot answer the question this group exists for.
 * "Which manager is this?" and "is that manager's environment healthy?" are different questions, and a
 * group that answered only the first would force the check to shrug at the two conditions users
 * actually hit: a missing binary, and a tree nobody installed.
 *
 * Each member earns its place by being read by the check or by the sentence it produces:
 *
 * - `selection` decides which story is told, and is the only required member: without it there is
 *   nothing to say.
 * - `executable` distinguishes "tool missing" from "tool present but silent", which have different
 *   fixes.
 * - `required` turns an installed version into a comparable statement; absent when the project
 *   declared nothing.
 * - `installState` separates "your tooling is wrong" from "you simply have not installed yet".
 */
export interface PackageManagerFacts {
  readonly selection: PackageManagerSelection;

  /** Lockfile basenames seen at the project root, sorted. Evidence for the sentence, never a decision input. */
  readonly lockfiles: readonly string[];

  readonly executable?: PackageManagerExecutableFact;

  /**
   * The manager version the project expects: a `packageManager` pin or an `engines` range.
   *
   * Same narrowed shape as the runtime requirement, for the same reason: the check must not be able to
   * reach a policy constant, so whatever it compares against arrives as evidence with its provenance
   * attached.
   */
  readonly required?: VersionRequirementFact;

  readonly installState: PackageManagerInstallState;

  /**
   * Who created `node_modules`, when `installState` is `foreign`.
   *
   * Carried separately rather than folded into the state string, because the answer itself is not the
   * useful part — naming the other tool is. "Dependencies were installed by npm" is actionable;
   * "foreign" is jargon.
   */
  readonly foreignMarker?: {
    readonly marker: string;
    readonly createdBy: string;
  };
}

/**
 * QAT's own configuration, as far as anything was entitled to conclude.
 *
 * This group is a *verdict*, like the two Cypress groups, and for the same reason: the file was read
 * exactly once by the gatherer, and what reaches a check is the conclusion together with the evidence
 * that supports it. Two checks read it — one asks whether the file exists and is readable, the other
 * whether it conforms to a schema we support — and both must be describing the same read.
 *
 * ## Why this is the composed inspection rather than the loader's outcome
 *
 * The loader's outcome stops at "bytes became a document or did not". It cannot answer the schema
 * question, and it cannot say whether the declared version is one we are allowed to interpret. A group
 * holding only the loader outcome would force the schema check to reach into `validation` itself and
 * compose the two stages again — a second composition, with its own ordering, that would eventually
 * disagree with the one the `run` preflight performs.
 *
 * The inspection is that composition, done once, in the configuration module, and deliberately
 * non-throwing: an expected condition such as "no file", "unreadable" or "not JSON" is a state a
 * diagnostic can describe, not an exception it has to catch. Its six states map one-to-one onto the
 * stories the two checks tell, which is why this layer can import a single type and no stage port.
 *
 * ## What is deliberately not here
 *
 * No file contents, no absolute paths, no environment values. The states carry identifiers, counts and
 * project-relative locations; the wording and the evidence shaping happen in the configuration
 * diagnostics module, so a check cannot accidentally paste a configuration value into a report.
 *
 * `ConfigInspection` is generic with an `unknown` payload: a check that needs the resolved
 * configuration reads it through a guard, exactly as it would read any other evidence it did not
 * produce. Claiming a concrete payload type here would be this layer asserting a shape the
 * configuration module owns.
 */
export type ConfigurationFacts = ConfigInspection;

/**
 * The installed framework's health conditions, already decided.
 *
 * Assessment is pure — evidence in, conditions out — so it runs inside the gatherer, which is the only
 * layer allowed to read the filesystem, resolve a package or probe a binary. The checks then read
 * decisions rather than raw observation, which is why three checks share one gather step and cannot
 * disagree about what was installed.
 *
 * `results` always contains one entry per framework check, including the skipped ones. That is the
 * point of carrying decisions rather than observations: a check that had to skip still says so in the
 * group, and the finding can name the check that must be fixed first instead of the report showing a
 * silent gap.
 *
 * A check absent from `results` is a defect in the gatherer, not a condition of the project — which is
 * why the rules throw on it rather than inventing a pass.
 */
export interface CypressFacts {
  readonly results: readonly CypressConditionResult[];
}

/**
 * The project's Cypress configuration: located, and validated as far as anything was entitled to.
 *
 * Both verdicts are required, and both are required *together*, because they were decided from one
 * capture of one file. Location depends on facts read from disk and validation depends on those
 * same facts plus, at most, one bounded loader invocation; a group that could hold one without the
 * other would let a check report a validity verdict about a file it never located — or a location
 * verdict that contradicts the validation performed seconds later.
 *
 * `location` answers "is it there, is it usable as a file", and is the subject of CFG-003.
 * `validation` answers "could anything establish that it is valid, and if so what", and is the
 * subject of CFG-004. Neither is derivable from the other: a located file may be unvalidatable, and
 * a validation can only exist because something was located first.
 *
 * ## Why this is not on `assessment`
 *
 * `assessment` carries what detection found, and detection deliberately never reads file contents —
 * it probes names at the root and reports a verdict. The configuration checks need bytes: is the
 * file readable, is it text, does a parser accept it. Putting their verdicts on `assessment` would
 * either force detection to become a file reader or leave the assessment carrying a decision whose
 * evidence came from somewhere else. A separate group keeps each claim traceable to the capture that
 * produced it.
 *
 * ## Why the loader's own result is not a third member
 *
 * The bounded loader invocation is already recorded inside `validation`: its tier says which
 * mechanism spoke, its cause says why none did, and its duration says what it cost. A separate
 * member would be a second place to look for one fact.
 */
export interface CypressConfigurationFacts {
  /** CFG-003's decided subject: where the configuration is, or why it is not usable. */
  readonly location: ConfigDiscovery;

  /** CFG-004's decided subject: the furthest safe conclusion about its validity. */
  readonly validation: ConfigValidation;
}

/**
 * The selected environment profile, as far as anything was entitled to conclude.
 *
 * A verdict, like `ConfigurationFacts` and the two Cypress groups, and for the same reason: the
 * configuration was read once and the selection was made once, so what reaches a check is the
 * conclusion rather than a second resolution. Two checks read it — one asks whether the profile the
 * command named is usable at all, the other whether the variables that profile references are
 * present — and both must be describing the same resolution of the same file.
 *
 * ## Why there is no separate `selected` member
 *
 * `EnvironmentInspection` carries the origin of the choice in every state that has one: whether the
 * profile came from a flag, from the process environment, or from the file's default. A separate
 * `selected` field would be a second copy of a fact already inside the verdict — and the two would
 * eventually disagree about the run where the flag was present but empty, which is exactly the run
 * worth reporting precisely.
 *
 * ## Why `requiredForOperation` is evidence and not a check concern
 *
 * The same absence is a non-event for `doctor` and a blocker for a command about to execute tests.
 * That difference is decided by the caller before the catalogue runs, and it changes a finding's
 * severity without changing one fact about the project. A check that inferred it would be guessing
 * which operation it was serving, and would be wrong on whichever one it guessed second.
 *
 * Recording it here is also what lets the finding explain its own severity: "no environment is
 * selected, and this command needs one" is a sentence the reader can check, while a severity
 * applied silently is one they have to take on trust.
 *
 * ## What is deliberately not here
 *
 * No values. Not one, for any variable, in any state. The inspection carries *names* and *presence
 * states*, which is the entire purpose of the presence port: the checks layer can say what is
 * missing without ever holding what it is missing. Redaction is not applied to this group because
 * there is nothing to redact, and adding a redaction step would imply otherwise — and imply that a
 * future change could start putting values here.
 */
export interface EnvironmentFacts {
  /** The decided state of the selection, from one resolution of one configuration. */
  readonly inspection: EnvironmentInspection;

  /**
   * Whether the operation being checked needs an environment at all.
   *
   * Decides the severity of "nothing was selected" and nothing else: informational for a diagnostic
   * run, blocking for a run that is about to execute. Carried rather than inferred so the verdict is
   * both correct and reproducible from the evidence alone.
   */
  readonly requiredForOperation: boolean;

  /**
   * Every profile the configuration declares, sorted.
   *
   * Read by the sentence for a run with no selection: "declare one of …" is only actionable if the
   * reader is told what exists. Not a decision input — which profile applies was decided by the
   * inspection, and a second list here could not disagree with it without contradicting the verdict.
   */
  readonly declared: readonly string[];
}

/** A configured output directory, as the prober found it. */
export interface OutputTarget {
  /**
   * The path as it was written, relative to the project root.
   *
   * The source form rather than the resolved one, because a finding's `path` is relative to the root and
   * echoing an absolute location back at the reader hides the typo they are looking for. The prober
   * resolved the real path to decide `writable`; nobody downstream needs to print it.
   */
  readonly path: string;
  /** Whether a write to the resolved location would succeed. Probed, never inferred from a mode bit. */
  readonly writable: boolean;
}

export interface OutputFacts {
  readonly reports: OutputTarget;
  readonly evidence: OutputTarget;
}

/**
 * Everything a caller may supply.
 *
 * Every group optional, because gathering is somebody else's job and a partially gathered set is a real
 * state — reported as a skip, which is why an absent group is a value rather than a compile error.
 */
export interface CheckFacts {
  readonly runtime?: RuntimeFacts;
  readonly packageManager?: PackageManagerFacts;
  /** What detection found, plus the per-operation verdict — the source five checks read. */
  readonly assessment?: ProjectAssessment;
  /** QAT's own configuration, composed into one verdict that distinguishes absent from malformed from unsupported from schema-invalid. */
  readonly configuration?: ConfigurationFacts;
  /** The selected environment profile and the references it declares, decided once for the two checks that read them. */
  readonly environment?: EnvironmentFacts;
  readonly output?: OutputFacts;
  /** The installed framework's health conditions, decided once for the checks that read them. */
  readonly cypress?: CypressFacts;
  /** The project's Cypress configuration: located and validated, decided once for the two checks that read them. */
  readonly cypressConfiguration?: CypressConfigurationFacts;
}

/**
 * Where each group lives on `CheckFacts`.
 *
 * A named map rather than a convention, because the label and the property are deliberately different
 * words — `'package-manager'` in a message, `packageManager` in a type — and a runner that indexed
 * `facts[group]` directly would compile against nothing. One map means one place to look when a group
 * is added.
 *
 * Frozen and literal-typed: this table is how the runner finds evidence, so it must not be rewritable at
 * runtime, and a contract test can assert every mapped key really exists on `CheckFacts` and that every
 * key on `CheckFacts` is reachable through it.
 */
export const FACT_KEYS = Object.freeze({
  [FactGroup.Runtime]: "runtime",
  [FactGroup.PackageManager]: "packageManager",
  [FactGroup.Assessment]: "assessment",
  [FactGroup.Configuration]: "configuration",
  [FactGroup.Environment]: "environment",
  [FactGroup.Output]: "output",
  [FactGroup.Cypress]: "cypress",
  [FactGroup.CypressConfiguration]: "cypressConfiguration",
} as const satisfies Record<FactGroup, keyof CheckFacts>);

/**
 * What a check concluded.
 *
 * Three values, not four: whether a `fail` stops the run is the check's declared severity, decided once
 * in the catalogue, rather than something the check gets to choose at the point of failure.
 *
 * `warn` is also where "could not establish" belongs. A condition that could not be evaluated is not a
 * pass — silence must not read as consent — and it is not a `fail`, because a question we failed to
 * answer must not block work we can still perform. The finding then says which of the two it was, in
 * words the reader can act on.
 *
 * Because verdicts come from facts alone, `evaluate` is synchronous. That is the type doing real work: a
 * check cannot reach for a filesystem, spawn a process or await a probe, so gathering has to happen
 * before the catalogue runs, and every check stays a pure function testable with literals.
 */
export type CheckVerdict =
  | { readonly verdict: "pass" }
  | { readonly verdict: "warn" | "fail"; readonly finding: CheckFinding };

/** One check, as data. */
export interface CheckDefinition {
  readonly id: CheckId;
  readonly category: CheckCategory;
  /** The check's name, as it appears in a report heading. */
  readonly title: string;
  /** Why the check exists, in one sentence a reader can disagree with. */
  readonly purpose: string;
  /** What the check actually does. One sentence, in the present tense. */
  readonly procedure: string;
  /** The evidence groups this check reads. A check is skipped when one of them is absent. */
  readonly requires: readonly FactGroup[];
  /**
   * The check that must have passed for this one to be meaningful.
   *
   * Not an ordering dependency: a failed or skipped precondition makes this check `skipped` rather than
   * failed, because reporting a consequence as a second problem hides the cause. Declaration order
   * guarantees the precondition has already been concluded, which is what lets the runner resolve skips
   * in one pass.
   *
   * Framework checks use it for their real dependency: a binary cache is keyed by version, so a check
   * that inspects the cache declares the check that establishes the version. The configuration checks
   * use it the same way: nothing can be validated until something has been located, and nothing can
   * be located in a file that could not be read. The environment checks are the third case: a
   * reference inside a profile that could not be resolved is not a fact about the variable, so
   * presence is not reported until the profile itself is usable.
   */
  readonly precondition?: CheckId;
  /** What an unfavourable answer means. The same value for every run, whatever condition fired. */
  readonly severity: CheckSeverity;
  /**
   * The scenario identifiers that verify this check.
   *
   * At least one, prefixed by the check's own identifier, unique across the catalogue — all three
   * asserted, because this list is the traceability artefact and a list nobody checks is a claim.
   */
  readonly scenarios: readonly string[];
  readonly evaluate: (facts: CheckFacts) => CheckVerdict;
}

/** The verdict for a check whose condition was met. Shared rather than rebuilt, so the happy path allocates nothing. */
export const PASS: CheckVerdict = Object.freeze({ verdict: "pass" });

/**
 * A fact group the runner has already guaranteed.
 *
 * Reaching the throw means this catalogue and the runner disagree about `requires` — the runner checks
 * every declared group before calling `evaluate`, so a group can only be missing here if a check read
 * one it never declared.
 *
 * That is a defect in this layer, not a condition of a project, so it must be loud in both directions:
 * reporting it as a finding would put a programmer's mistake into a user's terminal, and passing would
 * let a check claim something it never examined.
 */
export function present<T>(group: T | undefined): T {
  if (group === undefined) {
    throw new Error(
      "A check read a fact group it did not declare in `requires`. The catalogue and the runner disagree.",
    );
  }

  return group;
}

/**
 * A fact the type says must be present.
 *
 * `present()` guards a whole group and its message is about `requires`. This guards a *field* inside a
 * group, which is a different defect with a different fix: the gatherer declared the group and then
 * omitted the part that makes it useful.
 *
 * Both are loud, for the same reason. Reporting an absent field as a finding would put a programmer's
 * mistake into a user's terminal — the message would read "QAT could not confirm that Node 20.11.1
 * satisfies <empty range> (declared in <empty origin>)" — and passing on it would let a check claim
 * something it never examined. The only remaining option is a message that names the omission.
 *
 * The parameter is optional on purpose even though the property is not: the guard exists for the case
 * where the type was satisfied by a hand-built object that never went through the compiler's checks,
 * which is exactly how this gap was first found.
 */
export function requireFact<T>(fact: T | undefined, what: string): T {
  if (fact === undefined) {
    throw new Error(
      `A check required ${what}, which the facts did not carry. The gatherer must supply it; a check cannot invent one.`,
    );
  }

  return fact;
}
