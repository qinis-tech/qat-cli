/**
 * Unit tests for the Cypress health assessment.
 *
 * This is the decision point: one immutable snapshot in, three condition results out. It is pure, so every case is a
 * literal evidence object and an assertion about the decision — no fixture project, no filesystem, no process. That is
 * the whole reason the assessment was separated from gathering: the boundary between "supported" and "unsupported", and
 * between "skipped" and "failed", can be driven directly here with values that would be awkward or impossible to
 * reproduce on a real disk.
 *
 * The compatibility engine is injected rather than real, so the tests describe *what the assessment does with each
 * verdict* instead of re-testing the semver engine's arithmetic.
 */

import { describe, expect, it } from "vitest";

import type {
  CypressBinaryEvidence,
  CypressResolution,
} from "~/project/cypress-health/contracts.js";
import type {
  CompatibilityEvaluator,
  CypressCompatibilityPolicy,
  CypressConditionResult,
  CypressHealthEvidence,
} from "~/project/cypress-health/index.js";
import {
  assessCypressHealth,
  defaultCompatibilityEvaluator,
  overallCypressStatus,
} from "~/project/cypress-health/index.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PROJECT_ROOT = "/work/project";
const PACKAGE_DIR = `${PROJECT_ROOT}/node_modules/cypress`;

const COMPATIBILITY: CypressCompatibilityPolicy = {
  supportedRange: ">=12.0.0 <14",
  origin: "adapters/cypress#compatibility",
};

const RESOLVED: CypressResolution = {
  outcome: "resolved",
  packageDirectory: PACKAGE_DIR,
  version: "13.6.0",
  failure: null,
};

const ACCESSIBLE_BINARY: CypressBinaryEvidence = {
  version: "13.6.0",
  cacheRoot: "~/.cache/Cypress",
  expectedPath: "~/.cache/Cypress/13.6.0/Cypress/Cypress",
  state: "accessible",
  verifiedBy: "static-cache-inspection",
  probeDetail: null,
};

/** A resolution that failed, spelled out once so the tables below stay readable. */
function notInstalled(
  failure: CypressResolution["failure"],
): CypressResolution {
  return {
    outcome: "not-installed",
    packageDirectory: null,
    version: null,
    failure,
  };
}

/**
 * The three resolution failures and the reason each must produce.
 *
 * Declared here, at module scope, because two `describe` blocks read it — a table inside one callback is invisible to
 * the next, which is how this list came to be referenced before it existed.
 *
 * A mutable tuple array rather than a `readonly` one: `it.each` needs to resolve its tuple overload, and a readonly
 * array of readonly tuples containing a nullable union makes it give up and fall back to `any[]`. The cases are consumed
 * by an explicit loop below, so this type also never has to survive a generic inference.
 */
const RESOLUTION_FAILURES: [CypressResolution["failure"], string][] = [
  ["not-resolvable", "CYPRESS_DECLARED_NOT_INSTALLED"],
  ["rejected-outside-project", "CYPRESS_RESOLUTION_REJECTED_OUTSIDE_PROJECT"],
  ["unreadable-package-manifest", "CYPRESS_MANIFEST_UNREADABLE"],
];

/** A healthy snapshot: everything true unless a test overrides one fact. */
function snapshot(
  overrides: Partial<CypressHealthEvidence> = {},
): CypressHealthEvidence {
  return {
    projectRoot: PROJECT_ROOT,
    declaration: { declared: true, range: "^13.6.0", field: "devDependencies" },
    resolution: RESOLVED,
    binary: ACCESSIBLE_BINARY,
    compatibility: COMPATIBILITY,
    observedAt: "2025-01-14T09:22:41.117Z",
    ...overrides,
  };
}

const satisfied: CompatibilityEvaluator = () => ({
  status: "satisfied",
  reason: "within-range",
});

function unsatisfiedBecause(reason: string): CompatibilityEvaluator {
  return () => ({ status: "unsatisfied", reason });
}

function indeterminateBecause(reason: string): CompatibilityEvaluator {
  return () => ({ status: "indeterminate", reason });
}

/** Assesses with a satisfied engine by default, so only the fact under test varies. */
function assess(
  overrides: Partial<CypressHealthEvidence> = {},
  evaluateCompatibility: CompatibilityEvaluator = satisfied,
): readonly CypressConditionResult[] {
  return assessCypressHealth(snapshot(overrides), { evaluateCompatibility });
}

