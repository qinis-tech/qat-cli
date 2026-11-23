/**
 * What the detection engine reports.
 *
 * ## Detection is not validation
 *
 * This module answers one question — *is this a Cypress project QAT can drive?* — and returns evidence with an
 * answer attached. It does not decide whether the project can actually run: a project with a supported
 * configuration and no installed Cypress is **detected**, because it is identifiable as a Cypress project, and
 * the missing dependency is a separate problem with a separate remedy.
 *
 * That split is what lets one caller report a diagnosis and another decide to stop.
 *
 * ## Every verdict is a diagnosis, not an error
 *
 * Nothing here throws for absence, ambiguity or an unusable format. Those are answers. Errors are reserved for
 * input that cannot be read at all — a manifest that does not parse, a directory that cannot be listed — because
 * "there is nothing here" and "there is something here and it is broken" need different handling.
 */
import type { PackageDiscovery } from "../package-discovery/index.js";

/**
 * How the directory was classified.
 *
 * A closed set, so a `switch` over it is exhaustive. The five members are mutually exclusive by construction:
 * the engine produces exactly one, and the evidence explains it.
 */
export const DetectionVerdict = {
  /** Exactly one supported configuration was found. */
  Detected: "detected",
  /** Nothing identifying Cypress: no configuration, no dependency, no conventional directory. */
  Absent: "absent",
  /** Cypress is evidenced — declared, installed, or a `cypress/` directory — but no configuration file. */
  Incomplete: "incomplete",
  /** More than one supported configuration file in one directory. */
  Ambiguous: "ambiguous",
  /** A Cypress configuration was found in a format QAT cannot read. */
  Unsupported: "unsupported",
} as const;

export type DetectionVerdict =
  (typeof DetectionVerdict)[keyof typeof DetectionVerdict];

/**
 * Conventional locations that exist, as paths relative to the root.
 *
 * Arrays rather than a first match, because this is evidence: a project with both `cypress/e2e` and
 * `cypress/component` has both, and a consumer that wants one answer takes the first element of a list it can
 * see. Collapsing to a single value here would make that choice invisible.
 */
export interface CypressLayout {
  /** Conventional spec directories that exist, in candidate order. */
  readonly specDirectories: readonly string[];
  /** Conventional support files that exist, in candidate order. */
  readonly supportFiles: readonly string[];
  readonly screenshotsDirectory?: string;
  readonly videosDirectory?: string;
  /**
   * Whether a `cypress/` directory exists at all.
   *
   * Not derived from `specDirectories`, even though the two coincide today — `cypress` is one of the spec-directory
   * candidates. They answer different questions: this one is corroborating evidence when there is no
   * configuration file, and tying it to the other list would make one silently depend on the other's contents.
   */
  readonly hasCypressDirectory: boolean;
}

/** Everything gathered, whichever way the directory was classified. */
interface DetectionEvidence {
  /** Absolute, and the directory the evidence describes. */
  readonly root: string;
  /** Supported configuration files found, in candidate order. Empty, or one, unless the verdict is `ambiguous`. */
  readonly configurations: readonly string[];
  /**
   * Configuration files recognised as Cypress but not usable by QAT, in candidate order.
   *
   * Reported alongside a `detected` verdict rather than only on failure: a project part-way through a migration
   * has both forms, and the stale one is worth mentioning without being an error.
   */
  readonly unsupportedConfigurations: readonly string[];
  /** The manifest and installed package, read once. Declaration and installation live here. */
  readonly packages: PackageDiscovery;
  readonly layout: CypressLayout;
}

/** A usable configuration was found. */
export interface DetectedProject extends DetectionEvidence {
  readonly verdict: typeof DetectionVerdict.Detected;
  /** The configuration file, relative to the root. Non-optional, because `detected` without one is meaningless. */
  readonly configuration: string;
}

/** Everything else, with the evidence that explains why. */
export interface UndetectedProject extends DetectionEvidence {
  readonly verdict: Exclude<DetectionVerdict, typeof DetectionVerdict.Detected>;
}

export type CypressDetection = DetectedProject | UndetectedProject;

export interface DetectionOptions {
  /** How far to climb for a hoisted install. Bounded, so a mistaken root cannot walk to the filesystem root. */
  readonly maxDepth?: number;
}
