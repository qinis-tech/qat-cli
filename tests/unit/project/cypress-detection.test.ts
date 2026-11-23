import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ErrorCode } from "~/core/errors/index.js";
import {
  detectCypress,
  DetectionVerdict,
  MISPLACED_CONFIG_FILES,
} from "~/project/index.js";

/**
 * Fixtures are real temporary trees, for the same reason as everywhere else in this module: every question asked
 * here is "does this named file exist", which a fake would answer according to the same assumption the
 * implementation makes.
 *
 * ## The configuration filenames are written out, not imported
 *
 * The list below is the specification of what this tool reads. Deriving it from `CYPRESS_CONFIG_FILES` would make
 * the parameterised case pass for whatever the source happens to contain — including nothing — so a format removed
 * from the implementation would take its own test with it.
 */
const CONFIGURATION_FILES = [
  "cypress.config.ts",
  "cypress.config.mts",
  "cypress.config.cts",
  "cypress.config.js",
  "cypress.config.mjs",
  "cypress.config.cjs",
] as const;

const CYPRESS_MANIFEST = JSON.stringify({
  name: "cypress",
  version: "13.15.0",
});

let created: string[] = [];

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-detect-"));
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

/** A project that is a Cypress project in every respect, minus anything a test wants to vary. */
function cypressProject(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "package.json": manifest({ devDependencies: { cypress: "^13.15.0" } }),
    "cypress.config.ts": "export default {};",
    "cypress/e2e/smoke.cy.ts": "",
    "cypress/support/e2e.ts": "",
    "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    ...extra,
  };
}

/** Every file and directory under `root`, with size and modification time. Used to prove nothing was written. */
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

describe("a supported Cypress project", () => {
  it.each(CONFIGURATION_FILES)(
    "is detected when the configuration is %s",
    async (file) => {
      const root = await makeTree({ "package.json": manifest(), [file]: "" });

      const detection = await detectCypress(root);

      expect(detection.verdict).toBe(DetectionVerdict.Detected);
      expect(detection).toMatchObject({ configuration: file });
      expect(detection.configurations).toStrictEqual([file]);
    },
  );

  it("gathers every layout fact without letting any of them decide the verdict", async () => {
    const root = await makeTree(
      cypressProject({
        "cypress/screenshots/run.png": "",
        "cypress/videos/run.mp4": "",
      }),
    );

    const detection = await detectCypress(root);

    // One spec location, because `cypress` is a fallback rather than a candidate: it exists here only because
    // `cypress/e2e` is inside it, and reporting the parent alongside the child would point a run at the support
    // files as well as the specs.
    expect(detection.layout.specDirectories).toStrictEqual(["cypress/e2e"]);
    expect(detection.layout.supportFiles).toStrictEqual([
      "cypress/support/e2e.ts",
    ]);
    expect(detection.layout.screenshotsDirectory).toBe("cypress/screenshots");
    expect(detection.layout.videosDirectory).toBe("cypress/videos");
    expect(detection.layout.hasCypressDirectory).toBe(true);
    // Absent rather than empty, because there is no component directory to report. The pair of assertions below is
    // the ordinary case, not a special one.
    expect("componentDirectory" in detection.layout).toBe(false);
    expect(detection.layout.misplacedConfigurations).toStrictEqual([]);
    expect(detection.layout.occupiedConfigurationPaths).toStrictEqual([]);

    // Eight layout facts gathered, and the verdict is still the one the configuration file decided.
    expect(detection.verdict).toBe(DetectionVerdict.Detected);
  });

  it("omits layout fields for directories that do not exist", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "cypress.config.ts": "",
    });

    const { layout } = await detectCypress(root);

    // Absent, not present-and-undefined: the layout is serialised into a diagnostic document, and a null field
    // cannot be told apart from a directory that has no such folder.
    expect("screenshotsDirectory" in layout).toBe(false);
    expect("videosDirectory" in layout).toBe(false);
    expect("componentDirectory" in layout).toBe(false);
    // Present and empty, unlike the three above: a project with no `cypress/` directory has genuinely been
    // searched and genuinely has nothing misplaced.
    expect(layout.specDirectories).toStrictEqual([]);
    expect(layout.misplacedConfigurations).toStrictEqual([]);
    expect(layout.occupiedConfigurationPaths).toStrictEqual([]);
  });

  it("detects a project whose Cypress is declared but not installed", async () => {
    const root = await makeTree({
      "package.json": manifest({ devDependencies: { cypress: "^13.15.0" } }),
      "cypress.config.ts": "",
    });

    const detection = await detectCypress(root);

    // Identified, and not runnable. Detection reports the first fact; the missing dependency is the caller's
    // problem and a different code.
    expect(detection.verdict).toBe(DetectionVerdict.Detected);
    expect(detection.packages.installation).toBeUndefined();
    expect(detection.packages.declaration).toMatchObject({
      section: "devDependencies",
    });
  });
});

