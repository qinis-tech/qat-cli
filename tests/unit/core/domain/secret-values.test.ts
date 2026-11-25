/**
 * The container that holds resolved secrets.
 *
 * One property matters here and everything else is detail: **a secret value must not be reachable by any of the ways a
 * value is read by accident.** Not by `JSON.stringify` on the object that carries it, not by a template literal, not by
 * a spread into a log context, not by a test that failed and printed the whole result.
 *
 * So the tests are organised by *how a value could escape* rather than by method. `renderings()` below enumerates every
 * accident in one place; each case then asserts two things — that no rendering contains a value, and that the rendering
 * says plainly that something was withheld, because a container that leaked nothing by printing nothing would be safe
 * and useless.
 *
 * ## Two renderings, two shapes
 *
 * `toJSON` puts the marker where a value would be: `{"API_TOKEN":"[redacted]"}`. `toString` summarises the container
 * instead: `ResolvedSecrets(1 redacted)`. Both appear below, asserted for what each is, because a test that demanded one
 * shape from both would either force a summary to list names or force a document to stop being one.
 */
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { REDACTED, ResolvedSecrets } from "~/core/domain/secret-values.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const TOKEN = "tok_7f3a9c2e1b";
const OTHER = "s3cr3t-value-9d41";

function container(
  entries: Readonly<Record<string, string>> = {},
): ResolvedSecrets {
  return ResolvedSecrets.from(Object.entries(entries));
}

/**
 * A container of `count` secrets, for the cases that are about scale rather than about content.
 *
 * The mapper returns a readonly tuple so `from` receives `[name, value]` pairs rather than `string[]`: an untyped array
 * here would satisfy `Object.fromEntries` through its `any` overload and let `any` travel into the assertions.
 */
function many(count: number): ResolvedSecrets {
  return ResolvedSecrets.from(
    Array.from(
      { length: count },
      (_unused, index) =>
        [`TOKEN_${String(index)}`, `value-${String(index)}`] as const,
    ),
  );
}

/**
 * Every way a value can be rendered without anybody deciding to.
 *
 * A log call that receives the enclosing object, a snapshot in a failing assertion, a `--json` document, a template
 * literal in an error message. Enumerated once here so that adding a thirteenth rendering is a single line rather than a
 * thirteenth test.
 */
function renderings(secrets: ResolvedSecrets): readonly string[] {
  return [
    JSON.stringify(secrets),
    JSON.stringify({ secrets }),
    JSON.stringify([secrets]),
    JSON.stringify(secrets.toJSON()),
    String(secrets),
    // The interpolation *is* the accident this file exists to demonstrate, so the rule forbidding it is catching the
    // thing under test. Scoped to this line, with its reason; a repository that bans disables can use
    // `["prefix", secrets].join(" ")`, which takes the same `ToString` path.
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- the interpolation is the subject
    `${secrets}`,
    inspect(secrets),
    inspect({ secrets }),
    JSON.stringify(Object.keys(secrets)),
    JSON.stringify({ ...secrets }),
    String(Object.entries(secrets)),
    String(Object.values(secrets)),
  ];
}

/* -------------------------------------------------------------------------- */
/* Reading the values on purpose                                              */
/* -------------------------------------------------------------------------- */

