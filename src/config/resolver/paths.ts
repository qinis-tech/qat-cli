import * as nodePath from "node:path";

import type {
  PathIssue,
  PathIssueCode,
  PathResolution,
  PathTools,
  ResolvedPath,
  ResolvePathOptions,
} from "./contracts.js";

/**
 * Anchoring and validation for every path a configuration file can carry.
 *
 * The one rule that shapes this module: a path is **anchored**, never resolved. `path.resolve("reports")` silently
 * supplies `process.cwd()` as a hidden third argument, so the same configuration file writes to `<home>/reports` from a
 * shell and `<build>/reports` in continuous integration. Here a relative path is always joined to an explicit, absolute
 * project root, which makes resolution a pure function: same document plus same root gives a byte-identical result on
 * every machine, at every time of day.
 *
 * ## The absolute form is canonical, the source form is not
 *
 * `absolute` has no trailing separator and no interior `..` or duplicate separators, so two configurations that differ
 * only in how they spell the same location produce one value — equal by `===`, identical in a log line, safe to compare
 * in a test. `source` keeps what the reader wrote, because a diagnostic that echoes a normalised path hides the trailing
 * space or doubled separator that caused the problem.
 *
 * Everything below is free of side effects: no filesystem access, no clock, no environment lookup. That keeps the stage
 * fast enough to run on the project discovery path and cheap enough to test exhaustively.
 */

/**
 * Longest path accepted from a configuration file.
 *
 * Configuration paths are written by hand, so a value anywhere near the platform limit is a mistake rather than an
 * intent. Failing with our own message beats surfacing an opaque ENAMETOOLONG from the kernel halfway through a run.
 */
export const MAX_CONFIGURED_PATH_LENGTH = 4096;

/** How much of an offending value is echoed back, so diagnostics stay readable. */
const MAX_ECHOED_VALUE_LENGTH = 80;

/* -------------------------------------------------------------------------- */
/* Platform tools                                                             */
/* -------------------------------------------------------------------------- */

export const posixPathTools: PathTools = Object.freeze({
  isAbsolute: nodePath.posix.isAbsolute,
  normalize: nodePath.posix.normalize,
  join: (...parts: string[]) => nodePath.posix.join(...parts),
  relative: nodePath.posix.relative,
  separator: "/",
});

export const win32PathTools: PathTools = Object.freeze({
  isAbsolute: nodePath.win32.isAbsolute,
  normalize: nodePath.win32.normalize,
  join: (...parts: string[]) => nodePath.win32.join(...parts),
  relative: nodePath.win32.relative,
  separator: "\\",
});

/**
 * Host platform. Injecting these tools in tests is what lets the Windows rules be covered on a POSIX runner instead of
 * relying on the operating-system matrix to notice a regression.
 */
export const hostPathTools: PathTools =
  process.platform === "win32" ? win32PathTools : posixPathTools;

/* -------------------------------------------------------------------------- */
/* Containment                                                                */
/* -------------------------------------------------------------------------- */

/**
 * True when `absolute` is the project root itself or lives beneath it.
 *
 * Implemented with `relative()` rather than a string prefix, for two reasons that both bite in production:
 *
 * - Prefix comparison accepts siblings. `/work/proj-cache` starts with `/work/proj`, so a prefix test would happily write
 *   evidence into a neighbouring checkout.
 * - Prefix comparison rejects innocent names. A directory legitimately called `..data` starts with `..`, so the naive
 *   "does it start with ..?" guard would call an inside path an escape.
 *
 * Comparing segments avoids both. `win32.relative()` compares case-insensitively, which is the correct behaviour on a
 * case-insensitive filesystem.
 *
 * The check is lexical: symlinks are not followed. Real-path enforcement is an I/O concern and belongs to the filesystem
 * layer, not to a pure function.
 */
export function isWithinProjectRoot(
  absolute: string,
  projectRoot: string,
  pathTools: PathTools = hostPathTools,
): boolean {
  const root = pathTools.normalize(projectRoot);
  const target = pathTools.normalize(absolute);
  if (root === target) return true;

  const relativeToRoot = pathTools.relative(root, target);
  if (relativeToRoot === "") return true;

  return (
    relativeToRoot !== ".." &&
    !relativeToRoot.startsWith(`..${pathTools.separator}`) &&
    !pathTools.isAbsolute(relativeToRoot)
  );
}

