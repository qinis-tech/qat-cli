/**
 * Unit tests for the environment inspection state machine.
 *
 * The module under test has one job: given a selection and a profile catalogue, decide which of five
 * conditions is true — and stop at the first one that applies. Everything else in the environment
 * feature is downstream of that decision, so what these tests protect is the *order* as much as the
 * verdicts.
 *
 * Three properties are worth more than scenario coverage here, because each can fail silently:
 *
 *  - **A failing precondition stops the machine.** An unusable selection must not consult the profile
 *    catalogue; an undeclared profile must not be validated. A check that keeps going produces a second
 *    finding about a state that was never reached, and the reader is told to fix two things.
 *  - **Nothing that could not be read is guessed at.** A reference whose source is unapproved is
 *    reported as such and never probed, because probing would answer a question about a variable the
 *    declaration said QAT may not read.
 *  - **Output is deterministic.** Duplicate declarations fold to one verdict, list order does not depend
 *    on declaration order or on the host locale, and two runs with equal inputs produce equal results.
 */

import { describe, expect, it } from "vitest";

import {
  APPROVED_VARIABLE_SOURCES,
  inspectEnvironment,
  MAX_ENVIRONMENT_NAME_LENGTH,
  type EnvironmentInspection,
  type EnvironmentSelection,
  type InspectEnvironmentDependencies,
  type PathStatus,
  type ProfileIssue,
  type VariablePresence,
  type VariableReference,
} from "~/config/environment/index.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface FakeOptions {
  /** Declared profiles, as the gatherer would hand them over. The values are opaque. */
  readonly profiles?: Record<string, unknown>;
  /** What the profile schema reports. Empty means the profile was accepted. */
  readonly issues?: readonly ProfileIssue[];
  /** What the profile declares. */
  readonly references?: readonly VariableReference[];
  /** What path resolution concluded. */
  readonly paths?: readonly PathStatus[];
  /** Presence, by name. Anything unlisted answers `set`, because that is the quiet case. */
  readonly presence?: Record<string, VariablePresence>;
}

/**
 * Dependencies that record what was asked of them.
 *
 * Recording rather than mocking: the assertions below are mostly about *which* collaborator was reached
 * for, and an empty call list is a stronger statement than a spy that was never configured.
 */
function makeDeps(options: FakeOptions = {}) {
  const calls = {
    validateProfile: [] as { name: string; profile: unknown }[],
    readVariables: [] as string[],
    resolvePaths: [] as string[],
    probe: [] as string[],
  };

  const profiles = new Map<string, unknown>(
    Object.entries(options.profiles ?? { staging: { e2e: {} } }),
  );

  const deps: InspectEnvironmentDependencies = {
    profiles,

    validateProfile: (name, profile) => {
      calls.validateProfile.push({ name, profile });
      return options.issues ?? [];
    },

    readVariables: (name) => {
      calls.readVariables.push(name);
      return options.references ?? [];
    },

    resolvePaths: (name) => {
      calls.resolvePaths.push(name);
      return options.paths ?? [];
    },

    presence: {
      probe: (name) => {
        calls.probe.push(name);
        return options.presence?.[name] ?? "set";
      },
    },

    configPath: "/project/qat.config.json",
  };

  return { deps, calls, profiles };
}

/**
 * A selection naming a profile, from the default source.
 *
 * The parameter is `string`, not `string | undefined`. Under `exactOptionalPropertyTypes` this helper
 * could not build `{ origin, name: undefined }` for `name?: string` — and that is the type system
 * enforcing a distinction the rest of the feature depends on: a *nameless* selection and a selection
 * whose name is the string "undefined" are different states, and `inspectEnvironment` handles them in
 * different branches.
 */
function selected(
  name: string,
  origin: EnvironmentSelection["origin"] = "configuration-default",
): EnvironmentSelection {
  return { origin, name };
}

/**
 * Asserts the state and narrows.
 *
 * The cast is unavoidable — TypeScript cannot narrow through a generic guard — but it happens after the
 * assertion, so a wrong state fails here with the state that was actually produced rather than three
 * lines later with an undefined property.
 */
function expectState<K extends EnvironmentInspection["state"]>(
  result: EnvironmentInspection,
  state: K,
): Extract<EnvironmentInspection, { state: K }> {
  if (result.state !== state) {
    const message = `Expected state "${state}", received "${result.state}".`;
    throw new Error(message);
  }

  return result as Extract<EnvironmentInspection, { state: K }>;
}

