/**
 * Unit tests for package-manager detection.
 *
 * Detection is a pure function of a {@link ProjectSnapshot}, so every case here is a literal: no filesystem, no
 * fixtures on disk, no mocks. That is the property the collector exists to create — I/O in one place, decisions in
 * another — and these tests are where it pays for itself.
 *
 * The matrix is organised the way the rules are: what one lockfile means, what two mean, what a declaration adds, and
 * what remains when neither exists. Every case states the full result rather than a fragment of it, because a detection
 * result is read as evidence — a partially asserted one can be wrong in the field nobody checked.
 */
import { describe, expect, it } from "vitest";

import {
  detectPackageManager,
  type DeclarationParseResult,
  type PackageManagerName,
  type ProjectSnapshot,
} from "~/project/package-manager/index.js";

/**
 * A snapshot with nothing in it.
 *
 * A factory rather than a literal per case, for the reason the fixtures elsewhere learned: a spread that replaces part
 * of an object silently drops the rest, and the missing field surfaces as a confusing failure several assertions later.
 * Every member is present here, so a case can only *replace* one.
 */
function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    root: "/project",
    rootEntries: new Set<string>(),
    declaration: { status: "absent" },
    engineRanges: {},
    hasNodeModules: false,
    ...overrides,
  };
}

/** Root entries, as the collector reports them: basenames only, no directories. */
function entries(...names: string[]): ReadonlySet<string> {
  return new Set(names);
}

/** A usable `packageManager` declaration, as the parser produces one. */
function declaring(
  name: PackageManagerName,
  version = "9.1.0",
): DeclarationParseResult {
  return {
    status: "parsed",
    declaration: { name, version, raw: `${name}@${version}` },
  };
}

describe("a single lockfile", () => {
  it.each<[string, PackageManagerName]>([
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
  ])("identifies the manager from %s", (lockfile, expected) => {
    expect(
      detectPackageManager(snapshot({ rootEntries: entries(lockfile) })),
    ).toStrictEqual({
      status: "detected",
      manager: expected,
      lockfile,
      // Inferred, not declared. The distinction is in the evidence, because a reviewer reading "pnpm" needs to know
      // whether the project said so or whether we worked it out.
      declared: false,
    });
  });

  it("prefers the lockfile the policy lists first when a manager declares two", () => {
    // Both mean npm, so either answer is truthful — but "whichever the directory listing returned first" would make
    // two runs over the same project disagree.
    const detection = detectPackageManager(
      snapshot({
        rootEntries: entries("npm-shrinkwrap.json", "package-lock.json"),
      }),
    );

    expect(detection).toStrictEqual({
      status: "detected",
      manager: "npm",
      lockfile: "package-lock.json",
      declared: false,
    });
  });

  it("matches a lockfile regardless of case", () => {
    // The same repository checked out on a case-insensitive volume. A case-sensitive lookup would report a correctly
    // configured project as undeclared on one machine and not another.
    expect(
      detectPackageManager(
        snapshot({ rootEntries: entries("PNPM-LOCK.YAML") }),
      ),
    ).toMatchObject({ status: "detected", manager: "pnpm" });
  });

  it("ignores a lockfile that is not at the project root", () => {
    // Root entries are basenames; anything path-like came from somewhere else and must not identify this project.
    expect(
      detectPackageManager(
        snapshot({ rootEntries: entries("packages/app/package-lock.json") }),
      ),
    ).toStrictEqual({ status: "undeclared", lockfiles: [] });
  });

  it("ignores a Windows-style nested path", () => {
    // The separator check must cover both, or the same defect reappears on the platform where it is least likely to be
    // noticed by whoever wrote the fix.
    expect(
      detectPackageManager(
        snapshot({ rootEntries: entries("packages\\app\\package-lock.json") }),
      ),
    ).toStrictEqual({ status: "undeclared", lockfiles: [] });
  });

  it("ignores an empty entry", () => {
    // Not a name, and `managerForLockfile('')` returning `undefined` would otherwise let it through to the
    // unrecognised list on the strength of a pattern that does not match it either.
    expect(
      detectPackageManager(snapshot({ rootEntries: entries("") })),
    ).toStrictEqual({
      status: "undeclared",
      lockfiles: [],
    });
  });

  it("ignores an entry that merely resembles a lockfile", () => {
    expect(
      detectPackageManager(
        snapshot({
          rootEntries: entries("package-lock.json.bak", "notes.txt"),
        }),
      ),
    ).toStrictEqual({ status: "undeclared", lockfiles: [] });
  });
});

