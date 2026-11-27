import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CompatibilityStatus,
  DetectionStatus,
  DiagnosticCode,
  DiagnosticSeverity,
  PackageMetadataStatus,
  hasBlockingErrors,
  type ErrorDiagnosticCode,
} from "~/core/application/diagnostics.js";
import {
  detectCypress,
  diagnoseProject,
  diagnosisFrom,
  GUIDANCE,
} from "~/project/index.js";

/**
 * Fixtures are real temporary trees, as everywhere in this module: every question asked is "does this named file
 * exist, and what is in it", which a fake would answer according to the same assumption the implementation makes.
 */
const CYPRESS_MANIFEST = JSON.stringify({
  name: "cypress",
  version: "13.15.0",
});

let created: string[] = [];

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-diag-"));
  created.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  return root;
}

function manifest(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: "demo", version: "1.0.0", ...extra });
}

/** A project that is healthy in every respect a test does not vary. */
function healthy(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "package.json": manifest({ devDependencies: { cypress: "^13.15.0" } }),
    "cypress.config.ts": "export default {};",
    "cypress/e2e/smoke.cy.ts": "",
    "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    ...extra,
  };
}

/** The codes present, so an assertion names what it is looking for rather than a whole array. */
function codesOf(diagnosis: {
  readonly findings: readonly { readonly code: string }[];
}): string[] {
  return diagnosis.findings.map((finding) => finding.code);
}

/** Every file and directory under `root`, with size and modification time. Proves nothing was written. */
async function snapshot(root: string): Promise<readonly string[]> {
  const paths = (await readdir(root, { recursive: true })).sort();

  return Promise.all(
    paths.map(async (path) => {
      const stats = await stat(join(root, path));
      return `${path}|${String(stats.size)}|${String(stats.mtimeMs)}`;
    }),
  );
}

afterEach(async () => {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
  created = [];
});

describe("a healthy project", () => {
  it("is detected, compatible, and produces no findings at all", async () => {
    const root = await makeTree(healthy());

    const diagnosis = await diagnoseProject(root);

    expect(diagnosis.detection).toBe(DetectionStatus.Detected);
    expect(diagnosis.compatibility).toBe(CompatibilityStatus.Consistent);
    // An empty array is the good outcome. A positive finding would be noise in every filter and every count.
    expect(diagnosis.findings).toStrictEqual([]);
    expect(hasBlockingErrors(diagnosis)).toBe(false);
  });

  it("reports identity from the manifest", async () => {
    const root = await makeTree(healthy());

    const { identity } = await diagnoseProject(root);

    // `declaredWorkspaces` is required and frequently empty: "the manifest declares none" is a fact, and an absent
    // field would have to be read as unknown.
    expect(identity).toStrictEqual({
      root,
      name: "demo",
      packageMetadata: PackageMetadataStatus.Present,
      declaredWorkspaces: [],
    });
  });

  it("carries the workspace patterns a manifest declares", async () => {
    const root = await makeTree(
      healthy({
        "package.json": manifest({
          workspaces: ["packages/*", "apps/*"],
          devDependencies: { cypress: "^13.15.0" },
        }),
      }),
    );

    const { identity } = await diagnoseProject(root);

    // Carried so a warning about a workspace-shaped root can name the patterns, and never expanded: a consumer
    // handed a list of globs eventually expands one.
    expect(identity.declaredWorkspaces).toStrictEqual(["packages/*", "apps/*"]);
  });

  it("reports declaration and installation as two independent facts", async () => {
    const root = await makeTree(healthy());

    const { framework } = await diagnoseProject(root);

    expect(framework.declaration).toStrictEqual({
      section: "devDependencies",
      range: "^13.15.0",
    });
    expect(framework.installation).toMatchObject({
      version: "13.15.0",
      source: "project",
    });
    expect(framework.configuration).toBe("cypress.config.ts");
    expect(framework.configurationsFound).toStrictEqual(["cypress.config.ts"]);
  });

  it("reports binary availability as unverified rather than unavailable", async () => {
    const root = await makeTree(healthy());

    const { framework } = await diagnoseProject(root);

    // `undefined` means nobody looked. `false` would be a claim that nothing has checked, and the fixture has no
    // binary at all — anything that tried to invoke one would fail the test rather than quietly report false.
    expect(framework.binaryAvailable).toBeUndefined();
  });
});

