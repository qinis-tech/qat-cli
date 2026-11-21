/**
 * Discovering and describing the project a command is working on.
 *
 * A pure function of its inputs and the filesystem: no module-level cache, no global context, and
 * no mutation of the process working directory. The result is a value, passed explicitly to
 * whatever needs it — which is what makes it testable and what keeps two concurrent discoveries
 * from interfering.
 *
 * ## What is deliberately not done
 *
 * The framework configuration is **not executed or parsed**. A Cypress config is executable code,
 * and evaluating it during discovery would mean running the user's program before deciding anything
 * about it. Paths are therefore the conventional defaults, adjusted by which conventional
 * directories exist. See the decision record.
 */
import { basename, dirname, join, resolve } from "node:path";

import {
  Framework,
  InstallationSource,
  PackageManager,
  type FrameworkInstallation,
  type PackageManagerInfo,
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
import { isDirectory, isFile, readJson } from "../core/filesystem/index.js";

import {
  CYPRESS_CONFIG_FILES,
  DEFAULT_MAX_PARENT_DEPTH,
  LOCKFILES,
  SOURCE_DIRECTORIES,
  SPEC_DIRECTORIES,
  SUPPORT_FILES,
  type ProjectDiscoveryOptions,
} from "./contracts.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

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

/** Whether a directory contains something that identifies it as a project root. */
async function isProjectRoot(directory: string): Promise<boolean> {
  if (await isFile(join(directory, "package.json"))) return true;

  return (
    (await firstExistingFile(directory, CYPRESS_CONFIG_FILES)) !== undefined
  );
}

/** Ascends from `start` looking for a project root, bounded by the configured depth. */
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

interface PackageInspection {
  readonly metadata: PackageMetadata | undefined;
  readonly manager: PackageManagerInfo | undefined;
}

/** Reads `package.json` when present, narrowing every field rather than trusting the file. */
async function inspectPackage(root: string): Promise<PackageInspection> {
  const packagePath = join(root, "package.json");

  if (!(await isFile(packagePath)))
    return { metadata: undefined, manager: undefined };

  const record = asRecord(await readJson<unknown>(packagePath));

  const name =
    typeof record?.["name"] === "string" ? record["name"] : undefined;
  const version =
    typeof record?.["version"] === "string" ? record["version"] : undefined;

  // Metadata is only reported when both identifying fields are present. A partially described
  // package is worse than an absent one, because downstream code would print "undefined".
  const metadata =
    name === undefined || version === undefined
      ? undefined
      : { name, version, private: record?.["private"] === true };

  return { metadata, manager: await detectPackageManager(root, record) };
}

/** Prefers an explicit declaration, then the lockfile order in `LOCKFILES`. */
async function detectPackageManager(
  root: string,
  record: Record<string, unknown> | undefined,
): Promise<PackageManagerInfo | undefined> {
  const declared = record?.["packageManager"];

  if (typeof declared === "string") {
    // `name@version`; the name may itself be scoped, so split from the right.
    const separator = declared.lastIndexOf("@");
    const name = separator > 0 ? declared.slice(0, separator) : declared;

    if (isKnownPackageManager(name)) return { name, declared: true };
  }

  for (const { file, manager } of LOCKFILES) {
    if (!(await isFile(join(root, file)))) continue;
    if (isKnownPackageManager(manager))
      return { name: manager, declared: false, lockfile: file };
  }

  return undefined;
}

function isKnownPackageManager(value: string): value is PackageManager {
  return (Object.values(PackageManager) as readonly string[]).includes(value);
}

/**
 * Locates the framework installation, checking the project first and then ancestors.
 *
 * The ancestor search is independent of `searchParents`: a monorepo installing dependencies at its
 * root is the ordinary case, not an unusual one, and refusing to look would report a dependency
 * missing that is present two directories up.
 */
async function findInstallation(
  root: string,
  maxDepth: number,
): Promise<FrameworkInstallation | undefined> {
  let current: string = root;

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const manifest = join(current, "node_modules", "cypress", "package.json");

    if (await isFile(manifest)) {
      const record = asRecord(await readJson<unknown>(manifest));
      const version =
        typeof record?.["version"] === "string" ? record["version"] : undefined;

      if (version !== undefined) {
        return {
          framework: Framework.Cypress,
          version,
          source:
            current === root
              ? InstallationSource.Project
              : InstallationSource.Workspace,
        };
      }
    }

    const parent = dirname(current);
    if (parent === current) break;

    current = parent;
  }

  return undefined;
}

/**
 * Discovers the project a command is working on.
 *
 * @throws {InvalidArgumentError} when the requested directory does not exist.
 * @throws {InvalidProjectError} when no project root is found, or when more than one framework
 *   configuration exists.
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

  const configFiles: string[] = [];

  for (const candidate of CYPRESS_CONFIG_FILES) {
    if (await isFile(join(root, candidate))) configFiles.push(candidate);
  }

  // Ambiguity is reported before absence, because a project with two configurations is a different
  // mistake from one with none, and only the first is about to get worse if it is ignored.
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
        remediation:
          "Create cypress.config.ts, or run this in the right directory.",
      },
    );
  }

  const installation = await findInstallation(root, DEFAULT_MAX_PARENT_DEPTH);

  if (installation === undefined) {
    throw new MissingDependencyError(
      ErrorCode.dependencyMissing,
      `Cypress is not installed for ${root}.`,
      {
        context: { root, configFile },
        remediation: "Install it with the package manager this project uses.",
      },
    );
  }

  const { metadata, manager } = await inspectPackage(root);

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
    installation,
    paths,
    ...(metadata === undefined ? {} : { packageMetadata: metadata }),
    ...(manager === undefined ? {} : { packageManager: manager }),
  };
}

/**
 * Spreads an optional path field only when it has a value.
 *
 * `exactOptionalPropertyTypes` distinguishes an absent property from one set to `undefined`, and a
 * context that carries absent fields explicitly would serialise them as `null`.
 */
function optionalPath<Key extends keyof ProjectPaths>(
  key: Key,
  value: ProjectPaths[Key] | undefined,
): Partial<Pick<ProjectPaths, Key>> {
  return (value === undefined ? {} : { [key]: value }) as Partial<
    Pick<ProjectPaths, Key>
  >;
}
