/**
 * Project discovery contracts.
 *
 * What QAT knows about a project before it runs anything. Every later layer —
 * configuration, execution, reporting — reads this instead of re-reading the
 * filesystem, so discovery happens exactly once and its result is the single answer.
 *
 * This file has no imports at all. That is the strongest form of the domain rule:
 * the vocabulary depends on nothing, so nothing can leak into it.
 */

/**
 * Package managers QAT can recognise.
 *
 * A closed set, because recognising one is a claim about how a project is installed and what
 * command fixes a missing dependency. An unrecognised manager is better reported as absent than
 * guessed at.
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
   * The distinction matters: a lockfile left behind after a migration implies a manager the
   * project no longer uses, and any remediation built on it would be wrong.
   */
  readonly declared: boolean;
  /** The lockfile the inference came from, when it was inferred. */
  readonly lockfile?: string;
}

/**
 * Frameworks QAT can drive.
 *
 * A closed set, not `string`. Adding a member is a deliberate act that will break
 * every exhaustive `switch` over it — which is exactly what should happen, because
 * each switch needs a decision about the new framework.
 */
export const Framework = {
  Cypress: "cypress",
} as const;

export type Framework = (typeof Framework)[keyof typeof Framework];

/** The subset of `package.json` QAT actually uses. Not a copy of the whole file. */
export interface PackageMetadata {
  readonly name: string;
  readonly version: string;
  /**
   * Whether the project declares itself private.
   *
   * Relevant because `private: true` commonly marks a workspace member rather than a
   * publishable package, and it is one of the cheapest signals for distinguishing the
   * two during discovery.
   */
  readonly private: boolean;
}

/**
 * Locations inside a project, expressed as paths **relative to `ProjectInfo.root`**.
 *
 * Relative on purpose. An absolute path embeds one machine's layout: it makes a
 * stored result unreadable elsewhere, breaks reproducibility between developer and CI
 * runs, and is the usual route by which a username or home directory ends up in a
 * published artefact or a pasted log.
 *
 * Consumers join these against `root` at the point of use, which is the one place
 * that already knows where the project lives.
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
 * Recorded because it determines whether a run is reproducible. A project-level
 * install is pinned by the project's lockfile; a global install is pinned by whatever
 * the operator happened to install months ago. Reporting the source turns "works on my
 * machine" into a fact visible in the result rather than a debugging session.
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
   * A plain string. Version *interpretation* — range checking, compatibility rules —
   * belongs to whoever needs it, not to the type that carries it. Parsing here would
   * make every consumer depend on a semver implementation.
   */
  readonly version: string;
  readonly source: InstallationSource;
  /** Resolved path to the framework's executable entry, where one exists. */
  readonly executablePath?: string;
}

/**
 * Everything discovery established about a project.
 *
 * Produced once, passed by value, never re-derived. A field missing from this type is
 * a field every downstream layer would otherwise read from disk independently — which
 * is how two modules end up disagreeing about where the specs live.
 */
export interface ProjectInfo {
  /**
   * Absolute project root.
   *
   * The only absolute path in the whole description. Resolved once, at discovery,
   * because that is the single moment the answer is unambiguous.
   */
  readonly root: string;
  /** Project name, from `package.json` where present, otherwise the directory name. */
  readonly name: string;
  readonly framework: Framework;
  readonly installation: FrameworkInstallation;
  readonly paths: ProjectPaths;
  /** Absent when the directory has no `package.json`, which is legal for a bare project. */
  readonly packageMetadata?: PackageMetadata;
  /** Absent when no lockfile or declaration was found. Not an error: a project may have neither. */
  readonly packageManager?: PackageManagerInfo;
}
