/**
 * The document a newly initialised project receives.
 *
 * Three things are asserted here, and the third is the one that keeps the other two honest:
 *
 * 1. **What it contains** — exactly the two fields that have no default, and nothing else.
 * 2. **That the schema accepts it** — the generator and the schema are two separate statements of what a configuration
 *    is, and this is the only place they are compared.
 * 3. **That the bytes are stable** — a file's contents are a user-facing artefact. Somebody will diff it, review it and
 *    paste it into an issue, so its formatting is asserted rather than left to whichever `JSON.stringify` options a
 *    future edit happens to pick.
 *
 * The serialiser is also tested for what it deliberately does *not* do: it does not validate. A document with an
 * impossible path serialises without complaint, because refusing it is the schema's job and the workflow runs the
 * schema before it writes anything.
 *
 * Fixtures for "a document with more in it" are built by spreading `generateDefaultConfiguration()` rather than by
 * restating `version` and `framework`. The schema types the version as the literal it is, so a hand-written `version`
 * widens to `number` and stops satisfying its own input type — a fixture that fails to compile for a reason unrelated to
 * the behaviour under test.
 */
import { describe, expect, it } from "vitest";

import { OUTPUT_DEFAULTS, qatConfigSchema } from "~/config/schema/config.js";
import {
  SUPPORTED_CONFIG_VERSION,
  type QatConfigInput,
} from "~/config/schema/index.js";
import { Framework } from "~/core/domain/index.js";
import {
  generateDefaultConfiguration,
  serialiseConfiguration,
} from "~/init/generate.js";

/* -------------------------------------------------------------------------- */
/* The document                                                               */
/* -------------------------------------------------------------------------- */

