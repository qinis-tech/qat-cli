/**
 * Translation of operating-system failures into the application error model.
 *
 * Node reports filesystem failures as an `Error` with a `code` string — `ENOENT`, `EACCES`,
 * `EBUSY`. Those strings are meaningful to a systems programmer and meaningless to the person
 * running the command. This module is the single place that converts one into the other, so
 * that every filesystem failure in QAT arrives with a code, a category and, where one exists,
 * something to do about it.
 *
 * Translated errors keep the original as `cause`. The errno is also recorded in the context,
 * because it is the first thing anyone diagnosing a filesystem problem looks for.
 */
import { ErrorCode } from "../errors/codes.js";
import { FilesystemError } from "../errors/errors.js";

/**
 * Narrows an unknown value to something carrying a Node error code.
 *
 * A type predicate rather than a cast: casts inside `catch` blocks are how an assumption
 * about the thrown value becomes a second exception while handling the first.
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
 * Converts anything caught during a filesystem operation into a `FilesystemError`.
 *
 * @param error Whatever was thrown.
 * @param operation What was being attempted, phrased to follow "Cannot …". Recorded in the
 *   context rather than interpolated into the message, so a message stays a single sentence
 *   while the operation remains searchable.
 * @param path The path the operation was about. Not the temporary path an implementation
 *   happened to use internally.
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
      return new FilesystemError(
        ErrorCode.filesystemFailure,
        `Cannot ${operation} ${path}${errno === undefined ? "." : ` (${errno}).`}`,
        { ...base },
      );
  }
}
