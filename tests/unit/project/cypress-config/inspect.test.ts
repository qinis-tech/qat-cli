/**
 * The CFG-003 location projection.
 *
 * These tests drive `inspectConfiguration` with values only — no filesystem, no detection run, no fixtures on disk. That is
 * the point of the projection existing: every branch of a thirteen-reason union is a literal away, including the ones a
 * test would otherwise have to construct a directory tree to reach (a directory on the configuration path, a symlink
 * escaping the project, a file nobody may read).
 *
 * What is *not* tested here: whether the file is valid. That is the ladder's job and its own suite's; this module
 * deliberately never looks at the sample.
 */

import { describe, expect, it } from "vitest";

import type {
  ConfigDiscovery,
  ConfigFileFacts,
  ConfigFileState,
  ConfigTextSample,
} from "~/project/cypress-config/index.js";
import {
  inspectConfiguration,
  inspectMisplacedConfiguration,
} from "~/project/cypress-config/index.js";
import type {
  CypressLayout,
  DetectedProject,
  DetectionEvidence,
  UndetectedProject,
} from "~/project/cypress-detection/index.js";
import type { PackageDiscovery } from "~/project/package-discovery/index.js";

const ROOT = "/projects/example";

/**
 * Declares a value as a type this test does not read.
 *
 * The one escape hatch here, and deliberately generic: `unknown` in, `T` out, and — because the argument is an identifier
 * rather than an object literal — the annotated-literal rule stays satisfied. It is not a claim about the value's shape;
 * it is a statement that the shape is somebody else's business.
 *
 * Use it only for evidence a test never consults. Anything a test asserts on deserves a real fixture, because a placeholder
 * that happens to be read produces a failure with no relationship to what the test claims to prove.
 */
function opaque<T>(value: unknown): T {
  return value as T;
}

/**
 * Detection evidence this projection never reads.
 *
 * `PackageDiscovery` requires a manifest, a declaration and an installation, and this module consults none of them: it reads
 * configuration names and layout evidence. Building those three fields here would couple every assertion below to a module
 * this file does not test, and would break the whole suite the day `package-discovery` changes shape — for a reason
 * unrelated to the configuration projection.
 *
 * The alternative is a fixture in `tests/helpers`, which is the right home once anything in this file starts reading package
 * evidence. Until then the honest description is "present because the type requires it, read by nobody".
 */
const NO_PACKAGES = opaque<PackageDiscovery>({});

/** The two states that mean "this is not a file Cypress can read". Named so the loop below needs no inline assertion. */
const NOT_A_FILE_STATES: readonly ConfigFileState[] = [
  "directory",
  "dangling-symlink",
];

function layout(overrides: Partial<CypressLayout> = {}): CypressLayout {
  return {
    specDirectories: [],
    supportFiles: [],
    hasCypressDirectory: false,
    misplacedConfigurations: [],
    occupiedConfigurationPaths: [],
    ...overrides,
  };
}

function detected(
  overrides: Partial<DetectionEvidence> & { readonly configuration: string },
): DetectedProject {
  return {
    root: ROOT,
    configurations: [overrides.configuration],
    unsupportedConfigurations: [],
    packages: NO_PACKAGES,
    layout: layout(),
    ...overrides,
    verdict: "detected",
  };
}

function notDetected(
  verdict: UndetectedProject["verdict"],
  overrides: Partial<DetectionEvidence> = {},
): UndetectedProject {
  return {
    root: ROOT,
    configurations: [],
    unsupportedConfigurations: [],
    packages: NO_PACKAGES,
    layout: layout(),
    ...overrides,
    verdict,
  };
}

function facts(overrides: Partial<ConfigFileFacts> = {}): ConfigFileFacts {
  return {
    file: "cypress.config.ts",
    absolutePath: `${ROOT}/cypress.config.ts`,
    state: "file",
    sizeBytes: 512,
    ...overrides,
  };
}

/** A sample that established nothing. Included only where a test needs to prove it is ignored. */
const UNREADABLE_SAMPLE: ConfigTextSample = {
  state: "unreadable",
  text: "",
  bytesRead: 0,
  truncated: false,
  decodable: true,
  containsBinary: false,
};

const reasonOf = (verdict: ConfigDiscovery): string => verdict.reason;

