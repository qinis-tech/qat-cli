/**
 * Project-local resolution of the Cypress package.
 *
 * This module establishes exactly one of the six Cypress facts — *is the declared
 * package actually installed?* — and it establishes it the only way that gives a
 * trustworthy answer: by resolving the package **from the project root**, using
 * Node's own resolution algorithm, and then proving that what came back really
 * belongs to this project.
 *
 * Two failure modes make this file necessary rather than a one-line `require.resolve`:
 *
 *  1. **False health.** If QAT resolved Cypress from its own installation, or from
 *     the first `cypress` on `PATH`, every broken project on a machine that happens
 *     to have Cypress installed would report as healthy. That is the worst possible
 *     diagnostic outcome: a green result that hides a broken build.
 *  2. **Executing project code.** Cypress's package entry point does real work on
 *     load. A health check must not import it. This module resolves the *path* to
 *     `cypress/package.json` and reads that file as data — nothing is imported,
 *     evaluated or executed.
 *
 * What "project-local" means here, precisely:
 *
 *  • resolution is anchored at `<projectRoot>/package.json`, so the search starts in
 *    the project and walks up exactly as Node and npm/pnpm/yarn do;
 *  • the resolved location is accepted when it is inside the project root (covers
 *    plain installs and pnpm's in-project `.pnpm` store after realpath);
 *  • it is also accepted when it sits in an **ancestor's `node_modules`**, which is
 *    what workspace hoisting looks like and must not be reported as "missing";
 *  • it is rejected when it points into QAT's own installation (self-resolution), or
 *    anywhere else — a sibling directory, a global prefix, a stray cache.
 *
 * Rejections are returned, never thrown. "Not installed" is an expected answer that
 * the diagnostic exists to report, not an error condition to propagate.
 */

import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type {
  CypressResolution,
  CypressResolutionFailure,
} from "./contracts.js";
import { CYPRESS_PACKAGE_NAME } from "./declaration.js";

/** The specifier resolved to locate the package manifest. */
const MANIFEST_SPECIFIER = `${CYPRESS_PACKAGE_NAME}/package.json`;

/** Basename of the manifest we read inside the resolved package directory. */
const MANIFEST_BASENAME = "package.json";

/**
 * Upper bound on the manifest we will parse.
 *
 * A package manifest is a few kilobytes. A multi-megabyte "manifest" is either a
 * mistake or an attempt to make a health check allocate unbounded memory, and neither
 * deserves to be parsed. The check is on characters rather than bytes, which is close
 * enough for a guard whose job is to stop pathological input, not to measure it
 * precisely.
 */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * Depth guard for the ancestor walk. Deep paths exist; pathological paths that never
 * terminate should not hang a diagnostic.
 */
const MAX_ANCESTOR_DEPTH = 32;

/* -------------------------------------------------------------------------- */
/* Injectable boundaries                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The filesystem operations resolution needs, and nothing more.
 *
 * Narrowed to two calls deliberately: a smaller port is easier to fake in tests,
 * easier to reason about for security review ("this module cannot write"), and
 * impossible to extend accidentally into something that mutates the project.
 * `realpath` is part of the port precisely because containment must be judged on real
 * paths, not on strings a symlink can dress up.
 */
export interface ResolutionFileSystem {
  readonly realpath: (target: string) => Promise<string>;
  readonly readFile: (target: string, encoding: "utf8") => Promise<string>;
}

/**
 * Node's module resolution, injected so tests can drive resolution outcomes without
 * building a real `node_modules` tree.
 *
 * The default implementation uses `createRequire`, which runs Node's genuine
 * algorithm — hoisting, pnpm's symlinked store, workspaces — without loading the
 * resolved module.
 */
export type ModulePathResolver = (
  anchorFile: string,
  specifier: string,
) => string | undefined;

const defaultFileSystem: ResolutionFileSystem = {
  realpath: (target) => realpath(target),
  readFile: (target, encoding) => readFile(target, encoding),
};

/**
 * Resolves `<anchorFile>`-relative module paths with Node's real algorithm.
 *
 * The anchor matters: `createRequire(anchor)` searches from the *anchor's* directory
 * upwards. Anchoring at `<projectRoot>/package.json` is what makes the result
 * project-local; anchoring at QAT's own file would resolve QAT's dependencies and
 * silently declare every project healthy.
 */
const defaultModuleResolver: ModulePathResolver = (anchorFile, specifier) => {
  try {
    return createRequire(anchorFile).resolve(specifier);
  } catch {
    // A resolution miss is an expected outcome, not an exception to escalate.
    return undefined;
  }
};

