/**
 * Unit tests for the package-manager policy table.
 *
 * The table is the single source of truth for three facts that appear in prose all over the product — which lockfile
 * belongs to which manager, which command installs with it, and which managers are supported. These tests exist
 * because a table is only a source of truth if something checks it: a duplicate lockfile entry or an entry with no
 * executable would produce a confident, wrong answer at runtime rather than an error.
 *
 * No mocks, no fixtures, no filesystem. The module is data plus lookups, so the tests are assertions about data.
 *
 * Two house rules are visible throughout:
 *
 *   • **No assertion inside a conditional.** `expect` in an `if` silently stops asserting the moment the branch stops
 *     being taken, and the test keeps passing. Where a subset needs checking, the subset is *built* first — filter,
 *     then assert over the result — so the only thing that can vary is how many cases there are, which is asserted too.
 *   • **Guards are statements, not conditions around assertions.** `if (x === undefined) continue;` narrows the type
 *     and reads as a precondition; wrapping assertions in the same `if` would make them disappear with it.
 */
import { describe, expect, it } from "vitest";

import {
  findPolicyConflicts,
  installCommandFor,
  isSupportedManager,
  knownLockfiles,
  managerForLockfile,
  PACKAGE_MANAGER_POLICY,
  PACKAGE_MANAGER_POLICY_DOC,
  policyFor,
  supportedManagers,
  type PackageManagerName,
  type PackageManagerPolicy,
  type PackageManagerPolicyEntry,
} from "~/project/package-manager/index.js";

/**
 * Builds a complete policy from overrides.
 *
 * `PackageManagerPolicy` is a total record, so a partial object would not compile — and that is the point of the type.
 * The helper keeps the tests honest about it: every case starts from the shipped policy and changes only the entries
 * under test, so a new manager added to the real table cannot silently drop out of these scenarios.
 *
 * The callback's return type is annotated rather than `satisfies`-checked: a `satisfies` on an array literal leaves it
 * inferred as an array, not a tuple, and `Object.fromEntries` then loses the entry type.
 */
function policyWith(
  overrides: Partial<
    Record<PackageManagerName, Partial<PackageManagerPolicyEntry>>
  >,
): PackageManagerPolicy {
  const entries = (
    Object.keys(PACKAGE_MANAGER_POLICY) as PackageManagerName[]
  ).map((name): [PackageManagerName, PackageManagerPolicyEntry] => [
    name,
    { ...PACKAGE_MANAGER_POLICY[name], ...(overrides[name] ?? {}) },
  ]);

  return Object.freeze(Object.fromEntries(entries)) as PackageManagerPolicy;
}

/** Every manager in the table, in declaration order. */
const MANAGERS = Object.keys(PACKAGE_MANAGER_POLICY) as PackageManagerName[];

describe("PACKAGE_MANAGER_POLICY", () => {
  it("is internally consistent as shipped", () => {
    // The assertion that makes every other test in this file meaningful: no lockfile claimed twice, no manager
    // without a lockfile or an executable.
    expect(findPolicyConflicts()).toStrictEqual([]);
  });

  it("is deeply frozen, so no caller can widen support at runtime", () => {
    // A shallow freeze would still allow `lockfiles.push(...)`, which changes behaviour for every check in the
    // process — including ones already running.
    expect(Object.isFrozen(PACKAGE_MANAGER_POLICY)).toBe(true);

    for (const name of MANAGERS) {
      expect(Object.isFrozen(PACKAGE_MANAGER_POLICY[name])).toBe(true);
      expect(Object.isFrozen(PACKAGE_MANAGER_POLICY[name].lockfiles)).toBe(
        true,
      );
      expect(Object.isFrozen(PACKAGE_MANAGER_POLICY[name].executables)).toBe(
        true,
      );
    }
  });

  it("cannot be mutated through a lockfile array", () => {
    expect(() => {
      (PACKAGE_MANAGER_POLICY.npm.lockfiles as string[]).push("invented.lock");
    }).toThrow(TypeError);
  });

  it("declares every lockfile in lower case", () => {
    // The lookup index lower-cases its keys, so a mixed-case entry would be unreachable — present in the table and
    // invisible to detection, which is the worst of both.
    const lockfiles = MANAGERS.flatMap(
      (name) => PACKAGE_MANAGER_POLICY[name].lockfiles,
    );

    expect(lockfiles.length).toBeGreaterThan(0);
    expect(
      lockfiles.filter((lockfile) => lockfile !== lockfile.toLowerCase()),
    ).toStrictEqual([]);
  });

  it("declares install markers relative to the project root", () => {
    // Markers are compared against a root-relative path. An absolute one would never match, and install state would be
    // reported as `absent` for every fully installed project.
    //
    // The subset is built first and asserted afterwards, so the assertion cannot be skipped by a branch. `null` is a
    // legitimate value — it means the manager leaves no marker we trust — so it is filtered out rather than asserted
    // about, and the count assertions prove the filter did not empty the list.
    const markers = MANAGERS.map(
      (name) => PACKAGE_MANAGER_POLICY[name].installMarker,
    ).filter((marker): marker is string => marker !== null);

    expect(markers.length).toBeGreaterThan(0);
    expect(
      markers.filter((marker) => !marker.startsWith("node_modules/")),
    ).toStrictEqual([]);
    expect(markers.filter((marker) => marker.startsWith("/"))).toStrictEqual(
      [],
    );
  });
});

