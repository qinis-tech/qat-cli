/**
 * Public surface of configuration loading.
 *
 * Three values and the types that describe what they produce.
 *
 * | Export | For |
 * | --- | --- |
 * | `loadConfiguration` | The entry point — a path in, one of six outcomes out |
 * | `parseJsonDocument` | A caller holding JSON from somewhere other than a file, and a test of error positions that should not need a temporary directory |
 * | `ConfigurationLoad` | The closed set, because a caller switches over it and the switch must be exhaustive |
 *
 * ## Why the six outcomes are named exports
 *
 * A renderer takes *one* variant — `function renderLoaded(result: LoadedConfiguration)` — and `Extract<ConfigurationLoadResult, { kind: 'loaded' }>`
 * in a signature is clever where a name is clear. The union is exported too, so a caller that wants to treat them together can.
 *
 * ## What is deliberately absent
 *
 * **The schema and `zod`.** A consumer that wants to validate something itself imports the schema barrel, which owns that
 * vocabulary. Re-exporting either here would make this module a second route to a dependency, and the second route is the
 * one that goes stale.
 *
 * **`QatConfig`.** It is reachable structurally — `result.config` has the type — and a caller that needs to *name* it
 * imports it from `../schema/index.js`, which is where it is declared. Re-exporting it would give the configuration type
 * two homes and no owner.
 *
 * **`CONFIG_FILE_NAME`.** It lives in `../contracts.js`, which is the layer that reads files. Discovery re-exports it so a
 * caller rendering a location imports one module; the loader has nothing to render.
 *
 * **The filesystem-error predicate.** Which codes mean "nothing there" is an implementation detail of this module's two
 * probes. A caller that needs it is writing a third probe.
 */
export {
  ConfigurationLoad,
  type ConfigurationIssue,
  type ConfigurationLoadResult,
  type EmptyConfiguration,
  type InvalidConfiguration,
  type JsonLocation,
  type LoadedConfiguration,
  type LoadOptions,
  type MalformedConfiguration,
  type MissingConfiguration,
  type OversizedConfiguration,
} from "./contracts.js";
export { parseJsonDocument, type JsonParse } from "./json.js";
export { loadConfiguration } from "./load.js";
