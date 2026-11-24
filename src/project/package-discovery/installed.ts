/**
 * Whether a package is installed, and where from.
 *
 * The search climbs independently of whether parent traversal was requested for the *project root*. A workspace that
 * hoists dependencies to its root is the ordinary case rather than an unusual one, and refusing to look would report a
 * present dependency as missing. The two questions have opposite sensible defaults: climbing to find a project surprises
 * people; climbing to find an install does not.
 *
 * ## This module never throws
 *
 * A copy of the package that cannot be used is reported as not installed. That includes a manifest with no version and a
 * manifest that is not valid JSON — the same conclusion for the same reason, because both mean this copy cannot be
 * relied on and both are one reinstall away.
 *
 * The *project's* manifest is the one whose parse failure is a fault, and it is read by a different module which raises
 * it. The distinction is worth holding on to: a project whose own description cannot be read is undescribable, while a
 * package on disk whose only job is to supply a version string is simply a package that needs installing again.
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
   * Diagnostic only, and never persisted: the project description it feeds carries no path at all. It is absolute
   * because the copy may live above the project root, where a relative path would read `../..` and be useless in a
   * message.
   */
  readonly manifestPath: string;
}

/**
 * @param root Where to start looking, normally the project root.
 * @param packageName The npm package name.
 * @param maxDepth How far to climb. Bounds the search so a mistaken root cannot walk to the filesystem root.
 * @returns `undefined` when the package is not installed anywhere within the bound, **or** when the nearest copy it
 *   found cannot be used. The two are indistinguishable on purpose: the remedy is the same, and a caller that needs to
 *   tell them apart is a caller that needs a different question answered.
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

      // The nearest copy wins, even when it is unusable. Climbing past it would report a version from a different copy
      // of the same package — confidently, and about something the runtime will not load. This mirrors Node's own
      // resolution, which stops at the first candidate it finds.
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
 * The version an installed package declares, or `undefined` when its manifest is unusable.
 *
 * ## Two ways to be unusable, handled identically
 *
 * No version, and no readable JSON. Every consumer either compares or displays that string, so reporting `''` would be a
 * worse answer than none — and the interface says `version: string`, which would then be a lie.
 *
 * ## Why the read failure does not propagate
 *
 * Before this, an unparseable installed manifest reached the diagnosis as an unreadable **project** manifest:
 * `packageMetadata: 'unreadable'` about a `package.json` that had just been read successfully. That is a report blaming
 * the wrong file, and it sends a reader to inspect something that is fine.
 *
 * The finding a reader now gets is "declared but not installed", whose remedy — install it again — is exactly right for a
 * corrupt download or a half-written directory left by an interrupted install.
 *
 * ## What the broad catch means
 *
 * It catches every failure to read the file, not only invalid JSON: a permission problem, a truncated file, an I/O
 * error. All of them mean this copy cannot be relied on, and the remedy is the same for all of them. The trigger to
 * narrow it is the first diagnostic that has to tell a corrupt install from one it cannot read — that consumer adds the
 * distinction, rather than this function guessing which failures matter.
 */
async function readInstalledVersion(
  manifestPath: string,
): Promise<string | undefined> {
  const record = asRecord(
    await readJson<unknown>(manifestPath).catch(() => undefined),
  );
  const raw: unknown = record?.["version"];

  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
