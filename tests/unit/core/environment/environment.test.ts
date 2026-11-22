import { describe, expect, it } from "vitest";

import {
  describeEnvironment,
  isSensitiveVariable,
  readVariable,
  REDACTED_PLACEHOLDER,
  requireVariable,
  resolveValue,
  ValueSource,
  variableOrDefault,
  VariableState,
  type EnvironmentSource,
} from "~/core/environment/index.js";
import { ErrorCode, InvalidConfigurationError } from "~/core/errors/index.js";

/**
 * Every test passes an explicit source. Nothing reads `process.env`, so the suite is unaffected by
 * whatever happens to be set on the machine running it — and a test that set a variable to prove a
 * point could not leak into a neighbouring one.
 */
const source: EnvironmentSource = {
  PRESENT: "value",
  EMPTY: "",
  SPACES: "   ",
  QAT_LOG_LEVEL: "debug",
  GITHUB_TOKEN: "ghp_example",
  DB_PASSWORD: "hunter2-example",
  API_KEY: "key-example",
  PWD: "/home/example",
  PATH: "/usr/bin",
  KEYBOARD_LAYOUT: "uk",
};

describe("reading variables", () => {
  it("reports a value that is present", () => {
    expect(readVariable("PRESENT", source)).toStrictEqual({
      name: "PRESENT",
      state: VariableState.Present,
      value: "value",
      sensitive: false,
    });
  });

  it("distinguishes empty from missing", () => {
    expect(readVariable("EMPTY", source).state).toBe(VariableState.Empty);
    expect(readVariable("ABSENT", source).state).toBe(VariableState.Missing);
  });

  it("treats whitespace as a present value rather than trimming it", () => {
    // Trimming would change what the caller receives, and a deliberate space is not nothing.
    expect(readVariable("SPACES", source)).toMatchObject({
      state: VariableState.Present,
      value: "   ",
    });
  });

  it("marks a sensitive name without reading its value into the label", () => {
    expect(readVariable("GITHUB_TOKEN", source).sensitive).toBe(true);
  });

  it("rejects a name that could never be a variable", () => {
    expect(() => readVariable("", source)).toThrow(TypeError);
    expect(() => readVariable("A=B", source)).toThrow(TypeError);
  });
});

describe("requiring a variable", () => {
  it("returns the value when set", () => {
    expect(requireVariable("PRESENT", source)).toBe("value");
  });

  it("raises a configuration error naming the variable and not its value", () => {
    const error = (() => {
      try {
        requireVariable("DB_PASSWORD_MISSING", source);
        return undefined;
      } catch (caught: unknown) {
        return caught as InvalidConfigurationError;
      }
    })();

    expect(error).toBeInstanceOf(InvalidConfigurationError);
    expect(error?.code).toBe(ErrorCode.configurationInvalid);
    expect(error?.message).toContain("DB_PASSWORD_MISSING");
    expect(error?.message).not.toContain("hunter2");
    expect(error?.remediation).toContain("DB_PASSWORD_MISSING");
  });

  it("reports empty separately from missing", () => {
    expect(() => requireVariable("EMPTY", source)).toThrow(/empty/);
    expect(() => requireVariable("ABSENT", source)).toThrow(/not set/);
  });
});

describe("defaults", () => {
  it("prefers a present value", () => {
    expect(variableOrDefault("PRESENT", "fallback", source)).toBe("value");
  });

  it("falls back for both empty and missing", () => {
    expect(variableOrDefault("EMPTY", "fallback", source)).toBe("fallback");
    expect(variableOrDefault("ABSENT", "fallback", source)).toBe("fallback");
  });
});

describe("sensitive classification", () => {
  it.each([
    "GITHUB_TOKEN",
    "DB_PASSWORD",
    "API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "SESSION_ID",
  ])("treats %s as sensitive", (name) => {
    expect(isSensitiveVariable(name)).toBe(true);
  });

  it.each(["PATH", "PWD", "KEYBOARD_LAYOUT", "MONKEY", "NODE_ENV", "CI"])(
    "treats %s as ordinary",
    (name) => {
      // Matched on whole words: `KEY` catches `API_KEY` without catching `KEYBOARD` or `MONKEY`,
      // and `PWD` is a working directory rather than a password.
      expect(isSensitiveVariable(name)).toBe(false);
    },
  );
});

