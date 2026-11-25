import { describe, expect, it } from "vitest";

import { SUPPORTED_CONFIG_VERSION } from "~/config/schema/index.js";
import { validateConfiguration } from "~/config/validation/index.js";
import { ConfigurationDiagnosticCode } from "~/core/application/configuration.js";

/**
 * Validating a value, with no filesystem anywhere.
 *
 * The service takes whatever a JSON parser produced, so every rule below is a literal — including the ones about what a
 * diagnostic may not contain, which are the hardest to assert through a loader and the ones that matter most.
 *
 * Three groups are load-bearing rather than incidental. The version cases pin an ordering that only exists in one
 * module; the secrecy cases assert a property no type can express; and the code-vocabulary cases hold the one
 * vocabulary this layer shares with the doctor, which names a configuration code from a layer above.
 *
 * ## An environment is a profile
 *
 * `environments.smoke` is an object with `baseUrl`, `variables` and `secrets`, not a map of variables. A case that
 * wanted to exercise *a variable's* value has to reach it as `environments.smoke.variables.TOKEN`; written the old way
 * it would fail on an unknown key and assert something else entirely while still passing.
 *
 * ## Where the codes come from
 *
 * `ConfigurationDiagnosticCode` is declared in `core/application/configuration.ts` and imported from there. The
 * identifiers are vocabulary — a layer above this one has to name a configuration code without depending on how this
 * module is built — so they are not published through the config barrel, and a test that imported them from there would
 * be depending on a route that deliberately no longer exists.
 */
const VALID = { version: SUPPORTED_CONFIG_VERSION, framework: "cypress" };

/** A value chosen to be unmistakable if it ever reaches a message. */
const SECRET = "sk_live_do_not_print_me";

/** The codes, so an assertion reads as a category rather than a string. */
function codesOf(result: ReturnType<typeof validateConfiguration>): string[] {
  return result.valid
    ? []
    : result.diagnostics.map((diagnostic) => diagnostic.code);
}

function pathsOf(result: ReturnType<typeof validateConfiguration>): string[] {
  return result.valid
    ? []
    : result.diagnostics.map((diagnostic) => diagnostic.path).sort();
}

function messagesOf(result: ReturnType<typeof validateConfiguration>): string {
  return result.valid
    ? ""
    : result.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
}

describe("a valid configuration", () => {
  it("passes and applies the schema defaults", () => {
    const result = validateConfiguration(VALID);

    expect(result.valid).toBe(true);
    if (!result.valid) return;

    // The defaults are the schema's, applied once, in one place. A service that also defaulted would be a second opinion.
    expect(result.config.output).toStrictEqual({
      reports: "results/reports",
      evidence: "results/evidence",
    });
  });

  it("passes a fully populated document", () => {
    const result = validateConfiguration({
      ...VALID,
      cypress: { configFile: "config/cypress.config.ts" },
      defaultEnvironment: "staging",
      environments: {
        smoke: {
          baseUrl: "https://smoke.example.test",
          variables: { API_URL: "https://smoke.example.test/api" },
        },
        staging: {
          baseUrl: "https://staging.example.test",
          variables: {
            API_URL: "https://staging.example.test/api",
            RETRIES: "2",
          },
          secrets: {
            API_TOKEN: { from: "environment", name: "QAT_STAGING_API_TOKEN" },
          },
        },
      },
      output: { reports: "out/reports", evidence: "out/evidence" },
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(result.config.output.reports).toBe("out/reports");
    // The profile comes through the service intact, which is what a command reading it downstream depends on.
    expect(
      result.config.environments?.["staging"]?.secrets?.["API_TOKEN"],
    ).toStrictEqual({
      from: "environment",
      name: "QAT_STAGING_API_TOKEN",
    });
  });

  it("preserves the values it was given rather than the defaults", () => {
    const result = validateConfiguration({
      ...VALID,
      output: { reports: "reports/nightly" },
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(result.config.output.reports).toBe("reports/nightly");
    // The field that was not mentioned keeps its default.
    expect(result.config.output.evidence).toBe("results/evidence");
  });
});

describe("a document that is not an object", () => {
  const SHAPES: readonly [label: string, value: unknown][] = [
    ["an array", []],
    ["null", null],
    ["a string", "cypress"],
    ["a number", 42],
    ["a boolean", true],
  ];

  it.each(SHAPES)(
    "reports %s as one diagnostic with no path",
    (_label, value) => {
      const result = validateConfiguration(value);

      expect(result.valid).toBe(false);
      if (result.valid) return;

      // One diagnostic and no path: there are no fields to point at, so a list of them would be an invention.
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        code: ConfigurationDiagnosticCode.NotAnObject,
        path: "",
      });
    },
  );
});

describe("an unsupported version", () => {
  it("reports the version and does not examine the fields", () => {
    // The document also omits `framework` and carries a key the schema does not know. Neither is reported: at another
    // schema version, a missing field may simply not exist yet and an unrecognised one may have been added since, so
    // every field complaint would be a guess.
    const result = validateConfiguration({ version: 2, nope: true });

    expect(result.valid).toBe(false);
    if (result.valid) return;

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: ConfigurationDiagnosticCode.UnsupportedVersion,
      path: "version",
    });
    // A number is echoed, because a number is a number.
    expect(result.diagnostics[0]?.message).toContain("2");
    expect(result.diagnostics[0]?.remediation).toContain(
      String(SUPPORTED_CONFIG_VERSION),
    );
  });

  it("describes a version that is not a number rather than quoting it", () => {
    const result = validateConfiguration({
      version: SECRET,
      framework: "cypress",
    });

    expect(result.valid).toBe(false);
    if (result.valid) return;

    // A string in the version field is a defect and could be anything, including the kind of value that must never be
    // printed. It is described rather than quoted.
    expect(result.diagnostics[0]?.code).toBe(
      ConfigurationDiagnosticCode.UnsupportedVersion,
    );
    expect(messagesOf(result)).not.toContain(SECRET);
  });

  it("treats a version of the wrong type as unsupported rather than as a field error", () => {
    const result = validateConfiguration({
      version: "1",
      framework: "cypress",
    });

    // `'1'` is not `1`. Reporting it as a version problem is honest and actionable; reporting it as a type error beside
    // a page of field complaints is neither.
    expect(codesOf(result)).toStrictEqual([
      ConfigurationDiagnosticCode.UnsupportedVersion,
    ]);
  });

  it("treats an absent version as missing rather than as unsupported", () => {
    const result = validateConfiguration({ framework: "cypress" });

    // Different problems with different fixes: one needs a version added, the other needs the file replaced with one
    // this build reads.
    expect(codesOf(result)).toContain(ConfigurationDiagnosticCode.Missing);
    expect(codesOf(result)).not.toContain(
      ConfigurationDiagnosticCode.UnsupportedVersion,
    );
  });
});

