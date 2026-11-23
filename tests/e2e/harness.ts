/**
 * Shared harness for the end-to-end suite.
 *
 * Not a test file. The suite's include pattern is `tests/e2e/**\/*.test.ts`, so this module is imported and never
 * collected.
 *
 * ## Cleanup is explicit, not automatic
 *
 * `removeTemporaryDirectories` is exported rather than registered as a hook here. A helper that registers hooks on
 * import is attributed to whichever file imported it, which works until the module is imported twice or lazily — and
 * the failure mode is a leaked temporary directory nobody looks for. Each file that creates a fixture calls
 * `afterAll(removeTemporaryDirectories)`, one line, visible at the top of the file it belongs to.
 *
 * ## Four project shapes, and why they are separate functions
 *
 * Each one exists because a different assertion needs it, and a single function with a flag per variation would need a
 * reader to reconstruct which combination produces what:
 *
 * - `temporaryProject` — a real single-package project: declared, installed, configured, with specs.
 * - `temporaryWarningProject` — the same, minus the manifest. Runnable, and imperfect.
 * - `temporaryWorkspaceMember` — a member inside a monorepo, with the install hoisted above it.
 * - `temporaryPackageLayout` — the compiled output beside a manifest, for testing version resolution rather than a
 *   project.
 */
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runProcess } from "~/core/process/index.js";

/** The built binary. `npm run test:e2e` builds first, so its absence is a build failure rather than a skip. */
export const CLI = fileURLToPath(
  new URL("../../dist/cli/index.js", import.meta.url),
);

/** The compiled output, for building a package layout that is not the repository. */
const DIST = fileURLToPath(new URL("../../dist", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../../package.json", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

let created: string[] = [];

export interface QatOptions {
  readonly cwd?: string;
}

/**
 * Runs the built binary.
 *
 * The tool's own process runner spawns the tool, which is the first place in this project where that happens.
 *
 * Exit code `1` from any of these means Node died before qat decided anything — an empty build, or an installation
 * whose imports cannot resolve. The evidence is in stderr, and every assertion in this suite reads the stream as well
 * as the code for that reason.
 */
export function qat(args: readonly string[], options: QatOptions = {}) {
  return runProcess({
    executable: process.execPath,
    args: [CLI, ...args],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
}

/** An empty directory, for the cases that need somewhere real that is not a project. */
export async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-e2e-"));
  created.push(root);

  return root;
}

export interface ProjectOptions {
  /** Whether the manifest declares Cypress. Defaults to true. */
  readonly declared?: boolean;
  /** Whether to write a supported configuration file. Defaults to true. */
  readonly configured?: boolean;
  /**
   * Files written verbatim, relative to the root — last, so they can override any of the defaults.
   *
   * The escape hatch that keeps this helper from growing an option per variation. A test that needs a legacy
   * configuration, a malformed manifest or an extra lockfile passes one entry rather than the helper learning about
   * each.
   */
  readonly extra?: Readonly<Record<string, string>>;
}

/**
 * The minimum that makes a directory a runnable Cypress project.
 *
 * By default Cypress is declared in `devDependencies` *and* installed under `node_modules`, which is the shape a real
 * single-package project has. `declared: false` produces the other shape — present on disk, absent from the manifest —
 * which is what a workspace member with a hoisted install looks like.
 */
export async function temporaryProject(
  options: ProjectOptions = {},
): Promise<string> {
  const declared = options.declared ?? true;
  const root = await temporaryDirectory();

  await mkdir(join(root, "cypress", "e2e"), { recursive: true });
  await mkdir(join(root, "node_modules", "cypress"), { recursive: true });

  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      ...(declared ? { devDependencies: { cypress: "^13.15.0" } } : {}),
    }),
  );

  if (options.configured ?? true) {
    await writeFile(join(root, "cypress.config.ts"), "export default {};\n");
  }

  await writeFile(
    join(root, "node_modules", "cypress", "package.json"),
    JSON.stringify({ name: "cypress", version: "13.15.0" }),
  );

  for (const [path, contents] of Object.entries(options.extra ?? {})) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  return root;
}

