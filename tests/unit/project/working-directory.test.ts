import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ErrorCode, InvalidArgumentError } from "~/core/errors/index.js";
import { resolveWorkingDirectory } from "~/project/index.js";

/**
 * Every test supplies the process directory explicitly. Nothing here depends on where the suite happens
 * to be running, and nothing has to change the process to arrange its own input.
 */
const created: string[] = [];

async function makeTree(files: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-wd-"));
  created.push(root);

  for (const path of files) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "");
  }

  return root;
}

afterAll(async () => {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("precedence", () => {
  it("prefers an argument over the option and the process directory", async () => {
    const root = await makeTree([
      "argument/.keep",
      "option/.keep",
      "process/.keep",
    ]);

    const resolved = await resolveWorkingDirectory(
      { argument: join(root, "argument"), option: join(root, "option") },
      join(root, "process"),
    );

    expect(resolved).toStrictEqual({
      directory: join(root, "argument"),
      source: "argument",
    });
  });

  it("falls back to the option when no argument is given", async () => {
    const root = await makeTree(["option/.keep", "process/.keep"]);

    await expect(
      resolveWorkingDirectory(
        { option: join(root, "option") },
        join(root, "process"),
      ),
    ).resolves.toStrictEqual({
      directory: join(root, "option"),
      source: "option",
    });
  });

  it("falls back to the process directory when neither is given", async () => {
    const root = await makeTree(["process/.keep"]);

    await expect(
      resolveWorkingDirectory({}, join(root, "process")),
    ).resolves.toStrictEqual({
      directory: join(root, "process"),
      source: "process",
    });
  });
});

describe("path handling", () => {
  it("resolves a relative path against the process directory", async () => {
    const root = await makeTree(["process/inner/.keep"]);

    await expect(
      resolveWorkingDirectory({ argument: "inner" }, join(root, "process")),
    ).resolves.toMatchObject({ directory: join(root, "process", "inner") });
  });

  it("resolves `.` to the process directory and `..` to its parent", async () => {
    const root = await makeTree(["parent/child/.keep"]);
    const child = join(root, "parent", "child");

    await expect(
      resolveWorkingDirectory({ argument: "." }, child),
    ).resolves.toMatchObject({
      directory: child,
    });
    await expect(
      resolveWorkingDirectory({ argument: ".." }, child),
    ).resolves.toMatchObject({
      directory: join(root, "parent"),
    });
  });

  it("normalises an absolute path with redundant separators and segments", async () => {
    const root = await makeTree(["a/b/.keep"]);

    const resolved = await resolveWorkingDirectory(
      { argument: `${root}${sep}a${sep}.${sep}b${sep}` },
      root,
    );

    expect(resolved.directory).toBe(join(root, "a", "b"));
  });

  it("accepts an absolute path given as an argument", async () => {
    const root = await makeTree(["target/.keep"]);

    await expect(
      resolveWorkingDirectory({ argument: join(root, "target") }, tmpdir()),
    ).resolves.toMatchObject({ directory: join(root, "target") });
  });
});

describe("invalid input", () => {
  it("rejects a directory that does not exist, naming which input was wrong", async () => {
    const root = await makeTree(["process/.keep"]);

    const error = await resolveWorkingDirectory(
      { option: join(root, "absent") },
      join(root, "process"),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error).toMatchObject({ code: ErrorCode.invalidArgument });
    // The message says which of the three inputs it was, because "not a directory" alone does not tell a
    // reader where to look.
    expect((error as Error).message).toContain("--cwd");
    expect((error as Error).message).toContain("absent");
    expect((error as Error).message).toContain("is not a directory");
    expect((error as { remediation?: string }).remediation).toBeDefined();
  });

  it("rejects a path that is a file rather than a directory", async () => {
    const root = await makeTree(["file.txt"]);

    await expect(
      resolveWorkingDirectory({ argument: join(root, "file.txt") }, root),
    ).rejects.toMatchObject({ code: ErrorCode.invalidArgument });
  });

  it("rejects an empty argument rather than silently using the process directory", async () => {
    // An explicit empty value is a mistake, not an instruction to use the default.
    await expect(
      resolveWorkingDirectory({ argument: "" }, tmpdir()),
    ).rejects.toMatchObject({
      code: ErrorCode.invalidArgument,
      message: expect.stringContaining("empty"),
    });
  });

  it("rejects a whitespace-only value", async () => {
    await expect(
      resolveWorkingDirectory({ option: "   " }, tmpdir()),
    ).rejects.toMatchObject({
      code: ErrorCode.invalidArgument,
    });
  });

  it("rejects a null byte", async () => {
    await expect(
      resolveWorkingDirectory({ argument: `a\0b` }, tmpdir()),
    ).rejects.toMatchObject({ code: ErrorCode.invalidArgument });
  });
});

describe("isolation", () => {
  it("does not depend on, or change, the process working directory", async () => {
    const root = await makeTree(["target/.keep"]);
    const before = process.cwd();

    await expect(
      resolveWorkingDirectory({ argument: join(root, "target") }, root),
    ).resolves.toMatchObject({ directory: join(root, "target") });

    expect(process.cwd()).toBe(before);
  });

  it("does not look above the chosen directory", async () => {
    const root = await makeTree(["parent/child/.keep"]);

    // `child` exists; `parent` also exists and is a project-ish directory in other tests. The resolver
    // must return the directory it was given, not the first ancestor that satisfies some other question.
    await expect(
      resolveWorkingDirectory({ argument: "child" }, join(root, "parent")),
    ).resolves.toMatchObject({ directory: join(root, "parent", "child") });
  });
});