describe("the two entry points", () => {
  it("builds the same diagnosis from evidence as from disk", async () => {
    const root = await makeTree(healthy());

    const detection = await detectCypress(root);

    // The invariant the extraction exists for: one detection pass, two views. A difference here means the disk-facing
    // entry point stopped delegating, so a caller that already holds evidence would describe a different project than
    // a caller that does not.
    expect(diagnosisFrom(detection)).toStrictEqual(await diagnoseProject(root));
  });

  it("describes an unfavourable project without raising for it", async () => {
    const root = await makeTree({ "readme.md": "" });

    // Absence is an answer, not an error. This is the property that lets a report exist for the directories that most
    // need one.
    await expect(diagnoseProject(root)).resolves.toMatchObject({
      detection: DetectionStatus.NotDetected,
    });
  });
});

describe("every diagnostic code is reachable", () => {
  it("reports a directory with nothing in it", async () => {
    const root = await makeTree({ "readme.md": "" });

    const diagnosis = await diagnoseProject(root);

    expect(diagnosis.detection).toBe(DetectionStatus.NotDetected);
    expect(codesOf(diagnosis)).toContain(DiagnosticCode.FrameworkNotDetected);
    expect(hasBlockingErrors(diagnosis)).toBe(true);
  });

  it("reports Cypress evidenced without a configuration file", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    });

    const diagnosis = await diagnoseProject(root);

    expect(diagnosis.detection).toBe(DetectionStatus.NotDetected);
    expect(codesOf(diagnosis)).toContain(DiagnosticCode.ConfigurationMissing);
  });

  it("explains a bare cypress directory differently from a declared dependency", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "cypress/e2e/smoke.cy.ts": "",
    });

    const diagnosis = await diagnoseProject(root);
    const finding = diagnosis.findings.find(
      (candidate) => candidate.code === DiagnosticCode.ConfigurationMissing,
    );

    // Three causes behind one code, and the reader needs to know which: a deleted configuration looks nothing like a
    // dependency that was never installed.
    expect(finding?.explanation).toContain("A cypress directory was found");
  });

  it("reports two configurations as ambiguous", async () => {
    const root = await makeTree(
      healthy({ "cypress.config.js": "export default {};" }),
    );

    const diagnosis = await diagnoseProject(root);

    expect(diagnosis.detection).toBe(DetectionStatus.Ambiguous);
    expect(codesOf(diagnosis)).toContain(DiagnosticCode.ConfigurationAmbiguous);
  });

  it("reports a legacy configuration as invalid, with the file that caused it", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "cypress.json": "{}",
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    });

    const diagnosis = await diagnoseProject(root);

    expect(diagnosis.detection).toBe(DetectionStatus.Invalid);
    expect(
      diagnosis.findings.find(
        (candidate) =>
          candidate.code === DiagnosticCode.ConfigurationUnsupported,
      ),
    ).toMatchObject({
      path: "cypress.json",
      severity: DiagnosticSeverity.Error,
    });
  });

  it("reports a configuration with no installed package", async () => {
    const root = await makeTree({
      "package.json": manifest({ devDependencies: { cypress: "^13.15.0" } }),
      "cypress.config.ts": "",
    });

    const diagnosis = await diagnoseProject(root);

    // Detected, and not runnable. The status says the first; the finding says the second. Reporting both as one
    // failure is what made the previous behaviour unable to tell a fresh clone from the wrong directory.
    expect(diagnosis.detection).toBe(DetectionStatus.Detected);
    expect(codesOf(diagnosis)).toContain(DiagnosticCode.DependencyNotInstalled);
    expect(diagnosis.compatibility).toBe(CompatibilityStatus.Undetermined);
    expect(hasBlockingErrors(diagnosis)).toBe(true);
  });

  it("reports an installed major that predates the configuration format", async () => {
    const root = await makeTree(
      healthy({
        "node_modules/cypress/package.json": JSON.stringify({
          name: "cypress",
          version: "9.7.0",
        }),
      }),
    );

    const diagnosis = await diagnoseProject(root);

    expect(diagnosis.detection).toBe(DetectionStatus.Detected);
    expect(diagnosis.compatibility).toBe(CompatibilityStatus.Incompatible);
    expect(codesOf(diagnosis)).toContain(DiagnosticCode.VersionIncompatible);
  });

  it("reports a manifest that cannot be read, and does not throw", async () => {
    const root = await makeTree({
      "package.json": '{ "name": ',
      "cypress.config.ts": "",
    });

    const diagnosis = await diagnoseProject(root);

    expect(diagnosis.detection).toBe(DetectionStatus.Invalid);
    expect(diagnosis.identity.packageMetadata).toBe(
      PackageMetadataStatus.Unreadable,
    );
    // Exactly one finding: everything else detection would have looked at, it never reached.
    expect(diagnosis.findings).toHaveLength(1);
    expect(diagnosis.findings[0]).toMatchObject({
      code: DiagnosticCode.ManifestUnreadable,
      severity: DiagnosticSeverity.Error,
      path: "package.json",
    });
  });

  it("warns about a missing manifest without blocking", async () => {
    const root = await makeTree({
      "cypress.config.ts": "",
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    });

    const diagnosis = await diagnoseProject(root);

    expect(diagnosis.detection).toBe(DetectionStatus.Detected);
    expect(diagnosis.identity.packageMetadata).toBe(
      PackageMetadataStatus.Absent,
    );
    expect(codesOf(diagnosis)).toContain(DiagnosticCode.ManifestMissing);
    // A bare project is legal, so this does not stop a command.
    expect(hasBlockingErrors(diagnosis)).toBe(false);
    // And no second warning about an undeclared install: there is no package.json to have failed to declare it.
    expect(codesOf(diagnosis)).not.toContain(
      DiagnosticCode.DependencyUndeclared,
    );
  });

  it("warns about a manifest with no name or version", async () => {
    const root = await makeTree(
      healthy({ "package.json": JSON.stringify({ private: true }) }),
    );

    const diagnosis = await diagnoseProject(root);

    expect(diagnosis.identity.packageMetadata).toBe(
      PackageMetadataStatus.Incomplete,
    );
    expect(diagnosis.identity.name).toContain("qat-diag-");
    expect(codesOf(diagnosis)).toContain(DiagnosticCode.ManifestIncomplete);
  });

  it("warns about a project-local install the manifest does not declare", async () => {
    const root = await makeTree(healthy({ "package.json": manifest() }));

    const diagnosis = await diagnoseProject(root);

    expect(codesOf(diagnosis)).toContain(DiagnosticCode.DependencyUndeclared);
    expect(hasBlockingErrors(diagnosis)).toBe(false);
  });

  it("explains a configuration filed where Cypress never reads one", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "cypress/cypress.config.ts": "export default {};",
    });

    const diagnosis = await diagnoseProject(root);
    const finding = diagnosis.findings.find(
      (candidate) => candidate.code === DiagnosticCode.ConfigurationMissing,
    );

    // The file exists, one directory away. Telling the reader to create one would create a second project instead of
    // finding the first — which is the remedy this fact exists to replace.
    expect(finding?.explanation).toContain("not where Cypress looks");
    expect(finding?.remediation).toContain("Move");
  });

  it("explains a directory occupying the configuration path", async () => {
    const root = await makeTree({
      // Declared, so the project is `incomplete` rather than `absent`. Without this the verdict is "nothing here
      // identifies Cypress" and the occupancy never reaches a remedy: a different code fires first, and rightly — an
      // empty directory with an oddly-named folder in it is not a Cypress project with a problem.
      "package.json": manifest({ devDependencies: { cypress: "^13.15.0" } }),
      "cypress.config.ts/keep": "",
    });

    const diagnosis = await diagnoseProject(root);
    const finding = diagnosis.findings.find(
      (candidate) => candidate.code === DiagnosticCode.ConfigurationMissing,
    );

    // A file probe cannot see this, so every layer below says "no configuration found" — correctly. Without the
    // occupied-path fact the reader is told to create a file that cannot be created: the name is taken by a directory,
    // so the write fails with EISDIR.
    expect(finding?.explanation).toContain("A directory occupies");
    expect(finding?.remediation).toContain("Rename or remove");
  });
});

