/**
 * The CFG-004 validation ladder.
 *
 * These tests drive `validateConfiguration` with values only — no filesystem, no process, no real Cypress. The one
 * impurity the ladder has is the injected loader probe, so every case supplies a fake that records what it was asked
 * and answers with the outcome under test. That is what makes the interesting branches reachable at all: a timeout, an
 * unavailable loader and a 900-character stack trace are three lines here and an afternoon of process engineering
 * otherwise.
 *
 * The suite is organised by tier, because the ladder is: what happens before a byte is read (T0), what a parser
 * establishes (T1), what only the project's own loader can (T2), and — the half that matters most — every way the
 * ladder is entitled to *stop without a verdict*.
 */

import { describe, expect, it } from "vitest";

import type {
  ConfigDiscovery,
  ConfigFileFacts,
  ConfigLoadProbePort,
  ConfigLoadProbeResult,
  ConfigTextSample,
  ConfigValidation,
} from "~/project/cypress-config/index.js";
import {
  MAX_LOADER_MESSAGE_CHARS,
  sanitiseLoaderMessage,
  validateConfiguration,
} from "~/project/cypress-config/index.js";

const ROOT = "/projects/example";
const FILE = "cypress.config.ts";

/** A modern module configuration, located and readable. */
const FOUND: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_FOUND",
  outcome: "pass",
  file: FILE,
  format: "executable",
  sizeBytes: 512,
};

/** The same, in the JSON carrier — which routes the ladder through T1 instead of T2. */
const FOUND_JSON: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_FOUND",
  outcome: "pass",
  file: "cypress.json",
  format: "json",
  sizeBytes: 40,
};

const LEGACY: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_LEGACY_FORMAT",
  outcome: "warning",
  file: "cypress.json",
  sizeBytes: 40,
};

/**
 * Every verdict that leaves nothing to validate.
 *
 * Written as a list rather than one case per reason, because the assertion is the same for all of them: the ladder
 * refuses to have an opinion, and says which check it is waiting on. A new reason added to the union will not appear
 * here automatically — that is what the projection's own suite is for — but every reason that exists today is covered.
 */
const NOT_LOADABLE = [
  {
    reason: "CYPRESS_CONFIG_MISSING",
    outcome: "fail",
    context: "cypress-evidenced",
  },
  {
    reason: "CYPRESS_CONFIG_AMBIGUOUS",
    outcome: "fail",
    files: ["cypress.config.js", FILE],
  },
  {
    reason: "CYPRESS_CONFIG_UNSUPPORTED_NAME",
    outcome: "fail",
    files: ["cypress.config.yaml"],
  },
  {
    reason: "CYPRESS_CONFIG_MISPLACED",
    outcome: "warning",
    files: [`cypress/${FILE}`],
  },
  {
    reason: "CYPRESS_CONFIG_PATH_OCCUPIED",
    outcome: "fail",
    paths: [FILE],
  },
  {
    reason: "CYPRESS_CONFIG_NOT_A_FILE",
    outcome: "fail",
    file: FILE,
  },
  {
    reason: "CYPRESS_CONFIG_OUTSIDE_PROJECT",
    outcome: "fail",
    file: FILE,
    resolvedPath: "/shared/cypress.config.ts",
    projectRoot: ROOT,
  },
  {
    reason: "CYPRESS_CONFIG_UNREADABLE",
    outcome: "fail",
    file: FILE,
    cause: "permissions",
  },
  {
    reason: "CYPRESS_CONFIG_EMPTY",
    outcome: "fail",
    file: FILE,
  },
  {
    reason: "CYPRESS_CONFIG_NOT_INSPECTED",
    outcome: "indeterminate",
    file: FILE,
  },
] as const satisfies readonly ConfigDiscovery[];

const NOT_APPLICABLE: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_NOT_APPLICABLE",
  outcome: "skipped",
  detail: "No Cypress configuration is expected in this project.",
};

function sample(overrides: Partial<ConfigTextSample> = {}): ConfigTextSample {
  return {
    state: "sampled",
    text: "export default {};",
    bytesRead: 18,
    truncated: false,
    decodable: true,
    containsBinary: false,
    ...overrides,
  };
}

