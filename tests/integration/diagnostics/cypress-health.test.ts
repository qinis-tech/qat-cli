/**
 * Integration tests for the Cypress health pipeline.
 *
 * The unit tests drive each stage with literals. This suite drives the *seam between them*, over real directories: a real
 * `package.json` is read, Node's real resolver finds `node_modules/cypress`, a real cache directory is inspected, and the
 * three check definitions turn the result into verdicts. Only two things are faked — the compatibility verdict, because
 * the semver engine has its own suite, and the verification process, because running a real Cypress binary is not
 * something a unit pipeline should do.
 *
 * The reason this is worth the filesystem: every failure mode it covers is a failure *of the wiring*. A rule reading
 * `version` where the assessment publishes `detected`, a resolver reporting the cache root one directory too deep, a check
 * selected for the wrong fact group — none of those show up when each stage is tested alone, and all of them show up here.
 */

import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CheckCategory,
  CheckFinding,
  CheckId,
} from "~/core/application/checks.js";
import type {
  CheckDefinition,
  CheckFacts,
  CheckVerdict,
} from "~/diagnostics/checks/contracts.js";
import { PASS, present } from "~/diagnostics/checks/contracts.js";
import { createCypressBinaryCheck } from "~/diagnostics/checks/rules/cypress-binary.js";
import { createCypressCompatibilityCheck } from "~/diagnostics/checks/rules/cypress-compatibility.js";
import { createCypressDependencyCheck } from "~/diagnostics/checks/rules/cypress-dependency.js";
import type {
  CompatibilityEvaluation,
  CompatibilityEvaluator,
  CypressCompatibilityPolicy,
  CypressConditionResult,
  CypressDeclaringManifest,
} from "~/project/cypress-health/index.js";
import {
  assessCypressHealth,
  createCypressBinaryInspector,
  createNodeCypressResolver,
  overallCypressStatus,
  readCypressDeclaration,
} from "~/project/cypress-health/index.js";

/* -------------------------------------------------------------------------- */
/* Identity, policy, engine                                                   */
/* -------------------------------------------------------------------------- */

interface Identity {
  readonly id: CheckId;
  readonly category: CheckCategory;
  readonly severity: CheckFinding["severity"];
  readonly code: CheckFinding["code"];
  readonly precondition?: CheckId;
}

/**
 * A stub identity built from real catalogue values.
 *
 * `id` is the only cast: the parameter is a `string` so a caller can pass a literal, and narrowing a `string` to the closed
 * `CheckId` union is what the cast is for. The category and the code are written as plain literals because they *are*
 * members of their unions — asserting them would be noise the compiler is right to reject.
 */
function identity(id: string): Identity {
  return {
    id: id as CheckId,
    category: "cypress-installation",
    severity: "error",
    code: "QAT-H001",
  };
}

const DEPENDENCY = identity("cypress.installed");
const COMPATIBILITY = identity("cypress.version-supported");
const BINARY = identity("cypress.binary-available");

const POLICY: CypressCompatibilityPolicy = {
  supportedRange: ">=12.0.0 <14",
  origin: "adapters/cypress#compatibility",
};

/**
 * A verdict per version, rather than a second semver implementation.
 *
 * The point of this suite is the pipeline, not the range arithmetic: duplicating `>=12 <14` here would create a second
 * authority for what "supported" means and would fail the day the range legitimately changed.
 */
const VERDICTS: Readonly<Record<string, CompatibilityEvaluation>> = {
  "13.6.0": { status: "satisfied", reason: "within-range" },
  "11.2.0": { status: "unsatisfied", reason: "below-minimum" },
  "14.0.0": { status: "unsatisfied", reason: "above-maximum" },
  "14.0.0-rc.1": { status: "unsatisfied", reason: "pre-release-not-listed" },
};

const engine: CompatibilityEvaluator = ({ version }) =>
  VERDICTS[version] ?? {
    status: "indeterminate",
    reason: "unrecognised-version",
  };

/**
 * The assessment names its conditions with `DEP-*` ids; the catalogue names checks with dotted slugs.
 *
 * Keeping the two apart is what this type is for: the results and the verdict map are keyed by the *condition* id the
 * assessment emits, while the definitions carry the *check* id the catalogue owns. Conflating them was how `'DEP-003'` came
 * to be asserted into `CheckId`, which is a union it is not part of.
 */
type ConditionId = CypressConditionResult["checkId"];

