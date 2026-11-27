/**
 * The projection from an inspection to findings.
 *
 * `classifyConfiguration` is pure and takes its prose as a port, so every state, every reason and every severity is a
 * table row. Nothing here builds a document, a file or a clock: the guidance double records what it was asked and returns
 * a distinguishable string, which is what lets a case assert *that* prose was requested for a reason rather than pinning
 * the prose itself.
 *
 * The two things this file exists to keep true are not obvious from any single assertion:
 *
 *  • **Which check speaks.** A pass produces silence rather than a row, so the number of findings is part of the contract,
 *    not an accident. Three of the six states produce two findings and three produce one, and the difference is which
 *    check has something to say.
 *  • **What is never rendered.** `skipped` exists so a consequence is not reported as a second problem, and the reason it
 *    carries is the *blocker's*, not one of its own. A case asserts that, because "skipped for a reason nobody emitted"
 *    is the failure mode that would make a report inconsistent with itself.
 */
import { describe, expect, it } from "vitest";

import {
  CHECK_TITLE,
  classifyConfiguration,
  primaryReasonForIssues,
  type ClassifyOptions,
  type ConfigDiagnostic,
  type ConfigGuidancePort,
  type GuidanceInput,
  type QatConfigReason,
} from "~/config/diagnostics/index.js";
import type { ConfigInspection, SchemaInvalidConfig } from "~/config/index.js";

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

/** The facade's issue shape, derived from the state that carries it — the same route the composition root takes. */
type ConfigIssue = SchemaInvalidConfig["issues"][number];

const PATH = "qat.config.json";
const NOW = "2026-01-01T00:00:00.000Z";

function issue(
  path: readonly (string | number)[],
  code = "custom",
): ConfigIssue {
  return { path, code, message: `${path.join(".") || "<root>"} was refused.` };
}

/**
 * A guidance port that records its inputs.
 *
 * Returns a string that names the reason rather than a sentence: an assertion can then say "the entry for this reason was
 * asked" without the test being a second copy of the catalogue's wording.
 */
function double(overrides: Partial<ConfigGuidancePort> = {}): {
  readonly port: ConfigGuidancePort;
  readonly explained: readonly GuidanceInput[];
  readonly remediated: readonly GuidanceInput[];
} {
  const explained: GuidanceInput[] = [];
  const remediated: GuidanceInput[] = [];

  return {
    explained,
    remediated,
    port: {
      explain: (input) => {
        explained.push(input);
        return overrides.explain?.(input) ?? `explained:${input.reason}`;
      },
      remediate: (input) => {
        remediated.push(input);
        return overrides.remediate === undefined
          ? `fix:${input.reason}`
          : overrides.remediate(input);
      },
    },
  };
}

function options(
  guidance: ConfigGuidancePort,
  overrides: Partial<Omit<ClassifyOptions, "guidance">> = {},
): ClassifyOptions {
  return { required: false, guidance, now: () => NOW, ...overrides };
}

const ABSENT: ConfigInspection = { state: "missing", searchedAt: PATH };
const UNREADABLE: ConfigInspection = {
  state: "inaccessible",
  path: PATH,
  code: "EACCES",
};
const OVERSIZE: ConfigInspection = {
  state: "inaccessible",
  path: PATH,
  code: "TOO_LARGE",
};
const MALFORMED: ConfigInspection = {
  state: "malformed",
  path: PATH,
  line: 4,
  column: 17,
};
const MALFORMED_NO_POSITION: ConfigInspection = {
  state: "malformed",
  path: PATH,
};
const UNSUPPORTED: ConfigInspection = {
  state: "version-unsupported",
  path: PATH,
  declared: 7,
  supported: [1],
};
const VALID: ConfigInspection = {
  state: "valid",
  path: PATH,
  version: 1,
  config: { framework: "cypress" },
};

function schemaInvalid(
  issues: readonly ConfigIssue[],
  version = 1,
): ConfigInspection {
  return { state: "schema-invalid", path: PATH, version, issues };
}

/** The finding for one check, or a failure naming the check that reported nothing. */
function findingFor(
  findings: readonly ConfigDiagnostic[],
  id: "CFG-001" | "CFG-002",
): ConfigDiagnostic {
  const found = findings.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`${id} reported nothing.`);
  return found;
}

