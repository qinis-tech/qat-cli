import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ErrorCode,
  isApplicationError,
  type ApplicationError,
} from "~/core/errors/index.js";
import { discoverProject } from "~/project/index.js";

/**
 * Projects are built as real temporary trees rather than mocked filesystems.
 *
 * Discovery is almost entirely "does this named file exist", which a fake would answer according to the same
 * assumption the implementation makes — so a fake would agree with a wrong implementation.
 */
const CYPRESS_MANIFEST = JSON.stringify({
  name: "cypress",
  version: "13.15.0",
});

let created: string[] = [];

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-project-"));
  created.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  return root;
}

/**
 * The minimum that makes a directory a runnable Cypress project.
 *
 * Cypress is present in `node_modules` but deliberately **not** declared in the manifest. That is the shape a
 * workspace member and a project with a hoisted install both have, and it is the case where declaration and
 * installation genuinely differ — so the default fixture exercises the interesting half of the split rather than
 * the easy one. Tests that need a declaration add one.
 */
function cypressFiles(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }),
    "cypress.config.ts": "export default {};",
    "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    ...extra,
  };
}

/**
 * Runs a call that is expected to fail, and returns the error it produced.
 *
 * The type guard rather than a cast: if the call starts succeeding, the failure reads "expected an application
 * error, received undefined" instead of a `TypeError` about reading `code` of undefined three lines later.
 */
async function failure(run: Promise<unknown>): Promise<ApplicationError> {
  const caught: unknown = await run.then(
    () => undefined,
    (error: unknown) => error,
  );

  if (!isApplicationError(caught)) {
    throw new Error(
      `Expected an application error, received ${String(caught)}.`,
    );
  }

  return caught;
}

afterEach(async () => {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
  created = [];
});

describe("a conventional project", () => {
  it("is discovered from an explicit directory", async () => {
    const root = await makeProject(cypressFiles());

    const context = await discoverProject({ cwd: root });

    expect(context.root).toBe(root);
    expect(context.name).toBe("demo");
    expect(context.framework).toBe("cypress");
    expect(context.installation.version).toBe("13.15.0");
    expect(context.installation.source).toBe("project");
    expect(context.paths.configFile).toBe("cypress.config.ts");
  });

  it("resolves a relative directory against the working directory", async () => {
    const root = await makeProject(cypressFiles());

    // Expressed relative to wherever the runner is, which is exactly what the option promises to resolve against.
    // No `chdir`, so the process working directory stays untouched and this test cannot interfere with the one
    // asserting that it does.
    const relativeCwd = relative(process.cwd(), root);

    const context = await discoverProject({ cwd: relativeCwd });

    expect(context.root).toBe(root);
    expect(context.paths.configFile).toBe("cypress.config.ts");
  });

  it("records the spec directory, support file and source directory that exist", async () => {
    const root = await makeProject(
      cypressFiles({
        "cypress/e2e/smoke.cy.ts": "",
        "cypress/support/e2e.ts": "",
        "src/index.ts": "",
      }),
    );

    const { paths } = await discoverProject({ cwd: root });

    expect(paths.specsDirectory).toBe("cypress/e2e");
    expect(paths.supportFile).toBe("cypress/support/e2e.ts");
    expect(paths.sourceDirectory).toBe("src");
  });

  it("falls back to the conventional spec directory when none exists", async () => {
    const root = await makeProject(cypressFiles());

    const { paths } = await discoverProject({ cwd: root });

    // The layout reports no candidates at all, and the fallback is the first conventional name rather than an
    // empty string — a project with no specs yet is still a project.
    expect(paths.specsDirectory).toBe("cypress/e2e");
    expect(paths.supportFile).toBeUndefined();
    expect(paths.sourceDirectory).toBeUndefined();
  });

  it("omits screenshot and video directories that do not exist", async () => {
    const root = await makeProject(cypressFiles());

    const { paths } = await discoverProject({ cwd: root });

    // Absent, not present-and-undefined: the context is compared and serialised.
    expect("screenshotsDirectory" in paths).toBe(false);
    expect("videosDirectory" in paths).toBe(false);
  });
});

