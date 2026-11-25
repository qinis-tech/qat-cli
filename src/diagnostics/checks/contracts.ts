/**
 * The shapes the catalogue is written against.
 *
 * Internal to this layer. A check receives evidence and returns a verdict; it renders nothing except through
 * `guidance.ts`, so the prose still lives in one file and this one stays readable as logic.
 *
 * ## Facts are grouped by source, not by check
 *
 * One source usually answers several checks: the assessment answers five, the configuration load result three. Grouping
 * by check would mean reading the same tree twice, and two readings of one tree are two readings that can disagree.
 *
 * ## Absent is not the same as empty
 *
 * A group being absent means *nobody gathered it* — a defect in the assembly, reported as a named skip. Gathering it
 * and finding nothing is a different thing entirely, which is why `PackageManagerFacts` holds an optional `selected`
 * rather than the group itself being optional: "no package manager could be identified" is a finding, and a check that
 * skipped on it would have nothing to say about exactly the case it exists for.
 *
 * `RuntimeFacts.nodeVersion` follows the same rule for the same reason: a host that reports no version is not a group
 * nobody gathered, it is an answer — and one worth reporting. Leaving it required would have forced the assembly to
 * invent a string or throw, and both of those hide the condition the check exists to describe.
 *
 * ## Why the runtime group carries a requirement as well as a version
 *
 * A check is data with one input: `evaluate(facts)`. It has no constructor, no injected dependency bag, no second
 * channel. So the supported range must arrive as evidence or not at all — and "not at all" would mean the rule
 * importing a constant, which is precisely how the same range ends up written in a check, a README and a CI matrix,
 * with three different values after the first release that forgets two of them.
 *
 * Treating the policy as evidence is honest rather than convenient: the range is *gathered* from the package's own
 * declaration, exactly as the version is gathered from the running process. Both are things the check is told and
 * must not assume. The two are kept in the same group because they are answered by the same question — "what is the
 * runtime situation here?" — and splitting them would add a group that no other check will ever read.
 *
 * Every field below is read by at least one check or by the sentence it produces. A fact nothing reads is a fact the
 * next person will assume is load-bearing.
 */
import type { ConfigurationLoadResult } from "../../config/loader/index.js";
import type {
  CheckCategory,
  CheckFinding,
  CheckId,
  CheckSeverity,
} from "../../core/application/checks.js";
import type { ProjectAssessment } from "../../core/application/validation.js";
import type { RuntimeRequirement } from "../../core/compatibility/index.js";

/**
 * The evidence a check may declare that it needs.
 *
 * The values are labels rather than property names: a skip message reads "package-manager evidence was not gathered",
 * not "packageManager evidence", and a label quoted in a report should be the words a reader would use. `FACT_KEYS`
 * maps a label to the property that holds it, so the two can differ without either being wrong.
 */
export const FactGroup = {
  Runtime: "runtime",
  PackageManager: "package-manager",
  Assessment: "assessment",
  Configuration: "configuration",
  Environment: "environment",
  Output: "output",
} as const;

export type FactGroup = (typeof FactGroup)[keyof typeof FactGroup];

/**
 * A runtime requirement, as a check needs it: range and provenance only.
 *
 * Narrowed from core's `RuntimeRequirement` by `Pick`, so the two cannot drift about what a range is — and so the
 * fields that are deliberately *not* here stay visibly not-here rather than being quietly present and unused.
 *
 * `severityWhenUnsatisfied` is the field that is dropped, and dropping it is the point. How badly a failed requirement
 * matters is declared once, on the check's `severity`, decided with every other check in one catalogue. Carrying it
 * here too would give the same decision two homes and leave a reader guessing which one wins.
 */
export type RuntimeRequirementFact = Pick<
  RuntimeRequirement,
  "range" | "origin"
>;

/**
 * The Node runtime situation: what the host reports, and what is required of it.
 *
 * Both halves are needed to produce a finding a reader can act on. `detected` without `required` is a number with no
 * context; `required` without `detected` is a rule with no subject. A finding needs the pair, which is why the group
 * holds the pair rather than leaving the caller to join them.
 */
export interface RuntimeFacts {
  /**
   * The version as the host reports it, e.g. `v24.4.0`.
   *
   * Unparsed here, on purpose: parsing happens once, inside the comparison, so there is exactly one opinion about what
   * a version is. A layer that pre-parsed would be a second opinion, and the two would eventually disagree about
   * something like a pre-release suffix.
   *
   * Absent when the host reported nothing — reported as a warning finding rather than as a pass, because "I could not
   * read the runtime" must never be mistaken for "the runtime is fine" (see the note at the top of this file).
   */
  readonly nodeVersion?: string;

  /**
   * What QAT itself requires.
   *
   * Required, not optional, because every run has an authority even when that authority declared nothing: an absent
   * `engines` field arrives here as an empty `range`, which the check reports as unreadable policy. Modelling it as
   * optional would make "no policy" indistinguishable from "policy not gathered", and the check would then skip on the
   * one condition it most needs to speak about.
   */
  readonly required: RuntimeRequirementFact;

