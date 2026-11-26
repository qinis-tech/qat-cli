/**
 * Unit tests for reading a Cypress declaration out of a package manifest.
 *
 * These are literal-input tests by design: the function is pure, so every case is a manifest object and an
 * assertion about what was read. No filesystem, no fixture, no mock.
 *
 * The grouping follows the questions the function has to answer in order, because the order is the behaviour:
 * is anything declared at all → which section wins when several do → what was wrong when none did → what the
 * full mention list looks like → and finally the evidence projection, which is a published contract.
 */

import { describe, expect, it } from "vitest";

import type {
  CypressDeclaringManifest,
  CypressDeclarationReading,
} from "~/project/cypress-health/declaration.js";
import {
  CYPRESS_MANIFEST_FIELDS,
  CYPRESS_PACKAGE_NAME,
  readCypressDeclaration,
  toDeclarationEvidence,
} from "~/project/cypress-health/declaration.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Reads a manifest with no ceremony, so each test reads as one statement about one shape. */
function read(
  manifest: CypressDeclaringManifest | null | undefined,
): CypressDeclarationReading {
  return readCypressDeclaration(manifest);
}

/** The fields that count as a declaration of a required Cypress, per the module's stated boundary. */
const DECLARING_FIELDS = ["devDependencies", "dependencies"] as const;

/** The fields whose entry would cause Cypress to be installed for the project. */
const INSTALLING_FIELDS = [
  "devDependencies",
  "dependencies",
  "optionalDependencies",
] as const;

/* -------------------------------------------------------------------------- */
/* Absence                                                                    */
/* -------------------------------------------------------------------------- */

