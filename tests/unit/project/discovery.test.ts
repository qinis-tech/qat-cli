import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ErrorCode } from "~/core/errors/index.js";
import { discoverProject } from "~/project/index.js";

/**
 * Projects are built as real temporary trees rather than mocked filesystems.
 *
 * Discovery is almost entirely "does this named file exist", which a fake would answer according to
 * the same assumption the implementation makes — so a fake would agree with a wrong implementation.
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

/** The minimum that makes a directory a runnable Cypress project. */
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

async function failure(
  run: Promise<unknown>,
): Promise<Record<string, unknown>> {
  const caught = await run.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(caught).toBeInstanceOf(Error);

  return caught as Record<string, unknown>;
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

    // Expressed relative to wherever the runner is, which is exactly what the option promises to
    // resolve against. No `chdir`, so the process working directory stays untouched and this test
    // cannot interfere with the one asserting that it does.
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

describe("invalid and missing information", () => {
  it("rejects a path that is a file", async () => {
    const root = await makeProject({ "notes.txt": "" });

    const error = await failure(
      discoverProject({ cwd: join(root, "notes.txt") }),
    );

    expect(error["code"]).toBe(ErrorCode.invalidArgument);
  });

  it("rejects a path that does not exist", async () => {
    const root = await makeProject({});

    const error = await failure(discoverProject({ cwd: join(root, "absent") }));

    expect(error["code"]).toBe(ErrorCode.invalidArgument);
  });

  it("reports a directory with no project markers", async () => {
    const root = await makeProject({ "readme.md": "" });

    const error = await failure(discoverProject({ cwd: root }));

    expect(error["code"]).toBe(ErrorCode.projectNotFound);
  });

  it("reports a project with no framework configuration", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "x", version: "1" }),
    });

    const error = await failure(discoverProject({ cwd: root }));

    expect(error["code"]).toBe(ErrorCode.frameworkNotDetected);
  });

  it("reports a configured framework that is not installed", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "x", version: "1" }),
      "cypress.config.ts": "export default {};",
    });

    const error = await failure(discoverProject({ cwd: root }));

    expect(error["code"]).toBe(ErrorCode.dependencyMissing);
  });

  it("reports more than one configuration as ambiguous rather than picking one", async () => {
    const root = await makeProject(
      cypressFiles({ "cypress.config.js": "module.exports = {};" }),
    );

    const error = await failure(discoverProject({ cwd: root }));

    expect(error["code"]).toBe(ErrorCode.projectAmbiguous);
    expect(error["context"]).toMatchObject({
      configFiles: "cypress.config.ts, cypress.config.js",
    });
  });

  it("surfaces a malformed package.json as a structured error", async () => {
    const root = await makeProject(
      cypressFiles({ "package.json": '{ "name": ' }),
    );

    const error = await failure(discoverProject({ cwd: root }));

    expect(error["code"]).toBe(ErrorCode.filesystemInvalidJson);
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
    expect(error["code"]).toBe(ErrorCode.projectNotFound);
  });

  it("ascends to the root when asked", async () => {
    const base = await mkdtemp(join(tmpdir(), "qat-root-"));
    created.push(base);
    await makeProject({}); // keeps the helper symmetric; unused here
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

    expect(error["code"]).toBe(ErrorCode.projectNotFound);
    expect(error["context"]).toMatchObject({ searchedDepth: 0 });
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
    const root = await makeProject(cypressFiles({ "cypress/e2e/a.cy.ts": "" }));

    const first = await discoverProject({ cwd: root });
    const second = await discoverProject({ cwd: root });

    // No timestamp and no iteration-order dependence is what makes this assertion possible.
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
