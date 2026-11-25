/**
 * Selecting an environment, and resolving one profile into a target and a set of values.
 *
 * Six groups, one per thing the stage decides rather than per function it contains:
 *
 * 1. **Which environment** — requested, derived, or none, and the ways naming one can go wrong.
 * 2. **The target** — three levels in one call, plus the two that supply nothing.
 * 3. **The override** — validated with the file's own constraint, so it is not a bypass.
 * 4. **The variables** — passed through, never reinterpreted.
 * 5. **The secrets** — resolved, or reported without a value.
 * 6. **The shape** — what the result carries, what it must not, and that nothing is mutable afterwards.
 *
 * The ambient map is the single source for both the approved override variable and the secret values, which is how
 * production behaves: one process environment, read twice for two different reasons.
 *
 * ## Two fixtures, because a resolution is all or nothing
 *
 * A profile that declares a secret fails the whole resolution when the variable is absent — correct for a run, and noise
 * for a test about precedence. So `PLAIN` is the fixture for everything that is not about secrets, and `WITH_SECRET` is
 * used only where the secret is the subject. A token sprinkled through the precedence cases would make them look as
 * though they depended on one.
 */
import { describe, expect, it } from "vitest";

import type {
  DefaultEnvironmentResolution,
  EnvironmentResolution,
} from "~/config/resolver/contracts.js";
import {
  BASE_URL_ENVIRONMENT_VARIABLE,
  resolveEnvironment,
} from "~/config/resolver/environment.js";
import type { EnvironmentProfiles } from "~/config/schema/index.js";
import { InvalidArgumentError } from "~/core/errors/index.js";

/* -------------------------------------------------------------------------- */
/* A way to ask a question without restating the input shape                   */
/* -------------------------------------------------------------------------- */

interface Scenario {
  readonly profiles?: EnvironmentProfiles;
  readonly defaultEnvironment?: DefaultEnvironmentResolution;
  readonly requested?: string;
  readonly baseUrlFlag?: string;
  /** One map, two jobs: the override variable and the secret values, exactly as the process environment serves both. */
  readonly ambient?: Readonly<Record<string, string | undefined>>;
  readonly requireEnvironment?: boolean;
}

function resolve(scenario: Scenario = {}): EnvironmentResolution {
  const ambient = scenario.ambient ?? {};

  return resolveEnvironment({
    profiles: scenario.profiles,
    defaultEnvironment: scenario.defaultEnvironment ?? { origin: "none" },
    ...(scenario.requested === undefined
      ? {}
      : { requested: scenario.requested }),
    ...(scenario.baseUrlFlag === undefined
      ? {}
      : { fromFlag: { baseUrl: scenario.baseUrlFlag } }),
    environment: ambient,
    // The same reader production uses: a name in, whatever the ambient map holds out.
    readSecret: (name) => ambient[name],
    ...(scenario.requireEnvironment === undefined
      ? {}
      : { requireEnvironment: scenario.requireEnvironment }),
  });
}

/** The resolved half, or a failure naming the codes that were reported instead. */
function environmentOf(resolution: EnvironmentResolution) {
  if (!resolution.ok) {
    throw new Error(
      `expected a resolved environment, received ${resolution.issues.map((issue) => issue.code).join(", ")}`,
    );
  }

  return resolution.environment;
}

/** The codes a failure reported, so an assertion reads as the answer rather than as an index. */
function codesOf(resolution: EnvironmentResolution): readonly string[] {
  return resolution.ok ? [] : resolution.issues.map((issue) => issue.code);
}

/**
 * Run something that is expected to throw, and hand back what it threw.
 *
 * A `try`/`catch` in a test puts its assertions in a conditional block: they run only when a throw happened, and the
 * "nothing was thrown" case has to be caught by a second mechanism rather than by the assertion the reader is looking
 * at. Returning the error moves every expectation back onto the test body's own line, where it runs unconditionally.
 */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  return undefined;
}

const STAGING_VALUES = {
  baseUrl: "https://staging.example.test",
  variables: { API_URL: "https://api.staging.example.test" },
};

