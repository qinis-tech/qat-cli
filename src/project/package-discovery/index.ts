/**
 * What the project's package metadata says, as two independent facts.
 *
 * Declaration and installation are reported separately and neither implies the other. A package can be
 * declared and not installed, installed and not declared — hoisted from a workspace, or installed globally
 * — or both absent. Collapsing them loses the distinction that decides which message a reader needs, and
 * that collapsing is what the code this module replaces did.
 */
import type { FrameworkDeclaration } from "../../core/domain/index.js";

import { findDeclaration } from "./dependencies.js";
import { findInstalledPackage, type InstalledPackage } from "./installed.js";
import { readManifest, type ProjectManifest } from "./manifest.js";

export type { InstalledPackage, ProjectManifest };
export { findDeclaration, findInstalledPackage, readManifest };

export interface PackageDiscovery {
  /** Absent when the project has no manifest, which is legal for a bare Cypress project. */
  readonly manifest: ProjectManifest | undefined;
  /** Where the framework is declared. Absent when it is not declared anywhere. */
  readonly declaration: FrameworkDeclaration | undefined;
  /** Where the framework is installed. Absent when it is not installed on disk. */
  readonly installation: InstalledPackage | undefined;
}

export interface PackageDiscoveryOptions {
  /**
   * The npm package name to look for, e.g. `cypress`.
   *
   * Supplied rather than derived from the framework identifier, because the two only coincide today. A
   * framework whose package name differs from its identifier then has exactly one place to change.
   */
  readonly packageName: string;
  /** How far to climb for a hoisted install. */
  readonly maxDepth: number;
}

/**
 * Reads the manifest and the installed package in one call.
 *
 * Sequential rather than concurrent: the declaration is derived from the manifest, so there is nothing to
 * overlap once the manifest has been read. The install lookup is the only part that touches the filesystem
 * repeatedly, and it is bounded.
 */
export async function discoverPackages(
  root: string,
  options: PackageDiscoveryOptions,
): Promise<PackageDiscovery> {
  const manifest = await readManifest(root);

  // Computed before the install lookup so a malformed manifest is reported first. A broken manifest makes
  // the project undescribable, and finding out after a successful install check would only postpone it.
  const declaration =
    manifest === undefined
      ? undefined
      : findDeclaration(manifest, options.packageName);

  const installation = await findInstalledPackage(
    root,
    options.packageName,
    options.maxDepth,
  );

  return { manifest, declaration, installation };
}