describe("the generated configuration", () => {
  it("returns the input type the schema declares", () => {
    // A compile-time assertion with a runtime body. If the generator stops returning `QatConfigInput` — a lost annotation,
    // a widened property — this line fails to build, here, rather than in whichever test happens to pass the value on.
    const document: QatConfigInput = generateDefaultConfiguration();

    expect(document).toBeDefined();
  });

  it("satisfies the schema", () => {
    // Two independent statements of what a configuration is, compared in one place. If the schema gains a required field
    // or changes its version literal, this is the test that says the generator did not follow.
    expect(
      qatConfigSchema.safeParse(generateDefaultConfiguration()).success,
    ).toBe(true);
  });

  it("contains only the fields that have no default", () => {
    const document = generateDefaultConfiguration();

    // `output`, `environments` and `defaultEnvironment` all have documented defaults. Writing one into a new file would
    // freeze today's default as tomorrow's decision, and there would be no way to tell a setting from a fossil.
    expect(Object.keys(document).sort()).toStrictEqual([
      "framework",
      "version",
    ]);
  });

  it("states the schema version this build reads", () => {
    const document = generateDefaultConfiguration();

    // Asserted against the constant rather than against `1`, so a version bump updates one literal and this test follows.
    expect(document.version).toBe(SUPPORTED_CONFIG_VERSION);
    expect(typeof document.version).toBe("number");
  });

  it("names the framework from the domain's enum rather than a literal", () => {
    // A literal here would keep working after the domain renamed the member, and would then produce a document the
    // schema rejects — a failure that looks like a schema bug.
    expect(generateDefaultConfiguration().framework).toBe(Framework.Cypress);
  });

  it("orders the keys as the file will read", () => {
    // Insertion order is what `JSON.stringify` preserves, so this is the order on disk: version first, because without
    // it nothing else in the file can be interpreted.
    expect(Object.keys(generateDefaultConfiguration())).toStrictEqual([
      "version",
      "framework",
    ]);
  });

  it("is accepted once defaulted, which is the point of writing so little", () => {
    const parsed = qatConfigSchema.safeParse(generateDefaultConfiguration());

    // The generated file is a complete configuration only after the schema fills it. That is the design, not a gap: what
    // the file does not say, the documented defaults do.
    expect(parsed.success && parsed.data.output).toStrictEqual(OUTPUT_DEFAULTS);
    expect(parsed.success && parsed.data.environments).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The bytes                                                                  */
/* -------------------------------------------------------------------------- */

describe("serialising a configuration", () => {
  it("produces the file a reviewer will read", () => {
    // Written out rather than built with the same expression the implementation uses: a test that formatted its own
    // expectation with `JSON.stringify(document, null, 2)` would agree with any spacing, including wrong spacing.
    const expected = `{\n  "version": ${String(SUPPORTED_CONFIG_VERSION)},\n  "framework": "${Framework.Cypress}"\n}\n`;

    expect(serialiseConfiguration(generateDefaultConfiguration())).toBe(
      expected,
    );
  });

  it("writes a number as a number", () => {
    const text = serialiseConfiguration(generateDefaultConfiguration());

    // A quoted version would pass a looser assertion and be rejected by the schema, since the version is a literal and
    // not a string.
    expect(text).toContain(`"version": ${String(SUPPORTED_CONFIG_VERSION)},`);
    expect(text).not.toContain('"version": "');
  });

  it("ends with exactly one newline, and uses no carriage returns", () => {
    const text = serialiseConfiguration(generateDefaultConfiguration());

    // One newline because that is what every other file in a repository ends with, and no `\r` because the bytes must not
    // depend on the platform that produced them — a file is committed once and checked out everywhere.
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).not.toContain("\r");
  });

  it("round-trips through a parser unchanged", () => {
    const document = generateDefaultConfiguration();

    expect(JSON.parse(serialiseConfiguration(document))).toStrictEqual(
      document,
    );
  });

  it("round-trips a document with nested values and awkward characters", () => {
    // Built from the generator so the two fields the schema types as literals are correct by construction. The values
    // added here are deliberately awkward: a quote, a backslash and a URL with query separators, which is where a
    // hand-rolled serialiser would lose information.
    const document: QatConfigInput = {
      ...generateDefaultConfiguration(),
      output: { reports: 'a"b\\c', evidence: "results/evidence" },
      environments: {
        staging: { API_URL: "https://staging.example.test?a=1&b=2" },
      },
    };

    expect(JSON.parse(serialiseConfiguration(document))).toStrictEqual(
      document,
    );
  });

  it("does not validate, because validation is somebody else's job", () => {
    // A path the schema would refuse passes straight through. The serialiser answers "what bytes represent this value",
    // and the workflow runs the schema before it writes — so a refusal here would be a second opinion in the wrong
    // place.
    const document: QatConfigInput = {
      ...generateDefaultConfiguration(),
      output: { reports: "/absolute/and/refused", evidence: "../outside" },
    };

    expect(JSON.parse(serialiseConfiguration(document))).toStrictEqual(
      document,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Non-functional                                                             */
/* -------------------------------------------------------------------------- */

describe("non-functional behaviour", () => {
  it("is deterministic", () => {
    expect(serialiseConfiguration(generateDefaultConfiguration())).toBe(
      serialiseConfiguration(generateDefaultConfiguration()),
    );
  });

  it("returns a new object each time", () => {
    const first = generateDefaultConfiguration();
    const second = generateDefaultConfiguration();

    // Equal but not the same. A shared constant would make every caller an editor of the next caller's document.
    expect(second).toStrictEqual(first);
    expect(second).not.toBe(first);
  });

  it("cannot be poisoned through the object it returned", () => {
    const first = generateDefaultConfiguration() as unknown as Record<
      string,
      unknown
    >;
    first["version"] = 999;

    // The test above proves the reference differs; this proves the consequence — one caller's edit cannot reach the next
    // caller's file.
    expect(generateDefaultConfiguration().version).toBe(
      SUPPORTED_CONFIG_VERSION,
    );
  });

  it("is synchronous and touches nothing", () => {
    // No filesystem, no clock, no working directory: the generator builds a value, and the workflow decides whether it
    // ever becomes a file.
    expect(generateDefaultConfiguration()).not.toBeInstanceOf(Promise);
    expect(
      serialiseConfiguration(generateDefaultConfiguration()),
    ).not.toContain(process.cwd());
  });
});
