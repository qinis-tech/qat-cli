/**
 * Running the compiled binary, and cleaning up after it.
 *
 * Not a test file. The suite's include pattern is `tests/e2e/**\/*.test.ts`, so this module is imported and never
 * collected.
 *
 * ## What this file is not
 *
 * It does not know what a Cypress project looks like. `./fixtures.js` does — the project shapes, one per scenario, with
 * the reasons each exists.
 *
 * The split is worth the extra import line in six files because the two change for different reasons. Somebody adding a
 * scenario edits the fixtures. Somebody debugging a timeout, a Windows junction or a leaked directory edits this. A
 * module that does both grows until a reader has to scroll past one job to find the other, and the first thing you read
 * when either fails is the other one's code.
 *
 * ## Cleanup is explicit, and verified
 *
 * `removeTemporaryDirectories` is exported rather than registered as a hook here: a helper that registers hooks on
 * import is attributed to whichever file imported it, which works until the module is imported twice or lazily.
 *
 * It also **checks its own work**. Removing a directory and assuming it went is how a suite passes while leaving
 * fourteen directories in the temp root for the next run to inherit — and the leak is invisible, because nothing the
 * suite asserts depends on it. One `stat` per fixture turns that into a failure naming the paths.
 */
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 *
 * Always await it. A call left un-awaited on Windows keeps a handle on a fixture directory and defeats the removal in
 * `removeTemporaryDirectories` — which now reports that rather than letting it pass.
 */
export function qat(args: readonly string[], options: QatOptions = {}) {
  return runProcess({
    executable: process.execPath,
    args: [CLI, ...args],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
}

/**
 * An empty directory, for the cases that need somewhere real that is not a project.
 *
 * The only directory a *test* creates directly. Everything project-shaped comes from `./fixtures.js`, which calls this
 * — so every temporary directory in the suite passes through here and is recorded for cleanup, whichever module asked
 * for it.
 */
export async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-e2e-"));
  created.push(root);

  return root;
}

/**
 * A package layout — the compiled output beside a manifest — outside the repository.
 *
 * Not a project: this exists to test version resolution, which reads the manifest nearest the running file rather than
 * the directory a command is pointed at.
 *
 * The dependencies are symlinked rather than copied. Without them Node cannot resolve `commander` or `pino`, and the
 * process dies on the first import — which is what an exit code of 1 means, and is why a copied `dist/` is not a copy of
 * an installation. A junction on Windows: symlink creation there needs elevation for file links but not for directory
 * junctions, and the resolution behaviour is identical.
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
 * Used to prove that running a command wrote nothing. Sizes and times are included rather than contents alone, because a
 * rewrite with identical bytes is still a write: an atomic-write helper that rewrote a configuration with the same
 * contents would pass a content-only comparison and fail this one.
 *
 * Recursive, so a file created inside an existing directory is caught. The root itself is not included — `readdir` lists
 * its children — which is correct: the command may be given the directory without changing it.
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

/** Whether a path is still on disk. `stat` rather than `access`, because a directory needs the same answer as a file. */
async function stillExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes every directory a fixture created, then checks that each one is gone.
 *
 * ## Why the retry
 *
 * `rm` can fail on Windows while a child process has not yet released its handle, and the failure is transient by
 * nature — the handle closes milliseconds later. Three attempts is enough in practice and costs nothing when the first
 * succeeds, which it almost always does.
 *
 * ## Why the check
 *
 * `force` makes `rm` succeed for a path that never existed, so a removal that did nothing looks exactly like one that
 * worked. The directory then survives in the temp root, the next run inherits it, and nothing the suite asserts depends
 * on either fact. One `stat` per fixture turns a silent leak into a failure that names the paths.
 *
 * The list is cleared **before** removal, so a throw from the check cannot leave a second hook call trying to remove
 * directories that are already gone.
 *
 * The cost is honest: a throw inside `afterAll` can mask the failure that made the hook run in the first place. Worth
 * it — a leak is the one defect this suite cannot otherwise see, and a masked failure is still a failure.
 */
export async function removeTemporaryDirectories(): Promise<void> {
  const directories = created;
  created = [];

  await Promise.all(
    directories.map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      }),
    ),
  );

  const survivors = await Promise.all(
    directories.map(async (path) =>
      (await stillExists(path)) ? path : undefined,
    ),
  );
  const leaked = survivors.filter((path): path is string => path !== undefined);

  if (leaked.length > 0) {
    throw new Error(
      `${String(leaked.length)} fixture director${leaked.length === 1 ? "y" : "ies"} survived cleanup:\n` +
        `${leaked.join("\n")}\n` +
        "On Windows this is usually a child process still holding a handle. Check that every qat() call is awaited.",
    );
  }
}
