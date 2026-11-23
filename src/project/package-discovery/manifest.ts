/**
 * Reading and validating a project's manifest.
 *
 * This module owns every question about the contents of `package.json`, including which package manager
 * the project uses. That last one is here rather than in project discovery because it is a property of the
 * manifest — or of the lockfile sitting beside it — rather than of the project's directory shape.
 */
import { join } from "node:path";

import {
  DependencySection,
  PackageManager,
  type PackageManagerInfo,
} from "../../core/domain/index.js";
import { isFile, readJson } from "../../core/filesystem/index.js";

import { asRecord } from "./record.js";

const MANIFEST_NAME = "package.json";

/**
 * Lockfiles, in precedence order when more than one is present.
 *
 * An order rather than a "found any" check: a repository part-way through a migration commonly has two,
 * and the newer one describes the manager the project is moving towards.
 *
 * The manager is typed rather than spelled, so a typo in this table is a compile error instead of a
 * lookup that silently never matches.
 */
const LOCKFILES: readonly {
  readonly file: string;
  readonly manager: PackageManager;
}[] = [
  { file: "package-lock.json", manager: PackageManager.Npm },
  { file: "pnpm-lock.yaml", manager: PackageManager.Pnpm },
  { file: "yarn.lock", manager: PackageManager.Yarn },
  { file: "bun.lockb", manager: PackageManager.Bun },
];

type DependencyMap = Readonly<Record<string, string>>;

/**
 * The parts of a manifest QAT uses. Not a copy of the file: a field absent from this type is a field no
 * consumer reads, and adding one is a decision about what the tool needs rather than about what npm allows.
 */
export interface ProjectManifest {
  /** Present only when the manifest declared a string. A manifest without one is legal. */
  readonly name?: string;
  readonly version?: string;
  readonly private: boolean;
  readonly packageManager?: PackageManagerInfo;
  /**
   * Declared workspace patterns, exactly as written — `packages/*` and friends.
   *
   * Reported, never expanded. Expanding them means listing directories and matching globs, which is the
   * recursive discovery this module exists to avoid: a command run at a workspace root would start
   * choosing a package on the user's behalf. The MVP behaviour is to describe the root and let the reader
   * name the package. See ADR-0017.
   */
  readonly workspaces: readonly string[];
  readonly sections: Readonly<Record<DependencySection, DependencyMap>>;
}

/**
 * Reads the manifest at the project root.
 *
 * @returns `undefined` when there is no manifest. That is legal — a Cypress project may consist of a
 *   configuration file and specs with Cypress installed globally or hoisted from a workspace — and the
 *   caller falls back to the directory name.
 * @throws {FilesystemError} `QAT5004` when the file exists and is not valid JSON. A malformed manifest is a
 *   different problem from a missing one, has a different fix, and must not be reported as absence.
 */
export async function readManifest(
  root: string,
): Promise<ProjectManifest | undefined> {
  const path = join(root, MANIFEST_NAME);

  if (!(await isFile(path))) return undefined;

  const record = asRecord(await readJson<unknown>(path));

  // Read into locals rather than narrowing through an optional chain: a mirrored access cannot be
  // narrowed, and `record['name']` twice reads as though the check and the use are unrelated.
  const rawName: unknown = record?.["name"];
  const rawVersion: unknown = record?.["version"];

  const name = typeof rawName === "string" ? rawName : undefined;
  const version = typeof rawVersion === "string" ? rawVersion : undefined;

  const packageManager = await detectPackageManager(root, record);

  return {
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
    // Only a literal `true` counts. `"yes"`, `1` and `"true"` are all mistakes, and treating them as
    // private would change how the project is described on the strength of a typo.
    private: record?.["private"] === true,
    ...(packageManager === undefined ? {} : { packageManager }),
    workspaces: readWorkspaces(record),
    sections: {
      [DependencySection.Dependencies]: readSection(
        record,
        DependencySection.Dependencies,
      ),
      [DependencySection.DevDependencies]: readSection(
        record,
        DependencySection.DevDependencies,
      ),
      [DependencySection.OptionalDependencies]: readSection(
        record,
        DependencySection.OptionalDependencies,
      ),
      [DependencySection.PeerDependencies]: readSection(
        record,
        DependencySection.PeerDependencies,
      ),
    },
  };
}

/**
 * Reads one dependency map, keeping only entries whose value is a string.
 *
 * A non-string version — a number, an object, `null` — is a defect in the manifest. Dropping it means the
 * package is reported as not declared, which is what a reader would conclude from a broken entry anyway,
 * and it keeps every consumer free of a `string | undefined` version.
 */
function readSection(
  record: Record<string, unknown> | undefined,
  section: DependencySection,
): DependencyMap {
  const source = asRecord(record?.[section]);
  const entries: Record<string, string> = {};

  if (source === undefined) return entries;

  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string") entries[name] = value;
  }

  return entries;
}

/**
 * Reads the workspace declaration.
 *
 * Two shapes are legal: a bare array, and an object with `packages`. Yarn introduced the second and npm
 * accepts both, so a reader that understands only one describes half the workspaces in existence.
 */
function readWorkspaces(
  record: Record<string, unknown> | undefined,
): readonly string[] {
  const declared: unknown = record?.["workspaces"];

  const list = Array.isArray(declared)
    ? declared
    : asRecord(declared)?.["packages"];

  if (!Array.isArray(list)) return [];

  return list.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Detects the package manager, preferring an explicit declaration over a lockfile.
 *
 * A declared manager wins because a lockfile left behind after a migration implies a tool the project no
 * longer uses, and remediation built on that would name the wrong command.
 */
async function detectPackageManager(
  root: string,
  record: Record<string, unknown> | undefined,
): Promise<PackageManagerInfo | undefined> {
  const declared: unknown = record?.["packageManager"];

  if (typeof declared === "string") {
    // `name@version`; the name may be scoped, so split from the right.
    const separator = declared.lastIndexOf("@");
    const name = separator > 0 ? declared.slice(0, separator) : declared;

    if (isKnownPackageManager(name)) return { name, declared: true };
  }

  for (const { file, manager } of LOCKFILES) {
    if (await isFile(join(root, file)))
      return { name: manager, declared: false, lockfile: file };
  }

  return undefined;
}

function isKnownPackageManager(value: string): value is PackageManager {
  return Object.values(PackageManager).includes(value as PackageManager);
}