describe("package manager detection", () => {
  it("infers npm from a lockfile and marks it as inferred", async () => {
    const root = await makeProject(cypressFiles({ "package-lock.json": "{}" }));

    const { packageManager } = await discoverProject({ cwd: root });

    expect(packageManager).toStrictEqual({
      name: "npm",
      declared: false,
      lockfile: "package-lock.json",
    });
  });

  it("prefers a declared manager over a lockfile", async () => {
    const root = await makeProject(
      cypressFiles({
        "package.json": JSON.stringify({
          name: "demo",
          version: "1.0.0",
          packageManager: "pnpm@9.1.0",
        }),
        "package-lock.json": "{}",
      }),
    );

    const { packageManager } = await discoverProject({ cwd: root });

    expect(packageManager).toStrictEqual({ name: "pnpm", declared: true });
  });

  it("reports no manager when there is neither a declaration nor a lockfile", async () => {
    const root = await makeProject(cypressFiles());

    const { packageManager } = await discoverProject({ cwd: root });

    expect(packageManager).toBeUndefined();
  });
});

describe("framework declaration", () => {
  it("records where the framework was declared alongside where it is installed", async () => {
    const root = await makeProject(
      cypressFiles({
        "package.json": JSON.stringify({
          name: "demo",
          version: "1.0.0",
          devDependencies: { cypress: "^13.15.0" },
        }),
      }),
    );

    const context = await discoverProject({ cwd: root });

    // Two facts, two fields. A single merged answer could not report both of these at once.
    expect(context.frameworkDeclaration).toStrictEqual({
      section: "devDependencies",
      range: "^13.15.0",
    });
    expect(context.installation).toMatchObject({
      version: "13.15.0",
      source: "project",
    });
  });

  it("omits the declaration when the manifest does not name the framework", async () => {
    const root = await makeProject(cypressFiles());

    const context = await discoverProject({ cwd: root });

    // Absent, not undefined: a hoisted workspace install declares nothing, and the context is serialised.
    expect("frameworkDeclaration" in context).toBe(false);
    expect(context.installation.source).toBe("project");
  });

  it("prefers the runtime declaration when the manifest names it twice", async () => {
    const root = await makeProject(
      cypressFiles({
        "package.json": JSON.stringify({
          name: "demo",
          version: "1.0.0",
          dependencies: { cypress: "^13.0.0" },
          devDependencies: { cypress: "^12.0.0" },
        }),
      }),
    );

    const { frameworkDeclaration } = await discoverProject({ cwd: root });

    expect(frameworkDeclaration).toMatchObject({ section: "dependencies" });
  });
});

