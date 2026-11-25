/**
 * Writing a file without ever exposing a partial one.
 *
 * Three operations, because there are three jobs, and the primitive that makes each one safe is not the same:
 *
 * | Job | Primitive | Guarantee |
 * | --- | --- | --- |
 * | Replace a file whose previous contents the caller has read | `rename` | A reader sees the old file or the new one, never a mixture |
 * | Create a file that must not already exist | `link` | A file that appeared a moment ago is not overwritten — the create fails instead |
 * | Replace a configuration, keeping what was there | `rename`, twice | The previous bytes are preserved and verified before the target changes |
 *
 * `rename` is the wrong primitive for creation, and it is the tempting one: it is atomic, it is already here, and it
 * silently replaces whatever is at the destination. For an edit that is exactly the contract. For a create it is data
 * loss with a successful return code.
 *
 * ## Why the temporary file must be in the same directory
 *
 * A rename across filesystems is not atomic and in fact fails outright with `EXDEV`. Putting the temporary file in the
 * system temp directory would work on a single-disk developer machine and fail on a CI runner with a separate temp
 * volume — the worst kind of portability bug, because it only appears where the failure is least convenient. The same
 * holds for the hard link, which cannot cross a filesystem either.
 *
 * ## Why the flush happens before the rename or the link
 *
 * Without it, the operation can complete while the contents are still buffered, so a power loss or an abrupt termination
 * leaves a correctly named file containing nothing. The rename promises the name; the flush promises the contents.
 *
 * ## Why a backup is read back before anything is replaced
 *
 * A backup whose creation was reported as successful, but which cannot be read, is worse than no backup: it is a false
 * assurance that turns "I can put it back" into a discovery made after the original is gone. The read-back costs one read
 * of a file measured in kilobytes and happens before the one destructive step.
 *
 * ## What is not done
 *
 * The parent directory is not flushed, so on some filesystems the rename itself may not survive a crash even though the
 * contents did. Directory flushing is POSIX-specific and costs a system call on every write; for a CLI writing reports
 * this trade is correct, and it is stated here rather than discovered later.
 *
 * Temporary files that survive a crash are never swept automatically. They are named so that nothing which reads
 * configurations will ever mistake one for one, and removing another writer's in-flight temporary would be worse than the
 * litter it cleans up.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  open,
  readFile,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { ErrorCode } from "../errors/codes.js";
import { FilesystemError } from "../errors/errors.js";

import { hasErrorCode, translateFilesystemError } from "./errors.js";

export interface AtomicWriteOptions {
  /** File mode for a newly created file. Defaults to the process umask applied to `0o666`. */
  readonly mode?: number;
}

/**
 * Checks that the destination's directory exists and is a directory.
 *
 * Checked up front, rather than letting the temporary file's creation fail with an `ENOENT` that names the temporary
 * path. Creating parents implicitly is deliberately not offered: a typo in an output path should produce an error, not a
 * directory tree in an unexpected place.
 *
 * Shared by every operation so they cannot describe the same defect differently.
 */
async function assertWritableDirectory(
  directory: string,
  path: string,
): Promise<void> {
  const parent = await stat(directory).catch(() => undefined);

  if (parent === undefined) {
    throw new FilesystemError(
      ErrorCode.filesystemFailure,
      `Cannot write ${basename(path)}: the directory ${directory} does not exist.`,
      {
        context: { path, directory },
        remediation: "Create the directory first.",
      },
    );
  }

  if (!parent.isDirectory()) {
    throw new FilesystemError(
      ErrorCode.filesystemFailure,
      `Cannot write ${basename(path)}: ${directory} is not a directory.`,
      { context: { path, directory }, remediation: "Check the output path." },
    );
  }
}

/**
 * A unique temporary name beside the target.
 *
 * Unique per call, and including the process id, so two concurrent writers cannot collide and a leftover file is
 * attributable. The leading dot keeps it out of casual directory listings, and the `.tmp` suffix keeps it invisible to
 * anything that reads a file by exact name — which is how a configuration is read.
 */