/** A target and a set of variables, and no secrets: the fixture for everything that is not about secrets. */
const PLAIN: EnvironmentProfiles = { staging: STAGING_VALUES };

const PRODUCTION: EnvironmentProfiles = {
  production: { baseUrl: "https://example.test" },
};

/** A profile that needs a secret: the fixture for the secret cases, and only those. */
const WITH_SECRET: EnvironmentProfiles = {
  staging: {
    ...STAGING_VALUES,
    secrets: { API_TOKEN: { from: "environment", name: "QAT_STAGING_TOKEN" } },
  },
};

const STAGING_DEFAULT = { origin: "configured", name: "staging" } as const;

/* -------------------------------------------------------------------------- */
/* 1. Which environment                                                       */
/* -------------------------------------------------------------------------- */

describe("selecting an environment", () => {
  it("uses the environment that was requested", () => {
    const resolution = resolve({
      profiles: { ...PLAIN, ...PRODUCTION },
      defaultEnvironment: STAGING_DEFAULT,
      requested: "production",
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    expect(resolution.name).toBe("production");
    expect(resolution.origin).toBe("requested");
  });

  it("reports a request as a request even when it agrees with the default", () => {
    // The origin answers "did somebody choose this, or did the tool?" — and somebody did.
    const resolution = resolve({
      profiles: PLAIN,
      defaultEnvironment: STAGING_DEFAULT,
      requested: "staging",
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    expect(resolution.origin).toBe("requested");
  });

  it.each([
    [
      "a configured default",
      { origin: "configured", name: "staging" } as const,
    ],
    [
      "an environment named default",
      { origin: "declared", name: "staging" } as const,
    ],
    ["the only environment", { origin: "sole", name: "staging" } as const],
  ])("falls back to %s", (__case__, defaultEnvironment) => {
    const resolution = resolve({ profiles: PLAIN, defaultEnvironment });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    // Derived upstream, and carried here unchanged: this stage must not compute a second answer.
    expect(resolution.name).toBe("staging");
    expect(resolution.origin).toBe("default");
  });

  it("names the environments that exist when the requested one does not", () => {
    const resolution = resolve({
      profiles: { ...PLAIN, ...PRODUCTION },
      requested: "prod",
    });

    expect(codesOf(resolution)).toStrictEqual(["ENVIRONMENT_UNKNOWN"]);
    if (resolution.ok) return;

    // Sorted, so the message is stable and a reader can scan it.
    expect(resolution.issues[0]?.remediation).toContain("production, staging");
    expect(resolution.issues[0]?.message).toContain("prod");
  });

  it.each([
    ["a capitalised name", "Production"],
    ["a leading hyphen", "-prod"],
    ["an underscore", "prod_eu"],
    ["a space", "prod eu"],
    ["thirty-three characters", "a".repeat(33)],
    ["an empty name", ""],
  ])("rejects %s as malformed rather than unknown", (__case__, requested) => {
    const resolution = resolve({ profiles: PLAIN, requested });

    // The distinction is the whole point: a malformed name sends the reader to their typing, an unknown one sends them
    // to their profiles.
    expect(codesOf(resolution)).toStrictEqual(["ENVIRONMENT_NAME_INVALID"]);
  });

  it("checks the name before looking anything up", () => {
    // No profiles, a malformed name: the answer must be about the name, not about the empty project.
    expect(codesOf(resolve({ requested: "Production" }))).toStrictEqual([
      "ENVIRONMENT_NAME_INVALID",
    ]);
  });

  it("refuses to guess when the project declares nothing", () => {
    const resolution = resolve();

    expect(codesOf(resolution)).toStrictEqual(["ENVIRONMENT_NONE_SELECTED"]);
    if (resolution.ok) return;

    expect(resolution.issues[0]?.remediation).toContain(
      "Declare an environment",
    );
  });

  it("refuses to choose between several without a default", () => {
    const resolution = resolve({
      profiles: { ...PLAIN, ...PRODUCTION },
      defaultEnvironment: { origin: "none" },
    });

    expect(codesOf(resolution)).toStrictEqual(["ENVIRONMENT_NONE_SELECTED"]);
    if (resolution.ok) return;

    expect(resolution.issues[0]?.remediation).toContain("production, staging");
  });

  it("allows no environment when the caller does not need one", () => {
    const resolution = resolve({ requireEnvironment: false });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    // `none` is an answer for a caller that only inspects; the name is absent because there is nothing to name.
    expect(resolution.name).toBeUndefined();
    expect(resolution.origin).toBe("none");
    expect(resolution.environment.baseUrlSource).toBe("none");
    expect(resolution.environment.variables).toStrictEqual({});
    expect(resolution.environment.secrets.size).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The target                                                              */
/* -------------------------------------------------------------------------- */

describe("the target", () => {
  const scenario = { profiles: PLAIN, defaultEnvironment: STAGING_DEFAULT };

  it("takes the flag above everything", () => {
    const environment = environmentOf(
      resolve({
        ...scenario,
        baseUrlFlag: "https://from-flag.example.test",
        ambient: {
          [BASE_URL_ENVIRONMENT_VARIABLE]: "https://from-env.example.test",
        },
      }),
    );

    expect(environment.baseUrl).toBe("https://from-flag.example.test");
    expect(environment.baseUrlSource).toBe("flag");
  });

  it("takes the environment variable above the profile", () => {
    const environment = environmentOf(
      resolve({
        ...scenario,
        ambient: {
          [BASE_URL_ENVIRONMENT_VARIABLE]: "https://from-env.example.test",
        },
      }),
    );

    expect(environment.baseUrl).toBe("https://from-env.example.test");
    expect(environment.baseUrlSource).toBe("environment");
  });

  it("takes the profile when nothing overrides it", () => {
    const environment = environmentOf(resolve(scenario));

    expect(environment.baseUrl).toBe("https://staging.example.test");
    expect(environment.baseUrlSource).toBe("configuration");
  });

  it("reports no target at all when nothing supplies one", () => {
    const environment = environmentOf(
      resolve({
        profiles: { staging: { variables: { A: "1" } } },
        defaultEnvironment: STAGING_DEFAULT,
      }),
    );

    // Absent, not empty, and not `undefined`: under `exactOptionalPropertyTypes` those are different, and only one of
    // them is expressible. The `in` check is the assertion a truthiness test would silently pass for both.
    expect("baseUrl" in environment).toBe(false);
    expect(environment.baseUrlSource).toBe("none");
  });

  it("treats an empty override variable as absent", () => {
    const environment = environmentOf(
      resolve({
        ...scenario,
        ambient: { [BASE_URL_ENVIRONMENT_VARIABLE]: "" },
      }),
    );

    // A shell passing on a blank is not an instruction to use nothing — and an empty value is not an unusable one.
    expect(environment.baseUrl).toBe("https://staging.example.test");
    expect(environment.baseUrlSource).toBe("configuration");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The override is not a bypass                                            */
/* -------------------------------------------------------------------------- */

describe("an override that is not a usable target", () => {
  const scenario = { profiles: PLAIN, defaultEnvironment: STAGING_DEFAULT };

  it.each([
    ["a credential in the URL", "https://user:pass@host.example.test"],
    ["no scheme", "staging.example.test"],
    ["a relative address", "/api"],
    ["a scheme a run cannot use", "ftp://host.example.test"],
  ])("rejects %s from the environment variable", (__case__, value) => {
    // Refused rather than ignored. The shared precedence resolver would treat an unparseable value as absent and fall
    // back to the profile — right for a log level, and for a target it means a run pointed somewhere the operator did
    // not ask for.
    expect(() =>
      resolve({
        ...scenario,
        ambient: { [BASE_URL_ENVIRONMENT_VARIABLE]: value },
      }),
    ).toThrow(InvalidArgumentError);
  });

  it("rejects the same value from the flag", () => {
    expect(() =>
      resolve({
        ...scenario,
        baseUrlFlag: "https://user:pass@host.example.test",
      }),
    ).toThrow(InvalidArgumentError);
  });

  it("names the source and never the value it was given", () => {
    const error = thrownBy(() =>
      resolve({
        ...scenario,
        ambient: {
          [BASE_URL_ENVIRONMENT_VARIABLE]:
            "https://user:secret@host.example.test",
        },
      }),
    );

    expect(error).toBeInstanceOf(InvalidArgumentError);

    // Narrowing without an `expect` inside the branch, so the assertions below are unconditional.
    if (!(error instanceof InvalidArgumentError)) {
      throw new Error("the override was not refused with an argument error");
    }

    // The variable is configuration and may be printed; the value could be a credential and may not.
    expect(error.message).toContain(BASE_URL_ENVIRONMENT_VARIABLE);
    expect(error.message).not.toContain(
      "https://user:secret@host.example.test",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The variables                                                           */
/* -------------------------------------------------------------------------- */

describe("the variables", () => {
  const scenario = { profiles: PLAIN, defaultEnvironment: STAGING_DEFAULT };

  it("are handed over exactly as the profile wrote them", () => {
    const environment = environmentOf(
      resolve({
        profiles: {
          staging: {
            variables: {
              API_URL: "https://api.staging.example.test",
              REPORT_DIRECTORY: "results/elsewhere",
              LOOKS_LIKE_A_REFERENCE: "not: a reference",
            },
          },
        },
        defaultEnvironment: STAGING_DEFAULT,
      }),
    );

    // Nothing here guesses that `REPORT_DIRECTORY` "looks like a path" and rewrites it against the project root. A
    // variable is opaque text; a heuristic that rewrote some would break the one it guessed wrong about, silently.
    expect(environment.variables).toStrictEqual({
      API_URL: "https://api.staging.example.test",
      REPORT_DIRECTORY: "results/elsewhere",
      LOOKS_LIKE_A_REFERENCE: "not: a reference",
    });
  });

  it("are frozen", () => {
    const environment = environmentOf(resolve(scenario));

    expect(
      Reflect.set(environment.variables, "API_URL", "https://elsewhere.test"),
    ).toBe(false);
    expect(environment.variables["API_URL"]).toBe(
      "https://api.staging.example.test",
    );
  });

  it("do not pick up unrelated ambient values", () => {
    const environment = environmentOf(
      resolve({
        ...scenario,
        ambient: { UNRELATED: "value", QAT_LOG_LEVEL: "debug" },
      }),
    );

    // The ambient map is read by name, never enumerated: a project cannot gain a variable from the machine it runs on.
    expect(Object.keys(environment.variables)).toStrictEqual(["API_URL"]);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. The secrets                                                             */
/* -------------------------------------------------------------------------- */

describe("the secrets", () => {
  const scenario = {
    profiles: WITH_SECRET,
    defaultEnvironment: STAGING_DEFAULT,
  };

  it("are resolved from the variable the profile names", () => {
    const environment = environmentOf(
      resolve({ ...scenario, ambient: { QAT_STAGING_TOKEN: "a-real-token" } }),
    );

    expect(environment.secrets.has("API_TOKEN")).toBe(true);
    expect(environment.secrets.size).toBe(1);
    expect(environment.secrets.entriesForFramework()).toStrictEqual([
      ["API_TOKEN", "a-real-token"],
    ]);
  });

  it("report an unresolved secret by its variable, never by a value", () => {
    const resolution = resolve(scenario);

    expect(codesOf(resolution)).toStrictEqual(["SECRET_UNRESOLVED"]);
    if (resolution.ok) return;

    const issue = resolution.issues[0];
    // The variable is configuration and may be printed. There is no value to print, which is why this message can be
    // trusted in a log.
    expect(issue?.message).toContain("QAT_STAGING_TOKEN");
    expect(issue?.message).toContain("API_TOKEN");
    expect(issue?.remediation).toContain("QAT_STAGING_TOKEN");
  });

  it("fail the whole resolution, not just the missing field", () => {
    // A target was supplied explicitly, so the resolution could have produced a usable value without the token. It does
    // not: a run that authenticated as nobody would produce results nobody can trust, and a partial environment is not a
    // result.
    const resolution = resolve({
      ...scenario,
      baseUrlFlag: "https://from-flag.example.test",
    });

    expect(resolution.ok).toBe(false);
    expect("environment" in resolution).toBe(false);
  });

  it("report every unresolved secret in one pass", () => {
    const resolution = resolve({
      profiles: {
        staging: {
          secrets: {
            API_TOKEN: { from: "environment", name: "MISSING_ONE" },
            OTHER_TOKEN: { from: "environment", name: "MISSING_TWO" },
          },
        },
      },
      defaultEnvironment: STAGING_DEFAULT,
    });

    // Three missing variables should take one command to discover, not three.
    expect(codesOf(resolution)).toStrictEqual([
      "SECRET_UNRESOLVED",
      "SECRET_UNRESOLVED",
    ]);
  });

  it("resolve a secret that is set to an empty value", () => {
    const environment = environmentOf(
      resolve({ ...scenario, ambient: { QAT_STAGING_TOKEN: "" } }),
    );

    // Documented limitation, pinned so it is a decision: an empty value is a value somebody set. A run that needs a
    // token and gets "" fails at the far end with an authentication error. A stricter rule is defensible and is not the
    // rule today.
    expect(environment.secrets.has("API_TOKEN")).toBe(true);
  });

  it("cannot be read by serialising the value that carries them", () => {
    const resolution = resolve({
      ...scenario,
      ambient: { QAT_STAGING_TOKEN: "a-real-token" },
    });

    const serialised = JSON.stringify(resolution);
    const printed = String(environmentOf(resolution).secrets);

    // The accident this container exists to survive: an object with secrets inside it reaching a log line.
    expect(serialised).toContain("[redacted]");
    expect(serialised).not.toContain("a-real-token");
    // `toString` says how many it holds, without brackets — a different rendering with the same guarantee.
    expect(printed).toContain("redacted");
    expect(printed).not.toContain("a-real-token");
  });
});

/* -------------------------------------------------------------------------- */
/* 6. The shape of the answer                                                 */
/* -------------------------------------------------------------------------- */

describe("the result", () => {
  const scenario = { profiles: PLAIN, defaultEnvironment: STAGING_DEFAULT };

  it("carries the selection on the result, not inside the value", () => {
    const resolution = resolve(scenario);
    const environment = environmentOf(resolution);

    // `ExecutionRequest.environment` already carries the identifier; a second field holding the same string is how a
    // run recorded under one name ends up targeting another.
    expect("name" in environment).toBe(false);
    expect("origin" in environment).toBe(false);
  });

  it("carries nothing when it fails", () => {
    const resolution = resolve({ profiles: PLAIN, requested: "nowhere" });

    expect(resolution.ok).toBe(false);
    expect("environment" in resolution).toBe(false);
  });

  it("freezes the value it returns", () => {
    const environment = environmentOf(resolve(scenario));

    expect(Object.isFrozen(environment)).toBe(true);
    expect(Reflect.set(environment, "baseUrl", "https://elsewhere.test")).toBe(
      false,
    );
  });

  it("does not modify the profiles it was given", () => {
    const profiles: EnvironmentProfiles = structuredClone(PLAIN);
    const before = structuredClone(profiles);

    resolve({ profiles, defaultEnvironment: STAGING_DEFAULT });

    expect(profiles).toStrictEqual(before);
  });

  it("is deterministic", () => {
    const first = environmentOf(resolve(scenario));
    const second = environmentOf(resolve(scenario));

    expect(second.baseUrl).toBe(first.baseUrl);
    expect(second.baseUrlSource).toBe(first.baseUrlSource);
    expect(second.variables).toStrictEqual(first.variables);
    expect(second.secrets.entriesForFramework()).toStrictEqual(
      first.secrets.entriesForFramework(),
    );
  });

  it("is synchronous", () => {
    // Resolution reads no file and starts no process. A promise here would announce work that never happens, and callers
    // would begin awaiting something that resolves immediately.
    expect(resolve(scenario)).not.toBeInstanceOf(Promise);
  });
});
