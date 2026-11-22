import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { resolveVersion, VERSION_SEARCH_DEPTH } from "~/cli/version.js";
import { ErrorCode } from "~/core/errors/index.js";

const created: string[] = [];

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-version-"));
  created.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  return root;
}

function manifest(version: unknown): string {
  return JSON.stringify({ name: "qat-cli", version });
}

afterAll(async () => {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("resolving the version", () => {
  it("reads the manifest in the starting directory", async () => {
    const root = await makeTree({ "package.json": manifest("1.2.3") });

    await expect(resolveVersion(root)).resolves.toStrictEqual({
      version: "1.2.3",
      manifestPath: join(root, "package.json"),
    });
  });

  it("climbs to a parent when the starting directory has no manifest", async () => {
    const root = await makeTree({
      "package.json": manifest("1.2.3"),
      "dist/cli/.keep": "",
    });

    const resolved = await resolveVersion(join(root, "dist", "cli"));

    expect(resolved.version).toBe("1.2.3");
  });

  it("finds a manifest exactly at the search depth, and not one level further", async () => {
    const root = await makeTree({ "package.json": manifest("1.2.3") });

    // A single path segment per level, so "n levels deep" is unambiguous.
    const atDepth = (levels: number): string =>
      join(root, ...Array<string>(levels).fill("d"));

    await expect(
      resolveVersion(atDepth(VERSION_SEARCH_DEPTH)),
    ).resolves.toMatchObject({
      version: "1.2.3",
    });
    await expect(
      resolveVersion(atDepth(VERSION_SEARCH_DEPTH + 1)),
    ).rejects.toMatchObject({
      code: ErrorCode.installationIncomplete,
    });
  });

  it("accepts pre-release and build-metadata versions", async () => {
    const versions = [
      "0.2.0-alpha.1", // pre-release only
      "1.0.0+build.5", // build metadata only
      "2.0.0-rc.1+build.9", // both, pre-release first — the shape a single optional group rejects
    ];

    for (const version of versions) {
      const root = await makeTree({ "package.json": manifest(version) });

      await expect(resolveVersion(root)).resolves.toMatchObject({ version });
    }
  });
});

describe("missing and unusable metadata", () => {
  it("fails when no manifest is found anywhere", async () => {
    const root = await makeTree({ "readme.md": "" });

    const error = await resolveVersion(root).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: ErrorCode.installationIncomplete });
    // The message must name what is missing and the remedy must say what to do about it.
    expect(String((error as Error).message)).toContain("package.json");
    expect((error as { remediation?: string }).remediation).toContain(
      "Reinstall",
    );
  });

  it("fails on a manifest that is not valid JSON, without climbing past it", async () => {
    const root = await makeTree({
      "package.json": manifest("1.2.3"),
      "inner/package.json": '{ "version": ',
    });

    // The nearest manifest belongs to the package this code is in. Reporting a parent's version instead
    // would be confidently wrong.
    await expect(resolveVersion(join(root, "inner"))).rejects.toMatchObject({
      code: ErrorCode.installationIncomplete,
    });
  });

  it("fails on a manifest with no version", async () => {
    const root = await makeTree({
      "package.json": JSON.stringify({ name: "qat-cli" }),
    });

    await expect(resolveVersion(root)).rejects.toMatchObject({
      code: ErrorCode.installationIncomplete,
    });
  });

  it.each([
    ["a version that is a number", 42],
    ["an empty string", ""],
    ["prose", "see changelog"],
  ])("fails on %s", async (_label, version) => {
    const root = await makeTree({ "package.json": manifest(version) });

    await expect(resolveVersion(root)).rejects.toMatchObject({
      code: ErrorCode.installationIncomplete,
    });
  });
});

describe("isolation", () => {
  it("does not depend on the process working directory", async () => {
    const root = await makeTree({ "package.json": manifest("3.4.5") });
    const before = process.cwd();

    // The start directory is absolute, so the answer must be the same whatever the process is in — and
    // the process must be left alone.
    await expect(resolveVersion(root)).resolves.toMatchObject({
      version: "3.4.5",
    });
    expect(process.cwd()).toBe(before);
  });

  it("treats a path separator in the start directory literally", async () => {
    const root = await makeTree({ "package.json": manifest("4.5.6") });

    // Guards against a resolver that builds paths by string concatenation.
    await expect(resolveVersion(`${root}${sep}`)).resolves.toMatchObject({
      version: "4.5.6",
    });
  });
});