describe("two lockfiles", () => {
  it("reports a conflict between different managers, naming both files and both managers", () => {
    // The dangerous case: a detector that picked a winner here lets CI install with the wrong tool and rewrite the
    // lockfile the team meant to keep.
    expect(
      detectPackageManager(
        snapshot({
          rootEntries: entries("pnpm-lock.yaml", "package-lock.json"),
        }),
      ),
    ).toStrictEqual({
      status: "conflicting",
      // Sorted, so directory order cannot change the report.
      lockfiles: ["package-lock.json", "pnpm-lock.yaml"],
      managers: ["npm", "pnpm"],
    });
  });

  it("does not treat two lockfiles of the same manager as a conflict", () => {
    // `npm-shrinkwrap.json` and `package-lock.json` are one manager's footprint, not two claims.
    expect(
      detectPackageManager(
        snapshot({
          rootEntries: entries("package-lock.json", "npm-shrinkwrap.json"),
        }),
      ),
    ).toMatchObject({ status: "detected", manager: "npm" });
  });

  it("lists all three files and all three managers", () => {
    expect(
      detectPackageManager(
        snapshot({
          rootEntries: entries(
            "yarn.lock",
            "pnpm-lock.yaml",
            "package-lock.json",
          ),
        }),
      ),
    ).toStrictEqual({
      status: "conflicting",
      lockfiles: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
      managers: ["npm", "pnpm", "yarn"],
    });
  });

  it("is the boundary immediately above a clean detection", () => {
    // One manager and two managers differ by exactly one file. Asserted as a pair so the boundary is visible rather
    // than implied.
    const one = detectPackageManager(
      snapshot({ rootEntries: entries("package-lock.json") }),
    );
    const two = detectPackageManager(
      snapshot({ rootEntries: entries("package-lock.json", "yarn.lock") }),
    );

    expect([one.status, two.status]).toStrictEqual(["detected", "conflicting"]);
  });
});

describe("the declaration", () => {
  it("identifies the manager when no lockfile is present", () => {
    expect(
      detectPackageManager(snapshot({ declaration: declaring("pnpm") })),
    ).toStrictEqual({
      status: "detected",
      manager: "pnpm",
      lockfile: "",
      declared: true,
    });
  });

  it("confirms the identity when it agrees with the lockfile", () => {
    expect(
      detectPackageManager(
        snapshot({
          rootEntries: entries("pnpm-lock.yaml"),
          declaration: declaring("pnpm"),
        }),
      ),
    ).toStrictEqual({
      status: "detected",
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      declared: true,
    });
  });

  it("reports a conflict when it contradicts the lockfile", () => {
    // One file and one field disagreeing is a different story from two files fighting: the fix is "align the field or
    // the file", which is why both candidates are quoted.
    expect(
      detectPackageManager(
        snapshot({
          rootEntries: entries("package-lock.json"),
          declaration: declaring("pnpm"),
        }),
      ),
    ).toStrictEqual({
      status: "conflicting",
      lockfiles: ["package-lock.json"],
      managers: ["npm", "pnpm"],
    });
  });

  it("is ignored for identity when it cannot be used", () => {
    // A bare name declares nothing a comparison can act on. Identity falls to the lockfile, and the declaration is not
    // lost — the assessment step reads it independently and reports it as unusable.
    expect(
      detectPackageManager(
        snapshot({
          rootEntries: entries("pnpm-lock.yaml"),
          declaration: {
            status: "unparsable",
            raw: "pnpm",
            problem: "missing-version",
          },
        }),
      ),
    ).toStrictEqual({
      status: "detected",
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      declared: false,
    });
  });

  it("does not invent an identity from an unparsable declaration alone", () => {
    // `deno@2.0.0` is well-formed and names a manager outside this policy. Identity here would be a claim about a tool
    // QAT cannot act on; the assessment step reports it as unsupported.
    expect(
      detectPackageManager(
        snapshot({
          declaration: {
            status: "unparsable",
            raw: "deno@2.0.0",
            problem: "unknown-manager",
          },
        }),
      ),
    ).toStrictEqual({ status: "undeclared", lockfiles: [] });
  });
});

