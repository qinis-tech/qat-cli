import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  CheckCategory,
  CheckId,
  CheckSeverity,
  HealthCode,
} from "~/core/application/checks.js";
import {
  parseRange,
  qatRuntimeRequirement,
} from "~/core/compatibility/index.js";
import { CHECKS, HEALTH_GUIDANCE } from "~/diagnostics/checks/index.js";

/**
 * The catalogue as an artefact.
 *
 * These cases assert properties of the *table* rather than of any one check: that every question is documented, that the
 * identifiers are unique and permanently shaped, that a precondition never points forward or in a circle, and that
 * severity and mandatory-ness are independent of each other. They are what makes "every mandatory check has a documented
 * contract and a linked scenario" a fact rather than a claim.
 *
 * ## What is deliberately not here
 *
 * Anything that requires evidence. That a healthy project passes every check, that a failure blocks, and that an
 * advisory check never returns `fail` all need facts, and facts live in `run.test.ts` — which also derives its case list
 * from the scenario identifiers asserted below. This file is the shape of the register; that file is its behaviour.
 *
 * ## The package-manager check, as a worked example of the three rules
 *
 * It is **mandatory** (no precondition: every project gets asked), **advisory** (a warning, so it can never produce a
 * `failed` outcome), and it declares **eleven** scenarios — nine conditions plus two passing cases. Those three facts are
 * asserted separately and from opposite directions below, because they are separate policies: a change that made it
 * blocking would break the severity case, and a change that gave it a precondition would break the mandatory list, even
 * though both edits would look local in the catalogue.
 */
const ids = CHECKS.map((check) => check.id);

describe("the register", () => {
  it("declares every check exactly once", () => {
    // A duplicate would make two entries indistinguishable in a report and would break the `Record` keyed by identifier.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every identifier the contract declares", () => {
    // Both directions. A check missing from the catalogue is a question the doctor silently stopped asking; an entry for
    // an identifier that no longer exists is a question it asks under a name nobody else knows.
    expect([...ids].sort()).toStrictEqual(Object.values(CheckId).sort());
  });

  it("covers every category, and uses no category it does not declare", () => {
    const declared = new Set(CHECKS.map((check) => check.category));

    // A category with no check is a row missing from the report a reader expected.
    expect([...declared].sort()).toStrictEqual(
      Object.values(CheckCategory).sort(),
    );
  });

  it("gives every check a distinct title", () => {
    const titles = CHECKS.map((check) => check.title);

    // Titles are report headings. Two checks sharing one is a report where a reader cannot tell which line is which.
    expect(new Set(titles).size).toBe(titles.length);
  });

  it.each(CHECKS.map((check) => [check.id, check] as const))(
    "%s documents a purpose and a procedure",
    (__id, check) => {
      // The two fields a reader uses to decide whether the question is the one they had. An empty string passes a type
      // check and tells nobody anything, which is why the length is asserted rather than the presence.
      expect(check.purpose.length).toBeGreaterThan(0);
      expect(check.procedure.length).toBeGreaterThan(0);
    },
  );

  it.each(CHECKS.map((check) => [check.id, check] as const))(
    "%s declares the evidence it reads, without repeating a group",
    (__id, check) => {
      // A check that reads nothing cannot be judging a project. A repeated group doubles its weight in the skip
      // explanation, which reads as two missing inputs rather than one.
      expect(check.requires.length).toBeGreaterThan(0);
      expect(new Set(check.requires).size).toBe(check.requires.length);
    },
  );
});

describe("the scenario inventory", () => {
  it.each(CHECKS.map((check) => [check.id, check] as const))(
    "%s links at least one scenario, prefixed by its own identifier",
    (id, check) => {
      expect(check.scenarios.length).toBeGreaterThan(0);

      for (const scenario of check.scenarios) {
        // The prefix is what makes a scenario id readable on its own: `output.reports-writable.unwritable` says which
        // check it verifies and which condition it exercises, in the order a reader needs them.
        //
        // The separator is a dot, not a colon, and that is not cosmetic: `run.test.ts` keys its fixtures by these exact
        // strings, so a different separator makes the rule and its verification disagree while both read correctly in
        // isolation.
        expect(scenario.startsWith(`${id}.`)).toBe(true);
        expect(scenario.length).toBeGreaterThan(id.length + 1);
      }
    },
  );

  it("keeps scenario identifiers unique across the catalogue", () => {
    const scenarios = CHECKS.flatMap((check) => check.scenarios);

    // Two checks claiming one scenario means one of them is verified by a case that tests the other.
    expect(new Set(scenarios).size).toBe(scenarios.length);
  });

  it("gives the package-manager check a scenario per condition and per pass case", () => {
    // Counted rather than named here: which scenarios exist is the contract test's business, and duplicating the list
    // would give the register two places to disagree with itself. What this asserts is that the advisory ladder did not
    // quietly lose a rung — nine conditions plus the two ways a project can pass.
    const check = CHECKS.find(
      (candidate) => candidate.id === CheckId.PackageManager,
    );

    expect(check?.scenarios).toHaveLength(11);
  });
});

