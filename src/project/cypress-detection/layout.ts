/**
 * Directory-layout evidence.
 *
 * What a Cypress project looks like beyond its configuration file: where specs conventionally live, whether a
 * support file exists, where artefacts are written. None of it decides the verdict on its own — a project with a
 * custom `specPattern` has none of these and is still a Cypress project — but it is what turns "no configuration
 * file" into "no configuration file, though it is clearly a Cypress project", which is a different message.
 */
import { join } from "node:path";

import { isDirectory } from "../../core/filesystem/index.js";
import { SPEC_DIRECTORIES, SUPPORT_FILES } from "../contracts.js";

import type { CypressLayout } from "./contracts.js";
import { existingDirectories, existingFiles } from "./probe.js";

/** Cypress's conventional artefact directories. Named rather than repeated as literals in two places. */
const SCREENSHOTS_DIRECTORY = "cypress/screenshots";
const VIDEOS_DIRECTORY = "cypress/videos";
const CYPRESS_DIRECTORY = "cypress";

export async function readLayout(root: string): Promise<CypressLayout> {
  const [
    specDirectories,
    supportFiles,
    hasCypressDirectory,
    hasScreenshots,
    hasVideos,
  ] = await Promise.all([
    existingDirectories(root, SPEC_DIRECTORIES),
    existingFiles(root, SUPPORT_FILES),
    isDirectory(join(root, CYPRESS_DIRECTORY)),
    isDirectory(join(root, SCREENSHOTS_DIRECTORY)),
    isDirectory(join(root, VIDEOS_DIRECTORY)),
  ]);

  return {
    specDirectories,
    supportFiles,
    hasCypressDirectory,
    // Absent rather than `undefined`, because the layout is serialised into a diagnostic document and a null
    // field cannot be told apart from a directory that has no such folder.
    ...(hasScreenshots ? { screenshotsDirectory: SCREENSHOTS_DIRECTORY } : {}),
    ...(hasVideos ? { videosDirectory: VIDEOS_DIRECTORY } : {}),
  };
}
