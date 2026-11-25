/**
 * The primitives every configuration field is built from.
 *
 * Five of them, and each exists because it is used more than once or because the rule behind it is not obvious from the
 * call site. A constraint written inline at one field is a constraint the next field will not have.
 *
 * ## What belongs here, and what does not
 *
 * This file holds **string** primitives: one value in, one verdict out. Rules about *shapes* — a profile that must declare
 * something, a map that must not be empty — live beside the shape itself, in `profiles.ts`, because they are refinements
 * over objects rather than over values, and a reader looking for "why was my environment refused" should not have to check
 * two files to find out which kind of rule fired.
 *
 * Two of the constraints below are also used outside the configuration document: `environmentName` validates the name a
 * command was asked for, before it is looked up, and `profileBaseUrl` validates an approved override, so an environment
 * variable or a flag cannot introduce a target the file would have refused. A rule with a bypass is not a rule, which is
 * why the same function is called rather than an equivalent one.
 *
 * ## One issue per value, always
 *
 * Every constraint here is a single `superRefine` that checks its rules in order and **returns after the first one
 * broken**. That is not a style preference: zod runs the checks of a `.min().max().regex().refine()` chain
 * independently, so a value that breaks two of them produces two issues at the same path. A reader who typed `""` has
 * one thing to fix, and a `--json` consumer that groups issues by path sees a field listed twice.
 *
 * The cost is that the issue `code` is `custom` rather than `too_small`, `too_big` or `invalid_format`. Nothing
 * downstream depends on that distinction — the diagnostics layer maps all of them to the same category — and in exchange
 * every constraint states its own message, which is where the reason lives.
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
 * A base URL's length bound.
 *
 * Generous, because a URL carries a host, a path and often a query. Bounded at all so a paste accident produces a
 * sentence about the field rather than a document nobody can read.
 */
const MAX_BASE_URL_LENGTH = 2048;

/** A profile name's bound. Short enough to type on a command line and to use inside a directory name. */
const MAX_ENVIRONMENT_NAME_LENGTH = 32;

/** A variable name's bound. Far above any real name, close enough to catch a paste of the wrong thing. */
const MAX_VARIABLE_NAME_LENGTH = 128;

/** A variable value's bound. Generous for a token or a URL, bounded so a mistaken paste is reported rather than stored. */
const MAX_VARIABLE_VALUE_LENGTH = 4096;

/** The pattern a profile name must match. Hoisted so the rule and its message cannot drift apart. */
const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]*$/;

/** The pattern a variable name must match. Hoisted for the same reason. */
const ENVIRONMENT_VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * The shape a value has when somebody has tried to write a secret reference into a variable.
 *
 * Narrow on purpose. A broad pattern would refuse innocent values that happen to contain a colon; this one matches only
 * the prefix people actually reach for when they are trying to point at a secret from the wrong map.
 */
const SECRET_REFERENCE_SHAPE = /^env:/iu;

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
 * Exported because the check has to run in three places, and each catches a case the others cannot: on the raw input,
 * where a `__proto__` key still exists as a key (assigning it changes a prototype rather than adding a property, so a
 * record schema never sees it); as a refinement on each key schema, where it costs nothing and catches a caller that
 * reached a record directly; and by the walking check in `config.ts`, which descends into a profile's `variables` and
 * `secrets` maps because those keys are the user's too.
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
 * Six rules, and **the first one broken is the one reported**, because they overlap: an absolute path with a backslash is
 * one mistake, not two, and an empty path would otherwise be refused once for being empty and again for having an empty
 * segment.
 *
 * Used by the two output paths and by a framework configuration file. A profile contributes no paths: an environment
 * describes a target and a set of values, not a second place to write reports.
 */