  /**
   * An additional runtime bound declared by the project's framework release.
   *
   * Absent when nothing declares one, and absence emits nothing — an advisory invented from a missing declaration is
   * worse than no advisory. Named for the concept rather than for the framework, which is the same rule that keeps
   * this layer free of framework names: the next adapter supplies the same shape.
   *
   * Reported separately from `required`, never merged into its finding, because the two have different owners and
   * different urgency. A file that said only "unsupported runtime" would not tell a reader whose requirement failed.
   */
  readonly frameworkRequired?: RuntimeRequirementFact;
}

export interface PackageManagerFacts {
  /**
   * The manager that was declared or inferred. Absent when neither happened, which is a finding rather than silence.
   *
   * `name` and `declared` are carried for the report to print — "npm (from package-lock.json)" is a line a reader
   * wants — and the check itself reads only whether this is present. That is the honest division: the check decides,
   * the report describes.
   */
  readonly selected?: {
    readonly name: string;
    readonly declared: boolean;
  };
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
   * The source form rather than the resolved one, because a finding's `path` is relative to the root and echoing an
   * absolute location back at the reader hides the typo they are looking for. The prober resolved the real path to
   * decide `writable`; nobody downstream needs to print it.
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
 * Every group optional, because gathering is somebody else's job and a partially gathered set is a real state —
 * reported as a skip, which is why an absent group is a value rather than a compile error.
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
}

/**
 * Where each group lives on `CheckFacts`.
 *
 * A named map rather than a convention, because the label and the property are deliberately different words — `'package-manager'`
 * in a message, `packageManager` in a type — and a runner that indexed `facts[group]` directly would compile against
 * nothing. One map means one place to look when a group is added.
 */
export const FACT_KEYS: Readonly<Record<FactGroup, keyof CheckFacts>> = {
  [FactGroup.Runtime]: "runtime",
  [FactGroup.PackageManager]: "packageManager",
  [FactGroup.Assessment]: "assessment",
  [FactGroup.Configuration]: "configuration",
  [FactGroup.Environment]: "environment",
  [FactGroup.Output]: "output",
};

/**
 * What a check concluded.
 *
 * Three values, not four: whether a `fail` stops the run is the check's declared severity, decided once in the
 * catalogue, rather than something the check gets to choose at the point of failure.
 *
 * `warn` is also where "could not establish" belongs. A condition that could not be evaluated is not a pass — silence
 * must not read as consent — and it is not a `fail`, because a question we failed to answer must not block work we can
 * still perform. The finding then says which of the two it was, in words the reader can act on.
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
   * Not an ordering dependency: a failed or skipped precondition makes this check `skipped` rather than failed,
   * because reporting a consequence as a second problem hides the cause. Declaration order guarantees the precondition
   * has already been concluded, which is what lets the runner resolve skips in one pass.
   */
  readonly precondition?: CheckId;
  /** What an unfavourable answer means. The same value for every run, whatever condition fired. */
  readonly severity: CheckSeverity;
  /**
   * The scenario identifiers that verify this check.
   *
   * At least one, prefixed by the check's own identifier, unique across the catalogue — all three asserted, because
   * this list is the traceability artefact and a list nobody checks is a claim.
   */
  readonly scenarios: readonly string[];
  readonly evaluate: (facts: CheckFacts) => CheckVerdict;
}

/** The verdict for a check whose condition was met. Shared rather than rebuilt, so the happy path allocates nothing. */
export const PASS: CheckVerdict = { verdict: "pass" };

/**
 * A fact group the runner has already guaranteed.
 *
 * Reaching the throw means this catalogue and the runner disagree about `requires` — the runner checks every declared
 * group before calling `evaluate`, so a group can only be missing here if a check read one it never declared.
 *
 * That is a defect in this layer, not a condition of a project, so it must be loud in both directions: reporting it as
 * a finding would put a programmer's mistake into a user's terminal, and passing would let a check claim something it
 * never examined.
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
 * `present()` guards a whole group and its message is about `requires`. This guards a *field* inside a group, which is
 * a different defect with a different fix: the gatherer declared the group and then omitted the part that makes it
 * useful.
 *
 * Both are loud, for the same reason. Reporting an absent field as a finding would put a programmer's mistake into a
 * user's terminal — "QAT could not confirm that Node 20.11.1 satisfies  (declared in )" — and passing on it would let a
 * check claim something it never examined. The only remaining option is a message that names the omission.
 *
 * The parameter is optional on purpose even though the property is not: the guard exists for the case where the type
 * was satisfied by a hand-built object that never went through the type, which is exactly how this was first found.
 */
export function requireFact<T>(fact: T | undefined, what: string): T {
  if (fact === undefined) {
    throw new Error(
      `A check required ${what}, which the facts did not carry. The gatherer must supply it; a check cannot invent one.`,
    );
  }

  return fact;
}
