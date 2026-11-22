/**
 * Where the CLI's version comes from.
 *
 * ## Why not a fixed relative path
 *
 * `../../package.json` is correct only for the layout it was written against. Change `outDir`, nest
 * `rootDir`, let a bundler relocate a chunk — and the path points at a file that is not there. The
 * failure is silent until someone installs the package and runs `qat --version`, by which point the
 * evidence is on their machine rather than in a test.
 *
 * This walks upward from the module's own directory instead, bounded, so it is correct at any depth
 * inside the package: `src/cli` during development, `dist/cli` after a build, wherever a packager puts
 * it, and `node_modules/qat-cli/...` once installed.
 *
 * ## Why it reads the filesystem directly
 *
 * The CLI bootstrap may not import the project's implementation layers, and version resolution has to
 * work before anything else is known — before a project is discovered, before options are parsed. A
 * handful of lines against `node:fs` is the right amount of coupling for the one fact the program needs
 * before it can do anything at all.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ErrorCode } from "../core/errors/codes.js";
import { MissingDependencyError } from "../core/errors/errors.js";

/**
 * How far to climb.
 *
 * Six is enough for any layout this package could plausibly take — the deepest realistic case is
 * `node_modules/qat-cli/dist/cli/index.js`, which is three — and shallow enough that a mistaken start
 * directory cannot wander into an unrelated project's manifest.
 */
export const VERSION_SEARCH_DEPTH = 6;

const MANIFEST_NAME = "package.json";

/**
 * A version this tool will report.
 *
 * Deliberately loose. The job is to reject `undefined`, `""` and `"see the changelog"`, not to
 * reimplement semantic versioning — a stricter pattern would reject legitimate forms a release process
 * may well use.
 *
 * Two optional groups, not one. A version may carry a pre-release, build metadata, or both — and in that
 * order. A single `[-+]` alternation accepts either one alone and rejects `2.0.0-rc.1+build.9`, which is
 * a perfectly ordinary version and exactly the kind this comment claims to allow.
 */
const VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ResolvedVersion {
  readonly version: string;
  /** Where it was found. Carried because "which manifest?" is the first question about a wrong version. */
  readonly manifestPath: string;
}

/**
 * Resolves the version from the nearest package manifest at or above `startDirectory`.
 *
 * @throws {MissingDependencyError} when no manifest is found, or when the nearest one is unusable.
 *
 * A broken nearest manifest is an error rather than a reason to keep climbing. The nearest one belongs
 * to the package this code is part of; reporting a parent package's version instead would be worse than
 * reporting none, because it would be confidently wrong.
 */
export async function resolveVersion(
  startDirectory: string,
): Promise<ResolvedVersion> {
  let directory = startDirectory;

  for (let depth = 0; depth <= VERSION_SEARCH_DEPTH; depth += 1) {
    const manifestPath = join(directory, MANIFEST_NAME);
    const contents = await readIfPresent(manifestPath);

    if (contents !== undefined) {
      return { version: readVersion(contents, manifestPath), manifestPath };
    }

    // `dirname` of a filesystem root is itself, which is the signal to stop rather than climb forever.
    const parent = dirname(directory);
    if (parent === directory) break;

    directory = parent;
  }

  throw new MissingDependencyError(
    ErrorCode.installationIncomplete,
    `Could not find ${MANIFEST_NAME} at or above ${startDirectory}.`,
    {
      context: { start: startDirectory, searchedDepth: VERSION_SEARCH_DEPTH },
      remediation:
        "Reinstall QAT; this installation is missing its package metadata.",
    },
  );
}

/**
 * Reads a file if it exists.
 *
 * Only "not there" is treated as absence. A permission error on a candidate manifest is a real problem
 * and must not be reported as a missing version, because the two have different remedies.
 */
async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isAbsent(error)) return undefined;

    throw error;
  }
}

function isAbsent(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error))
    return false;

  // The `in` check narrows `error` to an object with a `code` property; no assertion is needed.
  const code: unknown = error.code;

  return code === "ENOENT" || code === "ENOTDIR";
}

function readVersion(contents: string, manifestPath: string): string {
  let manifest: unknown;

  try {
    manifest = JSON.parse(contents);
  } catch (error) {
    throw new MissingDependencyError(
      ErrorCode.installationIncomplete,
      `${manifestPath} is not valid JSON.`,
      {
        cause: error,
        context: { manifest: manifestPath },
        remediation:
          "Reinstall QAT; this installation has damaged package metadata.",
      },
    );
  }

  const record =
    typeof manifest === "object" && manifest !== null
      ? (manifest as Record<string, unknown>)
      : undefined;

  const version =
    typeof record?.["version"] === "string" ? record["version"] : undefined;

  if (version === undefined || !VERSION_PATTERN.test(version)) {
    throw new MissingDependencyError(
      ErrorCode.installationIncomplete,
      `${manifestPath} does not declare a usable version.`,
      {
        context: { manifest: manifestPath, declared: version ?? "absent" },
        remediation:
          "Reinstall QAT; this installation has invalid package metadata.",
      },
    );
  }

  return version;
}