describe("invalid and missing information", () => {
  it("rejects a path that is a file", async () => {
    const root = await makeProject({ "notes.txt": "" });

    const error = await failure(
      discoverProject({ cwd: join(root, "notes.txt") }),
    );

    expect(error.code).toBe(ErrorCode.invalidArgument);
  });

  it("rejects a path that does not exist", async () => {
    const root = await makeProject({});

    const error = await failure(discoverProject({ cwd: join(root, "absent") }));

    expect(error.code).toBe(ErrorCode.invalidArgument);
  });

  it("reports a directory with no project markers", async () => {
    const root = await makeProject({ "readme.md": "" });

    const error = await failure(discoverProject({ cwd: root }));

    expect(error.code).toBe(ErrorCode.projectNotFound);
  });

  it("reports a project with no Cypress indicators at all as having no configuration", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "x", version: "1" }),
    });

    const error = await failure(discoverProject({ cwd: root }));

    // Nothing Cypress-shaped: the message is about the configuration, and the remedy is the one for a project that
    // might be the wrong directory.
    expect(error.code).toBe(ErrorCode.frameworkNotDetected);
    expect(error.message).toContain("No Cypress configuration was found");
    expect(error.remediation).toContain("cypress.config.ts");
  });

  it("names an installed Cypress when the configuration file is missing", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    });

    const error = await failure(discoverProject({ cwd: root }));

    // A different diagnosis from "not a Cypress project", and a different next step: one file to create, not a
    // different directory to find.
    expect(error.code).toBe(ErrorCode.frameworkNotDetected);
    expect(error.message).toContain("13.15.0 is installed in");
    expect(error.message).toContain("no configuration file");
  });

  it("names a declared Cypress when the configuration file is missing", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({
        name: "x",
        version: "1.0.0",
        devDependencies: { cypress: "^13.15.0" },
      }),
    });

    const error = await failure(discoverProject({ cwd: root }));

    expect(error.code).toBe(ErrorCode.frameworkNotDetected);
    expect(error.message).toContain("declared in devDependencies");
    expect(error.message).toContain("no configuration file");
  });

  it("names a conventional cypress directory when the configuration file is missing", async () => {
    const root = await makeProject({
      // The manifest carries no Cypress dependency, so the directory is the only evidence. It is also what makes the
      // directory a project root at all — without it the failure is QAT2001, before detection is reached.
      "package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
      "cypress/e2e/smoke.cy.ts": "",
    });

    const error = await failure(discoverProject({ cwd: root }));

    expect(error.code).toBe(ErrorCode.frameworkNotDetected);
    expect(error.message).toContain("A cypress directory was found");
  });

  it("reports a configured framework that is not installed", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "x", version: "1" }),
      "cypress.config.ts": "export default {};",
    });

    const error = await failure(discoverProject({ cwd: root }));

    expect(error.code).toBe(ErrorCode.dependencyMissing);
  });

  it("says the framework is declared but not installed when the manifest names it", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({
        name: "x",
        version: "1.0.0",
        devDependencies: { cypress: "^13.15.0" },
      }),
      "cypress.config.ts": "export default {};",
    });

    const error = await failure(discoverProject({ cwd: root }));

    expect(error.code).toBe(ErrorCode.dependencyMissing);
    // Naming the section is the whole point: it tells the reader the package is one install command away rather
    // than absent from the project entirely.
    expect(error.message).toContain("declared in devDependencies");
    expect(error.context).toMatchObject({
      declaredIn: "devDependencies",
      declaredRange: "^13.15.0",
    });
  });

  it("says nothing is declared when the manifest does not mention the framework", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
      "cypress.config.ts": "export default {};",
    });

    const error = await failure(discoverProject({ cwd: root }));

    expect(error.message).toContain("No Cypress dependency is declared");
    // No `declaredIn` key at all, rather than one set to undefined.
    expect("declaredIn" in error.context).toBe(false);
  });

  it("reports more than one configuration as ambiguous rather than picking one", async () => {
    const root = await makeProject(
      cypressFiles({ "cypress.config.js": "module.exports = {};" }),
    );

    const error = await failure(discoverProject({ cwd: root }));

    expect(error.code).toBe(ErrorCode.projectAmbiguous);
    // Candidate order, not directory order: `ts` precedes `js` in the shared list, so the message is stable on any
    // filesystem.
    expect(error.context).toMatchObject({
      configFiles: "cypress.config.ts, cypress.config.js",
    });
  });

  it("reports a legacy cypress.json as an unsupported configuration, not a missing one", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
      "cypress.json": "{}",
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    });

    const error = await failure(discoverProject({ cwd: root }));

    // This is a Cypress project. Telling its owner they are in the wrong directory would send them looking for
    // something that is already there; the remedy is an upgrade.
    expect(error.code).toBe(ErrorCode.frameworkUnsupported);
    expect(error.message).toContain("cypress.json");
    expect(error.remediation).toContain("cypress.config.ts");
  });

  it("surfaces a malformed package.json as a structured error", async () => {
    const root = await makeProject(
      cypressFiles({ "package.json": '{ "name": ' }),
    );

    const error = await failure(discoverProject({ cwd: root }));

    // Reported before the configuration is judged, because a manifest that will not parse blocks everything behind
    // it. Asking the reader to create a configuration file first would only postpone the real error.
    expect(error.code).toBe(ErrorCode.filesystemInvalidJson);
    expect(error.remediation).toBeDefined();
  });
});

