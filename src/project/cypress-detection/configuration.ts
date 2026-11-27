/**
 * Configuration file discovery.
 *
 * Two lists are **scanned at the project root**: the supported formats, which
 * Cypress 10 and later uses and QAT can read, and the recognised-but-unusable one
 * — the legacy `cypress.json`, which identifies a Cypress project from an era
 * before the configuration became a module.
 *
 * A third list is **derived rather than scanned**: the same supported names, under
 * `cypress/`. It answers a different question — not "what can be loaded" but "why
 * is nothing loadable" — and it is probed by the layout reader rather than here,
 * which is why it is deliberately absent from `ConfigurationScan`. Merging it in
 * would put evidence into the detection verdict that the verdict never consults.
 *
 * ## One pass, not two
 *
 * Both lists are probed in a **single** call. Two calls would be two readings of
 * one directory, and a file appearing between them produces a scan that
 * contradicts itself: no supported configuration *and* no legacy one, for a
 * project that has exactly one of them. One pass also halves the stats on a hot
 * path — this runs for every project, every command.
 *
 * ## Ordering is guaranteed here, not inherited
 *
 * Each list is returned in candidate order — the order the names appear in their
 * source list — because two machines holding identical files must produce
 * identical evidence. That guarantee is enforced by re-indexing against the
 * candidate table rather than assumed from the probe's return order, so a future
 * change to `existingFiles` cannot quietly make a finding non-deterministic.
 *
 * ## Why the unsupported list is finite
 *
 * A file called `cypress.config.yaml` is not in either list, so it is
 * indistinguishable from no configuration at all — and that is a deliberate limit
 * rather than an oversight. Finding it would mean listing the directory, which the
 * determinism rule forbids. The limit is stated in the detection documentation so
 * a reader meets it there rather than concluding the engine is thorough.
 */

import { CYPRESS_CONFIG_FILES } from "../contracts.js";

import { existingFiles } from "./probe.js";

/**
 * Filenames QAT recognises as a Cypress configuration but cannot use.
 *
 * `cypress.json` was the configuration format before Cypress 10 replaced it with a
 * module. A directory holding only one of these is a Cypress project, which is why
 * it is reported as unsupported rather than absent — the distinction decides
 * whether the reader is told to upgrade or told they are in the wrong place.
 */
export const LEGACY_CONFIG_FILES = Object.freeze(["cypress.json"] as const);

/**
 * The same configuration names, in the place people put them by mistake.
 *
 * Derived from `CYPRESS_CONFIG_FILES` rather than written out. A second
 * hand-maintained list of six names is six names that eventually disagree with the
 * first — and the failure is silent: a format added to the root scan and forgotten
 * here would simply stop being reported as misplaced, which reads as a project
 * with no configuration and no explanation.
 *
 * Legacy names are deliberately **not** derived into this list. `cypress.json`
 * never lived beside the specs, so probing for `cypress/cypress.json` would buy a
 * stat per project for a case that does not occur — and a "misplaced legacy
 * configuration" finding would send people to move a file that the upgrade advice
 * already tells them to delete.
 *
 * The pairing of a *name* with a *wrong location* is the reason this lives beside
 * the root list rather than in the layout reader. The layout reader knows where it
 * looks; this file knows what counts as a configuration file, and the finding is
 * about the intersection.
 *
 * Fixed `cypress/` rather than a list of plausible wrong places. Two or three
 * guessed directories would be a coverage claim nobody can test, and the one that
 * matters in practice — a configuration filed next to the specs it configures — is
 * the one people actually hit.
 */
export const MISPLACED_CONFIG_FILES: readonly string[] = Object.freeze(
  CYPRESS_CONFIG_FILES.map((file) => `cypress/${file}`),
);

/**
 * Every root filename this module probes, in candidate order.
 *
 * Deduplicated because the two source lists describe overlapping ideas and could
 * one day share a name: a supported name that also appeared in the legacy list
 * would otherwise be probed twice and, worse, reported in both groups. Supported
 * membership wins, because a name Cypress can load must never be described as
 * unusable.
 */
const SCANNED_FILES: readonly string[] = Object.freeze([
  ...new Set<string>([...CYPRESS_CONFIG_FILES, ...LEGACY_CONFIG_FILES]),
]);

/** Candidate position, used to restore a deterministic order after the probe. */
const CANDIDATE_ORDER = new Map<string, number>(
  SCANNED_FILES.map((file, index) => [file, index]),
);

const SUPPORTED_NAMES = new Set<string>(CYPRESS_CONFIG_FILES);
const LEGACY_NAMES = new Set<string>(LEGACY_CONFIG_FILES);

/** Sort by position in the candidate table; unknown names sort last, stably. */
function byCandidateOrder(a: string, b: string): number {
  return (
    (CANDIDATE_ORDER.get(a) ?? Number.MAX_SAFE_INTEGER) -
    (CANDIDATE_ORDER.get(b) ?? Number.MAX_SAFE_INTEGER)
  );
}

/**
 * What the root scan found.
 *
 * Both arrays are frozen and both are in candidate order. Freezing matters because
 * this value is carried inside the detection verdict and reaches evidence: a
 * consumer that sorted it in place would reorder a shared observation for every
 * other consumer of the same run.
 *
 * `existingFiles` answers "is there a regular file with this name". A *directory*
 * occupying a configuration name is therefore invisible here by design, not by
 * accident — the layout reader reports it as an occupied path, because a directory
 * is a layout fact and this module only knows filenames.
 */
export interface ConfigurationScan {
  /** Supported configuration files present at the root, in candidate order. */
  readonly supported: readonly string[];
  /** Recognised-but-unusable configuration files present at the root, in candidate order. */
  readonly unsupported: readonly string[];
}

export async function findConfigurations(
  root: string,
): Promise<ConfigurationScan> {
  // One probe over one combined list: no window in which the directory can change
  // between two reads, and one batch of stats instead of two.
  const found = await existingFiles(root, SCANNED_FILES);

  const supported = found
    .filter((file) => SUPPORTED_NAMES.has(file))
    .sort(byCandidateOrder);
  const unsupported = found
    .filter((file) => LEGACY_NAMES.has(file))
    .sort(byCandidateOrder);

  return Object.freeze({
    supported: Object.freeze(supported),
    unsupported: Object.freeze(unsupported),
  });
}
