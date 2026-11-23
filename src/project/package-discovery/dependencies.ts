/**
 * Whether a package is declared, and where.
 *
 * The search order is fixed — runtime, then development, then optional, then peer — because a package
 * declared in two sections is a defect in the manifest, and the runtime declaration is the one that
 * describes how the project actually uses it. The first match is reported and the contradiction is left
 * visible: npm already warns about it, and adjudicating it here would be a second opinion nobody asked for.
 */
import {
  DependencySection,
  type FrameworkDeclaration,
} from "../../core/domain/index.js";

import type { ProjectManifest } from "./manifest.js";

const SEARCH_ORDER: readonly DependencySection[] = [
  DependencySection.Dependencies,
  DependencySection.DevDependencies,
  DependencySection.OptionalDependencies,
  DependencySection.PeerDependencies,
];

/**
 * @param manifest A manifest already read and narrowed.
 * @param packageName The npm package name to look for.
 * @returns The first section declaring it, or `undefined` when none does.
 */
export function findDeclaration(
  manifest: ProjectManifest,
  packageName: string,
): FrameworkDeclaration | undefined {
  for (const section of SEARCH_ORDER) {
    const range = manifest.sections[section][packageName];

    if (range !== undefined) return { section, range };
  }

  return undefined;
}