describe("the catalogue", () => {
  /** One representative fact set, dense enough that every entry's sentence is legible. */
  const FACTS = {
    root: "/project",
    workspaces: [],
    declaration: { section: "devDependencies", range: "^13.15.0" },
    installationVersion: "13.15.0",
    configurations: ["cypress.config.ts"],
    unsupportedConfigurations: ["cypress.json"],
    // Empty rather than omitted, and the distinction is the whole reason these are required: an empty array says
    // "none were found", while an absent field says "nobody looked" — and the catalogue cannot tell those apart, so it
    // would write a remedy for the wrong cause. This literal is what a producer must be able to fill.
    misplacedConfigurations: [],
    occupiedConfigurationPaths: [],
    hasCypressDirectory: true,
  } as const;

  /**
   * The detection codes the contract calls errors, written out.
   *
   * The duplication is the test. `ErrorDiagnosticCode` is a union with nothing at runtime behind it, so a code whose
   * catalogue severity disagreed with it would compile and behave differently from what the type promises. The
   * `satisfies` below proves this list is inside the union; the coverage record after it proves the union is inside
   * the list.
   */
  const ALWAYS_ERROR_CODES = [
    DiagnosticCode.FrameworkNotDetected,
    DiagnosticCode.ConfigurationMissing,
    DiagnosticCode.ConfigurationAmbiguous,
    DiagnosticCode.ConfigurationUnsupported,
    DiagnosticCode.DependencyNotInstalled,
    DiagnosticCode.VersionIncompatible,
    DiagnosticCode.ManifestUnreadable,
  ] as const satisfies readonly ErrorDiagnosticCode[];

  /**
   * The bidirectional half of the check.
   *
   * With the list exhaustive, `Exclude<…>` is `never` and `Record<never, true>` is `{}`, so the empty object below
   * compiles. A code added to `ErrorDiagnosticCode` without a row above leaves the type non-empty, the annotation
   * demands that key, and the assignment stops compiling — which is earlier than any test could tell you.
   */
  const UNLISTED_ERROR_CODES: Record<
    Exclude<ErrorDiagnosticCode, (typeof ALWAYS_ERROR_CODES)[number]>,
    true
  > = {};

  it.each(Object.values(DiagnosticCode))("%s explains itself", (code) => {
    const text = GUIDANCE[code].describe(FACTS);

    // The `Record` over the code union guarantees an entry exists; this asserts the entry says something, and that no
    // branch of a multi-shape entry fell through with a hole in its sentence.
    expect(text.explanation.length).toBeGreaterThan(0);
    expect(text.explanation).not.toContain("undefined");
  });

  it.each(
    Object.values(DiagnosticCode).filter(
      (code) => GUIDANCE[code].severity === DiagnosticSeverity.Error,
    ),
  )("%s offers a remedy, because the reader can act on it", (code) => {
    // An error with no remedy is a dead end: it says the command stopped and gives the reader nothing to do next.
    expect(GUIDANCE[code].describe(FACTS).remediation).toBeDefined();
  });

  it.each(ALWAYS_ERROR_CODES)(
    "%s is an error, as the contract says",
    (code) => {
      expect(GUIDANCE[code].severity).toBe(DiagnosticSeverity.Error);
    },
  );

  it.each(
    Object.values(DiagnosticCode).filter(
      (code) => !(ALWAYS_ERROR_CODES as readonly string[]).includes(code),
    ),
  )(
    "%s is a warning, because the contract does not call it an error",
    (code) => {
      // The other direction, at runtime: a code outside the union must be advisory. Together with the case above this
      // is a biconditional over the current code set, and the coverage record closes the gap the pair cannot see.
      expect(GUIDANCE[code].severity).toBe(DiagnosticSeverity.Warning);
      expect(Object.keys(UNLISTED_ERROR_CODES)).toStrictEqual([]);
    },
  );

  it("maps every code to a category and a recoverability class", () => {
    // A finding without a severity is impossible by type; a code without a place in the error model is possible and
    // would surface as an exit code decided by whatever happened to be first. Worth one assertion over the union.
    for (const code of Object.values(DiagnosticCode)) {
      expect(GUIDANCE[code].severity).toBeDefined();
    }
  });
});

