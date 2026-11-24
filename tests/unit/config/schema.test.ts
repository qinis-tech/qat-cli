import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { qatConfigSchema, type QatConfigInput } from "~/config/schema/index.js";

/**
 * The configuration schema, from fixtures.
 *
 * Two kinds of case. The table-driven ones read a file from `tests/fixtures/config/` and assert *the field of the issue*,
 * which is the contract a reporting caller depends on: a validation failure has to say which field, not just that
 * something was wrong. The others state a rule in a literal, because a rule worth having is worth naming at the place it
 * is asserted.
 *
 * Fixtures live in files rather than in the test because they are the same files the loader and the initialisation
 * workflow will be tested against — a schema and a workflow that disagree about a valid file is the defect this
 * arrangement makes impossible.
 */
const FIXTURES = fileURLToPath(
  new URL("../../fixtures/config", import.meta.url),
);

async function fixture(
  kind: "valid" | "invalid",
  name: string,
): Promise<unknown> {
  return JSON.parse(
    await readFile(join(FIXTURES, kind, name), "utf8"),
  ) as unknown;
}

/** The paths Zod reports, as dotted strings, so an assertion reads the way a user reads a message. */
function issuePaths(value: unknown): string[] {
  const result = qatConfigSchema.safeParse(value);

  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
}

/**
 * Whether any issue points at `field` or below it.
 *
 * A record key becomes part of the path, so a bad profile name is reported at `environments.Staging` rather than at
 * `environments`. Asserting the field rather than the leaf keeps this about *which field* was blamed — the contract a
 * caller renders against — and it survives the parser nesting one level deeper for a reason of its own.
 *
 * The empty string is the document root, which is where an unrecognised top-level key is reported: it has no path to
 * point at, so the key is named in the message instead.
 */
function reportedAt(value: unknown, field: string): boolean {
  return issuePaths(value).some(
    (path) => path === field || path.startsWith(`${field}.`),
  );
}

