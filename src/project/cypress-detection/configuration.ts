/**
 * Configuration file discovery.
 *
 * Two lists are **scanned at the project root**: the supported formats, which Cypress 10 and later uses and QAT
 * can read, and the recognised-but-unusable one — the legacy `cypress.json`, which identifies a Cypress project
 * from an era before the configuration became a module.
 *
 * A third list is **derived rather than scanned**: the same supported names, under `cypress/`. It answers a
 * different question — not "what can be loaded" but "why is nothing loadable" — and it is probed by the layout
 * reader rather than here, which is why it is deliberately absent from `ConfigurationScan`. Merging it in would
 * put evidence into the detection verdict that the verdict never consults.
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

/**
 * The same configuration names, in the place people put them by mistake.
 *
 * Derived from `CYPRESS_CONFIG_FILES` rather than written out. A second hand-maintained list of six names is six
 * names that eventually disagree with the first — and the failure is silent: a format added to the root scan and
 * forgotten here would simply stop being reported as misplaced, which reads as a project with no configuration
 * and no explanation.
 *
 * The pairing of a *name* with a *wrong location* is the reason this lives beside the root list rather than in
 * the layout reader. The layout reader knows where it looks; this file knows what counts as a configuration file,
 * and the finding is about the intersection.
 *
 * Fixed `cypress/` rather than a list of plausible wrong places. Two or three guessed directories would be a
 * coverage claim nobody can test, and the one that matters in practice — a configuration filed next to the specs
 * it configures — is the one people actually hit.
 */
export const MISPLACED_CONFIG_FILES: readonly string[] =
  CYPRESS_CONFIG_FILES.map((file) => `cypress/${file}`);

export interface ConfigurationScan {
  readonly supported: readonly string[];
  readonly unsupported: readonly string[];
}

export async function findConfigurations(
  root: string,
): Promise<ConfigurationScan> {
  // Two probes over two fixed lists, run together. Neither depends on the other's answer, and the pair is what
  // makes "configured in a form we cannot read" distinguishable from "not configured".
  const [supported, unsupported] = await Promise.all([
    existingFiles(root, CYPRESS_CONFIG_FILES),
    existingFiles(root, LEGACY_CONFIG_FILES),
  ]);

  return { supported, unsupported };
}