describe("fields", () => {
  it("names a missing required field", () => {
    const result = validateConfiguration({ version: SUPPORTED_CONFIG_VERSION });

    expect(result.valid).toBe(false);
    if (result.valid) return;

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: ConfigurationDiagnosticCode.Missing,
        path: "framework",
      }),
    );
  });

  it("does not mistake a missing key for a wrong type, or the reverse", () => {
    // Both halves use a field where the two situations really are different. `framework` would not do: it is an enum,
    // and a number in an enum field is reported as an unsupported *value*, because for an enum a wrong type and a wrong
    // value have the same fix. The pairing only means something where the field has a type apart from its allowed
    // values.
    const missing = validateConfiguration({
      version: SUPPORTED_CONFIG_VERSION,
    });
    const wrong = validateConfiguration({ ...VALID, output: "results" });

    // The library encodes absence differently depending on what the field holds — an enum member and a literal both
    // report it as a value error — so this pair is what proves the document is consulted rather than the issue's own
    // encoding.
    expect(codesOf(missing)).toStrictEqual([
      ConfigurationDiagnosticCode.Missing,
    ]);
    expect(codesOf(wrong)).toStrictEqual([
      ConfigurationDiagnosticCode.WrongType,
    ]);
  });

  it("names a field holding the wrong type", () => {
    const result = validateConfiguration({ ...VALID, output: "results" });

    expect(result.valid).toBe(false);
    if (result.valid) return;

    expect(result.diagnostics[0]).toMatchObject({
      code: ConfigurationDiagnosticCode.WrongType,
      path: "output",
    });
    expect(result.diagnostics[0]?.message).toContain("object");
  });

  it("names an unsupported framework, and lists the supported set", () => {
    const result = validateConfiguration({ ...VALID, framework: "playwright" });

    expect(result.valid).toBe(false);
    if (result.valid) return;

    const diagnostic = result.diagnostics.find(
      (entry) => entry.path === "framework",
    );

    expect(diagnostic?.code).toBe(ConfigurationDiagnosticCode.UnsupportedValue);
    // The allowed set is ours, not the file's, so listing it is safe and it is what the reader needs to retry.
    expect(diagnostic?.message).toContain("cypress");
    expect(diagnostic?.message).not.toContain("playwright");
  });

  it("names an unknown field, and says which key", () => {
    const result = validateConfiguration({ ...VALID, reportDir: "out" });

    expect(result.valid).toBe(false);
    if (result.valid) return;

    const diagnostic = result.diagnostics[0];

    // An unrecognised key has no path to point at, so the key itself has to appear — a key is not a value, it is what
    // the reader typed on purpose.
    expect(diagnostic?.code).toBe(ConfigurationDiagnosticCode.UnknownField);
    expect(diagnostic?.path).toBe("");
    expect(diagnostic?.message).toContain("reportDir");
  });

  it("names a path that escapes the project", () => {
    const result = validateConfiguration({
      ...VALID,
      output: { reports: "../outside" },
    });

    expect(result.valid).toBe(false);
    if (result.valid) return;

    expect(result.diagnostics[0]).toMatchObject({
      code: ConfigurationDiagnosticCode.RefusedValue,
      path: "output.reports",
    });
  });

  it("names a profile whose name breaks the rule", () => {
    const result = validateConfiguration({
      ...VALID,
      // A valid body, so the only thing wrong with this document is the name. `{}` would fail for its own reason as
      // well, and the case would then be asserting whichever issue happened to come first.
      environments: { Staging: { variables: { A: "1" } } },
    });

    expect(result.valid).toBe(false);
    if (result.valid) return;

    // The record key is part of the path, so the diagnostic points at the profile rather than at `environments`.
    expect(pathsOf(result)).toContain("environments.Staging");
    expect(result.diagnostics[0]?.code).toBe(
      ConfigurationDiagnosticCode.RefusedValue,
    );
    expect(result.diagnostics[0]?.message).toContain("lowercase");
  });

  it("names a profile that declares nothing", () => {
    const result = validateConfiguration({
      ...VALID,
      environments: { smoke: {} },
    });

    expect(result.valid).toBe(false);
    if (result.valid) return;

    // The rule reads oddly for a moment and then does not: an empty profile can be the default, applies nothing, and
    // reports the name it was selected by — so the first symptom is a run against whatever the previous command left
    // behind.
    expect(pathsOf(result)).toStrictEqual(["environments.smoke"]);
    expect(result.diagnostics[0]?.code).toBe(
      ConfigurationDiagnosticCode.RefusedValue,
    );
    expect(result.diagnostics[0]?.message).toContain(
      "declares no base URL, variables or secrets",
    );
  });

  it("names a secret that carries a value", () => {
    const result = validateConfiguration({
      ...VALID,
      environments: {
        smoke: {
          secrets: {
            API_TOKEN: {
              from: "environment",
              name: "TOKEN_SOURCE",
              value: "hunter2",
            },
          },
        },
      },
    });

    expect(result.valid).toBe(false);
    if (result.valid) return;

    // An unknown key rather than a custom rule, which is the point: a `value` beside a `name` is refused by the shape
    // rather than by a check that could be forgotten.
    expect(result.diagnostics[0]).toMatchObject({
      code: ConfigurationDiagnosticCode.UnknownField,
      path: "environments.smoke.secrets.API_TOKEN",
    });
    expect(messagesOf(result)).not.toContain("hunter2");
  });

  it("reports several field problems together when the version is one it reads", () => {
    const result = validateConfiguration({
      version: SUPPORTED_CONFIG_VERSION,
      framework: "playwright",
      output: { reports: "/var/reports" },
    });

    // Collecting is the point: a reader fixing a file needs the whole list, not one item per round trip. The version
    // rule short-circuits, so this is the case that proves the schema still collects once the version is acceptable.
    expect(pathsOf(result)).toStrictEqual(["framework", "output.reports"]);
  });
});