describe("diagnostic snapshots", () => {
  it("redacts a sensitive value and shows an ordinary one", () => {
    const entries = describeEnvironment({
      names: ["GITHUB_TOKEN", "PATH"],
      source,
    });

    expect(entries).toStrictEqual([
      {
        name: "GITHUB_TOKEN",
        state: VariableState.Present,
        displayValue: REDACTED_PLACEHOLDER,
      },
      { name: "PATH", state: VariableState.Present, displayValue: "/usr/bin" },
    ]);
  });

  it("lists only the default prefix and never the whole environment", () => {
    const entries = describeEnvironment({ source });
    const names = entries.map((entry) => entry.name);

    // The environment contains GITHUB_TOKEN and DB_PASSWORD; neither may appear here.
    expect(names).toStrictEqual(["QAT_LOG_LEVEL"]);
    expect(names).not.toContain("GITHUB_TOKEN");
  });

  it("reports a missing variable without inventing a value", () => {
    expect(describeEnvironment({ names: ["ABSENT"], source })).toStrictEqual([
      { name: "ABSENT", state: VariableState.Missing, displayValue: undefined },
    ]);
  });
});

describe("precedence", () => {
  const parse = (raw: string): number => Number.parseInt(raw, 10);

  it("prefers a flag over everything else", () => {
    expect(
      resolveValue(
        {
          flag: 1,
          environment: { name: "QAT_LOG_LEVEL", parse },
          configuration: 3,
          fallback: 4,
        },
        source,
      ),
    ).toStrictEqual({ value: 1, source: ValueSource.Flag });
  });

  it("prefers the environment over the configuration file", () => {
    const configured: EnvironmentSource = { ...source, QAT_LEVEL: "2" };

    expect(
      resolveValue(
        {
          environment: { name: "QAT_LEVEL", parse },
          configuration: 3,
          fallback: 4,
        },
        configured,
      ),
    ).toStrictEqual({ value: 2, source: ValueSource.Environment });
  });

  it("prefers the configuration file over a default", () => {
    expect(
      resolveValue({ configuration: 3, fallback: 4 }, source),
    ).toStrictEqual({
      value: 3,
      source: ValueSource.Configuration,
    });
  });

  it("reports the default as the source when nothing else supplied a value", () => {
    expect(resolveValue({ fallback: 4 }, source)).toStrictEqual({
      value: 4,
      source: ValueSource.Default,
    });
  });

  it("returns nothing when no candidate supplied a value", () => {
    expect(resolveValue<number>({}, source)).toBeUndefined();
  });

  it("treats an empty variable as absent and falls through to the configuration", () => {
    const blank: EnvironmentSource = { ...source, QAT_LEVEL: "" };

    expect(
      resolveValue(
        { environment: { name: "QAT_LEVEL", parse }, configuration: 3 },
        blank,
      ),
    ).toStrictEqual({ value: 3, source: ValueSource.Configuration });
  });

  it("propagates a parse failure rather than silently ignoring the value", () => {
    const invalid: EnvironmentSource = { ...source, QAT_LEVEL: "not-a-number" };
    const strictParse = (raw: string): number => {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed)) throw new TypeError(`${raw} is not a number.`);
      return parsed;
    };

    expect(() =>
      resolveValue(
        { environment: { name: "QAT_LEVEL", parse: strictParse } },
        invalid,
      ),
    ).toThrow(TypeError);
  });

  it("falls back when the variable is missing", () => {
    expect(
      resolveValue(
        { environment: { name: "ABSENT", parse }, fallback: 4 },
        source,
      ),
    ).toStrictEqual({ value: 4, source: ValueSource.Default });
  });

  it("does not touch the real process environment", () => {
    const before = process.env["QAT_LEVEL"];

    resolveValue(
      { environment: { name: "QAT_LEVEL", parse }, fallback: 1 },
      source,
    );

    expect(process.env["QAT_LEVEL"]).toBe(before);
  });
});
