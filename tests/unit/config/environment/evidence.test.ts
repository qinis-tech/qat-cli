/**
 * Unit tests for environment evidence assembly and the output gate.
 *
 * This module is the last thing that touches a finding before it is printed or persisted, which gives it two
 * jobs that fail in different ways and are tested differently:
 *
 *  - **Assembly.** It projects an inspection and a set of verdicts into the shape a stored record carries.
 *    Getting it wrong produces evidence that disagrees with the message beside it — the config path of a
 *    different project, a variable list from a different state, an issue count that contradicts the finding.
 *  - **The gate.** It normalises every string that leaves: no control characters, no terminal escapes, no
 *    absolute paths, bounded lists. Getting it wrong is a log-injection vector or a leaked home directory, and
 *    neither would fail a functional test.
 *
 * The one thing it does *not* do is redact, and several cases below assert the absence of anything to redact:
 * the inspection carries names and presence states, the detail carries names and counts, and there is no field
 * anywhere in the chain capable of holding a variable's value.
 */

import { describe, expect, it } from "vitest";

import {
  buildEnvironmentEvidence,
  capList,
  EVIDENCE_LIMITS,
  OUTSIDE_PROJECT,
  sanitiseDetail,
  sanitiseName,
  sanitiseToken,
  toProjectRelative,
  type EnvironmentDiagnostic,
  type EnvironmentDiagnosticStatus,
  type EnvironmentEvidenceInput,
  type EnvironmentInspection,
} from "~/config/environment/index.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

type ProfileValid = Extract<EnvironmentInspection, { state: "profile-valid" }>;

const ROOT = "/project";

function profileValid(overrides: Partial<ProfileValid> = {}): ProfileValid {
  return {
    state: "profile-valid",
    origin: "configuration-default",
    name: "staging",
    variables: [{ reason: "ENV_VARIABLE_PRESENT", name: "API_TOKEN" }],
    paths: [{ reason: "ENV_PATH_RESOLVED", field: "fixtures.directory" }],
    ...overrides,
  };
}

/** A diagnostic of a given status, with the fields `countIssues` reads. */
function diagnostic(
  status: EnvironmentDiagnosticStatus,
): EnvironmentDiagnostic {
  return {
    id: "ENV-002",
    status,
    severity: status === "fail" ? "error" : "information",
    reason: status === "fail" ? "ENV_PROFILE_INVALID" : null,
    profile: "staging",
    origin: "configuration-default",
    detail: {},
  };
}

/** Evidence for one inspection, with no diagnostics unless a case supplies them. */
function evidenceFor(
  inspection: EnvironmentInspection,
  overrides: Partial<EnvironmentEvidenceInput> = {},
) {
  return buildEnvironmentEvidence({
    inspection,
    diagnostics: [],
    projectRoot: ROOT,
    configPath: "/project/qat.config.json",
    ...overrides,
  });
}

// ─── Limits ─────────────────────────────────────────────────────────────────

describe("EVIDENCE_LIMITS", () => {
  it("bounds every string and every list that leaves this module", () => {
    // Asserted rather than assumed: a renderer that restated one of these numbers would eventually emit a
    // bound the persisted evidence does not use, and the report and the record would disagree about what a
    // complete list looks like.
    expect(EVIDENCE_LIMITS).toStrictEqual({
      tokenLength: 256,
      nameLength: 64,
      listLength: 50,
    });
  });

  it("is frozen", () => {
    // Exported policy. A caller that mutated it would silently change what every later finding in the process
    // is allowed to print.
    expect(Object.isFrozen(EVIDENCE_LIMITS)).toBe(true);
  });
});

// ─── Path rendering ────────────────────────────────────────────────────────

