/**
 * What the detection engine reports.
 *
 * ## Detection is not validation
 *
 * This module answers one question — *is this a Cypress project QAT can drive?* —
 * and returns evidence with an answer attached. It does not decide whether the
 * project can actually run: a project with a supported configuration and no
 * installed Cypress is **detected**, because it is identifiable as a Cypress
 * project, and the missing dependency is a separate problem with a separate
 * remedy.
 *
 * That split is what lets one caller report a diagnosis and another decide to stop.
 *
 * ## Every verdict is a diagnosis, not an error
 *
 * Nothing here throws for absence, ambiguity or an unusable format. Those are
 * answers. Errors are reserved for input that cannot be read at all — a manifest
 * that does not parse, a directory that cannot be listed — because "there is
 * nothing here" and "there is something here and it is broken" need different
 * handling.
 *
 * ## What consumers may rely on
 *
 * Two layers read this value and neither re-probes the disk: the diagnosis builds
 * findings from it, and the validation layer classifies its layout evidence into a
 * supported shape and a set of blocking conditions. So the guarantees are part of
 * the contract, not implementation detail:
 *
 * | Guarantee | Why it matters to a consumer |
 * | --- | --- |
 * | `root` is absolute and normalised | It is the only value a consumer may hand to a process or a path resolver |
 * | Every other path is project-relative, POSIX-separated | Evidence is printed verbatim; a Windows separator would reach a user's terminal |
 * | All arrays are frozen and in candidate order | Two machines with identical files must produce identical evidence, and no consumer may reorder it in place |
 * | Every declared list contains only entries that were actually observed | Nothing here is derived, inferred or defaulted |
 * | `verdict` never contradicts the evidence | A consumer may switch on `verdict` alone and never has to re-check for a case the evidence implies |
 * | Absence is authoritative | An empty list means "none exist", not "we could not tell" — the engine throws instead of returning a guess |
 *
 * ## Why everything is gathered here
 *
 * Including the awkward cases — a configuration in the wrong place, a directory
 * occupying a configuration filename, component tests that this tool cannot drive.
 * Evidence is cheap once; a second opinion about the same tree is not.
 */

import type { PackageDiscovery } from "../package-discovery/index.js";

/**
 * How the directory was classified.
 *
 * A closed set, so a `switch` over it is exhaustive. The five members are
 * mutually exclusive by construction: the engine produces exactly one, and the
 * evidence explains it.
 *
 * The const object and the union describe the same thing on purpose: the members
 * are values a `switch` can compare against without string literals drifting, and
 * the union is what makes an unhandled case a compile error.
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
 * Arrays rather than a first match, because this is evidence: a project with both
 * `cypress/e2e` and `cypress/integration` has both, and a consumer that wants one
 * answer takes the first element of a list it can see. Collapsing to a single
 * value here would make that choice invisible — and the choice does get made, once,
 * where the project description is assembled.
 *
 * Nothing here lists a directory. Every entry comes from a fixed candidate list, so
 * two machines holding identical files produce identical evidence. Paths are
 * project-relative and POSIX-separated: they are printed verbatim in findings.
 */
export interface CypressLayout {
  /** Conventional spec directories that exist, in candidate order. */
  readonly specDirectories: readonly string[];

  /**
   * `cypress/component`, when it exists.
   *
   * Reported separately from `specDirectories` because it is not one of them. QAT
   * has no component-testing execution path, so a project whose only tests are
   * components has no spec location this tool can drive — and merging the two would
   * make that project look ordinary here and fail later, during a run, with a
   * message about a missing file rather than about an unsupported layout.
   */
  readonly componentDirectory?: string;

  /** Conventional support files that exist, in candidate order. */
  readonly supportFiles: readonly string[];

  readonly screenshotsDirectory?: string;
  readonly videosDirectory?: string;

  /**
   * Whether a `cypress/` directory exists at all.
   *
   * Not derived from `specDirectories`, even though the two coincide today —
   * `cypress` is one of the spec-directory candidates. They answer different
   * questions: this one is corroborating evidence when there is no configuration
   * file, and tying it to the other list would make one silently depend on the
   * other's contents.
   */
  readonly hasCypressDirectory: boolean;

