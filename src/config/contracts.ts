/**
 * The configuration file a project is read from.
 *
 * ## One name, at the root, and no search
 *
 * A project's configuration is `qat.config.json` at the project root. There is no ascent to a parent directory, no
 * second filename for a "local" variant, and no negotiation between formats.
 *
 * Each of those refusals is a decision with a cost, and the cost is recorded: a workspace member with settings at its
 * root is not read, and a developer cannot keep a personal override beside the shared file. What each buys is the same
 * thing — that reading a project's configuration is a lookup rather than a search, so two commands in the same directory
 * cannot disagree about which file they read.
 *
 * ## JSON, not JavaScript
 *
 * A configuration file that is a program has to be executed to be understood, which is the same refusal
 * `docs/architecture/adr/0008-do-not-evaluate-the-framework-configuration.md` makes about a framework's own
 * configuration. It also means a configuration cannot be read by anything that does not trust the repository: a JSON
 * document is data, and a `qat.config.js` is code that runs on load.
 */
export const CONFIG_FILE_NAME = "qat.config.json";

/**
 * The contract for a configuration document.
 *
 * This file states *shape*: which fields exist, which are required, and which
 * values each accepts. It deliberately states nothing else — no default values,
 * no path rules, no error messages — because those live in one place each:
 *
 * - defaults belong to `src/config/resolver/defaults.ts`, so there is a single
 *   table to read and to regenerate the documentation from;
 * - path rules belong to `src/config/resolver/paths.ts`, so anchoring cannot be
 *   enforced in one layer and quietly ignored in another;
 * - shape constraints (name patterns, ranges, cross-field requirements) belong to
 *   `src/config/schema/constraints.ts`, which is what the validator applies.
 *
 * Duplicating any of that here would give the project two answers to the same
 * question and no way to tell which one a run used.
 */

/* -------------------------------------------------------------------------- */
/* Schema version                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The document schema this build understands.
 *
 * A configuration written against a different version is stopped at, not
 * coerced: reading fields through the wrong schema produces a document that
 * looks valid and means something else, and a run built on that is worse than a
 * refusal.
 */
export const CONFIG_VERSION = 1;

export type ConfigurationVersion = typeof CONFIG_VERSION;

/* -------------------------------------------------------------------------- */
/* Closed vocabularies                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Frameworks this build can drive.
 *
 * A closed list, so an unrecognised `framework` is a diagnosis rather than a
 * value carried through every later stage. Adding one is a deliberate act: it
 * requires an adapter to exist before the name may appear here, which is what
 * keeps a project from configuring a capability the build does not have.
 */
export const SUPPORTED_FRAMEWORKS = ["cypress"] as const;

export type FrameworkName = (typeof SUPPORTED_FRAMEWORKS)[number];

/** Report formats this build can write. */
export const SUPPORTED_REPORT_FORMATS = ["json"] as const;

export type ReportFormat = (typeof SUPPORTED_REPORT_FORMATS)[number];

/* -------------------------------------------------------------------------- */
/* Settings groups                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The variables of one environment.
 *
 * Values are single-line strings: multi-line content in a configuration file is
 * almost always a pasted certificate or key, and a value that cannot be read on
 * one line is a value that will be misread somewhere downstream.
 */
export type EnvironmentVariables = Readonly<Record<string, string>>;

/**
 * Named environments a run can be pointed at.
 *
 * A map rather than a list, so two environments cannot share a name by accident
 * and a lookup is a property access rather than a search.
 */
export type EnvironmentsConfiguration = Readonly<
  Record<string, EnvironmentVariables>
>;

/**
 * Where run reports go, and in which formats.
 *
 * `directory` is a project-relative path. It is typed as a plain string here
 * because it is the resolver — not the type system — that anchors it to the
 * project root and refuses escapes.
 */
export type ReportsConfiguration = Readonly<{
  readonly directory?: string;
  readonly formats?: readonly ReportFormat[];
}>;

/** Where captured evidence goes, and whether it is captured at all. */
export type EvidenceConfiguration = Readonly<{
  readonly directory?: string;
  readonly enabled?: boolean;
}>;

/**
 * Optional framework settings.
 *
 * Everything here is optional and nothing here has a default. `configFile` in
 * particular is supplied by project detection rather than chosen by this
 * contract, so that the layout of a project is described in one place only.
 */
export type CypressConfiguration = Readonly<{
  readonly configFile?: string;
  readonly baseUrl?: string;
  readonly projectId?: string;
  readonly specPattern?: string | readonly string[];
}>;

/** How long a run may take. */
export type ExecutionConfiguration = Readonly<{
  readonly timeoutMs?: number;
}>;

/** How much the tool says while it works. */
export type LoggingConfiguration = Readonly<{
  readonly level?: string;
}>;

/* -------------------------------------------------------------------------- */
/* The document                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A configuration document, as the validator leaves it.
 *
 * ## Two fields are required, and that is the whole point
 *
 * `version` and `framework` have no default because a plausible guess for either
 * would be worse than an error: one would reinterpret the document against the
 * wrong rules, the other would drive a project with the wrong tool.
 *
 * ## A type alias, not an interface
 *
 * Declared as an alias on purpose. TypeScript gives an implicit index signature
 * to anonymous object types, so a `Configuration` remains assignable to the
 * resolver's deliberately tolerant view of a document, while an `interface`
 * would be rejected for lacking the index signature it does not have. The same
 * property is what makes excess-property checking bite here: a field that is not
 * listed below is a compile error when constructing one, mirroring the runtime
 * refusal of unknown fields.
 *
 * ## Optional means "may be omitted", not "always present"
 *
 * Every optional field stays optional after validation. Filling them is the
 * resolver's job, and the resolved result is a different shape that guarantees
 * the anchors exist. Keeping the two apart means a consumer that needs an output
 * directory cannot accidentally depend on one being present in the file the user
 * wrote.
 */
export type Configuration = Readonly<{
  readonly version: ConfigurationVersion;
  readonly framework: FrameworkName;
  /** Which declared environment to use. Never defaulted by guesswork. */
  readonly defaultEnvironment?: string;
  readonly environments?: EnvironmentsConfiguration;
  readonly reports?: ReportsConfiguration;
  readonly evidence?: EvidenceConfiguration;
  readonly cypress?: CypressConfiguration;
  readonly execution?: ExecutionConfiguration;
  readonly logging?: LoggingConfiguration;
}>;
