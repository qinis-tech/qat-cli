/**
 * Path arithmetic and containment.
 *
 * ## The rule this module exists to enforce
 *
 * `path.join` is not a security check. `join('/out', '../../etc/passwd')` produces
 * `/etc/passwd` and reports success. Every path built from a value the caller did not write
 * itself — a suite name, a spec description, a configured output directory — must be resolved
 * through `resolveWithin`, which checks where the result actually landed.
 *
 * Purely lexical: it does not consult the filesystem, so it cannot detect that a symlink points
 * outside the root. That limitation is stated rather than hidden — see the note on
 * `resolveWithin`.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ErrorCode } from "../errors/codes.js";
import { FilesystemError } from "../errors/errors.js";

/**
 * Whether `candidate` is `root` itself or something beneath it. Both are resolved first.
 *
 * Uses `path.relative` rather than a string prefix, because a prefix test accepts
 * `/output-backup` for the root `/output`. And uses the platform's own `relative`, so Windows
 * drive letters and case-insensitive comparison are handled by the runtime rather than by a
 * hand-written rule.
 */
export function isWithin(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);

  if (resolvedRoot === resolvedCandidate) return true;

  const path = relative(resolvedRoot, resolvedCandidate);

  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

/**
 * Resolves path segments against a root, refusing anything that escapes it.
 *
 * @throws {FilesystemError} `QAT5003` when a segment is absolute or the result escapes the
 *   root, or when a segment contains a null byte.
 *
 * A symlink inside the root that points outside it will pass this check. Detecting that
 * requires resolving the link, which requires the path to exist, which is not true when the
 * function is used to build the path of a file about to be written. Callers that handle
 * attacker-controlled input and also write into a shared directory should resolve the real
 * path after creation, or keep that directory private to the current user.
 */
export function resolveWithin(
  root: string,
  ...segments: readonly string[]
): string {
  const resolvedRoot = resolve(root);

  for (const segment of segments) {
    if (isAbsolute(segment)) {
      throw new FilesystemError(
        ErrorCode.filesystemPathInvalid,
        `Cannot resolve ${segment} within ${resolvedRoot}: an absolute segment discards the root.`,
        {
          context: { root: resolvedRoot, segment },
          remediation: "Pass a path relative to the root.",
        },
      );
    }

    if (segment.includes("\0")) {
      throw new FilesystemError(
        ErrorCode.filesystemPathInvalid,
        "Path contains a null byte.",
        {
          context: { root: resolvedRoot },
          remediation: "Remove the null byte from the path.",
        },
      );
    }
  }

  const target = resolve(resolvedRoot, ...segments);

  if (!isWithin(resolvedRoot, target)) {
    throw new FilesystemError(
      ErrorCode.filesystemPathInvalid,
      `Resolved path escapes the approved directory.`,
      {
        context: { root: resolvedRoot, target },
        remediation: "Use a path that stays inside the output directory.",
      },
    );
  }

  return target;
}

/**
 * A path relative to `root`, always using forward slashes.
 *
 * Stored paths are written with `/` regardless of platform. A result produced on Windows and
 * read on Linux must name the same file, and a backslash in stored data is either a separator
 * or an escape depending on who reads it next.
 */
export function toPortableRelativePath(root: string, target: string): string {
  return relative(resolve(root), resolve(target)).split(sep).join("/");
}