/* ------------------------------------------------------------------------- *
 * Reason selection
 * ------------------------------------------------------------------------- */

describe("primaryReasonForIssues", () => {
  it("puts an unusable schema version ahead of every other field", () => {
    // Nothing else about the file can be trusted once the version is wrong, so the ordering is a correctness rule rather
    // than a presentation preference.
    expect(
      primaryReasonForIssues([issue(["framework"]), issue(["schemaVersion"])]),
    ).toBe<QatConfigReason>("QAT_CONFIG_VERSION_INVALID");
  });

  it("puts an unusable framework ahead of a path problem", () => {
    expect(
      primaryReasonForIssues([
        issue(["output", "reports"]),
        issue(["framework"]),
      ]),
    ).toBe<QatConfigReason>("QAT_CONFIG_FRAMEWORK_UNSUPPORTED");
  });

  it.each([
    ["reports", "directory"],
    ["evidence", "directory"],
    ["artifacts", "directory"],
    ["output", "reports"],
  ])("treats %s.directory as a path-bearing field", (...segments) => {
    expect(primaryReasonForIssues([issue(segments)])).toBe<QatConfigReason>(
      "QAT_CONFIG_OUTPUT_PATH_INVALID",
    );
  });

  it("does not treat a field that merely starts with a path-bearing word as one", () => {
    // `reporting` is not `reports`. A prefix match here would send a reader to fix a path that is fine, and the failure
    // would look like a correct diagnosis.
    expect(
      primaryReasonForIssues([issue(["reporting", "directory"])]),
    ).toBe<QatConfigReason>("QAT_CONFIG_SCHEMA_INVALID");
  });

  it("falls back to the general field report", () => {
    expect(
      primaryReasonForIssues([issue(["environments"])]),
    ).toBe<QatConfigReason>("QAT_CONFIG_SCHEMA_INVALID");
  });

  it("reports a root-level issue as the general field report", () => {
    // A document that is not an object has no field to name. Inventing one — the first key, the schema version — would
    // point a reader at something the problem is not about.
    expect(primaryReasonForIssues([issue([])])).toBe<QatConfigReason>(
      "QAT_CONFIG_SCHEMA_INVALID",
    );
  });

  it("is total over an empty issue list", () => {
    // Unreachable through the facade, which only calls this when it has issues, and asserted anyway: a function that
    // returned `undefined` for a legal input would produce a finding with no reason at the one call site that trusted it.
    expect(primaryReasonForIssues([])).toBe<QatConfigReason>(
      "QAT_CONFIG_SCHEMA_INVALID",
    );
  });
});

/* ------------------------------------------------------------------------- *
 * States that leave the validity check silent
 * ------------------------------------------------------------------------- */

describe("absent configuration", () => {
  it("passes the readability check, and skips the pair's second half", () => {
    const { port, explained } = double();

    const findings = classifyConfiguration(ABSENT, options(port));

    // Two findings, not one: the discovery check has something to say, and the validity check must say explicitly that
    // it did not evaluate anything.
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.id)).toStrictEqual([
      "CFG-001",
      "CFG-002",
    ]);

    const discovery = findingFor(findings, "CFG-001");
    expect(discovery.status).toBe("pass");
    expect(discovery.reason).toBe<QatConfigReason>("QAT_CONFIG_MISSING");
    // Information, not a warning: the documented defaults are a supported state, and marking a normal state as a problem
    // is how a doctor teaches people to ignore it.
    expect(discovery.severity).toBe("information");
    expect(discovery.remediation).toBe("fix:QAT_CONFIG_MISSING");
    expect(discovery.evidence.path).toBe(PATH);
    expect(discovery.evidence.prerequisite).toBeNull();
    expect(discovery.evidence.details).toStrictEqual({ state: "missing" });

    const validity = findingFor(findings, "CFG-002");
    expect(validity.status).toBe("skipped");
    expect(validity.evidence.prerequisite).toBe("CFG-001");
    expect(validity.remediation).toBeNull();

    // The skipped row does not consult guidance: its sentence is built from the state, and there is no reason of its own
    // for an entry to describe.
    expect(explained).toHaveLength(1);
    expect(explained[0]?.reason).toBe<QatConfigReason>("QAT_CONFIG_MISSING");
  });

  it("blocks when the operation requires configuration, and stays informational otherwise", () => {
    const { port } = double();

    const optional = findingFor(
      classifyConfiguration(ABSENT, options(port)),
      "CFG-001",
    );
    const required = findingFor(
      classifyConfiguration(ABSENT, options(port, { required: true })),
      "CFG-001",
    );

    expect(optional.status).toBe("pass");
    expect(optional.severity).toBe("information");

    // Same observation, different consequence — which is why they are two reasons rather than one with a flag.
    expect(required.status).toBe("fail");
    expect(required.severity).toBe("error");
    expect(required.reason).toBe<QatConfigReason>(
      "QAT_CONFIG_MISSING_REQUIRED",
    );
  });

  it("asks guidance for the operation's own requirement, not a default", () => {
    const { port, explained } = double();

    classifyConfiguration(ABSENT, options(port, { required: true }));

    expect(explained[0]?.required).toBe(true);
  });
});