  /**
   * Configuration files that exist where Cypress does not load one — inside
   * `cypress/`.
   *
   * The names are the root candidate list, prefixed, so a format added to one is
   * probed in both. A file here is evidence that the project *is* configured, just
   * not usefully, which is a different message from "nothing is configured" and
   * leads to a different fix.
   *
   * Populated even alongside a `detected` verdict: a project part-way through a
   * migration has both forms, and the stale one is worth mentioning without being
   * an error.
   */
  readonly misplacedConfigurations: readonly string[];

  /**
   * Paths carrying a configuration filename that are directories rather than files.
   *
   * A directory on `cypress.config.ts` is invisible to a file probe, so the engine
   * reports no configuration — correctly — and without this the reason would be
   * unavailable to whoever has to explain it. Empty in almost every project, and
   * the one fact that makes an otherwise baffling "no configuration found"
   * actionable.
   */
  readonly occupiedConfigurationPaths: readonly string[];
}

/**
 * Everything gathered, whichever way the directory was classified.
 *
 * Exported because two consumers already hold one: the diagnosis receives evidence
 * and a verdict together, and any future caller that wants to report *what was
 * seen* without reporting a classification should be able to name the type rather
 * than redeclare its shape.
 *
 * Treat this as a snapshot, not a view: it is frozen, it was read once, and it must
 * not be reconstructed from live disk state by a consumer. A second read of the
 * same tree is a second answer that can disagree with the first.
 */
export interface DetectionEvidence {
  /** Absolute, and the directory the evidence describes. The only absolute path here. */
  readonly root: string;

  /**
   * Supported configuration files found, in candidate order.
   *
   * Empty, or one, unless the verdict is `ambiguous` — which is the invariant a
   * consumer may rely on instead of re-counting. Frozen at the source, so a
   * consumer that sorts it would reorder a shared observation for the rest of the
   * run.
   */
  readonly configurations: readonly string[];

  /**
   * Configuration files recognised as Cypress but not usable by QAT, in candidate
   * order.
   *
   * Reported alongside a `detected` verdict rather than only on failure: a project
   * part-way through a migration has both forms, and the stale one is worth
   * mentioning without being an error.
   */
  readonly unsupportedConfigurations: readonly string[];

  /**
   * The manifest and installed package, read once. Declaration and installation
   * live here.
   *
   * Ownership stays with the package-discovery module: this layer records what it
   * was given and never re-resolves a package to double-check it.
   */
  readonly packages: PackageDiscovery;

  readonly layout: CypressLayout;
}

/**
 * A usable configuration was found.
 *
 * `configuration` is non-optional because `detected` without one is meaningless,
 * and it is always a member of `configurations` — the two are written together, so
 * a consumer never has to search the list for the one file it already has.
 */
export interface DetectedProject extends DetectionEvidence {
  readonly verdict: typeof DetectionVerdict.Detected;
  /** The configuration file, relative to the root. */
  readonly configuration: string;
}

/**
 * Everything else, with the evidence that explains why.
 *
 * Narrowing on `verdict` is the supported way to read the specific evidence for a
 * case — `Extract<CypressDetection, { verdict: 'unsupported' }>` gives access to
 * `unsupportedConfigurations` without a cast.
 */
export interface UndetectedProject extends DetectionEvidence {
  readonly verdict: Exclude<DetectionVerdict, typeof DetectionVerdict.Detected>;
}

export type CypressDetection = DetectedProject | UndetectedProject;

export interface DetectionOptions {
  /**
   * How far to climb for a hoisted install.
   *
   * A bound, not a strategy: the search is always "this directory, then up", and
   * this value only stops it. Bounded because an unbounded walk from a mistaken
   * root reaches the filesystem root, which is slow and surprising rather than
   * merely useless.
   */
  readonly maxDepth?: number;
}
