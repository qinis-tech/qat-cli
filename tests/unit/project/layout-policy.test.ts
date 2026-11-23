import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// Reached from the contracts module rather than the layer's barrel: `LEGACY_SPEC_DIRECTORY` is a lookup fallback,
// not part of the surface, and a test inside this layer may name it directly. Hard-coding 'cypress' here instead
// would be a second definition of a constant — the very thing this suite proves elsewhere that nothing else does.
import { LEGACY_SPEC_DIRECTORY } from "~/project/contracts.js";
import {
  classifyLayout,
  ConfigurationPlacement,
  detectCypress,
  SpecsShape,
  type CypressLayout,
} from "~/project/index.js";

/**
 * The supported-layout policy, exercised as a function.
 *
 * `classifyLayout` takes evidence and returns two closed answers. It touches no disk, so almost every rule here is
 * stated in three lines.
 *
 * ## The fixtures are copied from the engine, not simplified
 *
 * The first block builds real trees and asserts what the *classifier* says about what the *engine* actually
 * reports. That exists because an earlier version of this suite passed a fixture the engine never produces —
 * `specDirectories: []` for a component-only project — and so passed against a classifier that would have sent a
 * component-only project into a run. A fixture that is easier to write than the real evidence tests the rule
 * against a world that does not exist; where the two can drift, the real shape is asserted once, here, and the
 * cheap fixtures below are trusted because of it.
 */

let created: string[] = [];

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-layout-"));
  created.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  return root;
}

/**
 * Layout evidence with the most common real shape as its default: a named spec directory, and a `cypress/`
 * directory that exists because the named one is inside it.
 */
function layout(overrides: Partial<CypressLayout> = {}): CypressLayout {
  return {
    specDirectories: ["cypress/e2e"],
    supportFiles: [],
    hasCypressDirectory: true,
    misplacedConfigurations: [],
    occupiedConfigurationPaths: [],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
  created = [];
});

describe("the fixtures match what the engine emits", () => {
  it("classifies a component-only project as component-only, despite the legacy fallback", async () => {
    const root = await project({
      "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }),
      "cypress.config.ts": "",
      "cypress/component/widget.cy.tsx": "",
    });

    const detection = await detectCypress(root);

    // The engine cannot distinguish a component-only project from a pre-10 one by directory names alone: `cypress/`
    // exists in both, so it reports the fallback. The classifier must therefore trust the component evidence, and
    // this assertion is the one that catches it when it does not — a component-only project classified as `legacy`
    // passes validation and then runs against a directory of components.
    expect(detection.layout.specDirectories).toStrictEqual([
      LEGACY_SPEC_DIRECTORY,
    ]);
    expect(
      classifyLayout(detection.layout, detection.configurations[0]).specs,
    ).toBe(SpecsShape.ComponentOnly);
  });

  it("classifies a pre-10 project as legacy", async () => {
    const root = await project({
      "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }),
      "cypress.config.ts": "",
      "cypress/smoke.cy.js": "",
    });

    const detection = await detectCypress(root);

    // Same evidence as the case above, and a different answer — which is the point: the fallback alone does not
    // decide, and nothing but the component directory separates the two shapes.
    expect(detection.layout.specDirectories).toStrictEqual([
      LEGACY_SPEC_DIRECTORY,
    ]);
    expect(
      classifyLayout(detection.layout, detection.configurations[0]).specs,
    ).toBe(SpecsShape.Legacy);
  });

  it("reports one spec location for a modern project, not the parent as well", async () => {
    const root = await project({
      "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }),
      "cypress.config.ts": "",
      "cypress/e2e/smoke.cy.ts": "",
      "cypress/support/e2e.ts": "",
    });

    const detection = await detectCypress(root);

    // A regression anchor for the candidate list: `cypress` used to be a member, so this project reported two spec
    // locations and a run pointed at the second would have collected the support file as a spec.
    expect(detection.layout.specDirectories).toStrictEqual(["cypress/e2e"]);
    expect(
      classifyLayout(detection.layout, detection.configurations[0]).specs,
    ).toBe(SpecsShape.Named);
  });
});

describe("configuration placement", () => {
  it("reports a configuration at the root as at-root", () => {
    expect(classifyLayout(layout(), "cypress.config.ts").configuration).toBe(
      ConfigurationPlacement.AtRoot,
    );
  });

  it("reports a configuration inside cypress/ as misplaced", () => {
    const placement = classifyLayout(
      layout({ misplacedConfigurations: ["cypress/cypress.config.ts"] }),
      undefined,
    ).configuration;

    // A Cypress project, configured where Cypress does not look. Reporting it as `absent` would send its owner
    // looking for a directory they are already in.
    expect(placement).toBe(ConfigurationPlacement.Misplaced);
  });

  it("reports a directory on a configuration filename as name-occupied", () => {
    const placement = classifyLayout(
      layout({ occupiedConfigurationPaths: ["cypress.config.ts"] }),
      undefined,
    ).configuration;

    expect(placement).toBe(ConfigurationPlacement.NameOccupied);
  });

  it("reports absence when nothing explains it", () => {
    const placement = classifyLayout(
      layout({ hasCypressDirectory: false }),
      undefined,
    ).configuration;

    expect(placement).toBe(ConfigurationPlacement.Absent);
  });

  it("prefers a usable root configuration over a stray directory elsewhere", () => {
    // The precedence that protects a working project: a directory squatting on a filename the project does not use
    // is a repository defect, not a reason to refuse a run that would succeed.
    const placement = classifyLayout(
      layout({ occupiedConfigurationPaths: ["cypress.config.js"] }),
      "cypress.config.ts",
    ).configuration;

    expect(placement).toBe(ConfigurationPlacement.AtRoot);
  });

  it("prefers a misplaced file over an occupied name", () => {
    // Both are wrong and only one can be reported. A file in the wrong place is more actionable than a directory
    // in the right place, because moving it needs no decision about what the directory was for.
    const placement = classifyLayout(
      layout({
        misplacedConfigurations: ["cypress/cypress.config.ts"],
        occupiedConfigurationPaths: ["cypress.config.ts"],
      }),
      undefined,
    ).configuration;

    expect(placement).toBe(ConfigurationPlacement.Misplaced);
  });
});

