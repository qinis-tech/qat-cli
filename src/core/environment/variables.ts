/**
 * Reading environment variables, with the distinction that matters most made explicit.
 *
 * "Not set" and "set to nothing" are different facts, and most lookups collapse them. Collapsing is
 * usually harmless and occasionally terrible: a deployment that sets `API_URL=` to disable a
 * feature is not the same as one that never mentions it, and a tool that reports "missing" for both
 * sends the reader looking for the wrong problem.
 *
 * Two vocabularies live here, deliberately:
 *
 *   VariableState    faithful. Says what the source literally contains. Never trims, so a value of
 *                    " " stays `present` — a caller that asked for a value must receive the value.
 *   VariablePresence judgement. Says whether a variable is *usable*, so whitespace-only counts as
 *                    blank. Used by diagnostics, which must not report "set" for something that
 *                    will fail authentication.
 *
 * Keeping them apart is the whole discipline of this module: a value-faithful lookup is a terrible
 * presenceness test, and a presenceness test is a terrible value source.
 */
import { ErrorCode } from "../errors/codes.js";
import { InvalidConfigurationError } from "../errors/errors.js";

import {
  displayValue,
  isSensitiveVariable,
  REDACTED_PLACEHOLDER,
} from "./secrets.js";

/** A process environment, or anything shaped like one. */
export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export const VariableState = {
  /** Set to a non-empty value. */
  Present: "present",
  /** Set to the empty string. */
  Empty: "empty",
  /** Not set at all. */
  Missing: "missing",
} as const;

export type VariableState = (typeof VariableState)[keyof typeof VariableState];

/**
 * The result of looking a variable up.
 *
 * A union rather than `{ value?: string; present: boolean }`, so a caller cannot read a value
 * without first deciding what to do about its absence.
 */
export type EnvironmentVariable =
  | {
      readonly name: string;
      readonly state: typeof VariableState.Present;
      readonly value: string;
      readonly sensitive: boolean;
    }
  | {
      readonly name: string;
      readonly state: typeof VariableState.Empty;
      readonly sensitive: boolean;
    }
  | {
      readonly name: string;
      readonly state: typeof VariableState.Missing;
      readonly sensitive: boolean;
    };

/**
 * Rejects a name that could never be a variable.
 *
 * A programming error rather than a user error, so it throws `TypeError` rather than an application
 * error — the same distinction `writeJson` draws for a value it cannot serialise.
 *
 * Control characters are rejected as well as `=` and NUL. That is not pedantry: names are printed in
 * diagnostics and logs, and a name containing a newline or an escape sequence forges output. Since
 * no legitimate deployment produces such a name, refusing it costs nothing and closes a
 * log-injection hole.
 */
function assertUsableName(name: string): void {
  if (name.trim().length === 0) {
    throw new TypeError("Environment variable name is empty.");
  }

  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (name.includes("=") || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new TypeError(
      `Environment variable name ${JSON.stringify(name)} is not valid.`,
    );
  }
}

/**
 * Looks a variable up, distinguishing absent from empty.
 *
 * A value of whitespace only is `present`. Trimming would change what a caller receives, and a
 * deliberate space is not the same as nothing. If you want the usability judgement instead, use
 * `probeVariablePresence`.
 */
export function readVariable(
  name: string,
  source: EnvironmentSource = process.env,
): EnvironmentVariable {
  assertUsableName(name);

  const sensitive = isSensitiveVariable(name);
  const raw = source[name];

  if (raw === undefined)
    return { name, state: VariableState.Missing, sensitive };
  if (raw.length === 0) return { name, state: VariableState.Empty, sensitive };

  return { name, state: VariableState.Present, value: raw, sensitive };
}

/**
 * Reads a variable that must be set.
 *
 * @throws {InvalidConfigurationError} when it is missing or empty. The message names the variable
 *   and never its value: an error about a credential must not become a place a credential is
 *   printed.
 *
 * Note that an empty value is rejected here while whitespace is accepted — the same faithfulness
 * rule as `readVariable`, applied to a call site that has explicitly asked for a usable value.
 */
