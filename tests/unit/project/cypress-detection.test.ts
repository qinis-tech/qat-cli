import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ErrorCode } from "~/core/errors/index.js";
import { detectCypress, DetectionVerdict } from "~/project/index.js";

/**
 * Fixtures are real temporary trees, for the same reason as everywhere else in this module: every question asked
 * here is "does this named file exist", which a fake would answer according to the same assumption the
 * implementation makes.
 */
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
  it.each([
    "cypress.config.ts",
    "cypress.config.mts",
    "cypress.config.cts",
    "cypress.config.js",
    "cypress.config.mjs",
    "cypress.config.cjs",
  ])("is detected when the configuration is %s", async (file) => {
    const root = await makeTree({ "package.json": manifest(), [file]: "" });

    const detection = await detectCypress(root);

    expect(detection.verdict).toBe(DetectionVerdict.Detected);
    expect(detection).toMatchObject({ configuration: file });
    expect(detection.configurations).toStrictEqual([file]);
  });

  it("gathers layout evidence without letting it decide the verdict", async () => {
    const root = await makeTree(
      cypressProject({
        "cypress/screenshots/run.png": "",
        "cypress/videos/run.mp4": "",
      }),
    );

    const detection = await detectCypress(root);

    // `cypress` is itself a spec-directory candidate — the layout where specs sit directly under it — so creating
    // `cypress/e2e` makes both match. Candidate order, because this is evidence rather than a choice.
    expect(detection.layout.specDirectories).toStrictEqual([
      "cypress/e2e",
      "cypress",
    ]);
    expect(detection.layout.supportFiles).toStrictEqual([
      "cypress/support/e2e.ts",
    ]);
    expect(detection.layout.screenshotsDirectory).toBe("cypress/screenshots");
    expect(detection.layout.videosDirectory).toBe("cypress/videos");
    expect(detection.layout.hasCypressDirectory).toBe(true);

    // Five layout facts gathered, and the verdict is still the one the configuration file decided.
    expect(detection.verdict).toBe(DetectionVerdict.Detected);
  });

  it("does not report a component-testing directory, which is not a spec-directory candidate", async () => {
    // Cypress supports component testing under `cypress/component`, and no candidate list includes it — so a
    // component-only project falls back to `cypress` as its spec root. Recorded rather than fixed: the project
    // description carries one spec directory, and deciding what a second root means is a product question with a
    // domain change behind it.
    const root = await makeTree({
      "package.json": manifest(),
      "cypress.config.ts": "",
      "cypress/component/widget.cy.ts": "",
    });

    const detection = await detectCypress(root);

    expect(detection.layout.specDirectories).toStrictEqual(["cypress"]);
  });

  it("omits layout fields for directories that do not exist", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "cypress.config.ts": "",
    });

    const { layout } = await detectCypress(root);

    // Absent, not present-and-undefined: the layout is serialised into a diagnostic document.
    expect("screenshotsDirectory" in layout).toBe(false);
    expect("videosDirectory" in layout).toBe(false);
    expect(layout.specDirectories).toStrictEqual([]);
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

    const detection = await detectCypress(root);

    // The false positive this rule exists to prevent: a manifest and a source directory are not evidence of a
    // Cypress project.
    expect(detection.verdict).toBe(DetectionVerdict.Absent);
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

    // A Cypress project QAT cannot drive. Saying "absent" would send its owner to the wrong remedy.
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
  it("does not report a component-testing directory, which is not a spec-directory candidate", async () => {
    // Cypress supports component testing under `cypress/component`, and no candidate list includes it — so a
    // component-only project falls back to `cypress` as its spec root. Recorded rather than fixed: the project
    // description carries one spec directory, and deciding what a second root means is a product question with a
    // domain change behind it.
    const root = await makeTree({
      "package.json": manifest(),
      "cypress.config.ts": "",
      "cypress/component/widget.cy.ts": "",
    });

    const detection = await detectCypress(root);

    expect(detection.layout.specDirectories).toStrictEqual(["cypress"]);
  });

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
});

describe("non-functional behaviour", () => {
  it("does not modify the project tree", async () => {
    const root = await makeTree(cypressProject({ "package-lock.json": "{}" }));

    const before = await snapshot(root);
    await detectCypress(root);
    const after = await snapshot(root);

    // Byte-identical, including modification times: detection reads and nothing else. A tool that quietly
    // rewrote a configuration while merely inspecting a project would be untrustworthy even if it were right.
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