describe("an unsupported manager", () => {
  it("is identified rather than reported as missing", () => {
    // Saying "no package manager found" to a Bun user sends them looking for a file that is present.
    expect(
      detectPackageManager(snapshot({ rootEntries: entries("bun.lockb") })),
    ).toStrictEqual({
      status: "unsupported",
      manager: "bun",
      lockfile: "bun.lockb",
    });
  });

  it("is identified from its declaration when no lockfile is present", () => {
    expect(
      detectPackageManager(
        snapshot({ declaration: declaring("bun", "1.1.0") }),
      ),
    ).toStrictEqual({
      status: "unsupported",
      manager: "bun",
      lockfile: "",
    });
  });

  it("wins over nothing at all, but loses to a conflict", () => {
    // Recognition is not a tie-break: two declared/observed managers are still a disagreement, and reporting "unsupported"
    // would hide it.
    const unsupported = detectPackageManager(
      snapshot({ rootEntries: entries("bun.lockb") }),
    );
    const conflicting = detectPackageManager(
      snapshot({ rootEntries: entries("bun.lockb", "yarn.lock") }),
    );

    expect([unsupported.status, conflicting.status]).toStrictEqual([
      "unsupported",
      "conflicting",
    ]);
  });
});

describe("nothing identifies the manager", () => {
  it("is undeclared, never npm by default", () => {
    // The default would be a statement about the user's project that nothing supports.
    expect(detectPackageManager(snapshot())).toStrictEqual({
      status: "undeclared",
      lockfiles: [],
    });
  });

  it("reports an unrecognised lockfile as evidence without using it for identity", () => {
    expect(
      detectPackageManager(snapshot({ rootEntries: entries("deno.lock") })),
    ).toStrictEqual({ status: "undeclared", lockfiles: ["deno.lock"] });
  });

  it("sorts the unrecognised lockfiles it reports", () => {
    expect(
      detectPackageManager(
        snapshot({ rootEntries: entries("zeta.lock", "alpha.lock") }),
      ),
    ).toStrictEqual({
      status: "undeclared",
      lockfiles: ["alpha.lock", "zeta.lock"],
    });
  });

  it("stays silent about another ecosystem’s lockfile", () => {
    // A mixed repository would otherwise produce a warning on every run, and an ignored warning is worse than none.
    expect(
      detectPackageManager(
        snapshot({
          rootEntries: entries("Cargo.lock", "poetry.lock", "Gemfile.lock"),
        }),
      ),
    ).toStrictEqual({ status: "undeclared", lockfiles: [] });
  });

  it("does not report a known lockfile as unrecognised", () => {
    // `yarn.lock` matches the lockfile pattern and is also in the policy; it must appear in exactly one place.
    expect(
      detectPackageManager(snapshot({ rootEntries: entries("yarn.lock") })),
    ).toStrictEqual({
      status: "detected",
      manager: "yarn",
      lockfile: "yarn.lock",
      declared: false,
    });
  });
});

describe("purity", () => {
  it("is deterministic: the same snapshot produces the same detection", () => {
    const first = detectPackageManager(
      snapshot({ rootEntries: entries("pnpm-lock.yaml", "package-lock.json") }),
    );
    const second = detectPackageManager(
      snapshot({ rootEntries: entries("package-lock.json", "pnpm-lock.yaml") }),
    );

    // Different insertion orders, one answer — which is the property that makes a report reproducible on another
    // machine holding the same files.
    expect(first).toStrictEqual(second);
  });

  it("returns a frozen result", () => {
    // Detection is evidence. Evidence that a later consumer can edit is not evidence.
    expect(Object.isFrozen(detectPackageManager(snapshot()))).toBe(true);
  });

  it("does not mutate the snapshot it was given", () => {
    const input = snapshot({
      rootEntries: entries("pnpm-lock.yaml", "package-lock.json"),
    });

    detectPackageManager(input);

    expect(input.rootEntries.size).toBe(2);
  });

  it("does not consider whether dependencies are installed", () => {
    // Identity is a question about the project's tooling, not about how far an install got. The two answers come from
    // the same snapshot but must not influence each other.
    const without = detectPackageManager(
      snapshot({ rootEntries: entries("pnpm-lock.yaml") }),
    );
    const withNodeModules = detectPackageManager(
      snapshot({
        rootEntries: entries("pnpm-lock.yaml"),
        hasNodeModules: true,
      }),
    );

    expect(without).toStrictEqual(withNodeModules);
  });

  it("does not consider the declared engine ranges", () => {
    // A manager's version range is compared later, by the one compatibility engine. Detection that read it would be a
    // second place deciding what "supported" means.
    const plain = detectPackageManager(
      snapshot({ rootEntries: entries("pnpm-lock.yaml") }),
    );
    const withEngines = detectPackageManager(
      snapshot({
        rootEntries: entries("pnpm-lock.yaml"),
        engineRanges: { pnpm: ">=10.0.0" },
      }),
    );

    expect(plain).toStrictEqual(withEngines);
  });
});
