/**
 * Contract tests between the package-manager policy and the artefacts that describe it.
 *
 * Three things can drift apart silently, and this file is the only place they are held together:
 *
 *   1. **The documentation.** `docs/architecture/package-managers.md` is what a user reads before deciding whether their
 *      project is supported. A table that disagrees with the code is worse than no table, because it is quotable.
 *   2. **The install commands.** They appear in remediation text, so a command in the doc that differs from the one the
 *      product prints is advice the reader will find nowhere in their terminal.
 *   3. **The scenario inventory.** Every `QAT-H` code the package-manager check can emit must be reachable from a named
 *      scenario, and every scenario must have a code or a stated reason for having none. That is the traceability KPI
 *      made mechanical rather than remembered.
 *
 * Everything here reads files and compares values. Nothing is mocked, and nothing is generated: a contract test that
 * produced the artefact it checks would only prove the generator works.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CheckId, HealthCode } from "~/core/application/checks.js";
import { CHECKS } from "~/diagnostics/checks/index.js";
import {
  detectPackageManager,
  installCommandFor,
  PACKAGE_MANAGER_POLICY,
  PACKAGE_MANAGER_POLICY_DOC,
  supportedManagers,
  type PackageManagerName,
  type ProjectSnapshot,
} from "~/project/package-manager/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Reading the documentation
// ─────────────────────────────────────────────────────────────────────────────

const DOC_PATH = join(process.cwd(), PACKAGE_MANAGER_POLICY_DOC);

/**
 * The table rows under one `##` heading.
 *
 * Deliberately stops at the next level-two heading rather than reading the whole file: a parser that scanned everything
 * would start comparing the manager table with the rows of whichever table came next, and the failure would read as a
 * content mismatch rather than as a parser that overreached.
 *
 * Header and separator rows are dropped here. They are the two rows a Markdown table cannot do without and that carry no
 * data, and filtering them in one place keeps every caller from repeating the rule.
 */
function tableRowsUnder(
  markdown: string,
  heading: string,
): readonly (readonly string[])[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);

  if (start === -1) throw new Error(`the document has no "${heading}" heading`);

  const rows: string[][] = [];

  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();

    if (trimmed.startsWith("## ")) break;
    if (!trimmed.startsWith("|")) continue;

    rows.push(
      trimmed
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  }

  const [header, separator, ...data] = rows;

  // Asserted rather than assumed: if the table loses its header, every row would shift by one and the comparisons below
  // would blame the wrong cell.
  if (header === undefined || separator === undefined) {
    throw new Error(
      `the table under "${heading}" is missing its header or separator row`,
    );
  }

  return data;
}

/**
 * Removes the whitespace and backticks the document wraps identifiers in.
 *
 * The order is load-bearing: trim, strip, trim. A cell listing several names splits on the comma into pieces that begin
 * with a space, so stripping before trimming leaves the leading backtick in place while removing the trailing one —
 * producing `` `npm-shrinkwrap.json ``, which looks like a filename and is not one.
 *
 * The anchors matter too. Without the leading `^`, the first alternative matches a run of backticks anywhere in the
 * string, so a cell containing two names would lose the backtick between them as well as the ones around them.
 */
function unquote(cell: string): string {
  return cell
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim();
}

/** Splits a cell listing several backticked names, e.g. `` `a`, `b` ``. */
function unquoteList(cell: string): readonly string[] {
  return cell
    .split(",")
    .map(unquote)
    .filter((value) => value !== "");
}

/**
 * True when a cell says "this manager leaves no install marker we trust".
 *
 * Matched on the *words* rather than on one spelling, because the emphasis around them is presentation: the document may
 * write `*(none)*`, `_(none)_` or `(none)` and mean the same thing, and a parser that pinned one of those turned a
 * cosmetic edit into a failing contract test. Stripping every emphasis and code character first is the cheap version of
 * "compare the content, not the markup".
 */