// ─── Selection ───────────────────────────────────────────────────────────────

describe("inspectEnvironment — selection", () => {
  it("reports nothing selected without consulting anything else", () => {
    const { deps, calls } = makeDeps();

    const result = inspectEnvironment({ origin: "none" }, deps);

    expect(result).toStrictEqual({ state: "not-selected", origin: "none" });

    // A missing selection is a state, not an error, and there is nothing downstream to ask about it.
    expect(calls.validateProfile).toStrictEqual([]);
    expect(calls.readVariables).toStrictEqual([]);
    expect(calls.resolvePaths).toStrictEqual([]);
    expect(calls.probe).toStrictEqual([]);
  });

  it("trusts the origin rather than a stray name", () => {
    // A malformed selection should not be able to smuggle a profile past the first branch. The origin is
    // the fact; a name without one describes a selection nobody made.
    const { deps } = makeDeps();

    expect(
      inspectEnvironment({ origin: "none", name: "staging" }, deps),
    ).toStrictEqual({
      state: "not-selected",
      origin: "none",
    });
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["a tab", "\t"],
    ["interior whitespace", "sta ging"],
    ["a leading hyphen", "-staging"],
    ["a path separator", "staging/eu"],
    ["a control character", "staging\n"],
    [
      "one character over the bound",
      "a".repeat(MAX_ENVIRONMENT_NAME_LENGTH + 1),
    ],
  ])("reports an unusable selection for %s", (_label, name) => {
    const { deps, calls } = makeDeps();

    const result = expectState(
      inspectEnvironment({ origin: "explicit-cli", name }, deps),
      "selection-invalid",
    );

    // The raw value travels so the finding can quote what the caller supplied. A message that said only
    // "invalid selection" would leave them comparing their command line against nothing.
    expect(result.raw).toBe(name);
    expect(result.origin).toBe("explicit-cli");

    // Reported rather than replaced: falling through to a default here would run a different environment
    // than the one asked for, which is the one outcome worth failing on.
    expect(calls.validateProfile).toStrictEqual([]);
  });

  it("reports an unusable selection when a malformed selection carries no name", () => {
    const { deps } = makeDeps();

    // Only reachable from a caller that built the value by hand; it must land in the same branch as an
    // explicit empty flag rather than throw.
    expect(inspectEnvironment({ origin: "explicit-cli" }, deps)).toStrictEqual({
      state: "selection-invalid",
      origin: "explicit-cli",
      raw: "",
    });
  });

  it("preserves the origin of the supplied selection", () => {
    const { deps } = makeDeps({ profiles: { staging: {} } });

    const fromProcess = expectState(
      inspectEnvironment(selected("staging", "process-environment"), deps),
      "profile-valid",
    );

    // Both rules report which source chose the profile, so a reader can tell "you typed this" from
    // "your file said this" — the two have different fixes.
    expect(fromProcess.origin).toBe("process-environment");
  });
});

// ─── Profile existence ───────────────────────────────────────────────────────

describe("inspectEnvironment — profile existence", () => {
  it("reports an undeclared profile with the names that do exist", () => {
    const { deps, calls } = makeDeps({
      profiles: { development: {}, staging: {} },
    });

    const result = expectState(
      inspectEnvironment(selected("production"), deps),
      "profile-not-found",
    );

    expect(result.name).toBe("production");
    expect(result.available).toStrictEqual(["development", "staging"]);

    // Existence is checked before validity: you cannot judge the fields of a profile that is not there.
    expect(calls.validateProfile).toStrictEqual([]);
  });

  it("sorts the available names deterministically, not in declaration order", () => {
    const { deps } = makeDeps({
      profiles: { zeta: {}, alpha: {}, mike: {} },
    });

    const result = expectState(
      inspectEnvironment(selected("omega"), deps),
      "profile-not-found",
    );

    // Evidence that reordered between runs is evidence nobody can diff, and insertion order here is
    // whatever the configuration parser happened to do.
    expect(result.available).toStrictEqual(["alpha", "mike", "zeta"]);
  });

  it("reports an empty catalogue rather than an empty list in a sentence", () => {
    const { deps } = makeDeps({ profiles: {} });

    const result = expectState(
      inspectEnvironment(selected("staging"), deps),
      "profile-not-found",
    );

    // `available` being empty is a real answer — "declare one" — and it is what the finding's remediation
    // branches on. An omitted member would make that branch unreachable.
    expect(result.available).toStrictEqual([]);
  });
});

