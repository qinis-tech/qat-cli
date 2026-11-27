/**
 * The Cypress configuration diagnostics, end to end over a real tree.
 *
 * The unit suites drive each stage with literals; this one runs the whole chain against directories on disk:
 *
 *   detection → file facts → the location projection → the validation ladder → both checks
 *
 * What that buys is the joints. A projection that maps reasons correctly and a rule that renders them correctly can still
 * disagree about *which* file they are describing, and only a test that reads the disk can catch a gatherer that pointed
 * one of them at the wrong path or skipped a stage entirely.
 *
 * Deep validation is deliberately off throughout. It needs a process, and a process needs a real Cypress installation —
 * so `QAT-H028` is proved by the ladder's own suite and by a fixture-driven behaviour case, not here. Everything reachable
 * without spawning anything is reachable here.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CheckId,
  CheckSkipReason,
  CheckStatus,
  HealthCode,
  failedChecks,
  isBlocked,
  outcomeOf,
  type CheckOutcome,
  type DoctorReport,
} from "~/core/application/checks.js";
import {
  runChecks,
  type PackageManagerFacts,
  type RuntimeFacts,
} from "~/diagnostics/checks/index.js";
import {
  createConfigFileInspector,
  inspectConfiguration,
  validateConfiguration,
  type ConfigDiscovery,
  type ConfigValidation,
} from "~/project/cypress-config/index.js";
import {
  DetectionVerdict,
  assessProject,
  detectCypress,
} from "~/project/index.js";

let created: string[] = [];

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-cfg-"));
  created.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  return root;
}

afterEach(async () => {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
  created = [];
});

const CONFIG = "cypress.config.ts";
const CONFIG_BODY = "export default {};";

/**
 * The two groups this file is not about.
 *
 * Supplied as healthy literals rather than omitted, because a missing group makes its checks skip — and a report full of
 * unrelated skips makes it harder to see which rows the configuration pair produced. The assessment is real, because
 * `cypress.configuration-located` declares it as a precondition and a synthetic one would weaken the one cascade this
 * file exists to prove.
 */
const RUNTIME: RuntimeFacts = {
  nodeVersion: "v24.4.0",
  required: { range: ">=24.0.0 <25.0.0", origin: "package.json#engines.node" },
};

const MANAGER: PackageManagerFacts = {
  selection: { status: "identified", name: "npm", declared: true },
  lockfiles: ["package-lock.json"],
  executable: { resolved: true },
  installState: "installed",
};

/** A manifest that declares Cypress, so detection has something to call this project even without a configuration. */
const DECLARING_MANIFEST = JSON.stringify({
  name: "demo",
  version: "1.0.0",
  devDependencies: { cypress: "^13.15.0" },
});

/** An installed package, so `cypress.installed` and `cypress.version-supported` are satisfied rather than blocking. */
const CYPRESS_MANIFEST = JSON.stringify({
  name: "cypress",
  version: "13.15.0",
});

/**
 * A project that is healthy in every respect except the configuration.
 *
 * Declared *and* installed *and* with a spec location. All three are needed for the report to be clean: without the
 * installed package, `cypress.installed` fails; without `cypress/e2e`, `cypress.layout-driveable` fails; and either would
 * make `isBlocked` true for a reason this file is not testing.
 */
function project(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "package.json": DECLARING_MANIFEST,
    [CONFIG]: CONFIG_BODY,
    "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    "cypress/e2e/smoke.cy.ts": "",
    ...extra,
  };
}

interface Pipeline {
  readonly report: DoctorReport;
  readonly location: ConfigDiscovery;
  readonly validation: ConfigValidation;
}

/**
 * The chain the gatherer performs, in the order it performs it.
 *
 * Kept in one function so every case below varies a tree rather than a wiring: if the stages stop fitting together, one
 * change breaks all of them rather than a single case nobody notices.
 */
async function pipeline(root: string): Promise<Pipeline> {
  const detection = await detectCypress(root);

  // Facts only for a file detection accepted: asking the inspector about a configuration that does not exist would
  // produce a second, contradictory story about the same directory.
  const facts =
    detection.verdict === DetectionVerdict.Detected
      ? await createConfigFileInspector().inspect({
          projectRoot: root,
          file: detection.configuration,
        })
      : undefined;

  const location = inspectConfiguration({ detection, facts });

  // No `deep`, no probe: the default path, which is the one every user gets.
  const validation = await validateConfiguration({
    projectRoot: root,
    discovery: location,
    facts,
  });

  return {
    location,
    validation,
    report: runChecks({
      runtime: RUNTIME,
      packageManager: MANAGER,
      assessment: await assessProject(root),
      cypressConfiguration: { location, validation },
    }),
  };
}

/** Both outcomes this file asserts on, so a case reads as a pair rather than two lookups. */
function configurationOutcomes(
  report: DoctorReport,
): readonly [CheckOutcome | undefined, CheckOutcome | undefined] {
  return [
    outcomeOf(report, CheckId.CypressConfigurationLocated),
    outcomeOf(report, CheckId.CypressConfigurationValidatable),
  ];
}

