/**
 * Discovering and describing the project a command is working on.
 *
 * A pure function of its inputs and the filesystem: no module-level cache, no global context, and no
 * mutation of the process working directory. The result is a value, passed explicitly to whatever needs it
 * — which is what makes it testable and what keeps two concurrent discoveries from interfering.
 *
 * ## What this file no longer does
 *
 * It reads no `package.json` and no `node_modules` manifest. Package metadata, dependency declarations and
 * installed-package resolution all live in `./package-discovery/`, because they are questions about what a
 * project depends on rather than about which directory it is. Splitting them is what lets declaration and
 * installation stay two facts: a package can be declared and not installed, installed and not declared, or
 * neither, and this file has to report all three differently.
 *
 * ## What is deliberately not done
 *
 * The framework configuration is **not executed or parsed**. A Cypress config is executable code, and
 * evaluating it during discovery would mean running the user's program before deciding anything about it.
 * Paths are therefore the conventional defaults, adjusted by which conventional directories exist.
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
  SPEC_DIRECTORIES,
  SUPPORT_FILES,
  type ProjectDiscoveryOptions,
} from "./contracts.js";
import {
  discoverPackages,
  type PackageDiscovery,
} from "./package-discovery/index.js";

/** First candidate that exists as a file, relative to `root`. */
async function firstExistingFile(
  root: string,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await isFile(join(root, candidate))) return candidate;
  }

  return undefined;
}

/** First candidate that exists as a directory, relative to `root`. */
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
 * Whether a directory contains something that identifies it as a project root.
 *
 * Existence only, never content: a `package.json` that fails to parse is still a marker, and reporting it as
 * "not a project" would send the reader looking for the wrong problem. The parse happens later, where it can
 * produce a message about JSON.
 */
async function isProjectRoot(directory: string): Promise<boolean> {
  if (await isFile(join(directory, "package.json"))) return true;

  return (
    (await firstExistingFile(directory, CYPRESS_CONFIG_FILES)) !== undefined
  );
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
 * Discovers the project a command is working on.
 *
 * The order of the checks is deliberate, and two of them are worth knowing about:
 *
 *   1. **The manifest is read before the configuration is looked for.** A malformed manifest makes the project
 *      undescribable, and asking the reader to create a configuration file first would only postpone the real
 *      error by one round trip.
 *   2. **Ambiguity is reported before absence.** A project with two configurations is a different mistake from
 *      one with none, and only the first is about to get worse if it is ignored.
 *
 * @throws {InvalidArgumentError} when the requested directory does not exist or is a file. Ordinarily the
 *   caller has already resolved and validated it; this check stays because discovery is reachable directly and
 *   defence in depth costs one comparison.
 * @throws {FilesystemError} `QAT5004` when the manifest exists and is not valid JSON.
 * @throws {InvalidProjectError} when no project root is found, more than one framework configuration exists,
 *   or no configuration exists at the root.
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

  // One call, two independent answers, and it comes first because the failure below needs one of them: a
  // workspace root with no configuration is a different mistake from a plain directory with none, and only the
  // manifest can tell them apart. The install lookup this also performs is bounded and cheap.
  const packages = await discoverPackages(root, {
    packageName: Framework.Cypress,
    maxDepth: DEFAULT_MAX_PARENT_DEPTH,
  });

  const configFiles: string[] = [];

  for (const candidate of CYPRESS_CONFIG_FILES) {
    if (await isFile(join(root, candidate))) configFiles.push(candidate);
  }

  if (configFiles.length > 1) {
    throw new InvalidProjectError(
      ErrorCode.projectAmbiguous,
      `More than one Cypress configuration was found in ${root}.`,
      {
        context: { root, configFiles: configFiles.join(", ") },
        remediation: "Keep one configuration file and delete the others.",
      },
    );
  }

  const configFile = configFiles[0];

  if (configFile === undefined) {
    throw new InvalidProjectError(
      ErrorCode.frameworkNotDetected,
      `No Cypress configuration was found in ${root}.`,
      {
        context: { root },
        remediation: configurationRemediation(packages.manifest?.workspaces),
      },
    );
  }

  const installation = packages.installation;

  if (installation === undefined) {
    throw missingDependencyError(packages, root, configFile);
  }

  const manifest = packages.manifest;

  // Metadata is only reported when both identifying fields are present. A partially described package is worse
  // than an absent one, because downstream code would print `undefined`.
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
    configFile,
    specsDirectory:
      (await firstExistingDirectory(root, SPEC_DIRECTORIES)) ?? "cypress/e2e",
    ...optionalPath(
      "supportFile",
      await firstExistingFile(root, SUPPORT_FILES),
    ),
    ...optionalPath(
      "screenshotsDirectory",
      (await isDirectory(join(root, "cypress/screenshots")))
        ? "cypress/screenshots"
        : undefined,
    ),
    ...optionalPath(
      "videosDirectory",
      (await isDirectory(join(root, "cypress/videos")))
        ? "cypress/videos"
        : undefined,
    ),
    ...optionalPath(
      "sourceDirectory",
      await firstExistingDirectory(root, SOURCE_DIRECTORIES),
    ),
  };

  return {
    root,
    name: metadata?.name ?? basename(root),
    framework: Framework.Cypress,
    // Assembled from the installed package rather than looked up here, so the version and its provenance come
    // from one place.
    installation: {
      framework: Framework.Cypress,
      version: installation.version,
      source: installation.source,
    },
    // Absent, not `undefined`, when the manifest does not declare the framework — a hoisted workspace install
    // is the ordinary case rather than a missing value to be repaired.
    ...(packages.declaration === undefined
      ? {}
      : { frameworkDeclaration: packages.declaration }),
    paths,
    ...(metadata === undefined ? {} : { packageMetadata: metadata }),
    ...(manager === undefined ? {} : { packageManager: manager }),
  };
}

/**
 * What to suggest when there is no configuration at the root.
 *
 * A declared workspace changes the advice entirely: the reader is almost certainly one directory too high, and
 * telling them to create a configuration file would create a second project instead of finding the first.
 * Patterns are named but never expanded — expanding them would mean choosing a package on the reader's behalf,
 * which is the recursive discovery this module deliberately does not do.
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
 * The failure for a configured framework that cannot be run.
 *
 * Two shapes, because they have two fixes. Declared but not installed is one install command; not declared and
 * not installed usually means the project is not the one the reader meant, and telling them to install
 * something would be advice about the wrong repository.
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
 * `exactOptionalPropertyTypes` distinguishes an absent property from one set to `undefined`, and a context
 * that carries absent fields explicitly would serialise them as `null`.
 */
function optionalPath<Key extends keyof ProjectPaths>(
  key: Key,
  value: ProjectPaths[Key] | undefined,
): Partial<Pick<ProjectPaths, Key>> {
  return (value === undefined ? {} : { [key]: value }) as Partial<
    Pick<ProjectPaths, Key>
  >;
}
