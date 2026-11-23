/**
 * The shapes the validation rules are written against.
 *
 * Internal to this layer. A rule receives everything known about a project and returns the conditions it
 * found; it renders nothing, so the prose stays in one catalogue and the rule table stays readable as logic.
 */
import type { ProjectDiagnosis } from "../../core/application/diagnostics.js";
import type {
  AnyDiagnosticFinding,
  ValidationCode,
  ValidationRequirementId,
} from "../../core/application/validation.js";
import type { CypressDetection } from "../cypress-detection/contracts.js";

import type { LayoutAssessment } from "./layout-policy.js";

/** Everything a requirement is allowed to look at. */
export interface ValidationInput {
  /** The structured detection result, including evidence the diagnosis does not surface. */
  readonly detection: CypressDetection;
  /** The diagnosis derived from the same result, so a requirement can carry its findings forward. */
  readonly diagnosis: ProjectDiagnosis;
  /** The layout, classified once so every requirement agrees about the shape. */
  readonly layout: LayoutAssessment;
}

/**
 * What a requirement found.
 *
 * Two fields because conditions originate in two places, and treating them alike would be wrong:
 *
 * - `codes` are conditions *this layer* is the first to notice; the validation catalogue renders them.
 * - `findings` are what detection already said, carried forward **unchanged**. Re-wording them here would put
 *   one condition's prose in two catalogues, and the two would drift the first time either was edited.
 *   Detection decides what is wrong; this layer decides only whether it stops the operation.
 */
export interface RequirementVerdict {
  readonly codes?: readonly ValidationCode[];
  readonly findings?: readonly AnyDiagnosticFinding[];
}

/** One check, as data. */
export interface ValidationRequirement {
  readonly id: ValidationRequirementId;
  /** What it asserts, in one line. Printed for the ones that passed as well as the ones that did not. */
  readonly summary: string;
  readonly evaluate: (input: ValidationInput) => RequirementVerdict;
}