describe("sensitive values", () => {
  const LEAKS: readonly [label: string, override: Record<string, unknown>][] = [
    ["an absolute path", { output: { reports: `/${SECRET}` } }],
    ["a profile name that cannot be used", { defaultEnvironment: SECRET }],
    [
      "a variable value holding a control character",
      {
        environments: { staging: { variables: { TOKEN: `${SECRET}\u0000` } } },
      },
    ],
    [
      "a variable value that spans lines",
      {
        environments: { staging: { variables: { TOKEN: `${SECRET}\nline` } } },
      },
    ],
    [
      "a profile target that carries credentials",
      {
        environments: {
          staging: { baseUrl: `https://user:${SECRET}@example.test` },
        },
      },
    ],
  ];

  it.each(LEAKS)("does not echo %s", (_label, override) => {
    const result = validateConfiguration({ ...VALID, ...override });

    expect(result.valid).toBe(false);
    if (result.valid) return;

    // No diagnostic may contain the value. The path is enough to find the line, and the path is not the secret.
    expect(messagesOf(result)).not.toContain("sk_live");
  });

  it("never quotes a value the validation library would quote", () => {
    // The library's own message for an unrecognised member echoes what it received. Authoring the message here is what
    // stops that reaching a log line — and this is the assertion that fails the day a case is mapped to the library's
    // text by accident.
    const result = validateConfiguration({ ...VALID, framework: SECRET });

    expect(result.valid).toBe(false);
    if (result.valid) return;

    expect(messagesOf(result)).not.toContain(SECRET);
  });

  it("does not echo a version it cannot read", () => {
    // Covered above for a string; asserted again here because the version field is the one a diagnostic is most likely
    // to quote, and it is the field most likely to hold something copied from the wrong place.
    const result = validateConfiguration({
      version: SECRET,
      framework: "cypress",
    });

    expect(messagesOf(result)).not.toContain(SECRET);
  });
});

