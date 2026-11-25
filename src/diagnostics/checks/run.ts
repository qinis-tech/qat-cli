/**
 * Running the catalogue.
 *
 * Pure: facts in, report out. No filesystem, no clock, no stream — which is what lets every scenario in the catalogue
 * be verified from a literal, including the skipped ones, which are the hardest to arrange against a real disk.
 *
 * ## Two ways to skip, and they mean different things
 *
 * A **failed precondition** is a fact about the project: the question cannot be answered until something else is
 * fixed, and the report names the check that stopped it. A **missing input** is a fact about the caller: nobody
 * gathered the evidence, which is a defect in the assembly rather than in the project. Both are `skipped`, and the
 * reason distinguishes them because a user reading the report and a maintainer debugging the tool need different
 * answers from the same line.
 *
 * Neither ever blocks. A check is skipped *because* another check did not pass, and that failure is already in the
 * list — counting the consequence as well reports one condition as several, which is the collapse the whole
 * diagnostics chain exists to prevent.
 *
 * ## One pass, no fixed-point iteration
 *
 * The catalogue guarantees that a precondition appears before its dependant, so each outcome needs only the outcomes
 * already computed. That is a property the catalogue test asserts, and it is why this file reads as a loop rather than
 * as a dependency graph walk.
 */
import {
  CheckSkipReason,
  CheckStatus,
  type CheckOutcome,
  type CheckSeverity,
  type DoctorReport,
} from "../../core/application/checks.js";

import {
  FACT_KEYS,
  type CheckDefinition,
  type CheckFacts,
  type CheckVerdict,
} from "./contracts.js";
import { CHECKS } from "./rules.js";

/**
 * Runs every check the facts permit, in catalogue order.
 *
 * @param facts Whatever evidence the caller gathered. A group that is absent makes the checks requiring it skip, which
 *   is reported rather than hidden — an empty report would be indistinguishable from a healthy project.
 * @returns One outcome per check, in declaration order, which is the order a reader fixes things in.
 * @throws {Error} only when the catalogue contradicts itself: a precondition that was never concluded before its
 *   dependant. That is a defect in this layer rather than a condition of a project, so it must be loud in both
 *   directions — reporting it as a finding would put a programmer's mistake into a user's terminal, and skipping it
 *   would let a check run as though the gate it depends on had passed.
 */
export function runChecks(facts: CheckFacts): DoctorReport {
  const concluded = new Map<CheckOutcome["check"], CheckOutcome>();
  const outcomes: CheckOutcome[] = [];

  for (const check of CHECKS) {
    const outcome = outcomeFor(check, facts, concluded);

    concluded.set(outcome.check, outcome);
    outcomes.push(outcome);
  }

  return { outcomes };
}

function outcomeFor(
  check: CheckDefinition,
  facts: CheckFacts,
  concluded: ReadonlyMap<CheckOutcome["check"], CheckOutcome>,
): CheckOutcome {
  const base = {
    check: check.id,
    category: check.category,
    severity: check.severity,
  };

  // The precondition first. A user reading "not run, because the configuration could not be read" learns why; a user
  // reading "not run, because evidence was missing" learns nothing about their project. When both apply, the project
  // fact is the one worth printing.
  if (check.precondition !== undefined) {
    const dependency = concluded.get(check.precondition);

    if (dependency === undefined) {
      throw new Error(
        `The catalogue declares ${check.id} before its precondition ${check.precondition}, so the gate was never concluded.`,
      );
    }

    if (dependency.status !== CheckStatus.Passed) {
      return skipped(
        base,
        CheckSkipReason.PreconditionFailed,
        check.precondition,
      );
    }
  }

  const missing = check.requires.filter(
    (group) => facts[FACT_KEYS[group]] === undefined,
  );

  if (missing.length > 0) {
    return skipped(
      base,
      CheckSkipReason.InputUnavailable,
      missing.join(" and "),
    );
  }

  return conclude(base, check.evaluate(facts));
}

/** The fields every outcome shares, so the three builders below cannot disagree about them. */
interface OutcomeBase {
  readonly check: CheckOutcome["check"];
  readonly category: CheckOutcome["category"];
  readonly severity: CheckSeverity;
}

/**
 * A skip, with the reason and a sentence saying what stopped it.
 *
 * "Skipped" alone is the least useful word in a report, so the sentence names the thing that caused it — a check for
 * one reason, a missing evidence group for the other. `subject` is what makes that one builder rather than two.
 */
function skipped(
  base: OutcomeBase,
  reason: (typeof CheckSkipReason)[keyof typeof CheckSkipReason],
  subject: string,
): CheckOutcome {
  return {
    ...base,
    status: CheckStatus.Skipped,
    reason,
    explanation:
      reason === CheckSkipReason.PreconditionFailed
        ? `Not run, because ${subject} did not pass.`
        : `Not run, because ${subject} evidence was not gathered.`,
  };
}

/**
 * Maps a verdict to an outcome.
 *
 * The one place severity meets status, and it is a two-line rule: a `pass` is a pass; a `warn` is advice; a `fail` is
 * fatal when the check's declared severity is `error` and advisory otherwise.
 *
 * The last clause is unreachable by design — the catalogue test holds every advisory check to never returning `fail` —
 * and it is kept rather than asserted away because the alternative is trusting that invariant at every call site
 * instead of in one function. If it ever fires, the report says "warned", which is the conservative reading: a report
 * that under-claims a failure is recoverable, and one that refuses a run it should have allowed is not.
 */
function conclude(base: OutcomeBase, verdict: CheckVerdict): CheckOutcome {
  if (verdict.verdict === "pass") {
    return { ...base, status: CheckStatus.Passed };
  }

  if (verdict.verdict === "warn") {
    return { ...base, status: CheckStatus.Warned, finding: verdict.finding };
  }

  return {
    ...base,
    status: base.severity === "error" ? CheckStatus.Failed : CheckStatus.Warned,
    finding: verdict.finding,
  };
}
