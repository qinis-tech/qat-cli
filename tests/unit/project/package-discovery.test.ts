import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ErrorCode } from "~/core/errors/index.js";
import {
  discoverPackages,
  findDeclaration,
  readManifest,
} from "~/project/index.js";

/**
 * Fixtures are real temporary trees rather than a mocked filesystem.
 *
 * Every question this module asks is "does this named file exist, and what is in it", so a fake would answer
 * according to the same assumption the implementation makes — and would therefore agree with a wrong
 * implementation.
 */
const created: string[] = [];

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-pkg-"));
  created.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  return root;
}

function manifestJson(contents: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: "demo", version: "1.0.0", ...contents });
}

/** A project-shaped tree with the package installed beside it. */
function installed(version: string): Record<string, string> {
  return {
    "node_modules/cypress/package.json": JSON.stringify({
      name: "cypress",
      version,
    }),
  };
}

const OPTIONS = { packageName: "cypress", maxDepth: 4 };

afterAll(async () => {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("reading a manifest", () => {
  it("reads the fields QAT uses", async () => {
    const root = await makeTree({
      "package.json": manifestJson({
        private: true,
        packageManager: "pnpm@9.1.0",
      }),
    });

    const read = await readManifest(root);

    expect(read).toMatchObject({
      name: "demo",
      version: "1.0.0",
      private: true,
    });
    expect(read?.packageManager).toStrictEqual({
      name: "pnpm",
      declared: true,
    });
  });

  it("reports private as false when the field is absent or not a literal boolean", async () => {
    const root = await makeTree({
      "package.json": JSON.stringify({
        name: "demo",
        version: "1.0.0",
        private: "yes",
      }),
    });

    await expect(readManifest(root)).resolves.toMatchObject({ private: false });
  });

  it("returns undefined when there is no manifest", async () => {
    // A bare Cypress project is legal, and its absence must not be confused with a broken file.
    const root = await makeTree({ "cypress.config.ts": "" });

    await expect(readManifest(root)).resolves.toBeUndefined();
  });

  it("reports malformed JSON as a distinct failure, not as absence", async () => {
    const root = await makeTree({ "package.json": '{ "name": ' });

    await expect(readManifest(root)).rejects.toMatchObject({
      code: ErrorCode.filesystemInvalidJson,
    });
  });

  it("keeps only string dependency values", async () => {
    const root = await makeTree({
      "package.json": JSON.stringify({
        dependencies: { good: "^1.0.0", numeric: 42, nul: null, object: {} },
      }),
    });

    const read = await readManifest(root);

    expect(read?.sections.dependencies).toStrictEqual({ good: "^1.0.0" });
  });

  it("tolerates a manifest whose name and version are not strings", async () => {
    const root = await makeTree({
      "package.json": JSON.stringify({ name: 42, version: {} }),
    });

    const read = await readManifest(root);

    expect(read).toBeDefined();
    expect(read?.name).toBeUndefined();
    expect(read?.version).toBeUndefined();
  });

  it("reads an array workspace declaration", async () => {
    const root = await makeTree({
      "package.json": manifestJson({ workspaces: ["packages/*", "apps/*"] }),
    });

    await expect(readManifest(root)).resolves.toMatchObject({
      workspaces: ["packages/*", "apps/*"],
    });
  });

  it("reads the object form of a workspace declaration, as Yarn allows", async () => {
    const root = await makeTree({
      "package.json": manifestJson({
        workspaces: { packages: ["packages/*"], nohoist: ["x"] },
      }),
    });

    await expect(readManifest(root)).resolves.toMatchObject({
      workspaces: ["packages/*"],
    });
  });

  it("reports no workspaces when the declaration is unusable", async () => {
    const root = await makeTree({
      "package.json": manifestJson({ workspaces: "packages/*" }),
    });

    await expect(readManifest(root)).resolves.toMatchObject({ workspaces: [] });
  });
});

describe("package manager detection", () => {
  it("infers from a lockfile and marks it as inferred", async () => {
    const root = await makeTree({
      "package.json": manifestJson(),
      "package-lock.json": "{}",
    });

    await expect(readManifest(root)).resolves.toMatchObject({
      packageManager: {
        name: "npm",
        declared: false,
        lockfile: "package-lock.json",
      },
    });
  });

  it("prefers a declared manager over a lockfile", async () => {
    const root = await makeTree({
      "package.json": manifestJson({ packageManager: "pnpm@9.1.0" }),
      "package-lock.json": "{}",
    });

    await expect(readManifest(root)).resolves.toMatchObject({
      packageManager: { name: "pnpm", declared: true },
    });
  });

  it("ignores a declared manager that QAT does not recognise", async () => {
    const root = await makeTree({
      "package.json": manifestJson({ packageManager: "unknownpm@1.0.0" }),
      "yarn.lock": "",
    });

    // Falls through to the lockfile rather than reporting a manager whose remediation would be invented.
    await expect(readManifest(root)).resolves.toMatchObject({
      packageManager: { name: "yarn", declared: false },
    });
  });

  it("reports no manager when there is neither a declaration nor a lockfile", async () => {
    const root = await makeTree({ "package.json": manifestJson() });

    const read = await readManifest(root);

    expect(read?.packageManager).toBeUndefined();
  });
});

describe("declarations", () => {
  it.each([
    ["dependencies", "dependencies"],
    ["devDependencies", "devDependencies"],
    ["optionalDependencies", "optionalDependencies"],
    ["peerDependencies", "peerDependencies"],
  ])("finds a declaration in %s", async (field, section) => {
    const root = await makeTree({
      "package.json": JSON.stringify({ [field]: { cypress: "^13.15.0" } }),
    });

    const read = await readManifest(root);
    if (read === undefined) throw new Error("the fixture has a manifest");

    expect(findDeclaration(read, "cypress")).toStrictEqual({
      section,
      range: "^13.15.0",
    });
  });

  it("returns undefined when the package is not declared", async () => {
    const root = await makeTree({
      "package.json": manifestJson({ dependencies: { other: "^1" } }),
    });

    const read = await readManifest(root);
    if (read === undefined) throw new Error("the fixture has a manifest");

    expect(findDeclaration(read, "cypress")).toBeUndefined();
  });

  it("returns undefined when every dependency map is empty", async () => {
    const root = await makeTree({
      "package.json": JSON.stringify({ name: "demo" }),
    });

    const read = await readManifest(root);
    if (read === undefined) throw new Error("the fixture has a manifest");

    // No sections at all, not four empty records that must each be handled.
    expect(findDeclaration(read, "cypress")).toBeUndefined();
  });

  it("prefers the runtime declaration when a package appears twice", async () => {
    const root = await makeTree({
      "package.json": manifestJson({
        dependencies: { cypress: "^13.0.0" },
        devDependencies: { cypress: "^12.0.0" },
      }),
    });

    const read = await readManifest(root);
    if (read === undefined) throw new Error("the fixture has a manifest");

    expect(findDeclaration(read, "cypress")).toMatchObject({
      section: "dependencies",
    });
  });
});

describe("installation", () => {
  it("finds a package installed at the project root", async () => {
    const root = await makeTree({
      "package.json": manifestJson(),
      ...installed("13.15.0"),
    });

    const found = await discoverPackages(root, OPTIONS);

    expect(found.installation).toMatchObject({
      version: "13.15.0",
      source: "project",
    });
  });

  it("finds a package hoisted to a workspace root", async () => {
    const base = await makeTree({
      "node_modules/cypress/package.json": JSON.stringify({
        name: "cypress",
        version: "13.1.0",
      }),
      "packages/app/package.json": manifestJson(),
    });

    const found = await discoverPackages(
      join(base, "packages", "app"),
      OPTIONS,
    );

    expect(found.installation).toMatchObject({
      version: "13.1.0",
      source: "workspace",
    });
  });

  it("returns undefined when the package is not installed", async () => {
    const root = await makeTree({ "package.json": manifestJson() });

    await expect(discoverPackages(root, OPTIONS)).resolves.toMatchObject({
      installation: undefined,
    });
  });

  it("treats an installed package with no version as absent", async () => {
    const root = await makeTree({
      "node_modules/cypress/package.json": JSON.stringify({ name: "cypress" }),
    });

    await expect(discoverPackages(root, OPTIONS)).resolves.toMatchObject({
      installation: undefined,
    });
  });

  it("stops at an unusable local copy rather than reporting a hoisted one", async () => {
    // The nearest copy is what Node would load. Reporting the version from a directory above it would be
    // confident, well-formed and about a package the runtime will never use.
    const base = await makeTree({
      "node_modules/cypress/package.json": JSON.stringify({
        name: "cypress",
        version: "13.1.0",
      }),
      "packages/app/node_modules/cypress/package.json": JSON.stringify({
        name: "cypress",
      }),
      "packages/app/package.json": manifestJson(),
    });

    await expect(
      discoverPackages(join(base, "packages", "app"), OPTIONS),
    ).resolves.toMatchObject({
      installation: undefined,
    });
  });

  it("searches the root only when the depth is zero", async () => {
    const base = await makeTree({
      "node_modules/cypress/package.json": JSON.stringify({
        name: "cypress",
        version: "13.1.0",
      }),
      "packages/app/package.json": manifestJson(),
    });

    await expect(
      discoverPackages(join(base, "packages", "app"), {
        ...OPTIONS,
        maxDepth: 0,
      }),
    ).resolves.toMatchObject({ installation: undefined });
  });

  it("finds a hoisted install exactly at the depth boundary and not one level further", async () => {
    const base = await makeTree({
      "node_modules/cypress/package.json": JSON.stringify({
        name: "cypress",
        version: "13.1.0",
      }),
      "a/b/package.json": manifestJson(),
    });

    const from = join(base, "a", "b");

    await expect(
      discoverPackages(from, { ...OPTIONS, maxDepth: 2 }),
    ).resolves.toMatchObject({
      installation: { version: "13.1.0" },
    });
    await expect(
      discoverPackages(from, { ...OPTIONS, maxDepth: 1 }),
    ).resolves.toMatchObject({
      installation: undefined,
    });
  });
});

describe("the two states are independent", () => {
  it("reports a declared but uninstalled package as exactly that", async () => {
    const root = await makeTree({
      "package.json": manifestJson({
        devDependencies: { cypress: "^13.15.0" },
      }),
    });

    const found = await discoverPackages(root, OPTIONS);

    // The distinction the module exists to preserve: a caller can say "declared, not installed" rather than
    // a generic "missing".
    expect(found.declaration).toStrictEqual({
      section: "devDependencies",
      range: "^13.15.0",
    });
    expect(found.installation).toBeUndefined();
  });

  it("reports an installed but undeclared package as exactly that", async () => {
    const root = await makeTree({
      "package.json": manifestJson(),
      ...installed("13.15.0"),
    });

    const found = await discoverPackages(root, OPTIONS);

    expect(found.declaration).toBeUndefined();
    expect(found.installation).toBeDefined();
  });

  it("reports both absent when there is neither a manifest nor an install", async () => {
    const root = await makeTree({ "cypress.config.ts": "" });

    await expect(discoverPackages(root, OPTIONS)).resolves.toStrictEqual({
      manifest: undefined,
      declaration: undefined,
      installation: undefined,
    });
  });
});

describe("non-functional behaviour", () => {
  it("is deterministic: two calls produce deeply equal results", async () => {
    const root = await makeTree({
      "package.json": manifestJson({
        devDependencies: { cypress: "^13.15.0" },
      }),
      ...installed("13.15.0"),
    });

    expect(await discoverPackages(root, OPTIONS)).toStrictEqual(
      await discoverPackages(root, OPTIONS),
    );
  });

  it("does not change the process working directory", async () => {
    const root = await makeTree({
      "package.json": manifestJson(),
      ...installed("13.15.0"),
    });
    const before = process.cwd();

    await discoverPackages(root, OPTIONS);

    expect(process.cwd()).toBe(before);
  });

  it("keeps concurrent discoveries independent", async () => {
    const first = await makeTree({
      "package.json": manifestJson({ name: "alpha" }),
      ...installed("13.0.0"),
    });
    const second = await makeTree({
      "package.json": manifestJson({ name: "beta" }),
      ...installed("14.0.0"),
    });

    const [alpha, beta] = await Promise.all([
      discoverPackages(first, OPTIONS),
      discoverPackages(second, OPTIONS),
    ]);

    // A module-level cache would make one of these report the other's manifest.
    expect(alpha.manifest?.name).toBe("alpha");
    expect(alpha.installation?.version).toBe("13.0.0");
    expect(beta.manifest?.name).toBe("beta");
    expect(beta.installation?.version).toBe("14.0.0");
  });
});
