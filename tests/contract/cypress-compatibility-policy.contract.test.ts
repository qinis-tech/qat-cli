/**
 * Contract tests for the Cypress compatibility policy.
 *
 * This is the traceability artefact for "100% of approved compatibility boundaries verified": the boundaries are not
 * described in prose and hoped for, they are derived from the declared range, evaluated by the same engine that decides at
 * runtime, and asserted from both sides.
 *
 * Two things make this a *contract* rather than another unit test:
 *
 *  - The boundaries are derived, not restated. A hardcoded `>=12.0.0 <14` makes every assertion in the file wrong the day
 *    the policy legitimately moves, which trains a maintainer to edit the expectations until they pass — the opposite of
 *    what a contract test is for. The range itself is pinned once, by the documentation parity case: the policy cannot
 *    change without the prose changing with it.
 *  - Every figure comes from the module or from the engine. What is asserted is the *relationship* — the floor is
 *    inclusive, the ceiling is exclusive, every verified release is inside — which stays true across a policy change and
 *    still catches an off-by-one in an operator.
 *
 * ## Nothing here is allowed to pass by doing nothing
 *
 * An earlier version of the boundary cases opened with `if (bounds === null) return;`. Every one of them passed. They passed
 * because the policy's range was unparsable, so there were no bounds to assert — a suite that reports green precisely when
 * the policy stops working. `requireBounds()` throws instead, and its message says what to change.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateVersionRequirement,
  parseRange,
  type VersionRequirement,
} from "~/core/compatibility/index.js";
import {
  CYPRESS_ADAPTER_COMPATIBILITY,
  describeCypressCompatibility,
  recommendedCypressRange,
} from "~/execution/adapters/cypress/compatibility.js";

/* -------------------------------------------------------------------------- */
/* Locating the repository                                                    */
/* -------------------------------------------------------------------------- */

/** Two levels up from `tests/contract/`, which is where every path in this file is resolved from. */
const REPOSITORY_ROOT = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

/* -------------------------------------------------------------------------- */
/* The policy, as the engine sees it                                          */
/* -------------------------------------------------------------------------- */

const POLICY = CYPRESS_ADAPTER_COMPATIBILITY;
const RANGE = POLICY.supportedRange;

/**
 * The policy expressed as the engine's own input.
 *
 * Built from the module's declared range rather than a literal, so the boundary cases exercise what will actually be
 * evaluated at runtime; the equality between the module and the documentation is a separate case.
 */
const REQUIREMENT: VersionRequirement = {
  source: "cypress",
  range: RANGE,
  origin: POLICY.origin,
  severityWhenUnsatisfied: "warning",
};

function satisfies(version: string): boolean {
  return (
    evaluateVersionRequirement(REQUIREMENT, version).status === "satisfied"
  );
}

/** The documentation file the policy points at, without its `#fragment`. */
function documentationFile(): string {
  const [file] = POLICY.documentation.split("#");

  return path.join(REPOSITORY_ROOT, file ?? "");
}

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function versionOf(value: Version): string {
  return `${String(value.major)}.${String(value.minor)}.${String(value.patch)}`;
}

/** The greatest version strictly below `floor`. */
function below(floor: Version): string {
  if (floor.patch > 0)
    return `${String(floor.major)}.${String(floor.minor)}.${String(floor.patch - 1)}`;
  if (floor.minor > 0)
    return `${String(floor.major)}.${String(floor.minor - 1)}.999`;
  return `${String(floor.major - 1)}.999.999`;
}

/** The greatest version strictly below `ceiling`, i.e. the last one the range should accept. */
function lastBelow(ceiling: Version): string {
  if (ceiling.minor > 0)
    return `${String(ceiling.major)}.${String(ceiling.minor - 1)}.999`;
  return `${String(ceiling.major - 1)}.999.999`;
}

/**
 * The floor and the exclusive ceiling, read out of the declared range.
 *
 * Only the simple `>=x.y.z <a.b.c` shape is derived. That is deliberate rather than lazy: a policy written as a gapped
 * alternative or a caret has no single floor-and-ceiling pair, so there is nothing for these cases to assert. A range that
 * cannot be parsed or cannot be reduced to that shape is reported by `requireBounds()` rather than skipped here.
 */
function boundsOf(
  range: string,
): { readonly floor: Version; readonly ceiling: Version } | null {
  const parsed = parseRange(range);
  if (!parsed.ok) return null;

  const [set] = parsed.expression;
  if (set === undefined) return null;

  const floor = set.find((comparator) => comparator.operator === ">=");
  const ceiling = set.find((comparator) => comparator.operator === "<");

  if (floor === undefined || ceiling === undefined || set.length !== 2)
    return null;

  return { floor: floor.bound, ceiling: ceiling.bound };
}

