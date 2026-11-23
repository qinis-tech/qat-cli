/**
 * The detection engine.
 *
 * Reads the manifest, looks for an installed package, scans for configuration files and reads the layout, then
 * classifies the directory with the evidence attached.
 *
 * ## What it will not do
 *
 * - **It does not modify anything.** Every operation is a read; there is no write path in this module or in the
 *   two it delegates to.
 * - **It does not run Cypress.** The installed package is identified by reading its manifest, never by executing
 *   it. A project whose Cypress is not installed is still *detected*, because identifying a project and being
 *   able to run it are different questions.
 * - **It does not throw for an unfavourable verdict.** Absence, ambiguity and an unusable format are answers.
 *   It throws only when input cannot be read — a manifest that does not parse — because that is a broken file
 *   rather than a missing one.
 */
import { DEFAULT_MAX_PARENT_DEPTH } from "../contracts.js";
import { discoverPackages } from "../package-discovery/index.js";

import { findConfigurations } from "./configuration.js";
import { DetectionVerdict } from "./contracts.js";
import type { CypressDetection, DetectionOptions } from "./contracts.js";
import { readLayout } from "./layout.js";

/** The framework's npm package name. Separate from its identifier so the two can diverge later. */
const CYPRESS_PACKAGE = "cypress";

export async function detectCypress(
  root: string,
  options: DetectionOptions = {},
): Promise<CypressDetection> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_PARENT_DEPTH;

  // Three independent readings of the same tree, so they run together. None depends on another's answer: the
  // package lookup reads manifests, the configuration scan checks filenames, and the layout scan checks directory
  // names. Doing them in series would triple the wall-clock cost for no ordering benefit.
  const [packages, configurations, layout] = await Promise.all([
    discoverPackages(root, { packageName: CYPRESS_PACKAGE, maxDepth }),
    findConfigurations(root),
    readLayout(root),
  ]);

  const evidence = {
    root,
    configurations: configurations.supported,
    unsupportedConfigurations: configurations.unsupported,
    packages,
    layout,
  };

  // Ambiguity first: two usable configurations is a different mistake from none, and it is the one that gets
  // worse if it is ignored.
  if (configurations.supported.length > 1) {
    return { ...evidence, verdict: DetectionVerdict.Ambiguous };
  }

  const [configuration] = configurations.supported;

  if (configuration !== undefined) {
    // A legacy configuration alongside a supported one is a project part-way through a migration, not a failure.
    // It stays in the evidence so a caller can mention it.
    return { ...evidence, verdict: DetectionVerdict.Detected, configuration };
  }

  if (configurations.unsupported.length > 0) {
    return { ...evidence, verdict: DetectionVerdict.Unsupported };
  }

  // Cypress is evidenced, just not by a configuration file: a declared dependency, an installed package, or the
  // conventional directory. Any of the three is enough to say the reader is in a Cypress project with something
  // missing, which is a different message from "this is not a Cypress project".
  const evidenced =
    packages.declaration !== undefined ||
    packages.installation !== undefined ||
    layout.hasCypressDirectory;

  return {
    ...evidence,
    verdict: evidenced ? DetectionVerdict.Incomplete : DetectionVerdict.Absent,
  };
}
