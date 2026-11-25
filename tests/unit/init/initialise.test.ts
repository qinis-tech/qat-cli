/**
 * The initialisation workflow, with its three dependencies stubbed.
 *
 * What is under test is the *order* and the *outcomes*: judge before reading, read before writing, validate before
 * creating, and never touch a file that is already there. The contents of the file and the shape of the assessment are
 * other modules' business and are covered by their own suites, so the fixtures here stay as small as the types allow.
 *
 * Every case asserts the calls that were made, not only the result. A service that produced the right outcome by reading
 * the file twice, or by writing before it judged, would pass a result-only assertion and fail a reader who has to
 * reason about it later.
 *
 * The stubs are plain functions returning settled promises, not `async` functions. `async` on a body with no `await`
 * says nothing, and it hides the one distinction that matters here: `async () => { throw }` rejects, while `() => { throw }`
 * throws synchronously. A stub that has to fail uses `Promise.reject`, because that is what the real dependency does.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONFIG_FILE_NAME } from "~/config/contracts.js";
import {
  ConfigurationLoad,
  type ConfigurationLoadResult,
} from "~/config/loader/index.js";
import { markLoaded } from "~/config/resolver/index.js";
import { qatConfigSchema } from "~/config/schema/index.js";
import { ConfigurationDiagnosticCode } from "~/config/validation/index.js";
import {
  DiagnosticCode,
  DiagnosticSeverity,
  type ProjectDiagnosis,
} from "~/core/application/diagnostics.js";
import type { InitialisationService } from "~/core/application/initialisation.js";
import {
  OperationReadiness,
  QatOperation,
  ValidationCode,
  type AnyDiagnosticFinding,
  type OperationGate,
  type ProjectAssessment,
} from "~/core/application/validation.js";
import type { NewFileWriteOutcome } from "~/core/filesystem/index.js";
import {
  generateDefaultConfiguration,
  serialiseConfiguration,
} from "~/init/generate.js";
import { createInitialisationService } from "~/init/initialise.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const ROOT = "/project";
const CONFIG_PATH = join(ROOT, CONFIG_FILE_NAME);

function finding(code: AnyDiagnosticFinding["code"]): AnyDiagnosticFinding {
  return {
    code,
    severity: DiagnosticSeverity.Error,
    explanation: "Cypress is declared in devDependencies but is not installed.",
  };
}

function diagnosis(): ProjectDiagnosis {
  return {
    identity: {
      root: ROOT,
      name: "demo",
      packageMetadata: "present",
      declaredWorkspaces: [],
    },
    framework: {
      declaration: { section: "devDependencies", range: "^13.15.0" },
      installation: {
        framework: "cypress",
        version: "13.15.0",
        source: "project",
      },
      configuration: "cypress.config.ts",
      configurationsFound: ["cypress.config.ts"],
      unsupportedConfigurations: [],
      binaryAvailable: undefined,
    },
    detection: "detected",
    compatibility: "consistent",
    findings: [],
  };
}

/** An assessment whose execute gate holds whatever the case needs. */
function assessment(
  blocking: readonly AnyDiagnosticFinding[] = [],
): ProjectAssessment {
  const gate = (operation: QatOperation): OperationGate => ({
    operation,
    readiness:
      blocking.length === 0
        ? OperationReadiness.Ready
        : OperationReadiness.Blocked,
    blocking,
    warnings: [],
  });

  return {
    diagnosis: diagnosis(),
    findings: [],
    requirements: [],
    gates: {
      [QatOperation.Inspect]: gate(QatOperation.Inspect),
      [QatOperation.Execute]: gate(QatOperation.Execute),
    },
  };
}

/* Load outcomes ------------------------------------------------------------ */

const notFound = (): ConfigurationLoadResult => ({
  kind: ConfigurationLoad.NotFound,
  path: CONFIG_PATH,
});

/** A configuration that loaded: parsed through the schema, so the fixture is a real document and not a cast. */
const loaded = (): ConfigurationLoadResult => {
  const parsed = qatConfigSchema.safeParse(generateDefaultConfiguration());
  if (!parsed.success)
    throw new Error("fixture: the generated configuration must be valid");

  return {
    kind: ConfigurationLoad.Loaded,
    path: CONFIG_PATH,
    config: markLoaded(parsed.data, CONFIG_PATH),
  };
};

