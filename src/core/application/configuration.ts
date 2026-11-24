/**
 * The configuration a project supplied, as the application sees it.
 *
 * A sibling module rather than part of `ports.ts`, because its vocabulary is
 * independent of everything there: a resolved path, a finding, a resolution. None of
 * those ideas mention a project layout, a repository or a report.
 *
 * Nothing here names a file, a parser, a schema version or a library. Core may not
 * depend on the module that owns those, and does not — the composition root adapts
 * what that module produces into this vocabulary at the boundary.
 */
import type { ConfigurationResult } from "../domain/index.js";

/**
 * One configured path: what was written, and the absolute location it became.
 *
 * Both halves are kept. The absolute form is what a writer uses; the source form is
 * what a diagnostic quotes, because echoing a resolved path back at the reader hides
 * the typo they are looking for.
 */
export interface ResolvedConfigurationPath {
  readonly source: string;
  /** Absolute, anchored to the project root. Never derived from the working directory. */
  readonly absolute: string;
}

/**
 * Which environment a run targets, and how that choice was reached.
 *
 * `origin` is carried because the cases are operationally different: an operator who
 * never named an environment should be able to see that QAT selected the only one
 * available, rather than assuming it was configured.
 */
export type ResolvedEnvironment =
  | {
      readonly origin: "configured" | "declared" | "sole";
      readonly name: string;
    }
  | {
      readonly origin: "none";
      readonly name?: undefined;
    };

/** The directories and target a writer needs, already anchored. */
export interface ResolvedProjectConfiguration {
  readonly reportsDirectory: ResolvedConfigurationPath;
  readonly evidenceDirectory: ResolvedConfigurationPath;
  /** Present only when the project or its configuration supplied one. */
  readonly frameworkConfigFile?: ResolvedConfigurationPath;
  readonly environment: ResolvedEnvironment;
}

/**
 * A configured value the resolver refused.
 *
 * Carries a dotted `path` rather than a structured location because that is what a
 * command prints — `output.reports`. The sentence is written by the layer that knows
 * the rule and is carried across unchanged; re-deriving it here would give one problem
 * two wordings, and the reader might get the one that has drifted.
 */
export interface ConfigurationFinding {
  /** Permanent identifier for the rule that refused the value. */
  readonly code: string;
  readonly path: string;
  readonly message: string;
  /** What to write instead, when there is a concrete answer. */
  readonly remedy?: string;
  /** What to write instead, when there is a concrete answer. */
  readonly remediation?: string;
}

/**
 * The two outcomes of resolving a configuration.
 *
 * A failure carries no configuration, for the same reason a failed load carries none:
 * a run assembled from values nobody chose is indistinguishable from a correct one.
 * `findings` is present on both branches because a successful resolution can still
 * have something worth saying.
 */
export type ConfigurationResolution =
  | {
      readonly ok: true;
      readonly configuration: ResolvedProjectConfiguration;
      readonly findings: readonly ConfigurationFinding[];
    }
  | {
      readonly ok: false;
      readonly findings: readonly ConfigurationFinding[];
    };

/**
 * A configuration document that has passed loading and validation.
 *
 * Declared structurally rather than imported from the module that produces it, so core
 * does not name that module. The composition root passes the real value, which is
 * assignable because this shape is a subset of it.
 *
 * The runtime proof is not lost by that: the resolver checks a marker that only the
 * loading module can set, so a hand-built look-alike is refused even though it
 * type-checks here. Losing the compile-time brand at one boundary is the price of
 * keeping the dependency direction; losing it everywhere would be careless.
 */
export interface LoadedConfigurationDocument {
  /** Absolute path of the file it came from, for diagnostics. */
  readonly source: string;
  /** The validated document. Opaque here: core does not read configuration fields. */
  readonly document: Readonly<Record<string, unknown>>;
}

/**
 * Turns a configuration a project supplied into one a writer can act on.
 *
 * The only synchronous member in this directory, deliberately. Resolution is a pure
 * function of a validated document and a project root: it reads no file, consults no
 * clock and never looks at the working directory. Returning a promise would advertise
 * I/O that does not happen, and every caller would then start defending against a
 * failure that cannot occur.
 */
export interface ConfigurationResolver {
  /**
   * Fills the values the document omitted and anchors every configured path.
   *
   * @param projectRoot Absolute root the paths are anchored to. Resolved once, at the
   *   composition boundary, and passed in — reading it from the working directory here
   *   is the defect this whole separation exists to prevent.
   * @param configuration What loading produced and validation accepted.
   * @returns The anchored configuration, or the findings that prevented one. A refused
   *   path is expected input, not an exceptional condition, so it is a value.
   * @throws {ApplicationError} only for a wiring fault: a document that never loaded,
   *   or a root that is not absolute. Both are programming errors, not user input.
   */
  resolve(
    projectRoot: string,
    configuration: LoadedConfigurationDocument,
  ): ConfigurationResolution;
}

/**
 * Reading a configuration, for completeness of the vocabulary.
 *
 * Not a member of `Application`: a command reaches configuration through discovery,
 * which already answers "what did this project declare". This exists so a handler that
 * genuinely needs the file itself — a diagnostic command, an initialisation workflow —
 * can be written against a contract instead of an import.
 */
export interface ConfigurationReader {
  readonly load: (input: ConfigurationResult) => Promise<ConfigurationResult>;
}
