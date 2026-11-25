import { createHash, randomBytes } from "node:crypto";

import { ErrorCode } from "../errors/codes.js";
import { FilesystemError } from "../errors/errors.js";

import { hasErrorCode, translateFilesystemError } from "./errors.js";
import { nodeSafeWriteIo, type SafeWriteIo } from "./safe-write-io.js";

/**
 * Writing a file, without the ability to destroy one by accident.
 *
 * ## One entry point, and intent is a type
 *
 * There is no `overwrite: boolean` here. A boolean is a value somebody passes along, defaults, inverts or forgets; a
 * union member is a branch the compiler makes a caller write. A function that can replace a file unless it is told not
 * to is a function that will one day be told not to by a caller that was edited.
 *
 * ## The two primitives, and why neither can serve both cases
 *
 * `link` creates a second name for a file and fails if that name is taken. It is the only primitive that tests and
 * effects in one operation, which is what makes "create" safe under concurrency.
 *
 * `rename` replaces the target atomically. It is the right primitive once somebody has declared they intend to replace,
 * and the wrong one before that — it will not refuse, and it will not warn.
 *
 * ## What a caller may assume afterwards
 *
 * - The target is either the old bytes, or the new bytes, or absent. Never a mixture, never truncated.
 * - Nothing was written to the target unless the result says `created` or `replaced`.
 * - A `conflict` result means the filesystem was left exactly as it was found.
 * - A rejected promise means a *machine* failure — a full disk, a permission — not a decision about the content.
 */

/** How the caller intends to treat an existing file. */
export const WriteMode = {
  /** Write only if nothing is at the path. */
  Create: "create",
  /** Replace, but only the content the caller has actually seen. */
  Replace: "replace",
} as const;

export type WriteIntent =
  | { readonly mode: typeof WriteMode.Create }
  | {
      readonly mode: typeof WriteMode.Replace;
      /**
       * SHA-256 of the bytes the caller read before deciding to replace.
       *
       * Not a checksum for integrity — the filesystem already guarantees the bytes it gives back. It is a
       * compare-and-swap: replacement is authorised for *the content the caller saw*, so a file edited between the read
       * and the write is refused rather than clobbered. Without it, "explicit intent" means "intent to replace whatever
       * happens to be there", which is not intent at all.
       */
      readonly expectedSha256: string;
    };

export type SafeWriteResult =
  | { readonly outcome: "created"; readonly path: string }
  | {
      readonly outcome: "replaced";
      readonly path: string;
      /** Where the previous content was preserved. Byte-identical to what was read. */
      readonly backupPath: string;
    }
  | {
      readonly outcome: "conflict";
      readonly path: string;
      /** `exists`: something is already there. `changed`: the content is not the content the caller saw. */
      readonly reason: "exists" | "changed";
    };

/** Where a replacement keeps the previous content. A sibling, so it survives alongside the file it protects. */
export function backupPathFor(path: string): string {
  return `${path}.backup`;
}

/**
 * A unique name that cannot be mistaken for a configuration.
 *
 * Three things in the name, and each earns its place: the pid separates two processes writing at once, the random suffix
 * separates two writes in one process, and the `.tmp` suffix means nothing that reads configurations will ever look at it
 * — the loader reads one exact filename. A crash can therefore leave one of these behind without leaving anything that
 * looks like a project's configuration.
 */
export function temporaryPathFor(path: string): string {
  return `${path}.${String(process.pid)}.${randomBytes(4).toString("hex")}.tmp`;
}

