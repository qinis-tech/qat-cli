import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  qat,
  removeTemporaryDirectories,
  temporaryDirectory,
  temporaryProject,
} from "./harness.js";

import { ExitCode } from "~/core/errors/index.js";

/**
 * Which directory a command acts on.
 *
 * Five cases for one rule: an argument beats the option, the option beats where the process was started, and a
 * relative value resolves against the process directory. Every case asserts on the reported root or on the exit
 * code, so a precedence mistake fails rather than producing a plausible report about the wrong project.
 */
afterAll(removeTemporaryDirectories);

describe("working directory", () => {
  it("uses the process working directory when nothing is named", async () => {
    const root = await temporaryProject();

    // No argument, no option. The answer comes from where the process was started.
    const result = await qat(["doctor"], { cwd: root });

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.stdout).toContain("demo");
  });

  it("resolves a relative argument against the process working directory", async () => {
    const root = await temporaryProject();

    // `.` is the combination a developer uses most, and the one a path bug breaks first.
    const result = await qat(["doctor", "."], { cwd: root });

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.stdout).toContain(root);
  });

  it("uses the working-directory option when no argument is given", async () => {
    const root = await temporaryProject();

    const result = await qat(["doctor", "--cwd", root], { cwd: tmpdir() });

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.stdout).toContain("demo");
  });

  it("prefers an explicit argument over the working-directory option", async () => {
    const argument = await temporaryProject();
    const option = await temporaryDirectory();

    // The option points at an empty directory, so if it won this would fail with QAT2001 instead.
    const result = await qat(["doctor", argument, "--cwd", option]);

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.stdout).toContain("demo");
  });

  it("names the offending input when the directory does not exist", async () => {
    const result = await qat([
      "doctor",
      join(tmpdir(), "qat-absent-directory-7f3a"),
    ]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("QAT1001");
    // Which of the three inputs was wrong is the actionable part of the message.
    expect(result.stderr).toContain("argument");
    expect(result.stderr).toContain("is not a directory");
  });
});
