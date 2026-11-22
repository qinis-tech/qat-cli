import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ExitCode } from "~/core/errors/index.js";
import { runProcess } from "~/core/process/index.js";

/**
 * Runs the built binary.
 *
 * The tool's own process runner spawns the tool, which is the first thing in this project to do so and
 * the trigger the testing architecture document named for this suite existing. `npm run test:e2e`
 * builds first, so a failure here is a failure of the executable rather than of a missing build.
 */
const CLI = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

function qat(args: readonly string[]) {
  return runProcess({ executable: process.execPath, args: [CLI, ...args] });
}

describe("the executable", () => {
  it("reports the version and exits zero", async () => {
    const result = await qat(["--version"]);

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
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
    expect(result.stderr).not.toContain("at ");
  });

  it("exits two when no command is given", async () => {
    const result = await qat([]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("No command was given");
  });

  it("is executable through the binary mapping the package declares", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { bin?: Record<string, string> };

    // The criterion a declaration alone cannot satisfy: the mapped path must be the file that runs.
    expect(manifest.bin?.["qat"]).toBe("./dist/cli/index.js");
    expect(await readFile(CLI, "utf8")).toMatch(/^#!\/usr\/bin\/env node/);
  });
});