function facts(overrides: Partial<ConfigFileFacts> = {}): ConfigFileFacts {
  return {
    file: FILE,
    absolutePath: `${ROOT}/${FILE}`,
    state: "file",
    sizeBytes: 512,
    sample: sample(),
    ...overrides,
  };
}

/** The probe, plus the calls it saw. A probe that was never called is itself an assertion in several cases below. */
interface RecordingProbe {
  readonly port: ConfigLoadProbePort;
  readonly calls: { readonly projectRoot: string }[];
}

/**
 * A scripted probe.
 *
 * Not `async`: the fake performs no I/O, so declaring it asynchronous would claim work it does not do — and the lint
 * rules are right to refuse that, because it is the same habit that produces `await` on values that are already there.
 * Returning `Promise.resolve` states the contract (`Promise<ConfigLoadProbeResult>`) without implying a wait.
 */
function portReturning(result: ConfigLoadProbeResult): RecordingProbe {
  const calls: { projectRoot: string }[] = [];

  return {
    calls,
    port: {
      load: (input) => {
        calls.push(input);
        return Promise.resolve(result);
      },
    },
  };
}

const DEEP = { enabled: true } as const;

/**
 * A call with everything a healthy executable configuration would supply.
 *
 * Spelled out rather than defaulted inline so each case reads as "the same call, one thing changed" — and so the
 * `exactOptionalPropertyTypes` rule is satisfied without a cast: `deep` and `probe` are omitted rather than set to
 * `undefined`.
 */
async function validate(
  overrides: {
    discovery?: ConfigDiscovery;
    facts?: ConfigFileFacts | undefined;
    deep?: { readonly enabled: boolean };
    probe?: ConfigLoadProbePort;
  } = {},
): Promise<ConfigValidation> {
  return validateConfiguration({
    projectRoot: ROOT,
    discovery: overrides.discovery ?? FOUND,
    facts: "facts" in overrides ? overrides.facts : facts(),
    ...(overrides.deep === undefined ? {} : { deep: overrides.deep }),
    ...(overrides.probe === undefined ? {} : { probe: overrides.probe }),
  });
}

describe("when nothing is located", () => {
  it.each(NOT_LOADABLE.map((verdict) => [verdict.reason, verdict] as const))(
    "skips with the check it is waiting on, for %s",
    async (_reason, discovery) => {
      const probe = portReturning({ outcome: "loaded", durationMs: 1 });

      const verdict = await validate({ discovery, probe: probe.port });

      // A skip, not an indeterminate: we did not look, because there was nothing to look at. The distinction is the
      // whole difference between "unanswered" and "unasked".
      expect(verdict).toMatchObject({
        reason: "CYPRESS_CONFIG_SKIPPED",
        outcome: "skipped",
        prerequisite: "CFG-003",
      });
      expect(verdict).toHaveProperty(
        "detail",
        expect.stringContaining(discovery.reason),
      );

      // The loader is never consulted for a configuration nobody located — the process would be spent discovering
      // what the report already says.
      expect(probe.calls).toStrictEqual([]);
    },
  );

  it("says a non-Cypress project has nothing to validate, rather than naming a fault", async () => {
    const verdict = await validate({ discovery: NOT_APPLICABLE });

    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_SKIPPED",
      outcome: "skipped",
      detail: expect.stringContaining("No Cypress configuration is expected"),
    });
  });
});

