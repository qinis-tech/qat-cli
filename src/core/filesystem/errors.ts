/**
 * Translation of operating-system failures into the application error model.
 *
 * Node reports filesystem failures as an `Error` with a `code` string — `ENOENT`, `EACCES`, `EBUSY`. Those strings are
 * meaningful to a systems programmer and meaningless to the person running the command. This module is the single place
 * that converts one into the other, so that every filesystem failure in QAT arrives with a code, a category and, where one
 * exists, something to do about it.
 *
 * Translated errors keep the original as `cause`. The errno is also recorded in the context, because it is the first
 * thing anyone diagnosing a filesystem problem looks for.
 *
 * ## Two functions, and the order they are used in
 *
 * `isMissingPathError` answers whether a failure means "there is nothing at that path". `translateFilesystemError`
 * converts everything else. A caller that treats absence as an answer — discovery, the configuration loader — checks the
 * first and translates only what is left, which is what keeps "the file is not there" from arriving as a failure.
 */
import { ErrorCode } from "../errors/codes.js";
import { FilesystemError } from "../errors/errors.js";

/**
 * Narrows an unknown value to something carrying a Node error code.
 *
 * A type predicate rather than a cast: casts inside `catch` blocks are how an assumption about the thrown value becomes a
 * second exception while handling the first.
 */
export function hasErrorCode(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  );
}

/**
 * Whether a failure means there is nothing at the path.
 *
 * ## Two codes, not one
 *
 * `ENOENT` is the ordinary absence. `ENOTDIR` is a path whose parent segment is a file — `notes.txt/qat.config.json` —
 * and from a caller's side it is the same absence: there is nothing at that path, and there never could be.
 *
 * ## Why this is not a branch inside the translation
 *
 * The same errno means different things depending on the operation. A `stat` that returns `ENOTDIR` has found nothing,
 * which is an answer; a `writeFile` that returns it has been asked to create a file inside a file, which is a failure. Only
 * the caller knows which it was, so the predicate is separate and the caller decides — a translation that decided for
 * everybody would be wrong for half of them.
 *
 * ## Why not every "not found"-shaped code
 *
 * `ELOOP` is a symlink loop and `EACCES` is a directory that cannot be read; both can look like absence to a reader and
 * neither is. They are failures, and reporting them as "no configuration here" would send somebody to check the wrong
 * thing, which is the distinction the whole error model exists for.
 */
export function isMissingPathError(error: unknown): boolean {
  if (!hasErrorCode(error)) return false;

  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/**
 * Converts anything caught during a filesystem operation into a `FilesystemError`.
 *
 * @param error Whatever was thrown.
 * @param operation What was being attempted, phrased to follow "Cannot …". Recorded in the context rather than
 *   interpolated into the message, so a message stays a single sentence while the operation remains searchable.
 * @param path The path the operation was about. Not the temporary path an implementation happened to use internally.
 */
export function translateFilesystemError(
  error: unknown,
  operation: string,
  path: string,
): FilesystemError {
  const errno = hasErrorCode(error) ? error.code : undefined;

  const base = {
    cause: error,
    context: { path, operation, ...(errno === undefined ? {} : { errno }) },
  };

  switch (errno) {
    case "ENOENT":
      return new FilesystemError(
        ErrorCode.filesystemFailure,
        `${path} does not exist.`,
        {
          ...base,
          remediation:
            "Check the path, or run the command that creates it. QAT does not create parent directories implicitly.",
        },
      );

    case "EACCES":
    case "EPERM":
      return new FilesystemError(
        ErrorCode.filesystemFailure,
        `Permission denied: cannot ${operation} ${path}.`,
        {
          ...base,
          remediation:
            "Check the permissions on the file and its parent directories.",
        },
      );

    case "ENOSPC":
      return new FilesystemError(
        ErrorCode.filesystemFailure,
        `No space left on the device while trying to ${operation} ${path}.`,
        { ...base, remediation: "Free some space and run the command again." },
      );

    case "EROFS":
      return new FilesystemError(
        ErrorCode.filesystemFailure,
        `Cannot ${operation} ${path}: the filesystem is read-only.`,
        { ...base, remediation: "Choose a writable location for output." },
      );

    case "EISDIR":
      return new FilesystemError(
        ErrorCode.filesystemFailure,
        `Cannot ${operation} ${path}: it is a directory.`,
        { ...base, remediation: "Choose a file path rather than a directory." },
      );

    case "ENOTDIR":
      return new FilesystemError(
        ErrorCode.filesystemFailure,
        `Cannot ${operation} ${path}: part of the path is not a directory.`,
        {
          ...base,
          remediation: "Check the path for a segment that is actually a file.",
        },
      );

    case "ELOOP":
      return new FilesystemError(
        ErrorCode.filesystemFailure,
        `Cannot ${operation} ${path}: too many levels of symbolic links.`,
        {
          ...base,
          remediation: "Replace the symlink loop with a path that resolves.",
        },
      );

    case "EBUSY":
    case "ETXTBSY":
      return new FilesystemError(
        ErrorCode.filesystemLocked,
        `Cannot ${operation} ${path}: another process is using it.`,
        {
          ...base,
          remediation: "Close the program holding the file, then try again.",
        },
      );

    case "EMFILE":
    case "ENFILE":
      return new FilesystemError(
        ErrorCode.filesystemFailure,
        `Cannot ${operation} ${path}: too many files are open.`,
        {
          ...base,
          remediation: "Close other programs, or raise the open-file limit.",
        },
      );

    case "EXDEV":
      return new FilesystemError(
        ErrorCode.filesystemFailure,
        `Cannot ${operation} ${path}: the source and destination are on different filesystems.`,
        { ...base },
      );

    default:
      // No remediation, because there is nothing honest to suggest for a code this module does not know. The errno is in
      // the context and in the message, which is what a reader needs to search for it — inventing advice for `EUNKNOWN`
      // would be worse than admitting there is none.
      return new FilesystemError(
        ErrorCode.filesystemFailure,
        errno === undefined
          ? `Cannot ${operation} ${path}.`
          : `Cannot ${operation} ${path} (${errno}).`,
        { ...base },
      );
  }
}
