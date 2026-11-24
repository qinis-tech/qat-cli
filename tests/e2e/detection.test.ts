import { afterAll, describe, expect, it } from "vitest";

import {
  temporaryAmbiguousProject,
  temporaryLegacyProject,
  temporaryProject,
  temporaryUnrelatedProject,
} from "./fixtures.js";
import {
  qat,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./harness.js";

import { ExitCode } from "~/core/errors/index.js";

/**
 * How the binary classifies the shapes a repository can be in.
 *
 * The classification matrix, asserted through the structured document so each case states a verdict and a finding code
 * rather than a sentence. `doctor.test.ts` covers what the report *looks like*; this file covers what detection
 * *concludes*, and the two overlap only where a shape has to be recognised before it can be reported.
 *
 * Two imports, not one, and the split is the same one the modules make: project shapes come from `./fixtures.js`, and
 * running the binary or making a bare directory comes from `./harness.js`. An empty directory is not a project shape —
 * it is the absence of one — which is why it is the harness's.
 */
afterAll(removeTemporaryDirectories);

/** The `--json` document, narrowed to the fields these assertions read. */
interface DetectionDocument {
  assessment?: {
    diagnosis?: {
      detection?: string;
      compatibility?: string;
      framework?: { configuration?: string };
    };
    gates?: {
      execute?: { readiness?: string; blocking?: { code?: string }[] };
    };
  };
}

async function inspect(root: string) {
  const result = await qat(["doctor", root, "--json"]);

  return { result, document: JSON.parse(result.stdout) as DetectionDocument };
}

/**
 * The codes of the blocking findings.
 *
 * Undefined codes are dropped rather than carried. A blocking finding always has one, so an absent code means the
 * document's shape changed — and a `toContain` on a filtered list fails loudly at that point instead of passing on a
 * loose `toContain` against an array of `string | undefined`.
 */
function blockingCodes(document: DetectionDocument): string[] {
  const codes = (document.assessment?.gates?.execute?.blocking ?? []).map(
    (finding) => finding.code,
  );

  return codes.filter((code): code is string => code !== undefined);
}

describe("a supported project", () => {
  it.each([
    "cypress.config.ts",
    "cypress.config.mts",
    "cypress.config.cts",
    "cypress.config.js",
    "cypress.config.mjs",
    "cypress.config.cjs",
  ])("detects a project configured with %s", async (file) => {
    const root = await temporaryProject({
      configured: false,
      extra: { [file]: "export default {};\n" },
    });

    const { result, document } = await inspect(root);

    // Every supported format, not just the one the default fixture writes. The candidate list is the specification of
    // what the tool reads, and a format that is in the list but not in this table is one nothing proves is reachable.
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(document.assessment?.diagnosis?.detection).toBe("detected");
    expect(document.assessment?.diagnosis?.framework?.configuration).toBe(file);
  });

  it("reports the pre-10 spec layout as driveable", async () => {
    const { result, document } = await inspect(
      await temporaryProject({ extra: { "cypress/smoke.cy.js": "" } }),
    );

    // Specs directly under `cypress/` are a supported layout, not a missing one — the two produce the same evidence and
    // only the classification separates them.
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(document.assessment?.diagnosis?.detection).toBe("detected");
  });
});

describe("a project QAT cannot drive", () => {
  it("reports a missing configuration as incomplete when the framework is installed", async () => {
    const { result, document } = await inspect(
      await temporaryProject({
        configured: false,
        extra: { "cypress/e2e/smoke.cy.ts": "" },
      }),
    );

    // Cypress is evidenced — installed, and a `cypress/` directory exists — so "not a Cypress project" would be the
    // wrong message.
    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(document.assessment?.diagnosis?.detection).toBe("not-detected");
    expect(blockingCodes(document)).toContain("QAT-D002");
  });

  it("reports a legacy configuration as an unusable format rather than as an absence", async () => {
    const { result, document } = await inspect(await temporaryLegacyProject());

    // A Cypress project whose owner needs to upgrade, not to move. Reporting it as "no configuration found" sends them
    // looking for something that is already there.
    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(document.assessment?.diagnosis?.detection).toBe("invalid");
    expect(blockingCodes(document)).toContain("QAT-D004");
  });

  it("reports an installation older than the configuration format as incompatible", async () => {
    const { result, document } = await inspect(
      await temporaryProject({ version: "9.7.0" }),
    );

    // `cypress.config.*` arrived in Cypress 10, so a 9.x installation cannot read the file whose presence identified
    // the project. Compatibility is `incompatible` rather than `undetermined`: there is something to compare.
    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(document.assessment?.diagnosis?.compatibility).toBe("incompatible");
    expect(blockingCodes(document)).toContain("QAT-D006");
  });

  it("reports two configuration files as ambiguous and keeps both", async () => {
    const { result, document } = await inspect(
      await temporaryAmbiguousProject(),
    );

    // No defensible ordering between `ts` and `js`: the presence of both means a migration was left unfinished, and
    // picking one would hide it.
    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(document.assessment?.diagnosis?.detection).toBe("ambiguous");
    expect(blockingCodes(document)).toContain("QAT-D003");
  });
});

describe("a directory that is not a project", () => {
  it("reports an unrelated Node project as absent", async () => {
    const { result, document } = await inspect(
      await temporaryUnrelatedProject(),
    );

    // The false positive the detection rules exist to prevent. A manifest and a source directory are not evidence of a
    // Cypress project, and if a manifest counted, every npm project would be an incomplete Cypress project.
    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(document.assessment?.diagnosis?.detection).toBe("not-detected");
    expect(blockingCodes(document)).toContain("QAT-D001");
  });

  it("reports an empty directory as absent", async () => {
    const { result, document } = await inspect(await temporaryDirectory());

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(blockingCodes(document)).toContain("QAT-D001");
  });
});
