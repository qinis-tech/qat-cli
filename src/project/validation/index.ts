/**
 * Public surface of validation.
 *
 * The contract is not re-exported. `ProjectAssessment`, `QatOperation`, `OperationReadiness`, `ValidationCode`
 * and the requirement identifiers are declared in `core/application/validation.ts`, and a consumer imports
 * them from there — a second route through an implementation barrel is the route that goes stale.
 *
 * `VALIDATION_GUIDANCE` and `CYPRESS_VERSION_POLICY` *are* exported, for the same reason the detection
 * catalogue is: they are content this layer owns, and anything explaining a code should get the words from the
 * module that wrote them.
 */
export {
  assessDetection,
  assessProject,
  type AssessmentOptions,
} from "./assess.js";
export { VALIDATION_GUIDANCE, type ValidationFacts } from "./catalogue.js";
export type {
  RequirementVerdict,
  ValidationInput,
  ValidationRequirement,
} from "./contracts.js";
export { assertReadyFor } from "./gate.js";
export {
  classifyLayout,
  ConfigurationPlacement,
  SpecsShape,
  type LayoutAssessment,
} from "./layout-policy.js";
export { CYPRESS_VERSION_POLICY } from "./policy.js";
export { REQUIREMENTS } from "./rules.js";
