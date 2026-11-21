import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCode, FilesystemError } from "~/core/errors/index.js";
import {
  ensureDirectory,
  isDirectory,
  isFile,
  listDirectory,
  pathExists,
  readJson,
  readText,
  resolveWithin,
  toPortableRelativePath,
  writeFileAtomic,
  writeJson,
  writeText,
} from "~/core/filesystem/index.js";

/**
 * Tests run against a real temporary directory rather than a mocked filesystem.
 *
 * A fake filesystem is a second implementation of the thing under test, and the bugs this module
 * exists to prevent — permission failures, locked files, rename semantics, leftover temporary
 * files — are precisely the ones a fake does not reproduce.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qat-fs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ensureDirectory", () => {
  it("creates nested directories", async () => {
    const target = join(root, "a", "b", "c");

    await ensureDirectory(target);

    expect(await isDirectory(target)).toBe(true);
  });

  it("succeeds when the directory already exists", async () => {
    const target = join(root, "existing");

    await ensureDirectory(target);

    // Idempotence is the property that matters: every consumer may call this unconditionally.
    await expect(ensureDirectory(target)).resolves.toBe(target);
  });

  it("rejects a path that exists as a file, with a message naming the reason", async () => {
    const target = join(root, "file.txt");
    await writeFile(target, "contents");

    const error = await ensureDirectory(target).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(FilesystemError);
    expect((error as FilesystemError).message).toContain("is not a directory");
  });
});

describe("existence checks", () => {
  it("reports absent paths as false", async () => {
    const missing = join(root, "nothing-here");

    expect(await pathExists(missing)).toBe(false);
    expect(await isFile(missing)).toBe(false);
    expect(await isDirectory(missing)).toBe(false);
  });

  it("distinguishes files from directories", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "contents");

    expect(await pathExists(file)).toBe(true);
    expect(await isFile(file)).toBe(true);
    expect(await isDirectory(file)).toBe(false);
    expect(await isDirectory(root)).toBe(true);
  });

  // Permission semantics differ on Windows and are not enforced for a superuser, so the test is
  // skipped where it would prove nothing rather than passing for the wrong reason.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "throws rather than reporting false when it cannot look",
    async () => {
      const locked = join(root, "locked");
      await ensureDirectory(locked);
      await rm(locked, { recursive: true });
      await ensureDirectory(locked, { mode: 0o000 });

      const error = await pathExists(join(locked, "child")).catch(
        (caught: unknown) => caught,
      );

      await ensureDirectory(locked, { mode: 0o700 });

      expect(error).toBeInstanceOf(FilesystemError);
      expect((error as FilesystemError).code).toBe(ErrorCode.filesystemFailure);
    },
  );
});

describe("text files", () => {
  it("round-trips UTF-8 content", async () => {
    const file = join(root, "note.txt");

    await writeText(file, "café — naïve\n");

    expect(await readText(file)).toBe("café — naïve\n");
  });

  it("translates a missing file into an actionable error", async () => {
    const error = await readText(join(root, "absent.txt")).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(FilesystemError);
    expect((error as FilesystemError).context["path"]).toContain("absent.txt");
    expect((error as FilesystemError).remediation).toBeDefined();
  });
});

describe("listing", () => {
  it("returns entries sorted by code unit", async () => {
    for (const name of ["b.txt", "a.txt", "C.txt"]) {
      await writeFile(join(root, name), "");
    }

    // Code-unit order, not a locale order: `C` sorts before `a`. Locale-sensitive sorting would
    // make this list differ between machines.
    expect(await listDirectory(root)).toStrictEqual([
      "C.txt",
      "a.txt",
      "b.txt",
    ]);
  });
});

describe("json", () => {
  it("round-trips a value with formatting and a trailing newline", async () => {
    const file = join(root, "data.json");

    await writeJson(file, { name: "qat", nested: { ok: true } });

    const onDisk = await readFile(file, "utf8");
    expect(onDisk.endsWith("\n")).toBe(true);
    expect(onDisk).toContain('\n  "name"');
    expect(await readJson(file)).toStrictEqual({
      name: "qat",
      nested: { ok: true },
    });
  });

  it("reports invalid JSON with a code and the parser detail", async () => {
    const file = join(root, "broken.json");
    await writeFile(file, '{ "name": "qat", }');

    const error = await readJson(file).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FilesystemError);
    expect((error as FilesystemError).code).toBe(
      ErrorCode.filesystemInvalidJson,
    );
    expect((error as FilesystemError).context["detail"]).toBeTypeOf("string");
  });

  it("reports an empty file separately from invalid JSON", async () => {
    const file = join(root, "empty.json");
    await writeFile(file, "   \n");

    const error = await readJson(file).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FilesystemError);
    expect((error as FilesystemError).code).toBe(
      ErrorCode.filesystemInvalidJson,
    );
    expect((error as FilesystemError).message).toContain("is empty");
  });

  it("refuses to write a value that stringifies to undefined", async () => {
    const file = join(root, "undefined.json");

    // Written as an explicit failure rather than as the text "undefined", which would produce a
    // file that is neither valid JSON nor obviously broken.
    await expect(writeJson(file, undefined)).rejects.toThrow(TypeError);
    expect(await pathExists(file)).toBe(false);
  });
});

describe("atomic writes", () => {
  it("replaces an existing file and leaves no temporary file behind", async () => {
    const file = join(root, "report.json");
    await writeFile(file, "old contents that are longer than the new ones");

    await writeFileAtomic(file, "new");

    expect(await readText(file)).toBe("new");
    expect(await listDirectory(root)).toStrictEqual(["report.json"]);
  });

  it("creates a file that did not exist, and leaves no temporary file behind", async () => {
    const file = join(root, "fresh.json");

    await writeFileAtomic(file, '{"ok":true}');

    expect(await readText(file)).toBe('{"ok":true}');
    expect(await listDirectory(root)).toStrictEqual(["fresh.json"]);
  });

  it("fails without touching the target when the directory does not exist", async () => {
    const file = join(root, "missing-directory", "report.json");

    const error = await writeFileAtomic(file, "contents").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(FilesystemError);
    expect((error as FilesystemError).message).toContain("does not exist");
    // No stray directory tree, and nothing created anywhere.
    expect(await listDirectory(root)).toStrictEqual([]);
  });

  it("leaves the previous contents intact when the write fails", async () => {
    const file = join(root, "report.json");
    await writeFile(file, "previous");

    // A directory at the target path makes the rename fail after the temporary file was written —
    // the one failure this test can force reliably. The target's previous state must survive.
    const blocked = join(root, "blocked");
    await ensureDirectory(blocked);
    await writeFile(join(blocked, "inner.json"), "inner");

    const error = await writeFileAtomic(blocked, "contents").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(FilesystemError);
    expect(await readText(file)).toBe("previous");
    expect(await listDirectory(root)).toStrictEqual(["blocked", "report.json"]);
    expect(await listDirectory(blocked)).toStrictEqual(["inner.json"]);
  });

  it("does not leave temporary files in the directory when the write succeeds", async () => {
    for (let index = 0; index < 5; index += 1) {
      await writeFileAtomic(
        join(root, "repeated.json"),
        `write ${String(index)}`,
      );
    }

    // The cleanup path runs on every write, including successful ones. A leftover `.tmp` here
    // would be a file the user cannot account for, in a directory they chose.
    expect(await listDirectory(root)).toStrictEqual(["repeated.json"]);
  });
});

describe("path containment", () => {
  it("resolves a nested relative path", () => {
    expect(
      toPortableRelativePath(root, resolveWithin(root, "reports", "run.json")),
    ).toBe("reports/run.json");
  });

  it("rejects traversal out of the root", () => {
    const error = (() => {
      try {
        resolveWithin(root, "..", "outside.json");
        return undefined;
      } catch (caught: unknown) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(FilesystemError);
    expect((error as FilesystemError).code).toBe(
      ErrorCode.filesystemPathInvalid,
    );
  });

  it("rejects an absolute segment, which would silently discard the root", () => {
    const absolute =
      process.platform === "win32" ? "C:\\Windows\\System32" : "/etc/passwd";

    expect(() => resolveWithin(root, absolute)).toThrow(FilesystemError);
  });

  it("rejects a null byte", () => {
    expect(() => resolveWithin(root, "file\0.json")).toThrow(FilesystemError);
  });

  it("does not treat a sibling directory sharing a prefix as contained", () => {
    // A string-prefix check would accept this. `path.relative` does not.
    expect(resolveWithin("/out", "x")).toBe("/out/x");
    expect(() => resolveWithin("/out", "../outside")).toThrow(FilesystemError);
  });
});