/* -------------------------------------------------------------------------- */
/* Canonical form                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Normalise a path and drop a trailing separator.
 *
 * `path.normalize` keeps a single trailing separator, so `"reports/"` and `"reports"` would produce two different
 * absolute paths for one location. That difference is invisible to the filesystem and corrosive everywhere else: string
 * equality, log lines, report documents and deduplication all see two things where the reader wrote one.
 *
 * Two roots keep their separator, because removing it changes what the path means: `"/"` would become the empty string,
 * and `"C:\"` would become `"C:"`, which is not the drive root but a drive-relative path — a different and much worse
 * value than the one the reader wrote.
 */
function canonical(path: string, pathTools: PathTools): string {
  const normalised = pathTools.normalize(path);

  if (normalised.length <= 1) return normalised;
  if (!normalised.endsWith(pathTools.separator)) return normalised;

  const trimmed = normalised.slice(0, -1);

  // A Windows drive root must keep its separator: "C:" is drive-relative, "C:\" is the root.
  return trimmed.endsWith(":") ? normalised : trimmed;
}

/* -------------------------------------------------------------------------- */
/* Issue descriptions                                                         */
/* -------------------------------------------------------------------------- */

/** Inputs every message needs; `absolute` is present once anchoring has happened. */
interface IssueContext {
  readonly field: string;
  readonly value: unknown;
  readonly projectRoot: string;
  readonly absolute?: string;
}

interface IssueDescription {
  readonly message: string;
  /** What to write instead. Omitted only when the fix is genuinely self-evident. */
  readonly hint?: string;
}

/** Clip a value so one hostile field cannot flood the terminal. */
function truncate(
  value: string,
  limit: number = MAX_ECHOED_VALUE_LENGTH,
): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * Render an offending value without ever throwing.
 *
 * `JSON.stringify` is unsafe here: it throws on circular structures and on bigints, both of which a hand-edited file can
 * produce. Strings are escaped so a null byte appears as `\u0000` rather than corrupting the terminal.
 *
 * The result is always a `string`, which is what makes this safe to interpolate into a diagnostic: a template literal
 * cannot be handed an `unknown`.
 */
function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(truncate(value));
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  // Converted explicitly: `bigint` is not an accepted interpolation type.
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "an object" : typeof value;
}

/**
 * One template per issue code.
 *
 * Typed as an exhaustive record, so adding a code to `PATH_ISSUE_CODES` breaks compilation until a message exists for it.
 * The application cannot ship a rejection a user is unable to act on.
 *
 * ## What is echoed, and what is deliberately not
 *
 * Most messages quote the offending value, because a trailing space or a doubled separator is invisible until it is
 * printed. One does not: `PATH_FILE_URL`. A URL is the one path-shaped string that can carry credentials in its userinfo,
 * so `s3://key:secret@bucket/...` is described rather than repeated — a diagnostic reaches a terminal, a log and a
 * pasted issue, and a secret in any of those outlives the run that leaked it.
 */
export const PATH_ISSUE_TEMPLATES: Readonly<
  Record<PathIssueCode, (context: IssueContext) => IssueDescription>
