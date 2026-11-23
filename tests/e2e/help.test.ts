import { describe, expect, it } from "vitest";

import { qat } from "./harness.js";

import { ExitCode } from "~/core/errors/index.js";

/**
 * What the tool says about itself, and whether it says it well enough to use.
 *
 * No fixtures: help is a property of the binary, not of a project.
 */
describe("help", () => {
  it("lists every registered command in global help", async () => {
    const result = await qat(["--help"]);

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.stdout).toContain("doctor");

    // The summary, not only the name: a command list without a description tells a user nothing about which command
    // they want.
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
    // A distinct case from the global help above: this exercises the path where a subcommand prints its own help and
    // the parser throws to stop further work.
    const result = await qat(["doctor", "--help"]);

    expect(result.exitCode).toBe(ExitCode.Success);
  });
});
