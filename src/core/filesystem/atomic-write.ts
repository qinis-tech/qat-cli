/**
 * Writing a file without ever exposing a partial one.
 *
 * Two operations, because there are two jobs, and the primitive that makes each one safe is not the same:
 *
 * | Job | Primitive | Guarantee |
 * | --- | --- | --- |
 * | Replace a file whose previous contents the caller has read | `rename` | A reader sees the old file or the new one, never a mixture |
 * | Create a file that must not already exist | `link` | A file that appeared a moment ago is not overwritten — the create fails instead |
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
 * ## What is not done
 *
 * The parent directory is not flushed, so on some filesystems the rename itself may not survive a crash even though the
 * contents did. Directory flushing is POSIX-specific and costs a system call on every write; for a CLI writing reports
 * this trade is correct, and it is stated here rather than discovered later.
 */
import { randomUUID } from "node:crypto";
import {
  link,
  open,
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
 * Shared by both operations so the two cannot describe the same defect differently.
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
 * attributable. The leading dot keeps it out of casual directory listings.
 */
function temporaryPathFor(path: string, directory: string): string {
  return join(
    directory,
    `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
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
  const directory = dirname(path);

  await assertWritableDirectory(directory, path);

  const temporary = temporaryPathFor(path, directory);

  let handle: FileHandle | undefined;

  try {
    // `wx` fails if the path already exists. That is a defence against a pre-created symlink in a directory another user
    // can write to: without it, this call would follow the link and write somewhere unintended.
    handle = await open(temporary, "wx", options.mode ?? 0o666);

    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await rename(temporary, path);
  } catch (error) {
    throw translateFilesystemError(error, "write", path);
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Closing is best-effort here. The original failure is the one worth reporting, and replacing it with a close
        // error would hide it.
      }
    }

    try {
      // `force` makes this a no-op when the rename already moved the file. Running it unconditionally is what
      // guarantees no temporary file survives either path.
      await rm(temporary, { force: true });
    } catch {
      // Nothing further can be done, and throwing from a `finally` block would replace the real error with a cleanup
      // error.
    }
  }
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
 * @throws {FilesystemError} when the parent directory does not exist, when the filesystem cannot create a file atomically,
 *   or when the write fails. In every failure case the target is untouched and the temporary file is removed.
 */
export async function writeNewFile(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<NewFileWriteOutcome> {
  const directory = dirname(path);

  await assertWritableDirectory(directory, path);

  const temporary = temporaryPathFor(path, directory);

  let handle: FileHandle | undefined;

  try {
    handle = await open(temporary, "wx", options.mode ?? 0o666);

    await handle.writeFile(contents);
    // Before the link, not after: a file that becomes visible must be a file whose bytes are already durable.
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      await link(temporary, path);
    } catch (error) {
      if (isAlreadyExists(error)) return "exists";

      if (isHardLinkUnsupported(error)) {
        throw new FilesystemError(
          ErrorCode.filesystemFailure,
          `Cannot create ${basename(path)}: this filesystem does not support hard links, so the file cannot be created without risking an existing one.`,
          {
            context: { path, directory },
            remediation:
              "Create the file on a filesystem that supports hard links, or create it by hand and run the command again.",
          },
        );
      }

      throw error;
    }

    return "created";
  } catch (error) {
    throw translateFilesystemError(error, "write", path);
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Best-effort, as above: the original failure is the one worth reporting.
      }
    }

    try {
      // Runs on every path, including the `"exists"` return and the success. Leaving the temporary name behind on success
      // would give one file two names, and the next `git status` would show a configuration nobody wrote.
      await rm(temporary, { force: true });
    } catch {
      // Nothing further can be done from here.
    }
  }
}

/** Whether a failure means the destination is already occupied. */
function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error) && error.code === "EEXIST";
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
