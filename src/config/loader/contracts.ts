/**
 * What loading a configuration file reports.
 *
 * ## Six outcomes, and none of them is an error
 *
 * Everything that can be wrong with a *file* is a result:
 *
 * | Outcome | What the reader does |
 * | --- | --- |
 * | `loaded` | Proceeds with the configuration |
 * | `not-found` | Discovers again — the file moved between discovery and loading |
 * | `empty` | Writes something, or restores the file from version control |
 * | `malformed` | Fixes the syntax, at the line and column carried |
 * | `invalid` | Fixes the fields named by the diagnostics |
 * | `too-large` | Checks that the path is the file they meant |
 *
 * Six sentences rather than one because they send the reader to six places. Collapsing them — the obvious collapse being
 * "it did not load" — produces a message that is true and tells nobody what to do.
 *
 * The filesystem failing to answer is not on that list: a permission problem, a failing disk, a symlink loop. Those
 * throw, on the same reasoning discovery follows, because absence is an answer and a broken machine is not.
 *
 * ## Why a failure carries no configuration
 *
 * Only `loaded` has a `config`. A variant with `config?: QatConfig` would be handled correctly by everybody who read the
 * comment and incorrectly by the first person in a hurry — and "incorrectly" here means a run whose settings nobody
 * chose, indistinguishable from a correct one. The type is the rule rather than a note about it.
 * See ADR-0026.
 *
 * ## What this file does not define
 *
 * The shape of a field's problem belongs to the validation service, which owns the codes and authors the sentences. This
 * file names it and imports it, so a caller reading a load result sees one diagnostic type rather than a loader-specific
 * projection that the validator would have to be kept in step with.
 *
 * The dependency runs one way — loader, then validation, then schema — and this import is the only edge in it that a
 * reader might not predict.
 */
import type { QatConfig } from "../schema/index.js";
import type { ConfigurationDiagnostic } from "../validation/index.js";

/**
 * How a configuration file was loaded, or why it was not.
 *
 * A closed set, so a `switch` over it is exhaustive. Named for the operation rather than the outcome because that is the
 * shape the neighbouring `ConfigurationLocation` already has, and two vocabularies for one idea is a worse cost than a
 * slightly imprecise name.
 */
export const ConfigurationLoad = {
  /** Parsed, validated, defaults applied. */
  Loaded: "loaded",
  /** Nothing at the path. Removed between discovery and loading, or the caller never ran discovery. */
  NotFound: "not-found",
  /** The file exists and contains nothing but whitespace. */
  Empty: "empty",
  /** The file exists and is not JSON. Carries where the parser stopped. */
  Malformed: "malformed",
  /** Valid JSON, but not a configuration. Carries one diagnostic per problem it has. */
  Invalid: "invalid",
  /** Larger than any configuration should be, which usually means the path is not the file the caller meant. */
  TooLarge: "too-large",
} as const;

export type ConfigurationLoad =
  (typeof ConfigurationLoad)[keyof typeof ConfigurationLoad];

/**
 * Where a parse error is, in each of the three forms a reader needs.
 *
 * `position` is what a parser reports, `line` and `column` are what a person edits against, and `excerpt` is the line
 * itself — so a message can show the reader where they are without them counting. All three are carried because
 * converting between them is cheap here and impossible for a caller that received only one.
 *
 * The offset comes from the engine's own message, which is the only thing that knows it; the rest is computed from the
 * text, so a runtime that gains or loses a "(line 3 column 5)" suffix changes nothing observable here.
 */
export interface JsonLocation {
  /** Zero-based offset into the file's text, bounded to its length. */
  readonly position: number;
  /** One-based, counting `\n`. */
  readonly line: number;
  /** One-based, counting characters since the last newline. */
  readonly column: number;
  /** The line the parser stopped on, trimmed and truncated. Empty when that line has no content. */
  readonly excerpt: string;
}

export interface LoadedConfiguration {
  readonly kind: typeof ConfigurationLoad.Loaded;
  /** Absolute, as it was given. Carried so a caller reporting success names the file rather than assuming which one. */
  readonly path: string;
  /** Parsed, validated, defaults applied. The only variant with one, deliberately. */
  readonly config: QatConfig;
}

export interface MissingConfiguration {
  readonly kind: typeof ConfigurationLoad.NotFound;
  readonly path: string;
}

export interface EmptyConfiguration {
  readonly kind: typeof ConfigurationLoad.Empty;
  readonly path: string;
}

export interface MalformedConfiguration {
  readonly kind: typeof ConfigurationLoad.Malformed;
  readonly path: string;
  /**
   * What the parser said, verbatim.
   *
   * Engine-specific text — V8's wording — so it is shown to a reader and never asserted on. `location` is the stable part
   * of this variant, and the part a test should pin.
   */
  readonly reason: string;
  readonly location: JsonLocation;
}

export interface InvalidConfiguration {
  readonly kind: typeof ConfigurationLoad.Invalid;
  readonly path: string;
  /**
   * One per problem, in the schema's order.
   *
   * Empty is impossible: an invalid result with no diagnostics would say nothing. Each carries a permanent code, a dotted
   * path and a sentence this project wrote — never the value that failed, because the field could be an environment
   * variable whose value is a credential.
   *
   * At most one, where the document declares a schema version this build does not read: the fields are not examined then,
   * because a field complaint at another version is a guess. See ADR-0027.
   */
  readonly diagnostics: readonly ConfigurationDiagnostic[];
}

export interface OversizedConfiguration {
  readonly kind: typeof ConfigurationLoad.TooLarge;
  readonly path: string;
  /** What the filesystem reports. A hint rather than a guarantee — the file may have grown since. */
  readonly sizeBytes: number;
  /** The bound that refused it, so a message can state both numbers rather than the word "too large". */
  readonly limitBytes: number;
}

export type ConfigurationLoadResult =
  | LoadedConfiguration
  | MissingConfiguration
  | EmptyConfiguration
  | MalformedConfiguration
  | InvalidConfiguration
  | OversizedConfiguration;

/** Loading options. One field today, and it is the bound rather than a mode. */
export interface LoadOptions {
  /**
   * Reading bound, in bytes.
   *
   * Defaults to a megabyte, which is a hundred times the largest plausible configuration and far less than a mistaken
   * path would cost. A **guard against a wrong path**, not a security boundary: `stats.size` is a hint, and a file that
   * grows between the check and the read exceeds it.
   */
  readonly maxBytes?: number;
}
