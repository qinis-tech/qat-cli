/**
 * Whether a package is installed, and where from.
 *
 * The search climbs independently of whether parent traversal was requested for the *project root*. A
 * workspace that hoists dependencies to its root is the ordinary case rather than an unusual one, and
 * refusing to look would report a present dependency as missing. The two questions have opposite sensible
 * defaults: climbing to find a project surprises people; climbing to find an install does not.
 */
import { dirname, join } from "node:path";

import { InstallationSource } from "../../core/domain/index.js";
import { isFile, readJson } from "../../core/filesystem/index.js";

import { asRecord } from "./record.js";

export interface InstalledPackage {
  readonly name: string;
  readonly version: string;
  /** `project` when found at the root, `workspace` when found above it. */
  readonly source: InstallationSource;
  /**
   * Absolute path to the installed manifest.
   *
   * Diagnostic only, and never persisted: the project description it feeds carries no path at all. It is
   * absolute because the copy may live above the project root, where a relative path would read `../..`
   * and be useless in a message.
   */
  readonly manifestPath: string;
}

/**
 * @param root Where to start looking, normally the project root.
 * @param packageName The npm package name.
 * @param maxDepth How far to climb. Bounds the search so a mistaken root cannot walk to the filesystem root.
 * @returns `undefined` when the package is not installed anywhere within the bound.
 * @throws {FilesystemError} `QAT5004` when the nearest installed manifest exists and is not valid JSON.
 */
export async function findInstalledPackage(
  root: string,
  packageName: string,
  maxDepth: number,
): Promise<InstalledPackage | undefined> {
  let current: string = root;

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const manifestPath = join(
      current,
      "node_modules",
      packageName,
      "package.json",
    );

    if (await isFile(manifestPath)) {
      const version = await readInstalledVersion(manifestPath);

      // The nearest copy wins, even when it is unusable. Climbing past it would report a version from a
      // different copy of the same package — confidently, and about something the runtime will not load.
      // This mirrors Node's own resolution, which stops at the first candidate it finds.
      if (version === undefined) return undefined;

      return {
        name: packageName,
        version,
        source:
          current === root
            ? InstallationSource.Project
            : InstallationSource.Workspace,
        manifestPath,
      };
    }

    const parent = dirname(current);
    // `dirname` of a filesystem root is itself, which is the signal to stop rather than climb forever.
    if (parent === current) break;

    current = parent;
  }

  return undefined;
}

/**
 * The version an installed package declares, or `undefined` when it declares something unusable.
 *
 * An installed package whose manifest has no version is treated as not installed. Every consumer either
 * compares or displays that string, so reporting `''` would be a worse answer than none — and the type says
 * `version: string`, which would then be a lie. The trigger to revisit is the first consumer that needs to
 * tell a damaged install from an absent one; that consumer adds the code, not this function.
 */
async function readInstalledVersion(
  manifestPath: string,
): Promise<string | undefined> {
  const record = asRecord(await readJson<unknown>(manifestPath));
  const raw: unknown = record?.["version"];

  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