describe("preconditions", () => {
  it("names only declared checks, and never itself", () => {
    for (const check of CHECKS) {
      if (check.precondition === undefined) continue;

      expect(ids).toContain(check.precondition);
      expect(check.precondition).not.toBe(check.id);
    }
  });

  it("appears before its dependant in declaration order", () => {
    // Not a style rule. The runner resolves skips in one pass and throws when a precondition was never concluded, so a
    // dependency declared later would turn a mistake in this table into an exception the first time a project was
    // diagnosed.
    //
    // The callback's return type is annotated: an array literal without it infers as `(string | number)[]`, and `Map`
    // refuses that as a tuple of key and value.
    const position = new Map(
      ids.map((id, index): [string, number] => [id, index]),
    );

    for (const check of CHECKS) {
      if (check.precondition === undefined) continue;

      expect(position.get(check.precondition)).toBeLessThan(
        position.get(check.id) ?? -1,
      );
    }
  });

  it("forms no cycle", () => {
    const byId = new Map(CHECKS.map((check) => [check.id, check]));

    for (const check of CHECKS) {
      const seen = new Set<string>();

      for (let current = check.precondition; current !== undefined;) {
        expect(seen.has(current)).toBe(false);

        seen.add(current);
        current = byId.get(current)?.precondition;
      }
    }
  });
});

describe("severity, mandatory-ness and blocking are three separate facts", () => {
  it("marks a check mandatory exactly when it has no precondition", () => {
    // Derived rather than stored, so there is no second list to drift. This pins the derivation against the policy the
    // architecture note states, and it is the assertion that fails when a precondition is added or removed carelessly.
    //
    // The advisory runtime check is in this list, and that is the point of it: "always asked" and "can stop a run" are
    // different questions, and the framework's runtime bound is always worth asking about even though the answer never
    // blocks. The package-manager check is here for the same reason.
    const mandatory = CHECKS.filter(
      (check) => check.precondition === undefined,
    ).map((check) => check.id);

    expect(mandatory).toStrictEqual([
      CheckId.NodeVersion,
      CheckId.CypressRuntimeSupported,
      CheckId.PackageManager,
      CheckId.ProjectRecognised,
      CheckId.QatConfigurationLoadable,
    ]);
  });

  it("keeps mandatory-ness independent of blocking", () => {
    // The pair that proves the two are not the same question. A package manager must always be looked for, and naming
    // none is advice; an unwritable output directory must block, and is only asked about once the configuration read.
    // A design that collapsed the two would have to choose between refusing a run over a warning and never blocking on
    // an output path.
    const mandatory = new Set(
      CHECKS.filter((check) => check.precondition === undefined).map(
        (check) => check.id,
      ),
    );
    const blocking = new Set(
      CHECKS.filter((check) => check.severity === CheckSeverity.Error).map(
        (check) => check.id,
      ),
    );

    expect(mandatory.has(CheckId.PackageManager)).toBe(true);
    expect(blocking.has(CheckId.PackageManager)).toBe(false);

    expect(mandatory.has(CheckId.ReportsWritable)).toBe(false);
    expect(blocking.has(CheckId.ReportsWritable)).toBe(true);

    // The same split inside one subject: both runtime questions are always asked, and only QAT's own requirement can
    // refuse a run.
    expect(mandatory.has(CheckId.CypressRuntimeSupported)).toBe(true);
    expect(blocking.has(CheckId.CypressRuntimeSupported)).toBe(false);
  });

  it("uses both severities, so the distinction is exercised", () => {
    const severities = new Set(CHECKS.map((check) => check.severity));

    // A catalogue where every check is fatal is one where the severity field has stopped meaning anything, and the
    // distinction between a failure and advice is untested by construction.
    expect([...severities].sort()).toStrictEqual(
      [CheckSeverity.Error, CheckSeverity.Warning].sort(),
    );
  });
});