export const relativeProjectPath = z.string().superRefine((value, ctx) => {
  const refuse = (message: string): void => {
    ctx.addIssue({ code: "custom", message });
  };

  if (value.length === 0) return refuse("must not be empty");

  if (value.length > MAX_PATH_LENGTH) {
    return refuse(`must be at most ${String(MAX_PATH_LENGTH)} characters`);
  }

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
 *
 * Four rules in one refinement, so a name that is both too long and wrongly cased produces one message: the length first,
 * because that is the fix a reader can make without thinking about the rest.
 *
 * Called twice in a run's life, with the same rules both times: once by the schema, for a name declared in the file, and
 * once by the environment resolver, for the name a command was asked for — before the lookup, so a typo is reported as a
 * typo rather than as an environment the project does not have.
 */
export const environmentName = z.string().superRefine((value, ctx) => {
  const refuse = (message: string): void => {
    ctx.addIssue({ code: "custom", message });
  };

  if (value.length === 0) return refuse("must not be empty");

  if (value.length > MAX_ENVIRONMENT_NAME_LENGTH) {
    return refuse(
      `must be at most ${String(MAX_ENVIRONMENT_NAME_LENGTH)} characters`,
    );
  }

  if (!ENVIRONMENT_NAME.test(value)) {
    return refuse(
      "must start with a lowercase letter and contain only lowercase letters, digits and hyphens",
    );
  }

  if (RESERVED_NAMES.has(value)) {
    return refuse(
      "is reserved by the language and cannot be used as a profile name",
    );
  }
});

/**
 * A variable name, as an environment variable would be written.
 *
 * Upper case because these values are also passed to a child process, where a lowercase name is legal and a surprise.
 * One spelling, applied here, is what stops a configuration working on one platform and not another.
 *
 * The reserved-name check lowercases before comparing, which matters for the one casing the pattern above still accepts:
 * `CONSTRUCTOR` passes the upper-case rule and must still be refused, because a name that differs from a reserved one
 * only by case is one rename away from being read as it.
 */
export const environmentVariableName = z.string().superRefine((value, ctx) => {
  const refuse = (message: string): void => {
    ctx.addIssue({ code: "custom", message });
  };

  if (value.length === 0) return refuse("must not be empty");

  if (value.length > MAX_VARIABLE_NAME_LENGTH) {
    return refuse(
      `must be at most ${String(MAX_VARIABLE_NAME_LENGTH)} characters`,
    );
  }

  if (!ENVIRONMENT_VARIABLE_NAME.test(value)) {
    return refuse(
      "must be uppercase letters, digits and underscores, because it is also passed to the framework as an environment variable",
    );
  }

  if (RESERVED_NAMES.has(value.toLowerCase())) {
    return refuse(
      "is reserved by the language and cannot be used as a variable name",
    );
  }
});

/**
 * A variable value.
 *
 * One line, bounded, and no control characters. A value with a newline is almost always a paste accident, and one with an
 * escape sequence can move a cursor in whatever later prints it — the same reason the CLI filters its own output.
 *
 * No minimum: an empty value is a legitimate variable. `NAME=` in a shell is a value somebody set to nothing, and a
 * schema that refused it would be refusing a case people use deliberately.
 *
 * ## The one shape refused outright
 *
 * A value beginning `env:` is almost always somebody trying to point at a secret from the variable map — the exact
 * confusion the profile format prevents by giving secrets their own field. Accepting it would produce a run that hands the
 * literal text `env:TOKEN` to the framework, which fails at the far end with a message about authentication and no mention
 * of the configuration at all. Refusing it here names the field and the map to move it to.
 *
 * This is a heuristic and it is narrow on purpose: a value that merely *contains* a colon is fine, and an empty value is
 * fine. If it ever refuses something legitimate, the fix is to widen the profile's `secrets` documentation, not the
 * pattern.
 */
export const environmentVariableValue = z.string().superRefine((value, ctx) => {
  const refuse = (message: string): void => {
    ctx.addIssue({ code: "custom", message });
  };

  if (value.length > MAX_VARIABLE_VALUE_LENGTH) {
    return refuse(
      `must be at most ${String(MAX_VARIABLE_VALUE_LENGTH)} characters`,
    );
  }

  if (containsControlCharacters(value)) {
    return refuse("must be a single line without control characters");
  }

  if (SECRET_REFERENCE_SHAPE.test(value)) {
    return refuse(
      'looks like a reference to a secret; declare it under "secrets" instead, where the value is read from the environment at run time rather than stored in this file',
    );
  }
});

/**
 * The target address an environment points at.
 *
 * Five rules, reported one at a time, in the order that produces the most useful first message.
 *
 * - **Length, first.** A paste accident is the most likely mistake and the cheapest to state.
 * - **No control characters, before the parse.** `new URL` strips tabs and newlines as part of parsing, so a value with
 *   one embedded would otherwise be quietly repaired and accepted — and then written into a report and a log line.
 * - **It parses as a URL.** `example.test` and `/api` both look like addresses and neither is one. A runner handed either
 *   would resolve it against something nobody chose, which is the class of defect this whole format avoids.
 * - **The scheme is http or https.** A `file:` or `ftp:` target is not something this tool can drive, and accepting one
 *   moves the refusal to a place where the reader cannot see it.
 * - **There are no credentials in it.** `https://user:secret@host` is a valid URL and a leaked secret: it would live in a
 *   committed file, appear in every log line that mentions the target, and keep working until the day the password is
 *   rotated, when it would fail with a message about the host. Secrets have a field of their own; this rule is what stops
 *   this field being used as one.
 *
 * Also applied to an approved override — the `QAT_BASE_URL` variable and the corresponding flag — so the constraint cannot
 * be bypassed by supplying the same bad URL from a source the file's reader never sees.
 */
export const profileBaseUrl = z.string().superRefine((value, ctx) => {
  const refuse = (message: string): void => {
    ctx.addIssue({ code: "custom", message });
  };

  if (value.length === 0) return refuse("must not be empty");

  if (value.length > MAX_BASE_URL_LENGTH) {
    return refuse(`must be at most ${String(MAX_BASE_URL_LENGTH)} characters`);
  }

  if (containsControlCharacters(value)) {
    return refuse(
      "must not contain control characters, because it is written into reports and logs",
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse(
      'must be an absolute URL including its scheme, for example "https://staging.example.test"',
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return refuse(
      "must use http or https, because that is the only kind of target a run can address",
    );
  }

  if (url.username !== "" || url.password !== "") {
    return refuse(
      "must not contain a username or password, because that puts a credential in a file that is committed, logged and quoted in reports",
    );
  }
});