describe("the placement remedies", () => {
  /**
   * Facts with no configuration at all.
   *
   * Every case below varies exactly one placement fact, so the assertion names the cause rather than the wording of a
   * sentence four branches share.
   */
  const NO_CONFIGURATION = {
    root: "/project",
    workspaces: [],
    configurations: [],
    unsupportedConfigurations: [],
    misplacedConfigurations: [],
    occupiedConfigurationPaths: [],
    hasCypressDirectory: false,
  } as const;

  it("sends a reader to the file they already have when it is misplaced", () => {
    const text = GUIDANCE[DiagnosticCode.ConfigurationMissing].describe({
      ...NO_CONFIGURATION,
      misplacedConfigurations: ["cypress/cypress.config.ts"],
    });

    // The file exists. "Create cypress.config.ts" would create a second project instead of finding the first.
    expect(text.explanation).toContain("cypress/cypress.config.ts");
    expect(text.remediation).toContain("Move");
    expect(text.remediation).not.toContain("Create");
  });

  it("names the directory in the way rather than advising an impossible create", () => {
    const text = GUIDANCE[DiagnosticCode.ConfigurationMissing].describe({
      ...NO_CONFIGURATION,
      occupiedConfigurationPaths: ["cypress.config.ts"],
    });

    // The name is already taken by a directory, so "create cypress.config.ts" fails with EISDIR — advice that cannot
    // be followed, which is worse than no advice because it looks like a bug in the tool.
    expect(text.explanation).toContain("A directory occupies");
    expect(text.remediation).toContain("Rename or remove");
  });

  it("reports the occupying directory first when both are present", () => {
    const text = GUIDANCE[DiagnosticCode.ConfigurationMissing].describe({
      ...NO_CONFIGURATION,
      occupiedConfigurationPaths: ["cypress.config.ts"],
      misplacedConfigurations: ["cypress/cypress.config.ts"],
    });

    // A path that cannot be written to is the harder blocker: moving the file while the directory remains changes
    // nothing, so a message about the move would be advice that does not fix the problem.
    expect(text.explanation).toContain("A directory occupies");
    expect(text.explanation).not.toContain("not where Cypress looks");
  });

  it("still gives the general instruction when neither placement fact applies", () => {
    const text =
      GUIDANCE[DiagnosticCode.ConfigurationMissing].describe(NO_CONFIGURATION);

    // Both files, because naming only `.ts` sends a JavaScript project looking for a toolchain it does not need.
    expect(text.remediation).toContain("cypress.config.ts");
    expect(text.remediation).toContain("cypress.config.js");
  });
});