describe("the guidance table", () => {
  it("gives every health code a distinct, prefixed identifier", () => {
    const codes = Object.values(HealthCode);

    expect(new Set(codes).size).toBe(codes.length);

    for (const code of codes) {
      // `QAT-D` is a project condition, `QAT-V` whether it stops an operation, `QAT-C` a configuration document, and
      // `QAT-H` this machine or this run. A reader can tell which layer spoke from the code alone.
      expect(code).toMatch(/^QAT-H\d{3}$/);
    }
  });

  it.each(Object.values(HealthCode))(
    "%s explains itself and offers a remedy",
    (code) => {
      const text = HEALTH_GUIDANCE[code].describe({});

      // The `Record` guarantees an entry exists. This asserts the entry says something when handed no facts at all —
      // which is the state a caller reaches by passing a fact set gathered for a different check — and that no template
      // hole printed the word `undefined` into a sentence a user will read.
      //
      // The package-manager entries are the ones most likely to fail here: each reads several optional facts, so every one
      // of them has a degraded branch that must still compose a sentence. A single missing `??` in any of them surfaces as
      // `undefined` in the explanation, and this is the case that catches it.
      expect(text.explanation.length).toBeGreaterThan(0);
      expect(text.explanation).not.toContain("undefined");
      expect(text.remediation).toBeDefined();
    },
  );

  it("is exhaustive by type, so an entry cannot be forgotten", () => {
    // Not redundant with the parameterised case above: this asserts the table has exactly one entry per code, which a
    // duplicate or an extra key would break while every individual entry still read correctly.
    expect(Object.keys(HEALTH_GUIDANCE).sort()).toStrictEqual(
      Object.values(HealthCode).sort(),
    );
  });

  it("does not name an output directory, because the check that failed knows which one", () => {
    // One code covers both output paths. If the entry guessed from the facts it would name whichever it found first,
    // and a failure writing evidence could be reported as a failure writing reports.
    const text = HEALTH_GUIDANCE[HealthCode.OutputUnwritable].describe({
      output: {
        reports: { path: "results/reports", writable: false },
        evidence: { path: "results/evidence", writable: false },
      },
    });

    expect(text.explanation).not.toContain("results/reports");
    expect(text.explanation).not.toContain("results/evidence");
  });

  it("quotes a line number rather than a line of the file", () => {
    // A line of a configuration file can hold an environment value. Line and column find it in an editor; an excerpt
    // would print it into whatever consumes the report.
    const text = HEALTH_GUIDANCE[HealthCode.ConfigurationNotJson].describe({
      configuration: {
        kind: "malformed",
        path: "qat.config.json",
        reason: "Unexpected token",
        location: {
          position: 4,
          line: 4,
          column: 1,
          excerpt: '{"API_TOKEN": "sk_live_do_not_print"',
        },
      },
    });

    expect(text.explanation).toContain("line 4");
    expect(text.explanation).not.toContain("sk_live");
  });

  it("quotes the declared range for an unsupported runtime, rather than a version of its own", () => {
    // The entry used to name a floor it held as a constant. It now quotes what the facts carry, which is the only way
    // the message cannot lag the policy — and this is the assertion that stops a constant being reintroduced here.
    const text = HEALTH_GUIDANCE[HealthCode.RuntimeUnsupported].describe({
      runtime: {
        nodeVersion: "v18.19.0",
        required: {
          range: ">=24.0.0 <25",
          origin: "package.json#engines.node",
        },
      },
    });

    expect(text.explanation).toContain(">=24.0.0 <25");
    expect(text.explanation).toContain("package.json#engines.node");
    expect(text.explanation).toContain("v18.19.0");
  });

  it("quotes an executable version the project declared, not a support floor", () => {
    // The package-manager equivalent of the case above: the expectation comes from evidence, so the message cannot
    // claim a bound the project never wrote.
    const text = HEALTH_GUIDANCE[
      HealthCode.PackageManagerVersionMismatch
    ].describe({
      packageManager: {
        selection: { status: "identified", name: "pnpm", declared: true },
        lockfiles: ["pnpm-lock.yaml"],
        executable: { resolved: true, version: "9.0.9" },
        required: {
          range: ">=9.1.0 <10.0.0",
          origin: "package.json#engines.pnpm",
        },
        installState: "installed",
      },
    });

    expect(text.explanation).toContain("9.0.9");
    expect(text.explanation).toContain(">=9.1.0 <10.0.0");
    expect(text.explanation).toContain("package.json#engines.pnpm");
  });
});

describe("the declared Node range", () => {
  it("is declared, and readable by the compatibility engine", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { engines?: { node?: string } };

    // There used to be a constant here — the supported floor, restated from `engines.node` and compared against it. The
    // comparison was the guard and the constant was the duplication: every support change meant two edits, and
    // forgetting the second produced a message confidently quoting a requirement QAT no longer had.
    //
    // The range is now read from the manifest by the same function the check uses, so there is nothing left to compare
    // the declaration against. What still needs a release gate is that the declaration exists and that the engine can
    // parse it — an unreadable range is a warning at runtime, which is right for a user and useless as a build check.
    const requirement = qatRuntimeRequirement(manifest);

    expect(requirement.range).not.toBe("");
    expect(parseRange(requirement.range).ok).toBe(true);
  });
});

describe("the documentation", () => {
  it("names every check in the register table", async () => {
    const document = await readFile(
      new URL("../../../docs/architecture/doctor-checks.md", import.meta.url),
      "utf8",
    );

    // A documented field list is a copy of the table, and a copy lags. This is the same guard the configuration format
    // uses for its field table: a check added without a row fails here rather than being discovered by a reader who
    // went looking for it and found nothing.
    const missing = ids.filter((id) => !document.includes(id));

    expect(missing).toStrictEqual([]);
  });
});
