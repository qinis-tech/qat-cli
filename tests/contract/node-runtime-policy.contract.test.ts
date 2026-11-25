/**
 * Contract tests for the Node.js support policy.
 *
 * A contract test binds two artefacts that are maintained separately and must agree. Here there are three:
 *
 *   1. `package.json#engines.node` — what this build declares it supports.
 *   2. `core/compatibility` — what reads that declaration and decides membership.
 *   3. `diagnostics/checks` — what reports the decision, and the guidance table that says how much it weighs.
 *
 * None of them can check the other two on its own. The parser cannot know whether the shipped declaration is sane; the
 * checks cannot know whether the range they quoted came from the manifest; the guidance table cannot know that it
 * describes the same code the rule emits. This file is where those three are held against each other.
 *
 * ## Why the boundaries are derived rather than listed
 *
 * The suite computes the lowest version the declaration names and tests it with its neighbour below, instead of
 * hardcoding `>=24.0.0`. A literal here would be the second copy of the policy that the whole design exists to prevent —
 * and it would silently stop testing anything the day the declaration moved.
 *
 * ## What this file is not
 *
 * It is not the environment check. It says nothing about the interpreter running the suite; that claim belongs to CI,
 * where the runtime is chosen deliberately. This file asserts that the *declaration* is sound, which is true on every
 * machine.
 */
import { describe, expect, it } from "vitest";

import {
  CheckId,
  CheckSeverity,
  CheckStatus,
  HealthCode,
  isBlocked,
  outcomeOf,
} from "~/core/application/checks.js";
import { DiagnosticSeverity } from "~/core/application/diagnostics.js";
import {
  QAT_REQUIREMENT_ORIGIN,
  compareNodeVersions,
  evaluateRequirement,
  formatNodeVersion,
  parseNodeVersion,
  parseRange,
  qatRuntimeRequirement,
  type NodeVersion,
} from "~/core/compatibility/index.js";
import {
  CHECKS,
  HEALTH_GUIDANCE,
  runChecks,
  type CheckFacts,
  type RuntimeRequirementFact,
} from "~/diagnostics/checks/index.js";
import {
  frameworkRuntimeCheck,
  nodeRuntimeCheck,
} from "~/diagnostics/checks/rules/node-runtime.js";
import { readOwnManifest } from "~/shared/utils/package-manifest.js";

/* -------------------------------------------------------------------------- */
/* The declaration, as the shipped code reads it                              */
/* -------------------------------------------------------------------------- */

const requirement = qatRuntimeRequirement(readOwnManifest());

/**
 * The lowest complete version the declared range names.
 *
 * Any sane declaration has one: a range with no lower bound is a policy that claims support for versions nobody has
 * ever run, and this helper throwing on one is the first thing that would say so.
 */
function lowestDeclaredVersion(range: string): NodeVersion {
  const named = (range.match(/\d+\.\d+\.\d+/gu) ?? [])
    .map((token) => parseNodeVersion(token))
    .filter((version): version is NodeVersion => version !== undefined);

  if (named.length === 0) {
    throw new Error(
      `The declared range names no complete version, so its boundaries cannot be verified: ${JSON.stringify(range)}`,
    );
  }

  return named.reduce((lowest, candidate) =>
    compareNodeVersions(candidate, lowest) < 0 ? candidate : lowest,
  );
}

const floor = lowestDeclaredVersion(requirement.range);
const floorText = formatNodeVersion(floor);

/**
 * One major below the declared floor, at the top of its own range.
 *
 * `.999.999` rather than `.0.0`: the neighbour that matters is the last version of the excluded major, not the first.
 */
const belowFloorText =
  floor.major > 0 ? `${String(floor.major - 1)}.999.999` : "0.0.0";

