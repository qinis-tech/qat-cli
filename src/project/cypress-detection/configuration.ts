/**
 * Configuration file discovery.
 *
 * Two lists, and only two. Supported formats are the ones Cypress 10 and later uses and QAT can read; the
 * recognised-but-unusable list is the legacy `cypress.json`, which identifies a Cypress project from an era
 * before the configuration became a module.
 *
 * ## Why the unsupported list is finite
 *
 * A file called `cypress.config.yaml` is not in either list, so it is indistinguishable from no configuration at
 * all — and that is a deliberate limit rather than an oversight. Finding it would mean listing the directory,
 * which the determinism rule forbids. The limit is stated in the detection documentation so a reader meets it
 * there rather than concluding the engine is thorough.
 */
import { CYPRESS_CONFIG_FILES } from "../contracts.js";

import { existingFiles } from "./probe.js";

/**
 * Filenames QAT recognises as a Cypress configuration but cannot use.
 *
 * `cypress.json` was the configuration format before Cypress 10 replaced it with a module. A directory holding
 * only one of these is a Cypress project, which is why it is reported as unsupported rather than absent — the
 * distinction decides whether the reader is told to upgrade or told they are in the wrong place.
 */
export const LEGACY_CONFIG_FILES = ["cypress.json"] as const;

export interface ConfigurationScan {
  readonly supported: readonly string[];
  readonly unsupported: readonly string[];
}

export async function findConfigurations(
  root: string,
): Promise<ConfigurationScan> {
  const [supported, unsupported] = await Promise.all([
    existingFiles(root, CYPRESS_CONFIG_FILES),
    existingFiles(root, LEGACY_CONFIG_FILES),
  ]);

  return { supported, unsupported };
}
