/**
 * Public surface of the Cypress configuration health checks (CFG-003, CFG-004).
 *
 * Consumers — the two diagnostic rules and the composition root — import from
 * here and never from a deep path. The barrel makes the module's contract a
 * reviewable list rather than whatever happens to be exported by its files, so a
 * helper becoming public is a deliberate edit and not an accident.
 *
 * Scope reminder for anyone reading this list: nothing here discovers a project.
 * Which configuration file exists, what the layout looks like and whether the
 * directory is a Cypress project at all come from `cypress-detection`, which
 * reports that evidence once per run. This module starts from that evidence.
 *
 * Re-exports are explicit rather than `export *` for two reasons: the public
 * surface stays visible in one diff, and internal helpers (path normalisation,
 * error classification, tier internals) cannot leak into the module's API by
 * virtue of being exported for their own tests.
 */

/* -------------------------------------------------------------------------- */
/* Contracts — the vocabulary shared with the rules                           */
/* -------------------------------------------------------------------------- */

export type {
  /** Diagnostic identifiers this module feeds, used in skip verdicts. */
  ConfigCheckId,
  /** How a verdict maps onto `pass | warning | fail | indeterminate | skipped`. */
  ConfigOutcome,
  /** Validation depth a file's shape permits: parseable JSON, or executable. */
  CypressConfigFormat,
  /** Filesystem state of the configuration, as observed and never guessed. */
  ConfigFileState,
  /** Bounded, decoded sample of the file's bytes. Content never reaches output. */
  ConfigTextSample,
  /** Everything established about the located file. `absolutePath` is internal. */
  ConfigFileFacts,
  /** The CFG-003 location verdict. Discriminated by `reason`. */
  ConfigDiscovery,
  /** Why validation could not reach a verdict. */
  ConfigValidationGapCause,
  /** Which mechanism spoke: text sanity, JSON parser, or the project's loader. */
  ValidationTier,
  /** What kind of invalidity was established, so the message can point at a line. */
  ConfigFailure,
  /** The CFG-004 validation verdict. Discriminated by `reason`. */
  ConfigValidation,
  /** Narrowing helpers, so consumers avoid hand-rolled casts. */
  ConfigDiscoveryEstablished,
  ConfigDiscoveryFailed,
  /** What the two rules return together: one verdict per question. */
  ConfigHealthVerdicts,
} from "./contracts.js";

/* -------------------------------------------------------------------------- */
/* Discovery — pure projection from detection evidence                        */
/* -------------------------------------------------------------------------- */

export {
  /** CFG-003: detection evidence plus file facts → one location verdict. */
  inspectConfiguration,
  /** Advisory for a configuration that exists where Cypress never loads one. */
  inspectMisplacedConfiguration,
} from "./inspect.js";

/* -------------------------------------------------------------------------- */
/* Inspection — the only filesystem boundary in this module                   */
/* -------------------------------------------------------------------------- */

export {
  /** Largest configuration file we are willing to read (1 MiB). */
  CONFIG_SIZE_BUDGET_BYTES,
  createConfigFileInspector,
  createNodeConfigFileSystem,
} from "./snapshot.js";

export type {
  /** Injected filesystem surface, deliberately without a write method. */
  ConfigFileSystem,
  /** Memoised, single-flight inspector for the one located file. */
  ConfigFileInspector,
} from "./snapshot.js";

/* -------------------------------------------------------------------------- */
/* Validation — the tiered ladder, pure apart from the injected probe          */
/* -------------------------------------------------------------------------- */

export {
  /** CFG-004: facts plus policy plus loader → one validation verdict. */
  validateConfiguration,
  /** ANSI stripping, whitespace collapsing and length capping for loader output. */
  sanitiseLoaderMessage,
  /** Cap on loader output kept in evidence. */
  MAX_LOADER_MESSAGE_CHARS,
} from "./validate.js";

export type {
  /**
   * The loader capability, owned by its consumer so the ladder can be tested
   * with a stub and cannot acquire an accidental process-runner import.
   */
  ConfigLoadProbePort,
  /**
   * `loaded | failed | unavailable | timeout` — four facts that stay four facts,
   * because only `failed` is an observation about the file.
   */
  ConfigLoadProbeResult,
} from "./validate.js";

/* -------------------------------------------------------------------------- */
/* Preflight — the bounded, opt-in process boundary for tier 2                */
/* -------------------------------------------------------------------------- */

export {
  /** Builds the probe from an injected runner and CLI resolver. */
  createCypressConfigLoaderProbe,
  /** Hard bound on the load attempt. */
  CONFIG_LOAD_TIMEOUT_MS,
  /** Cap on captured stderr. */
  MAX_LOADER_OUTPUT_BYTES,
  /** Frozen argument vector: load the configuration, never run a test. */
  CONFIG_LOAD_ARGUMENTS,
} from "./preflight.js";

export type {
  /** Structural view of the framework's process utility, adapted in composition. */
  CommandRunnerPort,
  /** Project-local Cypress CLI resolution, owned by the Cypress health checks. */
  CypressCliResolverPort,
  /** One fully-specified invocation: command, args, cwd, budget, environment. */
  CommandInvocation,
  /** What the runner reports back, with `timedOut` kept separate from exit codes. */
  CommandOutcome,
} from "./preflight.js";
