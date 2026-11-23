import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { CLI, packageManifest, qat } from "./harness.js";

import { ExitCode } from "~/core/errors/index.js";

/**
 * The binary itself: does it run, does it identify itself, and what does it do when the command line makes no sense.
 *
 * No fixtures and therefore no cleanup — every case here runs against the repository or against nothing at all.
 */
describe("the executable", () => {
  it("reports exactly the version the package declares", async () => {
    const result = await qat(["--version"]);

    // Equality rather than a shape match: a version that is merely well-formed is not evidence that the resolved
    // value is the right one.
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