// ─── Profile validity ────────────────────────────────────────────────────────

describe("inspectEnvironment — profile validity", () => {
  const issues: readonly ProfileIssue[] = [
    { path: "baseUrl", code: "invalid_string", expected: "an absolute URL" },
    { path: "variables.API_TOKEN", code: "invalid_type" },
  ];

  it("reports the issues the schema produced, unchanged", () => {
    const { deps } = makeDeps({ issues });

    const result = expectState(
      inspectEnvironment(selected("staging"), deps),
      "profile-invalid",
    );

    // Carried verbatim rather than summarised: the field paths are the address a reader acts on, and a
    // rewrite here would be a second wording for a decision the schema already made.
    expect(result.issues).toStrictEqual(issues);
    expect(result.name).toBe("staging");
  });

  it("treats a single issue as invalid, not as a warning", () => {
    const { deps } = makeDeps({
      issues: [{ path: "baseUrl", code: "invalid_string" }],
    });

    // There is no such thing as a half-valid profile: a document the schema refused is one QAT will not
    // act on, and the count is reported rather than weighed.
    expect(inspectEnvironment(selected("staging"), deps).state).toBe(
      "profile-invalid",
    );
  });

  it("hands the schema the profile the catalogue holds", () => {
    const profile = { e2e: { baseUrl: "http://localhost" } };
    const { deps, calls } = makeDeps({ profiles: { staging: profile } });

    inspectEnvironment(selected("staging"), deps);

    // The same object, not a copy and not `undefined`: a validator handed nothing reports every required
    // field as missing, which reads as a profile the user wrote badly.
    expect(calls.validateProfile).toStrictEqual([{ name: "staging", profile }]);
  });

  it("does not ask for references or paths when the profile is invalid", () => {
    const { deps, calls } = makeDeps({ issues });

    inspectEnvironment(selected("staging"), deps);

    // References inside a profile that failed the schema belong to a document nobody parsed. Reading
    // them would let the second check judge variables out of a profile that was never accepted.
    expect(calls.readVariables).toStrictEqual([]);
    expect(calls.resolvePaths).toStrictEqual([]);
    expect(calls.probe).toStrictEqual([]);
  });
});

// ─── Reference verification ──────────────────────────────────────────────────