describe("toProjectRelative", () => {
  it("renders an absolute path inside the project as a relative one", () => {
    // The whole reason this exists: a shared CI log must not reveal a contributor's home directory, and an
    // absolute path is rarely useful in a finding anyway.
    expect(toProjectRelative(ROOT, "/project/qat.config.json")).toBe(
      "qat.config.json",
    );
  });

  it("renders the project root itself as a single dot", () => {
    expect(toProjectRelative(ROOT, ROOT)).toBe(".");
  });

  it("strips a leading ./ from a path that was already relative", () => {
    expect(toProjectRelative(ROOT, "./qat.config.json")).toBe(
      "qat.config.json",
    );
  });

  it("leaves a plain relative path alone", () => {
    expect(toProjectRelative(ROOT, "qat.config.json")).toBe("qat.config.json");
  });

  it.each([
    ["an absolute path outside the project", "/etc/passwd"],
    ["a relative escape", "../shared/cypress.config.ts"],
    ["the parent directory itself", ".."],
    ["a traversal dressed as an absolute path", "/project/../etc/passwd"],
  ])("reports %s as outside the project", (_label, candidate) => {
    // A marker rather than the path: the fact that it escaped is the finding, and the user's directory layout
    // is not. Remediation can name the declared value; evidence must not.
    expect(toProjectRelative(ROOT, candidate)).toBe(OUTSIDE_PROJECT);
  });

  it.each([
    ["a Windows drive path", "C:\\Users\\dev\\qat.config.json"],
    ["a UNC path", "//server/share/qat.config.json"],
  ])("recognises %s on every platform", (_label, candidate) => {
    // Configuration files travel between machines far more often than people expect, and a Windows-shaped path
    // must not be mistaken for a relative one just because the test is running on Linux.
    expect(toProjectRelative(ROOT, candidate)).toBe(OUTSIDE_PROJECT);
  });

  it("never throws, whatever it is handed", () => {
    // Evidence assembly runs after a verdict has already been reached; a malformed path must not be able to
    // destroy the report that explains it.
    for (const candidate of [
      "",
      " ",
      "\u0000",
      "a".repeat(1024),
      "/",
      "\\\\",
    ]) {
      expect(() => toProjectRelative(ROOT, candidate)).not.toThrow();
    }
  });
});

// ─── Token normalisation ───────────────────────────────────────────────────

describe("sanitiseToken", () => {
  it("leaves an ordinary path or field name untouched", () => {
    for (const value of [
      "qat.config.json",
      "reports/directory",
      "ENV_REFERENCE_NAME_INVALID",
    ]) {
      expect(sanitiseToken(value)).toBe(value);
    }
  });

  it("removes a terminal escape sequence", () => {
    const sanitised = sanitiseToken("\u001b[31mred\u001b[0m");

    // The characters that make an escape sequence work are the ones removed, which is what matters. Asserting
    // the exact replacement count would pin a cosmetic detail; asserting the escape is gone pins the guarantee.
    expect(sanitised).not.toContain("\u001b");
    expect(sanitised).not.toContain("[");
    expect(sanitised).toContain("red");
  });

  it("replaces control characters rather than deleting them", () => {
    // `?` rather than removal: the shape and length of what was there stay visible, so a user reading a mangled
    // name learns something, whereas a silently shortened one looks like a different name.
    expect(sanitiseToken("staging\n")).toBe("staging?");
    expect(sanitiseToken("stag\u0000ing")).toBe("stag?ing");
  });

  it("replaces whitespace, which no legitimate token contains", () => {
    expect(sanitiseToken("sta ging")).toBe("sta?ging");
  });

  it("truncates to the token bound", () => {
    expect(
      sanitiseToken("a".repeat(EVIDENCE_LIMITS.tokenLength + 100)),
    ).toHaveLength(EVIDENCE_LIMITS.tokenLength);
  });
});

describe("sanitiseName", () => {
  it("truncates to the name bound, which is shorter than the token bound", () => {
    // Profile and variable names appear in sentences, so they get the tighter bound. A 256-character name would
    // push the rest of the message off a terminal line.
    expect(sanitiseName("a".repeat(300))).toHaveLength(
      EVIDENCE_LIMITS.nameLength,
    );
    expect(EVIDENCE_LIMITS.nameLength).toBeLessThan(
      EVIDENCE_LIMITS.tokenLength,
    );
  });

  it("applies the same character rule as a token", () => {
    expect(sanitiseName("sta ging")).toBe("sta?ging");
  });
});

// ─── Lists ─────────────────────────────────────────────────────────────────

describe("capList", () => {
  it("returns a frozen copy of a short list", () => {
    const input = ["a", "b"];
    const capped = capList(input);

    expect(capped).toStrictEqual(["a", "b"]);
    // A copy, not the same array: a caller could otherwise mutate evidence a second consumer reads.
    expect(capped).not.toBe(input);
    expect(Object.isFrozen(capped)).toBe(true);
  });

  it("leaves a list exactly at the bound unmarked", () => {
    const input = Array.from(
      { length: EVIDENCE_LIMITS.listLength },
      (_unused, index) => `n${index}`,
    );

    // The boundary in the direction that is easy to get wrong: a marker at exactly the limit would tell a reader
    // something was omitted when nothing was.
    expect(capList(input)).toHaveLength(EVIDENCE_LIMITS.listLength);
    expect(capList(input).at(-1)).toBe(`n${EVIDENCE_LIMITS.listLength - 1}`);
  });

  it("marks a list one over the bound", () => {
    const input = Array.from(
      { length: EVIDENCE_LIMITS.listLength + 1 },
      (_unused, index) => `n${index}`,
    );
    const capped = capList(input);

    // Silent truncation is the worse option: the report would look complete while hiding the entry the user
    // needed.
    expect(capped).toHaveLength(EVIDENCE_LIMITS.listLength + 1);
    expect(capped.at(-1)).toBe("+1 more");
  });

  it("honours an explicit bound", () => {
    expect(capList(["a", "b", "c"], 2)).toStrictEqual(["a", "b", "+1 more"]);
  });

  it("counts the omitted entries correctly", () => {
    const input = Array.from({ length: 60 }, (_unused, index) => `n${index}`);

    expect(capList(input).at(-1)).toBe("+10 more");
  });
});

