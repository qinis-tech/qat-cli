/**
 * The safe writer, from the outside.
 *
 * ## Two ways of testing one module
 *
 * Real files and a real temporary directory for anything whose *meaning* is a filesystem behaviour: a link that finds the
 * target taken, a rename that replaces, a hard link that a volume refuses. Those are kernel semantics, and a fake would
 * only assert that the fake behaves like the fake.
 *
 * A mocked primitive for anything that is a *failure* — a disk that fills, a sync that errors, a backup that cannot be
 * read back — because producing those honestly needs a full disk or a filesystem that lies. The mock is applied to the
 * three primitives the writer depends on (`open`, `link`, `rename`) with the real implementations as the default, so a
 * test that does not queue an override is exercising the real thing.
 *
 * Every override is queued with `*Once` and consumed by the single call it was written for. An override installed with
 * `mockImplementation` would outlive its test, because clearing mocks resets call history rather than implementations —
 * and a leaked rename that always fails is a very confusing way to learn that.
 *
 * The one property most of these cases share: **after every failure, the directory contains exactly the files it
 * contained before the call.**
 */
import type * as FsPromises from "node:fs/promises";
import { link, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilesystemError } from "~/core/errors/index.js";
import {
  backupPathFor,
  hashContents,
  replaceFileWithBackup,
  writeFileAtomic,
  writeNewFile,
} from "~/core/filesystem/atomic-write.js";

/* -------------------------------------------------------------------------- */
/* Mocked primitives, real by default                                          */
/* -------------------------------------------------------------------------- */

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();

  return {
    ...actual,
    // Three functions, each defaulting to the real implementation. The imported bindings below are these mocks, which is
    // what lets a test name them without reaching into the module registry.
    open: vi.fn(actual.open),
    link: vi.fn(actual.link),
    rename: vi.fn(actual.rename),
  };
});

/** The real implementations, for the assertions and for the overrides that delegate back to reality. */
const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");

/** An open that has already written its bytes when the flush fails — the shape of a full disk. */
type OpenOverride = (path: string, flags: string) => Promise<unknown>;

const openMock = open as unknown as {
  mockImplementationOnce(implementation: OpenOverride): void;
};

const linkMock = link as unknown as {
  mockRejectedValueOnce(error: unknown): void;
};

const renameMock = rename as unknown as {
  mockImplementationOnce(
    implementation: (from: string, to: string) => Promise<void>,
  ): void;
  mockRejectedValueOnce(error: unknown): void;
};

/** An error shaped the way Node reports one, without needing the kernel to produce it. */
function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/* -------------------------------------------------------------------------- */
/* A directory per test                                                       */
/* -------------------------------------------------------------------------- */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qat-safe-write-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  // History only: the implementations installed by the mock factory must survive, or every later test would call
  // `undefined`. Queued overrides are consumed by the test that queues them, so there is nothing else to unwind.
  vi.clearAllMocks();
});

const target = (): string => join(root, "qat.config.json");

/** Everything in the directory, sorted, so an assertion can name the whole tree rather than search it. */
async function entries(): Promise<readonly string[]> {
  return (await actual.readdir(root)).sort();
}

/** The file's text, read through the real implementation rather than the mocked module. */
async function text(path: string): Promise<string> {
  return actual.readFile(path, "utf8");
}

/* -------------------------------------------------------------------------- */
/* Creating                                                                   */
/* -------------------------------------------------------------------------- */