function temporaryPathFor(path: string, directory: string): string {
  return join(
    directory,
    `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
}

/**
 * Writes and flushes the contents of a file that must not already exist.
 *
 * The `wx` flag fails if the path exists. That is a defence against a pre-created symlink in a directory another user can
 * write to: without it, this call would follow the link and write somewhere unintended.
 */
async function writeAndFlush(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions,
): Promise<void> {
  let handle: FileHandle | undefined;

  try {
    handle = await open(path, "wx", options.mode ?? 0o666);
    await handle.writeFile(contents);
    // Before the handle closes: a file that is about to become visible must be one whose bytes have reached the device.
    await handle.sync();
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Closing is best-effort. The original failure is the one worth reporting, and replacing it with a close error
        // would hide it.
      }
    }
  }
}

/**
 * Runs one write of a temporary file and hands it to a commit step.
 *
 * The temporary file's whole lifecycle — create, flush, hand over, remove — is here for two reasons. Three operations
 * need it, and three copies of it would eventually disagree about the `finally`. And it is the only place that knows a
 * temporary file was created, which is what makes "nothing is left behind" a property of one function rather than a
 * habit of three.
 *
 * Errors from writing the temporary are translated here, because the caller has no context to improve on them. Errors
 * from the commit are the commit's own business: it may translate, it may convert one into a value, and it may need to
 * name the operation differently.
 */
async function withTemporaryFile<T>(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions,
  commit: (temporary: string) => Promise<T>,
): Promise<T> {
  const directory = dirname(path);

  await assertWritableDirectory(directory, path);

  const temporary = temporaryPathFor(path, directory);

  try {
    await writeAndFlush(temporary, contents, options);
  } catch (error) {
    await removeTemporary(temporary);
    throw translateFilesystemError(error, "write", path);
  }

  try {
    return await commit(temporary);
  } finally {
    // Runs on every path. Force makes it a no-op when a rename already moved the file, and a clean-up when the commit
    // refused or threw. Leaving the name behind on success would give one file two names, and the next `git status`
    // would show a file nobody wrote.
    await removeTemporary(temporary);
  }
}

/**
 * Removes a temporary file that may not exist, and never fails because of it.
 *
 * Best-effort on purpose: this runs in `finally` blocks, where throwing would replace the error that actually explains
 * what went wrong with a complaint about cleanup.
 */
async function removeTemporary(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Nothing further can be done, and the failure that brought us here is the one worth reporting.
  }
}

/**
 * Writes `contents` to `path` such that the file is never observed partially written, replacing whatever was there.
 *
 * @throws {FilesystemError} when the parent directory does not exist, when the path cannot be written, or when the
 *   rename fails. In every failure case the target is left as it was and the temporary file is removed.
 */
export async function writeFileAtomic(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await withTemporaryFile(path, contents, options, async (temporary) => {
    try {
      await rename(temporary, path);
    } catch (error) {
      throw translateFilesystemError(error, "write", path);
    }
  });
}

/** What happened when a file was asked to be created. */
export type NewFileWriteOutcome =
  /** The file did not exist and now does, with the complete contents. */
  | "created"
  /** Something was already at the path. Nothing was read, written, replaced or removed. */
  | "exists";

/**
 * Creates a file, refusing if one is already there.
 *
 * ## Why the answer is a value rather than an error
 *
 * "There is already a file here" is an ordinary answer to an ordinary question. A caller that treats it as an exception
 * ends up catching it and converting it straight back into a value, and in between there is an error path that can be
 * logged, rendered or swallowed by accident. This module's neighbours make the same call for a missing path, and the
 * reasoning is the same: an expected state is not a failure.
 *
 * It is also what makes the operation safe under a race. The caller has almost certainly checked the path already — that
 * check was advice, taken at an earlier moment. This call is the one that decides, because the kernel performs the check
 * and the effect together.
 *
 * ## Why `link` and not `rename`
 *
 * `rename` replaces the destination silently, so a file created between the caller's check and this call would be
 * destroyed and the caller would be told the write succeeded. `link` creates a second name for the temporary file and
 * fails with `EEXIST` if the destination is taken, which is the same test the caller made earlier — performed atomically,
 * by the filesystem, at the moment it matters. The temporary name is then removed, leaving one name for one file whose
 * bytes are already on disk and already flushed.
 *
 * ## What is lost
 *
 * Nothing a create needs. Durability of a *replacement* is what `rename` protects — there is previous content to keep
 * whole. Here there is none: a crash before the link leaves a stray temporary file and no target, which is a state the
 * caller can retry from.
 *
 * ## Filesystems without hard links
 *
 * Network mounts and FAT volumes may refuse `link` with `EPERM` or `ENOSYS`. That is reported as its own error with its
 * own remedy rather than silently degrading to a direct write: degrading would trade crash atomicity for portability
 * without telling anybody, which is a decision this operation is not entitled to make on a caller's behalf.
 *
 * @returns `"created"` when the file was written, `"exists"` when something was already at the path — in which case the
 *   target is untouched and the temporary file is gone.
 * @throws {FilesystemError} when the parent directory does not exist, when the filesystem cannot create a file
 *   atomically, or when the write fails. In every failure case the target is untouched and the temporary file is removed.
 */
export async function writeNewFile(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<NewFileWriteOutcome> {
  return withTemporaryFile(path, contents, options, async (temporary) => {
    try {
      await link(temporary, path);
    } catch (error) {
      if (isAlreadyExists(error)) return "exists";

      if (isHardLinkUnsupported(error)) {
        throw new FilesystemError(
          ErrorCode.filesystemFailure,
          `Cannot create ${basename(path)}: this filesystem does not support hard links, so the file cannot be created without risking an existing one.`,
          {
            context: { path, directory: dirname(path) },
            remediation:
              "Create the file on a filesystem that supports hard links, or create it by hand and run the command again.",
          },
        );
      }

      throw translateFilesystemError(error, "write", path);
    }

    return "created";
  });
}

/* -------------------------------------------------------------------------- */
/* Replacing, with a verified copy of what was there                          */
/* -------------------------------------------------------------------------- */

/** Where a replacement keeps the previous contents. A sibling, so the copy survives alongside the file it protects. */
export function backupPathFor(path: string): string {
  return `${path}.backup`;
}

/**
 * The hash a caller passes as `expectedSha256`.
 *
 * Hashes bytes. A caller that has the file as text may pass the string, which is equivalent for any file that is valid
 * UTF-8 — and a configuration that is not valid UTF-8 cannot be loaded, so it never reaches a replacement. Anything else
 * produces a mismatch and a refusal, which is the safe direction.
 */
export function hashContents(contents: string | Uint8Array): string {
  return createHash("sha256")
    .update(
      typeof contents === "string" ? Buffer.from(contents, "utf8") : contents,
    )
    .digest("hex");
}

export interface ReplaceFileOptions extends AtomicWriteOptions {
  /**
   * Hash of the bytes the caller read before deciding to replace.
   *
   * No default, and that is the contract: a replacement that does not know what it is replacing is a licence to clobber
   * whatever happens to be there. Requiring the hash makes the caller look first, and makes a file edited between the
   * read and the write a refusal rather than a loss.
   */
  readonly expectedSha256: string;
}

/** What happened when a file was asked to be replaced. */
export type ReplaceFileOutcome =
  /** The previous contents were preserved at {@link backupPathFor} and the target now holds the new contents. */
  | "replaced"
  /** The contents were not the contents the caller saw. Nothing was written, and no backup was taken. */
  | "changed"
  /** Nothing was at the path. A replacement of nothing is a creation, which this operation does not do. */
  | "missing";

/**
 * Replaces a file, keeping a verified copy of what was there.
 *
 * Four steps, and the order is the whole guarantee:
 *
 * 1. Read the current contents and compare the hash. A mismatch ends the operation with `"changed"` — a file edited
 *    while the caller was deciding is not the file they decided about.
 * 2. Write the previous contents to the sibling backup and read that file back. A backup that cannot be read is not a
 *    backup, and this is the last moment at which refusing costs nothing.
 * 3. Replace the target atomically, by rename.
 * 4. Report that it happened.
 *
 * Nothing in this function is reachable from a command. It exists so that a replacement, if one is ever approved, is a
 * caller passing an intent it had to construct — rather than a flag somebody types.
 *
 * @returns Which of the three outcomes occurred.
 * @throws {FilesystemError} when the machine could not do its part: the read, the backup, the verification or the
 *   replacement failed. In every failure case the target still holds its original contents.
 */
export async function replaceFileWithBackup(
  path: string,
  contents: string | Uint8Array,
  options: ReplaceFileOptions,
): Promise<ReplaceFileOutcome> {
  const current = await readBytes(path);

  if (current === undefined) return "missing";
  if (hashContents(current) !== options.expectedSha256) return "changed";

  // Built conditionally rather than spread, because `exactOptionalPropertyTypes` distinguishes "no mode" from
  // "a mode of undefined", and only the first is meaningful.
  const atomicOptions: AtomicWriteOptions =
    options.mode === undefined ? {} : { mode: options.mode };

  const backupPath = backupPathFor(path);

  await writeFileAtomic(backupPath, current, atomicOptions);
  await verifyBackup(backupPath, current);

  await writeFileAtomic(path, contents, atomicOptions);

  return "replaced";
}

/**
 * Proves the copy is there and is the right one, before anything destructive happens.
 *
 * Compared byte for byte rather than by hash: the point is that the bytes are readable and identical, and a hash match
 * would also hold for a file that could not be read back at all.
 */
async function verifyBackup(
  backupPath: string,
  expected: Uint8Array,
): Promise<void> {
  const written = await readBytes(backupPath);

  if (
    written === undefined ||
    !Buffer.from(written).equals(Buffer.from(expected))
  ) {
    throw new FilesystemError(
      ErrorCode.filesystemFailure,
      `Cannot replace the file: the backup at ${backupPath} does not match the file it was copied from, so the original was left untouched.`,
      {
        context: { path: backupPath, operation: "verify the backup" },
        remediation:
          "Check the disk for errors, then run the command again. The file itself is unchanged.",
      },
    );
  }
}

/** The file's bytes, or `undefined` when there is nothing there. Absence is an answer, not a failure. */
async function readBytes(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw translateFilesystemError(error, "read", path);
  }
}

/** Whether a failure means the destination is already occupied. */
function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error) && error.code === "EEXIST";
}

/** Whether a failure means there is nothing at the path. */
function isMissing(error: unknown): boolean {
  return hasErrorCode(error) && error.code === "ENOENT";
}

/**
 * Whether a failure means hard links are not available on this filesystem.
 *
 * `ENOSYS` is the plain statement; `EPERM` is what a Windows volume without hard-link support returns, and it is
 * indistinguishable from a permissions problem by code alone — which is why the message names the capability rather than
 * the permission, and why it is produced here, where the operation is known.
 */
function isHardLinkUnsupported(error: unknown): boolean {
  return (
    hasErrorCode(error) && (error.code === "EPERM" || error.code === "ENOSYS")
  );
}