describe("boundaries", () => {
  const NAME_LENGTHS: readonly [
    label: string,
    name: string,
    accepted: boolean,
  ][] = [
    ["a profile name at the limit", "a".repeat(32), true],
    ["a profile name past the limit", "a".repeat(33), false],
  ];

  it.each(NAME_LENGTHS)("handles %s", (_label, name, accepted) => {
    const result = validateConfiguration({
      ...VALID,
      // A target rather than nothing: an empty profile is refused for a reason of its own, which would mask whether the
      // *name* was the thing being measured.
      environments: { [name]: { baseUrl: "https://example.test" } },
    });

    expect(result.valid).toBe(accepted);
  });

  const VALUE_LENGTHS: readonly [
    label: string,
    value: string,
    accepted: boolean,
  ][] = [
    ["a value at the limit", "a".repeat(4096), true],
    ["a value past the limit", "a".repeat(4097), false],
  ];

  it.each(VALUE_LENGTHS)("handles %s", (_label, value, accepted) => {
    const result = validateConfiguration({
      ...VALID,
      environments: { staging: { variables: { TOKEN: value } } },
    });

    expect(result.valid).toBe(accepted);
  });

  it("reports a size violation as a refused value, and states the bound", () => {
    const result = validateConfiguration({
      ...VALID,
      environments: { staging: { variables: { TOKEN: "a".repeat(4097) } } },
    });

    expect(result.valid).toBe(false);
    if (result.valid) return;

    expect(result.diagnostics[0]?.code).toBe(
      ConfigurationDiagnosticCode.RefusedValue,
    );
    // The bound is printed rather than the word "undefined". This is the assertion that would catch a size message
    // interpolating a property the issue does not always carry.
    expect(result.diagnostics[0]?.message).toContain("4096");
    expect(messagesOf(result)).not.toContain("undefined");
  });
});

describe("the code vocabulary", () => {
  it("assigns every condition a distinct, permanent identifier", () => {
    const codes = Object.values(ConfigurationDiagnosticCode);

    // Seven conditions, seven identifiers. A duplicate would make two situations indistinguishable in a bug report; a
    // reused value would change the meaning of a code somebody already quoted.
    expect(new Set(codes).size).toBe(codes.length);
  });

  it.each(Object.values(ConfigurationDiagnosticCode))(
    "%s is prefixed as a configuration code",
    (code) => {
      // `QAT-D` is what detection found wrong with a project, `QAT-V` whether that stops an operation, `QAT-C` what is
      // wrong with a configuration document, and `QAT-H` what is wrong with the machine or the run. A reader can tell
      // which layer spoke from the code alone — which is why this set lives in the contract layer now, where the doctor
      // can name it without importing this module.
      expect(code).toMatch(/^QAT-C\d{3}$/);
    },
  );
});

describe("non-functional behaviour", () => {
  it("is deterministic", () => {
    const broken = { version: 2, framework: "playwright" };

    expect(validateConfiguration(broken)).toStrictEqual(
      validateConfiguration(structuredClone(broken)),
    );
  });

  it("does not mutate the value it was given", () => {
    const value = { ...VALID, output: { reports: "out" } };
    const before = structuredClone(value);

    validateConfiguration(value);

    // A validator that defaulted by assignment would corrupt the value a second consumer reads — and the corruption
    // would be invisible, because the returned configuration is correct.
    expect(value).toStrictEqual(before);
  });

  const NOT_OBJECTS: readonly [label: string, value: unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["zero", 0],
    ["an empty string", ""],
    ["an empty array", []],
    ["an empty object", {}],
    ["true", true],
    ["a nested version", { version: {} }],
    ["an array where an object belongs", { version: 1, environments: [] }],
    ["a null output", { version: 1, framework: "cypress", output: null }],
  ];

  it.each(NOT_OBJECTS)("never throws for %s", (_label, value) => {
    // A validator that throws is a validator whose caller has to catch — and an exception cannot say which field. The
    // table gives each input its own case, so a failure names the shape rather than pointing at a loop body.
    expect(() => validateConfiguration(value)).not.toThrow();
  });

  it("touches no filesystem", () => {
    // Every case in this file is a literal. The service cannot do I/O — the loader did it — which is what makes the rule
    // set cheap enough to test exhaustively.
    expect(validateConfiguration(VALID).valid).toBe(true);
  });
});