describe("layout evidence for shapes QAT cannot drive", () => {
  it("derives the misplaced names from the supported ones", () => {
    // The invariant behind the misplaced probe. Written against the literal list this file owns rather than against
    // `CYPRESS_CONFIG_FILES`, so it proves the derivation from the outside without a test being the reason to widen
    // a module's surface.
    for (const file of MISPLACED_CONFIG_FILES) {
      expect(file.startsWith("cypress/")).toBe(true);
      expect(CONFIGURATION_FILES).toContain(file.slice("cypress/".length));
    }

    expect(MISPLACED_CONFIG_FILES).toHaveLength(CONFIGURATION_FILES.length);
  });

  it("reports a component directory as evidence, separate from the spec location", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "cypress.config.ts": "",
      "cypress/component/widget.cy.ts": "",
    });

    const { layout } = await detectCypress(root);

    // The engine cannot tell a component-only project from a pre-10 one by directory names alone — `cypress/`
    // exists in both — so it reports the fallback *and* the component directory, and the validation layer decides.
    // Detection gathers; it does not judge.
    expect(layout.specDirectories).toStrictEqual(["cypress"]);
    expect(layout.componentDirectory).toBe("cypress/component");
  });

  it("reports the legacy fallback only when no named directory exists", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "cypress.config.ts": "",
      "cypress/smoke.cy.js": "",
    });

    const { layout } = await detectCypress(root);

    // The same `specDirectories` shape as the case above, and no component directory: this is what separates a
    // driveable pre-10 project from one whose only tests QAT cannot run.
    expect(layout.specDirectories).toStrictEqual(["cypress"]);
    expect("componentDirectory" in layout).toBe(false);
  });

  it("prefers a named directory to the legacy fallback", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "cypress.config.ts": "",
      "cypress/e2e/smoke.cy.ts": "",
      "cypress/legacy.cy.js": "",
    });

    // A repository part-way through migrating its specs. One answer, and it is the named directory — the fallback
    // describes a layout this project no longer has.
    expect((await detectCypress(root)).layout.specDirectories).toStrictEqual([
      "cypress/e2e",
    ]);
  });

  it("reports a configuration inside cypress/ as misplaced rather than as present", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "cypress/cypress.config.js": "module.exports = {};",
    });

    const detection = await detectCypress(root);

    // Detection is right to say there is no configuration: Cypress will not load one from there. This is the
    // evidence that turns "no configuration found" into a message naming the file the reader can see.
    expect(detection.configurations).toStrictEqual([]);
    expect(detection.layout.misplacedConfigurations).toStrictEqual([
      "cypress/cypress.config.js",
    ]);
    expect(detection.verdict).toBe(DetectionVerdict.Incomplete);
  });

  it("reports a directory occupying a configuration filename", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "cypress/e2e/smoke.cy.ts": "",
    });

    // A directory where the tool expects a file. A file probe cannot see it, which is exactly why the evidence has
    // to be gathered separately — and `.js` rather than `.ts`, to prove the whole candidate list is probed.
    await mkdir(join(root, "cypress.config.js"), { recursive: true });

    const detection = await detectCypress(root);

    expect(detection.configurations).toStrictEqual([]);
    expect(detection.layout.occupiedConfigurationPaths).toStrictEqual([
      "cypress.config.js",
    ]);
  });

  it("reports an occupied name even when the project works", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "cypress.config.ts": "",
      "cypress/e2e/smoke.cy.ts": "",
    });

    await mkdir(join(root, "cypress.config.js"), { recursive: true });

    const detection = await detectCypress(root);

    // Evidence, not a verdict. The project loads `cypress.config.ts` and is detected; the squatting directory is
    // reported because evidence that is withheld when it looks harmless is evidence nobody can act on.
    expect(detection.verdict).toBe(DetectionVerdict.Detected);

    // `configuration` lives only on the detected variant, so it is read through `toMatchObject` rather than by
    // property access: a vitest assertion does not narrow a union, and writing `detection.configuration` would
    // need a real `if` first. The shape match states the same fact without the ceremony.
    expect(detection).toMatchObject({ configuration: "cypress.config.ts" });
    expect(detection.layout.occupiedConfigurationPaths).toStrictEqual([
      "cypress.config.js",
    ]);
  });
});

