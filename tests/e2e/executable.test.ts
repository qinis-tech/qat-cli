import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { CLI, packageManifest, qat } from "./harness.js";

import { ExitCode } from "~/core/errors/index.js";

/**
 * The binary itself: does it run, does it identify itself, and what does it do when the command line makes no sense.
 *
 * No fixtures and therefore no cleanup — every case here runs against the repository or against nothing at all. That is
 * also why this file did not move when the project shapes were split out of the harness: everything it uses is about
 * *running* the binary, which is the half that stayed.
 *
 * ## Exit code `1` is not a scenario here
 *
 * Every case asserts a code the tool chose. A code of `1` means Node died before qat decided anything — an empty build,
 * or an installation whose imports cannot resolve — and it is the failure these assertions exist to distinguish from a
 * considered answer. Nothing produces it deliberately.
 */
describe("the executable", () => {
  it("reports exactly the version the package declares", async () => {
    const result = await qat(["--version"]);

    // Equality rather than a shape match: a version that is merely well-formed is not evidence that the resolved value
    // is the right one.
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.stdout.trim()).toBe((await packageManifest()).version);
    // The version is the answer, so it goes where answers go. A copy on the second stream would be a message about the
    // answer, which nothing needs.
    expect(result.stderr).toBe("");
  });

  it("prints help listing the global options and exits zero", async () => {
    const result = await qat(["--help"]);

    expect(result.exitCode).toBe(ExitCode.Success);

    for (const flag of ["--cwd", "--log-level", "--json", "--debug"]) {
      expect(result.stdout).toContain(flag);
    }

    // Help is what the user asked for, so it is a result rather than a diagnostic — which is the whole reason it does not
    // share the stream with errors.
    expect(result.stderr).toBe("");
  });

  it("exits two for an unknown option, with a message rather than a stack", async () => {
    const result = await qat(["--nope"]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("unknown option");

    // A stack trace in default output is noise to the user and an information leak to everyone else. The check is a
    // heuristic rather than a proof — it looks for the shape of a frame — and it is the only cheap one available from
    // outside the process.
    expect(result.stderr).not.toContain("at ");
  });

  it("writes nothing to standard output when it fails", async () => {
    const result = await qat(["--nope"]);

    // The converse of the help case, and the property a pipeline depends on: standard output carries results, so a
    // command that produced none must leave it empty rather than putting an explanation there.
    expect(result.stdout).toBe("");
  });

  it("exits two when no command is given", async () => {
    const result = await qat([]);

    // Reporting this as invalid input means a script is told its invocation was wrong rather than that its work
    // succeeded — which is what a zero exit with nothing to show would have said.
    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("No command was given");
  });

  it("exits two for an empty positional argument", async () => {
    const result = await qat(["doctor", ""]);

    // An explicit empty value is a mistake, not an instruction to use the default. Treating it as absent would run the
    // command against the process directory and produce a confident report about a directory the user did not name.
    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("QAT1001");
    expect(result.stderr).not.toContain("at ");
  });

  it("exits two for a log level it does not recognise, and names the ones it does", async () => {
    const result = await qat(["doctor", "--log-level", "verbose"]);

    // A flag was typed for this invocation, so quietly falling back to a different level would be the tool doing
    // something other than what it was asked. The supported values are named because the reader needs them to retry.
    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("QAT1001");
    expect(result.stderr).toContain("Unknown log level verbose");
    expect(result.stderr).toContain("trace");
    expect(result.stderr).toContain("fatal");
  });

  it("is executable through the binary mapping the package declares", async () => {
    // The criterion a declaration alone cannot satisfy: the mapped path must be the file that runs.
    expect((await packageManifest()).bin?.["qat"]).toBe("./dist/cli/index.js");
    expect(await readFile(CLI, "utf8")).toMatch(/^#!\/usr\/bin\/env node/);
  });
});