describe("unreadable configuration", () => {
  it("fails the readability check and skips validity", () => {
    const { port } = double();

    const findings = classifyConfiguration(UNREADABLE, options(port));

    expect(findings.map((finding) => finding.id)).toStrictEqual([
      "CFG-001",
      "CFG-002",
    ]);

    const discovery = findingFor(findings, "CFG-001");
    expect(discovery.status).toBe("fail");
    expect(discovery.severity).toBe("error");
    expect(discovery.reason).toBe<QatConfigReason>("QAT_CONFIG_UNREADABLE");
    // The access code travels as evidence: remediation differs between a permission, a directory and a symlink loop, so
    // the sentence needs the cause and the finding is where it is available without opening the file again.
    expect(discovery.evidence.details).toStrictEqual({
      state: "inaccessible",
      code: "EACCES",
    });
    expect(findingFor(findings, "CFG-002").status).toBe("skipped");
  });

  it("carries the oversize code rather than collapsing it into a read failure", () => {
    const { port } = double();

    const discovery = findingFor(
      classifyConfiguration(OVERSIZE, options(port)),
      "CFG-001",
    );

    expect(discovery.reason).toBe<QatConfigReason>("QAT_CONFIG_UNREADABLE");
    expect(discovery.evidence.details).toMatchObject({ code: "TOO_LARGE" });
  });
});

describe("malformed configuration", () => {
  it("carries the position, because a line is content and a number is not", () => {
    const { port } = double();

    const discovery = findingFor(
      classifyConfiguration(MALFORMED, options(port)),
      "CFG-001",
    );

    expect(discovery.reason).toBe<QatConfigReason>("QAT_CONFIG_MALFORMED");
    expect(discovery.evidence.details).toStrictEqual({
      state: "malformed",
      line: 4,
      column: 17,
    });
  });

  it("omits the position entirely when the loader had none", () => {
    const { port } = double();

    const discovery = findingFor(
      classifyConfiguration(MALFORMED_NO_POSITION, options(port)),
      "CFG-001",
    );

    // Absent keys, not `undefined` values: a consumer iterating the details should not meet a key whose value means
    // nothing, and a renderer formatting `line` would print the word "undefined" into a sentence.
    expect(discovery.evidence.details).toStrictEqual({ state: "malformed" });
    expect(Object.keys(discovery.evidence.details)).not.toContain("line");
    expect(Object.keys(discovery.evidence.details)).not.toContain("column");
  });
});

/* ------------------------------------------------------------------------- *
 * States the readability check passes through
 * ------------------------------------------------------------------------- */

describe("unsupported schema version", () => {
  it("is reported by the validity check alone", () => {
    const { port, explained } = double();

    const findings = classifyConfiguration(UNSUPPORTED, options(port));

    // One finding. The bytes arrived and became a document, so CFG-001 has nothing to report — and manufacturing a
    // "readable" row would put a line in every report that says nothing.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("CFG-002");
    expect(findings[0]?.status).toBe("fail");
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.reason).toBe<QatConfigReason>(
      "QAT_CONFIG_VERSION_UNSUPPORTED",
    );
    expect(findings[0]?.evidence.schemaVersion).toBeNull();

    // Declared and supported both travel, because "unsupported version" without the pair leaves a reader unable to tell
    // whether to upgrade QAT or edit the file.
    expect(findings[0]?.evidence.details).toStrictEqual({
      state: "version-unsupported",
      declared: 7,
      supported: ["1"],
    });

    // No field list: there is nothing meaningful to say about the fields of a document whose version we cannot read.
    expect(explained[0]?.fields).toStrictEqual([]);
    expect(explained[0]?.supportedVersions).toStrictEqual([1]);
  });

  it("does not echo a declared value that was not a number", () => {
    // The facade only reaches this state for a numeric version; a non-numeric one is a field error. Asserting the guard
    // anyway keeps a future caller from putting arbitrary file content into evidence by taking this branch.
    const { port } = double();
    const odd: ConfigInspection = { ...UNSUPPORTED, declared: "seven" };

    const findings = classifyConfiguration(odd, options(port));

    expect(findingFor(findings, "CFG-002").evidence.details).toMatchObject({
      declared: null,
    });
  });
});

