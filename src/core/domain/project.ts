/**
 * Project discovery contracts.
 *
 * What QAT knows about a project before it runs anything. Every later layer — configuration, execution,
 * reporting — reads this instead of re-reading the filesystem, so discovery happens exactly once and its
 * result is the single answer.
 *
 * This file has no imports at all. That is the strongest form of the domain rule: the vocabulary depends on
 * nothing, so nothing can leak into it.
 */

/**
 * Package managers QAT can recognise.
 *
 * A closed set, because recognising one is a claim about how a project is installed and what command fixes a
 * missing dependency. An unrecognised manager is better reported as absent than guessed at.
 */
export const PackageManager = {
  Npm: "npm",
  Pnpm: "pnpm",
  Yarn: "yarn",
  Bun: "bun",
} as const;

export type PackageManager =
  (typeof PackageManager)[keyof typeof PackageManager];

export interface PackageManagerInfo {
  readonly name: PackageManager;
  /**
   * Whether `package.json` declared this, or a lockfile merely implied it.
   *
   * The distinction matters: a lockfile left behind after a migration implies a manager the project no
   * longer uses, and any remediation built on it would be wrong.
   */
  readonly declared: boolean;
  /** The lockfile the inference came from, when it was inferred. */
  readonly lockfile?: string;
}

/**
 * Frameworks QAT can drive.
 *
 * A closed set, not `string`. Adding a member is a deliberate act that will break every exhaustive `switch`
 * over it — which is exactly what should happen, because each switch needs a decision about the new
 * framework.
 */
export const Framework = {
  Cypress: "cypress",
} as const;

export type Framework = (typeof Framework)[keyof typeof Framework];

/**
 * Which dependency map a package was declared in.
 *
 * A closed set, because the section is a fact about the manifest rather than a label a caller may invent,
 * and because a `switch` over it should be exhaustive.
 *
 * The order of the members is the order a declaration is searched in, but nothing here enforces that —
 * the search order belongs to the reader, and stating it in two places would let them disagree.
 */
export const DependencySection = {
  Dependencies: "dependencies",
  DevDependencies: "devDependencies",
  OptionalDependencies: "optionalDependencies",
  PeerDependencies: "peerDependencies",
} as const;

export type DependencySection =
  (typeof DependencySection)[keyof typeof DependencySection];

/**
 * A framework's declaration in the project manifest.
 *
 * Deliberately carries no installation information. Whether a package is *declared* and whether it is
 * *installed* are two facts that fail differently: a declared but uninstalled package needs one command,
 * while an undeclared one usually means the project is not what the reader thought. Merging them produces
 * the message that tells someone to install something they already have.
 */
export interface FrameworkDeclaration {
  readonly section: DependencySection;
  /**
   * The version range exactly as written, e.g. `^13.15.0`.
   *
   * Not resolved, and not compared with the version that is actually installed. Comparing the two needs a
   * range implementation, and carrying one into this file would make every consumer of a project
   * description depend on it — including the ones that only ever print the string.
   */
  readonly range: string;
}

/** The subset of `package.json` QAT actually uses. Not a copy of the whole file. */
export interface PackageMetadata {
  readonly name: string;
  readonly version: string;
  /**
   * Whether the project declares itself private.
   *
   * Relevant because `private: true` commonly marks a workspace member rather than a publishable package,
   * and it is one of the cheapest signals for distinguishing the two during discovery.
   */
  readonly private: boolean;
}

/**
 * Locations inside a project, expressed as paths **relative to `ProjectInfo.root`**.
 *
 * Relative on purpose. An absolute path embeds one machine's layout: it makes a stored result unreadable
 * elsewhere, breaks reproducibility between developer and CI runs, and is the usual route by which a
 * username or home directory ends up in a published artefact or a pasted log.
 *
 * Consumers join these against `root` at the point of use, which is the one place that already knows where
 * the project lives.
 */
export interface ProjectPaths {
  /** Framework configuration file, e.g. `cypress.config.ts`. */
  readonly configFile: string;
  /** Directory holding specs, e.g. `cypress/e2e`. */
  readonly specsDirectory: string;
  /** Support or setup file, where the framework uses one. */
  readonly supportFile?: string;
  /** Where the framework writes screenshots, before QAT collects them as evidence. */
  readonly screenshotsDirectory?: string;
  /** Where the framework writes video, before QAT collects it as evidence. */
  readonly videosDirectory?: string;
  /** Application source directory, where one follows a conventional name. Absent for test-only projects. */
  readonly sourceDirectory?: string;
}

/**
 * Where the installed framework came from.
 *
 * Recorded because it determines whether a run is reproducible. A project-level install is pinned by the
 * project's lockfile; a global install is pinned by whatever the operator happened to install months ago.
 * Reporting the source turns "works on my machine" into a fact visible in the result rather than a debugging
 * session.
 */
export const InstallationSource = {
  Project: "project",
  Workspace: "workspace",
  Global: "global",
} as const;

export type InstallationSource =
  (typeof InstallationSource)[keyof typeof InstallationSource];

export interface FrameworkInstallation {
  readonly framework: Framework;
  /**
   * Version as the framework reports it, e.g. `13.15.0`.
   *
   * A plain string. Version *interpretation* — range checking, compatibility rules — belongs to whoever
   * needs it, not to the type that carries it. Parsing here would make every consumer depend on a semver
   * implementation.
   */
  readonly version: string;
  readonly source: InstallationSource;
  /** Resolved path to the framework's executable entry, where one exists. */
  readonly executablePath?: string;
}

/**
 * Everything discovery established about a project.
 *
 * Produced once, passed by value, never re-derived. A field missing from this type is a field every
 * downstream layer would otherwise read from disk independently — which is how two modules end up
 * disagreeing about where the specs live.
 */
export interface ProjectInfo {
  /**
   * Absolute project root.
   *
   * The only absolute path in the whole description. Resolved once, at discovery, because that is the single
   * moment the answer is unambiguous.
   */
  readonly root: string;
  /** Project name, from `package.json` where present, otherwise the directory name. */
  readonly name: string;
  readonly framework: Framework;
  readonly installation: FrameworkInstallation;
  /**
   * Where the framework was declared in the manifest.
   *
   * Carried separately from `installation` rather than folded into it, because the two answer different
   * questions and a consumer may reasonably need either. Absent when the project does not declare the
   * framework — a hoisted workspace install is the ordinary case, not an anomaly, and the absence is the
   * fact, not a missing-value bug to be papered over.
   */
  readonly frameworkDeclaration?: FrameworkDeclaration;
  readonly paths: ProjectPaths;
  /** Absent when the directory has no `package.json`, which is legal for a bare project. */
  readonly packageMetadata?: PackageMetadata;
  /** Absent when no lockfile or declaration was found. Not an error: a project may have neither. */
  readonly packageManager?: PackageManagerInfo;
}