describe("a project whose configuration is where Cypress expects it", () => {
  it("locates it, and reports that nothing validated it", async () => {
    const { report, location, validation } = await pipeline(
      await makeTree(project()),
    );
    const [located, validatable] = configurationOutcomes(report);

    expect(location).toMatchObject({
      reason: "CYPRESS_CONFIG_FOUND",
      file: CONFIG,
      format: "executable",
    });
    expect(located).toMatchObject({ status: CheckStatus.Passed });

    // The default experience of a TypeScript project, and the reason this is a warning rather than a pass: the file was
    // read and is decodable text, but nothing loaded it. A green check would claim a verification that never ran.
    expect(validation).toMatchObject({
      reason: "CYPRESS_CONFIG_NOT_VALIDATED",
      cause: "deep-validation-disabled",
    });
    expect(validatable).toMatchObject({
      status: CheckStatus.Warned,
      finding: { code: HealthCode.CypressConfigurationUnverified },
    });

    // One warning, and nothing that refuses a run: a configuration nobody deep-validated is not a broken project. The
    // fixture installs Cypress and provides a spec directory precisely so that this claim is about the pair and nothing
    // else.
    expect(isBlocked(report)).toBe(false);
    expect(failedChecks(report)).toStrictEqual([]);
  });

  it("describes one file from one capture", async () => {
    const { location, validation } = await pipeline(await makeTree(project()));

    // The property the shared fact group exists for: both verdicts name the same file, because both were decided from the
    // same read of it. Two stages pointing at different paths is the failure this asserts against.
    expect(location).toMatchObject({ file: CONFIG });
    expect(validation).toMatchObject({ file: CONFIG });
  });

  it("refuses to hand binary content to a loader", async () => {
    const root = await makeTree(
      project({ [CONFIG]: "export default {}\u0000;" }),
    );

    const { report, location, validation } = await pipeline(root);
    const [, validatable] = configurationOutcomes(report);

    // Located, because it is a non-empty regular file; not validated, because NUL bytes are valid UTF-8 and decodability
    // alone cannot tell binary from text. The honest answer is a gap, not a pass and not an invalidity claim.
    expect(location).toMatchObject({ reason: "CYPRESS_CONFIG_FOUND" });
    expect(validation).toMatchObject({
      reason: "CYPRESS_CONFIG_NOT_VALIDATED",
      cause: "text-sanity-not-established",
    });
    expect(validatable).toMatchObject({
      finding: { code: HealthCode.CypressConfigurationUnverified },
    });
  });
});