describe("schema rejection", () => {
  it("reports the version it interpreted alongside the issues", () => {
    const { port } = double();
    const inspection = schemaInvalid([
      issue(["environments"], "unrecognized_keys"),
    ]);

    const finding = findingFor(
      classifyConfiguration(inspection, options(port)),
      "CFG-002",
    );

    expect(finding.status).toBe("fail");
    expect(finding.reason).toBe<QatConfigReason>("QAT_CONFIG_SCHEMA_INVALID");
    expect(finding.evidence.schemaVersion).toBe(1);
  });

  it("reports a negative version as unknown rather than as a version", () => {
    const { port } = double();
    const inspection = schemaInvalid([issue(["version"], "invalid_type")], -1);

    const finding = findingFor(
      classifyConfiguration(inspection, options(port)),
      "CFG-002",
    );

    // `-1` is the facade's "no usable version" marker. Echoing it would put a number in a report that looks like a
    // version a reader could go and find.
    expect(finding.evidence.schemaVersion).toBeNull();
  });

  it("names the field paths as the piece a reader can act on", () => {
    const { port, explained } = double();
    const inspection = schemaInvalid([
      issue(["output", "reports"]),
      issue(["framework"], "invalid_enum_value"),
    ]);

    const findings = classifyConfiguration(inspection, options(port));

    expect(explained[0]?.fields).toStrictEqual(["output.reports", "framework"]);
    expect(findings[0]?.reason).toBe<QatConfigReason>(
      "QAT_CONFIG_FRAMEWORK_UNSUPPORTED",
    );
  });

  it("preserves the order the facade guarantees, and does not reorder it", () => {
    const { port } = double();
    // Sortedness belongs to the façade, which documents it on `SchemaInvalidConfig.issues` and proves it in its own
    // suite. Asserting it again here would make two places responsible for one guarantee. What this case pins is what
    // classify owes: the reader sees the façade's ordering, not a grouping this function invented on the way through.
    const inspection = schemaInvalid([
      issue(["framework"], "invalid_enum_value"),
      issue(["output", "evidence"], "custom"),
      issue(["output", "reports"], "custom"),
    ]);

    const finding = findingFor(
      classifyConfiguration(inspection, options(port)),
      "CFG-002",
    );

    expect(finding.evidence.issues.map((entry) => entry.path)).toStrictEqual([
      "framework",
      "output.evidence",
      "output.reports",
    ]);
  });

  it("reduces each issue to a reason and a type summary, never to a value", () => {
    const { port } = double();
    // Root first: `''` sorts before any field path, which is the ordering the façade supplies. The fixture states that
    // rather than relying on classify to impose it.
    const inspection = schemaInvalid([
      { path: [], code: "custom", message: "The document must be an object" },
      { path: ["env"], code: "invalid_type", message: "Expected object" },
    ]);

    const finding = findingFor(
      classifyConfiguration(inspection, options(port)),
      "CFG-002",
    );

    expect(finding.evidence.issues).toStrictEqual([
      {
        path: "<root>",
        code: "custom",
        expected: "a value satisfying the documented constraint",
        received: null,
      },
      {
        path: "env",
        code: "invalid_type",
        expected: "a value of the declared type",
        received: "a value of a different type",
      },
    ]);
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
    ["something-new", "a value that satisfies the configuration schema", null],
  ])("describes %s without quoting the value", (code, expected, received) => {
    const { port } = double();
    const inspection = schemaInvalid([
      { path: ["field"], code, message: "detail" },
    ]);

    const finding = findingFor(
      classifyConfiguration(inspection, options(port)),
      "CFG-002",
    );

    // An unknown code gets the general wording rather than nothing: a schema library that adds a code should produce a
    // sentence a reader can still act on, not an empty string in a report.
    expect(finding.evidence.issues[0]?.expected).toBe(expected);
    expect(finding.evidence.issues[0]?.received).toBe(received);
  });
});