describe("supportedManagers", () => {
  it("lists the supported managers in declaration order", () => {
    // Order is meaningful: it is the order candidates are listed in a report, so a stable order keeps diagnostic
    // output diffable across runs.
    expect(supportedManagers()).toStrictEqual(["npm", "pnpm", "yarn"]);
  });

  it("returns a frozen array", () => {
    expect(Object.isFrozen(supportedManagers())).toBe(true);
  });

  it("excludes a recognised but unsupported manager", () => {
    expect(supportedManagers()).not.toContain("bun");
    expect(isSupportedManager("bun")).toBe(false);
  });

  it("includes every manager whose policy entry says it is supported", () => {
    // Derived from the table rather than restated, so adding a manager does not require editing this test.
    const fromTable = MANAGERS.filter(
      (name) => PACKAGE_MANAGER_POLICY[name].supported,
    );

    expect(supportedManagers()).toStrictEqual(fromTable);
  });
});

describe("isSupportedManager", () => {
  it.each<[PackageManagerName, boolean]>([
    ["npm", true],
    ["pnpm", true],
    ["yarn", true],
    ["bun", false],
  ])("reports %s as supported=%s", (manager, expected) => {
    expect(isSupportedManager(manager)).toBe(expected);
  });
});

describe("policyFor", () => {
  it.each<PackageManagerName>(["npm", "pnpm", "yarn", "bun"])(
    "returns the frozen entry for %s",
    (manager) => {
      // Identity, not deep equality: a copy would be a second table, and the first caller to edit it would change
      // nothing that anyone else sees.
      expect(policyFor(manager)).toBe(PACKAGE_MANAGER_POLICY[manager]);
      expect(Object.isFrozen(policyFor(manager))).toBe(true);
    },
  );
});

describe("managerForLockfile", () => {
  it.each<[string, PackageManagerName]>([
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
  ])("maps %s to %s", (basename, manager) => {
    expect(managerForLockfile(basename)).toBe(manager);
  });

  it.each<[string, string]>([
    ["PNPM-LOCK.YAML", "pnpm"],
    ["Package-Lock.JSON", "npm"],
    ["YARN.LOCK", "yarn"],
  ])("matches %s case-insensitively as %s", (basename, manager) => {
    // The same repository can be checked out on a volume where case is not significant. A case-sensitive lookup would
    // report a correctly configured project as undeclared on one machine and not another.
    expect(managerForLockfile(basename)).toBe(manager);
  });

  it.each<string>([
    "pnpm-lock.yml",
    "package-lock.yaml",
    "deno.lock",
    "Cargo.lock",
    "pnpm-lock.yaml.bak",
    "",
  ])("returns undefined for %s", (basename) => {
    // An unrecognised lockfile is evidence, not identity. Returning a manager here would be a guess, and detection
    // would then report a confident answer about a tool nobody named.
    expect(managerForLockfile(basename)).toBeUndefined();
  });

  it("resolves both npm lockfiles to the same manager", () => {
    // Their co-existence is not a conflict, and no precedence rule is needed — which is why the table can list both.
    expect(managerForLockfile("package-lock.json")).toBe(
      managerForLockfile("npm-shrinkwrap.json"),
    );
  });
});

describe("knownLockfiles", () => {
  it("lists every declared lockfile exactly once", () => {
    const declared = MANAGERS.flatMap(
      (name) => PACKAGE_MANAGER_POLICY[name].lockfiles,
    ).map((name) => name.toLowerCase());

    expect(knownLockfiles().slice().sort()).toStrictEqual(declared.sort());
    expect(new Set(knownLockfiles()).size).toBe(knownLockfiles().length);
  });

  it("returns a frozen array", () => {
    expect(Object.isFrozen(knownLockfiles())).toBe(true);
  });
});