function resultFor(
  results: readonly CypressConditionResult[],
  checkId: CypressConditionResult["checkId"],
): CypressConditionResult {
  const found = results.find((candidate) => candidate.checkId === checkId);

  if (found === undefined) throw new Error(`No result for ${checkId}`);

  return found;
}

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

describe("assessCypressHealth — shape", () => {
  it("always returns exactly three results, in dependency order", () => {
    // The fixed set is what lets a consumer print "skipped because DEP-003 failed" instead of leaving a gap the reader
    // has to notice.
    expect(assess().map((result) => result.checkId)).toStrictEqual([
      "DEP-003",
      "DEP-004",
      "DEP-008",
    ]);
  });

  it("returns a frozen list of frozen results", () => {
    const results = assess();

    expect(Object.isFrozen(results)).toBe(true);
    expect(results.every((result) => Object.isFrozen(result))).toBe(true);
    expect(results.every((result) => Object.isFrozen(result.evidence))).toBe(
      true,
    );
  });

  it("reports a fully healthy snapshot as three passes", () => {
    const results = assess();

    expect(results.map((result) => result.status)).toStrictEqual([
      "pass",
      "pass",
      "pass",
    ]);
    expect(results.map((result) => result.reason)).toStrictEqual([
      "CYPRESS_OK",
      "CYPRESS_OK",
      "CYPRESS_OK",
    ]);
    expect(results.map((result) => result.severity)).toStrictEqual([
      "information",
      "information",
      "information",
    ]);
    expect(results.every((result) => result.prerequisite === null)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* DEP-003 — declaration and installation                                     */
/* -------------------------------------------------------------------------- */

describe("DEP-003 — declaration and installation", () => {
  it("passes when Cypress is declared and resolves from the project", () => {
    const result = resultFor(assess(), "DEP-003");

    expect(result.status).toBe("pass");
    expect(result.condition).toBe("installed");
    expect(result.reason).toBe("CYPRESS_OK");
    expect(result.evidence).toMatchObject({
      declared: true,
      declaredIn: "devDependencies",
      declaredSpecifier: "^13.6.0",
      installedVersion: "13.6.0",
    });
  });

  it("fails with an error when nothing declares Cypress", () => {
    const result = resultFor(
      assess({
        declaration: { declared: false },
        resolution: notInstalled("not-resolvable"),
      }),
      "DEP-003",
    );

    expect(result.status).toBe("fail");
    expect(result.condition).toBe("declared");
    expect(result.reason).toBe("CYPRESS_NOT_DECLARED");
    expect(result.severity).toBe("error");
    expect(result.evidence).toMatchObject({
      declared: false,
      declaredIn: null,
    });
  });

  it("warns — not fails — when Cypress is installed but undeclared", () => {
    // A ghost install: the project runs today and will not reproduce on a clean checkout. Blocking on it would stop work
    // over a problem that has not happened yet.
    const result = resultFor(
      assess({ declaration: { declared: false }, resolution: RESOLVED }),
      "DEP-003",
    );

    expect(result.status).toBe("fail");
    expect(result.reason).toBe("CYPRESS_INSTALLED_BUT_UNDECLARED");
    expect(result.severity).toBe("warning");
    expect(result.evidence).toMatchObject({ installedVersion: "13.6.0" });
  });

  for (const [failure, reason] of RESOLUTION_FAILURES) {
    it(`reports ${String(failure)} as ${reason}`, () => {
      // Three failures, three fixes: run the install, fix the resolver, or reinstall a damaged package. Collapsing them
      // into "Cypress missing" is how wrong remediation reaches users.
      const result = resultFor(
        assess({ resolution: notInstalled(failure) }),
        "DEP-003",
      );

      expect(result.status).toBe("fail");
      expect(result.reason).toBe(reason);
      expect(result.severity).toBe("error");
    });
  }

  it('treats a missing failure reason as "declared but not installed"', () => {
    // Defensive: an outcome of `not-installed` with no reason cannot say more than that, and guessing a worse failure
    // would invent an observation.
    const result = resultFor(
      assess({ resolution: notInstalled(null) }),
      "DEP-003",
    );

    expect(result.reason).toBe("CYPRESS_DECLARED_NOT_INSTALLED");
  });
});

/* -------------------------------------------------------------------------- */
/* DEP-004 — version identified and compatible                                */
/* -------------------------------------------------------------------------- */

describe("DEP-004 — prerequisite", () => {
  it("is skipped, not failed, when DEP-003 established no installation", () => {
    const result = resultFor(
      assess({
        declaration: { declared: false },
        resolution: notInstalled("not-resolvable"),
      }),
      "DEP-004",
    );

    expect(result.status).toBe("skipped");
    expect(result.severity).toBe("information");
    expect(result.prerequisite).toStrictEqual({
      checkId: "DEP-003",
      reason: "CYPRESS_NOT_DECLARED",
    });
    expect(result.evidence).toMatchObject({
      supported: COMPATIBILITY.supportedRange,
    });
  });

  for (const [failure, reason] of RESOLUTION_FAILURES) {
    it(`names the resolution failure behind the skip (${String(failure)})`, () => {
      const result = resultFor(
        assess({ resolution: notInstalled(failure) }),
        "DEP-004",
      );

      expect(result.status).toBe("skipped");
      expect(result.prerequisite).toStrictEqual({ checkId: "DEP-003", reason });
    });
  }
});

describe("DEP-004 — version identification", () => {
  it("is indeterminate when the package is readable but reports no version", () => {
    const result = resultFor(
      assess({ resolution: { ...RESOLVED, version: null } }),
      "DEP-004",
    );

    expect(result.status).toBe("indeterminate");
    expect(result.condition).toBe("version-identified");
    expect(result.reason).toBe("CYPRESS_VERSION_UNKNOWN");
    expect(result.severity).toBe("warning");
  });

  it("is indeterminate when the engine cannot evaluate the version", () => {
    // A question that could not be answered is never a pass: silence must not read as consent.
    const result = resultFor(
      assess({}, indeterminateBecause("runtime-version-unreadable")),
      "DEP-004",
    );

    expect(result.status).toBe("indeterminate");
    expect(result.reason).toBe("CYPRESS_VERSION_UNKNOWN");
    expect(result.severity).toBe("warning");
    expect(result.evidence).toMatchObject({
      evaluatorReason: "runtime-version-unreadable",
    });
  });
});

describe("DEP-004 — compatibility verdicts", () => {
  it("passes when the version satisfies the range", () => {
    const result = resultFor(assess(), "DEP-004");

    expect(result.status).toBe("pass");
    expect(result.condition).toBe("version-compatible");
    expect(result.reason).toBe("CYPRESS_OK");
    expect(result.evidence).toMatchObject({
      detected: "13.6.0",
      supported: COMPATIBILITY.supportedRange,
      supportedOrigin: COMPATIBILITY.origin,
    });
  });

  it("fails with an error below the minimum", () => {
    const result = resultFor(
      assess(
        { resolution: { ...RESOLVED, version: "11.2.0" } },
        unsatisfiedBecause("below-minimum"),
      ),
      "DEP-004",
    );

    expect(result.status).toBe("fail");
    expect(result.reason).toBe("CYPRESS_VERSION_BELOW_MINIMUM");
    expect(result.severity).toBe("error");
  });

  it("fails with a warning above the tested maximum", () => {
    // Newer is not broken, it is unproven. The split between this and the case above is the entire point of DEP-004.
    const result = resultFor(
      assess(
        { resolution: { ...RESOLVED, version: "14.0.0" } },
        unsatisfiedBecause("above-maximum"),
      ),
      "DEP-004",
    );

    expect(result.status).toBe("fail");
    expect(result.reason).toBe("CYPRESS_VERSION_ABOVE_TESTED_MAXIMUM");
    expect(result.severity).toBe("warning");
  });

  it("fails with a warning for a pre-release", () => {
    const result = resultFor(
      assess(
        { resolution: { ...RESOLVED, version: "14.0.0-rc.1" } },
        unsatisfiedBecause("pre-release-not-listed"),
      ),
      "DEP-004",
    );

    expect(result.status).toBe("fail");
    expect(result.reason).toBe("CYPRESS_VERSION_PRERELEASE");
    expect(result.severity).toBe("warning");
  });

  it('falls back to "version unknown" for a reason it does not recognise', () => {
    // The safe direction: admitting we could not classify the verdict, rather than guessing in the direction that blocks
    // a build.
    const result = resultFor(
      assess({}, unsatisfiedBecause("a-reason-from-a-future-engine")),
      "DEP-004",
    );

    expect(result.status).toBe("fail");
    expect(result.reason).toBe("CYPRESS_VERSION_UNKNOWN");
    expect(result.severity).toBe("warning");
    expect(result.evidence).toMatchObject({
      evaluatorReason: "a-reason-from-a-future-engine",
    });
  });

  it("passes the declared range and the detected version to the engine", () => {
    const calls: { range: string; version: string }[] = [];
    const recording: CompatibilityEvaluator = (input) => {
      calls.push(input);

      return { status: "satisfied", reason: "within-range" };
    };

    assess({}, recording);

    expect(calls).toStrictEqual([
      { range: COMPATIBILITY.supportedRange, version: "13.6.0" },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* DEP-008 — binary installed and accessible                                  */
/* -------------------------------------------------------------------------- */

describe("DEP-008 — prerequisite", () => {
  it("is skipped when DEP-004 did not establish a compatible version", () => {
    // The cache is keyed by version, so an incompatible version changes the path under our feet: a binary finding would
    // be noise about a directory that is about to change.
    const result = resultFor(
      assess({}, unsatisfiedBecause("below-minimum")),
      "DEP-008",
    );

    expect(result.status).toBe("skipped");
    expect(result.severity).toBe("information");
    expect(result.prerequisite).toStrictEqual({
      checkId: "DEP-004",
      reason: "CYPRESS_VERSION_BELOW_MINIMUM",
    });
  });

  it('names "version unknown" when the engine could not decide', () => {
    const result = resultFor(
      assess({}, indeterminateBecause("no-evaluator-configured")),
      "DEP-008",
    );

    expect(result.status).toBe("skipped");
    expect(result.prerequisite).toStrictEqual({
      checkId: "DEP-004",
      reason: "CYPRESS_VERSION_UNKNOWN",
    });
  });

  it("records which dependency check blocked it", () => {
    // Two findings, one problem: the reader should be able to see the chain without correlating by hand.
    const results = assess({
      declaration: { declared: false },
      resolution: notInstalled("not-resolvable"),
    });

    expect(resultFor(results, "DEP-008").evidence).toMatchObject({
      blockedBy: "DEP-003",
    });
  });
});

describe("DEP-008 — binary states", () => {
  it("reports nothing gathered as unknown, not as a missing binary", () => {
    const result = resultFor(assess({ binary: null }), "DEP-008");

    expect(result.status).toBe("indeterminate");
    expect(result.reason).toBe("CYPRESS_BINARY_UNKNOWN");
    expect(result.severity).toBe("warning");
  });

  it("passes for an accessible binary", () => {
    const result = resultFor(assess(), "DEP-008");

    expect(result.status).toBe("pass");
    expect(result.reason).toBe("CYPRESS_OK");
    expect(result.evidence).toMatchObject({
      detected: "13.6.0",
      verifiedBy: "static-cache-inspection",
    });
  });

  it("fails with an error when no binary is installed", () => {
    const result = resultFor(
      assess({ binary: { ...ACCESSIBLE_BINARY, state: "absent" } }),
      "DEP-008",
    );

    expect(result.status).toBe("fail");
    expect(result.condition).toBe("binary-installed");
    expect(result.reason).toBe("CYPRESS_BINARY_NOT_INSTALLED");
    expect(result.severity).toBe("error");
  });

  it("fails with an error when the binary cannot be executed", () => {
    const result = resultFor(
      assess({ binary: { ...ACCESSIBLE_BINARY, state: "not-executable" } }),
      "DEP-008",
    );

    expect(result.status).toBe("fail");
    expect(result.condition).toBe("binary-accessible");
    expect(result.reason).toBe("CYPRESS_BINARY_INACCESSIBLE");
    expect(result.severity).toBe("error");
  });

  it("is indeterminate when nothing could be observed about the binary", () => {
    const result = resultFor(
      assess({ binary: { ...ACCESSIBLE_BINARY, state: "unknown" } }),
      "DEP-008",
    );

    expect(result.status).toBe("indeterminate");
    expect(result.reason).toBe("CYPRESS_BINARY_UNKNOWN");
    expect(result.severity).toBe("warning");
  });

  it("is indeterminate — never a pass — when a probe could not conclude", () => {
    const result = resultFor(
      assess({
        binary: {
          ...ACCESSIBLE_BINARY,
          verifiedBy: "cypress-verify",
          probeDetail: "verification did not finish within 30000 ms",
        },
      }),
      "DEP-008",
    );

    expect(result.status).toBe("indeterminate");
    expect(result.reason).toBe("CYPRESS_BINARY_UNVERIFIED");
    expect(result.severity).toBe("warning");
    expect(result.evidence).toMatchObject({
      probeDetail: "verification did not finish within 30000 ms",
    });
  });

  it("reports a verified binary as accessible", () => {
    const result = resultFor(
      assess({
        binary: { ...ACCESSIBLE_BINARY, verifiedBy: "cypress-verify" },
      }),
      "DEP-008",
    );

    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({ verifiedBy: "cypress-verify" });
  });
});

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

describe("overallCypressStatus", () => {
  function synthetic(
    status: CypressConditionResult["status"],
  ): CypressConditionResult {
    return {
      checkId: "DEP-003",
      condition: "declared",
      status,
      severity: "warning",
      reason: "CYPRESS_OK",
      prerequisite: null,
      evidence: {},
    };
  }

  const summaries: [CypressConditionResult["status"][], string][] = [
    [["pass", "pass", "pass"], "pass"],
    [["pass", "fail", "skipped"], "fail"],
    [["pass", "pass", "skipped"], "skipped"],
    [["pass", "indeterminate", "pass"], "indeterminate"],
    [["indeterminate", "skipped", "fail"], "fail"],
    [[], "indeterminate"],
  ];

  for (const [statuses, expected] of summaries) {
    it(`summarises [${statuses.join(", ")}] as ${expected}`, () => {
      // Synthetic results, because the real assessment cannot produce "a skip with no failure" — DEP-003 must fail
      // first. A skip is still not health, which is why it outranks a pass rather than disappearing into it.
      expect(overallCypressStatus(statuses.map(synthetic))).toBe(expected);
    });
  }

  it("reports a healthy assessment as a pass", () => {
    expect(overallCypressStatus(assess())).toBe("pass");
  });

  it("reports an incomplete installation as a failure rather than a skip", () => {
    const results = assess({
      declaration: { declared: false },
      resolution: notInstalled("not-resolvable"),
    });

    expect(overallCypressStatus(results)).toBe("fail");
  });
});

/* -------------------------------------------------------------------------- */
/* Default evaluator                                                          */
/* -------------------------------------------------------------------------- */

describe("defaultCompatibilityEvaluator", () => {
  it("never claims support it cannot establish", () => {
    // Used only when no engine is injected. Answering "fine" here would be the one failure that hides a broken build.
    expect(
      defaultCompatibilityEvaluator({
        range: ">=12.0.0 <14",
        version: "13.6.0",
      }).status,
    ).toBe("indeterminate");
  });

  it("distinguishes an unparseable version from an absent engine", () => {
    expect(
      defaultCompatibilityEvaluator({ range: "*", version: "not-a-version" })
        .reason,
    ).toBe("version-not-parseable");
    expect(
      defaultCompatibilityEvaluator({ range: "*", version: "13.6.0" }).reason,
    ).toBe("no-evaluator-configured");
  });

  it("makes the assessment indeterminate when used by default", () => {
    const results = assessCypressHealth(snapshot());

    expect(resultFor(results, "DEP-004").status).toBe("indeterminate");
    expect(resultFor(results, "DEP-008").status).toBe("skipped");
  });
});

/* -------------------------------------------------------------------------- */
/* Purity                                                                     */
/* -------------------------------------------------------------------------- */

describe("assessCypressHealth — purity", () => {
  it("produces identical results for identical evidence", () => {
    const evidence = snapshot();

    expect(
      assessCypressHealth(evidence, { evaluateCompatibility: satisfied }),
    ).toStrictEqual(
      assessCypressHealth(evidence, { evaluateCompatibility: satisfied }),
    );
  });

  it("does not mutate the evidence it was given", () => {
    const evidence = snapshot();
    const copy = structuredClone(evidence);

    assessCypressHealth(evidence, { evaluateCompatibility: satisfied });

    expect(evidence).toStrictEqual(copy);
  });

  it("carries the resolved directory internally, for provenance", () => {
    // Internal evidence is not published evidence: the finding layer strips absolute paths through its own allowlist,
    // which is asserted where that allowlist lives. Documenting the seam here stops someone "tidying" it away.
    const result = resultFor(assess(), "DEP-003");

    expect(result.evidence).toMatchObject({ packageDirectory: PACKAGE_DIR });
  });
});
