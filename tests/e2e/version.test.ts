import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  removeTemporaryDirectories,
  temporaryPackageLayout,
} from "./harness.js";

import { ExitCode } from "~/core/errors/index.js";
import { runProcess } from "~/core/process/index.js";

/**
 * Version resolution from a layout that is not this repository.
 *
 * These run the binary directly with `runProcess` rather than through `qat`, because the binary under test lives
 * inside the temporary layout rather than in `dist/`.
 */
afterAll(removeTemporaryDirectories);

describe("version resolution", () => {
  it("resolves the version from a package layout that is not the repository", async () => {
    const root = await temporaryPackageLayout(
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
    // Valid JSON, so Node can read it and start the CLI — and no version, so the resolver fails where the reader can
    // see it. A malformed manifest never reaches this code: Node refuses the module before the entry point runs.
    const root = await temporaryPackageLayout(
      JSON.stringify({ name: "qat-cli", type: "module" }),
    );

    const result = await runProcess({
      executable: process.execPath,
      args: [join(root, "dist", "cli", "index.js"), "--version"],
    });

    // Environment, not internal: an installation with damaged metadata is a broken install, and the remedy is to
    // reinstall rather than to report a defect.
    expect(result.exitCode).toBe(ExitCode.Environment);
    expect(result.stderr).toContain("QAT4003");
    expect(result.stderr).toContain("does not declare a usable version");
    expect(result.stderr).not.toContain("at ");
  });
});
