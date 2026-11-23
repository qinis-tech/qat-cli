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
 *
 * ## What consumes this
 *
 * Two layers read it and neither re-probes the disk: the diagnosis builds findings from it, and the validation
 * layer classifies its layout evidence into a supported shape and a set of blocking conditions. That is why
 * everything a later decision needs is gathered here, including the awkward cases — a configuration in the wrong
 * place, a directory occupying a configuration filename, component tests that this tool cannot drive. Evidence is
 * cheap once; a second opinion about the same tree is not.
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
 * `cypress/integration` has both, and a consumer that wants one answer takes the first element of a list it can
 * see. Collapsing to a single value here would make that choice invisible — and the choice does get made, once,
 * where the project description is assembled.
 *
 * Nothing here lists a directory. Every entry comes from a fixed candidate list, so two machines holding
 * identical files produce identical evidence.
 */
export interface CypressLayout {
  /** Conventional spec directories that exist, in candidate order. */
  readonly specDirectories: readonly string[];
  /**
   * `cypress/component`, when it exists.
   *
   * Reported separately from `specDirectories` because it is not one of them. QAT has no component-testing
   * execution path, so a project whose only tests are components has no spec location this tool can drive —
   * and merging the two would make that project look ordinary here and fail later, during a run, with a message
   * about a missing file rather than about an unsupported layout.
   */
  readonly componentDirectory?: string;
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
  /**
   * Configuration files that exist where Cypress does not load one — inside `cypress/`.
   *
   * The names are the root candidate list, prefixed, so a format added to one is probed in both. A file here is
   * evidence that the project *is* configured, just not usefully, which is a different message from "nothing is
   * configured" and leads to a different fix.
   */
  readonly misplacedConfigurations: readonly string[];
  /**
   * Paths carrying a configuration filename that are directories rather than files.
   *
   * A directory on `cypress.config.ts` is invisible to a file probe, so the engine reports no configuration —
   * correctly — and without this the reason would be unavailable to whoever has to explain it. Empty in almost
   * every project, and the one fact that makes an otherwise baffling "no configuration found" actionable.
   */
  readonly occupiedConfigurationPaths: readonly string[];
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
