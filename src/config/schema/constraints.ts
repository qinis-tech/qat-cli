/**
 * The primitives every configuration field is built from.
 *
 * Three of them, and each exists because it is used more than once or because the rule behind it is not obvious from the
 * call site. A constraint written inline at one field is a constraint the next field will not have.
 *
 * ## Why the messages state the reason
 *
 * A validation message reaches a user in a terminal and a script in a JSON document. `must be relative` tells them what
 * the rule is; `must be relative to the project root, because an absolute path embeds one machine and breaks every
 * other` tells them why the tool is asking, which is what makes the next attempt succeed.
 */
import { z } from "zod";

/** A path's length bound. Long enough for `results/reports/2026-11-24/nightly`, short enough to read in an error. */
const MAX_PATH_LENGTH = 256;

/**
 * Names a path segment may not use.
 *
 * Not a style rule. A `..` segment is how a path leaves the project root, and a write outside the project is a
 * different class of defect from a wrong directory — `reports/../../etc` is not a typo, and a schema that accepts it has
 * to trust every later consumer to re-check. `.` is included because it is a segment that means "this directory" and
 * makes the resolved path different from the written one for no benefit.
 */
const FORBIDDEN_SEGMENTS = new Set([".", ".."]);

/**
 * Names refused wherever a user-supplied key would become a property.
 *
 * Exported because the check has to run twice: once on the raw input, where the key still exists, and once as a
 * refinement on each key schema, where it costs nothing and catches a caller that reached a record directly.
 */
export const RESERVED_NAMES = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/**
 * Returns whether a string contains C0 control characters or DEL.
 *
 * This uses character codes instead of a regular expression so lint rules do not mistake the range for literal control
 * characters in a regular expression. Newlines and tabs are included: a configuration value is a single line.
 */
function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }

  return false;
}

/**
 * A path inside the project, written so the same file works on every machine.
 *
 * Six rules, and the schema reports **the first one broken** rather than all six, because they overlap: an absolute path
 * with a backslash is one mistake, not two.
 */
export const relativeProjectPath = z
  .string()
  .min(1, "must not be empty")
  .max(MAX_PATH_LENGTH, `must be at most ${String(MAX_PATH_LENGTH)} characters`)
  .superRefine((value, ctx) => {
    const refuse = (message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    };

    if (containsControlCharacters(value)) {
      return refuse(
        "must not contain control characters, because it is written into reports and logs",
      );
    }

    if (value.includes("\\")) {
      return refuse(
        "must use forward slashes, so the same file works on every platform",
      );
    }

    if (value.startsWith("/")) {
      return refuse(
        "must be relative to the project root, because an absolute path embeds one machine and breaks every other",
      );
    }

    // A Windows absolute path or a drive-relative one. Caught here rather than by a platform check, because a
    // configuration committed on Windows is read on Linux in CI.
    if (/^[A-Za-z]:/.test(value)) {
      return refuse(
        "must be relative to the project root, not a drive-qualified path",
      );
    }

    const segments = value.split("/");

    if (segments.some((segment) => segment === "")) {
      return refuse(
        "must not contain a leading or trailing slash, or a repeated separator",
      );
    }

    if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
      return refuse(
        'must not contain "." or ".." segments, because a path that resolves outside the project is a write outside the project',
      );
    }
  });

/**
 * A profile name: lowercase, hyphenated, short.
 *
 * The shape is chosen so a name can be typed on a command line and used as part of a directory name without quoting or
 * case-folding surprises. Fifteen characters of prose would be friendlier; the constraint is what keeps `--environment`
 * unambiguous across shells.
 */
export const environmentName = z
  .string()
  .min(1, "must not be empty")
  .max(32, "must be at most 32 characters")
  .regex(
    /^[a-z][a-z0-9-]*$/,
    "must start with a lowercase letter and contain only lowercase letters, digits and hyphens",
  )
  .refine(
    (name) => !RESERVED_NAMES.has(name),
    "is reserved by the language and cannot be used as a profile name",
  );

/**
 * A variable name, as an environment variable would be written.
 *
 * Upper case because these values are also passed to a child process, where a lowercase name is legal and a surprise.
 * One spelling, applied here, is what stops a configuration working on one platform and not another.
 */
export const environmentVariableName = z
  .string()
  .min(1, "must not be empty")
  .max(128, "must be at most 128 characters")
  .regex(
    /^[A-Z][A-Z0-9_]*$/,
    "must be uppercase letters, digits and underscores, because it is also passed to the framework as an environment variable",
  )
  .refine(
    (name) => !RESERVED_NAMES.has(name.toLowerCase()),
    "is reserved by the language and cannot be used as a variable name",
  );

/**
 * A variable value.
 *
 * One line, bounded, and no control characters. A value with a newline is almost always a paste accident, and one with
 * an escape sequence can move a cursor in whatever later prints it — the same reason the CLI filters its own output.
 */
export const environmentVariableValue = z
  .string()
  .max(4096, "must be at most 4096 characters")
  .refine(
    (value) => !containsControlCharacters(value),
    "must be a single line without control characters",
  );