describe("installCommandFor", () => {
  it.each<[PackageManagerName, string]>([
    ["npm", "npm ci"],
    ["pnpm", "pnpm install --frozen-lockfile"],
    ["yarn", "yarn install --immutable"],
    ["bun", "bun install --frozen-lockfile"],
  ])("names the lockfile-respecting invocation for %s", (manager, expected) => {
    expect(installCommandFor(manager)).toBe(expected);
  });

  it("derives the executable from the policy rather than restating it", () => {
    for (const name of MANAGERS) {
      const [executable] = PACKAGE_MANAGER_POLICY[name].executables;

      // Asserted before it is used, so the `startsWith` below cannot be satisfied by an empty string: an entry with no
      // executable is a table defect, and `findPolicyConflicts` reports it too.
      expect(executable).toBeDefined();
      if (executable === undefined) continue;

      expect(installCommandFor(name).startsWith(executable)).toBe(true);
    }
  });

  it("never recommends a plain install", () => {
    // A non-frozen install rewrites the lockfile, which is exactly the drift this check exists to detect. If a command
    // ever loses its frozen flag, this fails rather than shipping advice that causes the fault.
    const commands = MANAGERS.map((name) => installCommandFor(name));

    expect(commands.filter((command) => !command.includes(" "))).toStrictEqual(
      [],
    );
    expect(
      commands.filter((command) => command.endsWith(" install")),
    ).toStrictEqual([]);
    expect(
      commands.filter(
        (command) =>
          !(
            command.endsWith("ci") ||
            command.endsWith("--frozen-lockfile") ||
            command.endsWith("--immutable")
          ),
      ),
    ).toStrictEqual([]);
  });
});

describe("findPolicyConflicts", () => {
  it("accepts the shipped policy explicitly, matching the default", () => {
    expect(findPolicyConflicts(PACKAGE_MANAGER_POLICY)).toStrictEqual(
      findPolicyConflicts(),
    );
  });

  it("returns a frozen array", () => {
    expect(Object.isFrozen(findPolicyConflicts())).toBe(true);
  });

  it("reports a lockfile claimed by two managers", () => {
    // The dangerous case: detection would silently resolve it to whichever entry was indexed last, producing a
    // confident and wrong answer.
    const conflicts = findPolicyConflicts(
      policyWith({
        pnpm: { lockfiles: ["pnpm-lock.yaml", "package-lock.json"] },
      }),
    );

    expect(conflicts).toContainEqual({
      kind: "duplicate-lockfile",
      detail: "package-lock.json is claimed by both npm and pnpm",
    });
  });

  it("reports an executable claimed by two managers", () => {
    const conflicts = findPolicyConflicts(
      policyWith({ yarn: { executables: ["npm"] } }),
    );

    expect(conflicts).toContainEqual({
      kind: "duplicate-executable",
      detail: "npm is claimed by both npm and yarn",
    });
  });

  it("reports a manager with no lockfile, which could never be detected", () => {
    const conflicts = findPolicyConflicts(
      policyWith({ yarn: { lockfiles: [] } }),
    );

    expect(conflicts).toContainEqual({
      kind: "no-lockfile",
      detail: "yarn declares no lockfile and could never be detected",
    });
  });

  it("reports a manager with no executable, which could never be verified", () => {
    const conflicts = findPolicyConflicts(
      policyWith({ bun: { executables: [] } }),
    );

    expect(conflicts).toContainEqual({
      kind: "no-executable",
      detail: "bun declares no executable and could never be verified",
    });
  });

  it("reports every defect rather than the first", () => {
    // A caller fixing a table wants the whole list; stopping at the first would mean one round trip per mistake.
    const conflicts = findPolicyConflicts(
      policyWith({ yarn: { lockfiles: [], executables: ["npm"] } }),
    );

    expect(conflicts.length).toBeGreaterThanOrEqual(2);
    expect(conflicts.map((conflict) => conflict.kind)).toStrictEqual(
      expect.arrayContaining(["no-lockfile", "duplicate-executable"]),
    );
  });

  it("is case-insensitive about duplicate lockfiles", () => {
    // The index lower-cases, so `YARN.LOCK` and `yarn.lock` collide at lookup time even though the strings differ. A
    // case-sensitive check here would miss the only kind of duplicate that can actually happen.
    const conflicts = findPolicyConflicts(
      policyWith({
        bun: { lockfiles: ["bun.lockb", "bun.lock", "YARN.LOCK"] },
      }),
    );

    expect(conflicts).toContainEqual({
      kind: "duplicate-lockfile",
      detail: "YARN.LOCK is claimed by both yarn and bun",
    });
  });
});

describe("PACKAGE_MANAGER_POLICY_DOC", () => {
  it("points at the document the parity test reads", () => {
    // Held here rather than in the test so that moving the document fails in one obvious place. The contract test
    // opens this path and compares its table with the policy above.
    expect(PACKAGE_MANAGER_POLICY_DOC).toBe(
      "docs/architecture/package-managers.md",
    );
    expect(PACKAGE_MANAGER_POLICY_DOC.startsWith("/")).toBe(false);
  });
});