describe("a project with no usable configuration", () => {
  it("reports a missing file as one failure, and skips what depended on it", async () => {
    const root = await makeTree({
      "package.json": DECLARING_MANIFEST,
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
      "cypress/e2e/smoke.cy.ts": "",
    });

    const { report } = await pipeline(root);
    const [located, validatable] = configurationOutcomes(report);

    expect(located).toMatchObject({
      status: CheckStatus.Failed,
      finding: { code: HealthCode.CypressConfigurationMissing },
    });

    // The cascade, on real evidence: validity is not a second problem, it is the same one seen from further down — and
    // the sentence names the check that stopped it.
    expect(validatable).toMatchObject({
      status: CheckStatus.Skipped,
      reason: CheckSkipReason.PreconditionFailed,
      explanation: expect.stringContaining(
        CheckId.CypressConfigurationLocated,
      ) as string,
    });
    expect(failedChecks(report).map((outcome) => outcome.check)).toStrictEqual([
      CheckId.CypressConfigurationLocated,
    ]);
  });

  it("reports two configuration files without choosing between them", async () => {
    const root = await makeTree(project({ "cypress.config.js": CONFIG_BODY }));

    const { report, location } = await pipeline(root);
    const [located] = configurationOutcomes(report);

    expect(location).toMatchObject({
      reason: "CYPRESS_CONFIG_AMBIGUOUS",
      files: ["cypress.config.js", CONFIG],
    });

    // Cypress refuses to start in this state, so a warning would contradict the tool. Both files are named and the choice
    // is left to the reader, because a guess here decides which file the next install rewrites.
    expect(located).toMatchObject({
      status: CheckStatus.Failed,
      finding: { code: HealthCode.CypressConfigurationAmbiguous },
    });
  });

  it("reports an empty file as empty rather than as unreadable or invalid", async () => {
    const root = await makeTree(project({ [CONFIG]: "" }));

    const { report, location } = await pipeline(root);
    const [located, validatable] = configurationOutcomes(report);

    // Zero bytes is a distinct condition with a distinct remedy: write the configuration, rather than fix a permission
    // or hunt for a syntax error that does not exist.
    expect(location).toMatchObject({ reason: "CYPRESS_CONFIG_EMPTY" });
    expect(located).toMatchObject({
      status: CheckStatus.Failed,
      finding: { code: HealthCode.CypressConfigurationEmpty },
    });
    expect(validatable).toMatchObject({ status: CheckStatus.Skipped });
  });

  it("reports a directory occupying the configuration path", async () => {
    const root = await makeTree({
      "package.json": DECLARING_MANIFEST,
      [`${CONFIG}/keep`]: "",
    });

    const { report, location } = await pipeline(root);
    const [located] = configurationOutcomes(report);

    // The one condition a file probe cannot see at all, and the reason the location verdict reads file facts rather than
    // names: the remedy for "missing" would be to create a file that cannot be created.
    expect(location).toMatchObject({
      reason: "CYPRESS_CONFIG_PATH_OCCUPIED",
      paths: [CONFIG],
    });
    expect(located).toMatchObject({
      status: CheckStatus.Failed,
      finding: { code: HealthCode.CypressConfigurationPathNotAFile },
    });
  });

  it("reports a configuration filed where Cypress never reads one", async () => {
    // Built from scratch rather than from `project()`: that fixture already carries a valid root configuration, so adding
    // one under `cypress/` would leave the project *detected* — which is the state this case is not about.
    const root = await makeTree({
      "package.json": DECLARING_MANIFEST,
      [`cypress/${CONFIG}`]: CONFIG_BODY,
      "cypress/e2e/smoke.cy.ts": "",
    });

    const { report, location } = await pipeline(root);
    const [located] = configurationOutcomes(report);

    // Advisory: the file exists, so the fix is to move it, and a project mid-migration may still run.
    expect(location).toMatchObject({
      reason: "CYPRESS_CONFIG_MISPLACED",
      files: [`cypress/${CONFIG}`],
    });
    expect(located).toMatchObject({
      status: CheckStatus.Warned,
      finding: { code: HealthCode.CypressConfigurationMisplaced },
    });
  });

  it("reports the pre-v10 carrier as an unusable format, not as a located legacy file", async () => {
    const root = await makeTree({
      "package.json": DECLARING_MANIFEST,
      "cypress.json": "{}",
    });

    const { report, location } = await pipeline(root);
    const [located] = configurationOutcomes(report);

    // What the engine actually concludes today: `cypress.json` sits in the recognised-but-unusable list, so the verdict is
    // `unsupported` and the finding says the format cannot be used.
    //
    // Note the gap this pins down. The projection has a `CYPRESS_CONFIG_LEGACY_FORMAT` branch that a `detected` verdict
    // carrying a `.json` configuration would reach — and the engine never produces one, because it classifies a lone
    // `cypress.json` as unsupported. If that ever changes, this case moves to
    // `HealthCode.CypressConfigurationLegacyFormat`, and the ladder would then get a chance to parse the file (T1). Right
    // now it is never reached through detection, which is worth knowing before someone writes a test that assumes it is.
    expect(location).toMatchObject({
      reason: "CYPRESS_CONFIG_UNSUPPORTED_NAME",
    });
    expect(located).toMatchObject({
      status: CheckStatus.Failed,
      finding: { code: HealthCode.CypressConfigurationUnsupportedFormat },
    });
  });
});

describe("a directory that is not a Cypress project", () => {
  it("skips both checks rather than reporting a configuration problem", async () => {
    const { report, location } = await pipeline(
      await makeTree({ "readme.md": "" }),
    );
    const [located, validatable] = configurationOutcomes(report);

    // Nothing here claims to be Cypress, so there is no configuration to be missing. Through the runner the check is
    // skipped by its own precondition — which is why the projection's `not-applicable` reason is normally unreachable.
    expect(location).toMatchObject({ reason: "CYPRESS_CONFIG_MISSING" });
    expect(located).toMatchObject({
      status: CheckStatus.Skipped,
      reason: CheckSkipReason.PreconditionFailed,
      explanation: expect.stringContaining(CheckId.ProjectRecognised) as string,
    });
    expect(validatable).toMatchObject({ status: CheckStatus.Skipped });
  });
});

describe("non-functional behaviour", () => {
  it("does not modify the project it inspects", async () => {
    const root = await makeTree(project());

    // Two *separate* inspectors, so the second genuinely re-reads: this factory memoises per project and file, and reusing
    // the instance would compare a cached answer with itself and prove nothing.
    const before = await createConfigFileInspector().inspect({
      projectRoot: root,
      file: CONFIG,
    });

    await pipeline(root);

    const after = await createConfigFileInspector().inspect({
      projectRoot: root,
      file: CONFIG,
    });

    // Same state, same size, same sampled bytes: a diagnostic that rewrote a configuration while describing it would be
    // untrustworthy even when its description was right.
    expect(after).toStrictEqual(before);
  });

  it("is deterministic: the same tree produces the same report", async () => {
    const root = await makeTree(project());

    const first = await pipeline(root);
    const second = await pipeline(root);

    // The pipeline reads a directory twice, so a cache keyed on anything but the path — or a module-level accumulator —
    // would show up here as a difference the second time round.
    expect(second.location).toStrictEqual(first.location);
    expect(second.validation).toStrictEqual(first.validation);
    expect(second.report).toStrictEqual(first.report);
  });
});