describe("inspectConfiguration — when nothing is configured", () => {
  it("reports a project with no Cypress evidence at all", () => {
    const verdict = inspectConfiguration({ detection: notDetected("absent") });

    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_MISSING",
      outcome: "fail",
      // The clause a reader needs: "nothing here is Cypress" is a setup problem, while "Cypress is here but
      // unconfigured" is a half-finished migration. Same reason, different opening sentence.
      context: "no-cypress-evidence",
    });
  });

  it("distinguishes a project that evidences Cypress but has no configuration", () => {
    const verdict = inspectConfiguration({
      detection: notDetected("incomplete", {
        layout: layout({ hasCypressDirectory: true }),
      }),
    });

    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_MISSING",
      outcome: "fail",
      context: "cypress-evidenced",
    });
  });

  it("reports a directory occupying the configuration path ahead of plain absence", () => {
    const verdict = inspectConfiguration({
      detection: notDetected("absent", {
        layout: layout({ occupiedConfigurationPaths: ["cypress.config.ts"] }),
      }),
    });

    // A file probe cannot see a directory, so every layer below says "no configuration found" — correctly. Without this
    // branch the reader is told to create a file that cannot be created.
    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_PATH_OCCUPIED",
      outcome: "fail",
      paths: ["cypress.config.ts"],
    });
  });

  it("reports a misplaced configuration when no path is occupied", () => {
    const verdict = inspectConfiguration({
      detection: notDetected("incomplete", {
        layout: layout({
          misplacedConfigurations: ["cypress/cypress.config.ts"],
        }),
      }),
    });

    // Configured, just not where Cypress looks: the fix is to move a file, not to write one.
    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_MISPLACED",
      outcome: "warning",
      files: ["cypress/cypress.config.ts"],
    });
  });

  it("reports the occupied path first when both layout problems are present", () => {
    const verdict = inspectConfiguration({
      detection: notDetected("absent", {
        layout: layout({
          occupiedConfigurationPaths: ["cypress.config.ts"],
          misplacedConfigurations: ["cypress/cypress.config.ts"],
        }),
      }),
    });

    // Documented precedence rather than an accident: a path that cannot be written to is a harder blocker than a file in
    // the wrong place, and fixing the second while the first remains changes nothing.
    expect(reasonOf(verdict)).toBe("CYPRESS_CONFIG_PATH_OCCUPIED");
  });

  it("orders the reported paths so two machines agree", () => {
    const verdict = inspectConfiguration({
      detection: notDetected("absent", {
        layout: layout({
          occupiedConfigurationPaths: [
            "cypress.config.mjs",
            "cypress.config.ts",
          ],
        }),
      }),
    });

    expect(verdict).toMatchObject({
      paths: ["cypress.config.mjs", "cypress.config.ts"],
    });
  });
});

describe("inspectConfiguration — ambiguity and unusable formats", () => {
  it("names every configuration file and refuses to choose one", () => {
    const verdict = inspectConfiguration({
      detection: notDetected("ambiguous", {
        configurations: ["cypress.config.ts", "cypress.config.js"],
      }),
    });

    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_AMBIGUOUS",
      outcome: "fail",
      // Sorted, because evidence order must never depend on directory iteration order.
      files: ["cypress.config.js", "cypress.config.ts"],
    });
  });

  it("names the unusable files alongside any recognised one", () => {
    const verdict = inspectConfiguration({
      detection: notDetected("unsupported", {
        configurations: ["cypress.config.ts"],
        unsupportedConfigurations: ["cypress.json"],
      }),
    });

    // Both sets: a project mid-migration has a usable-looking file and an ignored one, and naming only the ignored half
    // sends the reader to the wrong file.
    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_UNSUPPORTED_NAME",
      outcome: "fail",
      files: ["cypress.config.ts", "cypress.json"],
    });
  });
});