describe("usable configuration", () => {
  it("passes the validity check without a row from the readability check", () => {
    const { port, remediated } = double({ remediate: () => null });

    const findings = classifyConfiguration(VALID, options(port));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("CFG-002");
    expect(findings[0]?.status).toBe("pass");
    expect(findings[0]?.severity).toBe("information");
    expect(findings[0]?.reason).toBe<QatConfigReason>("QAT_CONFIG_VALID");
    expect(findings[0]?.evidence.schemaVersion).toBe(1);
    // The framework identifier is echoed only when it is a plain string; a renderer that printed `[object Object]` would
    // be quoting a value rather than naming one.
    expect(findings[0]?.evidence.framework).toBe("cypress");
    // A successful check has nothing to fix, and the port's `null` reaches the finding unchanged.
    expect(findings[0]?.remediation).toBeNull();
    expect(remediated).toHaveLength(1);
  });

  it("reports no framework when the resolved configuration does not name one", () => {
    const { port } = double();
    const anonymous: ConfigInspection = { ...VALID, config: { framework: 42 } };

    const findings = classifyConfiguration(anonymous, options(port));

    expect(findings[0]?.evidence.framework).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * Shape, determinism and immutability
 * ------------------------------------------------------------------------- */

describe("shape", () => {
  it("gives every finding the same envelope", () => {
    const { port } = double();

    const findings = [
      ...classifyConfiguration(ABSENT, options(port)),
      ...classifyConfiguration(MALFORMED, options(port)),
      ...classifyConfiguration(UNSUPPORTED, options(port)),
      ...classifyConfiguration(VALID, options(port)),
    ];

    for (const finding of findings) {
      // `category` is a constant rather than a parameter: a finding about configuration is grouped with configuration,
      // and a check does not get to choose its own heading.
      expect(finding.category).toBe("configuration");
      expect(finding.executedAt).toBe(NOW);
      // The title comes from the same table the catalogue reads, so a report heading and a catalogue row cannot diverge.
      expect(finding.title).toBe(CHECK_TITLE[finding.id]);
      expect(finding.explanation.length).toBeGreaterThan(0);
    }
  });

  it("uses the injected clock for every finding, including the skipped one", () => {
    // One clock per run, so a report cannot contain two timestamps from two calls to `new Date()` and imply the file was
    // read twice.
    const { port } = double();
    let calls = 0;

    const findings = classifyConfiguration(ABSENT, {
      ...options(port),
      now: () => {
        calls += 1;
        return NOW;
      },
    });

    expect(calls).toBe(1);
    expect(findings.map((finding) => finding.executedAt)).toStrictEqual([
      NOW,
      NOW,
    ]);
  });

  it("returns frozen findings, evidence, issue lists and details", () => {
    const { port } = double();
    const findings = classifyConfiguration(
      schemaInvalid([issue(["environments"])]),
      options(port),
    );
    const finding = findings[0];

    expect(finding).toBeDefined();
    if (finding === undefined) return;

    // Frozen all the way down: a consumer renders or serialises this, and one that mutated it would be changing what the
    // next consumer sees.
    expect(Object.isFrozen(finding)).toBe(true);
    expect(Object.isFrozen(finding.evidence)).toBe(true);
    expect(Object.isFrozen(finding.evidence.issues)).toBe(true);
    expect(Object.isFrozen(finding.evidence.details)).toBe(true);
  });

  it("does not mutate the inspection it was given", () => {
    const { port } = double();
    const inspection = schemaInvalid([issue(["output", "reports"])]);
    const before = structuredClone(inspection);

    classifyConfiguration(inspection, options(port));

    // The inspection is shared: two consumers reading one result must see the same thing, which a sort in place would
    // break — and only for the second consumer.
    expect(inspection).toStrictEqual(before);
  });

  it("produces equal findings for equal inputs", () => {
    const { port } = double();

    expect(classifyConfiguration(UNSUPPORTED, options(port))).toStrictEqual(
      classifyConfiguration(UNSUPPORTED, options(port)),
    );
  });
});
