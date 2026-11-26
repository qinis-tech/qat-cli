/**
 * Integration tests for the package-manager health check.
 *
 * This is the only place the whole chain runs end to end with a real filesystem: the snapshot collector reads a
 * temporary project, detection decides identity from what it found, assessment turns that into named issues, the
 * catalogue check picks the rung to report, and the guidance table renders the sentence a user would read.
 *
 * Each layer is already unit-tested against literals. The question here is different and cannot be answered by those
 * tests: do the layers agree about the *shape* of what they hand one another? A collector returning basenames, a
 * detector expecting them, an assessment carrying a `Detection` and a check reading a `PackageManagerFacts` — every one
 * of those joins compiles under either interpretation, and only a run through all of them proves they match.
 *
 * ## The mapping in `toPackageManagerFacts` is a stand-in
 *
 * The check reads facts; something has to build them from the snapshot, the detection and the executable state. That
 * gatherer does not exist yet, so this file contains the mapping — and says so, rather than hiding it in a helper that
 * looks like production code. When the gatherer lands, this function is deleted and replaced by an import, which is the
 * only change the assertions below should ever need.
 *
 * ## What is faked, and what is not
 *
 * Only the machine: the executable availability result. Everything about the project is real — real files, real
 * `readdir`, real JSON parsing — because "does the policy recognise a `pnpm-lock.yaml` that is actually on disk" is
 * exactly the question an integration test exists to ask.
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { CheckId, HealthCode } from "~/core/application/checks.js";
import {
  CHECKS,
  type CheckFacts,
  type PackageManagerFacts,
} from "~/diagnostics/checks/index.js";
import {
  assessPackageManagerHealth,
  createSnapshotCollector,
  detectPackageManager,
  type Detection,
  type ExecutableAvailability,
  type ProjectSnapshot,
  type SnapshotFileSystem,
} from "~/project/package-manager/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/** Every temporary project this file created, removed once at the end. */
const created: string[] = [];

