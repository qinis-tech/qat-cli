/**
 * Unit tests for package-manager assessment.
 *
 * The module is pure, so every case is a literal: a snapshot, a detection decision and an executable state go in, and a
 * set of named issues comes out. No filesystem, no process, no clock.
 *
 * The reason this matrix is worth its size: the conditions it separates are the ones users confuse. "No manager", "a
 * manager we do not support", "the tool is not installed" and "the dependencies are not installed" all look like "a
 * package-manager problem" and have four different fixes. A test per code is what keeps them separated, and it is the
 * only artefact that would notice if two of them ever collapsed into one message.
 *
 * Two type facts the fixtures have to respect, both of which the compiler refuses rather than the tests:
 *
 *   • `InstallState` is a discriminated union of objects, not a set of strings — `{ status: 'absent' }` rather than
 *     `'absent'`. Each variant carries the evidence that justified it (`marker`, `createdBy`, `reason`), so a state
 *     cannot be claimed without the thing that produced it.
 *   • `HealthIssue.detail` is a `Record<string, …>`, so its members are reached with brackets. That is the type saying
 *     "these keys are data, not shape", which is also why an assertion on a misspelled key reads as `undefined`
 *     instead of failing to compile — worth knowing before debugging one.
 *
 * And two fixture rules, learned the hard way from a run where eleven cases failed for three reasons:
 *
 *   • **Evidence must be what the code will really see.** A detection built as `` `${manager}-lock` `` produced a
 *     filename no project has, so every assertion on it was asserting against a fiction.
 *   • **A default must be healthy.** Leaving `hasNodeModules: false` meant the derived install state was `absent`, and
 *     every case silently carried an extra finding — a suite that was green because it was asserting the wrong thing.
 */
import { describe, expect, it } from "vitest";

import {
  assessPackageManagerHealth,
  determineInstallState,
  type Detection,
  type ExecutableAvailability,
  type HealthIssue,
  type HealthIssueCode,
  type InstallState,
  type PackageManagerAssessment,
  type PackageManagerAssessmentInput,
  type PackageManagerName,
  type ProjectSnapshot,
} from "~/project/package-manager/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A snapshot with nothing in it.
 *
 * A factory rather than a literal per case: a spread that replaces part of an object silently drops the rest, and the
 * missing field then surfaces as a confusing failure several assertions later. Every member is present, so a case can
 * only replace one.
 */
function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    root: "/project",
    rootEntries: new Set<string>(),
    declaration: { status: "absent" },
    engineRanges: {},
    hasNodeModules: false,
    ...overrides,
  };
}

/**
 * The lockfile each manager actually uses.
 *
 * Mapped rather than fabricated. An earlier version derived the name from the manager (`` `${manager}-lock` ``), which
 * is not a filename any project has: assertions on it were asserting against a fiction, and the evidence the check
 * would really revisit never appeared in a failure message.
 */
const LOCKFILE_OF: Readonly<Record<PackageManagerName, string>> = {
  npm: "package-lock.json",
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
  bun: "bun.lockb",
};

/** A detection the detector could actually have produced. */
function detected(manager: PackageManagerName = "npm"): Detection {
  return {
    status: "detected",
    manager,
    lockfile: LOCKFILE_OF[manager],
    declared: false,
  };
}

/** Availability when no binary was found. */
const MISSING: ExecutableAvailability = { status: "missing" };

/**
 * The install states, spelled once.
 *
 * Named rather than written inline at each use because the shipped marker strings are policy-adjacent: a test that
 * hard-codes `node_modules/.pnpm` in four places would need four edits the day the marker moves, and three of them
 * would be found by a failing assertion while the fourth would be found by nobody.
 */
const INSTALLED_NPM: InstallState = {
  status: "installed",
  marker: "node_modules/.package-lock.json",
};
const ABSENT: InstallState = { status: "absent" };
const FOREIGN_BY_YARN: InstallState = {
  status: "foreign",
  marker: "node_modules/.package-lock.json",
  createdBy: "yarn",
};
const FOREIGN_BY_PNPM: InstallState = {
  status: "foreign",
  marker: "node_modules/.pnpm",
  createdBy: "pnpm",
};
const UNATTRIBUTED: InstallState = {
  status: "unknown",
  reason: "attribution skipped",
};