describe("text sanity (T0)", () => {
  it("reports a located file whose facts were never gathered", async () => {
    const probe = portReturning({ outcome: "loaded", durationMs: 1 });

    const verdict = await validate({ facts: undefined, probe: probe.port });

    // An assembly defect, not a project condition: detection said the file is there and nothing inspected it. Reported
    // as a gap rather than a failure, and the probe stays unused because there is no text to hand it.
    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_NOT_VALIDATED",
      outcome: "indeterminate",
      file: FILE,
      cause: "text-sanity-not-established",
      tier: "T0-text",
    });
    expect(probe.calls).toStrictEqual([]);
  });

  it("reports an oversize file without claiming any tier spoke", async () => {
    const verdict = await validate({
      facts: facts({
        sizeBytes: 4_194_304,
        sample: sample({
          state: "skipped-too-large",
          text: "",
          bytesRead: 0,
          truncated: true,
        }),
      }),
    });

    // `none` rather than `T0-text`, and that asymmetry is deliberate: no byte was read, so no tier judged anything.
    // Reporting `T0-text` would imply a text judgement that never happened.
    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_NOT_VALIDATED",
      cause: "size-budget-exceeded",
      tier: "none",
    });
  });

  it("reports a file that could not be read", async () => {
    const verdict = await validate({
      facts: facts({
        sample: sample({ state: "unreadable", text: "", bytesRead: 0 }),
      }),
    });

    expect(verdict).toMatchObject({
      cause: "text-sanity-not-established",
      tier: "T0-text",
    });
  });

  it("reports bytes that are not valid UTF-8 as undecodable, not as empty", async () => {
    const verdict = await validate({
      facts: facts({ sample: sample({ decodable: false, text: "" }) }),
    });

    // The distinction the sample's `decodable` flag exists for: a file of invalid bytes and a file of only a BOM both
    // decode to an empty string, and conflating them turns "cannot read this" into "this file is empty".
    expect(verdict).toMatchObject({
      cause: "undecodable-text",
      tier: "T0-text",
    });
  });

  it("refuses to hand binary content to a loader", async () => {
    const probe = portReturning({ outcome: "loaded", durationMs: 1 });

    const verdict = await validate({
      facts: facts({
        sample: sample({
          containsBinary: true,
          text: "export default {};\u0000",
        }),
      }),
      probe: probe.port,
    });

    // NUL bytes are valid UTF-8, so decodability alone cannot tell binary from text. Spawning a process to read this
    // would be a wasted process.
    expect(verdict).toMatchObject({ cause: "text-sanity-not-established" });
    expect(probe.calls).toStrictEqual([]);
  });

  it("treats a whitespace-only file as carrying no configuration", async () => {
    const verdict = await validate({
      facts: facts({ sample: sample({ text: "  \n\t\n " }) }),
    });

    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_NOT_VALIDATED",
      cause: "text-sanity-not-established",
    });
  });
});

describe("a JSON configuration (T1)", () => {
  it("accepts a settings object and names the parser as the authority", async () => {
    const probe = portReturning({ outcome: "loaded", durationMs: 1 });

    const verdict = await validate({
      discovery: FOUND_JSON,
      facts: facts({
        file: "cypress.json",
        sample: sample({ text: '{"baseUrl":"http://localhost:3000"}' }),
      }),
      probe: probe.port,
    });

    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_VALIDATED",
      outcome: "pass",
      tier: "T1-json",
    });

    // Terminal: a parser cannot be wrong about syntax, so involving the loader would buy a process, a timeout and a
    // failure mode in exchange for no extra certainty.
    expect(probe.calls).toStrictEqual([]);
  });

  it("parses the legacy carrier too, because deprecation is a format question", async () => {
    const verdict = await validate({
      discovery: LEGACY,
      facts: facts({ file: "cypress.json", sample: sample({ text: "{}" }) }),
    });

    // The legacy verdict names a usable file; only its era is a problem. Validating it is a separate question with a
    // separate answer, and the answer here is "the parser liked it".
    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_VALIDATED",
      tier: "T1-json",
    });
  });

  it("establishes a syntax error, with a line for the reader", async () => {
    const verdict = await validate({
      discovery: FOUND_JSON,
      facts: facts({
        file: "cypress.json",
        sample: sample({ text: '{\n  "baseUrl": "http://localhost:3000",\n}' }),
      }),
    });

    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_INVALID",
      outcome: "fail",
      tier: "T1-json",
      failure: { kind: "syntax" },
    });

    // The exact number is the parser's business and varies between runtimes; what the ladder promises is a positive
    // line number it derived from the message rather than from the file.
    const failure =
      verdict.reason === "CYPRESS_CONFIG_INVALID" ? verdict.failure : undefined;
    expect(failure?.line).toBeGreaterThan(0);
  });

  it("distinguishes a shape problem from a syntax problem", async () => {
    for (const text of ["[]", "null", "42", '"a string"']) {
      const verdict = await validate({
        discovery: FOUND_JSON,
        facts: facts({ file: "cypress.json", sample: sample({ text }) }),
      });

      // Parses perfectly, and is still unusable. Reporting this as a syntax error would send the reader looking for a
      // stray comma in a file that has none.
      expect(verdict).toMatchObject({
        reason: "CYPRESS_CONFIG_INVALID",
        outcome: "fail",
        tier: "T1-json",
        failure: { kind: "shape" },
      });
    }
  });

  it("never reports a line number it had to invent", async () => {
    const verdict = await validate({
      discovery: FOUND_JSON,
      facts: facts({ file: "cypress.json", sample: sample({ text: "[]" }) }),
    });

    // A shape failure is not positional, so there is no line — and `undefined` is the honest answer rather than `1`.
    const failure =
      verdict.reason === "CYPRESS_CONFIG_INVALID" ? verdict.failure : undefined;
    expect(failure?.line).toBeUndefined();
  });
});

