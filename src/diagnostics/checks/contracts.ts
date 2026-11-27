/**
 * The shapes the catalogue is written against.
 *
 * Internal to this layer. A check receives evidence and returns a verdict; it renders nothing
 * except through `guidance.ts`, so the prose still lives in one file and this one stays readable
 * as logic.
 *
 * ## Facts are grouped by source, not by check
 *
 * One source usually answers several checks: the assessment answers five, the configuration load
 * result three, the Cypress configuration snapshot two. Grouping by check would mean reading the
 * same tree twice, and two readings of one tree are two readings that can disagree.
 *
 * The Cypress group is the clearest case of the rule: three checks read one assessment of one
 * installation, so the installation is captured once and the conditions are decided once. A group
 * per check would have meant three captures, three chances to see three different filesystems and
 * three findings that contradict each other about what is installed.
 *
 * ## Three near-identical names, three different subjects
 *
 * The vocabulary is close enough to be worth stating once, because choosing the wrong group is a
 * mistake the compiler cannot catch:
 *
 * | Group | Subject | Answers |
 * | --- | --- | --- |
 * | `configuration` | **QAT's** own configuration file | Can this file be trusted, and what did it say |
 * | `cypress` | The **installed** Cypress package and binary | Is the framework healthy enough to run |
 * | `cypressConfiguration` | The **project's** Cypress configuration file | Can it be located, and can it be validated |
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

import type { ConfigurationLoadResult } from "../../config/loader/index.js";
import type {
  CheckCategory,
  CheckFinding,
  CheckId,
  CheckSeverity,
} from "../../core/application/checks.js";
import type { ProjectAssessment } from "../../core/application/validation.js";
// The widened name. One shape serves the runtime QAT requires, the bound a project's framework
// release declares, and the version a project pins for its package manager — which is why this
// layer narrows it once, by `Pick`, rather than declaring three near-identical fact types and
// hoping they stay in step.
import type { VersionRequirement } from "../../core/compatibility/index.js";
// The two decided configuration verdicts. Imported as verdicts rather than as raw observation —
// the file was read once, by the gatherer, and what reaches a check is the conclusion plus the
// evidence that supports it.
import type {
  ConfigDiscovery,
  ConfigValidation,
} from "../../project/cypress-config/index.js";
// Framework health conditions are decided by a pure assessment inside the gatherer, so this layer
// imports the *result* type only. Diagnostics depends on the project layer; the project layer
// knows nothing about diagnostics, so the direction stays acyclic.
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

export interface EnvironmentFacts {
  /** The profile a command asked for: a flag, or the file's default. Absent when neither named one. */
  readonly selected?: string;
  /** Every profile the configuration declares, in file order. Empty when there is no configuration at all. */
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
  /** The load outcome, which distinguishes absent from empty from malformed from schema-invalid. */
  readonly configuration?: ConfigurationLoadResult;
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
   * use it the same way: nothing can be validated until something has been located.
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