/* -------------------------------------------------------------------------- */
/* Public shapes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The contract result, plus the one detail the contract cannot carry.
 *
 * `hoistedFrom` records the ancestor whose `node_modules` provided the package, or
 * `null` when it came from the project itself. It widens `CypressResolution`
 * structurally, so it can be consumed as either — the port contract stays small while
 * evidence stays informative.
 */
export interface CypressResolutionDetail extends CypressResolution {
  readonly hoistedFrom: string | null;
}

export interface ResolveCypressPackageOptions {
  readonly projectRoot: string;
  /**
   * Absolute root of QAT's own installation.
   *
   * Supplied by the composition root, which already knows where QAT is installed for
   * version reporting. When omitted the explicit self-resolution guard is skipped,
   * but the ancestor-walk guard still applies — QAT's installation is normally
   * nowhere near the project's ancestor chain.
   */
  readonly ownInstallationRoot?: string;
  readonly fileSystem?: ResolutionFileSystem;
  readonly resolveModule?: ModulePathResolver;
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the Cypress package belonging to one project.
 *
 * Order of judgement is fixed and matters:
 *   1. resolve the manifest path from the project root;
 *   2. realpath it, so symlinks cannot disguise the true location;
 *   3. reject anything inside QAT's own installation — checked *before* the ancestor
 *      rule, because safety must win over convenience;
 *   4. accept when inside the project root, or inside an ancestor `node_modules`;
 *   5. read the manifest as data and extract the version.
 *
 * Every rejection carries a distinct failure reason so the diagnostic can give a
 * specific correction instead of a generic "Cypress missing".
 */
export async function resolveCypressPackage(
  options: ResolveCypressPackageOptions,
): Promise<CypressResolutionDetail> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const resolveModule = options.resolveModule ?? defaultModuleResolver;

  const projectRoot = path.resolve(options.projectRoot);
  const anchorFile = path.join(projectRoot, MANIFEST_BASENAME);

  const manifestPath = resolveModule(anchorFile, MANIFEST_SPECIFIER);
  if (manifestPath === undefined) {
    return notInstalled("not-resolvable");
  }

  const packageDirectory = path.dirname(manifestPath);

  const realPackageDirectory = await realpathOrUndefined(
    fileSystem,
    packageDirectory,
  );
  if (realPackageDirectory === undefined) {
    // Resolution succeeded on paper but the directory is gone (a concurrent install,
    // a pruned store, a broken symlink). From the project's point of view the package
    // is simply not usable.
    return notInstalled("not-resolvable");
  }

  const realProjectRoot =
    (await realpathOrUndefined(fileSystem, projectRoot)) ?? projectRoot;

  if (options.ownInstallationRoot !== undefined) {
    const realOwnRoot =
      (await realpathOrUndefined(fileSystem, options.ownInstallationRoot)) ??
      options.ownInstallationRoot;

    if (isWithin(realPackageDirectory, realOwnRoot)) {
      // Belt and braces. Anchoring already prevents this in practice, but a project
      // nested inside QAT's own directory must never inherit QAT's Cypress and call
      // itself healthy.
      return notInstalled("rejected-outside-project");
    }
  }

  const hoisting = locateHoistingLocation(
    realPackageDirectory,
    realProjectRoot,
  );
  if (hoisting.origin === "outside") {
    return notInstalled("rejected-outside-project");
  }

  const manifest = await readManifest(
    fileSystem,
    path.join(realPackageDirectory, MANIFEST_BASENAME),
  );
  if (manifest === undefined) {
    // The directory exists but its manifest is unreadable or not a manifest. An
    // install command repairs this; an upgrade does not — hence a distinct reason
    // from "not resolvable at all".
    return notInstalled("unreadable-package-manifest", realPackageDirectory);
  }

  // Annotated before freezing so every literal is contextually typed by the contract;
  // findings are shared with the report, the JSON export and the history store, so
  // immutability must not be optional.
  const resolved: CypressResolutionDetail = {
    outcome: "resolved",
    packageDirectory: realPackageDirectory,
    // `null` rather than a throw: a readable package with no usable version is a real
    // state, and the compatibility check reports it as "version unknown" rather than
    // inventing one.
    version: readVersion(manifest),
    failure: null,
    hoistedFrom: hoisting.origin === "ancestor" ? hoisting.ancestor : null,
  };

  return Object.freeze(resolved);
}

/**
 * Reads the Cypress manifest as data.
 *
 * Returns `undefined` when the file cannot be read, is unreasonably large, is not
 * valid JSON, or is not a keyed object. All four are "this installation is not
 * usable", and none of them should crash a diagnostic.
 *
 * Note what is *not* done here: the package is never imported. Importing Cypress
 * executes project-controlled code, which a health check has no business doing.
 */
