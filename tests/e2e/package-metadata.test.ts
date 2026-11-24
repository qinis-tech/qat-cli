import { afterAll, describe, expect, it } from "vitest";

import {
  temporaryMalformedManifestProject,
  temporaryProject,
  temporaryWarningProject,
} from "./fixtures.js";
import { qat, removeTemporaryDirectories } from "./harness.js";

import { ExitCode } from "~/core/errors/index.js";

/**
 * What the command reports about a project's package metadata.
 *
 * Asserted through `--json` rather than through the human lines. The manifest's effect is a set of facts — a status, a
 * declaration section, a finding code — and asserting the facts is both shorter and less brittle than asserting a
 * formatted sentence that happens to contain them. The human format has its own tests, in the unit suite for the
 * presenter and in `doctor.test.ts` for the end-to-end shape.
 *
 * ## Two failure shapes that must never converge
 *
 * A manifest the tool cannot read means two entirely different things depending on *whose* it is. The project's own
 * manifest is the description of the thing being inspected: if it will not parse, the project is undescribable and the
 * identity says so. An installed package's manifest supplies one string — a version — and if it will not parse, the copy
 * is unusable and the answer is "not installed".
 *
 * The cases below assert both halves, one in each `describe`. Reporting an unparseable install as an unreadable project
 * was a real defect: it sent the reader to inspect a `package.json` that had just been read successfully.
 */
afterAll(removeTemporaryDirectories);

/** The `--json` document, narrowed to the fields these assertions read. */
interface MetadataDocument {
  assessment?: {
    diagnosis?: {
      identity?: { name?: string; packageMetadata?: string };
      framework?: { declaration?: { section?: string; range?: string } };
    };
    gates?: {
      execute?: {
        readiness?: string;
        blocking?: { code?: string }[];
        warnings?: { code?: string }[];
      };
    };
  };
}

async function inspect(root: string) {
  const result = await qat(["doctor", root, "--json"]);

  return { result, document: JSON.parse(result.stdout) as MetadataDocument };
}

/**
 * The codes present, with absent ones dropped.
 *
 * A finding always has a code, so an absent one means the document's shape changed — and a `toContain` against a
 * filtered list fails loudly at that point instead of passing on a loose comparison against `string | undefined`.
 */
function codesOf(findings: readonly { code?: string }[] | undefined): string[] {
  const codes = (findings ?? []).map((finding) => finding.code);

  return codes.filter((code): code is string => code !== undefined);
}

describe("package metadata", () => {
  it("reports a readable manifest as present", async () => {
    const { result, document } = await inspect(await temporaryProject());

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(document.assessment?.diagnosis?.identity?.packageMetadata).toBe(
      "present",
    );
    expect(document.assessment?.diagnosis?.identity?.name).toBe("demo");
  });

  it("reports a missing manifest as absent, and as a warning rather than a failure", async () => {
    const { result, document } = await inspect(await temporaryWarningProject());

    // A project of a configuration and specs, with the framework installed, is legal. The directory name becomes the
    // project name and the reader is told so — rather than the line simply not being there.
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(document.assessment?.diagnosis?.identity?.packageMetadata).toBe(
      "absent",
    );
    expect(codesOf(document.assessment?.gates?.execute?.warnings)).toContain(
      "QAT-D010",
    );
    expect(document.assessment?.gates?.execute?.blocking).toStrictEqual([]);
  });

  it("reports a malformed project manifest as a blocking condition naming the file", async () => {
    const { result, document } = await inspect(
      await temporaryMalformedManifestProject(),
    );

    // A broken file is a fault; a missing one is an answer. Conflating them would report a stray comma as "this is not a
    // Cypress project".
    //
    // This is the *project's* manifest, so the identity is what says the project cannot be described — and the finding
    // set is exactly one, because detection stopped before it could look at anything else.
    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(document.assessment?.diagnosis?.identity?.packageMetadata).toBe(
      "unreadable",
    );
    expect(
      codesOf(document.assessment?.gates?.execute?.blocking),
    ).toStrictEqual(["QAT-D007"]);
  });
});

describe("the Cypress declaration", () => {
  it("reports a development declaration", async () => {
    const { document } = await inspect(await temporaryProject());

    expect(
      document.assessment?.diagnosis?.framework?.declaration,
    ).toStrictEqual({
      section: "devDependencies",
      range: "^13.15.0",
    });
  });

  it("reports a runtime declaration", async () => {
    const { document } = await inspect(
      await temporaryProject({
        extra: {
          "package.json": JSON.stringify({
            name: "demo",
            version: "1.0.0",
            dependencies: { cypress: "^13.15.0" },
          }),
        },
      }),
    );

    // A package declared in `dependencies` rather than `devDependencies` is a defect in the manifest for a test tool,
    // and it is not this command's job to adjudicate — the declaration is reported as written.
    expect(
      document.assessment?.diagnosis?.framework?.declaration?.section,
    ).toBe("dependencies");
  });

  it("reports an installed but undeclared framework as a warning", async () => {
    const { result, document } = await inspect(
      await temporaryProject({
        declared: false,
        extra: {
          "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }),
        },
      }),
    );

    // Present on disk and absent from the manifest: what a clean install removes. Worth saying, not worth failing over.
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(
      document.assessment?.diagnosis?.framework?.declaration,
    ).toBeUndefined();
    expect(codesOf(document.assessment?.gates?.execute?.warnings)).toContain(
      "QAT-D012",
    );
  });

  it("reports a declared but uninstalled framework as blocking", async () => {
    const { result, document } = await inspect(
      await temporaryProject({ installed: false }),
    );

    // One install command away. The manifest names the package and nothing is on disk, so the reader is told that rather
    // than being sent to look for a project they are already in.
    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(
      codesOf(document.assessment?.gates?.execute?.blocking),
    ).toStrictEqual(["QAT-D005"]);
  });

  it("treats a corrupt install as not installed, and does not blame the project manifest", async () => {
    const { result, document } = await inspect(
      await temporaryProject({
        extra: { "node_modules/cypress/package.json": "" },
      }),
    );

    // The same finding as an absent install, deliberately: a corrupt download is one reinstall away, exactly like a
    // missing one. What matters is the second assertion — the project's own manifest parsed perfectly, so reporting it as
    // unreadable would send the reader to inspect a file that is fine.
    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(
      codesOf(document.assessment?.gates?.execute?.blocking),
    ).toStrictEqual(["QAT-D005"]);
    expect(document.assessment?.diagnosis?.identity?.packageMetadata).toBe(
      "present",
    );
  });
});