const empty = (): ConfigurationLoadResult => ({
  kind: ConfigurationLoad.Empty,
  path: CONFIG_PATH,
});

const malformed = (): ConfigurationLoadResult => ({
  kind: ConfigurationLoad.Malformed,
  path: CONFIG_PATH,
  reason: "Unexpected token } in JSON at position 42",
  location: { position: 42, line: 3, column: 1, excerpt: "}" },
});

const invalid = (): ConfigurationLoadResult => ({
  kind: ConfigurationLoad.Invalid,
  path: CONFIG_PATH,
  diagnostics: [
    {
      code: ConfigurationDiagnosticCode.WrongType,
      path: "framework",
      message: "framework must be cypress.",
      remediation: "Set it to cypress.",
    },
  ],
});

const tooLarge = (): ConfigurationLoadResult => ({
  kind: ConfigurationLoad.TooLarge,
  path: CONFIG_PATH,
  sizeBytes: 2_000_000,
  limitBytes: 1_048_576,
});

/* The service, with recording stubs ---------------------------------------- */

interface Harness {
  readonly initialise: InitialisationService["initialise"];
  /** Every dependency call, in order, as `assess:<root>`, `read:<path>` or `write:<path>`. */
  readonly calls: string[];
  /** What the writer was asked to create, in order. */
  readonly written: { readonly path: string; readonly contents: string }[];
}

function harness(
  options: {
    readonly assessment?: ProjectAssessment;
    /** Answers to successive reads. The last one repeats, so a case can describe one answer or several. */
    readonly loads?: readonly ConfigurationLoadResult[];
    readonly write?: NewFileWriteOutcome;
  } = {},
): Harness {
  const calls: string[] = [];
  const written: { path: string; contents: string }[] = [];
  const loads = options.loads ?? [notFound()];
  let reads = 0;

  const service = createInitialisationService({
    assess: (root) => {
      calls.push(`assess:${root}`);
      return Promise.resolve(options.assessment ?? assessment());
    },

    readConfiguration: (path) => {
      calls.push(`read:${path}`);
      const answer = loads[Math.min(reads, loads.length - 1)];
      reads += 1;

      return answer === undefined
        ? Promise.reject(new Error("fixture: no load answer configured"))
        : Promise.resolve(answer);
    },

    createFile: (path, contents) => {
      calls.push(`write:${path}`);
      written.push({ path, contents });
      return Promise.resolve(options.write ?? "created");
    },
  });

  // Wrapped rather than handed over as a method reference: extracting a member off an object is the kind of detail that
  // invites a `this` question later, and the wrapper costs one line.
  return { initialise: (root) => service.initialise(root), calls, written };
}

/* -------------------------------------------------------------------------- */
/* Positive: a project that can be initialised                                */
/* -------------------------------------------------------------------------- */