describe("spec location", () => {
  it("reports a named directory as named", () => {
    expect(classifyLayout(layout(), "x").specs).toBe(SpecsShape.Named);
  });

  it("reports the first named directory when several exist", () => {
    // Evidence order is candidate order, and the classifier reads the first element rather than searching. A run
    // uses the same element, so the two cannot pick differently.
    const specs = classifyLayout(
      layout({ specDirectories: ["cypress/e2e", "cypress/integration"] }),
      "x",
    ).specs;

    expect(specs).toBe(SpecsShape.Named);
  });

  it("reports the legacy root as legacy", () => {
    expect(
      classifyLayout(layout({ specDirectories: [LEGACY_SPEC_DIRECTORY] }), "x")
        .specs,
    ).toBe(SpecsShape.Legacy);
  });

  it("prefers a named directory over a component directory", () => {
    // A project with both is a project with end-to-end tests, and those are what this tool drives. The component
    // testing support is not withdrawn by the presence of e2e specs.
    const specs = classifyLayout(
      layout({
        specDirectories: ["cypress/e2e"],
        componentDirectory: "cypress/component",
      }),
      "x",
    ).specs;

    expect(specs).toBe(SpecsShape.Named);
  });

  it("prefers component evidence over the legacy fallback", () => {
    // The regression case, isolated from the disk: identical evidence to a pre-10 project except for the component
    // directory, and the answer the engine's fallback cannot reach on its own.
    const specs = classifyLayout(
      layout({
        specDirectories: [LEGACY_SPEC_DIRECTORY],
        componentDirectory: "cypress/component",
      }),
      "x",
    ).specs;

    expect(specs).toBe(SpecsShape.ComponentOnly);
  });

  it("reports no recognisable location as unknown", () => {
    // `hasCypressDirectory: false` deliberately, because that is the only shape that reaches this answer: the
    // engine applies the legacy fallback whenever `cypress/` exists. A fixture with `[]` and a `cypress/` directory
    // would compile, pass, and describe something the engine never emits.
    const specs = classifyLayout(
      layout({ specDirectories: [], hasCypressDirectory: false }),
      "x",
    ).specs;

    expect(specs).toBe(SpecsShape.Unknown);
  });
});

describe("the two answers are independent", () => {
  it("classifies a misplaced configuration in a project with driveable specs", () => {
    const assessment = classifyLayout(
      layout({
        specDirectories: ["cypress/e2e"],
        misplacedConfigurations: ["cypress/cypress.config.ts"],
      }),
      undefined,
    );

    // One question is about where the configuration is, the other about where the specs are. A project can fail
    // either while passing the other, which is why the two are not collapsed into one verdict here.
    expect(assessment).toStrictEqual({
      configuration: ConfigurationPlacement.Misplaced,
      specs: SpecsShape.Named,
    });
  });

  it("classifies a well-placed configuration in a component-only project", () => {
    const assessment = classifyLayout(
      layout({
        specDirectories: [LEGACY_SPEC_DIRECTORY],
        componentDirectory: "cypress/component",
      }),
      "cypress.config.ts",
    );

    expect(assessment).toStrictEqual({
      configuration: ConfigurationPlacement.AtRoot,
      specs: SpecsShape.ComponentOnly,
    });
  });
});

describe("non-functional behaviour", () => {
  it("does not mutate the evidence it was given", () => {
    const evidence = layout({
      specDirectories: ["cypress/e2e", "cypress/integration"],
      misplacedConfigurations: ["cypress/cypress.config.ts"],
    });
    const before = structuredClone(evidence);

    classifyLayout(evidence, "cypress.config.ts");

    // A classifier that sorted or spliced its input would corrupt the evidence a later consumer reads, and the
    // damage would surface as a wrong report rather than as a failure here.
    expect(evidence).toStrictEqual(before);
  });

  it("is deterministic: the same evidence produces deeply equal answers", () => {
    const evidence = layout({ specDirectories: [LEGACY_SPEC_DIRECTORY] });

    expect(classifyLayout(evidence, undefined)).toStrictEqual(
      classifyLayout(evidence, undefined),
    );
  });

  it("answers for evidence that contradicts itself", () => {
    // The engine will not produce this, and the classifier still has to return something rather than throw: it is
    // called from a path that must always end in an assessment, and a throw there would turn a project condition
    // into an exception.
    expect(() =>
      classifyLayout(
        layout({
          hasCypressDirectory: false,
          specDirectories: [LEGACY_SPEC_DIRECTORY],
          componentDirectory: "cypress/component",
        }),
        "cypress.config.ts",
      ),
    ).not.toThrow();
  });
});