describe("inspectEnvironment — reference verification", () => {
  it("classifies a usable reference without exposing a value", () => {
    const { deps } = makeDeps({
      references: [
        { name: "API_TOKEN", source: "env", requirement: "required" },
      ],
      presence: { API_TOKEN: "set" },
    });

    const result = expectState(
      inspectEnvironment(selected("staging"), deps),
      "profile-valid",
    );

    // The verdict carries a name and a state. There is no field here that could hold the value, which is
    // the whole reason the presence port returns an enum.
    expect(result.variables).toStrictEqual([
      { reason: "ENV_VARIABLE_PRESENT", name: "API_TOKEN" },
    ]);
  });

  it.each([
    ["missing", "unset"],
    ["blank", "blank"],
  ] as const)(
    "carries the declaration with a %s verdict",
    (reason, presence) => {
      const { deps } = makeDeps({
        references: [
          { name: "API_TOKEN", source: "env", requirement: "required" },
        ],
        presence: { API_TOKEN: presence },
      });

      const result = expectState(
        inspectEnvironment(selected("staging"), deps),
        "profile-valid",
      );

      // The requirement travels with the verdict because severity is derived from it downstream. A
      // verdict that dropped it would force the classifier to re-read the profile for a fact it was
      // already told.
      expect(result.variables).toStrictEqual([
        {
          reason:
            reason === "missing"
              ? "ENV_VARIABLE_MISSING"
              : "ENV_VARIABLE_BLANK",
          name: "API_TOKEN",
          requirement: "required",
        },
      ]);
    },
  );

  it("reports a presence question it could not answer, rather than a pass", () => {
    const { deps } = makeDeps({
      references: [
        { name: "API_TOKEN", source: "env", requirement: "required" },
      ],
      presence: { API_TOKEN: "unknown" },
    });

    const result = expectState(
      inspectEnvironment(selected("staging"), deps),
      "profile-valid",
    );

    // "I could not look" and "it is not set" lead a reader to different places, and it is never rendered
    // as present.
    expect(result.variables).toStrictEqual([
      { reason: "ENV_VARIABLE_UNVERIFIABLE", name: "API_TOKEN" },
    ]);
  });

  it("reports an unapproved source without probing it", () => {
    const { deps, calls } = makeDeps({
      references: [
        { name: "API_TOKEN", source: "file", requirement: "required" },
      ],
    });

    const result = expectState(
      inspectEnvironment(selected("staging"), deps),
      "profile-valid",
    );

    // The source is echoed because the finding quotes it: a reader who wrote `file` needs to see `file`.
    expect(result.variables).toStrictEqual([
      {
        reason: "ENV_REFERENCE_SOURCE_NOT_APPROVED",
        name: "API_TOKEN",
        source: "file",
      },
    ]);

    // Asking whether a variable is set is meaningless when the declaration named a source QAT may not
    // read. Cheap, certain failures come first.
    expect(calls.probe).toStrictEqual([]);
  });

  it("reports a name that cannot be passed faithfully without probing it", () => {
    const { deps, calls } = makeDeps({
      references: [
        { name: "api-token", source: "env", requirement: "required" },
      ],
    });

    const result = expectState(
      inspectEnvironment(selected("staging"), deps),
      "profile-valid",
    );

    expect(result.variables).toStrictEqual([
      { reason: "ENV_REFERENCE_NAME_INVALID", name: "api-token" },
    ]);
    expect(calls.probe).toStrictEqual([]);
  });

  it("folds duplicate declarations into one verdict, keeping the strictest requirement", () => {
    const { deps } = makeDeps({
      references: [
        { name: "API_TOKEN", source: "env", requirement: "unspecified" },
        { name: "API_TOKEN", source: "env", requirement: "required" },
      ],
      presence: { API_TOKEN: "unset" },
    });

    const result = expectState(
      inspectEnvironment(selected("staging"), deps),
      "profile-valid",
    );

    // Two references to one name are a configuration smell, not this module's business to reject. What it
    // guarantees is that the verdict does not depend on declaration order — and that folding two
    // declarations never downgrades a required variable to optional.
    expect(result.variables).toStrictEqual([
      {
        reason: "ENV_VARIABLE_MISSING",
        name: "API_TOKEN",
        requirement: "required",
      },
    ]);

    // One probe for one variable, not two.
    expect(result.variables).toHaveLength(1);
  });

  it("keeps the strictest requirement whichever way round the duplicates appear", () => {
    const forward = makeDeps({
      references: [
        { name: "API_TOKEN", source: "env", requirement: "required" },
        { name: "API_TOKEN", source: "env", requirement: "optional" },
      ],
      presence: { API_TOKEN: "unset" },
    });
    const backward = makeDeps({
      references: [
        { name: "API_TOKEN", source: "env", requirement: "optional" },
        { name: "API_TOKEN", source: "env", requirement: "required" },
      ],
      presence: { API_TOKEN: "unset" },
    });

    expect(inspectEnvironment(selected("staging"), forward.deps)).toStrictEqual(
      inspectEnvironment(selected("staging"), backward.deps),
    );
  });

  it("returns verdicts sorted by name, in code-unit order", () => {
    const { deps } = makeDeps({
      references: [
        { name: "ZED_TOKEN", source: "env", requirement: "required" },
        { name: "ALPHA_TOKEN", source: "env", requirement: "required" },
        { name: "MIKE_TOKEN", source: "env", requirement: "required" },
      ],
    });

    const result = expectState(
      inspectEnvironment(selected("staging"), deps),
      "profile-valid",
    );

    // Declaration order is whatever the configuration writer typed. Evidence that reordered between runs
    // — or between machines with different locales — is evidence nobody can diff.
    expect(result.variables.map((variable) => variable.name)).toStrictEqual([
      "ALPHA_TOKEN",
      "MIKE_TOKEN",
      "ZED_TOKEN",
    ]);
  });

  it("probes every usable reference exactly once", () => {
    const { deps, calls } = makeDeps({
      references: [
        { name: "ALPHA_TOKEN", source: "env", requirement: "required" },
        { name: "BETA_TOKEN", source: "env", requirement: "optional" },
      ],
    });

    inspectEnvironment(selected("staging"), deps);

    expect(calls.probe).toStrictEqual(["ALPHA_TOKEN", "BETA_TOKEN"]);
  });
});

// ─── Paths ───────────────────────────────────────────────────────────────────

