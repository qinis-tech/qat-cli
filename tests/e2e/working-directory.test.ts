import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { temporaryProject } from "./fixtures.js";
import {
  qat,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./harness.js";

import { ExitCode } from "~/core/errors/index.js";

/**
 * Which directory a command acts on.
 *
 * One rule, and every case states it as a property of the resolved path rather than as a substring of a report: an
 * argument beats the option, the option beats where the process was started, and a relative value resolves against the
 * process directory.
 *
 * ## Asserted through the structured document
 *
 * `toContain('demo')` passes whatever directory was resolved, because the project name is in every report. The document
 * carries the root the tool actually used, so a precedence mistake fails here instead of producing a plausible report
 * about the wrong project.
 *
 * ## Two kinds of equality, and why
 *
 * Where the directory is given as an **absolute path** — an argument, or `--cwd` — the resolved root is asserted to equal
 * it exactly. Where it is derived from the **process directory**, only the tail is asserted: on macOS a process started
 * in `/var/folders/…` reports its working directory as `/private/var/folders/…`, so an exact comparison would be a test of
 * the platform rather than of the tool.
 */
afterAll(removeTemporaryDirectories);

/** The `--json` document, narrowed to the one field these cases read. */
interface WorkingDirectoryDocument {
  assessment?: { diagnosis?: { identity?: { name?: string; root?: string } } };
}

/** The root the tool resolved, or `undefined` if the document did not parse into the shape expected. */
function resolvedRoot(stdout: string): string | undefined {
  return (JSON.parse(stdout) as WorkingDirectoryDocument).assessment?.diagnosis
    ?.identity?.root;
}

function resolvedName(stdout: string): string | undefined {
  return (JSON.parse(stdout) as WorkingDirectoryDocument).assessment?.diagnosis
    ?.identity?.name;
}

describe("working directory", () => {
  it("uses the process working directory when nothing is named", async () => {
    const root = await temporaryProject();

    // No argument, no option. The answer comes from where the process was started — so the assert is on the tail, not
    // on the whole path: the prefix is whatever the platform reports for the working directory.
    const result = await qat(["doctor", "--json"], { cwd: root });

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(resolvedName(result.stdout)).toBe("demo");
    expect(resolvedRoot(result.stdout)).toContain(basename(root));
  });

  it("resolves a relative argument against the process working directory", async () => {
    const root = await temporaryProject();

    // `.` is the combination a developer uses most, and the one a path bug breaks first. The fixture's directory name is
    // unique, so finding it at the end of the resolved root is evidence that `.` resolved to the cwd rather than to
    // somewhere else that happens to exist.
    const result = await qat(["doctor", ".", "--json"], { cwd: root });

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(resolvedRoot(result.stdout)).toContain(basename(root));
  });

  it("resolves a relative subpath below the process working directory", async () => {
    const root = await temporaryProject();
    await mkdir(join(root, "packages", "app"), { recursive: true });

    // The relative part is appended to whatever the platform reports as the working directory, so the suffix is the
    // stable half of the answer and the half this case is about.
    const result = await qat(["doctor", "./packages/app", "--json"], {
      cwd: root,
    });

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(resolvedRoot(result.stdout)?.endsWith(join("packages", "app"))).toBe(
      true,
    );
  });

  it("uses the working-directory option when no argument is given", async () => {
    const root = await temporaryProject();

    // The option is an absolute path, so the answer is exact — and the process is started somewhere else entirely, which
    // is what makes the option the thing that decided it.
    const result = await qat(["doctor", "--cwd", root, "--json"], {
      cwd: tmpdir(),
    });

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(resolvedRoot(result.stdout)).toBe(root);
  });

  it("prefers an explicit argument over the working-directory option", async () => {
    const argument = await temporaryProject();
    const option = await temporaryDirectory();

    // The option points at an empty directory, so if it won the verdict would be `blocked`. Asserting the root as well
    // makes the case about precedence rather than about the exit status, which two different mistakes can produce.
    const result = await qat(["doctor", argument, "--cwd", option, "--json"]);

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(resolvedRoot(result.stdout)).toBe(argument);
  });

  it("resolves a path containing spaces, given as an argument", async () => {
    const root = await temporaryDirectory();
    const spaced = join(root, "a directory with spaces");
    await mkdir(spaced, { recursive: true });

    // A path with a space in it is the oldest quoting bug there is, and it fails differently on each platform: the
    // argument arrives intact and the tool cannot open the file, or it arrives split and the tool reports the first
    // fragment as a directory. The resolved root is asserted, so a split argument shows up as the fragment the tool
    // actually used.
    //
    // The directory is empty rather than a project: this case is about the path surviving the parser, and detection has
    // its own file. A `blocked` verdict with the right root is a pass here.
    const result = await qat(["doctor", spaced, "--json"]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(resolvedRoot(result.stdout)).toBe(spaced);
    expect(result.stderr).toBe("");
  });

  it("resolves a path containing spaces, given as the working-directory option", async () => {
    const root = await temporaryDirectory();
    const spaced = join(root, "with spaces");
    await mkdir(spaced, { recursive: true });

    // The option travels a different route through the parser than the positional does, so both are worth asserting: a
    // quoting bug in one is not a quoting bug in the other.
    const result = await qat(["doctor", "--cwd", spaced, "--json"], {
      cwd: tmpdir(),
    });

    expect(resolvedRoot(result.stdout)).toBe(spaced);
  });

  it("names the offending input when the directory does not exist", async () => {
    const result = await qat([
      "doctor",
      join(tmpdir(), "qat-absent-directory-7f3a"),
    ]);

    // A path that does not exist is an argument defect rather than a project condition, so it is the one thing the
    // command still raises — on standard error, before any assessment exists.
    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("QAT1001");
    // Which of the three inputs was wrong is the actionable part of the message.
    expect(result.stderr).toContain("argument");
    expect(result.stderr).toContain("is not a directory");
  });

  it("names the offending input when the path is a file", async () => {
    const root = await temporaryProject();

    // A file is not a directory, and the failure says so rather than reporting "no project found" about a path that was
    // never a directory. The distinction matters because the two have different fixes: delete the argument, versus run
    // the command somewhere else.
    const result = await qat(["doctor", join(root, "cypress.config.ts")]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("QAT1001");
    expect(result.stderr).toContain("is not a directory");
  });
});
