/**
 * The defaulting service, tested against the decisions it makes rather than the mechanics it uses.
 *
 * Four properties carry the whole module, and each has its own group below:
 *
 * - **Omission is the only trigger.** `undefined` means "not supplied". `false`, `0` and `""` are values somebody
 *   typed, and the single most common defaulting bug is a truthiness test that erases them.
 * - **A malformed value is not a missing one.** `"output": "reports"` and `"reports": 42` are validation's problem;
 *   replacing them here would delete the error the reader most needs to see.
 * - **The input is never touched.** The returned document is a frozen copy, so the consumers that share it cannot
 *   diverge, and running the service twice changes nothing.
 * - **The environment is derived, never guessed.** Three narrowings, in order, and then an explicit "none".
 *
 * The documents below are written as plain JSON, which is how a malformed one reaches this stage: the loader hands over
 * whatever `JSON.parse` produced. No cast is needed to express that, and the absence of one is itself the point — the
 * document type on this service describes which fields may be filled, not what they contain, so a test can hand it a
 * value no schema would accept and still be type-correct.
 */
import { describe, expect, it } from "vitest";

import type { DefaultableConfiguration } from "~/config/resolver/contracts.js";
import {
  applyDefaults,
  isPlainObject,
  selectDefaultEnvironment,
} from "~/config/resolver/defaulting.js";
import {
  CONFIGURATION_DEFAULTS,
  PREFERRED_ENVIRONMENT_KEY,
} from "~/config/resolver/defaults.js";
import { OUTPUT_DEFAULTS } from "~/config/schema/config.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Read a dotted path out of a value, without narrowing anything. */
function readDotted(source: unknown, path: string): unknown {
  let current: unknown = source;

  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

/**
 * Apply defaults to a document written as plain JSON.
 *
 * No assertion: the document view accepts a plain record because it never reads a value, only decides whether to fill
 * one. A test that had to cast here would be testing a stricter contract than the service offers — and the malformed
 * cases below are exactly the ones a strict view would not let us write.
 */
function apply(document: Record<string, unknown>): DefaultableConfiguration {
  return applyDefaults(document);
}

/** Narrow to an object, or fail with a message that names what was wrong. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `expected an object, received ${value === null ? "null" : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

const REQUIRED = { version: 1, framework: "cypress" } as const;

/* -------------------------------------------------------------------------- */
/* Omission is the only trigger                                               */
/* -------------------------------------------------------------------------- */

describe("a document that omits fields", () => {
  it("fills the environment map and the output block, and nothing else", () => {
    const result = apply(REQUIRED);

    // The two groups the schema leaves open, and the only two this service may introduce.
    expect(readDotted(result, "environments")).toStrictEqual({});
    expect(readDotted(result, "output")).toStrictEqual(OUTPUT_DEFAULTS);
  });

  it("adds no field the schema does not declare", () => {
    const result = apply(REQUIRED);

    // A key that is not in this list was invented by the service, which is how defaults start failing validation on
    // fields the reader never wrote.
    expect(Object.keys(result).sort()).toStrictEqual([
      "environments",
      "framework",
      "output",
      "version",
    ]);
  });

  it("takes the defaulted values from the schema, not from a second literal", () => {
    const result = apply(REQUIRED);

    expect(readDotted(result, "output.reports")).toBe(OUTPUT_DEFAULTS.reports);
    expect(readDotted(result, "output.evidence")).toBe(
      OUTPUT_DEFAULTS.evidence,
    );
  });

  it("fills only the missing half of a partial group", () => {
    const result = apply({
      ...REQUIRED,
      output: { reports: "artifacts/reports" },
    });

    expect(readDotted(result, "output.reports")).toBe("artifacts/reports");
    expect(readDotted(result, "output.evidence")).toBe(
      OUTPUT_DEFAULTS.evidence,
    );
  });

  it("fills a wholly empty group", () => {
    const result = apply({ ...REQUIRED, output: {} });

    expect(readDotted(result, "output")).toStrictEqual(OUTPUT_DEFAULTS);
  });

  it("fills a group whose child is explicitly undefined", () => {
    const result = apply({ ...REQUIRED, output: { reports: undefined } });

    // `JSON.parse` cannot produce `undefined`, but a caller merging overrides can, and the answer must be the same as
    // for an absent key.
    expect(readDotted(result, "output.reports")).toBe(OUTPUT_DEFAULTS.reports);
  });

  it("uses a table it is given instead of the production one", () => {
    const result = applyDefaults(
      {},
      {
        environments: {},
        output: { reports: "custom/reports", evidence: "custom/evidence" },
      },
    );

    expect(readDotted(result, "output.reports")).toBe("custom/reports");
  });

  it("invents nothing a supplied table does not provide", () => {
    const result = applyDefaults({}, { environments: {} });

    // An empty group rather than a guess: the service fills from its table and has no opinion of its own. A caller that
    // passes a table without output gets a document without output, which validation then reports against the field.
    expect(readDotted(result, "output")).toStrictEqual({});
    expect(readDotted(result, "output.reports")).toBeUndefined();
  });
});

describe("a document that supplies values", () => {
  it("keeps every value it was given", () => {
    const result = apply({
      ...REQUIRED,
      defaultEnvironment: "staging",
      environments: { staging: { API_URL: "https://staging.example.test" } },
      output: { reports: "out/reports", evidence: "out/evidence" },
    });

    expect(readDotted(result, "defaultEnvironment")).toBe("staging");
    expect(readDotted(result, "environments.staging.API_URL")).toBe(
      "https://staging.example.test",
    );
    expect(readDotted(result, "output.reports")).toBe("out/reports");
    expect(readDotted(result, "output.evidence")).toBe("out/evidence");
  });

  it("does not add default variables to a declared environment map", () => {
    const result = apply({
      ...REQUIRED,
      environments: { staging: { A: "1" } },
    });

    // A user's map is taken as written: QAT has no business adding variables nobody declared.
    expect(readDotted(result, "environments")).toStrictEqual({
      staging: { A: "1" },
    });
  });

  it.each([
    ["an empty string", { reports: "" }, ""],
    ["zero", { reports: 0 }, 0],
    ["false", { reports: false }, false],
    ["null", { reports: null }, null],
    ["an empty list", { reports: [] }, []],
  ])(
    "preserves %s rather than defaulting over it",
    (__case__, output, expected) => {
      const result = apply({ ...REQUIRED, output });

      // The truthiness trap, one case per falsy value. `||` would replace every one of these; `=== undefined` replaces
      // none of them, and the difference is whether a deliberate choice survives a merge.
      expect(readDotted(result, "output.reports")).toStrictEqual(expected);
    },
  );

  it("preserves an unknown key so the schema can name it", () => {
    const result = apply({ ...REQUIRED, logging: { level: "debug" } });

    // Dropping it here would turn a clear "unknown field" diagnostic into a silent behaviour difference.
    expect(readDotted(result, "logging")).toStrictEqual({ level: "debug" });
  });
});

/* -------------------------------------------------------------------------- */
/* A malformed value is not a missing one                                     */
/* -------------------------------------------------------------------------- */

describe("a document with a malformed group", () => {
  it.each([
    ["a string", "out"],
    ["a list", ["out"]],
    ["a number", 42],
    ["null", null],
  ])("returns %s untouched", (__case__, output) => {
    const result = apply({ ...REQUIRED, output });

    // Validation reports the group's shape; this service must not repair it, or the error the reader needs disappears
    // behind a plausible default.
    expect(readDotted(result, "output")).toStrictEqual(output);
  });

  it("returns a malformed environment map untouched", () => {
    const result = apply({ ...REQUIRED, environments: "staging" });

    expect(readDotted(result, "environments")).toBe("staging");
  });

  it("returns an exotic object untouched", () => {
    const exotic = new Map([["staging", { A: "1" }]]);
    const result = apply({ ...REQUIRED, environments: exotic });

    // A `Map`, a `Date` or a class instance spread into `{}` and lose their contents, so the prototype check refuses to
    // treat them as documents. Identity is preserved: the value is passed through, not rebuilt.
    expect(readDotted(result, "environments")).toBe(exotic);
  });
});

/* -------------------------------------------------------------------------- */
/* The input is never touched                                                 */
/* -------------------------------------------------------------------------- */

describe("the returned document", () => {
  it("does not alias the shared defaults", () => {
    const result = apply(REQUIRED);

    // A copy, not the table itself. Aliasing would let a consumer editing this document change the defaults for every
    // later resolution in the process.
    expect(readDotted(result, "output")).not.toBe(
      readDotted(CONFIGURATION_DEFAULTS, "output"),
    );
    expect(readDotted(result, "environments")).not.toBe(
      readDotted(CONFIGURATION_DEFAULTS, "environments"),
    );
  });

  it("is frozen at depth", () => {
    const result = apply(REQUIRED);
    const output = asRecord(readDotted(result, "output"));

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Reflect.set(output, "reports", "elsewhere")).toBe(false);
    expect(readDotted(result, "output.reports")).toBe(OUTPUT_DEFAULTS.reports);
  });

  it("leaves the document it was given untouched", () => {
    const document = {
      ...REQUIRED,
      output: { reports: "out/reports" },
      environments: { staging: { A: "1" } },
    };
    const before = structuredClone(document);

    applyDefaults(document);

    expect(document).toStrictEqual(before);
  });

  it("is idempotent", () => {
    const once = apply({ ...REQUIRED, output: { reports: "out/reports" } });
    const twice = applyDefaults(once);

    // After one pass every defaultable key is defined, so a second pass is a no-op. The schema applies its own
    // defaults before this stage ever runs, which is why that has to be true.
    expect(twice).toStrictEqual(once);
  });

  it("is deterministic", () => {
    expect(apply(REQUIRED)).toStrictEqual(apply(REQUIRED));
  });

  it("is synchronous", () => {
    // Resolution is a pure function of a document and a table. A promise here would announce I/O that never happens.
    expect(apply(REQUIRED)).not.toBeInstanceOf(Promise);
  });
});

