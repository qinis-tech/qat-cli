/**
 * The defaults table, tested for the three properties it claims.
 *
 * 1. **One authority.** The values the resolution stage fills are the values the schema applies, so there is no second
 *    answer to "where does output go".
 * 2. **Complete coverage.** Every leaf field the schema defines has a documented rule — a default, a derivation, or an
 *    explicit refusal to default.
 * 3. **Nothing can move it.** The table is frozen at every depth, rendering it is deterministic, and the published
 *    documentation is compared against the same source the runtime reads.
 *
 * Assertions are aggregated rather than asserted one field at a time: a test that fails on the first bad row tells you
 * about one problem when the fixture may have four, and enumerating what is missing is the whole point.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  CONFIGURATION_DEFAULTS,
  DEFAULT_CATALOGUE,
  PREFERRED_ENVIRONMENT_KEY,
  createDefaultsProvider,
  defaultsAsMarkdown,
} from "~/config/resolver/defaults.js";
import { OUTPUT_DEFAULTS } from "~/config/schema/config.js";
import { CONFIG_FIELD_PATHS } from "~/config/schema/index.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Read a dotted path out of an untrusted value, without narrowing anything. */
function readDotted(source: unknown, path: string): unknown {
  let current: unknown = source;

  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

/**
 * Narrow to an object, or fail with a message that names what was wrong.
 *
 * The frozen-table tests need an `object` for `Reflect.set`, and the values they test are reached through `readDotted`,
 * which deliberately returns `unknown`. A cast here would pass `undefined` through and fail much later with a message
 * about `Reflect`.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `expected an object, received ${value === null ? "null" : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

/** Plain-data comparison, so a value and its catalogue copy can be compared without a deep-equal import. */
function plain(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

/**
 * The architecture document, or a failure that says what to do about it.
 *
 * A bare ENOENT is a poor first experience with this suite: the file is expected to exist, and the fix is to paste the
 * rendered table into it.
 */
async function readDefaultsDocument(): Promise<string> {
  try {
    return await readFile(
      new URL(
        "../../../docs/architecture/configuration-defaults.md",
        import.meta.url,
      ),
      "utf8",
    );
  } catch {
    throw new Error(
      "docs/architecture/configuration-defaults.md is missing. " +
        "Render the table with defaultsAsMarkdown() and paste it into that file.",
    );
  }
}

const catalogued = new Set(
  DEFAULT_CATALOGUE.map((descriptor) => descriptor.field),
);

/**
 * Fields the schema declares that are leaves — a path nothing else extends.
 *
 * `output` and `cypress` appear in `CONFIG_FIELD_PATHS` as group names, and a group is not a value anyone can default:
 * defaulting it means defaulting its children, which are listed separately. Deriving the leaves here rather than
 * hardcoding them means the test keeps working when a group gains a child.
 */
const leafFieldPaths = CONFIG_FIELD_PATHS.filter(
  (field) => !CONFIG_FIELD_PATHS.some((other) => other.startsWith(`${field}.`)),
);

/* -------------------------------------------------------------------------- */
/* One authority                                                              */
/* -------------------------------------------------------------------------- */

describe("the defaults the resolution stage applies", () => {
  it("takes the output paths from the schema rather than restating them", () => {
    // The single most valuable assertion in this file. Two literals would pass today and disagree the first time either
    // is edited.
    expect(readDotted(CONFIGURATION_DEFAULTS, "output.reports")).toBe(
      OUTPUT_DEFAULTS.reports,
    );
    expect(readDotted(CONFIGURATION_DEFAULTS, "output.evidence")).toBe(
      OUTPUT_DEFAULTS.evidence,
    );
  });

  it("fills no more than it must", () => {
    // Only the environment map and the output block. Anything else here is a field the schema either requires or
    // refuses to default.
    expect(Object.keys(CONFIGURATION_DEFAULTS).sort()).toEqual([
      "environments",
      "output",
    ]);
  });

  it("leaves the required fields absent", () => {
    // A default for either would reinterpret a file against the wrong rules, or drive a project with a tool it never
    // declared.
    expect(readDotted(CONFIGURATION_DEFAULTS, "version")).toBeUndefined();
    expect(readDotted(CONFIGURATION_DEFAULTS, "framework")).toBeUndefined();
  });

  it("leaves every framework setting absent", () => {
    // Nothing under `cypress` has a default: `configFile` comes from project detection, and nothing else exists yet.
    expect(readDotted(CONFIGURATION_DEFAULTS, "cypress")).toBeUndefined();
    expect(
      readDotted(CONFIGURATION_DEFAULTS, "cypress.configFile"),
    ).toBeUndefined();
  });

  it("states output paths that resolve inside the project", () => {
    // Deterministic means project-relative: no leading separator, no drive letter, no home alias, no timestamp, no
    // hostname.
    for (const key of ["reports", "evidence"] as const) {
      const value = readDotted(CONFIGURATION_DEFAULTS, `output.${key}`);
      expect(typeof value).toBe("string");
      expect(value).not.toMatch(/^[/\\]/u);
      expect(value).not.toMatch(/^[A-Za-z]:/u);
      expect(value).not.toContain("~");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Complete coverage                                                          */
/* -------------------------------------------------------------------------- */

describe("the documented catalogue", () => {
  it("documents every field the schema declares", () => {
    const undocumented = leafFieldPaths.filter(
      (field) => !catalogued.has(field),
    );

    expect(undocumented).toEqual([]);
  });

  it("documents no field the schema does not declare", () => {
    const declared = new Set(leafFieldPaths);
    const invented = [...catalogued].filter((field) => !declared.has(field));

    expect(invented).toEqual([]);
  });

  it("has exactly one entry per field", () => {
    expect(DEFAULT_CATALOGUE).toHaveLength(catalogued.size);
    expect(DEFAULT_CATALOGUE).toHaveLength(leafFieldPaths.length);
  });

  it("agrees with the defaults table for every entry that claims a value", () => {
    const disagreements = DEFAULT_CATALOGUE.filter(
      (descriptor) =>
        descriptor.rule === "default" &&
        plain(readDotted(CONFIGURATION_DEFAULTS, descriptor.field)) !==
          plain(descriptor.value),
    ).map((descriptor) => descriptor.field);

    expect(disagreements).toEqual([]);
  });

  it("states no value for an entry with no default", () => {
    const carrying = DEFAULT_CATALOGUE.filter(
      (descriptor) =>
        descriptor.rule !== "default" && descriptor.value !== undefined,
    ).map((descriptor) => descriptor.field);

    expect(carrying).toEqual([]);
  });

  it("refuses a default for the required fields, and says so", () => {
    const required = DEFAULT_CATALOGUE.filter(
      (descriptor) =>
        (descriptor.field === "version" || descriptor.field === "framework") &&
        (descriptor.rule !== "none" ||
          descriptor.rationale.trim().length === 0),
    ).map((descriptor) => descriptor.field);

    expect(required).toEqual([]);
  });

  it("derives the default environment rather than fixing it", () => {
    const descriptor = DEFAULT_CATALOGUE.find(
      (entry) => entry.field === "defaultEnvironment",
    );

    expect(descriptor?.rule).toBe("derived");
    expect(descriptor?.value).toBeUndefined();
  });

  it("explains every entry", () => {
    // A rationale is the only place the reasoning lives. An empty one turns the table into a list of assertions nobody
    // can review; a newline or a trailing space would break the table rendered from it.
    const unexplained = DEFAULT_CATALOGUE.filter(
      (descriptor) =>
        descriptor.rationale.trim().length === 0 ||
        descriptor.rationale !== descriptor.rationale.trim() ||
        descriptor.rationale.includes("\n"),
    ).map((descriptor) => descriptor.field);

    expect(unexplained).toEqual([]);
  });

  it("publishes the conventional environment name the derivation prefers", () => {
    expect(PREFERRED_ENVIRONMENT_KEY).toBe("default");
    // The name is a preference, not a default value: nothing in the table fixes it.
    expect(
      readDotted(CONFIGURATION_DEFAULTS, "defaultEnvironment"),
    ).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Nothing can move it                                                        */
/* -------------------------------------------------------------------------- */

describe("the frozen table", () => {
  it("cannot be replaced through its own reference", () => {
    expect(Object.isFrozen(CONFIGURATION_DEFAULTS)).toBe(true);

    // `Reflect.set` reports refusal by returning false rather than by throwing, so this asserts the freeze without
    // depending on the caller's strict mode. The double assertion is deliberate: the table is `readonly`, which is
    // exactly the claim being tested.
    const target = CONFIGURATION_DEFAULTS as unknown as Record<string, unknown>;

    expect(Reflect.set(target, "output", { reports: "elsewhere" })).toBe(false);
    expect(readDotted(CONFIGURATION_DEFAULTS, "output.reports")).toBe(
      OUTPUT_DEFAULTS.reports,
    );
  });

  it("cannot be changed at depth", () => {
    // Freezing the outer object alone would leave this writable, which is the failure mode a shallow freeze produces.
    const output = asRecord(readDotted(CONFIGURATION_DEFAULTS, "output"));

    expect(Object.isFrozen(output)).toBe(true);
    expect(Reflect.set(output, "reports", "elsewhere")).toBe(false);
    expect(readDotted(CONFIGURATION_DEFAULTS, "output.reports")).toBe(
      OUTPUT_DEFAULTS.reports,
    );
  });

  it("freezes the catalogue, not just the array", () => {
    expect(Object.isFrozen(DEFAULT_CATALOGUE)).toBe(true);
    expect(DEFAULT_CATALOGUE.length).toBeGreaterThan(0);

    // A mutable descriptor would let one consumer reword a rationale that a published document claims to quote.
    const descriptor = asRecord(DEFAULT_CATALOGUE[0]);

    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Reflect.set(descriptor, "rationale", "something else")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The provider                                                               */
/* -------------------------------------------------------------------------- */

describe("the defaults provider", () => {
  it("hands out the frozen table and the catalogue", () => {
    const provider = createDefaultsProvider();

    expect(provider.defaults).toBe(CONFIGURATION_DEFAULTS);
    expect(provider.catalogue).toBe(DEFAULT_CATALOGUE);
  });

  it("exposes nothing else", () => {
    // No override parameter, no profile selector, no test seam. Configuration surface added for the benefit of tests
    // ships without a user.
    expect(Object.keys(createDefaultsProvider()).sort()).toEqual([
      "catalogue",
      "defaults",
    ]);
  });

  it("is deterministic", () => {
    expect(createDefaultsProvider().defaults).toBe(
      createDefaultsProvider().defaults,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Documentation cannot drift                                                 */
/* -------------------------------------------------------------------------- */

describe("the rendered defaults table", () => {
  it("renders a header and one row per catalogue entry", () => {
    const lines = defaultsAsMarkdown().split("\n");

    expect(lines[0]).toBe("| Field | Rule | Default | Rationale |");
    expect(lines[1]).toBe("| --- | --- | --- | --- |");
    expect(lines).toHaveLength(DEFAULT_CATALOGUE.length + 2);
  });

  it("keeps every row the same shape", () => {
    // Four columns produce six segments once split on the separator, including the two empties around the edges. A
    // rationale containing an unescaped pipe would break that count, which is the only way this can silently go wrong.
    const irregular = defaultsAsMarkdown()
      .split("\n")
      .filter((line) => line.split("|").length !== 6);

    expect(irregular).toEqual([]);
  });

  it("is stable across calls", () => {
    expect(defaultsAsMarkdown()).toBe(defaultsAsMarkdown());
  });

  it("appears in the architecture document", async () => {
    // The published table is generated from the same source the runtime reads, so the only thing left to check is that
    // somebody pasted the current output into the document. Rows are asserted individually rather than as one block, so
    // the document may keep prose around them — and a missing row is named.
    const document = await readDefaultsDocument();

    const missing = defaultsAsMarkdown()
      .split("\n")
      .filter((line) => !line.startsWith("| ---") && !document.includes(line));

    expect(missing).toEqual([]);
  });
});
