import { afterAll, describe, expect, it } from "vitest";

import {
  qat,
  removeTemporaryDirectories,
  temporaryDirectory,
  temporaryProject,
  temporaryWorkspaceMember,
} from "./harness.js";

import { ExitCode } from "~/core/errors/index.js";

/**
 * The one command, from the outside.
 *
 * Two behaviours in one file on purpose: what it reports when it succeeds, and which exit code it produces for each
 * detection verdict. They are the same command's observable surface, and a reader asking "what does doctor do"
 * should find one file.
 */
afterAll(removeTemporaryDirectories);

/** The `--json` document `doctor` writes, narrowed to the fields these assertions read. */
interface DoctorDocument {
  project?: {
    name?: string;
    frameworkDeclaration?: { section?: string; range?: string };
    installation?: { version?: string; source?: string };
    packageMetadata?: { name?: string; version?: string };
  };
}

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

  it("reports where the framework is declared, separately from where it is installed", async () => {
    const root = await temporaryProject();

    const result = await qat(["doctor", root]);

    expect(result.exitCode).toBe(ExitCode.Success);
    // Four adjacent lines, three different sources: the manifest for identity, the manifest for the declaration, and
    // `node_modules` for the version. Collapsing any two of them is what the previous single message did.
    expect(result.stdout).toContain("package    demo@1.0.0");
    expect(result.stdout).toContain("cypress 13.15.0 (project install)");
    expect(result.stdout).toContain("declared   devDependencies (^13.15.0)");
  });

  it("reports a workspace member with a hoisted install as undeclared in the package itself", async () => {
    const { member } = await temporaryWorkspaceMember();

    const result = await qat(["doctor", member]);

    expect(result.exitCode).toBe(ExitCode.Success);
    // The version came from three directories up; the declaration came from nowhere. Both are true, and neither line
    // could be produced by the other.
    expect(result.stdout).toContain("cypress 13.15.0 (workspace install)");
    expect(result.stdout).toContain("declared   nowhere in this package");
  });

  it("includes the declaration in the machine-readable document", async () => {
    const root = await temporaryProject();

    const result = await qat(["doctor", root, "--json"]);

    expect(result.exitCode).toBe(ExitCode.Success);

    const document = JSON.parse(result.stdout) as DoctorDocument;

    expect(document.project?.name).toBe("demo");
    expect(document.project?.frameworkDeclaration).toStrictEqual({
      section: "devDependencies",
      range: "^13.15.0",
    });
    expect(document.project?.installation).toMatchObject({ source: "project" });
  });

  it("writes nothing to standard error when it succeeds", async () => {
    const root = await temporaryProject();

    const result = await qat(["doctor", root]);

    // A successful command that also logs to stderr makes a pipeline's error output noise.
    expect(result.stderr).toBe("");
  });

  it("exits two when the directory is not a project", async () => {
    const root = await temporaryDirectory();

    const result = await qat(["doctor", root]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("QAT2001");
    expect(result.stderr).toContain("No project found");

    // The remedy names what the reader can actually do here — passing a directory — rather than pointing at the help
    // screen, which would not help with this failure.
    expect(result.stderr).toContain("pass --cwd");
  });

  it("names the legacy configuration format and the upgrade rather than the wrong directory", async () => {
    const root = await temporaryProject({
      configured: false,
      extra: { "cypress.json": "{}" },
    });

    const result = await qat(["doctor", root]);

    // A Cypress project QAT cannot drive. The remedy is an upgrade, and telling its owner they are in the wrong
    // directory would send them looking for something that is already there.
    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("QAT2003");
    expect(result.stderr).toContain("cypress.json");
    expect(result.stderr).toContain("Upgrade to cypress.config.ts");
  });
});
