/**
 * Filesystem collector for the package-manager health check.
 *
 * This is the only module in `project/package-manager` that touches a disk. It
 * reads, and only reads: one directory listing of the project root and at most
 * one `package.json`. There is no writer, no temp file, no lockfile repair and
 * no install — a diagnostic that mutates the thing it inspects cannot be trusted
 * to describe it.
 *
 * Responsibility split:
 *
 *   snapshot.ts  (this file) — turn the filesystem into plain data, once
 *   detect.ts                — decide the manager from that data (pure)
 *   assess.ts                — decide health from that data (pure)
 *
 * Doing the I/O once, up front, is what makes the two decision steps pure and
 * therefore drivable from fixtures with no mocking at all. It also guarantees
 * every condition in the report describes the *same* instant of the filesystem,
 * so a concurrent install cannot produce a self-contradicting diagnosis.
 */

import { join } from "node:path";

import type {
  DeclarationParseResult,
  PackageManagerDeclaration,
  PackageManagerName,
  PackageManagerSnapshotPort,
  ProjectSnapshot,
} from "./contracts.js";
import { PACKAGE_MANAGER_POLICY } from "./policy.js";

// ─────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────

/** One entry of a directory listing, as reported by the filesystem. */
export interface DirectoryEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  /**
   * Tracked because a workspace can legitimately have `node_modules` as a
   * symlink. Ignoring it would report "dependencies not installed" for a project
   * that is fully installed — a false positive that erodes trust in every other
   * finding.
   */
  readonly isSymbolicLink: boolean;
}

/**
 * The narrow slice of filesystem behaviour this collector needs.
 *
 * Declared structurally rather than imported concretely so the module stays
 * unit-testable with an in-memory fake, and so composition can bind it to the
 * core filesystem abstraction without this file knowing about it. Two operations
 * is the whole surface: no `stat`, no globbing, no recursive walk.
 */
export interface SnapshotFileSystem {
  readDirectory(path: string): Promise<readonly DirectoryEntry[]>;
  readFile(path: string): Promise<string>;
}

/**
 * Upper bound on the manifest we are willing to parse.
 *
 * A `package.json` larger than this is either generated or hostile; either way,
 * loading it to read two fields risks the whole doctor run. We degrade to
 * "no declaration" rather than letting a pathological file take the process
 * down — a missing signal, not a crash.
 */
export const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Field names read from the manifest; kept in one place for auditing. */
const MANIFEST_FILE = "package.json";
const NODE_MODULES = "node_modules";

// ─────────────────────────────────────────────────────────────────────────────
// Declaration parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Corepack-style names are lower-case identifiers. Upper-case or scoped values
 * are rejected rather than normalised, because Corepack itself rejects them —
 * accepting `PNPM@9.1.0` here would make QAT report a healthy project that
 * cannot install anything.
 */
const MANAGER_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Narrows an arbitrary string to a manager the policy recognises. */
function toManagerName(value: string): PackageManagerName | undefined {
  return Object.prototype.hasOwnProperty.call(PACKAGE_MANAGER_POLICY, value)
    ? (value as PackageManagerName)
    : undefined;
}

/**
 * Parses the `packageManager` field into something a check can act on.
 *
 * Expected shape: `name@exact-version[+hash]`. Three outcomes are kept distinct
 * because they produce three different messages:
 *
 *   absent      nothing was declared — advise the user to declare it
 *   malformed   the value cannot be used — quote it back verbatim
 *   unknown     a real manager outside our policy — say "not supported", not "broken"
 *
 * The hash suffix is stripped: it is an integrity pin, not a version, and
 * feeding it to the version comparator would produce a nonsense verdict.
 */