const checks: readonly [ConditionId, CheckDefinition][] = [
  [
    "DEP-003",
    createCypressDependencyCheck(DEPENDENCY, {
      recommendedRange: "^13",
      supportedRange: POLICY.supportedRange,
    }),
  ],
  [
    "DEP-004",
    createCypressCompatibilityCheck(COMPATIBILITY, { recommendedRange: "^13" }),
  ],
  ["DEP-008", createCypressBinaryCheck(BINARY)],
];

/**
 * Which check each one names when it had to skip.
 *
 * The chain is DEP-003 → DEP-004 → DEP-008, and each finding names its *immediate* predecessor: the binary cache is keyed by
 * version, so the thing to fix first is the check that establishes the version — not the one that reports the package.
 * Following two pointers reaches the cause; telling every check to point at DEP-003 would make DEP-008 claim a dependency
 * it does not have.
 */
const SKIP_BLOCKERS: readonly [ConditionId, string][] = [
  ["DEP-004", "DEP-003"],
  ["DEP-008", "DEP-004"],
];

/* -------------------------------------------------------------------------- */
/* Filesystem fixtures                                                        */
/* -------------------------------------------------------------------------- */

const created: string[] = [];

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface ProjectOptions {
  /** Contents of `package.json`, already stringified, so a test can also write a corrupt one. */
  readonly manifest: string;
  /** Version of the installed `cypress` package, or `undefined` for "not installed". */
  readonly installedVersion?: string;
  /** Version to place in the Cypress cache, or `undefined` for "no cache entry". */
  readonly cachedVersion?: string;
  /** Mode for the cached binary. Ignored on Windows, which has no execute bit. */
  readonly binaryMode?: number;
}

interface Project {
  readonly root: string;
  readonly cacheFolder: string;
}

/** Materialises one project on disk, the way a user's repository would look. */
async function project(options: ProjectOptions): Promise<Project> {
  const base = await mkdtemp(path.join(tmpdir(), "qat-cypress-"));
  created.push(base);

  const root = path.join(base, "project");
  const cacheFolder = path.join(base, "cache");

  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), options.manifest);

  if (options.installedVersion !== undefined) {
    const packageDirectory = path.join(root, "node_modules", "cypress");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({
        name: "cypress",
        version: options.installedVersion,
        main: "index.js",
      }),
    );
  }

  if (options.cachedVersion !== undefined) {
    // The platform entry differs per operating system, and the inspector reproduces Cypress's own layout: provide the one this
    // machine will actually look for, computed the same way the product does.
    const entry =
      process.platform === "win32"
        ? [path.join(cacheFolder, options.cachedVersion, "Cypress.exe")]
        : process.platform === "darwin"
          ? [
              path.join(
                cacheFolder,
                options.cachedVersion,
                "Cypress.app",
                "Contents",
                "MacOS",
                "Cypress",
              ),
            ]
          : [
              path.join(
                cacheFolder,
                options.cachedVersion,
                "Cypress",
                "Cypress",
              ),
            ];

    for (const file of entry) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "#!/bin/sh\nexit 0\n");
      await chmod(file, options.binaryMode ?? 0o755);
    }
  }

  return { root, cacheFolder };
}

/** Reads the fixture's manifest the way the gatherer would. */
async function manifestOf(root: string): Promise<CypressDeclaringManifest> {
  const contents = await readFile(path.join(root, "package.json"), "utf8");
  const parsed: unknown = JSON.parse(contents);

  // No validation and no cast. The guard narrows `parsed` to `object`, and the manifest type is nothing but optional `unknown`
  // fields — which is exactly the right amount of assurance here: this file only claims to have read *an object*, while the
  // declaration reader is the thing under test and is responsible for surviving whatever that object turns out to contain.
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("fixture manifest is not an object");

  return parsed;
}

/* -------------------------------------------------------------------------- */
/* The pipeline under test                                                    */
/* -------------------------------------------------------------------------- */

interface Run {
  readonly results: readonly CypressConditionResult[];
  readonly verdicts: ReadonlyMap<ConditionId, CheckVerdict>;
}

/**
 * Runs the real pipeline over a real project.
 *
 * Declaration → resolution → assessment → the three checks, in that order, exactly as composition would wire it. The only
 * shortcuts are the injected compatibility verdict and the absence of a `verify` probe, which leaves binaries at "statically
 * inspected" — the outcome production sees in the overwhelming majority of cases anyway.
 */
