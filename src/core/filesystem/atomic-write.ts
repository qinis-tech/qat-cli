/**
 * Writing a file without ever exposing a partial one.
 *
 * The strategy: write the whole contents to a uniquely named temporary file in the same
 * directory, flush it to disk, then rename it over the target. A rename within one directory is
 * atomic on every supported platform, so a reader sees either the old file or the new one and
 * never a truncated mixture.
 *
 * ## Why the temporary file must be in the same directory
 *
 * A rename across filesystems is not atomic and in fact fails outright with `EXDEV`. Putting the
 * temporary file in the system temp directory would work on a single-disk developer machine and
 * fail on a CI runner with a separate temp volume — the worst kind of portability bug, because
 * it only appears where the failure is least convenient.
 *
 * ## Why the flush happens before the rename
 *
 * Without it, the rename can complete while the contents are still buffered, so a power loss or
 * an abrupt termination leaves a correctly named file containing nothing. The rename promises
 * the name; the flush promises the contents.
 *
 * ## What is not done
 *
 * The parent directory is not flushed, so on some filesystems the rename itself may not survive a
 * crash even though the contents did. Directory flushing is POSIX-specific and costs a system
 * call on every write; for a CLI writing reports this trade is correct, and it is stated here
 * rather than discovered later.
 */
import { randomUUID } from "node:crypto";
import { open, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { ErrorCode } from "../errors/codes.js";
import { FilesystemError } from "../errors/errors.js";

import { translateFilesystemError } from "./errors.js";

export interface AtomicWriteOptions {
  /** File mode for a newly created file. Defaults to the process umask applied to `0o666`. */
  readonly mode?: number;
}

/**
 * Writes `contents` to `path` such that the file is never observed partially written.
 *
 * @throws {FilesystemError} when the parent directory does not exist, when the path cannot be
 *   written, or when the rename fails. In every failure case the target is left as it was and
 *   the temporary file is removed.
 */
export async function writeFileAtomic(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = dirname(path);

  // Checked up front, rather than letting the temporary file's creation fail with an `ENOENT`
  // that names the temporary path. Creating parents implicitly is deliberately not offered: a
  // typo in an output path should produce an error, not a directory tree in an unexpected place.
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

  // Unique per call, and including the process id, so two concurrent writers cannot collide and
  // a leftover file is attributable. The leading dot keeps it out of casual directory listings.
  const temporary = join(
    directory,
    `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );

  let handle: FileHandle | undefined;

  try {
    // `wx` fails if the path already exists. That is a defence against a pre-created symlink in a
    // directory another user can write to: without it, this call would follow the link and write
    // somewhere unintended.
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
        // Closing is best-effort here. The original failure is the one worth reporting, and
        // replacing it with a close error would hide it.
      }
    }

    try {
      // `force` makes this a no-op when the rename already moved the file. Running it
      // unconditionally is what guarantees no temporary file survives either path.
      await rm(temporary, { force: true });
    } catch {
      // Nothing further can be done, and throwing from a `finally` block would replace the
      // real error with a cleanup error.
    }
  }
}