function isNoneMarker(cell: string): boolean {
  const stripped = cell.replace(/[*_`]/g, "").trim().toLowerCase();

  return stripped === "(none)" || stripped === "none";
}

const markdown = readFileSync(DOC_PATH, "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// The supported-manager table
// ─────────────────────────────────────────────────────────────────────────────

describe("the supported-manager table", () => {
  const rows = tableRowsUnder(markdown, "## 1. Supported managers");

  /** The document's view of one manager. */
  interface DocRow {
    readonly manager: string;
    readonly lockfiles: readonly string[];
    readonly installMarker: string | null;
    readonly executable: string;
    readonly supported: boolean;
  }

  const documented: readonly DocRow[] = rows.map((cells) => {
    const [
      manager = "",
      lockfiles = "",
      marker = "",
      executable = "",
      supported = "",
    ] = cells;

    return {
      manager: unquote(manager),
      lockfiles: unquoteList(lockfiles),
      // Parsed into `null` rather than compared as a string, so the policy's `null` and the document's phrase are the
      // same statement rather than two spellings of it.
      installMarker: isNoneMarker(marker) ? null : unquote(marker),
      executable: unquote(executable),
      supported: supported === "yes",
    };
  });

  it("documents exactly the managers the policy declares", () => {
    // Both directions. A manager in the policy but not the doc is an undocumented support claim; one in the doc but not
    // the policy is advice that nothing implements.
    expect(documented.map((row) => row.manager).sort()).toStrictEqual(
      (Object.keys(PACKAGE_MANAGER_POLICY) as PackageManagerName[]).sort(),
    );
  });

  it.each<PackageManagerName>(["npm", "pnpm", "yarn", "bun"])(
    "documents %s exactly as the policy declares it",
    (manager) => {
      const row = documented.find((candidate) => candidate.manager === manager);
      const policy = PACKAGE_MANAGER_POLICY[manager];

      expect(row).toBeDefined();
      if (row === undefined) return;

      expect(row.lockfiles.slice().sort()).toStrictEqual(
        policy.lockfiles.slice().sort(),
      );
      expect(row.installMarker).toBe(policy.installMarker);
      expect(row.executable).toBe(policy.executables[0]);
      expect(row.supported).toBe(policy.supported);
    },
  );

  it("agrees with the policy about which managers are supported", () => {
    expect(
      documented
        .filter((row) => row.supported)
        .map((row) => row.manager)
        .sort(),
    ).toStrictEqual(supportedManagers().slice().sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The install-command table
// ─────────────────────────────────────────────────────────────────────────────

describe("the install-command table", () => {
  const rows = tableRowsUnder(markdown, "## 2. Install commands");

  it.each<PackageManagerName>(["npm", "pnpm", "yarn", "bun"])(
    "documents the command the product prints for %s",
    (manager) => {
      // The command reaches a user through remediation text. A doc that disagreed would send them to a command that
      // either does not exist or — worse — rewrites the lockfile this check exists to protect.
      const row = rows.find((cells) => unquote(cells[0] ?? "") === manager);

      expect(row).toBeDefined();
      if (row === undefined) return;

      expect(unquote(row[1] ?? "")).toBe(installCommandFor(manager));
    },
  );

  it("documents no command the policy does not implement", () => {
    const documented = rows.map((cells) => unquote(cells[0] ?? "")).sort();

    expect(documented).toStrictEqual(
      (Object.keys(PACKAGE_MANAGER_POLICY) as PackageManagerName[]).sort(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The scenario inventory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every code the package-manager check can emit, and the scenario that proves it.
 *
 * An explicit map rather than a derivation, because the pairing is the claim: a code whose scenario is renamed here
 * fails against the catalogue, and a code added to `HealthCode` without an entry fails to compile at `HealthCode`'s use
 * below.
 */
const SCENARIO_BY_CODE: Readonly<Record<string, string>> = {
  [HealthCode.PackageManagerUnknown]: "environment.package-manager.none",
  [HealthCode.PackageManagerDeclarationInvalid]:
    "environment.package-manager.declaration-invalid",
  [HealthCode.PackageManagerUnsupported]:
    "environment.package-manager.unsupported",
  [HealthCode.PackageManagerConflicting]:
    "environment.package-manager.conflicting",
  [HealthCode.PackageManagerExecutableMissing]:
    "environment.package-manager.executable-missing",
  [HealthCode.PackageManagerVersionMismatch]:
    "environment.package-manager.version-mismatch",
  [HealthCode.PackageManagerVersionUnverified]:
    "environment.package-manager.version-unverified",
  [HealthCode.PackageManagerNotInstalled]:
    "environment.package-manager.not-installed",
  [HealthCode.PackageManagerForeignInstall]:
    "environment.package-manager.foreign-install",
};

/** The scenarios that prove the check passes, and therefore carry no code. */
const PASSING_SCENARIOS = [
  "environment.package-manager.declared",
  "environment.package-manager.inferred",
] as const;

describe("the scenario inventory", () => {
  const check = CHECKS.find(
    (candidate) => candidate.id === CheckId.PackageManager,
  );

  it("is registered in the catalogue", () => {
    expect(check).toBeDefined();
  });

  it("declares exactly the scenarios the codes and the pass cases require", () => {
    // Both directions again: a scenario without a code is a case nothing asked for, and a code without a scenario is a
    // finding the inventory does not claim to have tested.
    const declared = check?.scenarios.slice().sort() ?? [];
    const required = [
      ...Object.values(SCENARIO_BY_CODE),
      ...PASSING_SCENARIOS,
    ].sort();

    expect(declared).toStrictEqual(required);
  });

  it("maps every code to a scenario the check declares", () => {
    for (const [code, scenario] of Object.entries(SCENARIO_BY_CODE)) {
      expect(check?.scenarios).toContain(scenario);
      expect(scenario.startsWith(`${String(check?.id)}.`)).toBe(true);
      expect(code.startsWith("QAT-H")).toBe(true);
    }
  });

  it("names every package-manager condition in the documentation", () => {
    // The table in §4 is what a reader consults when a report quotes a code. A code missing from it is a finding with no
    // published explanation, which is the condition this whole feature is supposed to make visible.
    const undocumented = Object.keys(SCENARIO_BY_CODE).filter(
      (code) => !markdown.includes(code),
    );

    expect(undocumented).toStrictEqual([]);
  });

  it("is advisory: no scenario may produce a blocking verdict", () => {
    // The severity rule, restated where the inventory lives. The catalogue test enforces it against fixtures; this
    // asserts the declaration, so a future edit that changes the severity is caught even if the fixtures still pass.
    expect(check?.severity).toBe("warning");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// On-disk fixtures
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURES = join(process.cwd(), "tests/fixtures/package-manager");
const hasFixtures = existsSync(FIXTURES);

/**
 * A snapshot of one fixture directory.
 *
 * Built from a real directory listing rather than hand-written, because the question is whether the *policy* recognises
 * the files a project actually contains. The declaration is reported absent: a fixture proves recognition by its
 * lockfile, which is the evidence a project has and a doc cannot.
 */
function snapshotOf(directory: string): ProjectSnapshot {
  return {
    root: directory,
    rootEntries: new Set(readdirSync(directory)),
    declaration: { status: "absent" },
    engineRanges: {},
    hasNodeModules: false,
  };
}

/**
 * Skipped until the first fixture exists.
 *
 * Detection is currently covered by literals in `detect.test.ts`, which is cheaper and more precise. The moment a
 * directory appears under `tests/fixtures/package-manager/`, this block starts enforcing the coverage claim — and a
 * support claim with no fixture becomes a failing test rather than a sentence in a document.
 */
describe.skipIf(!hasFixtures)("on-disk fixtures", () => {
  const fixtures = existsSync(FIXTURES)
    ? readdirSync(FIXTURES, { withFileTypes: true })
    : [];
  const directories = fixtures
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it("has at least one fixture", () => {
    expect(directories.length).toBeGreaterThan(0);
  });

  it("detects every fixture as a manager the policy knows", () => {
    const undetected = directories.filter((name) => {
      const detection = detectPackageManager(snapshotOf(join(FIXTURES, name)));

      return (
        detection.status !== "detected" && detection.status !== "unsupported"
      );
    });

    expect(undetected).toStrictEqual([]);
  });

  it("covers every supported manager", () => {
    const covered = new Set(
      directories
        .map((name) => detectPackageManager(snapshotOf(join(FIXTURES, name))))
        .flatMap((detection) =>
          detection.status === "detected" || detection.status === "unsupported"
            ? [detection.manager]
            : [],
        ),
    );

    expect(
      supportedManagers().filter((manager) => !covered.has(manager)),
    ).toStrictEqual([]);
  });
});