export function parseDeclaration(raw: unknown): DeclarationParseResult {
  if (raw === undefined || raw === null) return { status: "absent" };

  if (typeof raw !== "string") {
    return {
      status: "unparsable",
      raw: JSON.stringify(raw),
      problem: "malformed",
    };
  }

  const value = raw.trim();
  if (value === "") return { status: "unparsable", raw, problem: "malformed" };

  // `lastIndexOf` rather than `split('@')` so a stray '@' in the version part
  // cannot silently truncate the name.
  const separator = value.lastIndexOf("@");

  if (separator < 1) {
    const bare = toManagerName(value);
    return {
      status: "unparsable",
      raw: value,
      problem: bare === undefined ? "malformed" : "missing-version",
    };
  }

  const name = value.slice(0, separator);
  const remainder = value.slice(separator + 1);

  if (!MANAGER_NAME.test(name)) {
    return { status: "unparsable", raw: value, problem: "malformed" };
  }

  const manager = toManagerName(name);
  if (manager === undefined) {
    return { status: "unparsable", raw: value, problem: "unknown-manager" };
  }

  const version = remainder.split("+")[0]?.trim();
  if (!version) {
    return { status: "unparsable", raw: value, problem: "missing-version" };
  }

  const declaration: PackageManagerDeclaration = {
    name: manager,
    version,
    raw: value,
  };
  return { status: "parsed", declaration: Object.freeze(declaration) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest reading
// ─────────────────────────────────────────────────────────────────────────────

interface ManifestFields {
  readonly declaration: DeclarationParseResult;
  readonly engineRanges: Readonly<Partial<Record<PackageManagerName, string>>>;
}

/**
 * Reads the two manifest fields this check cares about.
 *
 * Any failure — missing file, unreadable file, invalid JSON, unexpected shape —
 * degrades to "nothing declared" instead of throwing. Rationale: a corrupt
 * manifest is already reported by the QAT configuration check, and duplicating
 * that error here would produce two findings for one cause. The snapshot must
 * describe what it could see, and say nothing about what it could not.
 */
async function readManifestFields(
  fs: SnapshotFileSystem,
  root: string,
): Promise<ManifestFields> {
  const empty: ManifestFields = {
    declaration: { status: "absent" },
    engineRanges: Object.freeze({}),
  };

  let contents: string;
  try {
    contents = await fs.readFile(join(root, MANIFEST_FILE));
  } catch {
    return empty; // absent or unreadable; a sibling check owns that error
  }

  if (contents.length > MAX_MANIFEST_BYTES) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return empty;
  }

  if (typeof parsed !== "object" || parsed === null) return empty;

  const manifest = parsed as { packageManager?: unknown; engines?: unknown };

  return {
    declaration: parseDeclaration(manifest.packageManager),
    engineRanges: extractEngineRanges(manifest.engines),
  };
}

/**
 * Pulls `engines.<manager>` ranges for managers we recognise.
 *
 * Unknown engine keys are ignored rather than reported: `engines.node` belongs
 * to the runtime check, and inventing a finding for every third-party key would
 * turn a focused diagnostic into noise.
 */
function extractEngineRanges(
  engines: unknown,
): Readonly<Partial<Record<PackageManagerName, string>>> {
  if (typeof engines !== "object" || engines === null) return Object.freeze({});

  const ranges: Partial<Record<PackageManagerName, string>> = {};

  for (const [key, value] of Object.entries(
    engines as Record<string, unknown>,
  )) {
    const manager = toManagerName(key);
    if (
      manager !== undefined &&
      typeof value === "string" &&
      value.trim() !== ""
    ) {
      ranges[manager] = value.trim();
    }
  }

  return Object.freeze(ranges);
}

// ─────────────────────────────────────────────────────────────────────────────
// Collector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the snapshot collector.
 *
 * `capture` takes an explicit root rather than reading `process.cwd()`: the
 * caller owns path resolution, so tests point at a fixture without mutating
 * global state and the collector never has to guess which project it is in.
 *
 * Failure policy, in two halves:
 *
 *   • Directory-level failure (missing or unreadable project root) is thrown.
 *     Nothing can be judged, so the caller treats it as a failed precondition
 *     and skips the check rather than reporting a healthy project.
 *   • File-level failure (corrupt or oversized manifest) is swallowed and
 *     becomes "nothing declared", because the surrounding project is still
 *     inspectable and another check owns that error.
 */
export function createSnapshotCollector(
  fs: SnapshotFileSystem,
): PackageManagerSnapshotPort {
  return {
    async capture(root: string): Promise<ProjectSnapshot> {
      // One listing carries everything: entry names, directory-ness for
      // `node_modules`, and lockfile presence. No per-entry `stat`, no second
      // pass — a doctor run must stay inside its responsiveness budget.
      const entries = await fs.readDirectory(root);

      const rootEntries = new Set(entries.map((entry) => entry.name));

      // Case-insensitive on purpose: the same repository may be checked out on a
      // volume where `Node_Modules` and `node_modules` are the same directory.
      // Symlinks count, because workspace layouts legitimately use them.
      const hasNodeModules = entries.some(
        (entry) =>
          entry.name.toLowerCase() === NODE_MODULES &&
          (entry.isDirectory || entry.isSymbolicLink),
      );

      const { declaration, engineRanges } = await readManifestFields(fs, root);

      // Frozen so nothing downstream can rewrite the evidence it is judging;
      // the Set is treated as immutable by convention — it is created here and
      // never handed out again.
      return Object.freeze({
        root,
        rootEntries,
        declaration,
        engineRanges,
        hasNodeModules,
      });
    },
  };
}
