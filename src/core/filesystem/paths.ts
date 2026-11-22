/**
 * Path arithmetic and containment.
 *
 * ## The rule this module exists to enforce
 *
 * `path.join` is not a security check. `join('/out', '../../etc/passwd')` produces
 * `/etc/passwd` and reports success. Every path built from a value the caller did not write itself —
 * a suite name, a spec description, a configured output directory — must be resolved through
 * `resolveWithin`, which checks where the result actually landed.
 *
 * The same reasoning applies to absolutising. `resolve('relative')` silently produces a path
 * depending on where the process happened to be started, so a relative path is refused rather than
 * quietly resolved against something the caller never named.
 *
 * Containment is purely lexical: it does not consult the filesystem, so it cannot detect that a
 * symlink points outside the root. That limitation is stated rather than hidden — see the note on
 * `resolveWithin`.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ErrorCode } from "../errors/codes.js";
import { FilesystemError } from "../errors/errors.js";

/**
 * Rejects a null byte, which the operating system truncates a path at.
 *
 * The offending value is deliberately **not** recorded in the error context. A null byte in a log
 * line truncates whatever reads it next, so reporting the path would damage the very output a
 * reader needs to diagnose the problem.
 */
function assertNoNullByte(value: string, label: string): void {
  if (!value.includes("\0")) return;

  throw new FilesystemError(
    ErrorCode.filesystemPathInvalid,
    `${label} contains a null byte.`,
    {
      context: {},
      remediation: "Remove the null byte from the value.",
    },
  );
}

/**
 * Rejects values that cannot be a path, before any path arithmetic runs.
 *
 * Two cases, both of which otherwise produce a surprising success: a null byte, which the operating
 * system truncates at, and an empty string, which `resolve` silently turns into the working
 * directory. Both are always mistakes at the call site.
 */
function assertUsablePath(input: string, label: string): void {
  assertNoNullByte(input, label);

  if (input.trim().length === 0) {
    throw new FilesystemError(
      ErrorCode.filesystemPathInvalid,
      `${label} is empty.`,
      {
        context: {},
        remediation:
          "Pass a path, or omit the value entirely to use the default.",
      },
    );
  }
}

/**
 * Whether `candidate` is `root` itself or something beneath it. Both are resolved first.
 *
 * Uses `path.relative` rather than a string prefix, because a prefix test accepts `/output-backup`
 * for the root `/output`. And uses the platform's own `relative`, so Windows drive letters and
 * case-insensitive comparison are handled by the runtime rather than by a hand-written rule.
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
 * @throws {FilesystemError} `QAT5003` when a segment is absolute or the result escapes the root,
 *   or when a segment contains a null byte.
 *
 * A symlink inside the root that points outside it will pass this check. Detecting that requires
 * resolving the link, which requires the path to exist, which is not true when the function is used
 * to build the path of a file about to be written. Callers that handle attacker-controlled input and
 * also write into a shared directory should resolve the real path after creation, or keep that
 * directory private to the current user.
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

    // Not `assertUsablePath`: an empty segment is harmless here (`resolve` ignores it), and
    // rejecting it would make this function stricter than the arithmetic it wraps for no benefit.
    assertNoNullByte(segment, "Path segment");
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
 * Normalises an absolute path to a single canonical spelling.
 *
 * Rejects a relative input rather than resolving it, because resolving a relative path silently
 * makes the answer depend on the working directory — which is the class of bug this module exists to
 * remove. A caller that has a relative path and wants it made absolute must say what it is relative
 * to, using `resolveAgainst`.
 *
 * Uses `resolve` for its documented canonicalisation rather than `normalize`, because the two differ
 * on the one point that matters here: `normalize` **preserves** a trailing separator, while `resolve`
 * **removes** it unless the result is a filesystem root. Two spellings of the same directory are a
 * defect waiting to happen — an unequal comparison, a cache key that never hits, a test that passes
 * on one machine and not another — so the canonical form is the one without the separator.
 */
export function normalizeAbsolutePath(input: string): string {
  assertUsablePath(input, "Path");

  if (!isAbsolute(input)) {
    throw new FilesystemError(
      ErrorCode.filesystemPathInvalid,
      `${input} is not an absolute path.`,
      {
        context: { path: input },
        remediation:
          "Pass an absolute path, or use resolveAgainst to combine it with a base.",
      },
    );
  }

  return resolve(input);
}

/**
 * Resolves a path against an absolute base.
 *
 * An absolute target is normalised and returned unchanged: an explicit absolute path is a deliberate
 * override, and quietly re-basing it would be the more surprising behaviour.
 *
 * This is the function to use for anything a user typed — a `--cwd`, a `--config`, an output
 * directory — because it makes the base explicit instead of inheriting it from the process.
 */
export function resolveAgainst(base: string, target: string): string {
  const absoluteBase = normalizeAbsolutePath(base);

  assertUsablePath(target, "Path");

  return isAbsolute(target)
    ? normalizeAbsolutePath(target)
    : normalizeAbsolutePath(resolve(absoluteBase, target));
}

/**
 * A path relative to `root`, always using forward slashes.
 *
 * Stored paths are written with `/` regardless of platform. A result produced on Windows and read on
 * Linux must name the same file, and a backslash in stored data is either a separator or an escape
 * depending on who reads it next.
 */
export function toPortableRelativePath(root: string, target: string): string {
  return relative(resolve(root), resolve(target)).split(sep).join("/");
}

/**
 * Converts a stored, forward-slash path into the platform's separator.
 *
 * The counterpart to `toPortableRelativePath`. Portable paths are always relative — a leading slash
 * would mean different things on the two platforms, so it is not accepted.
 */
export function fromPortablePath(portable: string): string {
  assertUsablePath(portable, "Portable path");

  if (isAbsolute(portable)) {
    throw new FilesystemError(
      ErrorCode.filesystemPathInvalid,
      `${portable} is absolute, and a stored path must be relative.`,
      {
        context: { path: portable },
        remediation: "Strip the root before storing the path.",
      },
    );
  }

  return portable.split("/").join(sep);
}

/**
 * Refuses a path that resolves outside an approved directory.
 *
 * The check `resolveWithin` performs while building a path, exposed for the case where the path
 * already exists and is being validated before use. Same rule, same error, different moment.
 */
export function assertWithin(
  root: string,
  candidate: string,
  operation: string,
): void {
  if (isWithin(root, candidate)) return;

  throw new FilesystemError(
    ErrorCode.filesystemPathInvalid,
    `${operation} refused: the path is outside ${root}.`,
    {
      context: { root, candidate },
      remediation: "Use a path inside the approved directory.",
    },
  );
}
