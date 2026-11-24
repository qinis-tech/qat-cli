import { mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { ErrorCode } from "../errors/codes.js";
import { FilesystemError } from "../errors/errors.js";

import { hasErrorCode, translateFilesystemError } from "./errors.js";

/**
 * Directory creation, on demand.
 *
 * Directories are created at the till, not at the door. A command that
 * initialises a project writes one file and nothing else; the reports and
 * evidence directories appear when a command first has something to put in them.
 * The alternative — scaffolding empty directories during setup — leaves a
 * repository looking as though a run happened when none did, adds noise to every
 * diff, and survives a setup that failed halfway.
 *
 * Two properties make this safe to call from anywhere in a write path:
 *
 * - **Idempotent.** `recursive: true` already resolves without error when the
 *   directory exists, so two writers racing to the same path cannot fail each
 *   other and no caller needs to check first (a check would be a race anyway).
 * - **Explicit failure.** A writer that cannot create its output directory must
 *   not report success. Failures are translated by the filesystem error module, so
 *   every directory problem reaches the user with the same code, category and
 *   remediation as every other filesystem problem in the application.
 *
 * No permission mode is imposed. The directory inherits the process umask, so it
 * follows the conventions of the project it lives in rather than whichever mode
 * this file happened to choose.
 */

/**
 * The filesystem operations this module needs.
 *
 * Narrowed to one method so tests can drive every branch — permission denied,
 * file in the way, read-only volume — without touching a real filesystem. If the
 * shared `file-system.ts` port already exposes `mkdir`, widen it and pass it here;
 * the body of {@link ensureDirectory} does not change.
 */
export interface DirectoryIo {
  /**
   * Mirrors `fs.promises.mkdir` with `recursive: true`, which resolves to the
   * first directory it created, or `undefined` when everything already existed.
   */
  readonly mkdir: (
    path: string,
    options: { readonly recursive: true },
  ) => Promise<string | undefined>;
}

const nodeDirectoryIo: DirectoryIo = {
  mkdir: async (path, options) => mkdir(path, options),
};

export interface EnsureDirectoryResult {
  readonly path: string;
  /** True when this call created at least one directory, false when it already existed. */
  readonly created: boolean;
}

/**
 * Create a directory, and any missing parents, if it is not already there.
 *
 * Call this immediately before the first write to the directory, never during
 * initialisation. Returns whether anything was actually created, which lets a
 * caller log the difference between "set up" and "already present" without a
 * second filesystem call.
 */
export async function ensureDirectory(
  absolutePath: string,
  io: DirectoryIo = nodeDirectoryIo,
): Promise<EnsureDirectoryResult> {
  if (!isAbsolute(absolutePath)) {
    // A regression tripwire, not a security boundary. A relative path here would
    // resolve against the working directory and recreate exactly the class of bug
    // that anchoring to the project root exists to remove — and it would do so in
    // the one place nobody looks, at write time.
    throw new FilesystemError(
      ErrorCode.filesystemFailure,
      `Refusing to create a directory from a relative path: "${absolutePath}".`,
      {
        context: { path: absolutePath, operation: "create directory" },
        remediation:
          "Pass an absolute path resolved against the project root; a relative path would be resolved against the working directory.",
      },
    );
  }

  try {
    const created = await io.mkdir(absolutePath, { recursive: true });
    return { path: absolutePath, created: created !== undefined };
  } catch (error) {
    // `mkdir` with `recursive: true` reports `EEXIST` only when something that is
    // not a directory already occupies the path: the "directory is already there"
    // case resolves silently. The shared translator deliberately leaves `EEXIST`
    // alone, because the same errno means "already present" for a creation and
    // "would be overwritten" for a write, and only the caller knows which it is —
    // the same reasoning `errors.ts` documents for `ENOTDIR`. Here the meaning is
    // unambiguous, so it is translated locally.
    if (hasErrorCode(error) && error.code === "EEXIST") {
      throw new FilesystemError(
        ErrorCode.filesystemFailure,
        `Cannot create directory ${absolutePath}: a file already exists at that path.`,
        {
          cause: error,
          context: {
            path: absolutePath,
            operation: "create directory",
            errno: error.code,
          },
          remediation:
            "Remove the file, or point the reports or evidence directory at a different location.",
        },
      );
    }

    // Everything else — `EACCES`, `EROFS`, `ENOSPC`, `ENOTDIR`, `ELOOP`, `EMFILE`,
    // `EXDEV`, and anything unknown — already has a message and a remedy in one
    // place. Re-listing those codes here would be a second catalogue to keep in
    // step, and the two would eventually disagree about what to tell a user.
    throw translateFilesystemError(error, "create directory", absolutePath);
  }
}
