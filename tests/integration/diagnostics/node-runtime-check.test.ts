/**
 * Integration tests for the runtime checks: the composition root, the catalogue and the runner, wired together.
 *
 * The unit suites answer "does this rule conclude correctly" and "does this manifest produce a readable requirement".
 * This file answers the question neither can: **do the two halves the assembly exposes actually reach the check**. That
 * is a distinct failure mode — the rule can be perfect and the requirement correct while the wiring hands the gatherer
 * the wrong field, hands the check a string it never read, or resolves the policy twice.
 *
 * ## What is real, and what is injected
 *
 * Real: `createApplication`, the catalogue (`CHECKS`), the runner (`runChecks`), the manifest reader, the policy
 * resolver, the compatibility engine. Injected: only the two values a test cannot honestly obtain — the interpreter's
 * version, and the range the build declares. Everything else is the shipping code path.
 *
 * The gatherer in `gather` is the one piece that does not exist yet in `src/`. It is written here on purpose: it is the
 * contract the real gatherer will have to satisfy, and stating it as code means the integration seam is testable before
 * the module lands. When it lands, this helper is replaced by it and the assertions stay.
 */
import { describe, expect, it } from "vitest";

import { createApplication } from "~/app/composition.js";
import type { ApplicationOptions } from "~/app/contracts.js";
import {
  CheckId,
  CheckStatus,
  HealthCode,
  failedChecks,
  isBlocked,
  outcomeOf,
} from "~/core/application/checks.js";
import type { Application } from "~/core/application/ports.js";
import {
  evaluateRequirement,
  parseRange,
  qatRuntimeRequirement,
} from "~/core/compatibility/index.js";
import { createProcessRuntime } from "~/core/environment/index.js";
import {
  CHECKS,
  runChecks,
  type CheckFacts,
  type RuntimeRequirementFact,
} from "~/diagnostics/checks/index.js";
import { readOwnManifest } from "~/shared/utils/package-manifest.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A log destination that discards everything.
 *
 * The assembly builds a real logger; these tests never read it, and a test run should not depend on whether
 * `QAT_LOG_LEVEL` happens to be set in the environment it was launched from.
 */
const SILENT = { write: () => undefined };

/** The range these tests declare, unless a case needs a different one. */
const DECLARED = {
  range: ">=20.11.0 <21.0.0",
  origin: "package.json#engines.node",
} as const;

/**
 * Assembles an application, runs the body, and disposes it whatever happens.
 *
 * Disposal is in a `finally` because a failed assertion must not leak a repository — and because a test that only
 * cleans up on success is a test that hides its own failures behind an open handle.
 */
async function withApplication(
  options: ApplicationOptions,
  body: (app: Application) => void | Promise<void>,
): Promise<void> {
  const app = createApplication({
    environment: {},
    logDestination: SILENT,
    ...options,
  });

  try {
    await body(app);
  } finally {
    await app.dispose();
  }
}

/**
 * Pairs the two halves the assembly exposes into the evidence the check reads.
 *
 * This is the seam under test. The keys matter as much as the values: `nodeVersion` is **omitted** when the host reports
 * nothing, because absence and `undefined` mean different things to the check — "no version was reported" versus
 * "reported something unreadable".
 */
