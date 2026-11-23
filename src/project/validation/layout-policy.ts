/**
 * The supported-layout policy.
 *
 * Two questions, two closed answers, and each answer maps to at most one diagnostic code. They are kept
 * separate because they fail separately: a project can have its configuration in exactly the right place and
 * still have no spec location this tool can drive, and the two have different remedies.
 *
 * ## Nothing here lists a directory
 *
 * Every location considered comes from a fixed candidate list, so the answer cannot depend on iteration order.
 * The consequence is a real limit: a configuration at `cypress.config.yaml` is invisible, and so are specs
 * under a name nobody has used before. That is written down in the architecture document rather than papered
 * over — the alternative is an answer that differs between two machines holding identical files.
 */
import { LEGACY_SPEC_DIRECTORY } from "../contracts.js";
import type { CypressLayout } from "../cypress-detection/contracts.js";

/**
 * Where the configuration sits, relative to where Cypress will look for it.
 *
 * Precedence is decided by usefulness rather than severity: a project with a usable root configuration and a
 * stray directory elsewhere is *working*, and blocking it over the stray directory would refuse to run
 * something that runs.
 */
export const ConfigurationPlacement = {
  /** A supported configuration file at the project root. What Cypress loads. */
  AtRoot: "at-root",
  /** No root configuration, but one exists inside `cypress/`, where Cypress does not look. */
  Misplaced: "misplaced",
  /** No root configuration, and a directory occupies one of the configuration filenames. */
  NameOccupied: "name-occupied",
  /** Nothing configured, and nothing explaining why. */
  Absent: "absent",
} as const;

export type ConfigurationPlacement =
  (typeof ConfigurationPlacement)[keyof typeof ConfigurationPlacement];

/** Where the specs are, as far as this tool can drive them. */
export const SpecsShape = {
  /** One of the named directories: current, or the pre-10 one. */
  Named: "named",
  /** Specs directly under `cypress/` — the pre-10 layout. Supported, and last in Cypress's own preference. */
  Legacy: "legacy",
  /** Component tests only. A real Cypress layout this tool has no execution path for. */
  ComponentOnly: "component-only",
  /** Nothing recognisable — usually a custom `specPattern`, which would need the configuration evaluated. */
  Unknown: "unknown",
} as const;

export type SpecsShape = (typeof SpecsShape)[keyof typeof SpecsShape];

export interface LayoutAssessment {
  readonly configuration: ConfigurationPlacement;
  readonly specs: SpecsShape;
}

/**
 * Classifies the layout from the evidence detection gathered.
 *
 * Pure, and deliberately so: it takes a value and returns a value, so every rule about what a supported
 * project looks like is testable without a filesystem and the same evidence always produces the same answer.
 *
 * @param layout The layout evidence.
 * @param configuration The single supported configuration file detection chose, when there is one.
 */
export function classifyLayout(
  layout: CypressLayout,
  configuration: string | undefined,
): LayoutAssessment {
  return {
    configuration: placementOf(layout, configuration),
    specs: specsOf(layout),
  };
}

/**
 * A configuration at the root wins outright.
 *
 * A directory squatting on a *different* configuration filename is not reported when the project works: the
 * job is to gate operations, not to audit repositories, and a finding would block a run that would succeed.
 * That stray directory is worth mentioning to whoever owns the code; it is not worth refusing over.
 */
function placementOf(
  layout: CypressLayout,
  configuration: string | undefined,
): ConfigurationPlacement {
  if (configuration !== undefined) return ConfigurationPlacement.AtRoot;
  if (layout.misplacedConfigurations.length > 0)
    return ConfigurationPlacement.Misplaced;
  if (layout.occupiedConfigurationPaths.length > 0)
    return ConfigurationPlacement.NameOccupied;

  return ConfigurationPlacement.Absent;
}

/**
 * The first recognised spec location, and what kind it is.
 *
 * Precedence: a named directory, then a component directory, then the legacy root. The order matters because the legacy
 * fallback is a *guess* — it fires whenever `cypress/` exists, and `cypress/` exists in a component-only project too.
 * When stronger evidence is available it wins.
 *
 * The consequence to know about: a pre-10 project that also holds components is classified as component-only. That
 * combination is rare, and the alternative — trusting the fallback first — would classify every modern
 * component-testing project as driveable, which is the wrong error to make: it produces a run that starts and then
 * collects the wrong files rather than one that stops with an explanation.
 */
function specsOf(layout: CypressLayout): SpecsShape {
  const [first] = layout.specDirectories;

  if (first !== undefined && first !== LEGACY_SPEC_DIRECTORY)
    return SpecsShape.Named;
  if (layout.componentDirectory !== undefined) return SpecsShape.ComponentOnly;
  if (first === LEGACY_SPEC_DIRECTORY) return SpecsShape.Legacy;

  return SpecsShape.Unknown;
}
