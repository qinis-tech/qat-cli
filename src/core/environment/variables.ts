/**
 * Reading environment variables, with the distinction that matters most made explicit.
 *
 * "Not set" and "set to nothing" are different facts, and most lookups collapse them. Collapsing is
 * usually harmless and occasionally terrible: a deployment that sets `API_URL=` to disable a
 * feature is not the same as one that never mentions it, and a tool that reports "missing" for both
 * sends the reader looking for the wrong problem.
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
 */
function assertUsableName(name: string): void {
  if (name.trim().length === 0) {
    throw new TypeError("Environment variable name is empty.");
  }

  if (name.includes("=") || name.includes("\0")) {
    throw new TypeError(
      `Environment variable name ${JSON.stringify(name)} is not valid.`,
    );
  }
}

/**
 * Looks a variable up, distinguishing absent from empty.
 *
 * A value of whitespace only is `present`. Trimming would change what a caller receives, and a
 * deliberate space is not the same as nothing.
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
 */
export function describeEnvironment(
  options: DescribeEnvironmentOptions = {},
): readonly EnvironmentEntry[] {
  const source = options.source ?? process.env;
  const prefix = options.prefix ?? "QAT_";

  const names =
    options.names ??
    Object.keys(source)
      .filter((name) => name.startsWith(prefix))
      .sort();

  return names.map((name) => {
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