describe("initialising a usable project with no configuration", () => {
  it("creates the configuration and says so", async () => {
    const { initialise } = harness();

    const result = await initialise(ROOT);

    expect(result.outcome).toBe("created");
    expect(result).toMatchObject({ root: ROOT, path: CONFIG_PATH });
  });

  it("writes the document the generator produces, byte for byte", async () => {
    const { initialise, written } = harness();

    await initialise(ROOT);

    // Coupled to the generator on purpose: the service's job is to put exactly that document on disk, and a service that
    // assembled its own would be a second answer to what a new project receives.
    expect(written).toStrictEqual([
      {
        path: CONFIG_PATH,
        contents: serialiseConfiguration(generateDefaultConfiguration()),
      },
    ]);
  });

  it("judges, then reads, then writes, in that order", async () => {
    const { initialise, calls } = harness();

    await initialise(ROOT);

    // Reading a file before deciding the directory is a usable project would produce a refusal that named the wrong
    // problem. Writing before reading would clobber it.
    expect(calls).toStrictEqual([
      `assess:${ROOT}`,
      `read:${CONFIG_PATH}`,
      `write:${CONFIG_PATH}`,
    ]);
  });

  it("puts the file beside the project, not beside the process", async () => {
    const { initialise, written } = harness();

    await initialise(ROOT);

    expect(written[0]?.path.startsWith(ROOT)).toBe(true);
    expect(written[0]?.path).not.toContain(process.cwd());
  });

  it("proceeds when the only blocking findings are about the machine", async () => {
    // The journey this protects: clone, `qat init`, `npm ci`, `qat run`.
    const { initialise, calls } = harness({
      assessment: assessment([
        finding(DiagnosticCode.DependencyNotInstalled),
        finding(DiagnosticCode.ManifestMissing),
      ]),
    });

    expect((await initialise(ROOT)).outcome).toBe("created");
    expect(calls).toContain(`write:${CONFIG_PATH}`);
  });

  it("is already initialised when a configuration loaded", async () => {
    const { initialise, written } = harness({ loads: [loaded()] });

    const result = await initialise(ROOT);

    expect(result.outcome).toBe("already-initialised");
    expect(written).toStrictEqual([]);
  });

  it("reports the same thing on a second run", async () => {
    // The end state a caller cares about — this project has a configuration — is true after the first run, so a second
    // run is not a failure.
    const first = await harness().initialise(ROOT);
    const second = await harness({ loads: [loaded()] }).initialise(ROOT);

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("already-initialised");
  });
});

/* -------------------------------------------------------------------------- */
/* Negative: a project that cannot be initialised                             */
/* -------------------------------------------------------------------------- */

describe("a project QAT cannot configure", () => {
  it("refuses before reading anything", async () => {
    const { initialise, calls, written } = harness({
      assessment: assessment([finding(DiagnosticCode.FrameworkNotDetected)]),
    });

    const result = await initialise(ROOT);

    expect(result.outcome).toBe("project-not-usable");
    // No read at all: the answer was decided from the assessment, and a read would have been work done to describe a
    // directory that is already refused.
    expect(calls).toStrictEqual([`assess:${ROOT}`]);
    expect(written).toStrictEqual([]);
  });

  it("carries only the findings that are about the project", async () => {
    const { initialise } = harness({
      assessment: assessment([
        finding(DiagnosticCode.DependencyNotInstalled),
        finding(ValidationCode.ConfigurationMisplaced),
      ]),
    });

    const result = await initialise(ROOT);

    expect(result.outcome).toBe("project-not-usable");
    if (result.outcome !== "project-not-usable") return;

    // The excused condition is not reported: telling a reader about an uninstalled dependency while refusing for a
    // misplaced configuration sends them to install something they do not need yet.
    expect(result.findings.map((one) => one.code)).toStrictEqual([
      ValidationCode.ConfigurationMisplaced,
    ]);
  });
});