async function run(fixture: Project): Promise<Run> {
  // `readCypressDeclaration` returns a *reading*; the evidence contract wants the narrow declaration inside it. Passing the
  // reading whole is the mistake this line exists to make impossible: `declaration.declaration` is the fact, the rest
  // (mentions, defect, conflict) is messaging detail the guidance layer reads from the collector.
  const reading = readCypressDeclaration(await manifestOf(fixture.root));
  const resolution = await createNodeCypressResolver().resolve(fixture.root);

  const inspector = createCypressBinaryInspector({
    fileSystem: {
      stat: (target) =>
        stat(target).then((stats) => ({
          isFile: () => stats.isFile(),
          mode: stats.mode,
          size: stats.size,
        })),
      access: (target, mode) => access(target, mode),
    },
  });

  const binary =
    resolution.version === null
      ? null
      : await inspector.inspect({
          version: resolution.version,
          // Passed as data rather than through `process.env`: the fixture's cache must never leak into the developer's real one,
          // and the inspector already takes the environment it should read.
          environment: { CYPRESS_CACHE_FOLDER: fixture.cacheFolder },
        });

  const results = assessCypressHealth(
    {
      projectRoot: fixture.root,
      declaration: reading.declaration,
      resolution,
      binary,
      compatibility: POLICY,
      observedAt: "2025-01-14T09:22:41.117Z",
    },
    { evaluateCompatibility: engine },
  );

  const facts: CheckFacts = { cypress: { results } };
  const verdicts = new Map<ConditionId, CheckVerdict>();

  for (const [id, check] of checks) verdicts.set(id, check.evaluate(facts));

  return { results, verdicts };
}

function verdictOf(run_: Run, id: ConditionId): CheckVerdict {
  const verdict = run_.verdicts.get(id);
  if (verdict === undefined) throw new Error(`No verdict for ${id}`);

  return verdict;
}

function resultOf(run_: Run, id: ConditionId): CypressConditionResult {
  const result = run_.results.find((candidate) => candidate.checkId === id);
  if (result === undefined) throw new Error(`No condition for ${id}`);

  return result;
}

function findingOf(verdict: CheckVerdict): CheckFinding {
  if (verdict.verdict === "pass")
    throw new Error("Expected a finding, got a pass");

  return verdict.finding;
}

function textOf(verdict: CheckVerdict): string {
  const finding = findingOf(verdict);

  return `${finding.explanation}\n${finding.remediation ?? ""}`;
}

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                  */
/* -------------------------------------------------------------------------- */

describe("Cypress health pipeline — a healthy project", () => {
  it("reports three passes end to end", async () => {
    const fixture = await project({
      manifest: JSON.stringify({
        name: "app",
        devDependencies: { cypress: "^13.6.0" },
      }),
      installedVersion: "13.6.0",
      cachedVersion: "13.6.0",
    });

    const run_ = await run(fixture);

    expect(run_.results.map((result) => result.status)).toStrictEqual([
      "pass",
      "pass",
      "pass",
    ]);
    expect(overallCypressStatus(run_.results)).toBe("pass");
    expect(verdictOf(run_, "DEP-003")).toBe(PASS);
    expect(verdictOf(run_, "DEP-004")).toBe(PASS);
    expect(verdictOf(run_, "DEP-008")).toBe(PASS);
  });

  it("reports the version the real resolver found, not a guess", async () => {
    const fixture = await project({
      manifest: JSON.stringify({
        name: "app",
        dependencies: { cypress: "^13.6.0" },
      }),
      installedVersion: "13.6.0",
      cachedVersion: "13.6.0",
    });

    const run_ = await run(fixture);

    expect(resultOf(run_, "DEP-003").evidence).toMatchObject({
      installedVersion: "13.6.0",
    });
  });
});