async function readManifest(
  fileSystem: ResolutionFileSystem,
  manifestPath: string,
): Promise<Record<string, unknown> | undefined> {
  let contents: string;

  try {
    contents = await fileSystem.readFile(manifestPath, "utf8");
  } catch {
    return undefined;
  }

  if (contents.length > MAX_MANIFEST_BYTES) return undefined;

  let parsed: unknown;

  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }

  return isRecord(parsed) ? parsed : undefined;
}

/**
 * Extracts a usable version string.
 *
 * Cypress always ships a version, so an unusable one is anomalous — but reporting
 * "unknown version" is honest, whereas guessing `0.0.0` would produce the confidently
 * wrong message "Cypress 0.0.0 is not supported".
 */
function readVersion(manifest: Record<string, unknown>): string | null {
  const version = manifest["version"];
  if (typeof version !== "string") return null;

  const trimmed = version.trim();
  return trimmed === "" ? null : trimmed;
}

/* -------------------------------------------------------------------------- */
/* Containment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Where the package was found, relative to the project.
 *
 * Modelled as a discriminated union rather than `string | null | 'outside'`. That
 * earlier shape is exactly the kind of union the compiler rejects — a string literal
 * inside a `string` union is overridden by it and carries no type information — and
 * the sentinel also read as a magic value at the call site. Three named cases make
 * every branch exhaustive and self-explaining.
 */
type HoistingLocation =
  | { readonly origin: "project" }
  | { readonly origin: "ancestor"; readonly ancestor: string }
  | { readonly origin: "outside" };

/**
 * Classifies where a resolved package lives.
 *
 * Walking ancestors is deliberate: Node's algorithm checks `<root>/node_modules`, then
 * `<root>/../node_modules`, and so on, so a workspace-hoisted Cypress genuinely
 * belongs to the project. Anything not on that chain — a sibling directory, a global
 * prefix, a stray cache — is not this project's Cypress and is rejected.
 */
function locateHoistingLocation(
  packageDirectory: string,
  projectRoot: string,
): HoistingLocation {
  if (isWithin(packageDirectory, projectRoot)) return { origin: "project" };

  let current = projectRoot;

  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const parent = path.dirname(current);

    // Reached the filesystem root without finding the package: it is not part of this
    // project's workspace.
    if (parent === current) return { origin: "outside" };

    if (isWithin(packageDirectory, path.join(parent, "node_modules"))) {
      return { origin: "ancestor", ancestor: parent };
    }

    current = parent;
  }

  return { origin: "outside" };
}

/**
 * True when `child` is `parent` or lives beneath it.
 *
 * Compares real paths, and compares case-insensitively on Windows where the same
 * directory can arrive spelled two ways through different environment sources. Uses
 * `path.relative` rather than string prefixes, so `/app-evil` is not treated as living
 * inside `/app`.
 *
 * The platform is a parameter with a default so the Windows branch is testable on any
 * runner, instead of only on the machine that happens to be Windows.
 */
export function isWithin(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalise = (value: string): string => {
    const resolved = path.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };

  const relative = path.relative(normalise(parent), normalise(child));

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Narrows an unknown value to a plain keyed object.
 *
 * Arrays are excluded: `typeof [] === 'object'` is true, but a package manifest is
 * never an array, so an array here means the file is not a manifest at all. A
 * predicate is used rather than an assertion because `object` carries no index
 * signature, so widening it to `Record<string, unknown>` is not a legal cast.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* -------------------------------------------------------------------------- */
/* Factories                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Builds the port the collector and checks depend on.
 *
 * The factory exists so the composition root decides *once* what "QAT's own
 * installation" means and which filesystem/resolver to use, rather than every call
 * site re-deriving it — the usual way two components end up with two different
 * definitions of the same safety boundary.
 */
export function createNodeCypressResolver(
  options: Omit<ResolveCypressPackageOptions, "projectRoot"> = {},
): {
  readonly resolve: (projectRoot: string) => Promise<CypressResolutionDetail>;
} {
  return {
    resolve: (projectRoot) =>
      resolveCypressPackage({ ...options, projectRoot }),
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

async function realpathOrUndefined(
  fileSystem: ResolutionFileSystem,
  target: string,
): Promise<string | undefined> {
  try {
    return await fileSystem.realpath(target);
  } catch {
    return undefined;
  }
}

/** Builds the frozen "not installed" result, so evidence shape never varies. */
function notInstalled(
  failure: CypressResolutionFailure,
  packageDirectory: string | null = null,
): CypressResolutionDetail {
  const result: CypressResolutionDetail = {
    outcome: "not-installed",
    packageDirectory,
    version: null,
    failure,
    hoistedFrom: null,
  };

  return Object.freeze(result);
}