describe("edges and boundaries", () => {
  it("names the project after its directory when there is no package.json", async () => {
    const root = await makeProject({
      "cypress.config.js": "module.exports = {};",
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    });

    const context = await discoverProject({ cwd: root });

    expect(context.name).toContain("qat-project-");
    expect("packageMetadata" in context).toBe(false);
  });

  it("does not fail when the manifest exists but declares no name or version", async () => {
    const root = await makeProject(
      cypressFiles({ "package.json": JSON.stringify({ private: true }) }),
    );

    const context = await discoverProject({ cwd: root });

    // Metadata absent, project still described. A partially described package is worse than an absent one, because
    // downstream code would print `undefined`.
    expect("packageMetadata" in context).toBe(false);
    expect(context.name).toContain("qat-project-");
  });

  it("accepts a project part-way through migrating its configuration", async () => {
    const root = await makeProject(
      cypressFiles({
        "cypress.config.ts": "export default {};",
        "cypress.json": "{}",
      }),
    );

    // Both formats present. The supported one wins, because the project still works — the stale file is evidence
    // for a diagnostic, not a reason to refuse.
    await expect(discoverProject({ cwd: root })).resolves.toMatchObject({
      paths: { configFile: "cypress.config.ts" },
    });
  });

  it("finds an installation hoisted to a workspace root", async () => {
    const base = await mkdtemp(join(tmpdir(), "qat-workspace-"));
    created.push(base);

    const root = join(base, "packages", "app");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "app", version: "1.0.0" }),
    );
    await writeFile(join(root, "cypress.config.ts"), "export default {};");
    await mkdir(join(base, "node_modules", "cypress"), { recursive: true });
    await writeFile(
      join(base, "node_modules", "cypress", "package.json"),
      CYPRESS_MANIFEST,
    );

    const context = await discoverProject({ cwd: root });

    expect(context.installation.source).toBe("workspace");
    // The member does not declare the framework itself, which is the ordinary hoisted shape.
    expect("frameworkDeclaration" in context).toBe(false);
  });

  it("suggests the package directory when the root declares workspaces and has no configuration", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({
        name: "root",
        version: "1.0.0",
        workspaces: ["packages/*"],
      }),
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    });

    const error = await failure(discoverProject({ cwd: root }));

    // Running at a workspace root is a mistake that otherwise reads like a missing project. Naming the patterns
    // turns it into a one-line fix without descending into them — expanding globs would mean choosing a package on
    // the reader's behalf.
    expect(error.code).toBe(ErrorCode.frameworkNotDetected);
    expect(error.remediation).toContain("workspace root");
    expect(error.remediation).toContain("packages/*");
  });

  it("does not ascend when parent search was not requested", async () => {
    const base = await mkdtemp(join(tmpdir(), "qat-root-"));
    created.push(base);
    await writeFile(
      join(base, "package.json"),
      JSON.stringify({ name: "root", version: "1.0.0" }),
    );

    const nested = join(base, "nested");
    await mkdir(nested, { recursive: true });

    const error = await failure(discoverProject({ cwd: nested }));

    // Ascending silently would report a project the caller did not know they were inside.
    expect(error.code).toBe(ErrorCode.projectNotFound);
  });

  it("ascends to the root when asked", async () => {
    const base = await mkdtemp(join(tmpdir(), "qat-root-"));
    created.push(base);
    await writeFile(
      join(base, "package.json"),
      JSON.stringify({ name: "root", version: "1.0.0" }),
    );
    await writeFile(join(base, "cypress.config.ts"), "export default {};");
    await mkdir(join(base, "node_modules", "cypress"), { recursive: true });
    await writeFile(
      join(base, "node_modules", "cypress", "package.json"),
      CYPRESS_MANIFEST,
    );

    const nested = join(base, "a", "b");
    await mkdir(nested, { recursive: true });

    const context = await discoverProject({ cwd: nested, searchParents: true });

    expect(context.root).toBe(base);
  });

  it("treats a depth of zero as the starting directory only", async () => {
    const base = await mkdtemp(join(tmpdir(), "qat-root-"));
    created.push(base);
    await writeFile(
      join(base, "package.json"),
      JSON.stringify({ name: "root", version: "1.0.0" }),
    );
    const nested = join(base, "nested");
    await mkdir(nested, { recursive: true });

    const error = await failure(
      discoverProject({ cwd: nested, searchParents: true, maxParentDepth: 0 }),
    );

    expect(error.code).toBe(ErrorCode.projectNotFound);
    expect(error.context).toMatchObject({ searchedDepth: 0 });
  });

  it("finds a root exactly at the configured depth and not one level further", async () => {
    const base = await mkdtemp(join(tmpdir(), "qat-root-"));
    created.push(base);
    await writeFile(
      join(base, "package.json"),
      JSON.stringify({ name: "root", version: "1.0.0" }),
    );
    await writeFile(join(base, "cypress.config.ts"), "export default {};");
    await mkdir(join(base, "node_modules", "cypress"), { recursive: true });
    await writeFile(
      join(base, "node_modules", "cypress", "package.json"),
      CYPRESS_MANIFEST,
    );

    const twoDown = join(base, "one", "two");
    await mkdir(twoDown, { recursive: true });

    await expect(
      discoverProject({ cwd: twoDown, searchParents: true, maxParentDepth: 2 }),
    ).resolves.toMatchObject({ root: base });

    await expect(
      failure(
        discoverProject({
          cwd: twoDown,
          searchParents: true,
          maxParentDepth: 1,
        }),
      ),
    ).resolves.toMatchObject({ code: ErrorCode.projectNotFound });
  });
});