describe("Cypress health pipeline — declaration and installation", () => {
  it('reports "not declared" and passes the blocker down the chain', async () => {
    const fixture = await project({
      manifest: JSON.stringify({ name: "app" }),
    });

    const run_ = await run(fixture);

    expect(textOf(verdictOf(run_, "DEP-003"))).toContain("not declared");

    // Each check names its immediate predecessor, so following two pointers reaches the cause. A flat "everything blames
    // DEP-003" would make DEP-008 claim a dependency it does not have — its cache is keyed by version, not by package.
    for (const [id, blocker] of SKIP_BLOCKERS) {
      const verdict = verdictOf(run_, id);

      expect(verdict.verdict).toBe("warn");
      expect(textOf(verdict)).toContain(blocker);
    }
  });

  it('reports "declared but not installed" without trying to read a version', async () => {
    const fixture = await project({
      manifest: JSON.stringify({
        name: "app",
        devDependencies: { cypress: "^13.6.0" },
      }),
    });

    const run_ = await run(fixture);

    expect(textOf(verdictOf(run_, "DEP-003"))).toContain("^13.6.0");
    expect(verdictOf(run_, "DEP-004").verdict).toBe("warn");
  });

  it("keeps a ghost install advisory while the rest of the pipeline still runs", async () => {
    // Installed but undeclared: the project works today. The warning must not stop DEP-004 and DEP-008 from answering, because
    // they have everything they need.
    const fixture = await project({
      manifest: JSON.stringify({ name: "app" }),
      installedVersion: "13.6.0",
      cachedVersion: "13.6.0",
    });

    const run_ = await run(fixture);
    const dependency = verdictOf(run_, "DEP-003");

    expect(dependency.verdict).not.toBe("pass");
    expect(findingOf(dependency).severity).toBe("warning");
    expect(verdictOf(run_, "DEP-004")).toBe(PASS);
    expect(verdictOf(run_, "DEP-008")).toBe(PASS);
  });

  it("treats a package whose manifest is unparseable as not installed", async () => {
    // Node's resolver has to *parse* the manifest to resolve `cypress/package.json`, so an unparseable one makes the package
    // unresolvable rather than "resolved but damaged". Asserting the real behaviour here rather than the intuitive one is the
    // point: "damaged" is a different branch, covered below with the damage that genuinely reaches it.
    const fixture = await project({
      manifest: JSON.stringify({
        name: "app",
        devDependencies: { cypress: "^13.6.0" },
      }),
      installedVersion: "13.6.0",
    });

    await writeFile(
      path.join(fixture.root, "node_modules", "cypress", "package.json"),
      '{ "name": "cypress", ',
    );

    const run_ = await run(fixture);

    expect(textOf(verdictOf(run_, "DEP-003"))).toContain("not installed");
  });

  it("reports a manifest QAT refuses as a damaged installation", async () => {
    // A package that resolves but whose manifest is larger than the documented cap: resolution succeeds, our reader refuses
    // it, and the finding must say "damaged" rather than sending the reader to run an install that will change nothing.
    const fixture = await project({
      manifest: JSON.stringify({
        name: "app",
        devDependencies: { cypress: "^13.6.0" },
      }),
      installedVersion: "13.6.0",
    });

    await writeFile(
      path.join(fixture.root, "node_modules", "cypress", "package.json"),
      JSON.stringify({
        name: "cypress",
        version: "13.6.0",
        main: "index.js",
        padding: "x".repeat(1024 * 1024),
      }),
    );

    const run_ = await run(fixture);

    expect(textOf(verdictOf(run_, "DEP-003"))).toContain("damaged");
  });
});

describe("Cypress health pipeline — version compatibility", () => {
  it("blocks below the minimum and skips the binary check", async () => {
    const fixture = await project({
      manifest: JSON.stringify({
        name: "app",
        devDependencies: { cypress: "^11.2.0" },
      }),
      installedVersion: "11.2.0",
      cachedVersion: "11.2.0",
    });

    const run_ = await run(fixture);
    const compatibility = findingOf(verdictOf(run_, "DEP-004"));

    expect(compatibility.severity).toBe("error");
    expect(compatibility.explanation).toContain("11.2.0");
    expect(compatibility.explanation).toContain(POLICY.supportedRange);

    // The cache is keyed by version, so an unsupported version makes binary advice noise.
    expect(verdictOf(run_, "DEP-008").verdict).toBe("warn");
    expect(textOf(verdictOf(run_, "DEP-008"))).toContain("DEP-004");
  });

  it("warns above the tested maximum without calling it unsupported", async () => {
    const fixture = await project({
      manifest: JSON.stringify({
        name: "app",
        devDependencies: { cypress: "^14.0.0" },
      }),
      installedVersion: "14.0.0",
      cachedVersion: "14.0.0",
    });

    const run_ = await run(fixture);
    const compatibility = findingOf(verdictOf(run_, "DEP-004"));

    expect(compatibility.severity).toBe("warning");
    expect(compatibility.explanation).not.toMatch(/unsupported/u);
  });

  it("quotes the range from the policy it was given", async () => {
    // The range is injected policy, never a constant inside a rule: this is what makes changing the supported version a one-line
    // change and a documentation edit.
    const fixture = await project({
      manifest: JSON.stringify({
        name: "app",
        devDependencies: { cypress: "^11.2.0" },
      }),
      installedVersion: "11.2.0",
      cachedVersion: "11.2.0",
    });

    const run_ = await run(fixture);

    expect(textOf(verdictOf(run_, "DEP-004"))).toContain(">=12.0.0 <14");
  });
});

