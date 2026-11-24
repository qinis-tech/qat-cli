/**
 * Public surface of configuration validation.
 *
 * The service, the codes and the diagnostic shape. The mapping helpers in `issue.ts` are not exported: a consumer with
 * a validation issue of its own wants a different function written for its own rules, not this one bent to fit.
 */
export {
  ConfigurationDiagnosticCode,
  type ConfigurationDiagnostic,
  type ConfigurationValidation,
} from "./contracts.js";
export { validateConfiguration } from "./verify.js";
