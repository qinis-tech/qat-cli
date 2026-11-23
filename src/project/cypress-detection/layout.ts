/**
 * Directory-layout evidence.
 *
 * What a Cypress project looks like beyond its configuration file: where specs conventionally live, whether a
 * support file exists, where artefacts are written, and — since a configuration can be present and still useless —
 * where a configuration file exists that Cypress will not load.
 *
 * None of it decides the verdict on its own. A project with a custom `specPattern` has none of the conventional
 * directories and is still a Cypress project. What the layout does is turn "no configuration file" into "no
 * configuration file, though it is clearly a Cypress project", and turn "no spec location" into one of two
 * different messages depending on whether component tests are the reason.
 *
 * ## Why the awkward cases are gathered here
 *
 * A directory squatting on `cypress.config.ts`, a configuration filed inside `cypress/`, component tests and
 * nothing else: each is invisible to a probe that only asks "is this a file" or only asks "is this a directory".
 * They are gathered here because this is the one place that reads the tree, and because the layer above needs
 * them to explain a failure it would otherwise report as a plain absence.
 *
 * ## Nothing here lists a directory
 *
 * Every probe is a fixed candidate list. Two machines holding identical files must produce identical evidence, so
 * the cost of a name nobody anticipated is that it is invisible — stated in the architecture document rather than
 * worked around with an iteration whose order nobody controls.
 */
import { join } from "node:path";

import { isDirectory } from "../../core/filesystem/index.js";
import {
  CYPRESS_CONFIG_FILES,
  LEGACY_SPEC_DIRECTORY,
  SPEC_DIRECTORIES,
  SUPPORT_FILES,
} from "../contracts.js";

import { MISPLACED_CONFIG_FILES } from "./configuration.js";
import type { CypressLayout } from "./contracts.js";
import { existingDirectories, existingFiles } from "./probe.js";

/** Cypress's conventional artefact directories. Named rather than repeated as literals in two places. */
const SCREENSHOTS_DIRECTORY = "cypress/screenshots";
const VIDEOS_DIRECTORY = "cypress/videos";
const CYPRESS_DIRECTORY = "cypress";
const COMPONENT_DIRECTORY = "cypress/component";

export async function readLayout(root: string): Promise<CypressLayout> {
  // Eight independent existence checks, run together. None depends on another's answer and each is a single
  // `stat`, so the extra evidence costs one round trip rather than eight. Sequential awaits here would make the
  // cost of the awkward-case probes visible in every detection, for no ordering benefit.
  const [
    namedSpecDirectories,
    supportFiles,
    hasCypressDirectory,
    hasScreenshots,
    hasVideos,
    hasComponentDirectory,
    misplacedConfigurations,
    occupiedConfigurationPaths,
  ] = await Promise.all([
    existingDirectories(root, SPEC_DIRECTORIES),
    existingFiles(root, SUPPORT_FILES),
    isDirectory(join(root, CYPRESS_DIRECTORY)),
    isDirectory(join(root, SCREENSHOTS_DIRECTORY)),
    isDirectory(join(root, VIDEOS_DIRECTORY)),
    isDirectory(join(root, COMPONENT_DIRECTORY)),
    existingFiles(root, MISPLACED_CONFIG_FILES),
    existingDirectories(root, CYPRESS_CONFIG_FILES),
  ]);

  return {
    specDirectories: specDirectoriesFor(
      namedSpecDirectories,
      hasCypressDirectory,
    ),
    // Absent rather than `undefined`, because the layout is serialised into a diagnostic document and a null
    // field cannot be told apart from a project that has no component directory.
    ...(hasComponentDirectory
      ? { componentDirectory: COMPONENT_DIRECTORY }
      : {}),
    supportFiles,
    // Same reasoning as `componentDirectory`: absent means "no such directory", not "not reported".
    ...(hasScreenshots ? { screenshotsDirectory: SCREENSHOTS_DIRECTORY } : {}),
    ...(hasVideos ? { videosDirectory: VIDEOS_DIRECTORY } : {}),
    hasCypressDirectory,
    // Both are almost always empty, and both are non-optional: an empty array is a fact about the project, an
    // absent field would be read as "nobody looked".
    misplacedConfigurations,
    occupiedConfigurationPaths,
  };
}

/**
 * The spec locations that exist, with the legacy root as a fallback rather than as a candidate.
 *
 * `cypress/` is present in every project that has any Cypress directory at all, so counting it alongside a named
 * one reports a parent as a spec location — true, and actively misleading: a run pointed at it would collect every
 * file under `cypress/`, including the support files. It is reported only when nothing more specific exists, which
 * is the one layout it describes.
 *
 * The distinction is load-bearing for the validation layer rather than merely tidy: a `legacy` project is
 * driveable and an `unknown` one is not, and a list that always contains `cypress/` cannot tell them apart.
 */
function specDirectoriesFor(
  named: readonly string[],
  hasCypressDirectory: boolean,
): readonly string[] {
  if (named.length > 0) return named;

  return hasCypressDirectory ? [LEGACY_SPEC_DIRECTORY] : [];
}