/** The hash a caller passes as `expectedSha256`. Exported so nobody invents their own encoding. */
export function hashContents(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

/**
 * Write a file under a declared intent.
 *
 * @throws {FilesystemError} when the machine could not do its part. A refusal to proceed is a `conflict` *result*, not a
 *   rejection: it is an expected answer about content, and the caller has a message to write for it.
 */
export async function writeFileSafely(
  path: string,
  contents: string,
  intent: WriteIntent,
  io: SafeWriteIo = nodeSafeWriteIo,
): Promise<SafeWriteResult> {
  return intent.mode === WriteMode.Create
    ? create(path, contents, io)
    : replace(path, contents, intent.expectedSha256, io);
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

async function create(
  path: string,
  contents: string,
  io: SafeWriteIo,
): Promise<SafeWriteResult> {
  const temporary = await writeTemporary(path, contents, io);

  try {
    await io.link(temporary, path);
  } catch (error) {
    if (isExists(error)) {
      // The target appeared between whatever check the caller made and this call. That is not an error — it is the
      // answer "somebody got there first", and the caller reports it in the same words as a file it found itself.
      return { outcome: "conflict", path, reason: "exists" };
    }

    throw translateFilesystemError(error, "create", path);
  } finally {
    // Whether the link succeeded or refused, the temporary name must go: on success it would leave one file with two
    // names, and on failure it would leave litter beside a file that was never written.
    await removeQuietly(temporary, io);
  }

  return { outcome: "created", path };
}

/* -------------------------------------------------------------------------- */
/* Replace                                                                    */
/* -------------------------------------------------------------------------- */

async function replace(
  path: string,
  contents: string,
  expectedSha256: string,
  io: SafeWriteIo,
): Promise<SafeWriteResult> {
  const current = await readExisting(path, io);

  if (current === undefined) {
    // The file vanished between the caller reading it and asking to replace it. Replacing nothing would be a creation
    // dressed as a replacement, so it is refused in the same vocabulary as a changed file.
    return { outcome: "conflict", path, reason: "changed" };
  }

  if (hashContents(current) !== expectedSha256) {
    return { outcome: "conflict", path, reason: "changed" };
  }

  const backupPath = backupPathFor(path);
  await writeVerifiedBackup(backupPath, current, io);

  const temporary = await writeTemporary(path, contents, io);

  try {
    // The one destructive step, and it is atomic: the target holds either the old bytes or the new ones.
    await io.rename(temporary, path);
  } catch (error) {
    await removeQuietly(temporary, io);
    throw translateFilesystemError(error, "replace", path);
  }

  return { outcome: "replaced", path, backupPath };
}

/**
 * Copy the current content aside and prove the copy is readable.
 *
 * The read-back is the part worth defending. A backup whose creation was reported as successful, but which cannot be
 * read, is worse than no backup: it is a false assurance that turns "I can put it back" into a discovery made after the
 * original is gone. Verification costs one read of a file sized in kilobytes, and it happens before anything destructive.
 */
async function writeVerifiedBackup(
  backupPath: string,
  current: string,
  io: SafeWriteIo,
): Promise<void> {
  const temporary = await writeTemporary(backupPath, current, io);

  try {
    await io.rename(temporary, backupPath);
  } catch (error) {
    await removeQuietly(temporary, io);
    throw translateFilesystemError(error, "write the backup", backupPath);
  }

  let written: string;
  try {
    written = await io.read(backupPath);
  } catch (error) {
    throw translateFilesystemError(error, "verify the backup", backupPath);
  }

  if (written !== current) {
    throw new FilesystemError(
      ErrorCode.filesystemFailure,
      `The backup at ${backupPath} does not match the file it was copied from, so nothing was replaced.`,
      {
        context: { path: backupPath, operation: "verify the backup" },
        remediation:
          "Check the disk for errors, then run the command again. The configuration itself is unchanged.",
      },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Shared steps                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Write the bytes to a temporary file and make them durable.
 *
 * `sync` before the handle closes, not after: a file that is about to become visible under its final name should be
 * one whose bytes have reached the device, because the visible name is the promise.
 *
 * The temporary is removed on any failure, so a handled error never leaves anything behind. A crash leaves it — nothing
 * can prevent that — and the name is chosen so that a leftover is inert and identifiable rather than mistaken for a
 * configuration.
 */
async function writeTemporary(
  path: string,
  contents: string,
  io: SafeWriteIo,
): Promise<string> {
  const temporary = temporaryPathFor(path);

  let handle;
  try {
    handle = await io.openNew(temporary);

    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await removeQuietly(temporary, io);
    throw translateFilesystemError(error, "write", path);
  }

  return temporary;
}

/** The file's content, or `undefined` when there is nothing there. Absence is an answer, not a failure. */
async function readExisting(
  path: string,
  io: SafeWriteIo,
): Promise<string | undefined> {
  try {
    return await io.read(path);
  } catch (error) {
    if (hasErrorCode(error) && error.code === "ENOENT") return undefined;
    throw translateFilesystemError(error, "read", path);
  }
}

/**
 * Remove a file that may not exist, and never fail because of it.
 *
 * Best-effort on purpose: this runs in `finally` blocks, where throwing would replace the error that actually explains
 * what went wrong with a complaint about cleanup.
 */
async function removeQuietly(path: string, io: SafeWriteIo): Promise<void> {
  try {
    await io.remove(path);
  } catch {
    // Deliberately empty. A temporary file that could not be removed is litter, not a correctness problem, and the
    // failure that brought us here is the one worth reporting.
  }
}

/**
 * Whether a failure is "that name is taken".
 *
 * Handled here rather than in the shared translator, for the same reason `mkdir` handles it there: `EEXIST` means
 * different things to different operations — "the target is occupied" for a create, "the destination exists" for a
 * rename — and only the caller knows which answer it needs.
 */
function isExists(error: unknown): boolean {
  return hasErrorCode(error) && error.code === "EEXIST";
}