describe("a valid configuration", () => {
  it("accepts the minimal file and applies every default", () => {
    const result = qatConfigSchema.safeParse({
      version: 1,
      framework: "cypress",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Defaults are the whole reason `output` is always present: a consumer reads `config.output.reports` without
    // branching on whether anybody configured it.
    expect(result.data.output).toStrictEqual({
      reports: "results/reports",
      evidence: "results/evidence",
    });
    expect(result.data.cypress).toBeUndefined();
    expect(result.data.environments).toBeUndefined();
  });

  it.each(["minimal.json", "full.json", "awkward-names.json"])(
    "accepts fixtures/valid/%s",
    async (name) => {
      const result = qatConfigSchema.safeParse(await fixture("valid", name));

      expect(result.success).toBe(true);
    },
  );

  it("preserves the values it was given, rather than the defaults", async () => {
    const result = qatConfigSchema.safeParse(
      await fixture("valid", "full.json"),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.output.reports).toBe("results/reports/nightly");
    expect(result.data.environments?.["staging"]?.["RETRIES"]).toBe("2");
    expect(result.data.defaultEnvironment).toBe("staging");
  });
});

describe("an invalid configuration", () => {
  it.each([
    ["an unsupported version", "version-unsupported.json", "version"],
    ["a missing version", "version-missing.json", "version"],
    ["an unknown framework", "framework-unknown.json", "framework"],
    ["a missing framework", "framework-missing.json", "framework"],
    ["an unknown top-level field", "unknown-field.json", ""],
    [
      "an absolute reports directory",
      "reports-absolute.json",
      "output.reports",
    ],
    [
      "an evidence directory that escapes the project",
      "evidence-escapes-root.json",
      "output.evidence",
    ],
    [
      "a backslash in a configured path",
      "config-file-backslash.json",
      "cypress.configFile",
    ],
    [
      "a profile name that is not lowercase",
      "environment-name-invalid.json",
      "environments",
    ],
    [
      "a multi-line variable value",
      "variable-value-multiline.json",
      "environments.smoke.API_URL",
    ],
    [
      "a default naming an undeclared profile",
      "default-environment-undeclared.json",
      "defaultEnvironment",
    ],
  ])("rejects %s, and names the field", async (_case, name, field) => {
    expect(reportedAt(await fixture("invalid", name), field)).toBe(true);
  });

  it("names the offending key in the message for an unknown field", () => {
    const result = qatConfigSchema.safeParse({
      version: 1,
      framework: "cypress",
      reportDir: "out",
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    // The message is the only place a reader learns *which* key was unexpected, because an unrecognised key has no path
    // to point at — the issue is reported at the document root. Asserted across every issue rather than on the first,
    // so this stays a statement about what the schema says and not about the order it happens to say it in.
    const messages = result.error.issues.map((issue) => issue.message);

    expect(messages.some((message) => message.includes("reportDir"))).toBe(
      true,
    );
  });
});

describe("edge cases", () => {
  it("accepts environments without a default", () => {
    const result = qatConfigSchema.safeParse({
      version: 1,
      framework: "cypress",
      environments: { smoke: { API_URL: "https://example.test" } },
    });

    expect(result.success).toBe(true);
  });

  it("rejects a default naming an undeclared profile, and says which", () => {
    const result = qatConfigSchema.safeParse({
      version: 1,
      framework: "cypress",
      defaultEnvironment: "production",
      environments: { smoke: {} },
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    const issue = result.error.issues.find(
      (candidate) => candidate.path.join(".") === "defaultEnvironment",
    );

    // Naming the value is the difference between "something is wrong" and a one-line fix.
    expect(issue?.message).toContain("production");
  });

  it("rejects a default when environments is empty", () => {
    expect(
      issuePaths({
        version: 1,
        framework: "cypress",
        defaultEnvironment: "smoke",
        environments: {},
      }),
    ).toContain("defaultEnvironment");
  });

  it("accepts an empty environment profile", () => {
    // A profile with no variables is a legitimate state — the selection still changes which `--environment` is active,
    // and a schema that refused it would force a placeholder into every configuration.
    expect(
      qatConfigSchema.safeParse({
        version: 1,
        framework: "cypress",
        environments: { smoke: {} },
      }).success,
    ).toBe(true);
  });
});

describe("corner cases", () => {
  it.each([
    [
      "a prototype key as a profile name",
      { environments: JSON.parse('{"__proto__": {}}') as unknown },
    ],
    [
      "a constructor key as a profile name",
      { environments: { constructor: {} } },
    ],
    [
      "a prototype key as a variable name",
      { environments: { smoke: JSON.parse('{"__proto__": "x"}') as unknown } },
    ],
    [
      "a constructor key as a variable name",
      { environments: { smoke: { constructor: "x" } } },
    ],
  ])("rejects %s", (_case, override) => {
    // Assigning `__proto__` on an ordinary object changes its prototype rather than adding a key, so a record built from
    // configuration input is where prototype pollution reaches an application — and also why an ordinary key check can
    // appear to pass: the key never becomes a property to check. The guard walks the raw value, where it still is one.
    expect(
      qatConfigSchema.safeParse({
        version: 1,
        framework: "cypress",
        ...override,
      }).success,
    ).toBe(false);
  });

  it("names the reserved key it refused", () => {
    const result = qatConfigSchema.safeParse({
      version: 1,
      framework: "cypress",
      environments: JSON.parse('{"__proto__": {}}') as unknown,
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    // "It returned false" is compatible with several causes — a bad version, a missing framework. This is the assertion
    // that the refusal is about the key, at the path a reader would be sent to.
    expect(
      result.error.issues.some(
        (issue) => issue.path.join(".") === "environments.__proto__",
      ),
    ).toBe(true);
  });

  it("does not pollute the object prototype", () => {
    qatConfigSchema.safeParse({
      version: 1,
      framework: "cypress",
      environments: JSON.parse('{"__proto__": {"polluted": true}}') as unknown,
    });

    // A canary rather than a proof: it passes trivially until something pollutes, and then it never passes again in
    // this process. Worth having because the failure it guards is silent and global — every object in the run would gain
    // a property, and the first symptom would be somewhere unrelated.
    const emptyObject: Record<string, unknown> = {};

    expect(emptyObject["polluted"]).toBeUndefined();
  });

  it.each([
    ["a single dot segment", "reports/./today"],
    ["a parent segment in the middle", "results/../../etc"],
    ["a trailing slash", "results/reports/"],
    ["a doubled separator", "results//reports"],
  ])("rejects %s", (_case, path) => {
    expect(
      issuePaths({
        version: 1,
        framework: "cypress",
        output: { reports: path },
      }),
    ).toContain("output.reports");
  });

  it("rejects an empty path rather than treating it as the project root", () => {
    // An empty string would resolve to the root itself, so every report would be written over the project.
    expect(
      issuePaths({ version: 1, framework: "cypress", output: { reports: "" } }),
    ).toContain("output.reports");
  });

  it("rejects a Windows drive-qualified path on every platform", () => {
    // A configuration committed on Windows is read on Linux in CI, so the rule cannot be a platform check.
    expect(
      issuePaths({
        version: 1,
        framework: "cypress",
        output: { reports: "C:/reports" },
      }),
    ).toContain("output.reports");
  });
});

describe("boundaries", () => {
  it.each([
    ["a profile name at the limit", "a".repeat(32), true],
    ["a profile name past the limit", "a".repeat(33), false],
  ])("handles %s", (_case, name, accepted) => {
    const value = {
      version: 1,
      framework: "cypress",
      environments: { [name]: {} },
    };

    expect(qatConfigSchema.safeParse(value).success).toBe(accepted);
  });

  it.each([
    ["a path at the limit", "a".repeat(256), true],
    ["a path past the limit", "a".repeat(257), false],
  ])("handles %s", (_case, path, accepted) => {
    const value = {
      version: 1,
      framework: "cypress",
      output: { reports: path },
    };

    expect(qatConfigSchema.safeParse(value).success).toBe(accepted);
  });

  it.each([
    ["a value at the limit", "a".repeat(4096), true],
    ["a value past the limit", "a".repeat(4097), false],
  ])("handles %s", (_case, value, accepted) => {
    const config = {
      version: 1,
      framework: "cypress",
      environments: { smoke: { API_URL: value } },
    };

    expect(qatConfigSchema.safeParse(config).success).toBe(accepted);
  });
});

describe("non-functional behaviour", () => {
  it("does not mutate the value it was given", async () => {
    const input = (await fixture("valid", "full.json")) as QatConfigInput;
    const before = structuredClone(input);

    qatConfigSchema.safeParse(input);

    // The loader reads a file, parses it, and may hand the same object to a second consumer for reporting. A schema that
    // defaulted by assignment would corrupt it — and the corruption would be invisible, because the parsed copy is
    // correct.
    expect(input).toStrictEqual(before);
  });

  it("is deterministic: the same input produces the same result and the same issue order", () => {
    const broken = {
      version: 2,
      framework: "playwright",
      output: { reports: "/absolute" },
    };

    const first = qatConfigSchema.safeParse(broken);
    const second = qatConfigSchema.safeParse(structuredClone(broken));

    expect(first).toStrictEqual(second);
  });

  it("reports every independent failure in one pass", () => {
    const result = qatConfigSchema.safeParse({
      version: 2,
      framework: "playwright",
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    // A caller showing a reader what to fix needs all of it, not the first field that failed. Zod collects; the schema
    // does not short-circuit — except for a reserved key, where refusing early is the point.
    expect(
      result.error.issues.map((issue) => issue.path.join(".")),
    ).toStrictEqual(["version", "framework"]);
  });

  it("handles a large environment without recursion or quadratic cost", () => {
    const environments = Object.fromEntries(
      Array.from({ length: 1000 }, (_unused, index) => [
        `profile-${String(index)}`,
        { API_URL: "https://x.test" },
      ]),
    );

    const started = performance.now();
    const result = qatConfigSchema.safeParse({
      version: 1,
      framework: "cypress",
      environments,
    });

    expect(result.success).toBe(true);
    // A bound, not a benchmark: it catches a regression to something accidentally quadratic — the reserved-key walk runs
    // over every profile and every variable, so a nested loop over the wrong thing would show here.
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("touches no filesystem", () => {
    // The schema is a function of a value. The loader reads the file and calls it, which is what lets every rule here be
    // tested without a temporary directory.
    expect(
      qatConfigSchema.safeParse({ version: 1, framework: "cypress" }).success,
    ).toBe(true);
  });
});