/* -------------------------------------------------------------------------- */
/* The environment is derived, never guessed                                  */
/* -------------------------------------------------------------------------- */

describe("which environment a run targets", () => {
  it("uses the environment the document names", () => {
    expect(
      selectDefaultEnvironment({
        defaultEnvironment: "staging",
        environments: { default: {}, staging: {} },
      }),
    ).toStrictEqual({ origin: "configured", name: "staging" });
  });

  it("trims the name it was given", () => {
    // The value reached a schema that permits no padding, so anything left here is whitespace a reader cannot see in a
    // diff. Trimming it beats reporting an environment that does not exist.
    expect(
      selectDefaultEnvironment({ defaultEnvironment: "  staging  " }),
    ).toStrictEqual({
      origin: "configured",
      name: "staging",
    });
  });

  it("treats a blank name as absent and derives instead", () => {
    expect(
      selectDefaultEnvironment({
        defaultEnvironment: "   ",
        environments: { only: {} },
      }),
    ).toStrictEqual({ origin: "sole", name: "only" });
  });

  it("prefers the environment called default", () => {
    expect(
      selectDefaultEnvironment({
        environments: { production: {}, default: {} },
      }),
    ).toStrictEqual({ origin: "declared", name: PREFERRED_ENVIRONMENT_KEY });
  });

  it("uses the only environment declared", () => {
    expect(
      selectDefaultEnvironment({ environments: { only: {} } }),
    ).toStrictEqual({
      origin: "sole",
      name: "only",
    });
  });

  it("refuses to choose between several", () => {
    // The most expensive failure available: a suite that passes against the wrong target. An explicit "none" makes the
    // run say so rather than pick.
    expect(
      selectDefaultEnvironment({ environments: { a: {}, b: {} } }),
    ).toStrictEqual({
      origin: "none",
    });
  });

  it.each([
    ["a document with no environments", {}],
    ["an empty environment map", { environments: {} }],
    ["a malformed environment map", { environments: "staging" }],
  ])("reports none for %s", (__case__, document) => {
    expect(selectDefaultEnvironment(document)).toStrictEqual({
      origin: "none",
    });
  });

  it("does not consult the defaults table", () => {
    // The derivation reads the document only: a project that declares nothing has no target, whatever the table says.
    expect(selectDefaultEnvironment({})).toStrictEqual({ origin: "none" });
  });
});

/* -------------------------------------------------------------------------- */
/* The shape predicate                                                        */
/* -------------------------------------------------------------------------- */

describe("what counts as a settings group", () => {
  it.each([
    ["an object literal", {}],
    ["a null-prototype object", Object.create(null)],
  ])("accepts %s", (__case__, value) => {
    expect(isPlainObject(value)).toBe(true);
  });

  it.each([
    ["null", null],
    ["a list", []],
    ["a string", "staging"],
    ["a number", 42],
    ["a map", new Map()],
    ["a date", new Date(0)],
    ["a class instance", new (class Settings {})()],
    ["an object with a custom prototype", Object.create({ reports: "x" })],
  ])("refuses %s", (__case__, value) => {
    // Anything that would lose its contents in a spread is not a group this service can reason about. Treating it as
    // malformed and letting validation say so is more honest than quietly rebuilding it as `{}`.
    expect(isPlainObject(value)).toBe(false);
  });
});