afterAll(async () => {
  await Promise.all(
    created.map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * Writes a temporary project.
 *
 * Keys are paths relative to the root; a key ending in `/` creates a directory, anything else a file with the given
 * contents. Nested paths create their parents, so a fixture reads as the layout it describes rather than as a list of
 * `mkdir` calls.
 */
async function project(entries: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-pm-"));
  created.push(root);

  for (const [relative, contents] of Object.entries(entries)) {
    const target = join(root, relative);

    if (relative.endsWith("/")) {
      await mkdir(target, { recursive: true });
      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }

  return root;
}

/**
 * The snapshot collector's filesystem, backed by the real one.
 *
 * Three lines in production and three here, because the collector takes a narrow port rather than importing `fs` — which
 * is what lets this file use a real disk while a unit test uses an in-memory map.
 */
const files: SnapshotFileSystem = {
  readDirectory: async (path) => {
    const entries = await readdir(path, { withFileTypes: true });

    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  },
  readFile: (path) => readFile(path, "utf8"),
};

const collector = createSnapshotCollector(files);

/**
 * The check, taken from the catalogue rather than imported directly.
 *
 * The runner resolves it the same way, so a rename or a removal fails here for the same reason it would fail in a
 * report — and this file does not need the catalogue to export one more name for its benefit.
 *
 * The local is named `check`, not `found`: `found` is the availability fixture below, and a shadowed fixture is the
 * kind of collision that turns a test failure into a compiler message about the wrong line.
 */
const packageManagerCheck = (() => {
  const check = CHECKS.find(
    (candidate) => candidate.id === CheckId.PackageManager,
  );

  if (check === undefined)
    throw new Error(
      "the catalogue no longer contains the package-manager check",
    );

  return check;
})();

/** A located binary that answered. */
function found(version?: string): ExecutableAvailability {
  return {
    status: "found",
    path: "/fake/bin/tool",
    version:
      version === undefined
        ? { status: "not-probed" }
        : { status: "read", value: version },
  };
}

/** A binary that is not installed. */
const MISSING: ExecutableAvailability = { status: "missing" };

/**
 * Builds the fact group the check reads.
 *
 * A stand-in for the gatherer that will own this mapping — see the note at the top of the file. Written as one function
 * with one return, so the compiler checks the whole group against the type instead of checking five spreads of it.
 *
 * Optional members are added by conditional spread rather than assigned `undefined`. Under `exactOptionalPropertyTypes`
 * those are different states — "this fact was not gathered" versus "this fact is present and empty" — and the check
 * reads that difference: a `required` that is absent means the project declared nothing, while one that is present with
 * an empty range means the declaration could not be read.
 */
function toPackageManagerFacts(
  snapshot: ProjectSnapshot,
  detection: Detection,
  executable: ExecutableAvailability,
  assessment: ReturnType<typeof assessPackageManagerHealth>,
): PackageManagerFacts {
  const required = requiredOf(snapshot, detection);
  const foreign = assessment.issues.find(
    (issue) => issue.code === "PM_FOREIGN_NODE_MODULES",
  );

  return {
    selection: selectionOf(snapshot, detection),
    lockfiles: lockfilesOf(detection),
    executable: executableOf(executable),
    installState: installStateOf(assessment),
    ...(required === undefined ? {} : { required }),
    ...(foreign === undefined
      ? {}
      : {
          foreignMarker: {
            marker: String(foreign.detail["marker"]),
            createdBy: String(foreign.detail["createdBy"]),
          },
        }),
  };
}

/** Detection → the lockfile names the finding will quote. Total over the union. */
function lockfilesOf(detection: Detection): readonly string[] {
  switch (detection.status) {
    case "conflicting":
    case "undeclared":
      return detection.lockfiles;
    case "detected":
    case "unsupported":
      return detection.lockfile === "" ? [] : [detection.lockfile];
  }
}

/** Detection → the check's four mutually exclusive stories. */
function selectionOf(
  snapshot: ProjectSnapshot,
  detection: Detection,
): PackageManagerFacts["selection"] {
  switch (detection.status) {
    case "detected":
      return {
        status: "identified",
        name: detection.manager,
        declared: detection.declared,
      };
    case "conflicting":
      return {
        status: "conflicting",
        managers: detection.managers,
        lockfiles: detection.lockfiles,
      };
    case "unsupported":
      return { status: "unsupported", name: detection.manager };
    case "undeclared":
      return snapshot.declaration.status === "unparsable"
        ? {
            status: "undeclared",
            declaration: {
              raw: snapshot.declaration.raw,
              problem: snapshot.declaration.problem,
            },
          }
        : { status: "undeclared" };
  }
}

/**
 * Availability → the flat executable fact.
 *
 * Returned as `NonNullable<…>` rather than as `PackageManagerFacts['executable']`: the member is optional in the group
 * (an unidentified manager has no binary to describe), but this function is *total* — every variant of
 * `ExecutableAvailability` produces a fact, including `missing`, which becomes `{ resolved: false }`. Annotating it with
 * the optional type would tell the caller it might be absent, and under `exactOptionalPropertyTypes` the compiler would
 * then refuse to place the result in the group at all.
 */
function executableOf(
  executable: ExecutableAvailability,
): NonNullable<PackageManagerFacts["executable"]> {
  if (executable.status === "missing") return { resolved: false };

  switch (executable.version.status) {
    case "read":
      return { resolved: true, version: executable.version.value };
    case "unreadable":
      return { resolved: true, reason: executable.version.reason };
    case "not-probed":
      return { resolved: true, reason: "not-probed" };
  }
}

/**
 * Snapshot → the version the project expects.
 *
 * A `packageManager` pin wins over an `engines` range, matching the precedence the assessment applies — this function
 * exists so the check compares the same authority the assessment did, and the two cannot disagree about which document
 * was quoted.
 */
function requiredOf(
  snapshot: ProjectSnapshot,
  detection: Detection,
): PackageManagerFacts["required"] {
  const pinned =
    snapshot.declaration.status === "parsed"
      ? snapshot.declaration.declaration.version
      : undefined;

  if (pinned !== undefined) {
    return { range: pinned, origin: "package.json#packageManager" };
  }

  const manager =
    detection.status === "detected" ? detection.manager : undefined;
  const range =
    manager === undefined ? undefined : snapshot.engineRanges[manager];

  return range === undefined
    ? undefined
    : { range, origin: `package.json#engines.${String(manager)}` };
}

/** Assessment → the flat install state the check reads. */
function installStateOf(
  assessment: ReturnType<typeof assessPackageManagerHealth>,
): PackageManagerFacts["installState"] {
  if (
    assessment.issues.some((issue) => issue.code === "PM_FOREIGN_NODE_MODULES")
  )
    return "foreign";
  if (
    assessment.issues.some(
      (issue) => issue.code === "PM_DEPENDENCIES_NOT_INSTALLED",
    )
  )
    return "absent";

  return "installed";
}

/** Runs the whole chain for one project and returns every stage, so a failure can name the layer that produced it. */
async function evaluate(root: string, executable: ExecutableAvailability) {
  const snapshot = await collector.capture(root);
  const detection = detectPackageManager(snapshot);
  const assessment = assessPackageManagerHealth({
    snapshot,
    detection,
    executable,
  });

  const facts: CheckFacts = {
    packageManager: toPackageManagerFacts(
      snapshot,
      detection,
      executable,
      assessment,
    ),
  };

  return {
    snapshot,
    detection,
    assessment,
    verdict: packageManagerCheck.evaluate(facts),
  };
}

/** The finding a warning verdict carries, or a failure naming what actually came back. */
function findingOf(verdict: ReturnType<typeof packageManagerCheck.evaluate>) {
  expect(verdict.verdict).toBe("warn");
  if (verdict.verdict === "pass") throw new Error("expected a warning");

  return verdict.finding;
}

/** A manifest declaring a manager, as Corepack writes it. */
function manifest(extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    { name: "fixture", version: "1.0.0", ...extra },
    null,
    2,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The healthy case
// ─────────────────────────────────────────────────────────────────────────────

describe("a consistent project", () => {
  it("passes, having read the manager from the declaration and confirmed it with the lockfile", async () => {
    const root = await project({
      "package.json": manifest({ packageManager: "pnpm@9.1.0" }),
      "pnpm-lock.yaml": "",
      "node_modules/.pnpm/": "",
    });

    const { detection, verdict } = await evaluate(root, found("9.1.0"));

    expect(detection).toStrictEqual({
      status: "detected",
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      declared: true,
    });
    expect(verdict).toStrictEqual({ verdict: "pass" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity, through the real filesystem
// ─────────────────────────────────────────────────────────────────────────────

describe("identity problems", () => {
  it("reports two lockfiles and names both of them in the message", async () => {
    // The end-to-end value: the finding names the files the user can see in their own directory listing, which only
    // holds if the collector, the detector and the guidance table agree about what a lockfile basename is.
    const root = await project({
      "package.json": manifest(),
      "package-lock.json": "{}",
      "pnpm-lock.yaml": "",
    });

    const finding = findingOf((await evaluate(root, found())).verdict);

    expect(finding).toMatchObject({
      code: HealthCode.PackageManagerConflicting,
    });
    expect(finding.explanation).toContain("package-lock.json");
    expect(finding.explanation).toContain("pnpm-lock.yaml");
  });

  it("reports nothing identified as unknown, and stays a warning", async () => {
    const root = await project({ "package.json": manifest() });

    const { verdict } = await evaluate(root, found());
    const finding = findingOf(verdict);

    expect(finding).toMatchObject({ code: HealthCode.PackageManagerUnknown });
    // Advisory, not blocking: the project may run perfectly; we simply cannot say how it installs.
    expect(verdict.verdict).not.toBe("fail");
  });

  it("reports an unsupported manager by name rather than as unidentified", async () => {
    const root = await project({
      "package.json": manifest({ packageManager: "bun@1.1.0" }),
      "bun.lockb": "",
    });

    const finding = findingOf((await evaluate(root, found())).verdict);

    expect(finding).toMatchObject({
      code: HealthCode.PackageManagerUnsupported,
    });
    expect(finding.explanation).toContain("bun");
  });

  it("survives a manifest that is not JSON, falling back to the lockfile", async () => {
    // The collector degrades to "nothing declared" rather than throwing, because the configuration check owns that
    // error and duplicating it would produce two findings for one cause.
    const root = await project({
      "package.json": "{ not json",
      "pnpm-lock.yaml": "",
      "node_modules/.pnpm/": "",
    });

    const { detection, verdict } = await evaluate(root, found("9.1.0"));

    expect(detection).toMatchObject({
      status: "detected",
      manager: "pnpm",
      declared: false,
    });
    expect(verdict).toStrictEqual({ verdict: "pass" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tooling and installation
// ─────────────────────────────────────────────────────────────────────────────

describe("tooling and installation", () => {
  it("reports a missing binary with a remedy naming the shim that ships with Node", async () => {
    const root = await project({
      "package.json": manifest({ packageManager: "pnpm@9.1.0" }),
      "pnpm-lock.yaml": "",
      "node_modules/.pnpm/": "",
    });

    const finding = findingOf((await evaluate(root, MISSING)).verdict);

    expect(finding).toMatchObject({
      code: HealthCode.PackageManagerExecutableMissing,
    });
    expect(finding.remediation).toContain("corepack enable");
  });

  it("reports dependencies not installed with the command that respects the lockfile", async () => {
    // The command comes from the policy table, so this assertion fails if guidance ever inlines its own copy: the
    // frozen-lockfile flag is the whole point of quoting it from one place.
    const root = await project({
      "package.json": manifest({ packageManager: "pnpm@9.1.0" }),
      "pnpm-lock.yaml": "",
    });

    const finding = findingOf((await evaluate(root, found("9.1.0"))).verdict);

    expect(finding).toMatchObject({
      code: HealthCode.PackageManagerNotInstalled,
    });
    expect(finding.remediation).toContain("pnpm install --frozen-lockfile");
  });

  it("reports a version that disagrees with the declared engines range", async () => {
    const root = await project({
      "package.json": manifest({ engines: { npm: ">=9.1.0 <10.0.0" } }),
      "package-lock.json": "{}",
      "node_modules/.package-lock.json": "{}",
    });

    const finding = findingOf((await evaluate(root, found("9.0.9"))).verdict);

    expect(finding).toMatchObject({
      code: HealthCode.PackageManagerVersionMismatch,
    });
    expect(finding.explanation).toContain("9.0.9");
    expect(finding.explanation).toContain(">=9.1.0 <10.0.0");
  });

  it("does not claim the dependencies are missing merely because node_modules exists unattributed", async () => {
    // The honest gap, asserted as a behaviour: presence of `node_modules` is not evidence that this manager created it,
    // so the state is `unknown` and produces no finding. A check that guessed `installed` here would be quiet about a
    // real problem; one that guessed `absent` would raise a false alarm on every healthy project.
    const root = await project({
      "package.json": manifest({ packageManager: "pnpm@9.1.0" }),
      "pnpm-lock.yaml": "",
      "node_modules/": "",
    });

    const { assessment, verdict } = await evaluate(root, found("9.1.0"));

    expect(assessment.issues).toStrictEqual([]);
    expect(verdict).toStrictEqual({ verdict: "pass" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-functional guarantees
// ─────────────────────────────────────────────────────────────────────────────

describe("guarantees", () => {
  it("rejects rather than reporting a healthy project when the root cannot be read", async () => {
    // A directory we cannot inspect is a failed precondition. The workflow skips the check; the important part is that
    // it does not come back as a pass, which is what a silently empty snapshot would produce.
    await expect(
      collector.capture(join(tmpdir(), "qat-does-not-exist-7f3a")),
    ).rejects.toThrow();
  });

  it("writes nothing, and creates nothing", async () => {
    const root = await project({
      "package.json": manifest({ packageManager: "pnpm@9.1.0" }),
      "pnpm-lock.yaml": "",
    });
    const before = await tree(root);

    await evaluate(root, found("9.1.0"));

    expect(await tree(root)).toStrictEqual(before);
  });

  it("runs against a read-only project", async () => {
    // The strongest form of "does not write": a directory the process cannot write to.
    const root = await project({
      "package.json": manifest({ packageManager: "pnpm@9.1.0" }),
      "pnpm-lock.yaml": "",
    });

    await chmod(root, 0o555);

    try {
      await expect(evaluate(root, found("9.1.0"))).resolves.toBeDefined();
    } finally {
      // Restored before cleanup, or `rm` cannot traverse it and the temporary directory leaks on every run.
      await chmod(root, 0o755);
    }
  }, 10_000);

  it("never leaks a credential or an absolute path into the finding", async () => {
    // `npm` reads `.npmrc` on install, and that file can hold a registry token. QAT never opens it — and the assertion
    // is on the rendered finding rather than on the intent, because the finding is what gets logged and pasted.
    const root = await project({
      "package.json": manifest({ packageManager: "pnpm@9.1.0" }),
      "pnpm-lock.yaml": "",
      ".npmrc": "//registry.npmjs.org/:_authToken=super-secret-token",
    });

    const finding = findingOf((await evaluate(root, MISSING)).verdict);
    const rendered = JSON.stringify(finding);

    expect(rendered).not.toContain("super-secret-token");
    expect(rendered).not.toContain(root);
  });

  it("is deterministic: the same project produces the same finding twice", async () => {
    const root = await project({
      "package.json": manifest(),
      "package-lock.json": "{}",
      "yarn.lock": "",
    });

    const first = findingOf((await evaluate(root, found())).verdict);
    const second = findingOf((await evaluate(root, found())).verdict);

    expect(first).toStrictEqual(second);
  });
});

/** Every path under a root, relative and sorted, so a before/after comparison is meaningful. */
async function tree(root: string, prefix = ""): Promise<readonly string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    paths.push(relative);

    if (entry.isDirectory()) paths.push(...(await tree(root, relative)));
  }

  return paths.sort();
}
