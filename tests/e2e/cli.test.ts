import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ExitCode } from "~/core/errors/index.js";
import { runProcess } from "~/core/process/index.js";

/**
 * Runs the built binary.
 *
 * The tool's own process runner spawns the tool, which is the first thing in this project to do so and
 * the trigger the testing architecture document named for this suite existing. `npm run test:e2e`
 * builds first and runs the binary once, so a failure here is a failure of the executable rather than of
 * a missing build.
 */
const CLI = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const DIST = fileURLToPath(new URL("../../dist", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../../package.json", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const created: string[] = [];

function qat(args: readonly string[]) {
  return runProcess({ executable: process.execPath, args: [CLI, ...args] });
}

/** An empty directory, for the cases that need somewhere real that is not a project. */
async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-e2e-"));
  created.push(root);

  return root;
}

/** The minimum that makes a directory a runnable Cypress project. */
async function temporaryProject(): Promise<string> {
  const root = await temporaryDirectory();

  await mkdir(join(root, "cypress", "e2e"), { recursive: true });
  await mkdir(join(root, "node_modules", "cypress"), { recursive: true });

  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0" }),
  );
  await writeFile(join(root, "cypress.config.ts"), "export default {};\n");
  await writeFile(
    join(root, "node_modules", "cypress", "package.json"),
    JSON.stringify({ name: "cypress", version: "13.15.0" }),
  );

  return root;
}

/** The repository's own manifest, read once per assertion that needs it. */
async function packageManifest(): Promise<{
  version?: string;
  bin?: Record<string, string>;
}> {
  return JSON.parse(await readFile(MANIFEST, "utf8")) as {
    version?: string;
    bin?: Record<string, string>;
  };
}