> = Object.freeze({
  PATH_NOT_A_STRING: ({ field, value }) => ({
    message: `Configuration field "${field}" must be a path written as text, but it is ${describeValue(value)}.`,
    hint: 'Write the path as a string, for example "results/reports".',
  }),

  PATH_EMPTY: ({ field }) => ({
    message: `Configuration field "${field}" must not be empty.`,
    hint: 'Remove the field to accept the default, or set a path such as "results/reports".',
  }),

  PATH_SURROUNDING_WHITESPACE: ({ field, value }) => ({
    message: `Configuration field "${field}" has leading or trailing whitespace: ${describeValue(value)}.`,
    hint: "Remove the spaces around the path; they become part of the directory name.",
  }),

  PATH_NUL_BYTE: ({ field }) => ({
    message: `Configuration field "${field}" contains a null character.`,
    hint: "Remove the null character; it cannot appear in a file path.",
  }),

  PATH_BACKSLASH_SEPARATOR: ({ field, value }) => ({
    message: `Configuration field "${field}" uses a backslash separator: ${describeValue(value)}.`,
    hint: 'Use forward slashes, for example "results/reports", so the configuration works on every operating system.',
  }),

  PATH_HOME_ALIAS: ({ field, value }) => ({
    message: `Configuration field "${field}" starts with "~", which is not expanded: ${describeValue(value)}.`,
    hint: 'Write a path relative to the project root, for example "results/reports"; a home directory would make the configuration machine-specific.',
  }),

  PATH_FILE_URL: ({ field }) => ({
    // Deliberately not echoed: a URL can carry credentials in its userinfo, and a diagnostic is the one string
    // guaranteed to be logged and pasted into an issue.
    message: `Configuration field "${field}" looks like a URL rather than a filesystem path.`,
    hint: 'Write a filesystem path, for example "results/reports".',
  }),

  PATH_DRIVE_RELATIVE: ({ field, value }) => ({
    message: `Configuration field "${field}" is relative to a drive rather than fully qualified: ${describeValue(value)}.`,
    hint: 'Write a fully qualified path such as "C:/reports", or a project-relative path such as "results/reports".',
  }),

  PATH_TOO_LONG: ({ field, value }) => ({
    message: `Configuration field "${field}" is ${typeof value === "string" ? value.length : "longer than the limit"} characters long, which exceeds the ${MAX_CONFIGURED_PATH_LENGTH} character limit.`,
    hint: `Shorten the path to ${MAX_CONFIGURED_PATH_LENGTH} characters or fewer.`,
  }),

  PATH_ABSOLUTE_NOT_PERMITTED: ({ field, value }) => ({
    message: `Configuration field "${field}" must be relative to the project root, but it is the absolute path ${describeValue(value)}.`,
    hint: 'Write the path relative to the project root, for example "results/reports".',
  }),

  PATH_OUTSIDE_PROJECT_ROOT: ({ field, value, projectRoot, absolute }) => ({
    // `absolute` is always present for this code, but the fallback keeps the expression a `string`: interpolating the raw
    // `unknown` value would print "[object Object]" to a user.
    message: `Configuration field "${field}" resolves to "${absolute ?? describeValue(value)}", which is outside the project root "${projectRoot}".`,
    hint: 'Use a path inside the project, for example "results/reports"; resolved paths must stay within the project root.',
  }),
});

/** Render the description for a code. Exported for the diagnostics catalogue. */
export function describePathIssue(
  code: PathIssueCode,
  context: IssueContext,
): IssueDescription {
  return PATH_ISSUE_TEMPLATES[code](context);
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build a frozen issue.
 *
 * Every rule in this stage is structural — a path that breaks one cannot be used safely — so severity is always `error`.
 * It stays a field so a future relaxation is a data change rather than an API change.
 */
function createIssue(code: PathIssueCode, context: IssueContext): PathIssue {
  const { message, hint } = describePathIssue(code, context);
  const issue: PathIssue = {
    code,
    severity: "error",
    field: context.field,
    value: context.value,
    projectRoot: context.projectRoot,
    message,
    // Spread conditionally so an absent hint stays absent rather than becoming an explicit `undefined`, which strict
    // optional-property settings reject.
    ...(hint === undefined ? {} : { hint }),
  };
  return Object.freeze(issue);
}

function reject(code: PathIssueCode, context: IssueContext): PathResolution {
  return { ok: false, issue: createIssue(code, context) };
}

/**
 * Guard against a project root that is empty or relative.
 *
 * A relative root would reintroduce exactly the working-directory dependency this module exists to remove, and it would
 * do so invisibly. This is a programming error, not a user error, so it throws instead of returning an issue the CLI
 * would have to render.
 */
export function assertAbsoluteProjectRoot(
  projectRoot: string,
  pathTools: PathTools,
): void {
  if (projectRoot.length === 0 || !pathTools.isAbsolute(projectRoot)) {
    throw new TypeError(
      `Configuration resolution requires an absolute project root, received "${projectRoot}". ` +
        "Take it from the resolved project context rather than from the working directory.",
    );
  }
}

/**
 * Result of the untrusted-shape check.
 *
 * A discriminated union rather than "code or undefined": the success branch hands back a `string`, so the rest of
 * `resolvePath` works with a narrowed value and needs no type assertion.
 */
type ShapeCheck =
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly code: PathIssueCode };

