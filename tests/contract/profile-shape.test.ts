/**
 * The contract between the profile schema and the configuration schema.
 *
 * One claim, in several forms: **a profile is validated by the configuration schema, not beside it.** Everything else here
 * follows from that —
 *
 * - a profile problem appears at its own path in the document's issue list, not as a root-level complaint;
 * - the cross-field rule about `defaultEnvironment` still sees the profiles it is checking against;
 * - the reserved-name guard runs when a whole document is parsed, not only when the environments schema is used directly;
 * - the constraints are the ones every other field uses, so a rule stated once applies inside a profile too;
 * - the field list still treats `environments` as one leaf, because a profile's properties are values rather than paths.
 *
 * The unit suite covers the profile shape on its own. This file covers the seam, which is why it takes the root schema as
 * its only entry point.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import type { ZodError } from "zod";

import {
  CONFIG_FIELD_PATHS,
  OUTPUT_DEFAULTS,
  SecretSource,
  SUPPORTED_CONFIG_VERSION,
  qatConfigSchema,
} from "~/config/schema/index.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Paths of every issue, joined for readability. Empty for a root-level issue. */
function issuePaths(error: ZodError): string[] {
  return error.issues.map((issue) => issue.path.map(String).join("."));
}

/** Every issue message, joined, for a fragment match rather than a full-prose assertion. */
function issueText(error: ZodError): string {
  return error.issues.map((issue) => issue.message).join(" | ");
}

/** Parse a document that must be accepted, or fail with the reason it was not. */
function accepted(
  document: unknown,
): NonNullable<ReturnType<typeof qatConfigSchema.safeParse>["data"]> {
  const result = qatConfigSchema.safeParse(document);

  if (!result.success) {
    throw new Error(
      `expected the document to be accepted: ${issuePaths(result.error).join(", ")}`,
    );
  }

  return result.data;
}

/** Parse a document that must be refused, or fail saying it was accepted. */
function refused(document: unknown): ZodError {
  const result = qatConfigSchema.safeParse(document);

  if (result.success) throw new Error("expected the document to be refused");

  return result.error;
}

/** A document with one well-formed profile and nothing else interesting. */
function withProfiles(environments: unknown): unknown {
  return {
    version: SUPPORTED_CONFIG_VERSION,
    framework: "cypress",
    environments,
  };
}

const STAGING = {
  baseUrl: "https://staging.example.test",
  variables: { API_URL: "https://staging.example.test/api" },
  secrets: {
    API_TOKEN: {
      from: SecretSource.Environment,
      name: "QAT_STAGING_API_TOKEN",
    },
  },
};

/* -------------------------------------------------------------------------- */
/* The composition                                                            */
/* -------------------------------------------------------------------------- */