/** A package layout — the compiled output beside a manifest — outside the repository. */
async function packagedLayout(manifest: string | undefined): Promise<string> {
  const root = await temporaryDirectory();

  await cp(DIST, join(root, "dist"), { recursive: true });

  // A real installation has its dependencies beside it. Without them Node cannot resolve `commander` or
  // `pino`, and the process dies on the first import — which is what an exit code of 1 means, and is why
  // a copied `dist/` is not a copy of an installation.
  //
  // A junction on Windows; symlink creation there needs elevation for file links but not for directory
  // junctions, and the resolution behaviour is identical.
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

afterAll(async () => {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("the executable", () => {
  it("reports exactly the version the package declares", async () => {
    const result = await qat(["--version"]);

    // Equality rather than a shape match: a version that is merely well-formed is not evidence that the
    // resolved value is the right one.
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.stdout.trim()).toBe((await packageManifest()).version);
  });

  it("prints help listing the global options and exits zero", async () => {
    const result = await qat(["--help"]);

    expect(result.exitCode).toBe(ExitCode.Success);

    for (const flag of ["--cwd", "--log-level", "--json", "--debug"]) {
      expect(result.stdout).toContain(flag);
    }
  });

  it("exits two for an unknown option, with a message rather than a stack", async () => {
    const result = await qat(["--nope"]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("unknown option");

    // A stack trace in default output is noise to the user and an information leak to everyone else.
    expect(result.stderr).not.toContain("at ");
  });

  it("exits two when no command is given", async () => {
    const result = await qat([]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("No command was given");
  });

  it("is executable through the binary mapping the package declares", async () => {
    // The criterion a declaration alone cannot satisfy: the mapped path must be the file that runs.
    expect((await packageManifest()).bin?.["qat"]).toBe("./dist/cli/index.js");
    expect(await readFile(CLI, "utf8")).toMatch(/^#!\/usr\/bin\/env node/);
  });
});

describe("version resolution", () => {
  it("resolves the version from a package layout that is not the repository", async () => {
    const root = await packagedLayout(
      JSON.stringify({ name: "qat-cli", version: "9.8.7", type: "module" }),
    );

    // An installed package is exactly this: compiled output beside a manifest, with no src/ above it.
    const installed = await runProcess({
      executable: process.execPath,
      args: [join(root, "dist", "cli", "index.js"), "--version"],
    });

    expect(installed.exitCode).toBe(ExitCode.Success);
    expect(installed.stdout.trim()).toBe("9.8.7");
  });

  it("fails predictably when the nearest manifest has no usable version", async () => {
    // Valid JSON, so Node can read it and start the CLI — and no version, so the resolver fails where
    // the reader can see it. A malformed manifest never reaches this code: Node refuses the module
    // before the entry point runs.
    const root = await packagedLayout(
      JSON.stringify({ name: "qat-cli", type: "module" }),
    );

    const result = await runProcess({
      executable: process.execPath,
      args: [join(root, "dist", "cli", "index.js"), "--version"],
    });

    // Environment, not internal: an installation with damaged metadata is a broken install, and the
    // remedy is to reinstall rather than to report a defect.
    expect(result.exitCode).toBe(ExitCode.Environment);
    expect(result.stderr).toContain("QAT4003");
    expect(result.stderr).toContain("does not declare a usable version");
    expect(result.stderr).not.toContain("at ");
  });
});

describe("help", () => {
  it("lists every registered command in global help", async () => {
    const result = await qat(["--help"]);

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.stdout).toContain("doctor");

    // The summary, not only the name: a command list without a description tells a user nothing about
    // which command they want.
    expect(result.stdout).toContain("Report what QAT can see");
  });

  it("describes a command, its arguments and its examples", async () => {
    const result = await qat(["doctor", "--help"]);

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("[directory]");
    expect(result.stdout).toContain("Examples:");
    expect(result.stdout).toContain("qat doctor ./packages/api");
  });

  it("exits zero for help, because the user asked for something and got it", async () => {
    // A distinct case from the global help above: this exercises the path where a subcommand prints its
    // own help and the parser throws to stop further work.
    const result = await qat(["doctor", "--help"]);

    expect(result.exitCode).toBe(ExitCode.Success);
  });
});

describe("unknown input", () => {
  it("names a likely correction for an unknown command and exits two", async () => {
    const result = await qat(["doctr"]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);

    // The exact wording, including the code: this failure is generated by the program's own action and
    // rendered by this project's error renderer, not written by the parser.
    expect(result.stderr).toContain("QAT1001: Unknown command 'doctr'");

    // Actionable rather than merely correct: the suggestion turns a dead end into a typo fix.
    expect(result.stderr).toContain("Did you mean 'doctor'");
  });

  it("exits two for an unknown option on a command", async () => {
    const result = await qat(["doctor", "--nope"]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("unknown option");
  });

  it("exits two for an extra positional rather than ignoring it", async () => {
    const root = await temporaryDirectory();

    const result = await qat(["doctor", root, "surplus"]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("too many arguments");
  });
});

describe("doctor", () => {
  it("reports a project as human-readable lines and exits zero", async () => {
    const root = await temporaryProject();

    const result = await qat(["doctor", root]);

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.stdout).toContain("project");
    expect(result.stdout).toContain("demo");
    expect(result.stdout).toContain("cypress");
    expect(result.stdout).toContain(root);
  });

  it("reports the same project as a document with --json", async () => {
    const root = await temporaryProject();

    const result = await qat(["doctor", root, "--json"]);

    expect(result.exitCode).toBe(ExitCode.Success);

    const document = JSON.parse(result.stdout) as {
      project?: { name?: string };
    };
    expect(document.project?.name).toBe("demo");
  });

  it("writes nothing to standard error when it succeeds", async () => {
    const root = await temporaryProject();

    const result = await qat(["doctor", root]);

    // A successful command that also logs to stderr makes a pipeline's error output noise.
    expect(result.stderr).toBe("");
  });

  it("exits two when the directory is not a project, with a remedy", async () => {
    const root = await temporaryDirectory();

    const result = await qat(["doctor", root]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("QAT2001");
    expect(result.stderr).toContain("No project found");

    // The remedy names what the reader can actually do here — passing a directory — rather than pointing
    // at the help screen, which would not help with this failure.
    expect(result.stderr).toContain("pass --cwd");
  });

  it("exits two for a directory that does not exist", async () => {
    const result = await qat([
      "doctor",
      join(tmpdir(), "qat-absent-directory-7f3a"),
    ]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("is not a directory");
  });
});