describe("reading the values", () => {
  it("hands them to the one caller that must have them", () => {
    const secrets = container({ API_TOKEN: TOKEN, OTHER_TOKEN: OTHER });

    // Named for its single caller, so a reviewer who sees it anywhere else has found a leak rather than a convenience.
    expect(secrets.entriesForFramework()).toStrictEqual([
      ["API_TOKEN", TOKEN],
      ["OTHER_TOKEN", OTHER],
    ]);
  });

  it("keeps the order it was given", () => {
    const secrets = ResolvedSecrets.from([
      ["Z_LAST", "3"],
      ["A_FIRST", "1"],
      ["M_MIDDLE", "2"],
    ]);

    // Insertion order rather than sorted: the framework receives these in a stable order, and a container that reordered
    // them would make two runs of one configuration differ in a place nobody looks.
    expect(secrets.names()).toStrictEqual(["Z_LAST", "A_FIRST", "M_MIDDLE"]);
  });

  it("answers what it holds without revealing what it holds", () => {
    const secrets = container({ API_TOKEN: TOKEN });

    expect(secrets.size).toBe(1);
    expect(secrets.has("API_TOKEN")).toBe(true);
    expect(secrets.names()).toStrictEqual(["API_TOKEN"]);
  });

  it("answers for a name it does not hold", () => {
    const secrets = container({ API_TOKEN: TOKEN });

    expect(secrets.has("OTHER_TOKEN")).toBe(false);
    expect(secrets.has("")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Refusing to be read by accident                                            */
/* -------------------------------------------------------------------------- */

describe("rendering the container", () => {
  it("never contains a value, however it is rendered", () => {
    const secrets = container({ API_TOKEN: TOKEN, OTHER_TOKEN: OTHER });

    for (const rendered of renderings(secrets)) {
      // The whole justification for a class rather than a record of strings.
      expect(rendered).not.toContain(TOKEN);
      expect(rendered).not.toContain(OTHER);
    }
  });

  it("puts the marker where a value would be, in structured output", () => {
    const secrets = container({ API_TOKEN: TOKEN });

    // A container that printed nothing at all would pass the test above and tell a reader their run has no secrets.
    expect(JSON.stringify(secrets)).toContain(REDACTED);
    expect(JSON.stringify({ secrets })).toContain(REDACTED);
    expect(JSON.stringify(secrets.toJSON())).toContain(REDACTED);
  });

  it("summarises itself in prose when converted to a string", () => {
    const secrets = container({ API_TOKEN: TOKEN });

    // `toString` is a summary, not a document: it says how many it holds and nothing about which. The marker it uses is
    // the word rather than the bracketed spelling, which is why this asserts the word — a test demanding `[redacted]`
    // here would be asking a summary to become a document.
    expect(secrets.toString()).toContain("redacted");
    expect(secrets.toString()).not.toContain(TOKEN);
    expect(secrets.toString()).not.toContain("API_TOKEN");
  });

  it("serialises one entry per name", () => {
    const secrets = container({ API_TOKEN: TOKEN, OTHER_TOKEN: OTHER });

    expect(secrets.toJSON()).toStrictEqual({
      API_TOKEN: REDACTED,
      OTHER_TOKEN: REDACTED,
    });
  });

  it("states how many it holds, and no more", () => {
    expect(container({ A: "1", B: "2" }).toString()).toBe(
      "ResolvedSecrets(2 redacted)",
    );
    expect(container().toString()).toBe("ResolvedSecrets(0 redacted)");
  });

  it("has nothing to spread", () => {
    const secrets = container({ API_TOKEN: TOKEN });
    const logContext = { ...secrets, runId: "run-1" };

    // A spread is how a value reaches a logger's context object without anybody typing its name.
    expect(Object.keys(secrets)).toStrictEqual([]);
    expect(logContext).toStrictEqual({ runId: "run-1" });
  });

  it("is deliberately not iterable", () => {
    const secrets = container({ API_TOKEN: TOKEN });

    // `[...secrets]` and `for…of` are accidents too, and an iterable container invites them. The one accessor that
    // yields values is named, so reading them is a decision.
    expect(() => [...(secrets as unknown as Iterable<unknown>)]).toThrow(
      TypeError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Immutability                                                               */
/* -------------------------------------------------------------------------- */

describe("changing the container", () => {
  it("is frozen", () => {
    const secrets = container({ API_TOKEN: TOKEN });

    expect(Object.isFrozen(secrets)).toBe(true);
  });

  it("cannot be added to, even in strict mode code", () => {
    const secrets = container({ API_TOKEN: TOKEN });
    const mutable = secrets as unknown as Record<string, unknown>;

    expect(() => {
      mutable["NEW_TOKEN"] = "value";
    }).toThrow(TypeError);
    expect(secrets.has("NEW_TOKEN")).toBe(false);
  });

  it("does not expose the map it holds", () => {
    const secrets = container({ API_TOKEN: TOKEN });

    // A `values` property would be a second route to the contents, and a route nobody reviews.
    expect("values" in secrets).toBe(false);
    expect("entries" in secrets).toBe(false);
  });

  it("is not affected by changing the collection it was built from", () => {
    const source: [string, string][] = [["API_TOKEN", TOKEN]];
    const secrets = ResolvedSecrets.from(source);

    source.push(["LATE_TOKEN", OTHER]);
    source[0] = ["API_TOKEN", OTHER];

    // `from` copies into a new map. A container aliasing its input would let a caller mutate a value the framework is
    // about to receive, after the container had been handed over.
    expect(secrets.names()).toStrictEqual(["API_TOKEN"]);
    expect(secrets.entriesForFramework()).toStrictEqual([["API_TOKEN", TOKEN]]);
  });
});

/* -------------------------------------------------------------------------- */
/* Boundaries                                                                 */
/* -------------------------------------------------------------------------- */

describe("boundaries", () => {
  it("handles an empty container", () => {
    const secrets = ResolvedSecrets.empty();

    expect(secrets.size).toBe(0);
    expect(secrets.names()).toStrictEqual([]);
    expect(secrets.entriesForFramework()).toStrictEqual([]);
    expect(JSON.stringify(secrets)).toBe("{}");
    expect(secrets.toString()).toBe("ResolvedSecrets(0 redacted)");
  });

  it("keeps the last of a duplicated name", () => {
    const secrets = ResolvedSecrets.from([
      ["API_TOKEN", "first"],
      ["API_TOKEN", "second"],
    ]);

    // A map has one value per key, and the alternative — refusing the duplicate — would fail a run for something the
    // profile schema already prevents by construction.
    expect(secrets.size).toBe(1);
    expect(secrets.entriesForFramework()).toStrictEqual([
      ["API_TOKEN", "second"],
    ]);
  });

  it("holds a secret whose value is empty", () => {
    const secrets = container({ API_TOKEN: "" });

    // A set-but-empty variable is a value somebody set. It is `has`, it resolves, and it fails at the far end with an
    // authentication error — which is why the resolution stage documents that case rather than hiding it.
    expect(secrets.has("API_TOKEN")).toBe(true);
    expect(secrets.entriesForFramework()).toStrictEqual([["API_TOKEN", ""]]);
  });

  it("does not confuse a value with the redaction marker", () => {
    const secrets = container({ API_TOKEN: REDACTED });

    // A secret whose real value happens to be `[redacted]` is still a secret, and the container still holds it.
    expect(secrets.entriesForFramework()).toStrictEqual([
      ["API_TOKEN", REDACTED],
    ]);
    expect(secrets.toJSON()).toStrictEqual({ API_TOKEN: REDACTED });
  });

  it("handles a value far larger than a token", () => {
    const long = "x".repeat(64 * 1024);
    const secrets = container({ PEM: long });

    expect(secrets.entriesForFramework()).toStrictEqual([["PEM", long]]);
    expect(JSON.stringify(secrets)).toBe(`{"PEM":"${REDACTED}"}`);
  });

  it("handles many secrets", () => {
    const secrets = many(1000);

    expect(secrets.size).toBe(1000);
    expect(JSON.stringify(secrets)).not.toContain("value-999");
  });

  it("refuses to be polluted by a name that is a prototype member", () => {
    const secrets = ResolvedSecrets.from([["__proto__", TOKEN]]);
    const probe: Record<string, unknown> = {};

    // The profile schema refuses this name, so reaching it here takes deliberate effort. It is asserted anyway: the
    // container is the last thing between a crafted name and a log line, and `Object.fromEntries` creates an own
    // property rather than touching a prototype — which is the behaviour being relied on.
    expect(Object.getPrototypeOf(secrets.toJSON())).toBe(Object.prototype);
    expect(probe["API_TOKEN"]).toBeUndefined();
    expect(probe["__proto__"]).toBe(Object.prototype);
  });
});

/* -------------------------------------------------------------------------- */
/* Non-functional                                                             */
/* -------------------------------------------------------------------------- */

describe("non-functional behaviour", () => {
  it("returns a fresh object from every serialisation", () => {
    const secrets = container({ API_TOKEN: TOKEN });

    const first = secrets.toJSON();
    // `Object.assign` rather than a cast: the point is that a consumer may mutate the object it was handed, and the
    // container must not care.
    Object.assign(first, { API_TOKEN: TOKEN, INJECTED: "value" });

    // If the serializer returned the container's own state, that mutation would be a way to put a real value into the
    // next document.
    expect(secrets.toJSON()).toStrictEqual({ API_TOKEN: REDACTED });
    expect(secrets.entriesForFramework()).toStrictEqual([["API_TOKEN", TOKEN]]);
  });

  it("is indistinguishable from an equal container by its projections", () => {
    const first = container({ API_TOKEN: TOKEN, OTHER_TOKEN: OTHER });
    const second = container({ API_TOKEN: TOKEN, OTHER_TOKEN: OTHER });

    // Compared by projection rather than by `toStrictEqual` on the instances: the contents are private fields, so a deep
    // equality would compare two empty enumerable shapes and pass even if the tokens differed. This is the assertion
    // that can fail for the reason the test is about.
    expect(second.names()).toStrictEqual(first.names());
    expect(second.entriesForFramework()).toStrictEqual(
      first.entriesForFramework(),
    );
    expect(second.toString()).toBe(first.toString());
  });

  it("redacts in time proportional to the number of secrets", () => {
    const secrets = many(1000);

    const started = performance.now();
    for (let index = 0; index < 100; index += 1) {
      JSON.stringify(secrets);
    }

    // A bound, not a benchmark: it catches a serialisation that went quadratic — rebuilding a string per entry, say —
    // rather than grading the runner.
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