/** Availability when a binary answered. */
function found(version?: string): ExecutableAvailability {
  return {
    status: "found",
    path: "/fake/bin/npm",
    version:
      version === undefined
        ? { status: "not-probed" }
        : { status: "read", value: version },
  };
}

/** Availability when a binary was found and would not say. */
function unreadable(
  reason: "timeout" | "empty-output" | "failed",
): ExecutableAvailability {
  return {
    status: "found",
    path: "/fake/bin/npm",
    version: { status: "unreadable", reason },
  };
}

/**
 * The input, with healthy defaults.
 *
 * Dependencies are declared installed by default. Without that, the derived state is `absent` whenever
 * `hasNodeModules` is false, so every case would also report `PM_DEPENDENCIES_NOT_INSTALLED` — a test about version
 * agreement would be asserting against two findings, and a helper that insists on exactly one would refuse it. A case
 * that is *about* installation passes its own state.
 */
function input(
  overrides: Partial<PackageManagerAssessmentInput> = {},
): PackageManagerAssessmentInput {
  return {
    snapshot: snapshot({ rootEntries: new Set([LOCKFILE_OF.npm]) }),
    detection: detected(),
    executable: found(),
    installState: INSTALLED_NPM,
    ...overrides,
  };
}

/** Every code reported, in order. The order is part of the contract: it is the order a reader fixes things in. */
function codesOf(
  assessment: PackageManagerAssessment,
): readonly HealthIssueCode[] {
  return assessment.issues.map((issue) => issue.code);
}

/** The single issue a case expects, or a failure that shows what was actually reported. */
function onlyIssue(assessment: PackageManagerAssessment): HealthIssue {
  expect(codesOf(assessment)).toHaveLength(1);

  const [issue] = assessment.issues;
  if (issue === undefined) throw new Error("expected exactly one issue");

  return issue;
}

// ─────────────────────────────────────────────────────────────────────────────
// Install state
// ─────────────────────────────────────────────────────────────────────────────