describe("version", () => {
  it("reports the installed version and the declaration range separately", async () => {
    const root = await makeTree(cypressProject());

    const detection = await detectCypress(root);

    expect(detection.packages.installation?.version).toBe("13.15.0");
    expect(detection.packages.declaration?.range).toBe("^13.15.0");
  });

  it("reports no version when Cypress is not installed", async () => {
    const root = await makeTree({
      "package.json": manifest({ devDependencies: { cypress: "^13.15.0" } }),
      "cypress.config.ts": "",
    });

    const detection = await detectCypress(root);

    // A range is what was asked for; a version is what was delivered. Nothing has reported the second.
    expect(detection.packages.installation).toBeUndefined();
  });
});

describe("absence", () => {
  it("reports an unrelated Node project as absent", async () => {
    const root = await makeTree({
      "package.json": manifest({ dependencies: { react: "^19.0.0" } }),
      "src/index.ts": "",
    });

    // The false positive this rule exists to prevent: a manifest and a source directory are not evidence of a
    // Cypress project. If a manifest counted, every npm project would be an incomplete Cypress project.
    expect((await detectCypress(root)).verdict).toBe(DetectionVerdict.Absent);
  });

  it("reports a directory with nothing in it as absent", async () => {
    const root = await makeTree({});

    await expect(detectCypress(root)).resolves.toMatchObject({
      verdict: DetectionVerdict.Absent,
    });
  });

  it("treats an installed Cypress with no other evidence as incomplete, not absent", async () => {
    const root = await makeTree({
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    });

    await expect(detectCypress(root)).resolves.toMatchObject({
      verdict: DetectionVerdict.Incomplete,
    });
  });
});

describe("incomplete", () => {
  it("reports a declared dependency with no configuration file", async () => {
    const root = await makeTree({
      "package.json": manifest({ devDependencies: { cypress: "^13.15.0" } }),
    });

    const detection = await detectCypress(root);

    expect(detection.verdict).toBe(DetectionVerdict.Incomplete);
    expect(detection.packages.declaration).toBeDefined();
  });

  it("reports a conventional cypress directory with no configuration file", async () => {
    const root = await makeTree({ "cypress/e2e/smoke.cy.ts": "" });

    const detection = await detectCypress(root);

    // Evidence without a manifest and without an install: the directory is Cypress-shaped, so "not a Cypress
    // project" would be the wrong message.
    expect(detection.verdict).toBe(DetectionVerdict.Incomplete);
    expect(detection.layout.hasCypressDirectory).toBe(true);
  });
});

describe("ambiguity", () => {
  it("reports two supported configurations as ambiguous and keeps both, in candidate order", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "cypress.config.ts": "",
      "cypress.config.js": "",
    });

    const detection = await detectCypress(root);

    expect(detection.verdict).toBe(DetectionVerdict.Ambiguous);
    // Candidate order, not directory order: `ts` precedes `js` in the shared list, so the message is stable on any
    // filesystem.
    expect(detection.configurations).toStrictEqual([
      "cypress.config.ts",
      "cypress.config.js",
    ]);
  });
});

