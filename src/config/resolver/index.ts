/**
 * Public surface of the configuration resolution stage.
 *
 * The resolver fills the values a configuration omitted and anchors every path to
 * the project root. Everything outside this folder — the composition root,
 * validation, the CLI, the report and evidence writers — reaches it through this
 * file, so the list below is the contract rather than an inventory of what
 * happens to be declared next door.
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
 *   configuration surface with no user.
 * - **Implementation details stay inside.** `freeze.ts` and the internal shape
 *   predicates are not part of the contract. Promoting one is a one-line change;
 *   withdrawing one is a breaking change.
 */

/* -------------------------------------------------------------------------- */
/* Contracts: shapes                                                          */
/* -------------------------------------------------------------------------- */

export type {
  ConfigurationResolution,
  DefaultableConfiguration,
  DefaultDescriptor,
  DefaultEnvironmentResolution,
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
  ResolvePathOptions,
} from "./contracts.js";

/* -------------------------------------------------------------------------- */
/* Contracts: the loaded-document guard and the path policies                 */
/* -------------------------------------------------------------------------- */

export {
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