function gather(
  app: Application,
  frameworkRequired?: RuntimeRequirementFact,
): CheckFacts {
  const version = app.runtime.readNodeVersion();

  return {
    runtime: {
      ...(version === undefined ? {} : { nodeVersion: version }),
      required: {
        range: app.nodeRequirement.range,
        origin: app.nodeRequirement.origin,
      },
      ...(frameworkRequired === undefined ? {} : { frameworkRequired }),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The wiring                                                                 */
/* -------------------------------------------------------------------------- */

describe("the assembled application", () => {
  it("exposes the requirement it was given, rather than resolving its own", async () => {
    const supplied = qatRuntimeRequirement({
      engines: { node: DECLARED.range },
    });

    await withApplication({ nodeRequirement: supplied }, (app) => {
      // Identity, not equality: the requirement is resolved once and shared, so two consumers cannot disagree about
      // what "supported" means within a run.
      expect(app.nodeRequirement).toBe(supplied);
      expect(Object.isFrozen(app.nodeRequirement)).toBe(true);
    });
  });

  it("reads the interpreter through its port", async () => {
    await withApplication(
      { runtime: createProcessRuntime({ node: "v20.11.1" }) },
      (app) => {
        expect(app.runtime.readNodeVersion()).toBe("v20.11.1");
      },
    );
  });

  it("produces facts the runtime check accepts, so nothing is skipped for want of evidence", async () => {
    await withApplication(
      {
        runtime: createProcessRuntime({ node: "v20.11.1" }),
        nodeRequirement: qatRuntimeRequirement({
          engines: { node: DECLARED.range },
        }),
      },
      (app) => {
        const report = runChecks(gather(app));

        // Every check reports — none throws, none is missing a group it declared.
        expect(report.outcomes).toHaveLength(CHECKS.length);
        expect(outcomeOf(report, CheckId.NodeVersion)?.status).not.toBe(
          CheckStatus.Skipped,
        );
      },
    );
  });

  it("skips the checks whose evidence this gatherer does not supply", async () => {
    await withApplication(
      { runtime: createProcessRuntime({ node: "v20.11.1" }) },
      (app) => {
        const report = runChecks(gather(app));

        // A gatherer that supplies only the runtime group must leave the project checks skipped, not failed — and the
        // skipped ones must name the group they were missing rather than the project.
        expect(outcomeOf(report, CheckId.ProjectRecognised)).toMatchObject({
          status: CheckStatus.Skipped,
        });
      },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Outcomes through the whole chain                                           */
/* -------------------------------------------------------------------------- */

describe("a supported runtime", () => {
  it("passes both runtime checks and blocks nothing", async () => {
    await withApplication(
      {
        runtime: createProcessRuntime({ node: "v20.11.1" }),
        nodeRequirement: qatRuntimeRequirement({
          engines: { node: DECLARED.range },
        }),
      },
      (app) => {
        const report = runChecks(gather(app));

        expect(outcomeOf(report, CheckId.NodeVersion)?.status).toBe(
          CheckStatus.Passed,
        );
        expect(outcomeOf(report, CheckId.CypressRuntimeSupported)?.status).toBe(
          CheckStatus.Passed,
        );
        expect(isBlocked(report)).toBe(false);
      },
    );
  });
});

describe("an unsupported runtime", () => {
  it("fails exactly one check, and blocks", async () => {
    await withApplication(
      {
        runtime: createProcessRuntime({ node: "v18.19.0" }),
        nodeRequirement: qatRuntimeRequirement({
          engines: { node: DECLARED.range },
        }),
      },
      (app) => {
        const report = runChecks(gather(app));

        expect(isBlocked(report)).toBe(true);
        expect(
          failedChecks(report).map((outcome) => outcome.check),
        ).toStrictEqual([CheckId.NodeVersion]);
        expect(outcomeOf(report, CheckId.NodeVersion)).toMatchObject({
          finding: { code: HealthCode.RuntimeUnsupported },
        });
      },
    );
  });

  it("quotes the range the assembly resolved, not a copy of it", async () => {
    await withApplication(
      {
        runtime: createProcessRuntime({ node: "v18.19.0" }),
        nodeRequirement: qatRuntimeRequirement({
          engines: { node: DECLARED.range },
        }),
      },
      (app) => {
        const outcome = outcomeOf(runChecks(gather(app)), CheckId.NodeVersion);

        // The passthrough, end to end: change the requirement and the sentence changes with it, with no second place to
        // edit. If this assertion needed updating whenever the message changed, something would be restating the range.
        expect(outcome).toMatchObject({
          finding: {
            explanation: expect.stringContaining(
              app.nodeRequirement.range,
            ) as string,
          },
        });
        expect(outcome).toMatchObject({
          finding: {
            explanation: expect.stringContaining(
              app.nodeRequirement.origin,
            ) as string,
          },
        });
      },
    );
  });
});

describe("a runtime the host cannot report", () => {
  it.each([
    { node: undefined, because: "the host reported no version" },
    {
      node: "v-next",
      because: "the host reported something that is not a version",
    },
  ])("warns and does not block when $because", async ({ node }) => {
    await withApplication(
      {
        runtime: createProcessRuntime(node === undefined ? {} : { node }),
        nodeRequirement: qatRuntimeRequirement({
          engines: { node: DECLARED.range },
        }),
      },
      (app) => {
        const report = runChecks(gather(app));

        // The end-to-end shape of the safety property: an unanswered question is visible, is not a pass, and does not
        // refuse a run.
        expect(outcomeOf(report, CheckId.NodeVersion)).toMatchObject({
          status: CheckStatus.Warned,
          finding: { code: HealthCode.RuntimeUnknown },
        });
        expect(isBlocked(report)).toBe(false);
      },
    );
  });
});

describe("a runtime bound declared by the project's framework", () => {
  it("is reported on its own check, alongside QAT's verdict rather than inside it", async () => {
    await withApplication(
      {
        runtime: createProcessRuntime({ node: "v20.11.1" }),
        nodeRequirement: qatRuntimeRequirement({
          engines: { node: DECLARED.range },
        }),
      },
      (app) => {
        const report = runChecks(
          gather(app, {
            range: ">=22.0.0 <25.0.0",
            origin: "cypress runtime requirement",
          }),
        );

        // QAT's own requirement is satisfied, and the project's is not: two independent answers, in two outcomes, with
        // two codes. A merged finding could not express this case at all.
        expect(outcomeOf(report, CheckId.NodeVersion)?.status).toBe(
          CheckStatus.Passed,
        );
        expect(
          outcomeOf(report, CheckId.CypressRuntimeSupported),
        ).toMatchObject({
          status: CheckStatus.Warned,
          finding: { code: HealthCode.FrameworkRuntimeUnsupported },
        });
        expect(isBlocked(report)).toBe(false);
      },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The policy this build actually ships                                       */
/* -------------------------------------------------------------------------- */

describe("the shipped policy", () => {
  it("declares a range the shipped parser can read", () => {
    const requirement = qatRuntimeRequirement(readOwnManifest());

    // An empty range is what a broken installation produces, and the finding it produces at runtime is a warning —
    // right for a user, useless as a build gate. This is the gate.
    expect(requirement.range).not.toBe("");
    expect(parseRange(requirement.range).ok).toBe(true);
  });

  it("reaches a conclusion for the interpreter this suite is running on", async () => {
    // Real manifest, real probe, nothing injected. `indeterminate` is the only outcome that would indicate a defect in
    // the shipped declaration or in the port — so this is the wiring claim, and unlike "is it satisfied" it is true on
    // every machine.
    await withApplication({}, (app) => {
      const verdict = evaluateRequirement(
        app.nodeRequirement,
        app.runtime.readNodeVersion(),
      );

      expect(verdict.status).not.toBe("indeterminate");
    });
  });

  it("makes the report agree with that conclusion", async () => {
    // Whatever the answer is, the chain must say the same thing: blocked exactly when the engine is unsatisfied. This
    // catches a probe and a requirement taken from different sources, without depending on which interpreter happens to
    // be installed.
    await withApplication({}, (app) => {
      const verdict = evaluateRequirement(
        app.nodeRequirement,
        app.runtime.readNodeVersion(),
      );
      const report = runChecks(gather(app));

      expect(isBlocked(report)).toBe(verdict.status === "unsatisfied");
    });
  });
});
