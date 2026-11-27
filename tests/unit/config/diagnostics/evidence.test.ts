/**
 * What is allowed to leave the process.
 *
 * This is the security boundary of the configuration diagnostics, so the cases here are less about behaviour than about
 * *non*-occurrence: a value that must not appear, a string that must not exceed a bound, an object that must not be
 * mutable once it has been handed to a renderer. The happy paths are cheap; the ones worth reading are the four
 * security sections at the bottom.
 *
 * The redactor is a double in every case, which is the point of the port: the module's contract is "call it, and call it
 * in this order", and a test that used the product's real redaction would be testing that service instead.
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildConfigEvidence,
  MAX_EVIDENCE_STRING,
  summariseValue,
  toProjectRelative,
  toSafeIssue,
  truncate,
  type ConfigEvidenceInput,
  type SecretRedactorPort,
} from "~/config/diagnostics/evidence.js";
import type { ConfigIssue } from "~/config/inspect.js";

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

const ROOT = "/project";
const FILE = "/project/qat.config.json";

/** Leaves everything alone, so a case that is about something else says so. */
const identity: SecretRedactorPort = { redact: (value) => value };

/** Masks anything that looks like a token, the way the product's redactor would. */
const masking: SecretRedactorPort = {
  redact: (value) => (value.includes("sk_live") ? "[redacted]" : value),
};

function input(
  overrides: Partial<ConfigEvidenceInput> = {},
): ConfigEvidenceInput {
  return {
    projectRoot: ROOT,
    path: FILE,
    schemaVersion: 1,
    framework: "cypress",
    prerequisite: "CFG-001",
    redactor: identity,
    ...overrides,
  };
}

function issue(overrides: Partial<ConfigIssue> = {}): ConfigIssue {
  return {
    path: ["output", "reports"],
    code: "custom",
    message: "Must be relative to the project root.",
    ...overrides,
  };
}

/* ------------------------------------------------------------------------- *
 * truncate
 * ------------------------------------------------------------------------- */

describe("truncate", () => {
  it("pins the bound the guidance prose quotes", () => {
    expect(MAX_EVIDENCE_STRING).toBe(200);
  });

  it("leaves a string shorter than the bound alone", () => {
    expect(truncate("qat.config.json")).toBe("qat.config.json");
  });

  it("leaves a string exactly at the bound alone", () => {
    // The boundary, asserted on its own: an off-by-one here would either clip a legal path or let a 201st character
    // through, and neither is visible without a case at the edge.
    const exact = "a".repeat(MAX_EVIDENCE_STRING);

    expect(truncate(exact)).toBe(exact);
    expect(truncate(exact)).toHaveLength(MAX_EVIDENCE_STRING);
  });

  it("shortens one character past the bound, keeping the length at the bound", () => {
    const over = "a".repeat(MAX_EVIDENCE_STRING + 1);
    const shortened = truncate(over);

    // The ellipsis replaces a character rather than adding one, so a consumer can rely on `length <= max`.
    expect(shortened).toHaveLength(MAX_EVIDENCE_STRING);
    expect(shortened.endsWith("…")).toBe(true);
  });

  it("honours an explicit bound", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
  });

  it("never grows a string", () => {
    for (const length of [0, 1, 199, 200, 201, 5_000]) {
      expect(truncate("x".repeat(length)).length).toBeLessThanOrEqual(
        MAX_EVIDENCE_STRING,
      );
    }
  });
});

/* ------------------------------------------------------------------------- *
 * toProjectRelative
 * ------------------------------------------------------------------------- */

