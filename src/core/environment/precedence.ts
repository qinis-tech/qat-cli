/**
 * Resolving one configuration value from the four places it can come from.
 *
 * The order is **flag, then environment, then configuration file, then default** — see the
 * precedence specification and the decision record. The reasoning in one line: the narrower the
 * scope of the source, the more deliberate it is, and the more deliberate it is the more it should
 * win.
 */
import {
  readVariable,
  VariableState,
  type EnvironmentSource,
} from "./variables.js";

export const ValueSource = {
  /** Supplied on the command line for this invocation. */
  Flag: "flag",
  /** Supplied by the environment for this process. */
  Environment: "environment",
  /** Supplied by the project's configuration file. */
  Configuration: "configuration",
  /** Neither supplied nor configured; the built-in value applies. */
  Default: "default",
} as const;

export type ValueSource = (typeof ValueSource)[keyof typeof ValueSource];

export interface EnvironmentCandidate<T> {
  readonly name: string;
  /**
   * Converts the raw string into a typed value.
   *
   * Allowed to throw. A malformed value is a configuration problem, and the parser is the only
   * thing that knows what "malformed" means for this setting — so it raises the error, with its own
   * remediation, rather than returning `undefined` and having the value silently ignored.
   */
  readonly parse: (raw: string) => T;
}

export interface ValueCandidates<T> {
  readonly flag?: T | undefined;
  readonly environment?: EnvironmentCandidate<T> | undefined;
  readonly configuration?: T | undefined;
  readonly fallback?: T | undefined;
}

export interface ResolvedValue<T> {
  readonly value: T;
  /** Where the value came from. Recorded because "why is it using this?" is the usual question. */
  readonly source: ValueSource;
}

/**
 * Resolves a value, reporting where it came from.
 *
 * Returns `undefined` only when no candidate supplied anything, which is subtly different from
 * returning a default: a caller that has no sensible default needs to be able to tell that nothing
 * was configured rather than receive a value it never chose.
 */
export function resolveValue<T>(
  candidates: ValueCandidates<T>,
  source: EnvironmentSource = process.env,
): ResolvedValue<T> | undefined {
  if (candidates.flag !== undefined) {
    return { value: candidates.flag, source: ValueSource.Flag };
  }

  if (candidates.environment !== undefined) {
    const variable = readVariable(candidates.environment.name, source);

    // Empty falls through rather than being parsed. `NAME=` in a shell is far more often an
    // inherited blank than an instruction, and a parser handed an empty string can only report a
    // problem the operator did not intend to create.
    if (variable.state === VariableState.Present) {
      return {
        value: candidates.environment.parse(variable.value),
        source: ValueSource.Environment,
      };
    }
  }

  if (candidates.configuration !== undefined) {
    return {
      value: candidates.configuration,
      source: ValueSource.Configuration,
    };
  }

  if (candidates.fallback !== undefined) {
    return { value: candidates.fallback, source: ValueSource.Default };
  }

  return undefined;
}
