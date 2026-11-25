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

/** The Node runtime is running on. One value, because the only question asked of it is which major it starts with. */
export interface RuntimeFacts {
  /** As the process reports it, e.g. `v24.4.0`. Unparsed here: the check compares majors, not strings. */
  readonly nodeVersion: string;
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