describe("toProjectRelative", () => {
  it("makes a file inside the project relative", () => {
    expect(toProjectRelative(ROOT, FILE)).toBe("qat.config.json");
  });

  it("keeps a nested path nested", () => {
    expect(toProjectRelative(ROOT, "/project/config/qat.config.json")).toBe(
      "config/qat.config.json",
    );
  });

  it("reports the root itself as the current directory", () => {
    expect(toProjectRelative(ROOT, ROOT)).toBe(".");
    expect(toProjectRelative(ROOT, "")).toBe(".");
  });

  it("tolerates a trailing separator on the root", () => {
    expect(toProjectRelative("/project/", FILE)).toBe("qat.config.json");
  });

  it("normalises separators, so a Windows path reads the same as a POSIX one", () => {
    // The doctor runs in containers and on Windows agents, and a relative path has to read identically in both or every
    // report is a little different depending on who ran it.
    expect(
      toProjectRelative("C:\\project", "C:\\project\\qat.config.json"),
    ).toBe("qat.config.json");
    expect(toProjectRelative(ROOT, "/project/config\\qat.config.json")).toBe(
      "config/qat.config.json",
    );
  });

  it("does not treat a sibling directory as inside the project", () => {
    // The boundary test that a naive `startsWith(root)` fails: `/app` is a prefix of `/application`, and a resolver that
    // mistook one for the other would print a path outside the project as though it were inside it.
    expect(toProjectRelative("/app", "/application/qat.config.json")).toBe(
      "<outside-project>/qat.config.json",
    );
  });

  it("keeps only the basename when the target is outside the project", () => {
    // Enough to identify the file, not enough to disclose the surrounding layout — a home directory is the usual case.
    expect(
      toProjectRelative(ROOT, "/home/someone/shared/qat.config.json"),
    ).toBe("<outside-project>/qat.config.json");
  });

  it("bounds a pathologically long path", () => {
    const deep = `${ROOT}/${"nested/".repeat(100)}qat.config.json`;

    expect(toProjectRelative(ROOT, deep)).toHaveLength(MAX_EVIDENCE_STRING);
  });
});

/* ------------------------------------------------------------------------- *
 * Issue wording
 * ------------------------------------------------------------------------- */

describe("toSafeIssue", () => {
  it("joins a field path into the address a reader can act on", () => {
    expect(toSafeIssue(issue())).toStrictEqual({
      path: "output.reports",
      code: "custom",
      expected: "a value satisfying the documented constraint",
      received: null,
    });
  });

  it("names a root-level issue rather than leaving the path empty", () => {
    // An empty string in a report column reads as "no problem here", which is the opposite of the finding.
    expect(toSafeIssue(issue({ path: [] })).path).toBe("<root>");
  });

  it("renders a numeric segment as part of the path", () => {
    expect(
      toSafeIssue(issue({ path: ["environments", 0, "baseUrl"] })).path,
    ).toBe("environments.0.baseUrl");
  });

  it.each([
    [
      "invalid_type",
      "a value of the declared type",
      "a value of a different type",
    ],
    [
      "unrecognized_keys",
      "no unknown properties",
      "an object carrying unknown properties",
    ],
    [
      "invalid_enum_value",
      "one of the supported values",
      "an unsupported value",
    ],
    ["too_small", "a value within the permitted range", null],
    ["custom", "a value satisfying the documented constraint", null],
    [
      "a-code-from-the-future",
      "a value that satisfies the configuration schema",
      null,
    ],
  ])("describes %s without quoting the value", (code, expected, received) => {
    // The wording is derived from the *code*, not copied from the schema library's message — which is why an unknown
    // code still gets a sentence a reader can act on rather than an empty column.
    const safe = toSafeIssue(issue({ code }));

    expect(safe.expected).toBe(expected);
    expect(safe.received).toBe(received);
    expect(safe.code).toBe(code);
  });

  it("does not carry the schema library's message", () => {
    const safe = toSafeIssue(
      issue({ message: 'Expected object, received "sk_live_do_not_print"' }),
    );

    // The message is precisely where a rejected value leaks: libraries quote what they were given, and this projection
    // drops it in favour of wording keyed by the code.
    expect(JSON.stringify(safe)).not.toContain("sk_live");
    expect(Object.keys(safe).sort()).toStrictEqual([
      "code",
      "expected",
      "path",
      "received",
    ]);
  });
});

/* ------------------------------------------------------------------------- *
 * summariseValue
 * ------------------------------------------------------------------------- */

describe("summariseValue", () => {
  it.each([
    [null, "null"],
    ["secret", "string"],
    [42, "number"],
    [true, "boolean"],
    [[1, 2, 3], "array(3)"],
    [{}, "object(0 keys)"],
    [{ a: 1, b: 2 }, "object(2 keys)"],
  ])("summarises %j as %s", (value, expected) => {
    expect(summariseValue(value)).toBe(expected);
  });

  it("says what kind of thing a value is without saying what it is", () => {
    // The escape hatch for "we would like to mention this without printing it". Exported for exactly that reason: the
    // alternative a future caller reaches for is `JSON.stringify`, which is the leak.
    expect(summariseValue({ token: "sk_live_do_not_print" })).toBe(
      "object(1 keys)",
    );
  });
});