describe("creating a file that must not exist", () => {
  it("writes the file and reports that it created it", async () => {
    await expect(writeNewFile(target(), "{\n}\n")).resolves.toBe("created");

    expect(await text(target())).toBe("{\n}\n");
    // No temporary survived: one name, one file.
    expect(await entries()).toStrictEqual(["qat.config.json"]);
  });

  it("reports an occupied path without touching it", async () => {
    await actual.writeFile(target(), "mine\n");

    // The answer, not an exception. A caller that had to catch this would convert it straight back into a value, with an
    // error path in between that can be logged or swallowed by accident.
    await expect(writeNewFile(target(), "theirs\n")).resolves.toBe("exists");

    expect(await text(target())).toBe("mine\n");
    expect(await entries()).toStrictEqual(["qat.config.json"]);
  });

  it("writes bytes, not only text", async () => {
    const bytes = Uint8Array.from([0x7b, 0x0a, 0x7d, 0x0a]);

    await expect(writeNewFile(target(), bytes)).resolves.toBe("created");
    expect(await actual.readFile(target())).toStrictEqual(Buffer.from(bytes));
  });

  it("creates an empty file when asked for one", async () => {
    // A boundary worth naming: `""` is a legitimate content, and a writer that treated it as "nothing to write" would
    // produce a zero-length file by a different route than the caller intended.
    await expect(writeNewFile(target(), "")).resolves.toBe("created");

    expect(await text(target())).toBe("");
    expect(await entries()).toStrictEqual(["qat.config.json"]);
  });

  it("refuses a directory that does not exist, naming the directory", async () => {
    const path = join(root, "absent", "qat.config.json");

    // Naming the temporary file — which is what a raw ENOENT would report — tells the reader nothing about the typo they
    // actually made.
    await expect(writeNewFile(path, "{}")).rejects.toThrow(/does not exist/u);
    expect(await entries()).toStrictEqual([]);
  });

  it("refuses a parent that is a file", async () => {
    const file = join(root, "notes.txt");
    await actual.writeFile(file, "x");

    await expect(
      writeNewFile(join(file, "qat.config.json"), "{}"),
    ).rejects.toThrow(/is not a directory/u);
  });

  it("leaves nothing behind when the write fails", async () => {
    openMock.mockImplementationOnce(async (path, flags) => {
      const real = await actual.open(path, flags);
      await real.writeFile("partial");

      return {
        // No `async` and no `await`: a promise-returning arrow whose body has nothing to wait for is lint noise, and
        // these three need only the shape the writer calls.
        writeFile: () => Promise.resolve(),
        sync: () => {
          throw errno("ENOSPC");
        },
        close: () => real.close(),
      };
    });

    await expect(writeNewFile(target(), "{}")).rejects.toBeInstanceOf(
      FilesystemError,
    );

    // The property that matters: the target is absent, and the half-written temporary is gone.
    expect(await entries()).toStrictEqual([]);
  });

  it("names the filesystem when hard links are unavailable", async () => {
    // `EPERM` from a link is indistinguishable from a permission problem by code alone, so the message has to say which
    // capability is missing rather than which permission was refused.
    linkMock.mockRejectedValueOnce(errno("EPERM"));

    await expect(writeNewFile(target(), "{}")).rejects.toThrow(/hard links/u);
    expect(await entries()).toStrictEqual([]);
  });

  it("names the filesystem when hard links are not implemented", async () => {
    linkMock.mockRejectedValueOnce(errno("ENOSYS"));

    await expect(writeNewFile(target(), "{}")).rejects.toThrow(/hard links/u);
  });

  it("translates any other link failure rather than reporting it raw", async () => {
    linkMock.mockRejectedValueOnce(errno("EACCES"));

    await expect(writeNewFile(target(), "{}")).rejects.toBeInstanceOf(
      FilesystemError,
    );
    expect(await entries()).toStrictEqual([]);
  });

  it("lets exactly one of two concurrent creates win", async () => {
    const outcomes = await Promise.all([
      writeNewFile(target(), "first\n"),
      writeNewFile(target(), "second\n"),
    ]);

    // This is the case a check-then-write cannot survive, and the only reason the create uses `link`. Whichever outcome
    // the loser got, the winner's bytes are what is on disk and the loser's temporary is gone.
    expect([...outcomes].sort()).toStrictEqual(["created", "exists"]);
    expect(await entries()).toStrictEqual(["qat.config.json"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Replacing                                                                  */
/* -------------------------------------------------------------------------- */

describe("writing a file atomically", () => {
  it("replaces existing content", async () => {
    await actual.writeFile(target(), "old\n");

    await writeFileAtomic(target(), "new\n");

    expect(await text(target())).toBe("new\n");
    expect(await entries()).toStrictEqual(["qat.config.json"]);
  });

  it("creates the file when it is not there", async () => {
    await writeFileAtomic(target(), "new\n");

    expect(await text(target())).toBe("new\n");
  });

  it("leaves the old content when the rename fails", async () => {
    await actual.writeFile(target(), "old\n");
    renameMock.mockRejectedValueOnce(errno("EACCES"));

    await expect(writeFileAtomic(target(), "new\n")).rejects.toBeInstanceOf(
      FilesystemError,
    );

    // The name still points at the old bytes, and the new bytes never had a name worth keeping.
    expect(await text(target())).toBe("old\n");
    expect(await entries()).toStrictEqual(["qat.config.json"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Replacing with a backup                                                    */
/* -------------------------------------------------------------------------- */

describe("replacing a file with a verified backup", () => {
  const original = '{\n  "version": 1\n}\n';
  const replacement = '{\n  "version": 1,\n  "framework": "cypress"\n}\n';

  async function seed(): Promise<string> {
    await actual.writeFile(target(), original);
    return hashContents(await actual.readFile(target()));
  }

  it("keeps the previous contents and reports where", async () => {
    const expected = await seed();

    const outcome = await replaceFileWithBackup(target(), replacement, {
      expectedSha256: expected,
    });

    expect(outcome).toBe("replaced");
    expect(await text(target())).toBe(replacement);
    expect(await text(backupPathFor(target()))).toBe(original);
  });

  it("refuses when nothing is there", async () => {
    // Replacing nothing would be a creation wearing a replacement's clothes, and it would take a backup of nothing.
    await expect(
      replaceFileWithBackup(target(), replacement, {
        expectedSha256: hashContents(""),
      }),
    ).resolves.toBe("missing");

    expect(await entries()).toStrictEqual([]);
  });

  it("refuses when the content is not the content the caller saw", async () => {
    await seed();
    const stale = hashContents("something else entirely");

    await expect(
      replaceFileWithBackup(target(), replacement, { expectedSha256: stale }),
    ).resolves.toBe("changed");

    // Both halves matter: the file still holds the edit somebody else made, and no backup was taken of it.
    expect(await text(target())).toBe(original);
    expect(await entries()).toStrictEqual(["qat.config.json"]);
  });

  it("refuses when the backup cannot be read back, leaving the original untouched", async () => {
    const expected = await seed();

    // The backup rename lands, then writes different bytes — the shape of a copy that reported success and is not one.
    renameMock.mockImplementationOnce(async (from, to) => {
      await actual.writeFile(to, "tampered");
      await actual.rm(from, { force: true });
    });

    await expect(
      replaceFileWithBackup(target(), replacement, {
        expectedSha256: expected,
      }),
    ).rejects.toThrow(/does not match/u);

    // AC8, stated as an assertion: a backup that is not trustworthy stops the destructive step rather than following it.
    expect(await text(target())).toBe(original);
  });

  it("refuses when the backup path is occupied by a directory", async () => {
    const expected = await seed();
    await mkdir(backupPathFor(target()));

    await expect(
      replaceFileWithBackup(target(), replacement, {
        expectedSha256: expected,
      }),
    ).rejects.toBeInstanceOf(FilesystemError);

    expect(await text(target())).toBe(original);
  });

  it("keeps a proven backup even when the replacement itself fails", async () => {
    const expected = await seed();

    // Two renames in order: the backup, which must succeed, then the target, which does not.
    renameMock.mockImplementationOnce((from, to) => actual.rename(from, to));
    renameMock.mockRejectedValueOnce(errno("EACCES"));

    await expect(
      replaceFileWithBackup(target(), replacement, {
        expectedSha256: expected,
      }),
    ).rejects.toBeInstanceOf(FilesystemError);

    // The failed replacement is not a lost replacement: the original is still the target, and the copy is on disk.
    expect(await text(target())).toBe(original);
    expect(await text(backupPathFor(target()))).toBe(original);
  });

  it("is recoverable by putting the backup back", async () => {
    const expected = await seed();
    await replaceFileWithBackup(target(), replacement, {
      expectedSha256: expected,
    });

    // The one-line undo a reader can be told in a message, executed here to prove it works.
    await writeFileAtomic(
      target(),
      await actual.readFile(backupPathFor(target())),
    );

    expect(await text(target())).toBe(original);
  });

  it("round-trips a large document in every operation", async () => {
    // Boundary: an uncomfortably large configuration, through replace and backup, because the guarantees are about bytes
    // rather than about short strings.
    const large = `${"a".repeat(1024 * 1024)}\n`;
    await actual.writeFile(target(), original);

    await replaceFileWithBackup(target(), large, {
      expectedSha256: hashContents(await actual.readFile(target())),
    });

    expect((await actual.readFile(target())).byteLength).toBe(large.length);
    expect(await text(backupPathFor(target()))).toBe(original);
  });

  it("handles an empty previous file", async () => {
    // A zero-byte configuration is a defect a reader can have; the backup of one is an empty file rather than a missing
    // one, which is the difference between "restore this" and "there was nothing to restore".
    await actual.writeFile(target(), "");

    await expect(
      replaceFileWithBackup(target(), replacement, {
        expectedSha256: hashContents(""),
      }),
    ).resolves.toBe("replaced");

    expect(await text(backupPathFor(target()))).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/* The helpers                                                                */
/* -------------------------------------------------------------------------- */

describe("the helpers the caller has to use", () => {
  it("names the backup beside the file it protects", () => {
    expect(backupPathFor("/repo/qat.config.json")).toBe(
      "/repo/qat.config.json.backup",
    );
  });

  it("hashes text and bytes to the same value", () => {
    const contents = '{\n  "version": 1\n}\n';

    // The equivalence matters: a caller usually holds the file as text and the writer holds it as bytes, and a hash that
    // disagreed between them would make every replacement look like a concurrent edit.
    expect(hashContents(contents)).toBe(
      hashContents(Buffer.from(contents, "utf8")),
    );
  });

  it("produces a stable hash", () => {
    expect(hashContents("a")).toBe(hashContents("a"));
    expect(hashContents("a")).not.toBe(hashContents("b"));
  });
});

/* -------------------------------------------------------------------------- */
/* Non-functional                                                             */
/* -------------------------------------------------------------------------- */

describe("non-functional behaviour", () => {
  it("leaves the directory as it found it after every refusal", async () => {
    await actual.writeFile(target(), "mine\n");

    await writeNewFile(target(), "theirs\n");
    await replaceFileWithBackup(target(), "x", {
      expectedSha256: hashContents("other"),
    });

    // One file, unchanged. A writer that produced a stray temporary here would be indistinguishable from one that had
    // half-succeeded.
    expect(await entries()).toStrictEqual(["qat.config.json"]);
    expect(await text(target())).toBe("mine\n");
  });

  it("is deterministic across repeated replacements", async () => {
    await actual.writeFile(target(), "one\n");

    for (const contents of ["two\n", "three\n", "four\n"]) {
      await replaceFileWithBackup(target(), contents, {
        expectedSha256: hashContents(await actual.readFile(target())),
      });
    }

    expect(await text(target())).toBe("four\n");
    // Each replacement replaced the previous backup, so there is one file beside the target and not a history of them.
    expect(await entries()).toStrictEqual([
      "qat.config.json",
      "qat.config.json.backup",
    ]);
  });

  it("never leaves a temporary file after a successful write", async () => {
    await writeNewFile(target(), "{}");
    await writeFileAtomic(target(), "{}");

    const stray = (await entries()).filter((entry) => entry.endsWith(".tmp"));

    expect(stray).toStrictEqual([]);
  });
});
