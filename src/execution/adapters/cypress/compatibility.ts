/**
 * The Cypress compatibility policy for the QAT Cypress adapter.
 *
 * This module answers exactly one question, loudly and in one place: *which Cypress releases can this adapter actually
 * drive?* Everything else — the health checks, the configuration diagnostics, the run preflight — reads the answer from
 * here.
 *
 * Why a module rather than a constant scattered across call sites: a supported-version range is a promise to users. The
 * moment it exists in two places it is no longer a promise, it is two opinions that will disagree, and the disagreement
 * will surface as a check that passes while a run fails — the least useful kind of bug. The range, its provenance and the
 * releases actually exercised in CI therefore live together, and a contract test asserts that
 * `docs/architecture/cypress-health-checks.md` documents the same values.
 *
 * What this module deliberately does **not** do:
 *
 *  - **It does not compare versions against the range.** That belongs to the shared version engine, which owns one
 *    definition of "in range" for the runtime, package-manager and Cypress checks alike. A helper here that *looked*
 *    convenient would become a second semver implementation, and that is exactly the technical debt this design avoids.
 *  - **It does not decide severity or wording.** Whether an unsupported version blocks or advises is an assessment
 *    decision made against this declaration; the declaration only states what is supported.
 *  - **It does not read the project.** The project may declare any Cypress range it likes; this module states what the
 *    adapter supports, which is what the project's declaration is measured against.
 *  - **It has no import from the diagnostics side.** The shape below is structurally assignable to the policy type the
 *    Cypress health checks consume, and that assignability is enforced at the composition root where the two are wired
 *    together. Keeping the dependency out of this file means the adapter can be understood, tested and shipped without the
 *    diagnostics module existing.
 *
 * Updating the policy is a four-step, reviewable change:
 *   1. widen or narrow `supportedRange` here — full `MAJOR.MINOR.PATCH` triples on both bounds;
 *   2. add or remove the corresponding entries in `verifiedReleases`;
 *   3. update the table in `docs/architecture/cypress-health-checks.md`;
 *   4. run the contract test — it fails if the documentation and this file disagree, or if a verified release falls
 *      outside the declared range.
 */

/**
 * The compatibility declaration for one adapter.
 *
 * Kept as a small explicit interface rather than an inline object type so callers can name it (tests, documentation
 * generators, future adapters) without importing the frozen value itself.
 */
export interface CypressAdapterCompatibility {
  /**
   * Semver range of supported Cypress releases.
   *
   * Written in the subset the shared version engine evaluates: comparator sets joined by `||`, with `>=`, `<=`, `>`, `<`,
   * `=` and `^`. Both bounds are full triples — `>=12.0.0 <14.0.0`, never `>=12 <14`. The abbreviated form reads correctly
   * to a human and is *refused* by the engine, which means the support promise would be stated and then silently stop
   * being applied; the contract test fails on exactly that.
   *
   * The ceiling is explicit rather than a caret, because a caret would silently claim support for an untested major the
   * day it is published. An explicit floor and ceiling states what has been qualified — the same "publish only what you
   * tested" stance the release compatibility matrix is built on.
   */
  readonly supportedRange: string;

  /**
   * Provenance of the range, carried into diagnostic evidence.
   *
   * A finding that says "Cypress 11 is unsupported" must be able to say *on what authority*, otherwise a reader has no way
   * to judge or challenge the claim.
   */
  readonly origin: string;

  /**
   * Documentation anchor for the remediation message.
   *
   * Remediation text should point at the page that explains the policy, not at a number the user has to trust. Keeping the
   * anchor here means the message and the documentation cannot drift apart.
   */
  readonly documentation: string;

  /**
   * Cypress releases this adapter is exercised against in CI.
   *
   * These are the *tested* half of the support promise, and they are data rather than prose so they can be asserted: the
   * contract test verifies that every entry lies inside `supportedRange` and that the floor line is represented. A range
   * nobody ran is a wish; a range with verified releases behind it is a claim.
   *
   * The list is a **set, not a sequence**. Nothing here reads it positionally — see `recommendedCypressRange` for the one
   * consumer that needs an order, and why it computes one rather than trusting the array's.
   */
  readonly verifiedReleases: readonly string[];
}

/**
 * The single source of truth for Cypress support in this adapter.
 *
 * Frozen: this value is read at composition time and injected into every check and every preflight, so a stray mutation
 * would change the product's support promise at runtime with no code review anywhere. `Object.freeze` is shallow, which is
 * why the nested array is frozen separately.
 */
export const CYPRESS_ADAPTER_COMPATIBILITY: CypressAdapterCompatibility =
  Object.freeze({
    supportedRange: ">=12.0.0 <14.0.0",
    origin: "adapters/cypress#compatibility",
    documentation:
      "docs/architecture/cypress-health-checks.md#supported-cypress-range",
    verifiedReleases: Object.freeze(["12.17.4", "13.6.0"]),
  });

/**
 * One-line, human-readable summary of what is supported.
 *
 * Exists so a message, a `--verbose` header or a support answer can state the policy without any caller re-typing the range
 * — and without any caller being tempted to build the sentence from a second copy of the numbers.
 */
export function describeCypressCompatibility(
  compatibility: CypressAdapterCompatibility = CYPRESS_ADAPTER_COMPATIBILITY,
): string {
  return `Cypress ${compatibility.supportedRange} (verified: ${compatibility.verifiedReleases.join(", ")})`;
}

/**
 * A comparable triple, or `null` when the string is not one.
 *
 * Parsing here is a *format* check for ordering, not version comparison: it answers "can these three numbers be put in
 * order", which is the only question picking a recommendation asks. Whether a version satisfies the range remains the
 * engine's business, and this module still does not compare versions against it.
 */
function toTriple(release: string): readonly [number, number, number] | null {
  const parts = release.split(".");
  if (parts.length !== 3) return null;

  const [major, minor, patch] = parts.map(Number);
  if (major === undefined || minor === undefined || patch === undefined)
    return null;
  if (
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    !Number.isInteger(patch)
  )
    return null;

  return [major, minor, patch];
}

/**
 * The install target recommended in remediation text.
 *
 * The **highest** verified release, not the first one listed. That distinction is the whole reason this function exists
 * rather than a `.at(0)`: `verifiedReleases` is declared as a set, so treating element zero as the recommendation silently
 * advised `^12.17.4` while the policy had moved past that line — a recommendation outside the supported range, in the one
 * message whose entire job is to name a supported version. The contract test now pins this: it computes the highest release
 * independently and compares.
 *
 * Ordering is decided here rather than assumed of the array, because an array's order is a fact about how somebody typed it
 * and a recommendation must be a fact about the policy. Entries that are not triples are skipped rather than sorted to the
 * end, so a malformed entry cannot become the recommendation.
 *
 * Returns `null` when nothing is verifiable: a remediation that suggests an untested version is worse than one that only
 * states the range.
 */
export function recommendedCypressRange(
  compatibility: CypressAdapterCompatibility = CYPRESS_ADAPTER_COMPATIBILITY,
): string | null {
  const highest = compatibility.verifiedReleases
    .flatMap((release) => {
      const triple = toTriple(release);

      return triple === null ? [] : [{ release, triple }];
    })
    .sort(
      (a, b) =>
        b.triple[0] - a.triple[0] ||
        b.triple[1] - a.triple[1] ||
        b.triple[2] - a.triple[2],
    )
    .at(0);

  return highest === undefined ? null : `^${highest.release}`;
}
