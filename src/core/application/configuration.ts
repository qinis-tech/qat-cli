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
 *
 * That rule is why `ConfigurationInspection` below is declared rather than imported.
 * It is shaped like the producer's result because it *is* the same observation, but it
 * is written in this module's words: a dotted field path instead of a path array, a
 * resolved configuration instead of an opaque document, findings instead of a schema
 * library's issues.
 */
import type { ConfigurationResult } from "../domain/index.js";

/**
 * Every condition a configuration document can be in.
 *
 * ## Why these identifiers live here
 *
 * A code is vocabulary. Vocabulary is what a contract may mention and what a layer above may name without depending on
 * how the layer below is built — and the doctor is the first consumer that has to say "this is a configuration code"
 * from further up than `src/config`. Importing an implementation path to do it would make the application layer depend
 * on one.
 *
 * Only the identifiers move. The *shape* of a configuration diagnostic, and every sentence behind a code, stay where
 * they are produced, because only the identifiers are vocabulary and only the prose is the schema's business.
 *
 * Codes are permanent. A withdrawn condition leaves its code unused rather than reusing it, so a code quoted in a bug
 * report keeps the meaning it had when it was quoted.
 */
export const ConfigurationDiagnosticCode = {
  /** The document is not a JSON object at all — an array, a string, a number, or `null`. */
  NotAnObject: "QAT-C001",
  /** The document declares a schema version this build does not read. */
  UnsupportedVersion: "QAT-C002",
  /** A required field is absent. */
  Missing: "QAT-C003",
  /** A field holds the wrong kind of value — a string where an object belongs, a number where a string is. */
  WrongType: "QAT-C004",
  /** A field holds a value outside the set the schema allows. */
  UnsupportedValue: "QAT-C005",
  /** A field holds a value the rules refuse: too long, wrong shape, a path escaping the project, a reserved name. */
  RefusedValue: "QAT-C006",
  /** A key the schema does not declare. */
  UnknownField: "QAT-C007",
} as const;

export type ConfigurationDiagnosticCode =
  (typeof ConfigurationDiagnosticCode)[keyof typeof ConfigurationDiagnosticCode];

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
  /**
   * @deprecated Use {@link ConfigurationFinding.remediation}.
   *
   * Two names for one field, and only one of them was ever meant to survive. `remedy` is
   * kept because a stored report may already carry it; nothing new may write it, and a
   * reader must prefer `remediation` when both are present. Deleting the field is a
   * breaking change to the report contract and belongs in its own versioned step.
   */
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

/* ------------------------------------------------------------------------- *
 * Inspection
 * ------------------------------------------------------------------------- */

/**
 * Why a configuration file could not be read.
 *
 * Deliberately a closed vocabulary rather than a raw filesystem code: "permission
 * denied" and "that path is a directory" send a reader to two different fixes, and
 * every other system error is the same sentence to them. The producer maps its own
 * codes onto these; nothing above has to know which platform raised what.
 */
export type ConfigurationAccessCode =
  /** The file exists and the process may not read it. */
  | "permission-denied"
  /** A directory, or something else that is not a regular file, occupies the path. */
  | "not-a-file"
  /** A symbolic link loop, or a link that cannot be followed. */
  | "link-loop"
  /** A read error that is none of the above. */
  | "io-error"
  /** More than one candidate was found, and the scheme admits only one. */
  | "ambiguous";

/**
 * Everything inspection can conclude about a project's configuration.
 *
 * Six states, and they are six because each ends in a different action: create a file,
 * fix a permission, fix the syntax, upgrade QAT, correct a field, or carry on. A
 * boolean — "is the configuration valid" — cannot express that, and every consumer
 * given one would end up inventing its own taxonomy to say what actually happened.
 *
 * Three design points worth stating, because each is load-bearing:
 *
 * - **`missing` is not `inaccessible`.** An uninitialised project is a supported state
 *   where documented defaults apply; a file that cannot be read is a fault. Collapsing
 *   them tells half the readers to create a file they already have.
 * - **`version-unsupported` is not `schema-invalid`.** There is nothing meaningful to
 *   say about the fields of a document whose version we cannot interpret, and a list of
 *   field errors would bury the one fact the reader can act on.
 * - **`valid` carries the resolved configuration.** Inspection ends where a writer can
 *   begin: the paths are already anchored and the environment already chosen. Anything
 *   less would make every caller resolve a second time, which is how two components end
 *   up disagreeing about where output goes.
 */
export type ConfigurationInspection =
  /** No configuration file at the project root. Documented defaults apply. */
  | {
      readonly state: "missing";
      /** Project-relative location that was inspected, for reproducible reporting. */
      readonly searchedAt: string;
    }
  /** Present and unobtainable. */
  | {
      readonly state: "inaccessible";
      readonly path: string;
      readonly code: ConfigurationAccessCode;
    }
  /** Present, readable, and not a JSON document. */
  | {
      readonly state: "malformed";
      readonly path: string;
      /** 1-based, when a parser reported a position. */
      readonly line?: number;
      /** 1-based, when a parser reported a position. */
      readonly column?: number;
    }
  /** Readable, and declaring a schema version this build does not read. */
  | {
      readonly state: "version-unsupported";
      readonly path: string;
      /** Exactly what the file declared, so a report can quote it without guessing. */
      readonly declared: unknown;
      readonly supported: readonly number[];
    }
  /** Readable and refused, field by field. */
  | {
      readonly state: "schema-invalid";
      readonly path: string;
      /** The declared version, or a negative value when no usable one was given. */
      readonly version: number;
      readonly issues: readonly ConfigurationFinding[];
    }
  /** Readable, version-checked, schema-valid and resolved. */
  | {
      readonly state: "valid";
      readonly path: string;
      readonly version: number;
      readonly configuration: ResolvedProjectConfiguration;
    };

/**
 * Turns a configuration a project supplied into one a writer can act on, and answers
 * whether a document can be obtained at all.
 *
 * ## Why the two members have different shapes
 *
 * `resolve` is synchronous; `inspect` is not. That is not an inconsistency — it is the
 * difference between a pure function and one that reads a disk. Resolution takes a
 * document somebody already loaded and validated: it reads no file, consults no clock
 * and never looks at the working directory, so returning a promise would advertise I/O
 * that does not happen. Inspection *is* I/O, and pretending otherwise would force every
 * caller to handle an exception from a function that claimed to be total.
 *
 * ## Why `inspect` belongs on this port rather than beside it
 *
 * Both members answer the same question at different depths: "what configuration does
 * this project have?" A caller that resolves needs a document; a caller that inspects
 * needs to know whether obtaining one is possible. Splitting them across two ports
 * would let a consumer hold one without the other, and the doctor — which must describe
 * a broken file rather than fail on it — is exactly the consumer that needs both
 * behaviours from one place.
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

  /**
   * Composes locate → load → version gate → validate → resolve into one verdict.
   *
   * One implementation, called once per project root per run, so that two findings can
   * never describe two different readings of one file. The composition root guarantees
   * that; this contract only requires that a caller may treat the result as the whole
   * truth about the project's configuration.
   *
   * @param projectRoot Absolute root to inspect. Never the working directory.
   * @returns The state, as a value. Every expected condition — absent, unreadable,
   *   malformed, unsupported version, schema-invalid — is one of the six states, not a
   *   rejection: a diagnostic that throws cannot report.
   * @throws {ApplicationError} only for a wiring fault in the implementation, never for
   *   a condition of the project.
   */
  inspect(projectRoot: string): Promise<ConfigurationInspection>;
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