export function requireVariable(
  name: string,
  source: EnvironmentSource = process.env,
): string {
  const variable = readVariable(name, source);

  if (variable.state === VariableState.Present) return variable.value;

  throw new InvalidConfigurationError(
    ErrorCode.configurationInvalid,
    `The environment variable ${name} is ${variable.state === VariableState.Empty ? "empty" : "not set"}.`,
    {
      context: { variable: name },
      remediation: `Set ${name} before running this command.`,
    },
  );
}

/**
 * Reads a variable, falling back when it is missing **or empty**.
 *
 * Empty counts as absent here, and only here. A shell assignment of `NAME=` is far more often an
 * accidental inheritance than an instruction to use nothing, and a fallback is exactly the place
 * where that judgement belongs.
 */
export function variableOrDefault(
  name: string,
  fallback: string,
  source: EnvironmentSource = process.env,
): string {
  const variable = readVariable(name, source);

  return variable.state === VariableState.Present ? variable.value : fallback;
}

/**
 * Whether a variable is usable — the diagnostics vocabulary.
 *
 * `blank` covers both the empty string and whitespace-only content. That is the one place this
 * module deliberately disagrees with `VariableState.Empty`: a token of spaces will fail
 * authentication exactly like a missing one, and telling a user "it is set" when it is not usable
 * is the wrong answer to the question a diagnostic is asking.
 *
 * `unknown` is absent on purpose. This function cannot fail: either the source yields a value or it
 * does not. The extra state belongs to the caller that might not have a source at all, and it is
 * added there rather than invented here.
 *
 * Returns an enum, never a value. A caller that needs the value must go through `readVariable` and
 * thereby accept the responsibility that comes with it.
 */
export const VariablePresence = {
  /** Set to something usable. */
  Set: "set",
  /** Set to empty or whitespace-only content. */
  Blank: "blank",
  /** Not set at all. */
  Unset: "unset",
} as const;

export type VariablePresence =
  (typeof VariablePresence)[keyof typeof VariablePresence];

/**
 * Judges whether a variable is usable, without exposing what it contains.
 *
 * This is the function diagnostics are meant to call. It existed as a gap before: the only options
 * were `readVariable`, which hands back a secret-shaped string, or a bare `source[name] !== undefined`
 * check, which each caller implemented slightly differently and one of them got wrong.
 */
export function probeVariablePresence(
  name: string,
  source: EnvironmentSource = process.env,
): VariablePresence {
  assertUsableName(name);

  const raw = source[name];

  if (raw === undefined) return VariablePresence.Unset;

  // Empty *or* whitespace-only: both are unusable for the purpose a diagnostic is asking about.
  if (raw.trim().length === 0) return VariablePresence.Blank;

  return VariablePresence.Set;
}

export interface EnvironmentEntry {
  readonly name: string;
  readonly state: VariableState;
  /** `[redacted]` for a sensitive name, whatever its value. */
  readonly displayValue: string | undefined;
}

export interface DescribeEnvironmentOptions {
  /** Only variables starting with this prefix. Defaults to `QAT_`. */
  readonly prefix?: string;
  /** Explicit names, when the caller knows what it is looking for. */
  readonly names?: readonly string[];
  readonly source?: EnvironmentSource;
}

/**
 * A snapshot suitable for diagnostics, redacted.
 *
 * Requires a prefix or an explicit list — there is no way to ask for "everything". Dumping a process
 * environment into a diagnostic output is how unrelated credentials end up in bug reports, and the
 * convenience is not worth the category of accident it creates.
 *
 * Output is de-duplicated and sorted regardless of how the names arrived. Evidence that changes
 * order between runs is evidence nobody can diff, and a caller passing the same name twice is
 * asking for two identical lines, not two facts.
 */
export function describeEnvironment(
  options: DescribeEnvironmentOptions = {},
): readonly EnvironmentEntry[] {
  const source = options.source ?? process.env;
  const prefix = options.prefix ?? "QAT_";

  const names =
    options.names ??
    Object.keys(source).filter((name) => name.startsWith(prefix));

  return [...new Set(names)].sort().map((name) => {
    const variable = readVariable(name, source);

    return {
      name,
      state: variable.state,
      displayValue:
        variable.state === VariableState.Present
          ? displayValue(name, variable.value)
          : undefined,
    };
  });
}

/** Re-exported so a caller building its own output has the same placeholder. */
export { REDACTED_PLACEHOLDER };