/**
 * A project that is runnable and imperfect: a configuration, an installed framework, and no manifest.
 *
 * The warning is the point of the fixture. A project with a blocker would let a report that printed only blockers pass
 * every assertion about warnings, because the warning would never be reached — and the difference between "reports
 * warnings" and "reports warnings when there is also an error" is the whole behaviour being tested.
 *
 * No manifest means the missing-manifest warning and nothing else: the dependency is installed, so `QAT-D005` does not
 * fire, and an undeclared install is not reported for a project with no manifest to have declared it.
 */
export async function temporaryWarningProject(): Promise<string> {
  const root = await temporaryDirectory();

  await mkdir(join(root, "cypress", "e2e"), { recursive: true });
  await mkdir(join(root, "node_modules", "cypress"), { recursive: true });

  await writeFile(join(root, "cypress.config.ts"), "export default {};\n");
  await writeFile(
    join(root, "node_modules", "cypress", "package.json"),
    JSON.stringify({ name: "cypress", version: "13.15.0" }),
  );

  return root;
}

/**
 * A workspace member: its own manifest and configuration, with the framework installed at the root above it.
 *
 * The root declares `workspaces`, which is what makes this a real monorepo rather than two nested directories. It also
 * proves the member is still an ordinary project — the declaration above it neither helps nor interferes, and only the
 * *install* search is expected to climb.
 */
export async function temporaryWorkspaceMember(): Promise<{
  readonly root: string;
  readonly member: string;
}> {
  const root = await temporaryDirectory();

  const member = join(root, "packages", "app");
  await mkdir(join(member, "cypress", "e2e"), { recursive: true });
  await mkdir(join(root, "node_modules", "cypress"), { recursive: true });

  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "root",
      version: "1.0.0",
      workspaces: ["packages/*"],
    }),
  );
  await writeFile(
    join(member, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0" }),
  );
  await writeFile(join(member, "cypress.config.ts"), "export default {};\n");
  await writeFile(
    join(root, "node_modules", "cypress", "package.json"),
    JSON.stringify({ name: "cypress", version: "13.15.0" }),
  );

  return { root, member };
}

/**
 * A package layout — the compiled output beside a manifest — outside the repository.
 *
 * The dependencies are symlinked rather than copied. Without them Node cannot resolve `commander` or `pino`, and the
 * process dies on the first import — which is what an exit code of 1 means, and is why a copied `dist/` is not a copy
 * of an installation. A junction on Windows: symlink creation there needs elevation for file links but not for
 * directory junctions, and the resolution behaviour is identical.
 */
export async function temporaryPackageLayout(
  manifest?: string,
): Promise<string> {
  const root = await temporaryDirectory();

  await cp(DIST, join(root, "dist"), { recursive: true });
  await symlink(
    join(REPO_ROOT, "node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  if (manifest !== undefined) {
    await writeFile(join(root, "package.json"), manifest);
  }

  return root;
}

export interface RepositoryManifest {
  version?: string;
  bin?: Record<string, string>;
}

/** The repository's own manifest, read once per assertion that needs it. */
export async function packageManifest(): Promise<RepositoryManifest> {
  return JSON.parse(await readFile(MANIFEST, "utf8")) as RepositoryManifest;
}

/**
 * Every path under `root`, with its size and modification time.
 *
 * Used to prove that running a command wrote nothing. Sizes and times are included rather than contents alone, because
 * a rewrite with identical bytes is still a write: an atomic-write helper that rewrote a configuration with the same
 * contents would pass a content-only comparison and fail this one.
 *
 * Recursive, so a file created inside an existing directory is caught. The root itself is not included — `readdir`
 * lists its children — which is correct: the command may be given the directory without changing it.
 */
export async function snapshot(root: string): Promise<readonly string[]> {
  const paths = (await readdir(root, { recursive: true })).sort();

  return Promise.all(
    paths.map(async (path) => {
      const stats = await stat(join(root, path));
      return `${path}|${String(stats.size)}|${String(stats.mtimeMs)}`;
    }),
  );
}

/** Removes every directory a fixture created. Called from `afterAll` in each file that has one. */
export async function removeTemporaryDirectories(): Promise<void> {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
  created = [];
}