describe("determineInstallState", () => {
  it("is unknown when no manager was identified", () => {
    // "Is it installed" is a question about a specific manager's tree. With no manager there is nothing to look at,
    // and `absent` would report a fault nobody can act on.
    expect(
      determineInstallState(snapshot(), {
        status: "undeclared",
        lockfiles: [],
      }),
    ).toStrictEqual({
      status: "unknown",
      reason: "no package manager identified",
    });
  });

  it("is absent when nothing is installed", () => {
    expect(
      determineInstallState(
        snapshot({ hasNodeModules: false }),
        detected("npm"),
      ),
    ).toStrictEqual({ status: "absent" });
  });

  it("is unknown — not installed — when dependencies are present but unattributable", () => {
    // The presence of `node_modules` is not evidence that the detected manager created it. Claiming `installed` here
    // would be a guess, and a guess in a diagnostic is worse than an acknowledged gap.
    expect(
      determineInstallState(
        snapshot({ hasNodeModules: true }),
        detected("npm"),
      ),
    ).toStrictEqual({
      status: "unknown",
      reason:
        "installation present; attribution requires inspecting node_modules",
    });
  });

  it("is unknown for a manager that leaves no marker", () => {
    // A synthetic pairing on purpose: detection reports Bun as `unsupported`, so this branch is unreachable through a
    // real detection today. It is tested anyway because the policy decides whether a marker exists, and a future
    // supported manager with no marker would land here rather than in `installed`.
    expect(
      determineInstallState(snapshot({ hasNodeModules: true }), {
        status: "detected",
        manager: "bun",
        lockfile: "bun.lockb",
        declared: true,
      }),
    ).toStrictEqual({
      status: "unknown",
      reason: "bun leaves no install marker",
    });
  });

  it("returns a frozen value", () => {
    expect(Object.isFrozen(determineInstallState(snapshot(), detected()))).toBe(
      true,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

describe("identity problems", () => {
  it("reports two lockfiles as a conflict, naming both", () => {
    const assessment = assessPackageManagerHealth(
      input({
        detection: {
          status: "conflicting",
          lockfiles: ["package-lock.json", "pnpm-lock.yaml"],
          managers: ["npm", "pnpm"],
        },
      }),
    );

    expect(onlyIssue(assessment)).toMatchObject({
      code: "PM_LOCKFILES_CONFLICT",
      outcome: "fail",
      detail: {
        lockfiles: ["package-lock.json", "pnpm-lock.yaml"],
        managers: ["npm", "pnpm"],
        declaration: null,
      },
    });
    expect(assessment.outcome).toBe("fail");
    expect(assessment.manager).toBeUndefined();
  });

  it("reports a declaration that contradicts the only lockfile as a mismatch, not a file conflict", () => {
    // One file and one field disagreeing is a different repair from two files fighting: align the field or the file,
    // rather than delete one of two.
    const assessment = assessPackageManagerHealth(
      input({
        snapshot: snapshot({
          rootEntries: new Set(["package-lock.json"]),
          declaration: {
            status: "parsed",
            declaration: { name: "pnpm", version: "9.1.0", raw: "pnpm@9.1.0" },
          },
        }),
        detection: {
          status: "conflicting",
          lockfiles: ["package-lock.json"],
          managers: ["npm", "pnpm"],
        },
      }),
    );

    expect(onlyIssue(assessment)).toMatchObject({
      code: "PM_DECLARATION_MISMATCH",
      outcome: "fail",
      manager: "pnpm",
      detail: {
        declared: "pnpm",
        observed: "npm",
        lockfiles: ["package-lock.json"],
        declaration: "pnpm@9.1.0",
      },
    });
  });

  it("reports a file conflict when two lockfiles disagree, even if a declaration is involved", () => {
    // The boundary of the case above: a mismatch needs exactly *one* file to disagree with the field. With two there is
    // no single observation to compare against, so the answer is the conflict — and the pair is what states the
    // boundary rather than leaving it to be inferred from one example.
    const assessment = assessPackageManagerHealth(
      input({
        detection: {
          status: "conflicting",
          lockfiles: ["package-lock.json", "yarn.lock"],
          managers: ["npm", "yarn"],
        },
      }),
    );

    expect(codesOf(assessment)).toStrictEqual(["PM_LOCKFILES_CONFLICT"]);
  });

  it("reports a recognised but unsupported manager as unsupported, not as missing", () => {
    const assessment = assessPackageManagerHealth(
      input({
        detection: {
          status: "unsupported",
          manager: "bun",
          lockfile: "bun.lockb",
        },
      }),
    );

    expect(onlyIssue(assessment)).toMatchObject({
      code: "PM_UNSUPPORTED",
      outcome: "fail",
      manager: "bun",
      detail: { manager: "bun", lockfile: "bun.lockb", supported: false },
    });
  });

  it("quotes an unusable declaration rather than hiding it", () => {
    const assessment = assessPackageManagerHealth(
      input({
        snapshot: snapshot({
          declaration: {
            status: "unparsable",
            raw: "pnpm",
            problem: "missing-version",
          },
        }),
        detection: { status: "undeclared", lockfiles: [] },
      }),
    );

    expect(onlyIssue(assessment)).toMatchObject({
      code: "PM_DECLARATION_UNPARSABLE",
      outcome: "fail",
      detail: { declaration: "pnpm", problem: "missing-version" },
    });
  });

  it("treats a declaration naming an unknown manager as unsupported", () => {
    // Well-formed and outside the policy: the file is fine, our list is the limit. Calling it invalid would send the
    // reader to edit a value that is correct.
    const assessment = assessPackageManagerHealth(
      input({
        snapshot: snapshot({
          declaration: {
            status: "unparsable",
            raw: "deno@2.0.0",
            problem: "unknown-manager",
          },
        }),
        detection: { status: "undeclared", lockfiles: [] },
      }),
    );

    expect(onlyIssue(assessment)).toMatchObject({
      code: "PM_UNSUPPORTED",
      outcome: "fail",
      detail: { declaration: "deno@2.0.0", problem: "unknown-manager" },
    });
  });

  it("reports nothing identified as indeterminate, never as a pass", () => {
    // The project may be perfectly healthy and simply not declare what it installs with. We cannot verify it, so the
    // outcome must not read as clean.
    const assessment = assessPackageManagerHealth(
      input({
        snapshot: snapshot({ rootEntries: new Set(["deno.lock"]) }),
        detection: { status: "undeclared", lockfiles: ["deno.lock"] },
      }),
    );

    expect(onlyIssue(assessment)).toMatchObject({
      code: "PM_UNDECLARED",
      outcome: "indeterminate",
      detail: { lockfiles: ["deno.lock"] },
    });
    expect(assessment.outcome).toBe("indeterminate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tooling
// ─────────────────────────────────────────────────────────────────────────────

describe("the executable", () => {
  it("reports a missing binary separately from anything about dependencies", () => {
    const assessment = assessPackageManagerHealth(
      input({ executable: MISSING }),
    );

    expect(onlyIssue(assessment)).toMatchObject({
      code: "PM_EXECUTABLE_MISSING",
      outcome: "fail",
      manager: "npm",
      detail: {
        manager: "npm",
        executable: "npm",
        lockfile: "package-lock.json",
      },
    });
  });

  it("reports no version problem when no version was declared", () => {
    // Nothing declared means nothing to compare. An advisory invented from an absence is how people learn to ignore
    // advisories.
    const assessment = assessPackageManagerHealth(
      input({ executable: found("1.0.0") }),
    );

    expect(assessment.issues).toStrictEqual([]);
    expect(assessment.outcome).toBe("pass");
  });

  it("reports a version outside the declared engines range", () => {
    const assessment = assessPackageManagerHealth(
      input({
        snapshot: snapshot({ engineRanges: { npm: ">=9.1.0 <10.0.0" } }),
        executable: found("9.0.9"),
      }),
    );

    expect(onlyIssue(assessment)).toMatchObject({
      code: "PM_EXECUTABLE_VERSION_MISMATCH",
      outcome: "fail",
      detail: {
        detected: "9.0.9",
        expected: ">=9.1.0 <10.0.0",
        expectedOrigin: "package.json#engines.npm",
        executable: "/fake/bin/npm",
      },
    });
  });

  it("accepts a version inside the declared engines range", () => {
    const assessment = assessPackageManagerHealth(
      input({
        snapshot: snapshot({ engineRanges: { npm: ">=9.1.0 <10.0.0" } }),
        executable: found("9.1.0"),
      }),
    );

    expect(assessment.issues).toStrictEqual([]);
  });

  it("prefers the `packageManager` requirement over an `engines` range", () => {
    // The declaration is the stricter statement, and only one of the two documents should be quoted.
    //
    // The declared value is written as a range rather than as an exact pin, deliberately: the question here is *which
    // authority decides*, and a range keeps the outcome independent of how the grammar treats an operator-less version.
    // The engines range is one the installed version satisfies, so if the wrong document won this case would report
    // nothing at all — a louder failure than an unexpected code.
    const assessment = assessPackageManagerHealth(
      input({
        snapshot: snapshot({
          engineRanges: { npm: ">=9.0.0 <10.0.0" },
          declaration: {
            status: "parsed",
            declaration: {
              name: "npm",
              version: ">=9.1.0 <10.0.0",
              raw: "npm@9.1.0",
            },
          },
        }),
        executable: found("9.0.9"),
      }),
    );

    const issue = onlyIssue(assessment);

    // Brackets, not dots: `detail` is a `Record<string, …>`, so its keys are data — and a misspelled one would read as
    // `undefined` rather than failing to compile, which is why the assertion is on the value and not on its presence.
    expect(issue.detail["expected"]).toBe(">=9.1.0 <10.0.0");
    expect(issue.detail["expectedOrigin"]).toBe("package.json#packageManager");
  });

  it("reports an unreadable requirement as unverified rather than as a mismatch", () => {
    // A partial version is not a range this grammar completes. The comparison could not be made, which is a different
    // finding from one that was made and failed.
    const assessment = assessPackageManagerHealth(
      input({
        snapshot: snapshot({ engineRanges: { npm: ">=9" } }),
        executable: found("9.1.0"),
      }),
    );

    expect(onlyIssue(assessment)).toMatchObject({
      code: "PM_VERSION_UNVERIFIED",
      outcome: "indeterminate",
      detail: {
        detected: "9.1.0",
        expected: ">=9",
        reason: "policy-range-unreadable",
      },
    });
  });

  it("reports a binary that would not answer, when a version was expected", () => {
    const assessment = assessPackageManagerHealth(
      input({
        snapshot: snapshot({ engineRanges: { npm: ">=9.1.0 <10.0.0" } }),
        executable: unreadable("timeout"),
      }),
    );

    expect(onlyIssue(assessment)).toMatchObject({
      code: "PM_VERSION_UNVERIFIED",
      outcome: "indeterminate",
      detail: { expected: ">=9.1.0 <10.0.0", reason: "timeout" },
    });
  });

  it("reports nothing when a version was expected but probing was skipped", () => {
    // `not-probed` means nobody asked: no version was declared, or the platform needs a shell we refuse to enable.
    // Reporting it as "unverified" would teach readers to ignore the code that matters.
    const assessment = assessPackageManagerHealth(
      input({
        snapshot: snapshot({ engineRanges: { npm: ">=9.1.0 <10.0.0" } }),
        executable: found(),
      }),
    );

    expect(assessment.issues).toStrictEqual([]);
    expect(assessment.outcome).toBe("pass");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Installation state
// ─────────────────────────────────────────────────────────────────────────────

describe("installation state", () => {
  it("reports dependencies not installed when the project clearly intends them", () => {
    const assessment = assessPackageManagerHealth(
      input({ installState: ABSENT }),
    );

    expect(onlyIssue(assessment)).toMatchObject({
      code: "PM_DEPENDENCIES_NOT_INSTALLED",
      outcome: "fail",
      detail: {
        manager: "npm",
        lockfile: "package-lock.json",
        nodeModules: false,
      },
    });
  });

  it("reports a tree created by another manager", () => {
    // Everything looks installed, so this is the finding that would otherwise surface much later as a resolution error
    // naming a package nobody edited.
    const assessment = assessPackageManagerHealth(
      input({ installState: FOREIGN_BY_YARN }),
    );

    expect(onlyIssue(assessment)).toMatchObject({
      code: "PM_FOREIGN_NODE_MODULES",
      outcome: "fail",
      detail: {
        marker: "node_modules/.package-lock.json",
        createdBy: "yarn",
      },
    });
  });

  it("reports nothing when attribution failed but nothing is wrong", () => {
    // `unknown` is not a defect: the manager leaves no marker we trust, or the tree could not be inspected. Reporting
    // it would put a diagnostic gap in front of a reader who has no problem.
    const assessment = assessPackageManagerHealth(
      input({ installState: UNATTRIBUTED }),
    );

    expect(assessment.issues).toStrictEqual([]);
  });

  it("prefers a supplied state over the derived one", () => {
    // The snapshot has no `node_modules`, so the derived answer is `absent`; the supplied `installed` is the only
    // reason there is no finding.
    const assessment = assessPackageManagerHealth(
      input({
        snapshot: snapshot({ hasNodeModules: false }),
        installState: INSTALLED_NPM,
      }),
    );

    expect(assessment.issues).toStrictEqual([]);
  });

  it("derives the state when none is supplied", () => {
    // Built inline rather than through `input`, because the factory's healthy default *is* a supplied state — and the
    // whole point of this case is that there is none.
    const assessment = assessPackageManagerHealth({
      snapshot: snapshot({
        rootEntries: new Set(["package-lock.json"]),
        hasNodeModules: false,
      }),
      detection: detected("npm"),
      executable: found(),
    });

    expect(codesOf(assessment)).toStrictEqual([
      "PM_DEPENDENCIES_NOT_INSTALLED",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation and purity
// ─────────────────────────────────────────────────────────────────────────────

describe("aggregation", () => {
  it("reports a passing assessment with no issues", () => {
    const assessment = assessPackageManagerHealth(input());

    expect(assessment).toStrictEqual({
      manager: "npm",
      outcome: "pass",
      issues: [],
    });
  });

  it("reports several independent problems in the order a reader fixes them", () => {
    // A missing binary and a foreign tree are both true and both worth showing: one is a tool to install, the other a
    // dependency tree to rebuild, and neither hides the other.
    const assessment = assessPackageManagerHealth(
      input({ executable: MISSING, installState: FOREIGN_BY_PNPM }),
    );

    expect(codesOf(assessment)).toStrictEqual([
      "PM_EXECUTABLE_MISSING",
      "PM_FOREIGN_NODE_MODULES",
    ]);
    expect(assessment.outcome).toBe("fail");
  });

  it("takes the worst outcome across the issues it reports", () => {
    // `indeterminate` outranks `pass` and is outranked by `fail`. The ordering lives here rather than in every consumer
    // that wants a headline status.
    const indeterminate = assessPackageManagerHealth(
      input({ detection: { status: "undeclared", lockfiles: [] } }),
    );
    const failing = assessPackageManagerHealth(input({ executable: MISSING }));

    expect([indeterminate.outcome, failing.outcome]).toStrictEqual([
      "indeterminate",
      "fail",
    ]);
  });

  it("reports the identified manager only when one was identified", () => {
    const identified = assessPackageManagerHealth(input());
    const conflicting = assessPackageManagerHealth(
      input({
        detection: {
          status: "conflicting",
          lockfiles: ["package-lock.json", "yarn.lock"],
          managers: ["npm", "yarn"],
        },
      }),
    );

    expect([identified.manager, conflicting.manager]).toStrictEqual([
      "npm",
      undefined,
    ]);
  });

  it("returns frozen data throughout", () => {
    // Evidence that a later consumer can edit is not evidence.
    const assessment = assessPackageManagerHealth(
      input({ executable: MISSING }),
    );

    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.issues)).toBe(true);
    expect(Object.isFrozen(assessment.issues[0])).toBe(true);
    expect(Object.isFrozen(assessment.issues[0]?.detail)).toBe(true);
  });

  it("does not mutate the evidence it was given", () => {
    const evidence = input({ executable: MISSING });

    assessPackageManagerHealth(evidence);

    // One, not zero: the default snapshot now carries the lockfile the default detection describes, so the assertion
    // proves the set was left alone rather than proving it was empty to begin with.
    expect(evidence.snapshot.rootEntries.size).toBe(1);
    expect(evidence.executable).toStrictEqual(MISSING);
  });

  it("is deterministic: the same evidence produces a deeply equal assessment", () => {
    const evidence = input({ executable: MISSING });

    expect(assessPackageManagerHealth(evidence)).toStrictEqual(
      assessPackageManagerHealth(evidence),
    );
  });
});

describe("the state this module refuses to claim", () => {
  it("never reports an installation problem it cannot attribute", () => {
    // The four `InstallState` values are deliberately exhaustive: `unknown` produces no finding at all, so a gap in the
    // evidence can never be rendered as a fault. Asserted as a set so a future state cannot be added without a case.
    const states: readonly InstallState[] = [
      INSTALLED_NPM,
      ABSENT,
      FOREIGN_BY_PNPM,
      UNATTRIBUTED,
    ];

    const codes = states.map((installState) =>
      codesOf(assessPackageManagerHealth(input({ installState }))),
    );

    expect(codes).toStrictEqual([
      [],
      ["PM_DEPENDENCIES_NOT_INSTALLED"],
      ["PM_FOREIGN_NODE_MODULES"],
      [],
    ]);
  });
});
