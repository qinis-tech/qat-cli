/**
 * Discovering and describing the project a command is working on.
 *
 * A pure function of its inputs and the filesystem: no module-level cache, no global context, and no mutation of
 * the process working directory. The result is a value, passed explicitly to whatever needs it — which is what
 * makes it testable and what keeps two concurrent discoveries from interfering.
 *
 * ## What this file is, now that detection exists
 *
 * It is the **validation** layer. `detectCypress` gathers evidence and says what the directory is; this file
 * decides whether that answer permits a run, turns an unfavourable one into an error with a remedy, and assembles
 * the project description from the evidence it was given.
 *
 * The split matters because the two questions have different audiences. A verdict is a diagnosis — useful to a
 * command that wants to report what it found, including that there is nothing to find. An error is a decision to
 * stop. Collapsing them would make the diagnosis impossible to obtain without catching an exception.
 *
 * ## What this file does not do
 *
 * It reads no `package.json`, no `node_modules` manifest, and no configuration filename. Package metadata lives in
 * `./package-discovery/` and configuration discovery in `./cypress-detection/`. What remains here is the shape of
 * a project rather than of a Cypress project: the source directory, the project name, and the projection of
 * evidence onto the domain's description.
 *
 * The framework configuration is **not executed or parsed**. A Cypress config is executable code, and evaluating
 * it during discovery would mean running the user's program before deciding anything about it. Paths are therefore
 * the conventional defaults, adjusted by which conventional directories exist.
 */
import { basename, dirname, join, resolve } from "node:path";

import {
  Framework,
  type PackageMetadata,
  type ProjectInfo,
  type ProjectPaths,
} from "../core/domain/index.js";
import {
  ErrorCode,
  InvalidArgumentError,
  InvalidProjectError,
  MissingDependencyError,
} from "../core/errors/index.js";
import { isDirectory, isFile } from "../core/filesystem/index.js";

import {
  CYPRESS_CONFIG_FILES,
  DEFAULT_MAX_PARENT_DEPTH,
  SOURCE_DIRECTORIES,
  type ProjectDiscoveryOptions,
} from "./contracts.js";
import {
  detectCypress,
  DetectionVerdict,
  type UndetectedProject,
} from "./cypress-detection/index.js";
import type { PackageDiscovery } from "./package-discovery/index.js";

/**
 * Whether a directory contains something that identifies it as a project root.
 *
 * Existence only, never content, and deliberately cheap: this runs once per ancestor level, so it must not read
 * anything. A `package.json` that fails to parse is still a marker — reporting it as "not a project" would send
 * the reader looking for the wrong problem, and the parse happens later, where it can produce a message about
 * JSON.
 *
 * The configuration candidates are inlined rather than delegated to the detection engine for the same reason: a
 * full detection per ancestor level would read a manifest and climb for an install at every step. The list itself
 * is shared, so the two cannot disagree about what counts as a configuration file.
 */
async function isProjectRoot(directory: string): Promise<boolean> {
  if (await isFile(join(directory, "package.json"))) return true;

  for (const candidate of CYPRESS_CONFIG_FILES) {
    if (await isFile(join(directory, candidate))) return true;
  }

  return false;
}

/**
 * Ascends from `start` looking for a project root, bounded by the configured depth.
 *
 * Off by default. A command run in the wrong place should say so rather than silently report a project three
 * levels above, and looking upward is the behaviour that makes tools surprise people.
 */
async function resolveRoot(
  start: string,
  options: ProjectDiscoveryOptions,
): Promise<string> {
  const maxDepth =
    options.searchParents === true
      ? (options.maxParentDepth ?? DEFAULT_MAX_PARENT_DEPTH)
      : 0;

  let current = start;

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (await isProjectRoot(current)) return current;

    const parent = dirname(current);
    // `dirname` of a filesystem root is itself, which is the signal to stop.
    if (parent === current) break;

    current = parent;
  }

  throw new InvalidProjectError(
    ErrorCode.projectNotFound,
    `No project found at or above ${start}.`,
    {
      context: { start, searchedDepth: maxDepth },
      remediation:
        "Run the command inside a project, or pass --cwd pointing at one.",
    },
  );
}

/**
 * First conventional source root that exists, relative to `root`.
 *
 * The one layout lookup this file still performs. A source directory is a property of the *project* rather than of
 * a Cypress project, so it does not belong in the detection evidence — which is about what makes this a test
 * project, not about what makes it a software project.
 */