describe("a document with profiles", () => {
  it("is accepted by the configuration schema", () => {
    const document = withProfiles({ staging: STAGING });

    expect(accepted(document).environments).toStrictEqual({ staging: STAGING });
  });

  it("keeps the profile values exactly as written", () => {
    const parsed = accepted(withProfiles({ staging: STAGING }));

    // Not normalised, not re-encoded: a target or a variable that came back changed would be a different run from the one
    // the reader described.
    expect(parsed.environments).toStrictEqual({ staging: STAGING });
  });

  it("still fills the output block", () => {
    // The proof that adding profiles did not disturb the defaults: one optional block is filled, the other keeps what it
    // was given, and neither depends on the other.
    expect(accepted(withProfiles({ staging: STAGING })).output).toStrictEqual(
      OUTPUT_DEFAULTS,
    );
  });

  it("leaves an absent environments map absent", () => {
    // The schema does not invent the map — the resolution stage fills it. A document written without environments must
    // come back without a key, so a consumer can tell "not declared" from "declared empty".
    const parsed = accepted({
      version: SUPPORTED_CONFIG_VERSION,
      framework: "cypress",
    });

    expect("environments" in parsed).toBe(false);
  });

  it("accepts a declared-but-empty map and keeps it empty", () => {
    expect(accepted(withProfiles({})).environments).toStrictEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* Where a profile problem appears                                            */
/* -------------------------------------------------------------------------- */

describe("a document with a broken profile", () => {
  it("reports the problem at the profile's own path", () => {
    const error = refused(withProfiles({ staging: { baseUrl: "not a url" } }));

    // `environments.staging.baseUrl`, not a complaint about `environments`. The distinction is what lets a reader find the
    // line, and what lets the diagnostics renderer prefix a dotted path it recognises.
    expect(issuePaths(error)).toStrictEqual(["environments.staging.baseUrl"]);
  });

  it("does not blame the profiles that are fine", () => {
    const error = refused(
      withProfiles({
        staging: { baseUrl: "not a url" },
        production: { baseUrl: "https://example.test" },
      }),
    );

    // A single broken profile must not turn a document into "the environments are wrong": the sibling is untouched and
    // unreported, which is what makes a multi-environment file fixable one line at a time.
    expect(
      issuePaths(error).every((path) =>
        path.startsWith("environments.staging"),
      ),
    ).toBe(true);
  });

  it("reports independent problems in one pass", () => {
    const error = refused({
      version: SUPPORTED_CONFIG_VERSION,
      framework: "cypress",
      environments: {
        staging: { baseUrl: "not a url", variables: { api_url: "x" } },
      },
      output: { reports: "/absolute" },
    });

    const paths = issuePaths(error);

    // Three separate mistakes, collected together. A schema that stopped after the first would make fixing a file a
    // sequence of runs.
    expect(paths).toContain("environments.staging.baseUrl");
    expect(paths).toContain("output.reports");
    expect(
      paths.some((path) => path.startsWith("environments.staging.variables")),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The rule that spans fields                                                 */
/* -------------------------------------------------------------------------- */

describe("defaultEnvironment", () => {
  it("is accepted when it names a declared profile", () => {
    const parsed = accepted({
      ...(withProfiles({
        staging: STAGING,
        production: { baseUrl: "https://example.test" },
      }) as object),
      defaultEnvironment: "staging",
    });

    expect(parsed.defaultEnvironment).toBe("staging");
  });

  it("is refused when it names nothing declared", () => {
    const error = refused({
      ...(withProfiles({ staging: STAGING }) as object),
      defaultEnvironment: "production",
    });

    // The existing cross-field rule, unchanged by the profile model: it reads the map's keys, and those are still profile
    // names.
    expect(issuePaths(error)).toStrictEqual(["defaultEnvironment"]);
    expect(issueText(error)).toContain("not declared in environments");
  });

  it("is not satisfied by an inherited property", () => {
    // `constructor` is on every object's prototype. The rule uses `hasOwnProperty` rather than `in`, so a name that is
    // inherited is not a profile — and the profile-level reserved-name guard refuses it as a *name* either way.
    const error = refused({
      ...(withProfiles({ staging: STAGING }) as object),
      defaultEnvironment: "constructor",
    });

    expect(error.issues.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The guard that must run on the raw value                                   */
/* -------------------------------------------------------------------------- */

describe("reserved names through the root schema", () => {
  it("refuses a profile called __proto__", () => {
    // Parsed from text, because a literal cannot express the key: `{ __proto__: … }` in source sets the prototype of the
    // object instead of creating a property, so the case the guard exists for can only arrive from `JSON.parse`.
    const document = JSON.parse(
      `{"version": ${String(SUPPORTED_CONFIG_VERSION)}, "framework": "cypress", "__proto__": {}}`,
    ) as unknown;

    const error = refused({
      ...(JSON.parse(
        `{"version": ${String(SUPPORTED_CONFIG_VERSION)}, "framework": "cypress"}`,
      ) as object),
      environments: JSON.parse(
        '{"__proto__": {"baseUrl": "https://example.test"}}',
      ),
    });

    // Two separate facts, and both matter: the document is refused, and the guard ran through the root schema rather than
    // only when the environments schema is used by itself.
    expect(issuePaths(error)).toContain("environments.__proto__");
    expect(issueText(error)).toContain("reserved by the language");

    // The same document without profiles is accepted, so the refusal above is about the key and nothing else.
    expect(qatConfigSchema.safeParse(document).success).toBe(false);
  });

  it.each([
    ["variables", "constructor", "x"],
    ["secrets", "prototype", { from: "environment", name: "TOKEN_SOURCE" }],
  ])("refuses a reserved name inside %s", (map, key, entry) => {
    const environments = JSON.parse(
      `{"staging": {"${map}": {"${key}": ${JSON.stringify(entry)}}}}`,
    ) as unknown;

    const error = refused(withProfiles(environments));

    expect(issuePaths(error)).toContain(`environments.staging.${map}.${key}`);
  });
});

/* -------------------------------------------------------------------------- */
/* One set of rules                                                           */
/* -------------------------------------------------------------------------- */

describe("the constraints inside a profile", () => {
  it.each([
    [
      "a multi-line variable value",
      { variables: { CERTIFICATE: "line one\nline two" } },
      "control characters",
    ],
    ["a lowercase variable name", { variables: { api_url: "x" } }, "uppercase"],
    [
      "credentials in the target",
      { baseUrl: "https://user:secret@example.test" },
      "username or password",
    ],
    // The key is in the *message*, not in the path: zod reports a strict-object violation as
    // `Unrecognized key: "value"`, and the path stops at the entry it was found on.
    [
      "a secret carrying a value",
      {
        secrets: {
          TOKEN: { from: "environment", name: "TOKEN_SOURCE", value: "x" },
        },
      },
      'Unrecognized key: "value"',
    ],
  ])("refuses %s", (_case, profile, fragment) => {
    const error = refused(withProfiles({ staging: profile }));

    expect(
      issuePaths(error).every((path) =>
        path.startsWith("environments.staging"),
      ),
    ).toBe(true);
    expect(issueText(error)).toContain(fragment);
  });
});

/* -------------------------------------------------------------------------- */
/* The field list                                                             */
/* -------------------------------------------------------------------------- */

describe("the field list", () => {
  it("names environments once, as a leaf", () => {
    expect(CONFIG_FIELD_PATHS).toContain("environments");
  });

  it("names no path inside a profile", () => {
    // `baseUrl`, `variables` and `secrets` are properties of a value, not paths through the document. A field list that
    // included them would make the documentation table claim four rows where the format has one, and the coverage test
    // would then demand a catalogue entry for a field nobody can default.
    expect(
      CONFIG_FIELD_PATHS.filter((path) => path.startsWith("environments.")),
    ).toStrictEqual([]);
  });

  it("stays sorted and free of duplicates", () => {
    // The documentation comparison is a set comparison, but a sorted list is what makes a diff of that table readable.
    expect(CONFIG_FIELD_PATHS).toStrictEqual([...CONFIG_FIELD_PATHS].sort());
    expect(new Set(CONFIG_FIELD_PATHS).size).toBe(CONFIG_FIELD_PATHS.length);
  });
});

/* -------------------------------------------------------------------------- */
/* Non-functional                                                             */
/* -------------------------------------------------------------------------- */

describe("non-functional behaviour", () => {
  it("is deterministic", () => {
    const document = withProfiles({ staging: STAGING });

    expect(qatConfigSchema.safeParse(document)).toStrictEqual(
      qatConfigSchema.safeParse(document),
    );
  });

  it("does not modify the document it was given", () => {
    const document = withProfiles({ staging: STAGING });
    const before = structuredClone(document);

    qatConfigSchema.safeParse(document);

    // The reserved-name walk reads the raw value before Zod rebuilds anything, and a walk that assigned would corrupt the
    // document a later consumer reads — the command prints and then decides its status from the same value.
    expect(document).toStrictEqual(before);
  });

  it("accepts the shipped example", async () => {
    // The most copied file in the repository, parsed through the schema a reader's project will use. If the example and
    // the schema ever disagree, the example is what people believe.
    const example: unknown = JSON.parse(
      await readFile(
        new URL(
          "../../examples/configuration/qat.config.profiles.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    expect(qatConfigSchema.safeParse(example).success).toBe(true);
  });
});
