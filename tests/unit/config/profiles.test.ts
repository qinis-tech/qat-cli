/**
 * The environment profile schema, tested at the two levels it is built from.
 *
 * Two entry points, and the split is deliberate:
 *
 * - **`profileSchema`** for the shape of one environment — target, variables, secrets, unknown properties. Its issue
 *   paths are relative to the profile, so an assertion reads `secrets.API_TOKEN.name` rather than
 *   `environments.staging.secrets.API_TOKEN.name`.
 * - **`environmentsSchema`** for the collection — profile names, and the reserved-name guard that only works on the raw
 *   value. Several cases below parse a JSON *string* rather than an object literal, because an object literal cannot
 *   express a `__proto__` own key and the guard exists precisely for the case where one arrives.
 *
 * What is *not* here: the profile composed into the root document. That is `tests/contract/profile-shape.test.ts`, whose
 * subject is the integration rather than the shape.
 *
 * ## Every negative case goes through `refusal`
 *
 * `expect(result.success).toBe(false)` does not narrow, so a helper that accepted the whole result would need a cast at
 * every call site. `refusal` narrows once, throws when a value was unexpectedly accepted, and hands back the error — so
 * a test that stops being a rejection fails with a sentence about that rather than with a complaint about `undefined`.
 */
import { describe, expect, it } from "vitest";
import type { ZodError } from "zod";

import {
  environmentsSchema,
  profileSchema,
  SecretSource,
  secretReferenceSchema,
} from "~/config/schema/profiles.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** The error of a parse that must have failed, or a thrown sentence saying it did not. */
function refusal(result: {
  readonly success: boolean;
  readonly error?: ZodError;
}): ZodError {
  if (result.success || result.error === undefined) {
    throw new Error("expected the value to be refused");
  }

  return result.error;
}

/** Paths of every issue, joined for readability. Empty for a root-level issue. */
function issuePaths(error: ZodError): string[] {
  return error.issues.map((issue) => issue.path.map(String).join("."));
}

/** Every issue message, joined, for a fragment match rather than a full-prose assertion. */
function issueText(error: ZodError): string {
  return error.issues.map((issue) => issue.message).join(" | ");
}

function profileAccepts(value: unknown): boolean {
  return profileSchema.safeParse(value).success;
}

const VALID_PROFILE = {
  baseUrl: "https://staging.example.test",
  variables: { API_URL: "https://staging.example.test/api" },
  secrets: {
    API_TOKEN: {
      from: SecretSource.Environment,
      name: "QAT_STAGING_API_TOKEN",
    },
  },
} as const;

/* -------------------------------------------------------------------------- */
/* A profile that is well formed                                              */
/* -------------------------------------------------------------------------- */