describe("inspectConfiguration — the file detection accepted", () => {
  it("reports an unobserved file as indeterminate rather than assuming it is fine", () => {
    const verdict = inspectConfiguration({
      detection: detected({ configuration: "cypress.config.ts" }),
    });

    // Detection said the file is there; without facts we have observed nothing about it, so we say so.
    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_NOT_INSPECTED",
      outcome: "indeterminate",
      file: "cypress.config.ts",
    });
  });

  it("reports a symlink that escapes the project, and where it escaped to", () => {
    const verdict = inspectConfiguration({
      detection: detected({ configuration: "cypress.config.ts" }),
      facts: facts({
        absolutePath: "/shared/cypress.config.ts",
        state: "outside-project",
      }),
    });

    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_OUTSIDE_PROJECT",
      outcome: "fail",
      file: "cypress.config.ts",
      // The one absolute path we ever report: it is the fact a reader needs to see where the link goes.
      resolvedPath: "/shared/cypress.config.ts",
      projectRoot: ROOT,
    });
  });

  it("reports a directory and a dangling link identically: neither is a file Cypress can read", () => {
    for (const state of NOT_A_FILE_STATES) {
      const verdict = inspectConfiguration({
        detection: detected({ configuration: "cypress.config.ts" }),
        facts: facts({ state }),
      });

      // Different filesystem situations, one sentence: the actionable fact in both cases is that this is not a file.
      expect(verdict).toMatchObject({
        reason: "CYPRESS_CONFIG_NOT_A_FILE",
        outcome: "fail",
      });
    }
  });

  it("reports a file that exists and cannot be read", () => {
    const verdict = inspectConfiguration({
      detection: detected({ configuration: "cypress.config.ts" }),
      facts: facts({ state: "unreadable" }),
    });

    // Not "missing": the file is there, so telling the reader to create one would be actively misleading.
    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_UNREADABLE",
      outcome: "fail",
      cause: "permissions",
    });
  });

  it("reports an empty file as empty rather than as an unreadable or invalid one", () => {
    const verdict = inspectConfiguration({
      detection: detected({ configuration: "cypress.config.ts" }),
      facts: facts({ sizeBytes: 0 }),
    });

    // Zero bytes is not the same as unreadable, and the remedy is different: write the configuration rather than fix a
    // permission.
    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_EMPTY",
      outcome: "fail",
    });
  });

  it("accepts a modern module configuration", () => {
    const verdict = inspectConfiguration({
      detection: detected({ configuration: "cypress.config.ts" }),
      facts: facts(),
    });

    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_FOUND",
      outcome: "pass",
      file: "cypress.config.ts",
      format: "executable",
      sizeBytes: 512,
    });
  });

  it("warns about the pre-v10 format without failing the project", () => {
    const verdict = inspectConfiguration({
      detection: detected({ configuration: "cypress.json" }),
      facts: facts({ file: "cypress.json", sizeBytes: 120 }),
    });

    // Detected, readable and valid for its era. Failing it would fail a project that runs today.
    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_LEGACY_FORMAT",
      outcome: "warning",
      file: "cypress.json",
      sizeBytes: 120,
    });
  });

  it("reports the name detection gave, not the symlink target", () => {
    const verdict = inspectConfiguration({
      detection: detected({ configuration: "cypress.config.ts" }),
      facts: facts({ absolutePath: `${ROOT}/config/cypress.config.ts` }),
    });

    // The evidence must name the file the user recognises. Only the internal absolute path follows the link.
    expect(verdict).toMatchObject({ file: "cypress.config.ts" });
  });

  it("never lets the content sample change the location verdict", () => {
    const withUnreadableSample = inspectConfiguration({
      detection: detected({ configuration: "cypress.config.ts" }),
      facts: facts({ sample: UNREADABLE_SAMPLE }),
    });

    const withoutSample = inspectConfiguration({
      detection: detected({ configuration: "cypress.config.ts" }),
      facts: facts(),
    });

    // Validity belongs to the ladder. A location verdict that reacted to the sample would be a second opinion about the
    // file's contents, and the two would eventually disagree.
    expect(withUnreadableSample).toStrictEqual(withoutSample);
  });
});

describe("inspectConfiguration — properties of the projection", () => {
  it("returns a frozen value", () => {
    const verdict = inspectConfiguration({ detection: notDetected("absent") });

    // Frozen at the source: the verdict travels into evidence, and a consumer that sorted a list in place would reorder a
    // shared observation for every other consumer of the same run.
    expect(Object.isFrozen(verdict)).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const detection = notDetected("ambiguous", {
      configurations: ["cypress.config.ts", "cypress.config.js"],
    });

    expect(inspectConfiguration({ detection })).toStrictEqual(
      inspectConfiguration({ detection }),
    );
  });
});

describe("inspectMisplacedConfiguration", () => {
  it("reports a stale copy that sits beside a working configuration", () => {
    const advisory = inspectMisplacedConfiguration(
      detected({
        configuration: "cypress.config.ts",
        layout: layout({
          misplacedConfigurations: ["cypress/cypress.config.ts"],
        }),
      }),
    );

    expect(advisory).toMatchObject({
      reason: "CYPRESS_CONFIG_MISPLACED",
      outcome: "warning",
      files: ["cypress/cypress.config.ts"],
    });
  });

  it("says nothing when there is no misplaced copy", () => {
    expect(
      inspectMisplacedConfiguration(
        detected({ configuration: "cypress.config.ts" }),
      ),
    ).toBeUndefined();
  });

  it("says nothing when the project has no configuration at all", () => {
    // The failure path already explains itself; reporting the same file twice would make one problem look like two.
    const advisory = inspectMisplacedConfiguration(
      notDetected("incomplete", {
        layout: layout({
          misplacedConfigurations: ["cypress/cypress.config.ts"],
        }),
      }),
    );

    expect(advisory).toBeUndefined();
  });
});