/** Builds the evidence the checks read, using the declaration this build ships. */
function factsFor(
  nodeVersion: string | undefined,
  frameworkRequired?: RuntimeRequirementFact,
): CheckFacts {
  return {
    runtime: {
      ...(nodeVersion === undefined ? {} : { nodeVersion }),
      required: { range: requirement.range, origin: requirement.origin },
      ...(frameworkRequired === undefined ? {} : { frameworkRequired }),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The declaration                                                            */
/* -------------------------------------------------------------------------- */

describe("the declared support range", () => {
  it("is present, and the shipped parser can read it", () => {
    // A missing declaration is reported at runtime as an indeterminate warning — correct for a user, useless as a
    // release gate. An unreadable one is the same, for the same reason. This is the gate.
    expect(requirement.range).not.toBe("");
    expect(parseRange(requirement.range).ok).toBe(true);
  });

  it("is carried verbatim, with the provenance a reader can open", () => {
    // Verbatim, because a normalised copy would be a second rendering of the policy — the kind that disagrees with the
    // declaration the day someone writes the range differently but equivalently.
    expect(requirement.range).toBe(readOwnManifest()?.engines?.node?.trim());
    expect(requirement.origin).toBe(QAT_REQUIREMENT_ORIGIN);
    expect(requirement.source).toBe("qat");
    expect(requirement.severityWhenUnsatisfied).toBe("error");
  });

  it("admits the lowest version it names", () => {
    // If this fails the policy is *inverted* — it refuses the very version it is written around — which no amount of
    // unit testing would reveal, because the unit tests use their own fixtures.
    expect(evaluateRequirement(requirement, floorText).status).toBe(
      "satisfied",
    );
  });

  it("refuses the major below the one it names", () => {
    // If this fails the policy is *vacuous*: it claims a floor and admits everything, so the check can never block and
    // the guarantee it exists for is decorative.
    expect(evaluateRequirement(requirement, belowFloorText).status).toBe(
      "unsatisfied",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The declaration and the checks that report on it                           */
/* -------------------------------------------------------------------------- */

describe("the report agrees with the declaration", () => {
  it("passes, and blocks nothing, on the declared floor", () => {
    const report = runChecks(factsFor(floorText));

    expect(outcomeOf(report, CheckId.NodeVersion)?.status).toBe(
      CheckStatus.Passed,
    );
    expect(isBlocked(report)).toBe(false);
    expect(CHECKS.length).toBeGreaterThan(0);
  });

  it("fails exactly one check, one major below", () => {
    // Exactly one: an unsupported runtime must not also produce consequences in the checks that depend on the project.
    const report = runChecks(factsFor(belowFloorText));

    expect(isBlocked(report)).toBe(true);
    expect(outcomeOf(report, CheckId.NodeVersion)).toMatchObject({
      status: CheckStatus.Failed,
      finding: { code: HealthCode.RuntimeUnsupported },
    });
    expect(
      report.outcomes.filter(
        (outcome) => outcome.status === CheckStatus.Failed,
      ),
    ).toHaveLength(1);
  });

  it("quotes the declared range in the finding", () => {
    // The passthrough made contractual: the sentence a user reads contains the string the manifest contains. If a copy
    // of the range ever appears between the two, this is where it shows.
    const outcome = outcomeOf(
      runChecks(factsFor(belowFloorText)),
      CheckId.NodeVersion,
    );

    expect(outcome).toMatchObject({
      finding: {
        explanation: expect.stringContaining(requirement.range) as string,
      },
    });
  });

  it("warns, and does not block, when the host reports nothing", () => {
    // The safety property at the boundary of the chain: a question that could not be answered is visible, is not a
    // pass, and does not refuse a run.
    const report = runChecks(factsFor(undefined));

    expect(outcomeOf(report, CheckId.NodeVersion)).toMatchObject({
      status: CheckStatus.Warned,
      finding: { code: HealthCode.RuntimeUnknown },
    });
    expect(isBlocked(report)).toBe(false);
  });

  it("reports a framework bound on its own check, without touching QAT's verdict", () => {
    // A project declaring a higher floor than QAT's must not be reported as QAT being unsupported — and must not block.
    const report = runChecks(
      factsFor(floorText, {
        range: `>=${String(floor.major + 5)}.0.0`,
        origin: "framework",
      }),
    );

    expect(outcomeOf(report, CheckId.NodeVersion)?.status).toBe(
      CheckStatus.Passed,
    );
    expect(outcomeOf(report, CheckId.CypressRuntimeSupported)).toMatchObject({
      status: CheckStatus.Warned,
      finding: { code: HealthCode.FrameworkRuntimeUnsupported },
    });
    expect(isBlocked(report)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Weights: the catalogue and the guidance table                              */
/* -------------------------------------------------------------------------- */

describe("the declared weights agree with the guidance table", () => {
  it("gives the blocking mismatch the same weight in both places", () => {
    // `CheckSeverity.Failed` is reserved for error-severity checks. If the catalogue said `error` and the guidance said
    // `warning`, the finding a reader sees would claim a weight the verdict does not act on — and vice versa.
    expect(nodeRuntimeCheck.severity).toBe(
      HEALTH_GUIDANCE[HealthCode.RuntimeUnsupported].severity,
    );
    expect(nodeRuntimeCheck.severity).toBe(CheckSeverity.Error);
  });

  it("keeps the advisory at warning weight in both places", () => {
    expect(frameworkRuntimeCheck.severity).toBe(
      HEALTH_GUIDANCE[HealthCode.FrameworkRuntimeUnsupported].severity,
    );
    expect(frameworkRuntimeCheck.severity).toBe(CheckSeverity.Warning);
  });

  it("renders the could-not-check condition as advice, not as a verdict", () => {
    // `QAT-H008` is produced by a `warn` verdict from an error-severity check, which is the only combination the runner
    // permits for "I could not answer". An error weight here would describe a failure nothing blocks on.
    expect(HEALTH_GUIDANCE[HealthCode.RuntimeUnknown].severity).toBe(
      DiagnosticSeverity.Warning,
    );
  });
});