describe("inspectEnvironment — paths", () => {
  it("sorts path verdicts by field", () => {
    const { deps } = makeDeps({
      paths: [
        { reason: "ENV_PATH_RESOLVED", field: "reports.directory" },
        { reason: "ENV_PATH_RESOLVED", field: "evidence.directory" },
        { reason: "ENV_PATH_RESOLVED", field: "fixtures.directory" },
      ],
    });

    const result = expectState(
      inspectEnvironment(selected("staging"), deps),
      "profile-valid",
    );

    expect(result.paths.map((path) => path.field)).toStrictEqual([
      "evidence.directory",
      "fixtures.directory",
      "reports.directory",
    ]);
  });

  it("keeps the kind of an unresolved path", () => {
    const { deps } = makeDeps({
      paths: [
        {
          reason: "ENV_PATH_OUTSIDE_PROJECT",
          field: "fixtures.directory",
          declared: "../../shared",
        },
      ],
    });

    const result = expectState(
      inspectEnvironment(selected("staging"), deps),
      "profile-valid",
    );

    // The kind reaches the finding so the remedy can differ: an absolute path is fixed by making it
    // relative, an escaping one by moving it inside the project.
    expect(result.paths).toStrictEqual([
      {
        reason: "ENV_PATH_OUTSIDE_PROJECT",
        field: "fixtures.directory",
        declared: "../../shared",
      },
    ]);
  });
});

// ─── Non-functional ──────────────────────────────────────────────────────────

describe("inspectEnvironment — determinism and purity", () => {
  it("produces a deeply equal result for equal inputs", () => {
    const build = () =>
      makeDeps({
        references: [
          { name: "BETA_TOKEN", source: "env", requirement: "required" },
          { name: "ALPHA_TOKEN", source: "env", requirement: "optional" },
        ],
        paths: [{ reason: "ENV_PATH_RESOLVED", field: "reports.directory" }],
        presence: { BETA_TOKEN: "unset", ALPHA_TOKEN: "blank" },
      });

    const first = inspectEnvironment(selected("staging"), build().deps);

    for (let index = 0; index < 100; index += 1) {
      expect(
        inspectEnvironment(selected("staging"), build().deps),
      ).toStrictEqual(first);
    }
  });

  it("does not reorder the collections it was given", () => {
    // Frozen on purpose: an implementation that sorted in place would throw here rather than corrupting
    // evidence a second consumer reads — and the corruption would be invisible, because the result is
    // correct.
    const references = Object.freeze([
      Object.freeze({
        name: "ZED_TOKEN",
        source: "env",
        requirement: "required" as const,
      }),
      Object.freeze({
        name: "ALPHA_TOKEN",
        source: "env",
        requirement: "required" as const,
      }),
    ]);
    const paths = Object.freeze([
      Object.freeze({
        reason: "ENV_PATH_RESOLVED" as const,
        field: "reports.directory",
      }),
    ]);

    const { deps } = makeDeps({ references, paths });

    expect(() => inspectEnvironment(selected("staging"), deps)).not.toThrow();
    expect(references.map((reference) => reference.name)).toStrictEqual([
      "ZED_TOKEN",
      "ALPHA_TOKEN",
    ]);
  });

  it.each([
    ["a control character", "stag\u0000ing"],
    ["an emoji", "stag\u{1F600}ing"],
    ["a kilobyte of punctuation", "!".repeat(1024)],
    ["a right-to-left override", "\u202Estaging"],
  ])("returns a state rather than throwing for %s", (_label, name) => {
    // The machine's contract is that expected conditions are results. A name is user text from a command
    // line, so the shapes it can take are unbounded — and a throw here would take down the whole report.
    const { deps } = makeDeps();

    expect(() => inspectEnvironment(selected(name), deps)).not.toThrow();
    expect(inspectEnvironment(selected(name), deps).state).toBe(
      "selection-invalid",
    );
  });
});

describe("APPROVED_VARIABLE_SOURCES", () => {
  it("approves exactly one source", () => {
    // Policy, quoted by the finding that rejects a reference. If a second source is ever approved, the
    // remediation text and this assertion change together — which is the point of asserting it.
    expect(APPROVED_VARIABLE_SOURCES).toStrictEqual(["env"]);
  });

  it("does not approve a literal source", () => {
    // The absence that matters most: a value written into a configuration file is a leaked credential,
    // not a setting, and there is deliberately no source that would accept one.
    expect(APPROVED_VARIABLE_SOURCES).not.toContain("literal");
    expect(APPROVED_VARIABLE_SOURCES).not.toContain("file");
  });
});
