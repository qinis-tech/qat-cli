/**
 * Public surface of Cypress detection.
 *
 * `detectCypress` and the result types are exported; the probe, configuration and layout helpers are not. They
 * are the implementation of one question, and a caller that reaches for them is a caller that wants to answer a
 * slightly different question — which it should ask in its own module.
 */
export { LEGACY_CONFIG_FILES } from "./configuration.js";
export {
  DetectionVerdict,
  type CypressDetection,
  type CypressLayout,
  type DetectedProject,
  type DetectionOptions,
  type UndetectedProject,
} from "./contracts.js";
export { detectCypress } from "./detect.js";