async function firstExistingDirectory(
  root: string,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await isDirectory(join(root, candidate))) return candidate;
  }

  return undefined;
}

/**
 * Discovers the project a command is working on.
 *
 * The order of the checks decides what a directory that is wrong in two ways reports, and two of them matter: the
 * manifest is read before the configuration is judged, so a broken manifest is reported as itself; and ambiguity
 * is reported before absence, because a project with two configurations is the mistake that gets worse if it is
 * ignored. Both orderings live in the detection engine, which is where the evidence is gathered.
 *
 * @throws {InvalidArgumentError} when the requested directory does not exist or is a file. Ordinarily the caller
 *   has already resolved and validated it; this check stays because discovery is reachable directly and defence in
 *   depth costs one comparison.
 * @throws {FilesystemError} `QAT5004` when the manifest exists and is not valid JSON.
 * @throws {InvalidProjectError} when no project root is found (`QAT2001`), the directory is not a Cypress project
 *   (`QAT2002`), its configuration is in a format QAT cannot read (`QAT2003`), or two configurations exist
 *   (`QAT2004`).
 * @throws {MissingDependencyError} when a framework is configured but not installed.
 */
export async function discoverProject(
  options: ProjectDiscoveryOptions = {},
): Promise<ProjectInfo> {
  const start =
    options.cwd === undefined ? process.cwd() : resolve(options.cwd);

  if (!(await isDirectory(start))) {
    throw new InvalidArgumentError(
      ErrorCode.invalidArgument,
      `${start} is not a directory.`,
      {
        context: { cwd: start },
        remediation: "Pass a directory that exists.",
      },
    );
  }

  const root = await resolveRoot(start, options);

  const detection = await detectCypress(root, {
    maxDepth: DEFAULT_MAX_PARENT_DEPTH,
  });

  // The verdict is narrowed here rather than inside the engine, because whether a non-detection is fatal depends
  // on the caller. A command that only reports — `qat init`, `qat doctor` — will want the evidence; a command that
  // is about to run tests does not.
  if (detection.verdict !== DetectionVerdict.Detected) {
    throw detectionError(detection, root);
  }

  const { packages } = detection;
  const installation = packages.installation;

  // Detected and not installed is a supported project with a dependency missing: one install command, and a
  // different code from every failure above. Detection deliberately does not judge this, because identifying a
  // project and being able to run it are two questions.
  if (installation === undefined) {
    throw missingDependencyError(packages, root, detection.configuration);
  }

  const manifest = packages.manifest;

  // Metadata is only reported when both identifying fields are present. A partially described package is worse than
  // an absent one, because downstream code would print `undefined`.
  const metadata: PackageMetadata | undefined =
    manifest?.name !== undefined && manifest.version !== undefined
      ? {
          name: manifest.name,
          version: manifest.version,
          private: manifest.private,
        }
      : undefined;

  const manager = manifest?.packageManager;

  const paths: ProjectPaths = {
    configFile: detection.configuration,
    // The layout keeps every conventional candidate because it is evidence; this is the choice, made once, in the
    // one place that assembles a description. The order is the candidate order, so the answer matches what a
    // first-match scan would have produced.
    specsDirectory: detection.layout.specDirectories[0] ?? "cypress/e2e",
    ...optionalPath("supportFile", detection.layout.supportFiles[0]),
    ...optionalPath(
      "screenshotsDirectory",
      detection.layout.screenshotsDirectory,
    ),
    ...optionalPath("videosDirectory", detection.layout.videosDirectory),
    ...optionalPath(
      "sourceDirectory",
      await firstExistingDirectory(root, SOURCE_DIRECTORIES),
    ),
  };

  return {
    root,
    name: metadata?.name ?? basename(root),
    framework: Framework.Cypress,
    // Assembled from the installed package rather than looked up here, so the version and its provenance come from
    // one place.
    installation: {
      framework: Framework.Cypress,
      version: installation.version,
      source: installation.source,
    },
    // Absent, not `undefined`, when the manifest does not declare the framework — a hoisted workspace install is
    // the ordinary case rather than a missing value to be repaired.
    ...(packages.declaration === undefined
      ? {}
      : { frameworkDeclaration: packages.declaration }),
    paths,
    ...(metadata === undefined ? {} : { packageMetadata: metadata }),
    ...(manager === undefined ? {} : { packageManager: manager }),
  };
}

