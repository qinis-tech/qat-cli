/**
 * Configuration contracts.
 *
 * The distinction this file exists to enforce: what the user supplied is not what the
 * application is allowed to act on. Supplied values are unvalidated and typed
 * `unknown`; resolved values exist only if validation succeeded and defaults were
 * applied. Nothing downstream can accidentally consume the former.
 *
 * Paths are relative to the project root, consistent with `ProjectPaths`.
 */
import type { EnvironmentId } from "./primitives.js";

/**
 * Where a set of values came from.
 *
 * Provenance, not content — it answers "why is this setting what it is", which is the
 * question behind most configuration confusion. Recorded rather than inferred so
 * `qat doctor` can report it without re-tracing how loading happened.
 */
export const ConfigurationSource = {
  /** A configuration file belonging to the project. */
  File: "file",
  /** Built-in values used because the file did not specify them. */
  Defaults: "defaults",
  /** Values from the process environment, which override everything else. */
  EnvironmentVariables: "environment-variables",
} as const;

export type ConfigurationSource =
  (typeof ConfigurationSource)[keyof typeof ConfigurationSource];

export interface ConfigurationOrigin {
  readonly source: ConfigurationSource;
  /** Path of the file that was read, relative to the project root. Absent for defaults. */
  readonly path?: string;
}

/**
 * Values as supplied, before any trust is extended to them.
 *
 * `values` is `unknown` on purpose. Typing it as `Partial<ResolvedConfiguration>` would
 * claim knowledge nobody has yet, and the first consumer would skip validation because
 * the type said it had already happened.
 */
export interface ConfigurationInput {
  readonly origin: ConfigurationOrigin;
  /** Environment requested on the command line, before it is checked against the file. */
  readonly requestedEnvironment?: EnvironmentId;
  readonly values: unknown;
}

/**
 * Severity separates what blocks a run from what deserves a mention.
 *
 * Without it, every unfamiliar key becomes either a hard failure — hostile to a file
 * written for a newer version — or silence, which is worse. An unrecognised key is a
 * warning; a key with the wrong type is an error.
 */
export const IssueSeverity = {
  Error: "error",
  Warning: "warning",
} as const;

export type IssueSeverity = (typeof IssueSeverity)[keyof typeof IssueSeverity];

export interface ConfigurationIssue {
  /**
   * Dotted path to the offending key, e.g. `environments.staging.baseUrl`.
   *
   * Dotted rather than a JSON pointer so it can be shown directly in a message and
   * grepped for in the file without a decoder.
   */
  readonly path: string;
  readonly severity: IssueSeverity;
  readonly message: string;
}

export interface EnvironmentConfiguration {
  /** Base URL the application under test is served from. Optional: not every suite needs one. */
  readonly baseUrl?: string;
  /**
   * Variables exposed to the tests.
   *
   * Named `variables` rather than adopting any framework's term, so this contract does
   * not shift when an adapter does. The adapter maps it to whatever the framework
   * calls it.
   */
  readonly variables: Readonly<Record<string, string>>;
}

export interface SuiteConfiguration {
  /** Glob identifying the specs in this suite, relative to the specs directory. */
  readonly specPattern: string;
  /** Default browser for this suite. Absent means the framework default. */
  readonly browser?: string;
}

export interface OutputConfiguration {
  /** Where normalised results are written, relative to the project root. */
  readonly resultsDirectory: string;
  /** Where generated reports are written. */
  readonly reportsDirectory: string;
  /** Where collected artefacts are written. */
  readonly evidenceDirectory: string;
}

/**
 * Configuration that passed validation, with defaults applied.
 *
 * Existence is the proof of validity. There is no `isValid` flag to check and no path
 * by which an unvalidated object reaches this type.
 */
export interface ResolvedConfiguration {
  /** The environment selected for this run. Always one of the keys in `environments`. */
  readonly environment: EnvironmentId;
  /**
   * Every declared environment, not only the selected one.
   *
   * Kept because listing environments and validating a requested name both need the
   * whole set, and re-reading the file to answer either would mean two sources of truth.
   */
  readonly environments: Readonly<
    Record<EnvironmentId, EnvironmentConfiguration>
  >;
  /** Named suites. `noUncheckedIndexedAccess` makes a lookup return `T | undefined`, so a missing suite is handled rather than assumed away. */
  readonly suites: Readonly<Record<string, SuiteConfiguration>>;
  readonly output: OutputConfiguration;
  /** Where the applied values came from, for diagnostics. */
  readonly origin: ConfigurationOrigin;
}

/**
 * The outcome of loading configuration.
 *
 * A discriminated union rather than a bag of fields with an `isValid` boolean. The
 * difference matters: with a bag, every consumer must remember to check the flag, and
 * the compiler cannot help the one that forgets. With a union, reading
 * `result.configuration` without narrowing is a type error.
 *
 * The asymmetry between the branches is deliberate. On success you receive `warnings`,
 * because by definition there were no errors. On failure you receive `issues`, because
 * a caller reporting the problem needs all of them, not only the first.
 */
export type ConfigurationResult =
  | {
      readonly ok: true;
      readonly configuration: ResolvedConfiguration;
      readonly warnings: readonly ConfigurationIssue[];
    }
  | {
      readonly ok: false;
      readonly issues: readonly ConfigurationIssue[];
    };