/**
 * Reject inputs that cannot be trusted, before any path arithmetic happens.
 *
 * Ordered by how fundamental the problem is, so the reported reason is the one a user should fix first: type, emptiness,
 * padding, control characters, length.
 */
function checkShape(value: unknown): ShapeCheck {
  if (typeof value !== "string")
    return { ok: false, code: "PATH_NOT_A_STRING" };
  if (value.trim().length === 0) return { ok: false, code: "PATH_EMPTY" };
  if (value !== value.trim())
    return { ok: false, code: "PATH_SURROUNDING_WHITESPACE" };
  if (value.includes("\u0000")) return { ok: false, code: "PATH_NUL_BYTE" };
  if (value.length > MAX_CONFIGURED_PATH_LENGTH)
    return { ok: false, code: "PATH_TOO_LONG" };
  return { ok: true, source: value };
}

/** A URI scheme, e.g. `file://` or `s3://`. Hoisted so it is compiled once. */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//iu;

/** A Windows drive-relative path, e.g. `C:reports`. */
const DRIVE_RELATIVE = /^[a-z]:(?![\\/])/iu;

/**
 * Validate and anchor a single configured path.
 *
 * Checks run cheapest-and-most-fundamental first, so the reported reason is the one a user should fix first: shape, then
 * portability, then policy, then containment. A value rejected at the shape stage never reaches path arithmetic, which
 * keeps hostile input out of `join()` entirely.
 */
export function resolvePath(
  value: unknown,
  options: ResolvePathOptions,
): PathResolution {
  const pathTools = options.pathTools ?? hostPathTools;
  const { field, policy, projectRoot } = options;

  if (field.length === 0) {
    throw new TypeError(
      "resolvePath requires the dotted field name it is resolving.",
    );
  }
  assertAbsoluteProjectRoot(projectRoot, pathTools);

  const context: IssueContext = { field, value, projectRoot };

  const shape = checkShape(value);
  if (!shape.ok) return reject(shape.code, context);

  const source = shape.source;

  // Backslashes are rejected before the drive-relative check on purpose: a Windows user pasting "C:\reports" should be
  // told the portable spelling, not lectured about drive qualification.
  if (policy.rejectBackslashes && source.includes("\\")) {
    return reject("PATH_BACKSLASH_SEPARATOR", context);
  }
  if (source.startsWith("~")) return reject("PATH_HOME_ALIAS", context);
  if (SCHEME_PREFIX.test(source)) return reject("PATH_FILE_URL", context);
  // "C:reports" is relative to the drive's current directory: never what a user means, and impossible to reason about, so
  // it is refused outright.
  if (DRIVE_RELATIVE.test(source))
    return reject("PATH_DRIVE_RELATIVE", context);

  const form = pathTools.isAbsolute(source) ? "absolute" : "relative";
  if (form === "absolute" && !policy.allowAbsolute) {
    return reject("PATH_ABSOLUTE_NOT_PERMITTED", context);
  }

  // Relative paths join the *project root*. Using path.resolve() here would silently anchor to the working directory,
  // which differs between a developer's shell, a continuous-integration job and an editor task runner.
  const absolute = canonical(
    form === "absolute" ? source : pathTools.join(projectRoot, source),
    pathTools,
  );

  const withinProjectRoot = isWithinProjectRoot(
    absolute,
    projectRoot,
    pathTools,
  );
  if (policy.requireWithinProjectRoot && !withinProjectRoot) {
    return reject("PATH_OUTSIDE_PROJECT_ROOT", { ...context, absolute });
  }

  const resolved: ResolvedPath = {
    source,
    absolute,
    form,
    withinProjectRoot,
  };
  return { ok: true, path: Object.freeze(resolved) };
}
