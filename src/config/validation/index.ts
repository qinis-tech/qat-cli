/**
 * Public surface of configuration validation.
 *
 * `validateConfiguration` and the two shapes it produces. The mapping helpers in `issue.ts` are not exported: a
 * consumer with a validation issue of its own wants a different function written for its own rules, not this one bent
 * to fit.
 *
 * ## The code set is deliberately absent
 *
 * `ConfigurationDiagnosticCode` is declared in `core/application/configuration.ts` and imported from there. It is
 * vocabulary — a layer above this one has to name a configuration code without depending on how this module is built —
 * so publishing it here as well would give one permanent identifier two routes, and the route through an
 * implementation barrel is the one that goes stale.
 *
 * The same rule holds for the domain types these signatures mention. `QatConfig` is exported from the schema module,
 * and nothing here re-exports it.
 */
export {
  type ConfigurationDiagnostic,
  type ConfigurationValidation,
} from "./contracts.js";
export { validateConfiguration } from "./verify.js";