/**
 * Turns an unfavourable verdict into the error that stops the command.
 *
 * Every branch is a distinct mistake with a distinct remedy, and the mapping is exhaustive over the four undetected
 * verdicts — a fifth added to the engine becomes a compile error here rather than a case nobody handled.
 */
function detectionError(
  detection: UndetectedProject,
  root: string,
): InvalidProjectError {
  const remediation = configurationRemediation(
    detection.packages.manifest?.workspaces,
  );

  switch (detection.verdict) {
    case DetectionVerdict.Ambiguous:
      return new InvalidProjectError(
        ErrorCode.projectAmbiguous,
        `More than one Cypress configuration was found in ${root}.`,
        {
          context: { root, configFiles: detection.configurations.join(", ") },
          remediation: "Keep one configuration file and delete the others.",
        },
      );

    case DetectionVerdict.Unsupported:
      return new InvalidProjectError(
        ErrorCode.frameworkUnsupported,
        `${root} uses ${detection.unsupportedConfigurations.join(", ")}, which QAT cannot read.`,
        {
          context: {
            root,
            unsupportedConfigurations:
              detection.unsupportedConfigurations.join(", "),
          },
          remediation:
            "Upgrade to cypress.config.ts, which Cypress 10 and later use.",
        },
      );

    case DetectionVerdict.Incomplete:
      return new InvalidProjectError(
        ErrorCode.frameworkNotDetected,
        incompleteMessage(detection, root),
        {
          context: { root },
          remediation,
        },
      );

    case DetectionVerdict.Absent:
      return new InvalidProjectError(
        ErrorCode.frameworkNotDetected,
        `No Cypress configuration was found in ${root}.`,
        { context: { root }, remediation },
      );
  }
}

/**
 * Why a Cypress-evidenced directory has no configuration.
 *
 * Three causes, named separately because they have three different next steps: an installed copy with no
 * configuration is one file to create, a declared dependency is the same file plus an install, and a bare
 * `cypress/` directory is usually a configuration that was deleted.
 */
function incompleteMessage(detection: UndetectedProject, root: string): string {
  const { declaration, installation } = detection.packages;

  if (installation !== undefined) {
    return `Cypress ${installation.version} is installed in ${root}, but no configuration file was found.`;
  }

  if (declaration !== undefined) {
    return `Cypress is declared in ${declaration.section}, but no configuration file was found in ${root}.`;
  }

  return `A cypress directory was found in ${root}, but no configuration file.`;
}

/**
 * What to suggest when there is no usable configuration.
 *
 * A declared workspace changes the advice entirely: the reader is almost certainly one directory too high, and
 * telling them to create a configuration file would create a second project instead of finding the first. Patterns
 * are named but never expanded — expanding them would mean choosing a package on the reader's behalf, which is the
 * recursive discovery this module deliberately does not do.
 */
function configurationRemediation(
  workspaces: readonly string[] | undefined,
): string {
  if (workspaces === undefined || workspaces.length === 0) {
    return "Create cypress.config.ts, or run this in the right directory.";
  }

  return `This looks like a workspace root (${workspaces.join(", ")}). Run the command from the package directory.`;
}

/**
 * The failure for a detected project with no installed framework.
 *
 * Two shapes, because they have two fixes. Declared but not installed is one install command; detected with no
 * declaration at all is a hoisted or global install that has gone missing.
 */
function missingDependencyError(
  packages: PackageDiscovery,
  root: string,
  configFile: string,
): MissingDependencyError {
  const { declaration } = packages;

  const message =
    declaration === undefined
      ? `No Cypress dependency is declared in ${root}, and Cypress is not installed.`
      : `Cypress is declared in ${declaration.section} but is not installed.`;

  return new MissingDependencyError(ErrorCode.dependencyMissing, message, {
    context: {
      root,
      configFile,
      ...(declaration === undefined
        ? {}
        : {
            declaredIn: declaration.section,
            declaredRange: declaration.range,
          }),
    },
    remediation: "Install it with the package manager this project uses.",
  });
}

/**
 * Spreads an optional path field only when it has a value.
 *
 * `exactOptionalPropertyTypes` distinguishes an absent property from one set to `undefined`, and a context that
 * carries absent fields explicitly would serialise them as `null`.
 */
function optionalPath<Key extends keyof ProjectPaths>(
  key: Key,
  value: ProjectPaths[Key] | undefined,
): Partial<Pick<ProjectPaths, Key>> {
  return (value === undefined ? {} : { [key]: value }) as Partial<
    Pick<ProjectPaths, Key>
  >;
}