describe("edge and corner cases", () => {
  it("does not warn about a hoisted workspace install", async () => {
    const base = await makeTree({
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
      "packages/app/package.json": manifest(),
      "packages/app/cypress.config.ts": "",
    });

    const diagnosis = await diagnoseProject(join(base, "packages", "app"));

    // Hoisting is the normal shape for a member and `installation.source` already says so. A warning here would make
    // the most common monorepo layout the noisiest one.
    expect(diagnosis.framework.installation).toMatchObject({
      source: "workspace",
    });
    expect(diagnosis.findings).toStrictEqual([]);
  });

  it("puts blocking findings before warnings", async () => {
    const root = await makeTree({ "readme.md": "" });

    const diagnosis = await diagnoseProject(root);

    // Concrete rather than a sorted-copy comparison, which would pass for an empty array.
    expect(diagnosis.findings.map((finding) => finding.severity)).toStrictEqual(
      [DiagnosticSeverity.Error, DiagnosticSeverity.Warning],
    );
    expect(codesOf(diagnosis)).toStrictEqual([
      DiagnosticCode.FrameworkNotDetected,
      DiagnosticCode.ManifestMissing,
    ]);
  });

  it("is consistent at the minimum major and incompatible one below it", async () => {
    const atMinimum = await makeTree(
      healthy({
        "node_modules/cypress/package.json": JSON.stringify({
          name: "cypress",
          version: "10.0.0",
        }),
      }),
    );
    const below = await makeTree(
      healthy({
        "node_modules/cypress/package.json": JSON.stringify({
          name: "cypress",
          version: "9.7.0",
        }),
      }),
    );

    await expect(diagnoseProject(atMinimum)).resolves.toMatchObject({
      compatibility: CompatibilityStatus.Consistent,
    });
    await expect(diagnoseProject(below)).resolves.toMatchObject({
      compatibility: CompatibilityStatus.Incompatible,
    });
  });

  it("reports no incompatibility when there is no configuration to contradict", async () => {
    const root = await makeTree({
      "package.json": manifest({ devDependencies: { cypress: "^9.7.0" } }),
      "node_modules/cypress/package.json": JSON.stringify({
        name: "cypress",
        version: "9.7.0",
      }),
    });

    const diagnosis = await diagnoseProject(root);

    // Undetermined rather than incompatible: an old installation cannot contradict a configuration file that is not
    // there. Whether the version is *supported* is a different question, asked by the version policy.
    expect(diagnosis.compatibility).toBe(CompatibilityStatus.Undetermined);
    expect(codesOf(diagnosis)).not.toContain(
      DiagnosticCode.VersionIncompatible,
    );
  });
});