/* ------------------------------------------------------------------------- *
 * buildConfigEvidence
 * ------------------------------------------------------------------------- */

describe("buildConfigEvidence", () => {
  it("emits a project-relative path, whatever form it was given", () => {
    expect(buildConfigEvidence(input()).path).toBe("qat.config.json");
    expect(buildConfigEvidence(input({ path: "qat.config.json" })).path).toBe(
      "qat.config.json",
    );
    expect(
      buildConfigEvidence(input({ path: "/project/config/qat.config.json" }))
        .path,
    ).toBe("config/qat.config.json");
  });

  it("carries the schema version and the prerequisite unchanged", () => {
    const evidence = buildConfigEvidence(
      input({ schemaVersion: 2, prerequisite: null }),
    );

    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.prerequisite).toBeNull();
  });

  it("reports an unknown schema version as null rather than as a number", () => {
    expect(
      buildConfigEvidence(input({ schemaVersion: null })).schemaVersion,
    ).toBeNull();
  });

  it("maps every issue through the safe projection", () => {
    const evidence = buildConfigEvidence(
      input({ issues: [issue({ path: ["framework"] }), issue({ path: [] })] }),
    );

    expect(evidence.issues.map((entry) => entry.path)).toStrictEqual([
      "framework",
      "<root>",
    ]);
  });

  it("reports no issues when none were supplied", () => {
    // Absent and empty are different states in the facts, and the same one in the report: a consumer iterating issues
    // should not have to guard against a missing array.
    expect(buildConfigEvidence(input()).issues).toStrictEqual([]);
  });

  it("squashes string details and passes scalars through", () => {
    const evidence = buildConfigEvidence(
      input({
        details: {
          state: "inaccessible",
          code: "EACCES",
          line: 4,
          issueCount: 2,
        },
      }),
    );

    expect(evidence.details).toStrictEqual({
      state: "inaccessible",
      code: "EACCES",
      line: 4,
      issueCount: 2,
    });
  });

  it("squashes every element of an array detail", () => {
    const evidence = buildConfigEvidence(
      input({ details: { supported: ["1", "2", "3"] } }),
    );

    // Element-wise, so a list cannot be a way of smuggling an unbounded string past the per-value treatment.
    expect(evidence.details["supported"]).toStrictEqual(["1", "2", "3"]);
  });

  it("omits details entirely when the caller supplied none", () => {
    expect(buildConfigEvidence(input()).details).toStrictEqual({});
  });
});

/* ------------------------------------------------------------------------- *
 * Superseded: 1 — redaction
 * ------------------------------------------------------------------------- */

describe("redaction", () => {
  it("redacts the framework identifier", () => {
    // A framework name is not a secret, but it is user-authored and it flows into output, so it takes the same
    // treatment. A value that *looks* like a credential must not be printed even when we believe we know what it is.
    const evidence = buildConfigEvidence(
      input({ framework: "sk_live_framework_name", redactor: masking }),
    );

    expect(evidence.framework).toBe("[redacted]");
  });

  it("leaves a null framework null", () => {
    expect(
      buildConfigEvidence(input({ framework: null })).framework,
    ).toBeNull();
  });

  it("redacts string details, including inside arrays", () => {
    const evidence = buildConfigEvidence(
      input({
        redactor: masking,
        details: {
          state: "inaccessible",
          code: "sk_live_code",
          supported: ["sk_live_one", "2"],
        },
      }),
    );

    expect(evidence.details["code"]).toBe("[redacted]");
    expect(evidence.details["supported"]).toStrictEqual(["[redacted]", "2"]);
  });

  it("consults the redactor for every surviving string", () => {
    const redact = vi.fn((value: string) => value);

    // A framework plus one string detail: the two *kinds* of surviving string, so the count covers both routes rather
    // than only the obvious one.
    buildConfigEvidence(
      input({
        framework: "cypress",
        details: { state: "missing" },
        redactor: { redact },
      }),
    );

    // A count rather than a set: the point is that no string reaches evidence without passing through the redactor, so a
    // future field added here *without* a call fails this case. That is the only assertion in the file that notices the
    // absence of a call, which is why it has to be exact.
    expect(redact).toHaveBeenCalledTimes(2);
  });

  it("never lets a secret reach the evidence", () => {
    // The whole purpose of the module, stated as a property of its output rather than of one field.
    const evidence = buildConfigEvidence(
      input({
        framework: "sk_live_framework",
        redactor: masking,
        details: { state: "sk_live_state", code: "sk_live_code" },
        issues: [issue({ message: "sk_live_message" })],
      }),
    );

    expect(JSON.stringify(evidence)).not.toContain("sk_live");
  });
});