const BOUNDS = boundsOf(RANGE);

/**
 * The bounds, or a failure that says what to fix.
 *
 * Throwing rather than returning `null` is the whole point: a boundary case that cannot derive its own edges has proved
 * nothing, and reporting it as a pass is how a broken policy ships with a green contract suite. The message names the two
 * realistic causes, because both look correct in a diff.
 */
function requireBounds(): {
  readonly floor: Version;
  readonly ceiling: Version;
} {
  if (BOUNDS !== null) return BOUNDS;

  const parsed = parseRange(RANGE);

  throw new Error(
    [
      `The declared range "${RANGE}" cannot be reduced to a floor and an exclusive ceiling, so no boundary can be asserted.`,
      parsed.ok
        ? "It parses, but not as a single `>=floor <ceiling` pair."
        : `It does not parse at all: ${parsed.reason}. Bounds must be full MAJOR.MINOR.PATCH triples — "<14" is refused, "<14.0.0" is accepted.`,
      `Declared in ${POLICY.origin}.`,
    ].join(" "),
  );
}

/* -------------------------------------------------------------------------- */
/* The declaration                                                            */
/* -------------------------------------------------------------------------- */

describe("Cypress compatibility policy — the declaration", () => {
  it("declares a non-empty range, origin and documentation anchor", () => {
    expect(RANGE.length).toBeGreaterThan(0);
    expect(POLICY.origin.length).toBeGreaterThan(0);
    expect(POLICY.documentation.length).toBeGreaterThan(0);
  });

  it("names itself as the provenance", () => {
    // Evidence quotes this string, so it has to identify the module a reader can go and open.
    expect(POLICY.origin).toMatch(/cypress/iu);
  });

  it("is frozen, so no consumer can widen support at runtime", () => {
    expect(Object.isFrozen(POLICY)).toBe(true);
    expect(Object.isFrozen(POLICY.verifiedReleases)).toBe(true);
  });

  it("declares a range the engine can evaluate at all", () => {
    // An unparsable range makes every real project indeterminate — a policy that cannot be applied is worse than a strict
    // one, because it silently stops saying anything.
    const parsed = parseRange(RANGE);

    // One argument only: `expect(value, message)` is rejected by `vitest/valid-expect`. The parser's own reason is folded
    // into the compared value instead, so a failure reads `expected 'policy-range-unreadable' to be 'parseable'` — which
    // names the cause more precisely than a hand-written message would.
    expect(parsed.ok ? "parseable" : parsed.reason).toBe("parseable");
  });

  it("declares a range with derivable floor and ceiling boundaries", () => {
    // Named failure rather than a silent skip — see the header.
    expect(() => requireBounds()).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Approved boundaries                                                        */
/* -------------------------------------------------------------------------- */

describe("Cypress compatibility policy — approved boundaries", () => {
  it("is driven by the four adjacent cells of its own range", () => {
    const bounds = requireBounds();

    const cases: readonly [string, string, boolean][] = [
      ["one below the floor", below(bounds.floor), false],
      ["the floor itself", versionOf(bounds.floor), true],
      ["the last version below the ceiling", lastBelow(bounds.ceiling), true],
      ["the ceiling itself", versionOf(bounds.ceiling), false],
    ];

    for (const [label, version, expected] of cases) {
      // Both sides of every edge. An off-by-one in an inclusivity operator is invisible to a test that only checks "a
      // version in the middle works", and it is exactly the change that makes a supported version look unsupported on every
      // machine at the floor.
      expect(satisfies(version), `${label} (${version})`).toBe(expected);
    }
  });

  it("has an inclusive floor", () => {
    const bounds = requireBounds();

    expect(satisfies(versionOf(bounds.floor))).toBe(true);
    expect(satisfies(below(bounds.floor))).toBe(false);
  });

  it("has an exclusive ceiling", () => {
    const bounds = requireBounds();

    expect(satisfies(lastBelow(bounds.ceiling))).toBe(true);
    expect(satisfies(versionOf(bounds.ceiling))).toBe(false);
  });

  it("rejects a pre-release of the ceiling", () => {
    const bounds = requireBounds();

    // A pre-release is not a released version of the next line, and support is only claimed for released versions.
    expect(satisfies(`${versionOf(bounds.ceiling)}-rc.1`)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Verified releases                                                          */
/* -------------------------------------------------------------------------- */

describe("Cypress compatibility policy — verified releases", () => {
  it("verifies at least one release", () => {
    // A range nobody ran is a wish. The set being non-empty is what makes the support promise testable at all.
    expect(POLICY.verifiedReleases.length).toBeGreaterThan(0);
  });

  it.each(POLICY.verifiedReleases.map((release) => [release] as [string]))(
    "verifies %s inside the declared range",
    (release) => {
      // The most expensive kind of stale policy: a range with a release inside it that was never tested, or a tested
      // release that has drifted outside the range and can no longer be installed from a clean checkout.
      expect(satisfies(release), `${release} must satisfy ${RANGE}`).toBe(true);
    },
  );

  it("represents the floor line", () => {
    // The floor is the boundary most likely to be wrong, because it is the one nobody develops on.
    const major = String(requireBounds().floor.major);

    expect(
      POLICY.verifiedReleases.some((release) =>
        release.startsWith(`${major}.`),
      ),
    ).toBe(true);
  });

  it("lists releases without duplicates or empty entries", () => {
    const releases = POLICY.verifiedReleases;

    expect(new Set(releases).size).toBe(releases.length);
    expect(releases.every((release) => /^\d+\.\d+\.\d+$/u.test(release))).toBe(
      true,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Presentation helpers                                                       */
/* -------------------------------------------------------------------------- */

describe("Cypress compatibility policy — presentation", () => {
  it("summarises the policy in one line", () => {
    const summary = describeCypressCompatibility();

    expect(summary).toContain(RANGE);
    for (const release of POLICY.verifiedReleases)
      expect(summary).toContain(release);
  });

  it("recommends a release that is actually supported", () => {
    // "Upgrade Cypress" is only actionable if the version suggested is one the adapter can drive.
    const recommended = recommendedCypressRange();

    expect(recommended).not.toBeNull();

    const version = (recommended ?? "").replace(/^\^/u, "");
    expect(POLICY.verifiedReleases).toContain(version);
    expect(
      satisfies(version),
      `${version} is recommended but does not satisfy ${RANGE}`,
    ).toBe(true);
  });

  it("recommends the highest verified release", () => {
    const recommended = recommendedCypressRange();

    // Ordering written out rather than delegated: this asserts *which* release wins, so deriving the winner from the code
    // under test would make the case a tautology. Three components, compared numerically — the two ways a "highest" check
    // normally goes wrong are lexical comparison and taking the first entry.
    const highest = [...POLICY.verifiedReleases]
      .map((release) => ({ release, parts: release.split(".").map(Number) }))
      .sort((a, b) => {
        const [aMajor = 0, aMinor = 0, aPatch = 0] = a.parts;
        const [bMajor = 0, bMinor = 0, bPatch = 0] = b.parts;

        return bMajor - aMajor || bMinor - aMinor || bPatch - aPatch;
      })
      .at(0);

    expect(recommended).toBe(
      highest === undefined ? null : `^${highest.release}`,
    );
  });

  it("recommends nothing rather than something unverified when no release is verified", () => {
    // A remediation that suggests an untested version is worse than one that only states the range.
    expect(
      recommendedCypressRange({ ...POLICY, verifiedReleases: [] }),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Documentation parity                                                       */
/* -------------------------------------------------------------------------- */

describe("Cypress compatibility policy — documentation", () => {
  it("points at a file that exists", async () => {
    // A documentation anchor that no longer resolves is quoted verbatim in a remediation, so the reader is sent to a
    // heading that is not there.
    await expect(stat(documentationFile())).resolves.toBeDefined();
  });

  it("points at a heading the document actually has", async () => {
    const document = await readFile(documentationFile(), "utf8");

    expect(document.toLowerCase()).toContain("supported cypress range");
  });

  it("quotes the declared range verbatim", async () => {
    // Prose that states a different range from the one the code enforces is worse than no prose. This is also the single
    // place the range is pinned: change the policy and the documentation must change with it.
    const document = await readFile(documentationFile(), "utf8");

    expect(document, `the documentation must quote "${RANGE}"`).toContain(
      RANGE,
    );
  });

  it.each(POLICY.verifiedReleases.map((release) => [release] as [string]))(
    "names the verified release %s",
    async (release) => {
      const document = await readFile(documentationFile(), "utf8");

      expect(document).toContain(release);
    },
  );

  it("names the policy module the range comes from", async () => {
    // The provenance a finding quotes should be findable in the document that explains the policy.
    const document = await readFile(documentationFile(), "utf8");

    expect(document).toContain("adapters/cypress/compatibility.ts");
  });
});
