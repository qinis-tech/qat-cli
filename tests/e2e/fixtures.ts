/**
 * The project shapes the end-to-end suite runs the binary against.
 *
 * ## Why this is separate from the harness
 *
 * The harness answers "how do I run the binary and clean up after it". This answers "what kind of project am I running
 * it against". They change for different reasons and are read by different people — somebody adding a scenario looks
 * here, somebody debugging a timeout looks there — and a single module that does both grows until neither is readable.
 *
 * ## Every shape is a real directory
 *
 * No mocked filesystem, for the same reason as everywhere else in this repository: every question the tool asks is
 * "does this named file exist, and what is inside it", and a fake would answer according to the same assumption the
 * implementation makes. The cost is a `mkdir` per shape and the cleanup the harness now verifies.
 *
 * ## Each shape exists because an assertion needs it
 *
 * A single builder with a flag per variation would require a reader to reconstruct which combination produces what, and
 * the combinations that matter are not the ones a flag matrix suggests — a project with a legacy configuration and an
 * old installation is a different scenario from one with a supported configuration and an old installation, and neither
 * is "valid project, minus a bit".
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { temporaryDirectory } from "./harness.js";

/** The version the fixtures install unless a case says otherwise. Inside the supported range, and not at a boundary. */
const SUPPORTED_VERSION = "13.15.0";

export interface ProjectOptions {
  /** Whether the manifest declares Cypress. Defaults to true. */
  readonly declared?: boolean;
  /** Whether to write a supported configuration file at the root. Defaults to true. */
  readonly configured?: boolean;
  /**
   * Whether Cypress is installed under `node_modules`. Defaults to true.
   *
   * Turning it off produces the shape a fresh clone has: the manifest names the package and nothing is on disk. It is
   * also the only way to reach "declared but not installed" without also making the install *corrupt*, which is a
   * different case with a different cause and — deliberately — the same answer.
   */
  readonly installed?: boolean;
  /** The version installed under `node_modules`. Defaults to the supported one. */
  readonly version?: string;
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
 * A runnable Cypress project.
 *
 * By default Cypress is declared in `devDependencies` *and* installed under `node_modules`, which is what a real
 * single-package project looks like. Three variations, and each exists because an assertion needs it:
 *
 * - `declared: false` — present on disk, absent from the manifest. What a workspace member with a hoisted install looks
 *   like, and what a clean install removes.
 * - `installed: false` — declared, and nothing on disk. A fresh clone.
 * - `version` — an installation whose version differs from the declared range, for the compatibility rules.
 *
 * `extra` is applied **last**, so a test can replace any of the above file by file — including replacing the installed
 * manifest with something unreadable, which is how the corrupt-install case is built.
 */
export async function temporaryProject(
  options: ProjectOptions = {},
): Promise<string> {
  const declared = options.declared ?? true;
  const installed = options.installed ?? true;
  const version = options.version ?? SUPPORTED_VERSION;
  const root = await temporaryDirectory();

  await mkdir(join(root, "cypress", "e2e"), { recursive: true });

  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      ...(declared ? { devDependencies: { cypress: `^${version}` } } : {}),
    }),
  );

  if (options.configured ?? true) {
    await writeFile(join(root, "cypress.config.ts"), "export default {};\n");
  }

  // Both writes are guarded by the same flag. Conditioning the `mkdir` alone leaves an empty `node_modules/cypress`
  // directory behind, which the install search finds as a directory and then reports as absent anyway — the right answer
  // for the wrong reason, and one that would hide a regression in `isFile`.
  if (installed) {
    await mkdir(join(root, "node_modules", "cypress"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "cypress", "package.json"),
      JSON.stringify({ name: "cypress", version }),
    );
  }

  await write(root, options.extra);
  return root;
}

/**
 * A project that is runnable and imperfect: a configuration, an installed framework, and no manifest.
 *
 * The warning is the point. A project with a blocker would let a report that printed only blockers pass every assertion
 * about warnings, because the warning would never be reached.
 */
export async function temporaryWarningProject(): Promise<string> {
  const root = await temporaryDirectory();

  await mkdir(join(root, "cypress", "e2e"), { recursive: true });
  await mkdir(join(root, "node_modules", "cypress"), { recursive: true });
  await writeFile(join(root, "cypress.config.ts"), "export default {};\n");
  await writeFile(
    join(root, "node_modules", "cypress", "package.json"),
    JSON.stringify({ name: "cypress", version: SUPPORTED_VERSION }),
  );

  return root;
}

/**
 * A Cypress project from before the configuration became a module: `cypress.json`, and an installation old enough to
 * match it.
 *
 * Two facts, deliberately consistent. A legacy configuration with a current installation would be a different scenario —
 * one that cannot occur — and a fixture that mixed them would be testing a state no repository is in.
 */
export async function temporaryLegacyProject(): Promise<string> {
  const root = await temporaryDirectory();

  await mkdir(join(root, "node_modules", "cypress"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "legacy",
      version: "1.0.0",
      devDependencies: { cypress: "^9.7.0" },
    }),
  );
  await writeFile(join(root, "cypress.json"), "{}");
  await writeFile(
    join(root, "node_modules", "cypress", "package.json"),
    JSON.stringify({ name: "cypress", version: "9.7.0" }),
  );

  return root;
}

/**
 * A working repository with more than one configuration file in it.
 *
 * The shape a migration leaves behind: both files present, both readable, and no defensible way to choose. `ts` before
 * `js` is the candidate order, so the report names them in that order whatever order the filesystem returns them in.
 */
export async function temporaryAmbiguousProject(): Promise<string> {
  return temporaryProject({
    extra: { "cypress.config.js": "module.exports = {};\n" },
  });
}

/**
 * A repository with a manifest and source, and nothing to do with Cypress.
 *
 * The false positive the detection rules exist to prevent: if a manifest counted as evidence, every npm project would
 * be an incomplete Cypress project.
 */
export async function temporaryUnrelatedProject(): Promise<string> {
  const root = await temporaryDirectory();

  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "web-app",
      version: "1.0.0",
      dependencies: { react: "^19.0.0" },
    }),
  );
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.tsx"), "export default null;\n");

  return root;
}

/**
 * A project whose manifest is not JSON.
 *
 * Valid enough for Node to start the CLI and read the directory, and broken enough that nothing can be concluded about
 * the project. The one condition the tool refuses to classify, so it is asserted separately rather than folded in with
 * the other detection shapes.
 */
export async function temporaryMalformedManifestProject(): Promise<string> {
  const root = await temporaryDirectory();

  await writeFile(join(root, "package.json"), '{ "name": "demo", "version": ');
  await writeFile(join(root, "cypress.config.ts"), "export default {};\n");

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
    JSON.stringify({ name: "cypress", version: SUPPORTED_VERSION }),
  );

  return { root, member };
}

/**
 * Writes verbatim files under a fixture root, creating directories as needed.
 *
 * Last in every builder, so an override wins over a default. A separate function rather than a loop repeated in four
 * builders, and in this module rather than the harness because the only caller is a fixture.
 */
async function write(
  root: string,
  files: Readonly<Record<string, string>> = {},
): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}