/* ------------------------------------------------------------------------- *
 * Superseded: 2 — ordering
 * ------------------------------------------------------------------------- */

describe("truncation and redaction order", () => {
  it("truncates before redacting, so the redactor sees the final text", () => {
    // The other way round can split a redaction marker and reveal a fragment of what it replaced. The spy records the
    // argument the redactor actually received.
    const redact = vi.fn((value: string) => value);

    buildConfigEvidence(
      input({
        path: "qat.config.json",
        framework: "a".repeat(500),
        redactor: { redact },
      }),
    );

    expect(redact).toHaveBeenCalledTimes(1);
    expect(redact.mock.calls[0]?.[0]).toHaveLength(MAX_EVIDENCE_STRING);
  });

  it("bounds what a redactor returns, so an expanding redactor cannot exceed the limit", () => {
    // The second truncation is not decoration: a redactor that replaces a token with a description would otherwise produce
    // a string longer than the value it replaced.
    const expanding: SecretRedactorPort = {
      redact: (value) => `[redacted ${value}]`.padEnd(1_000, "x"),
    };

    const evidence = buildConfigEvidence(
      input({ framework: "cypress", redactor: expanding }),
    );

    expect(evidence.framework?.length).toBeLessThanOrEqual(MAX_EVIDENCE_STRING);
  });
});

/* ------------------------------------------------------------------------- *
 * Immutability and determinism
 * ------------------------------------------------------------------------- */

describe("immutability and determinism", () => {
  it("freezes the evidence, its issue list and its details", () => {
    const evidence = buildConfigEvidence(
      input({ issues: [issue()], details: { state: "schema-invalid" } }),
    );

    // A consumer renders, serialises or persists this. One that mutated it in place would be changing what the next
    // consumer sees, and the change would be invisible because the first report was already correct.
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.issues)).toBe(true);
    expect(Object.isFrozen(evidence.details)).toBe(true);
  });

  it("freezes an array detail rather than only the object holding it", () => {
    const evidence = buildConfigEvidence(
      input({ details: { supported: ["1", "2"] } }),
    );

    expect(Object.isFrozen(evidence.details["supported"])).toBe(true);
  });

  it("freezes each safe issue", () => {
    const evidence = buildConfigEvidence(input({ issues: [issue()] }));

    expect(Object.isFrozen(evidence.issues[0])).toBe(true);
  });

  it("produces equal evidence for equal input", () => {
    const first = buildConfigEvidence(
      input({ details: { state: "malformed", line: 4 } }),
    );
    const second = buildConfigEvidence(
      input({ details: { state: "malformed", line: 4 } }),
    );

    expect(first).toStrictEqual(second);
  });

  it("does not mutate the input it was given", () => {
    // The redactor is a function and cannot be cloned, so the snapshot covers the data — which is also the only part of
    // the input a mutation would be visible in. Cloning the whole object would test `structuredClone`, not this module.
    const details = { supported: ["1", "2"] };
    const issues = [issue()];
    const supplied = input({ details, issues });
    const beforeDetails = structuredClone(details);
    const beforeIssues = structuredClone(issues);

    buildConfigEvidence(supplied);

    expect(details).toStrictEqual(beforeDetails);
    expect(issues).toStrictEqual(beforeIssues);
    // The scalars are copied by value into the input, so comparing one is enough to show the envelope was not rewritten.
    expect(supplied.path).toBe(FILE);
  });
});