describe("non-functional behaviour", () => {
  it("is deterministic: two discoveries produce deeply equal contexts", async () => {
    const root = await makeProject(
      cypressFiles({
        "cypress/e2e/a.cy.ts": "",
        "package.json": JSON.stringify({
          name: "demo",
          version: "1.0.0",
          devDependencies: { cypress: "^13.15.0" },
        }),
      }),
    );

    const first = await discoverProject({ cwd: root });
    const second = await discoverProject({ cwd: root });

    // No timestamp and no iteration-order dependence is what makes this assertion possible — including for the
    // declaration, which is derived from an object whose key order the manifest chose.
    expect(second).toStrictEqual(first);
  });

  it("does not mutate the process working directory", async () => {
    const before = process.cwd();
    const root = await makeProject(cypressFiles());

    await discoverProject({ cwd: root });

    expect(process.cwd()).toBe(before);
  });

  it("keeps concurrent discoveries independent", async () => {
    const first = await makeProject(
      cypressFiles({
        "package.json": JSON.stringify({ name: "alpha", version: "1.0.0" }),
      }),
    );
    const second = await makeProject(
      cypressFiles({
        "package.json": JSON.stringify({ name: "beta", version: "2.0.0" }),
      }),
    );

    const [alpha, beta] = await Promise.all([
      discoverProject({ cwd: first }),
      discoverProject({ cwd: second }),
    ]);

    // A module-level cache would make one of these report the other's project.
    expect(alpha.name).toBe("alpha");
    expect(beta.name).toBe("beta");
  });

  it("is unaffected by an earlier failed discovery", async () => {
    const root = await makeProject({ "readme.md": "" });
    await failure(discoverProject({ cwd: root }));

    const valid = await makeProject(cypressFiles());

    await expect(discoverProject({ cwd: valid })).resolves.toMatchObject({
      name: "demo",
    });
  });
});