// ─── Detail sanitisation ───────────────────────────────────────────────────

describe("sanitiseDetail", () => {
  it("passes numbers and strings through the gate", () => {
    expect(sanitiseDetail({ checked: 3, profile: "staging" })).toStrictEqual({
      checked: 3,
      profile: "staging",
    });
  });

  it("sanitises every element of a list", () => {
    expect(
      sanitiseDetail({ missing: ["API TOKEN", "BETA_TOKEN"] }),
    ).toStrictEqual({
      missing: ["API?TOKEN", "BETA_TOKEN"],
    });
  });

  it("sanitises the key as well as the value", () => {
    // Keys come from the same untrusted direction as values — a detail map is written by whoever built it — and a
    // key is printed in the same JSON document.
    expect(sanitiseDetail({ "bad key": "v" })).toStrictEqual({
      "bad?key": "v",
    });
  });

  it("keeps null as null rather than inventing a string", () => {
    expect(sanitiseDetail({ detected: null })).toStrictEqual({
      detected: null,
    });
  });

  it("collapses anything unexpected to null instead of stringifying it", () => {
    // The assertion that matters most in this file. `String(value)` or `JSON.stringify` would put the *contents*
    // of an object into a report — and if a future change ever put a value in a detail map, that is precisely how
    // it would escape. Collapsing to null loses a fact and leaks nothing.
    const detail = { nested: { token: "sk_live_secret" }, flag: true };

    const sanitised = sanitiseDetail(detail as never);

    expect(sanitised).toStrictEqual({ nested: null, flag: null });
    expect(JSON.stringify(sanitised)).not.toContain("sk_live_secret");
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(sanitiseDetail({ profile: "staging" }))).toBe(true);
  });

  it("is idempotent, which is what makes it safe to apply at the boundary", () => {
    const once = sanitiseDetail({
      path: "reports/out",
      missing: ["API TOKEN"],
    });

    // The rules apply it even though the producer already did. That is only safe if a second pass cannot change
    // anything.
    expect(sanitiseDetail(once)).toStrictEqual(once);
  });

  it.todo("survives a detail list that contains a non-string entry");
});

// ─── Evidence assembly ────────────────────────────────────────────────────

