/**
 * Public surface of the configuration resolution stage.
 *
 * The resolver fills the values a configuration omitted, anchors every path to the
 * project root, and resolves the environment a run targets into one protected
 * value. Everything outside this folder — the composition root, validation, the
 * CLI, the report and evidence writers — reaches it through this file, so the list
 * below is the contract rather than an inventory of what happens to be declared
 * next door.
 *
 * Rules applied here:
 *
 * - **Explicit names only.** No `export *`. A wildcard publishes internals the
 *   moment somebody adds a helper, and an accidental export is a promise the
 *   project then has to keep.
 * - **Types and values are separated.** `export type` is erased at build time, so
 *   a type-only re-export cannot pull a module into the runtime graph.
 * - **Nothing is exported only for a test.** A test that needs an internal helper
 *   imports the module directly; a public export that only a test calls is
 *   configuration surface with no user. The two exception-shaped entries below
 *   (`PATH_ISSUE_CODES`, `ENVIRONMENT_ISSUE_CODES`) exist because the diagnostics
 *   catalogue iterates them to prove every code has a message — a production
 *   consumer, not a test.
 * - **Implementation details stay inside.** `freeze.ts`, the internal shape
 *   predicates and `environment.ts`'s parsing helper are not part of the contract.
 *   Promoting one is a one-line change; withdrawing one is a breaking change.
 * - **Borrowed types are not re-exported.** `ResolvedExecutionEnvironment` belongs
 *   to the domain, and a consumer that needs to name it imports it from there. A
 *   barrel that re-exported the vocabulary of its dependencies would slowly become
 *   the place everybody imports everything from, and the dependency graph would
 *   show nothing.
 */

/* -------------------------------------------------------------------------- */
/* Contracts: shapes                                                          */
/* -------------------------------------------------------------------------- */

export type {
  ConfigurationResolution,
  DefaultableConfiguration,
  DefaultDescriptor,
  DefaultEnvironmentResolution,
  EnvironmentIssue,
  EnvironmentIssueCode,
  EnvironmentOverrides,
  EnvironmentResolution,
  IssueSeverity,
  LoadedConfigurationDocument,
  PathFieldPolicy,
  PathForm,
  PathIssue,
  PathIssueCode,
  PathResolution,
  PathTools,
  ResolvedConfiguration,
  ResolvedConfigurationPaths,
  ResolvedPath,
  ResolveConfigurationInput,
  ResolveEnvironmentInput,
  ResolvePathOptions,
} from "./contracts.js";

/* -------------------------------------------------------------------------- */
/* Contracts: the guards, the codes and the path policies                     */
/* -------------------------------------------------------------------------- */

export {
  ENVIRONMENT_ISSUE_CODES,
  EXTERNAL_INPUT_PATH_POLICY,
  LoadedConfigurationRequiredError,
  PATH_ISSUE_CODES,
  PROJECT_INPUT_PATH_POLICY,
  PROJECT_OUTPUT_PATH_POLICY,
  assertLoadedDocument,
  isLoadedDocument,
  markLoaded,
} from "./contracts.js";

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

export {
  CONFIGURATION_DEFAULTS,
  DEFAULT_CATALOGUE,
  PREFERRED_ENVIRONMENT_KEY,
  createDefaultsProvider,
  defaultsAsMarkdown,
} from "./defaults.js";

export type { DefaultsProvider } from "./defaults.js";

/* -------------------------------------------------------------------------- */
/* Defaulting                                                                 */
/* -------------------------------------------------------------------------- */

export { applyDefaults, selectDefaultEnvironment } from "./defaulting.js";

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

export {
  MAX_CONFIGURED_PATH_LENGTH,
  isWithinProjectRoot,
  resolvePath,
} from "./paths.js";

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

export { outputDirectories, resolveConfiguration } from "./resolve.js";

/* -------------------------------------------------------------------------- */
/* Environment resolution                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Selection, approved overrides and secret resolution.
 *
 * Published after configuration resolution rather than beside it because it
 * consumes that stage's output: it takes the derived default environment and the
 * validated profiles, and never re-reads the document. A caller that reached for
 * it first would have to derive both itself, which is how two stages end up
 * disagreeing about which environment a project declares.
 *
 * The one override variable's name is exported next to the resolver, because a
 * caller that documents `QAT_BASE_URL` in its own help text should not have to
 * spell it twice.
 */
export {
  BASE_URL_ENVIRONMENT_VARIABLE,
  resolveEnvironment,
} from "./environment.js";