describe("something already at the configuration path", () => {
  it.each([
    ["an empty file", empty],
    ["a malformed file", malformed],
    ["an invalid file", invalid],
    ["an oversized file", tooLarge],
  ])("refuses to replace %s", async (_case, make) => {
    const answer = make();
    const { initialise, written } = harness({ loads: [answer] });

    const result = await initialise(ROOT);

    expect(result.outcome).toBe("existing-configuration");
    expect(result).toMatchObject({ reason: answer.kind });
    // Nothing was removed and nothing was written: QAT does not touch a file it did not write.
    expect(written).toStrictEqual([]);
  });

  it("explains a malformed file by line and column", async () => {
    const { initialise } = harness({ loads: [malformed()] });

    const result = await initialise(ROOT);
    if (result.outcome !== "existing-configuration")
      throw new Error("expected a refusal");

    expect(result.findings[0]?.explanation).toContain("line 3 column 1");
    expect(result.findings[0]?.remediation).toContain("Fix or delete");
  });

  it("passes a schema refusal through as the reader wrote it", async () => {
    const { initialise } = harness({ loads: [invalid()] });

    const result = await initialise(ROOT);
    if (result.outcome !== "existing-configuration")
      throw new Error("expected a refusal");

    expect(result.findings).toStrictEqual([
      {
        code: ConfigurationDiagnosticCode.WrongType,
        severity: DiagnosticSeverity.Error,
        explanation: "framework: framework must be cypress.",
        path: "framework",
        remediation: "Set it to cypress.",
      },
    ]);
  });

  it("never quotes the contents of the file", async () => {
    const { initialise } = harness({ loads: [invalid()] });

    const result = await initialise(ROOT);
    if (result.outcome !== "existing-configuration")
      throw new Error("expected a refusal");

    // A configuration can carry environment variables, so the finding repeats the rule's message and not the value that
    // failed it. Asserted as a property rather than as one string, because the guarantee is about all findings.
    for (const one of result.findings) {
      expect(one.explanation).not.toContain("API_URL=");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Corner: the file appears between the check and the write                    */
/* -------------------------------------------------------------------------- */

describe("a file created between the check and the write", () => {
  it("reports already initialised rather than failing", async () => {
    const { initialise, calls } = harness({
      loads: [notFound(), loaded()],
      write: "exists",
    });

    const result = await initialise(ROOT);

    // The writer refused to replace it, which is the whole reason it reports rather than throws. Their file is now the
    // project's file, so the answer is the one we would have given a moment earlier.
    expect(result.outcome).toBe("already-initialised");
    expect(calls.filter((call) => call.startsWith("read:"))).toHaveLength(2);
  });

  it("reports what actually landed when it cannot be used", async () => {
    const { initialise } = harness({
      loads: [notFound(), invalid()],
      write: "exists",
    });

    const result = await initialise(ROOT);

    expect(result.outcome).toBe("existing-configuration");
    expect(result).toMatchObject({ reason: ConfigurationLoad.Invalid });
  });

  it("says to try again when the file vanished as quickly as it appeared", async () => {
    const { initialise } = harness({
      loads: [notFound(), notFound()],
      write: "exists",
    });

    const result = await initialise(ROOT);
    if (result.outcome !== "existing-configuration")
      throw new Error("expected a refusal");

    // Nothing to fix, so the remedy is the only honest one.
    expect(result.findings[0]?.code).toBe("QAT-INIT-EXISTING-DISAPPEARED");
    expect(result.findings[0]?.remediation).toBe("Run the command again.");
  });
});

/* -------------------------------------------------------------------------- */
/* Boundary and failure propagation                                           */
/* -------------------------------------------------------------------------- */

describe("failures that are not outcomes", () => {
  it("propagates a write that failed for a reason other than the file existing", async () => {
    const service = createInitialisationService({
      assess: () => Promise.resolve(assessment()),
      readConfiguration: () => Promise.resolve(notFound()),
      // Rejects rather than throws: a filesystem failure arrives from an awaited call, so the fake must fail the same
      // way or the service would be tested against a synchronous escape it will never see.
      createFile: () => Promise.reject(new Error("ENOSPC")),
    });

    // A full disk is not an answer about the project, so it is not an outcome. The command's error handler renders it
    // with the filesystem category it came in with.
    await expect(service.initialise(ROOT)).rejects.toThrow("ENOSPC");
  });

  it("propagates an assessment that failed for a non-project reason", async () => {
    const service = createInitialisationService({
      assess: () => Promise.reject(new Error("EACCES")),
      readConfiguration: () => Promise.resolve(notFound()),
      createFile: () => Promise.resolve("created"),
    });

    await expect(service.initialise(ROOT)).rejects.toThrow("EACCES");
  });
});

/* -------------------------------------------------------------------------- */
/* Non-functional                                                             */
/* -------------------------------------------------------------------------- */

describe("non-functional behaviour", () => {
  it("does not modify the assessment it was given", async () => {
    const value = assessment([finding(DiagnosticCode.FrameworkNotDetected)]);
    const before = structuredClone(value);

    await harness({ assessment: value }).initialise(ROOT);

    // The command renders the same assessment afterwards; a service that sorted or spliced the gate's arrays would
    // change what the reader sees after the refusal.
    expect(value).toStrictEqual(before);
  });

  it("returns a promise", async () => {
    const pending = harness().initialise(ROOT);

    expect(pending).toBeInstanceOf(Promise);
    await pending;
  });

  it("is deterministic", async () => {
    const first = await harness().initialise(ROOT);
    const second = await harness().initialise(ROOT);

    expect(second).toStrictEqual(first);
  });
});