describe("buildEnvironmentEvidence", () => {
  it("carries exactly the fields a stored record declares", () => {
    // No `values`, no `environment`, no free-form bag. A structural assertion rather than a stylistic one: the
    // interface has no slot capable of holding a secret, and an added field would have to be justified here.
    expect(Object.keys(evidenceFor(profileValid())).sort()).toStrictEqual([
      "configPath",
      "issueCount",
      "paths",
      "profile",
      "selectionOrigin",
      "variables",
    ]);
  });

  it("reports the selected profile and where the selection came from", () => {
    const evidence = evidenceFor(profileValid({ origin: "explicit-cli" }));

    expect(evidence.profile).toBe("staging");
    expect(evidence.selectionOrigin).toBe("explicit-cli");
  });

  it("reports no profile when nothing was selected", () => {
    const evidence = evidenceFor({ state: "not-selected", origin: "none" });

    // `null` rather than an empty string: absence is a state, and a finding that printed an empty profile name
    // would read as a bug.
    expect(evidence.profile).toBeNull();
    expect(evidence.selectionOrigin).toBe("none");
  });

  it("reports no profile for an empty selection, and one for a non-empty unusable one", () => {
    const empty = evidenceFor({
      state: "selection-invalid",
      origin: "explicit-cli",
      raw: "",
    });
    const unusable = evidenceFor({
      state: "selection-invalid",
      origin: "explicit-cli",
      raw: "production",
    });

    // The raw text is user input, so it goes through the name gate — but it is still worth carrying, because the
    // finding quotes it back to show what was rejected.
    expect(empty.profile).toBeNull();
    expect(unusable.profile).toBe("production");
  });

  it("lists the variables examined, and only for a usable profile", () => {
    const usable = evidenceFor(
      profileValid({
        variables: [
          { reason: "ENV_VARIABLE_PRESENT", name: "API_TOKEN" },
          {
            reason: "ENV_VARIABLE_MISSING",
            name: "BETA_TOKEN",
            requirement: "required",
          },
        ],
      }),
    );
    const undeclared = evidenceFor({
      state: "profile-not-found",
      origin: "explicit-cli",
      name: "production",
      available: ["staging"],
    });

    // The question "what did you check?" only has an answer once the profile was usable. Listing names for an
    // undeclared profile would imply they were examined.
    expect(usable.variables).toStrictEqual(["API_TOKEN", "BETA_TOKEN"]);
    expect(undeclared.variables).toStrictEqual([]);
  });

  it("lists the path fields examined, and only for a usable profile", () => {
    const usable = evidenceFor(
      profileValid({
        paths: [
          { reason: "ENV_PATH_RESOLVED", field: "reports.directory" },
          {
            reason: "ENV_PATH_OUTSIDE_PROJECT",
            field: "fixtures.directory",
            declared: "../../shared",
          },
        ],
      }),
    );

    // The field, never the declared value: a path routinely contains a username, and the remedy is a shape.
    expect(usable.paths).toStrictEqual([
      "reports.directory",
      "fixtures.directory",
    ]);
    expect(
      evidenceFor({ state: "not-selected", origin: "none" }).paths,
    ).toStrictEqual([]);
  });

  it("counts the findings that reported a problem", () => {
    const diagnostics = [
      diagnostic("fail"),
      diagnostic("fail"),
      diagnostic("indeterminate"),
      diagnostic("pass"),
      diagnostic("skipped"),
    ];

    // Passes and skips are excluded: an issue count that included them would make a clean result look like five
    // issues and train people to ignore the number.
    expect(evidenceFor(profileValid(), { diagnostics }).issueCount).toBe(3);
  });

  it("counts nothing when there were no diagnostics", () => {
    expect(evidenceFor(profileValid()).issueCount).toBe(0);
  });

  it("relativises the configuration path, and omits it when there is none", () => {
    expect(evidenceFor(profileValid()).configPath).toBe("qat.config.json");
    expect(
      evidenceFor(profileValid(), { configPath: null }).configPath,
    ).toBeNull();

    // A configuration outside the project root would leak the caller's directory layout, so it becomes the same
    // marker a path would.
    expect(
      evidenceFor(profileValid(), { configPath: "/elsewhere/qat.config.json" })
        .configPath,
    ).toBe(OUTSIDE_PROJECT);
  });

  it("sanitises a hostile profile name", () => {
    const evidence = evidenceFor({
      state: "profile-not-found",
      origin: "explicit-cli",
      name: "stag\u001b[31ming",
      available: ["stag ing"],
    });

    // Names come from a configuration file and are printed verbatim, so they are the one piece of user text in this
    // module that cannot be avoided — only neutralised.
    expect(evidence.profile).not.toContain("\u001b");
    expect(evidence.profile).not.toContain("[");
  });

  it("caps a long list rather than emitting it whole", () => {
    const variables = Array.from(
      { length: EVIDENCE_LIMITS.listLength + 5 },
      (_unused, index) => ({
        reason: "ENV_VARIABLE_PRESENT" as const,
        name: `TOKEN_${index}`,
      }),
    );

    const evidence = evidenceFor(profileValid({ variables }));

    expect(evidence.variables).toHaveLength(EVIDENCE_LIMITS.listLength + 1);
    expect(evidence.variables.at(-1)).toBe("+5 more");
  });

  it("freezes the evidence and its lists", () => {
    const evidence = evidenceFor(profileValid());

    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.variables)).toBe(true);
    expect(Object.isFrozen(evidence.paths)).toBe(true);
  });

  it("is deterministic for equal inputs", () => {
    const build = () =>
      evidenceFor(profileValid(), { diagnostics: [diagnostic("fail")] });

    expect(Array.from({ length: 20 }, build)).toStrictEqual(
      Array.from({ length: 20 }, build),
    );
  });

  it("does not mutate the inspection or the diagnostics it was given", () => {
    const inspection = Object.freeze(profileValid());
    const diagnostics = Object.freeze([diagnostic("fail")]);

    // Frozen on purpose: an implementation that sorted or capped in place would throw here rather than quietly
    // corrupting a record a second consumer reads.
    expect(() => evidenceFor(inspection, { diagnostics })).not.toThrow();
  });
});