describe("non-functional behaviour", () => {
  it("does not modify the project tree", async () => {
    const root = await makeTree(healthy({ "package-lock.json": "{}" }));

    const before = await snapshot(root);
    await diagnoseProject(root);

    // Byte-identical, including modification times. A tool that rewrote a configuration while merely describing a
    // project would be untrustworthy even when its description was right.
    expect(await snapshot(root)).toStrictEqual(before);
  });

  it("is deterministic: two calls produce deeply equal results", async () => {
    const root = await makeTree(healthy());

    expect(await diagnoseProject(root)).toStrictEqual(
      await diagnoseProject(root),
    );
  });

  it("is deterministic from evidence alone, with no filesystem", async () => {
    const root = await makeTree(healthy());
    const detection = await detectCypress(root);

    // The property the extraction bought: a diagnosis can be built from a value, so a finding can be tested without a
    // tree and a second layer can describe the same evidence without reading it again.
    expect(diagnosisFrom(detection)).toStrictEqual(diagnosisFrom(detection));
  });

  it("keeps concurrent diagnoses independent", async () => {
    const first = await makeTree(
      healthy({ "package.json": manifest({ name: "alpha" }) }),
    );
    const second = await makeTree({
      "package.json": manifest({ name: "beta" }),
    });

    const [alpha, beta] = await Promise.all([
      diagnoseProject(first),
      diagnoseProject(second),
    ]);

    // A module-level cache would make one of these report the other's project.
    expect(alpha.identity.name).toBe("alpha");
    expect(alpha.detection).toBe(DetectionStatus.Detected);
    expect(beta.identity.name).toBe("beta");
    expect(beta.detection).toBe(DetectionStatus.NotDetected);
  });
});