describe("a profile", () => {
  it("accepts all three fields and preserves them verbatim", () => {
    const parsed = profileSchema.safeParse(VALID_PROFILE);

    if (!parsed.success) {
      throw new Error(
        `expected the profile to be accepted: ${issuePaths(parsed.error).join(", ")}`,
      );
    }

    // Verbatim, not normalised: a variable value is handed to the framework exactly as it was written, and a base URL
    // that came back re-encoded would be a different target from the one the reader chose.
    expect(parsed.data).toStrictEqual(VALID_PROFILE);
  });

  it.each([
    ["only a target", { baseUrl: "http://localhost:3000" }],
    ["only variables", { variables: { A: "1" } }],
    [
      "only secrets",
      { secrets: { TOKEN: { from: "environment", name: "TOKEN_SOURCE" } } },
    ],
  ])("accepts %s", (_case, profile) => {
    // Every field is optional; the refinement refuses only the profile that declares none of them.
    expect(profileAccepts(profile)).toBe(true);
  });

  it("accepts a plain http target", () => {
    // Not https-only: a local server is the most common target there is.
    expect(profileAccepts({ baseUrl: "http://localhost:3000" })).toBe(true);
  });

  it("accepts a target with a port, a path and a query", () => {
    expect(
      profileAccepts({
        baseUrl: "https://example.test:8443/api/v1?tenant=demo",
      }),
    ).toBe(true);
  });

  it("accepts a variable value with non-ASCII characters", () => {
    // The value constraint refuses control characters, not accents.
    expect(profileAccepts({ variables: { GREETING: "grüße" } })).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* A profile that declares nothing                                            */
/* -------------------------------------------------------------------------- */

describe("an empty profile", () => {
  it("is refused", () => {
    const error = refusal(profileSchema.safeParse({}));

    // It would validate as an object, be selectable as the default, and apply nothing — so the run would use whatever the
    // previous command left behind and report the new profile's name. The issue sits on the profile itself.
    expect(issuePaths(error)).toStrictEqual([""]);
    expect(issueText(error)).toContain(
      "declares no base URL, variables or secrets",
    );
  });

  it.each([
    ["variables", { variables: {} }],
    ["secrets", { secrets: {} }],
  ])("is refused one level down for an empty %s map", (field, profile) => {
    const error = refusal(profileSchema.safeParse(profile));

    // The same defect: the field says "these apply" and applies none of them.
    expect(issuePaths(error)).toStrictEqual([field]);
    expect(issueText(error)).toContain(`declares no ${field}`);
  });
});

/* -------------------------------------------------------------------------- */
/* Unknown properties                                                         */
/* -------------------------------------------------------------------------- */

describe("an unsupported profile property", () => {
  it.each([
    [
      "a setting nobody has defined",
      { baseUrl: "https://example.test", timeout: 3000 },
      "timeout",
    ],
    [
      "a value beside a target",
      { baseUrl: "https://example.test", value: "x" },
      "value",
    ],
  ])("refuses %s", (_case, profile, key) => {
    const error = refusal(profileSchema.safeParse(profile));

    // Zod reports an unrecognised key on the object it was found in, so the path is the profile itself and the key is
    // named in the message.
    expect(error.issues.map((issue) => issue.code)).toContain(
      "unrecognized_keys",
    );
    expect(issueText(error)).toContain(key);
  });
});

/* -------------------------------------------------------------------------- */
/* The target                                                                 */
/* -------------------------------------------------------------------------- */

describe("a base URL", () => {
  it.each([
    ["a relative path", "/api"],
    ["a bare host", "example.test"],
    ["another scheme", "ftp://example.test"],
    ["a non-URL", "not a url"],
    ["empty", ""],
  ])("refuses %s, with exactly one issue", (_case, baseUrl) => {
    const error = refusal(profileSchema.safeParse({ baseUrl }));

    // Single-element, not `toContain`. An earlier revision of the constraint reported an empty string twice — once for
    // "not empty" and once, derived from it, for "not a URL" — and only an exact assertion notices that.
    expect(issuePaths(error)).toStrictEqual(["baseUrl"]);
  });

  it.each([
    ["a username and a password", "https://user:secret@example.test"],
    ["a username only", "https://user@example.test"],
  ])(
    "refuses %s, because a credential in a URL is a secret in the wrong field",
    (_case, baseUrl) => {
      const error = refusal(profileSchema.safeParse({ baseUrl }));

      expect(issueText(error)).toContain("username or password");
    },
  );

  it("refuses an embedded newline rather than letting the URL parser strip it", () => {
    // `new URL("https://example.test\nx")` succeeds and silently drops the newline. The control-character guard runs
    // first, which is the only thing that refuses this — and the ordering is easy to lose in a tidy-up.
    const error = refusal(
      profileSchema.safeParse({ baseUrl: "https://example.test\nx" }),
    );

    expect(issueText(error)).toContain("control characters");
  });

  it("accepts a target at the length bound and refuses one character more", () => {
    const prefix = "https://example.test/";
    const atLimit = `${prefix}${"a".repeat(2048 - prefix.length)}`;

    expect(atLimit).toHaveLength(2048);
    expect(profileAccepts({ baseUrl: atLimit })).toBe(true);
    expect(profileAccepts({ baseUrl: `${atLimit}a` })).toBe(false);
  });

  it("does not echo the offending value in its message", () => {
    const error = refusal(
      profileSchema.safeParse({ baseUrl: "https://user:hunter2@example.test" }),
    );

    // A diagnostic reaches a terminal, a log and a pasted issue. The value here contains a credential, and the message
    // says what is wrong without repeating what was written.
    expect(issueText(error)).not.toContain("hunter2");
  });
});

/* -------------------------------------------------------------------------- */
/* Secrets                                                                    */
/* -------------------------------------------------------------------------- */

describe("a secret reference", () => {
  it("accepts a named source", () => {
    const parsed = secretReferenceSchema.safeParse({
      from: SecretSource.Environment,
      name: "QAT_STAGING_API_TOKEN",
    });

    expect(parsed.success).toBe(true);
  });

  it.each([
    ["no source", { name: "TOKEN_SOURCE" }, "from"],
    ["no name", { from: "environment" }, "name"],
    [
      "an unsupported source",
      { from: "keychain", name: "TOKEN_SOURCE" },
      "from",
    ],
    ["a lowercase name", { from: "environment", name: "token_source" }, "name"],
  ])("refuses %s", (_case, reference, field) => {
    const error = refusal(secretReferenceSchema.safeParse(reference));

    expect(issuePaths(error)).toContain(field);
  });

  it("refuses a reference that carries a value", () => {
    const error = refusal(
      secretReferenceSchema.safeParse({
        from: "environment",
        name: "TOKEN_SOURCE",
        value: "hunter2",
      }),
    );

    // The security property of the shape, and the reason it is strict: writing the credential where it does not belong
    // is an error addressed to that line, rather than a secret in a pull request.
    expect(error.issues.map((issue) => issue.code)).toContain(
      "unrecognized_keys",
    );
    expect(issueText(error)).not.toContain("hunter2");
  });

  it("is refused a level up when the whole entry is a bare string", () => {
    const error = refusal(
      profileSchema.safeParse({ secrets: { API_TOKEN: "env:TOKEN_SOURCE" } }),
    );

    // The shape a prefix convention would have allowed. It fails, which is the point of two maps rather than one.
    expect(issuePaths(error)).toStrictEqual(["secrets.API_TOKEN"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Variables                                                                  */
/* -------------------------------------------------------------------------- */

describe("variables", () => {
  it.each([
    ["a lowercase name", { api_url: "x" }, "api_url"],
    // The hyphen is what makes this case what its name says. `API_URL` — an earlier revision of this table — is a valid
    // variable name, so the case asserted nothing about hyphens while reading as coverage of them.
    ["a name with a hyphen", { "API-URL": "x" }, "API-URL"],
  ])("refuses %s, at the key's own path", (_case, variables, name) => {
    // The existing variable constraint, reused rather than restated: a name here is handed to a child process as an
    // environment variable, where the spelling matters. The path names the key, because a reader needs to know *which*
    // variable, not that one of them is wrong.
    const error = refusal(profileSchema.safeParse({ variables }));

    expect(issuePaths(error)).toStrictEqual([`variables.${name}`]);
  });

  it.each([
    ["a number", 1],
    ["a boolean", true],
    ["a nested object", { A: "1" }],
  ])("refuses a %s as a value", (_case, value) => {
    expect(profileAccepts({ variables: { API_URL: value } })).toBe(false);
  });

  it("refuses a multi-line value", () => {
    // A value with a newline is almost always a paste accident, and a runner that received it would pass something
    // different from what the file appears to say.
    expect(
      profileAccepts({ variables: { CERTIFICATE: "line one\nline two" } }),
    ).toBe(false);
  });

  it("accepts a value at the length bound and refuses one character more", () => {
    expect(profileAccepts({ variables: { BLOB: "a".repeat(4096) } })).toBe(
      true,
    );
    expect(profileAccepts({ variables: { BLOB: "a".repeat(4097) } })).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The collection                                                             */
/* -------------------------------------------------------------------------- */

describe("the set of environments", () => {
  it("accepts an empty map", () => {
    // Distinct from an empty *profile*, and legitimate: a project with no named environments is a project QAT can still
    // inspect. The difference is what the two absences mean, not the shape.
    expect(environmentsSchema.safeParse({}).success).toBe(true);
  });

  it.each([
    ["development", { baseUrl: "http://localhost:3000" }],
    ["staging", { baseUrl: "https://staging.example.test" }],
    ["production", { baseUrl: "https://example.test" }],
    ["qa-1", { baseUrl: "https://qa1.example.test" }],
    ["a".repeat(32), { baseUrl: "https://example.test" }],
  ])("accepts the profile name %s", (name, profile) => {
    expect(environmentsSchema.safeParse({ [name]: profile }).success).toBe(
      true,
    );
  });

  it.each([
    ["a capital", "Staging"],
    ["a leading digit", "1staging"],
    ["an underscore", "staging_env"],
    ["a space", "staging env"],
    ["an empty name", ""],
    ["one character too long", "a".repeat(33)],
  ])("refuses a name with %s, and names it", (_case, name) => {
    const error = refusal(
      environmentsSchema.safeParse({
        [name]: { baseUrl: "https://example.test" },
      }),
    );

    // The path is the key, not the map: a reader needs to know which profile to rename.
    expect(issuePaths(error)).toStrictEqual([name]);
  });

  it("refuses a value that is not an object", () => {
    const error = refusal(environmentsSchema.safeParse("staging"));

    expect(error.issues.length).toBeGreaterThan(0);
  });

  it("reports a bad profile at the profile's own path", () => {
    const error = refusal(
      environmentsSchema.safeParse({
        staging: { baseUrl: "not a url" },
        production: { baseUrl: "https://example.test" },
      }),
    );

    // One profile is wrong and the other is fine; the issue names the one that is wrong, and the sibling is not blamed.
    expect(issuePaths(error)).toStrictEqual(["staging.baseUrl"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Reserved names                                                             */
/* -------------------------------------------------------------------------- */

describe("a reserved name", () => {
  it("refuses a profile called __proto__", () => {
    // Parsed from text, not written as a literal: `{ __proto__: … }` in source sets the prototype of the object and
    // creates no key at all, so a literal cannot express the case this guard exists for.
    const document = JSON.parse(
      '{"__proto__": {"baseUrl": "https://example.test"}}',
    ) as unknown;

    const error = refusal(environmentsSchema.safeParse(document));

    expect(issuePaths(error)).toContain("__proto__");
    expect(issueText(error)).toContain("reserved by the language");
  });

  it.each([
    ["a variable", "variables", "constructor"],
    ["a secret", "secrets", "constructor"],
    ["a variable named prototype", "variables", "prototype"],
  ])("refuses %s called %s", (_case, map, key) => {
    const entry =
      map === "variables" ? "x" : { from: "environment", name: "TOKEN_SOURCE" };
    const document = JSON.parse(
      `{"staging": {"${map}": {"${key}": ${JSON.stringify(entry)}}}}`,
    ) as unknown;

    const error = refusal(environmentsSchema.safeParse(document));

    expect(issuePaths(error)).toContain(`staging.${map}.${key}`);
  });
});

/* -------------------------------------------------------------------------- */
/* Corner cases                                                               */
/* -------------------------------------------------------------------------- */

describe("corner cases", () => {
  it("keeps the last of two profiles with the same name, silently", () => {
    // A limit, asserted so it is a decision rather than a surprise: `JSON.parse` cannot report a duplicate key, so the
    // second definition wins and nothing notices. Fixing it needs a parser that reports duplicates.
    const document = JSON.parse(
      '{"staging": {"baseUrl": "https://first.test"}, "staging": {"baseUrl": "https://second.test"}}',
    ) as unknown;

    const parsed = environmentsSchema.safeParse(document);

    if (!parsed.success) {
      throw new Error(
        `expected the document to be accepted: ${issuePaths(parsed.error).join(", ")}`,
      );
    }

    expect(parsed.data).toStrictEqual({
      staging: { baseUrl: "https://second.test" },
    });
  });

  it("accepts two profiles that address the same target", () => {
    // Sharing a base URL is plausible and not the schema's business: a rule that compared values across profiles would
    // be a policy, and policies belong in validation where they can name the consequence.
    const parsed = environmentsSchema.safeParse({
      qa: { baseUrl: "https://shared.example.test" },
      staging: { baseUrl: "https://shared.example.test" },
    });

    expect(parsed.success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Non-functional                                                             */
/* -------------------------------------------------------------------------- */

describe("non-functional behaviour", () => {
  it("is deterministic", () => {
    expect(profileSchema.safeParse(VALID_PROFILE)).toStrictEqual(
      profileSchema.safeParse(VALID_PROFILE),
    );
  });

  it("does not modify the value it was given", () => {
    const document = {
      staging: {
        baseUrl: "https://staging.example.test",
        variables: { API_URL: "https://staging.example.test/api" },
      },
    };
    const before = structuredClone(document);

    environmentsSchema.safeParse(document);

    // The reserved-name guard walks the raw value, which is the one place in this schema that touches the input before
    // Zod rebuilds it. A walk that assigned anything would corrupt the document every later consumer reads.
    expect(document).toStrictEqual(before);
  });

  it("reports every independent problem in one pass", () => {
    const error = refusal(
      profileSchema.safeParse({
        baseUrl: "not a url",
        variables: { api_url: "x" },
      }),
    );

    // Two unrelated defects, both reported: a reader fixing a file should not have to run the command twice.
    const paths = issuePaths(error);

    expect(paths).toContain("baseUrl");
    expect(paths.some((path) => path.startsWith("variables"))).toBe(true);
  });

  it("reports one issue per value, not one per rule the value broke", () => {
    // `""` breaks "not empty" and "must be a URL"; a 2049-character value breaks the bound and the parse. The reader
    // needs the first, and a second message derived from it is noise in a terminal and in a `--json` document.
    for (const baseUrl of ["", "a".repeat(2049), "not a url"]) {
      const error = refusal(profileSchema.safeParse({ baseUrl }));

      expect(issuePaths(error)).toStrictEqual(["baseUrl"]);
    }
  });
});