describe("readCypressDeclaration — nothing declared", () => {
  it("reports nothing declared for an empty manifest", () => {
    const reading = read({});

    expect(reading.declaration).toStrictEqual({ declared: false });
    expect(reading.field).toBeNull();
    expect(reading.specifier).toBeNull();
    expect(reading.mentions).toStrictEqual([]);
    expect(reading.defect).toBeNull();
    expect(reading.conflict).toBe(false);
  });

  it("reports nothing declared when the manifest is absent", () => {
    // A caller that could not read a manifest at all still needs a reading, not an exception.
    expect(read(undefined).declaration).toStrictEqual({ declared: false });
    expect(read(null).declaration).toStrictEqual({ declared: false });
  });

  it("ignores a manifest whose sections do not mention Cypress", () => {
    const reading = read({
      devDependencies: { typescript: "^5.4.0", eslint: "^9.0.0" },
      dependencies: { lodash: "^4.17.21" },
    });

    expect(reading.declaration).toStrictEqual({ declared: false });
    expect(reading.mentions).toStrictEqual([]);
  });

  it("does not find a differently-cased key", () => {
    // Package names are case-sensitive; an entry named `Cypress` installs something else entirely.
    const reading = read({ devDependencies: { Cypress: "^13.6.0" } });

    expect(reading.declaration).toStrictEqual({ declared: false });
    expect(reading.mentions).toStrictEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Presence and precedence                                                    */
/* -------------------------------------------------------------------------- */

describe("readCypressDeclaration — declared", () => {
  it("accepts a devDependency", () => {
    const reading = read({
      devDependencies: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" },
    });

    expect(reading.declaration).toStrictEqual({
      declared: true,
      range: "^13.6.0",
      field: "devDependencies",
    });
    expect(reading.field).toBe("devDependencies");
    expect(reading.specifier).toBe("^13.6.0");
    expect(reading.defect).toBeNull();
  });

  it("accepts a runtime dependency", () => {
    const reading = read({
      dependencies: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" },
    });

    expect(reading.declaration).toStrictEqual({
      declared: true,
      range: "^13.6.0",
      field: "dependencies",
    });
  });

  it("prefers devDependencies when both declare it", () => {
    // Recorded precedence, not an accident of iteration order: an automation repository keeps Cypress in
    // devDependencies, and a stray entry in dependencies should not silently win.
    const reading = read({
      dependencies: { [CYPRESS_PACKAGE_NAME]: "^12.17.4" },
      devDependencies: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" },
    });

    expect(reading.field).toBe("devDependencies");
    expect(reading.specifier).toBe("^13.6.0");
  });

  it("records a disagreement between sections instead of hiding it", () => {
    const reading = read({
      dependencies: { [CYPRESS_PACKAGE_NAME]: "^12.17.4" },
      devDependencies: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" },
    });

    expect(reading.conflict).toBe(true);
  });

  it("does not report a conflict when both sections agree", () => {
    const reading = read({
      dependencies: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" },
      devDependencies: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" },
    });

    expect(reading.conflict).toBe(false);
  });

  it("trims surrounding whitespace from the specifier", () => {
    const reading = read({
      devDependencies: { [CYPRESS_PACKAGE_NAME]: "  ^13.6.0\n" },
    });

    expect(reading.specifier).toBe("^13.6.0");
  });

  it.each([
    ["npm:cypress@13.6.0", "an npm alias"],
    ["file:../cypress", "a local path"],
    ["link:../cypress", "a linked package"],
    ["workspace:*", "a workspace protocol"],
    ["latest", "a dist-tag"],
  ])("records %s verbatim (%s)", (specifier) => {
    // Whether a specifier is evaluable is the version engine's decision. This module must not pre-judge it,
    // or the product ends up with a second opinion about what a supported version looks like.
    const reading = read({
      devDependencies: { [CYPRESS_PACKAGE_NAME]: specifier },
    });

    expect(reading.declaration).toStrictEqual({
      declared: true,
      range: specifier,
      field: "devDependencies",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Sections that install but do not declare                                   */
/* -------------------------------------------------------------------------- */

describe("readCypressDeclaration — sections that are not a declaration", () => {
  it("records an optionalDependency without accepting it as a declaration", () => {
    // An optional dependency is installed best-effort; it does not establish Cypress as required.
    const reading = read({
      optionalDependencies: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" },
    });

    expect(reading.declaration).toStrictEqual({ declared: false });
    expect(reading.mentions).toStrictEqual([
      {
        field: "optionalDependencies",
        specifier: "^13.6.0",
        installing: true,
        accepts: false,
        defect: null,
      },
    ]);
  });

  it("records a peerDependency as neither installing nor declaring", () => {
    // A peer range is a statement about consumers; nobody installs it for this project.
    const reading = read({
      peerDependencies: { [CYPRESS_PACKAGE_NAME]: ">=12" },
    });

    expect(reading.declaration).toStrictEqual({ declared: false });
    expect(reading.mentions).toStrictEqual([
      {
        field: "peerDependencies",
        specifier: ">=12",
        installing: false,
        accepts: false,
        defect: null,
      },
    ]);
  });

  it("does not report a defect from a non-declaring section", () => {
    // A malformed peer entry is not "the project failed to declare Cypress"; it was never a declaration.
    const reading = read({
      peerDependencies: { [CYPRESS_PACKAGE_NAME]: null },
    });

    expect(reading.declaration).toStrictEqual({ declared: false });
    expect(reading.defect).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Defects                                                                    */
/* -------------------------------------------------------------------------- */

describe("readCypressDeclaration — unusable declarations", () => {
  it.each([
    [null, "not-a-string"],
    [42, "not-a-string"],
    [{ version: "13.6.0" }, "not-a-string"],
    [true, "not-a-string"],
    ["", "blank"],
    ["   ", "blank"],
    ["\n\t ", "blank"],
  ])("reports %j as %s", (value, expectedDefect) => {
    const reading = read({
      devDependencies: { [CYPRESS_PACKAGE_NAME]: value },
    });

    expect(reading.declaration).toStrictEqual({ declared: false });
    expect(reading.defect).toBe(expectedDefect);
    expect(reading.mentions).toHaveLength(1);
    expect(reading.mentions[0]?.specifier).toBeNull();
    expect(reading.mentions[0]?.defect).toBe(expectedDefect);
  });

  it("accepts a usable entry in dependencies when the devDependencies entry is blank", () => {
    // The blank one is a defect, but a winner exists, so there is nothing left to report: the project does
    // declare Cypress, just not in the first place we looked.
    const reading = read({
      devDependencies: { [CYPRESS_PACKAGE_NAME]: "   " },
      dependencies: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" },
    });

    expect(reading.specifier).toBe("^13.6.0");
    expect(reading.field).toBe("dependencies");
    expect(reading.defect).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Mentions: order and the installing/accepts matrix                          */
/* -------------------------------------------------------------------------- */

describe("readCypressDeclaration — mentions", () => {
  it("lists every mentioning section in declaration order", () => {
    const reading = read({
      peerDependencies: { [CYPRESS_PACKAGE_NAME]: ">=12" },
      optionalDependencies: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" },
      dependencies: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" },
      devDependencies: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" },
    });

    expect(reading.mentions.map((mention) => mention.field)).toStrictEqual([
      ...CYPRESS_MANIFEST_FIELDS,
    ]);
  });

  it.each(CYPRESS_MANIFEST_FIELDS.map((field) => [field] as const))(
    "classifies %s correctly",
    (field) => {
      const reading = read({ [field]: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" } });
      const [mention] = reading.mentions;

      expect(mention).toStrictEqual({
        field,
        specifier: "^13.6.0",
        installing: (INSTALLING_FIELDS as readonly string[]).includes(field),
        accepts: (DECLARING_FIELDS as readonly string[]).includes(field),
        defect: null,
      });
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Untrusted shapes                                                           */
/* -------------------------------------------------------------------------- */

describe("readCypressDeclaration — malformed sections and untrusted input", () => {
  it.each([
    ["a string", "cypress@13.6.0"],
    ["an array", ["cypress@13.6.0"]],
    ["a number", 13],
    ["a boolean", false],
  ])("ignores a section that is %s", (_label, section) => {
    // A section that is not a keyed object cannot express "cypress: version". Manifest shape errors are the
    // manifest reader's finding; here it simply mentions nothing.
    const reading = read({
      devDependencies: section as unknown as Record<string, string>,
    });

    expect(reading.declaration).toStrictEqual({ declared: false });
    expect(reading.mentions).toStrictEqual([]);
  });

  it("ignores an explicit null section", () => {
    const reading = read({ devDependencies: null });

    expect(reading.mentions).toStrictEqual([]);
  });

  it("ignores an entry inherited from the prototype of a section", () => {
    // Own properties only: a key that arrives through the prototype chain is not something the user wrote, and
    // honouring it would let a polluted manifest make a project look like it declares Cypress.
    const section = Object.create({
      [CYPRESS_PACKAGE_NAME]: "^13.6.0",
    }) as Record<string, string>;

    const reading = read({ devDependencies: section });

    expect(reading.declaration).toStrictEqual({ declared: false });
    expect(reading.mentions).toStrictEqual([]);
  });

  it("does not throw for any of the shapes above", () => {
    const shapes: unknown[] = [
      undefined,
      null,
      {},
      { devDependencies: "x" },
      [1, 2, 3],
      "manifest",
      7,
    ];

    for (const shape of shapes) {
      expect(() =>
        read(shape as CypressDeclaringManifest | null | undefined),
      ).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Immutability                                                               */
/* -------------------------------------------------------------------------- */

describe("readCypressDeclaration — immutability", () => {
  it("freezes the reading, its declaration and its mentions", () => {
    // Readings are shared with evidence and reporting; an accidental mutation in one consumer must be impossible
    // rather than merely discouraged.
    const reading = read({
      devDependencies: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" },
    });

    expect(Object.isFrozen(reading)).toBe(true);
    expect(Object.isFrozen(reading.declaration)).toBe(true);
    expect(Object.isFrozen(reading.mentions)).toBe(true);
  });

  it("does not mutate the manifest it was given", () => {
    const manifest = { devDependencies: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" } };
    const snapshot = structuredClone(manifest);

    read(manifest);

    expect(manifest).toStrictEqual(snapshot);
  });
});

/* -------------------------------------------------------------------------- */
/* Evidence projection                                                        */
/* -------------------------------------------------------------------------- */

describe("toDeclarationEvidence", () => {
  it("publishes the winning declaration for a declared project", () => {
    const evidence = toDeclarationEvidence(
      read({ dependencies: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" } }),
    );

    expect(evidence).toStrictEqual({
      declared: true,
      declaredIn: "dependencies",
      declaredSpecifier: "^13.6.0",
      mentions: ["dependencies:^13.6.0"],
      defect: null,
      conflict: false,
    });
  });

  it("publishes an empty mention list for a project that never mentions Cypress", () => {
    const evidence = toDeclarationEvidence(read({}));

    expect(evidence).toStrictEqual({
      declared: false,
      declaredIn: null,
      declaredSpecifier: null,
      mentions: [],
      defect: null,
      conflict: false,
    });
  });

  it("names an unusable mention rather than dropping it", () => {
    // The whole reason mentions are carried: a reader told "not declared" should be able to see the entry they
    // are thinking of, including the broken one.
    const evidence = toDeclarationEvidence(
      read({ optionalDependencies: { [CYPRESS_PACKAGE_NAME]: "   " } }),
    );

    expect(evidence["mentions"]).toStrictEqual([
      "optionalDependencies:(unusable)",
    ]);
    expect(evidence["defect"]).toBeNull();
  });

  it("publishes exactly the documented keys", () => {
    // Asserted as a list, not as a subset: adding a field to evidence is a published-contract change and should
    // require updating this test and the documentation together.
    const evidence = toDeclarationEvidence(read({}));

    expect(Object.keys(evidence)).toStrictEqual([
      "declared",
      "declaredIn",
      "declaredSpecifier",
      "mentions",
      "defect",
      "conflict",
    ]);
  });

  it("is frozen and carries no paths", () => {
    const evidence = toDeclarationEvidence(
      read({ devDependencies: { [CYPRESS_PACKAGE_NAME]: "^13.6.0" } }),
    );

    expect(Object.isFrozen(evidence)).toBe(true);
    // A finding may be logged, pasted into an issue or rendered by something that has not read the disclosure
    // rule, so nothing path-like belongs here.
    expect(JSON.stringify(evidence)).not.toMatch(/\/|\\/);
  });
});