describe("an executable configuration (T2)", () => {
  it("does not load anything unless deep validation was asked for", async () => {
    const probe = portReturning({ outcome: "loaded", durationMs: 1 });

    const absent = await validate({ probe: probe.port });
    const disabled = await validate({
      deep: { enabled: false },
      probe: probe.port,
    });

    // Both are the default path, and both conclude the same way. Loading a configuration executes project code, which
    // is acceptable on request and unacceptable as a silent default.
    expect([absent, disabled]).toStrictEqual([
      expect.objectContaining({
        reason: "CYPRESS_CONFIG_NOT_VALIDATED",
        cause: "deep-validation-disabled",
      }),
      expect.objectContaining({
        reason: "CYPRESS_CONFIG_NOT_VALIDATED",
        cause: "deep-validation-disabled",
      }),
    ]);
    expect(probe.calls).toStrictEqual([]);
  });

  it("reports that no loader exists when deep validation is asked for without one", async () => {
    const verdict = await validate({ deep: DEEP });

    // A missing mechanism is not a verdict about the file: `unavailable` rather than `invalid`.
    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_NOT_VALIDATED",
      cause: "deep-validation-unavailable",
      tier: "T0-text",
    });
  });

  it("accepts what the project's own loader accepted, in the project itself", async () => {
    const probe = portReturning({ outcome: "loaded", durationMs: 812 });

    const verdict = await validate({ deep: DEEP, probe: probe.port });

    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_VALIDATED",
      outcome: "pass",
      tier: "T2-cypress",
      // Recorded because profundity costs a process, and a reader comparing two reports deserves to see the price.
      durationMs: 812,
    });

    // The loader must load *this* project's configuration, so the project root travels with the request rather than
    // being read from the process's own working directory.
    expect(probe.calls).toStrictEqual([{ projectRoot: ROOT }]);
  });

  it("reports a load failure as invalidity, with the loader named", async () => {
    const probe = portReturning({
      outcome: "failed",
      message: "defineConfig is not a function",
      durationMs: 640,
    });

    const verdict = await validate({ deep: DEEP, probe: probe.port });

    // The loader spoke: a real observation, and the only case where T2 can produce a failure.
    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_INVALID",
      outcome: "fail",
      tier: "T2-cypress",
      failure: { kind: "load" },
      durationMs: 640,
    });
  });

  it("caps a loader message that would otherwise dominate the report", async () => {
    const probe = portReturning({
      outcome: "failed",
      message: "x".repeat(MAX_LOADER_MESSAGE_CHARS * 2),
      durationMs: 5,
    });

    const verdict = await validate({ deep: DEEP, probe: probe.port });
    const failure =
      verdict.reason === "CYPRESS_CONFIG_INVALID" ? verdict.failure : undefined;

    expect(failure?.message).toHaveLength(MAX_LOADER_MESSAGE_CHARS);
    expect(failure?.message.endsWith("…")).toBe(true);
    expect(verdict).toMatchObject({ truncated: true });
  });

  it("reports an exhausted budget as no verdict, not as an invalid file", async () => {
    const probe = portReturning({ outcome: "timeout", durationMs: 60_000 });

    const verdict = await validate({ deep: DEEP, probe: probe.port });

    // Reporting a timeout as invalidity would blame the user for our own bound. Nothing was established about the
    // configuration, so nothing is claimed about it.
    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_NOT_VALIDATED",
      outcome: "indeterminate",
      cause: "probe-timeout",
    });
  });

  it("reports a loader that could not be run as unavailable rather than failed", async () => {
    const probe = portReturning({ outcome: "unavailable" });

    const verdict = await validate({ deep: DEEP, probe: probe.port });

    // A missing prerequisite is a different fact from a rejection, and the remedy is different: install the tooling,
    // do not correct the file.
    expect(verdict).toMatchObject({
      reason: "CYPRESS_CONFIG_NOT_VALIDATED",
      cause: "deep-validation-unavailable",
    });
  });
});