describe("Cypress health pipeline — the binary", () => {
  it("sends the reader to `cypress install` when the cache has no entry", async () => {
    const fixture = await project({
      manifest: JSON.stringify({
        name: "app",
        devDependencies: { cypress: "^13.6.0" },
      }),
      installedVersion: "13.6.0",
      // No cachedVersion: the package is installed, the ~150 MB binary never was.
    });

    const run_ = await run(fixture);
    const binary = findingOf(verdictOf(run_, "DEP-008"));

    expect(binary.severity).toBe("error");
    expect(binary.explanation).toContain("13.6.0");
    expect(binary.remediation).toContain("npx cypress install");
  });

  it("honours CYPRESS_CACHE_FOLDER rather than the real user cache", async () => {
    // If the inspector had read `process.env`, this project would be reporting on the machine running the tests.
    const fixture = await project({
      manifest: JSON.stringify({
        name: "app",
        devDependencies: { cypress: "^13.6.0" },
      }),
      installedVersion: "13.6.0",
      cachedVersion: "13.6.0",
    });

    const run_ = await run(fixture);

    expect(verdictOf(run_, "DEP-008")).toBe(PASS);
  });

  it.skipIf(process.platform === "win32")(
    "reports an unpacked binary that is not executable",
    async () => {
      const fixture = await project({
        manifest: JSON.stringify({
          name: "app",
          devDependencies: { cypress: "^13.6.0" },
        }),
        installedVersion: "13.6.0",
        cachedVersion: "13.6.0",
        binaryMode: 0o644,
      });

      const run_ = await run(fixture);
      const binary = findingOf(verdictOf(run_, "DEP-008"));

      expect(binary.severity).toBe("error");
      expect(binary.explanation).toMatch(/permission|architecture|quarantine/u);
      expect(binary.remediation).toContain("--force");
    },
  );
});

describe("Cypress health pipeline — consistency", () => {
  it("always produces the three conditions in dependency order", async () => {
    const fixture = await project({
      manifest: JSON.stringify({ name: "app" }),
    });

    const run_ = await run(fixture);

    expect(run_.results.map((result) => result.checkId)).toStrictEqual([
      "DEP-003",
      "DEP-004",
      "DEP-008",
    ]);
  });

  it("never reports a later check as failed while its prerequisite was not established", async () => {
    // The invariant the whole design rests on: a consequence is not a second problem.
    const fixture = await project({
      manifest: JSON.stringify({ name: "app" }),
    });

    const run_ = await run(fixture);

    expect(resultOf(run_, "DEP-003").status).toBe("fail");

    for (const [id] of SKIP_BLOCKERS) {
      const result = resultOf(run_, id);

      expect(result.status).not.toBe("fail");
      expect(result.prerequisite).not.toBeNull();
    }
  });

  it("reports no pass for a version the engine could not evaluate", async () => {
    // An unknown verdict must not be counted as health anywhere in the chain.
    const fixture = await project({
      manifest: JSON.stringify({
        name: "app",
        devDependencies: { cypress: "^99.0.0" },
      }),
      installedVersion: "99.0.0",
      cachedVersion: "99.0.0",
    });

    const run_ = await run(fixture);

    expect(overallCypressStatus(run_.results)).not.toBe("pass");
    expect(verdictOf(run_, "DEP-008").verdict).not.toBe("pass");
  });

  it("exposes the gathered group through the same helper the rules use", async () => {
    const fixture = await project({
      manifest: JSON.stringify({ name: "app" }),
    });
    const run_ = await run(fixture);

    expect(
      present<CypressFactsShape>({ results: run_.results }).results,
    ).toHaveLength(3);
  });
});

/** The shape of the fact group, restated narrowly so this test does not depend on the catalogue's file layout. */
interface CypressFactsShape {
  readonly results: readonly CypressConditionResult[];
}