describe("unsupported formats", () => {
  it("reports a legacy cypress.json as unsupported rather than absent", async () => {
    const root = await makeTree({
      "package.json": manifest({ devDependencies: { cypress: "^9.7.0" } }),
      "cypress.json": "{}",
      "node_modules/cypress/package.json": JSON.stringify({
        name: "cypress",
        version: "9.7.0",
      }),
    });

    const detection = await detectCypress(root);

    // A Cypress project QAT cannot drive. Saying "absent" would send its owner to the wrong remedy: they need to
    // upgrade, not to move.
    expect(detection.verdict).toBe(DetectionVerdict.Unsupported);
    expect(detection.unsupportedConfigurations).toStrictEqual(["cypress.json"]);
    expect(detection.configurations).toStrictEqual([]);
  });

  it("reports a legacy cypress.json with no manifest at all as unsupported", async () => {
    const root = await makeTree({ "cypress.json": "{}" });

    await expect(detectCypress(root)).resolves.toMatchObject({
      verdict: DetectionVerdict.Unsupported,
    });
  });

  it("detects a project that holds both a supported and a legacy configuration", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "cypress.config.ts": "",
      "cypress.json": "{}",
    });

    const detection = await detectCypress(root);

    // A migration in progress is a working project. The stale file stays in the evidence so a caller can mention
    // it without treating it as a failure.
    expect(detection.verdict).toBe(DetectionVerdict.Detected);
    expect(detection.unsupportedConfigurations).toStrictEqual(["cypress.json"]);
  });
});

describe("boundaries", () => {
  it("finds a hoisted install exactly at the depth boundary and not one level further", async () => {
    const base = await makeTree({
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
      "a/b/package.json": manifest(),
      "a/b/cypress.config.ts": "",
    });

    const nested = join(base, "a", "b");

    await expect(detectCypress(nested, { maxDepth: 2 })).resolves.toMatchObject(
      {
        verdict: DetectionVerdict.Detected,
      },
    );

    // Detected either way, because the configuration is local; the difference is whether the install was found.
    const short = await detectCypress(nested, { maxDepth: 1 });
    expect(short.packages.installation).toBeUndefined();
  });

  it("finds a misplaced configuration only at the fixed depth it probes", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "cypress/cypress.config.ts": "",
      // One level deeper than the probe looks. Recorded rather than fixed: finding this would mean listing a
      // directory, and the determinism rule is worth more than the coverage.
      "cypress/nested/cypress.config.ts": "",
    });

    expect(
      (await detectCypress(root)).layout.misplacedConfigurations,
    ).toStrictEqual(["cypress/cypress.config.ts"]);
  });
});

describe("non-functional behaviour", () => {
  it("does not modify the project tree", async () => {
    const root = await makeTree(cypressProject({ "package-lock.json": "{}" }));

    const before = await snapshot(root);
    await detectCypress(root);
    const after = await snapshot(root);

    // Byte-identical, including modification times: detection reads and nothing else. A tool that quietly rewrote
    // a configuration while merely inspecting a project would be untrustworthy even if it were right.
    expect(after).toStrictEqual(before);
  });

  it("does not require an executable Cypress to be present", async () => {
    // The installed manifest declares no `bin` and no binary exists, so anything that ran Cypress would fail.
    // Detection succeeds, which is the observable form of "it did not launch it".
    const root = await makeTree(
      cypressProject({
        "node_modules/cypress/package.json": JSON.stringify({
          name: "cypress",
          version: "13.15.0",
        }),
      }),
    );

    await expect(detectCypress(root)).resolves.toMatchObject({
      verdict: DetectionVerdict.Detected,
    });
  });

  it("is deterministic: two calls produce deeply equal results", async () => {
    const root = await makeTree(cypressProject());

    // Eight probes per call now, run concurrently — `Promise.all` preserves input order, so the evidence and the
    // verdict are identical however the filesystem completes them.
    expect(await detectCypress(root)).toStrictEqual(await detectCypress(root));
  });

  it("keeps concurrent detections independent", async () => {
    const first = await makeTree(
      cypressProject({ "package.json": manifest({ name: "alpha" }) }),
    );
    const second = await makeTree({
      "package.json": manifest({ name: "beta" }),
    });

    const [alpha, beta] = await Promise.all([
      detectCypress(first),
      detectCypress(second),
    ]);

    // A module-level cache would make one of these report the other's project.
    expect(alpha.verdict).toBe(DetectionVerdict.Detected);
    expect(beta.verdict).toBe(DetectionVerdict.Absent);
  });

  it("propagates an unreadable manifest rather than reporting absence", async () => {
    const root = await makeTree({
      "package.json": '{ "name": ',
      "cypress.config.ts": "",
    });

    // A broken file is an error; a missing one is an answer. Conflating them would report a stray comma as "this is
    // not a Cypress project".
    await expect(detectCypress(root)).rejects.toMatchObject({
      code: ErrorCode.filesystemInvalidJson,
    });
  });
});