describe("sanitising loader output", () => {
  it("strips terminal escapes, which would corrupt any log that stored them", () => {
    const raw = `\u001B[31mError:\u001B[39m defineConfig is not a function`;
    const clean = sanitiseLoaderMessage(raw);

    expect(clean).toBe("Error: defineConfig is not a function");
    expect(clean).not.toContain("\u001B");
  });

  it("collapses a code frame into one readable line", () => {
    const raw =
      "  Error: boom\n\n    at build (cypress.config.ts:4:3)\n    at run main.js:1:1";
    const clean = sanitiseLoaderMessage(raw);

    // Whitespace runs would store a stack trace as an unreadable block; a single line with the useful part first is
    // what a report can render.
    expect(clean).toBe(
      "Error: boom at build (cypress.config.ts:4:3) at run main.js:1:1",
    );
  });

  it("truncates rather than growing without bound", () => {
    const clean = sanitiseLoaderMessage(
      "y".repeat(MAX_LOADER_MESSAGE_CHARS + 1),
    );

    expect(clean).toHaveLength(MAX_LOADER_MESSAGE_CHARS);
    expect(clean.endsWith("…")).toBe(true);
  });

  it("only ever removes content", () => {
    // Nothing in the transform can add text: the message that comes out is a subsequence of the one that went in,
    // modulo whitespace. That property is what makes it safe to store.
    const raw = "a b   c\nd";
    expect(raw.replace(/\s+/gu, " ").trim()).toBe(sanitiseLoaderMessage(raw));
  });
});

describe("properties of the verdict", () => {
  it("returns a frozen value on every path", async () => {
    const probe = portReturning({ outcome: "loaded", durationMs: 1 });

    const verdicts = await Promise.all([
      validate({ discovery: NOT_APPLICABLE }),
      validate({ facts: undefined }),
      validate({
        discovery: FOUND_JSON,
        facts: facts({ sample: sample({ text: "{}" }) }),
      }),
      validate({ deep: DEEP, probe: probe.port }),
    ]);

    // Frozen at the source: the verdict travels into evidence, and a consumer that annotated it in place would alter a
    // shared observation for the rest of the run.
    expect(verdicts.every((value) => Object.isFrozen(value))).toBe(true);
  });

  it("is deterministic for the same input", async () => {
    const probe = portReturning({
      outcome: "failed",
      message: "boom",
      durationMs: 3,
    });

    const first = await validate({ deep: DEEP, probe: probe.port });
    const second = await validate({ deep: DEEP, probe: probe.port });

    // The only impurity is the probe, and it is scripted — so two calls with the same script must agree exactly.
    expect(first).toStrictEqual(second);
  });

  it("consults the loader at most once", async () => {
    const probe = portReturning({ outcome: "loaded", durationMs: 2 });

    await validate({ deep: DEEP, probe: probe.port });

    // A retry would be a second execution of project code and a second, possibly different, answer to one question.
    expect(probe.calls).toHaveLength(1);
  });
});
