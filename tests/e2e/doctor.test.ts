import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  temporaryProject,
  temporaryWarningProject,
  temporaryWorkspaceMember,
} from "./fixtures.js";
import {
  qat,
  removeTemporaryDirectories,
  snapshot,
  temporaryDirectory,
} from "./harness.js";

import {
  OUTPUT_DEFAULTS,
  SecretSource,
  SUPPORTED_CONFIG_VERSION,
} from "~/config/schema/index.js";
import { ExitCode } from "~/core/errors/index.js";

/**
 * The one command, from the outside.
 *
 * One file for one command's observable surface: what it reports, what it exits with, and what the machine-readable
 * document contains. A reader asking "what does `doctor` do" should not have to join three files.
 *
 * ## What changed shape, and why the assertions look different
 *
 * The command reports a project rather than describing one, so a project condition is no longer an error. Findings are
 * printed on standard output with their codes, and the exit status carries the failure. `stderr` is therefore clean for
 * every project condition — and that emptiness is asserted deliberately, because it is what lets a caller distinguish
 * "this command found something to say" from "this command broke".
 *
 * The report now has three blocks rather than two: the project summary, where a run would write, and the findings. The
 * middle one is present only when the project has a configuration to resolve, which is why several cases below assert
 * that it is *absent* — a project with no configuration has no output location, and a report that invented one would be
 * worse than one that stayed quiet.
 *
 * ## What the report says about a configuration, and what it deliberately does not
 *
 * It says where output will go and which environment was selected. It does not reproduce the profile: no variable, no
 * target, no secret source. Naming the environment is enough for an operator, and a report that dumped a profile would
 * put the contents of a committed file into a log line by default.
 *
 * ## Which layer's codes appear here
 *
 * `QAT-D` and `QAT-V`, from the assessment's gate. **Not** `QAT-H`, from the check layer: the two Cypress-configuration
 * checks are registered, covered and correct, and this command does not render their outcomes yet — it renders the gate.
 * Two vocabularies therefore exist for the same conditions, which is the duplication the diagnostics architecture warns
 * about, and the honest status is "wired into the catalogue and the runner, not into this command's output".
 *
 * The consequence for these cases is concrete: asserting a `QAT-H` code here would fail, and would keep failing until the
 * presenter is switched to `DoctorReport`. When that happens every code in "a blocking condition" changes at once, which
 * is the signal that it is one decision made in the CLI rather than a per-message edit.
 *
 * ## The runtime and tooling questions, and why neither has a "broken" case here
 *
 * A **passing check contributes no finding**, so on a supported interpreter, with a declared package manager, this file's
 * assertions are unchanged and both bodies of work are invisible from the outside. That is the correct observable
 * behaviour, and it is load-bearing: a check that warned on a runtime or a toolchain that is fine would make every clean
 * project's report noisy in every pipeline.
 *
 * There is deliberately no case that *forces* an unsupported runtime, and none that forces conflicting lockfiles. Both
 * need arrangements — a second interpreter, two lockfiles — and the unsupported paths are covered where they can be
 * driven honestly: `run.test.ts` for the report, and the compatibility suites for the comparisons themselves.
 *
 * ## Two imports, and the split is the modules'
 *
 * Project shapes come from `./fixtures.js`; running the binary, snapshotting a tree and making a bare directory come from
 * `./harness.js`. Following the imports is the quickest way to see what a case depends on.
 */
afterAll(removeTemporaryDirectories);

/** The `--json` document `doctor` writes, narrowed to the fields these assertions read. */
interface DoctorDocument {
  assessment?: {
    diagnosis?: {
      identity?: {
        name?: string;
        packageMetadata?: string;
        declaredWorkspaces?: string[];
      };
      framework?: {
        declaration?: { section?: string; range?: string };
        installation?: { version?: string; source?: string };
        configuration?: string;
      };
      detection?: string;
      compatibility?: string;
    };
    findings?: readonly DoctorFinding[];
    gates?: {
      execute?: {
        readiness?: string;
        blocking?: readonly DoctorFinding[];
        warnings?: readonly DoctorFinding[];
      };
    };
    configuration?: {
      reportsDirectory?: { source?: string; absolute?: string };
      evidenceDirectory?: { source?: string; absolute?: string };
      frameworkConfigFile?: { absolute?: string };
      environment?: { origin?: string; name?: string };
    };
  };
}

interface DoctorFinding {
  readonly code?: string;
  readonly severity?: string;
  readonly path?: string;
}

/**
 * The value printed beside a label.
 *
 * Named `valueOfLabel` rather than `valueOf`, which it was: `valueOf` already means something on every object in the
 * language, so a module-level function by that name reads as a mistake and is invisible in a search for its own call
 * sites.
 *
 * The value begins one column past the wider of the label and the column width. Kept in step with the presenter by the
 * unit suite, which pins the format with literal strings — this file reads values rather than re-asserting spacing,
 * because a `toContain("demo")` would pass whatever column the name happened to land in.
 *
 * The trailing space is implied by the column arithmetic rather than matched literally: a label that is a prefix of
 * another cannot collide, because the slice starts past the padded column rather than immediately after the label's last
 * character.
 *
 * `find` returns the *first* matching line, which matters now that `config` appears twice: once in the summary for the
 * framework's configuration file, and once in the output block for the anchored path of one. The summary always comes
 * first, so asking for `config` keeps returning the summary.
 */
function valueOfLabel(stdout: string, label: string): string | undefined {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith(label));

  return line === undefined
    ? undefined
    : line.slice(Math.max(label.length, 10) + 1).trim();
}

function parseDocument(stdout: string): DoctorDocument {
  // `JSON.parse` returns `any`; routing it through `unknown` keeps the cast honest and keeps an untyped value from
  // travelling any further than this function.
  const parsed: unknown = JSON.parse(stdout);

  return parsed as DoctorDocument;
}

/** A configuration requiring nothing beyond the two fields with no default. */
function minimalConfig(): string {
  return JSON.stringify({
    version: SUPPORTED_CONFIG_VERSION,
    framework: "cypress",
  });
}

describe("doctor", () => {
  describe("the report", () => {
    it("reports a supported project and exits zero", async () => {
      const root = await temporaryProject();

      const result = await qat(["doctor", root]);

      expect(result.exitCode).toBe(ExitCode.Success);

      // Labelled lines in the summary, read by label rather than by substring. The spec directory and the package manager
      // are deliberately not among them: they are facts about a project's shape, and the assessment carries the
      // correctness facts this command now reports.
      expect(valueOfLabel(result.stdout, "project")).toBe("demo");
      expect(valueOfLabel(result.stdout, "root")).toBe(root);
      expect(valueOfLabel(result.stdout, "package")).toBe("present");
      expect(valueOfLabel(result.stdout, "framework")).toBe(
        "cypress 13.15.0 (project install)",
      );
      expect(valueOfLabel(result.stdout, "declared")).toBe(
        "devDependencies (^13.15.0)",
      );
      expect(valueOfLabel(result.stdout, "config")).toBe("cypress.config.ts");
      expect(valueOfLabel(result.stdout, "detection")).toBe("detected");
      expect(valueOfLabel(result.stdout, "compatibility")).toBe("consistent");

      // `ready`, not `ready-with-warnings`. A supported runtime, a declared manager and a located configuration are all
      // satisfied conditions, and a satisfied condition prints nothing.
      expect(valueOfLabel(result.stdout, "result")).toBe("ready");
    });

    it("reports a project with warnings, and still exits zero", async () => {
      const root = await temporaryWarningProject();

      const result = await qat(["doctor", root]);

      // A warning is advice, not a failure. A tool that fails on advice is a tool people pipe through `|| true`, and
      // then it fails on blockers too.
      expect(result.exitCode).toBe(ExitCode.Success);
      expect(valueOfLabel(result.stdout, "result")).toBe("ready-with-warnings");
      expect(result.stdout).toContain("QAT-D010 warning");
      expect(result.stdout).toContain("No package.json was found");
    });

    it("reports a workspace member with a hoisted install as undeclared in the package itself", async () => {
      const { member } = await temporaryWorkspaceMember();

      const result = await qat(["doctor", member]);

      expect(result.exitCode).toBe(ExitCode.Success);
      // The version came from three directories up; the declaration came from nowhere. Both are true, and neither line
      // could be produced by the other.
      expect(valueOfLabel(result.stdout, "framework")).toBe(
        "cypress 13.15.0 (workspace install)",
      );
      expect(valueOfLabel(result.stdout, "declared")).toBe(
        "nowhere in this package",
      );
    });

    it("writes nothing to standard error when it succeeds", async () => {
      const root = await temporaryProject();

      const result = await qat(["doctor", root]);

      // A successful command that also logs to stderr makes a pipeline's error output noise.
      expect(result.stderr).toBe("");
    });
  });

  describe("the configuration it found", () => {
    it("says nothing about a configuration that is where Cypress expects it", async () => {
      const root = await temporaryProject();

      const result = await qat(["doctor", root]);

      // The load-bearing absence, stated over both vocabularies. A located, readable module configuration is a satisfied
      // condition and produces no finding, so this report has no findings block at all.
      //
      // Asserting only that `QAT-H029` is absent would pass trivially — no `QAT-H` code can appear here today — so the
      // `QAT-D` half is the assertion with teeth, and it is what catches a configuration check that starts warning on
      // every TypeScript project.
      expect(valueOfLabel(result.stdout, "result")).toBe("ready");
      expect(result.stdout).not.toContain("QAT-D");
      expect(result.stdout).not.toContain("QAT-H");
    });

    it("reports a Cypress project with no configuration file", async () => {
      const root = await temporaryProject({ configured: false });

      const result = await qat(["doctor", root]);

      // Declared but unconfigured: the project is identifiable as Cypress and cannot start. One condition, one status.
      expect(result.exitCode).toBe(ExitCode.InvalidInput);
      expect(valueOfLabel(result.stdout, "result")).toBe("blocked");

      // `QAT-D002`, from the assessment. The remedy offers both common extensions rather than naming only `.ts`, which
      // would send a JavaScript project looking for a toolchain it does not need.
      expect(result.stdout).toContain("QAT-D002 error");
      expect(result.stdout).toContain(
        "Create cypress.config.ts (or cypress.config.js) for Cypress",
      );
      expect(result.stderr).toBe("");
    });
  });

  describe("where the run would write", () => {
    it("prints the anchored output locations and the environment", async () => {
      const root = await temporaryProject({
        extra: { "qat.config.json": minimalConfig() },
      });

      const result = await qat(["doctor", root]);

      expect(result.exitCode).toBe(ExitCode.Success);

      // The visible consequence of defaulting and anchoring: the reader wrote nothing, and the report says where the run
      // will land. Absolute, and inside the project — never beside the process.
      expect(valueOfLabel(result.stdout, "reports")).toBe(
        join(root, OUTPUT_DEFAULTS.reports),
      );
      expect(valueOfLabel(result.stdout, "evidence")).toBe(
        join(root, OUTPUT_DEFAULTS.evidence),
      );
      // No environments declared, so nothing is selected, and the line says what to do about it.
      expect(valueOfLabel(result.stdout, "env")).toContain("none selected");
    });

    it("keeps a path the configuration chose", async () => {
      const root = await temporaryProject({
        extra: {
          "qat.config.json": JSON.stringify({
            version: SUPPORTED_CONFIG_VERSION,
            framework: "cypress",
            output: { reports: "artifacts/runs", evidence: "artifacts/proof" },
          }),
        },
      });

      const result = await qat(["doctor", root]);

      expect(valueOfLabel(result.stdout, "reports")).toBe(
        join(root, "artifacts/runs"),
      );
      expect(valueOfLabel(result.stdout, "evidence")).toBe(
        join(root, "artifacts/proof"),
      );
    });

    it("names the environment the configuration selected", async () => {
      const root = await temporaryProject({
        extra: {
          "qat.config.json": JSON.stringify({
            version: SUPPORTED_CONFIG_VERSION,
            framework: "cypress",
            defaultEnvironment: "staging",
            environments: {
              staging: {
                baseUrl: "https://staging.example.test",
                variables: { API_URL: "https://staging.example.test/api" },
                secrets: {
                  API_TOKEN: {
                    from: SecretSource.Environment,
                    name: "QAT_STAGING_API_TOKEN",
                  },
                },
              },
            },
          }),
        },
      });

      const result = await qat(["doctor", root]);

      expect(result.exitCode).toBe(ExitCode.Success);

      // The origin is in the sentence on purpose: an operator who never named an environment should be able to see that
      // the tool took them at their word, rather than assuming it inferred one.
      expect(valueOfLabel(result.stdout, "env")).toBe(
        "staging (from defaultEnvironment)",
      );

      // The report names the environment and stops there. A profile is a committed file that may name credentials; a
      // report that reproduced it would put those names into every log line and pasted issue by default.
      expect(result.stdout).not.toContain("QAT_STAGING_API_TOKEN");
      expect(result.stdout).not.toContain("https://staging.example.test");
    });

    it("says nothing about output when the project has no configuration", async () => {
      const root = await temporaryDirectory();

      const result = await qat(["doctor", root]);

      // Not "nowhere", not a placeholder. A project with no configuration has no output location, and inventing one
      // would tell a reader their reports are going somewhere they are not.
      expect(valueOfLabel(result.stdout, "reports")).toBeUndefined();
      expect(valueOfLabel(result.stdout, "evidence")).toBeUndefined();
      expect(result.stderr).toBe("");
    });

    it("says nothing about output when the configuration cannot be read", async () => {
      const root = await temporaryProject({
        extra: {
          "qat.config.json": JSON.stringify({
            version: 2,
            framework: "cypress",
          }),
        },
      });

      const result = await qat(["doctor", root]);

      // Current behaviour, recorded rather than endorsed. An unusable configuration produces no finding and no output
      // block, so the report is indistinguishable from a project that was never initialised. Closing that means merging
      // the loader's diagnostics into the assessment's gate, which changes this exit status — so this case exists to make
      // that change a decision rather than an accident.
      expect(result.exitCode).toBe(ExitCode.Success);
      expect(result.stdout).not.toContain("QAT-C002");
      expect(valueOfLabel(result.stdout, "reports")).toBeUndefined();
    });
  });

  describe("a blocking condition", () => {
    it("names it, its file and its fix, and reports the failure on standard output", async () => {
      const root = await temporaryProject({
        configured: false,
        extra: { "cypress/cypress.config.ts": "export default {};\n" },
      });

      const result = await qat(["doctor", root]);

      // The case the previous design could not describe: a Cypress project QAT cannot drive, reported rather than thrown.
      // The status still says the command failed, because a caller checking `$?` is entitled to know.
      expect(result.exitCode).toBe(ExitCode.InvalidInput);
      expect(valueOfLabel(result.stdout, "result")).toBe("blocked");

      // The placement facts doing their job: the explanation says the file exists and is one directory away, rather than
      // telling the reader to create one that is already there.
      expect(result.stdout).toContain("QAT-D002 error");
      expect(result.stdout).toContain("but not where Cypress looks");
      expect(result.stdout).toContain("Move cypress/cypress.config.ts");

      // Two conditions, both true, and neither redundant: one says the project has no configuration it can load, the
      // other says where the configuration it does have is sitting.
      expect(result.stdout).toContain("QAT-V001 error");
      // Detail lines hang two spaces beneath their code, so the codes stay one scannable column.
      expect(result.stdout).toContain("at:  cypress/cypress.config.ts");
      expect(result.stdout).toContain(
        "fix: Move it to the project root as cypress.config.ts.",
      );

      // The failure *is* the report. Nothing was thrown for a project condition, so standard error stays clean — which is
      // what lets a caller separate "found something to say" from "broke".
      expect(result.stderr).toBe("");
    });

    it("reports a directory that is not a project, with a remedy", async () => {
      const root = await temporaryDirectory();

      const result = await qat(["doctor", root]);

      // Previously QAT2001 from a throw. Now the condition is described and the status carries the failure.
      expect(result.exitCode).toBe(ExitCode.InvalidInput);
      expect(valueOfLabel(result.stdout, "detection")).toBe("not-detected");
      expect(result.stdout).toContain("QAT-D001 error");
      expect(result.stdout).toContain("Create cypress.config.ts");
      expect(result.stderr).toBe("");
    });

    it("names a legacy configuration format and the upgrade it needs", async () => {
      const root = await temporaryProject({
        configured: false,
        extra: { "cypress.json": "{}" },
      });

      const result = await qat(["doctor", root]);

      // A Cypress project QAT cannot drive. The remedy is an upgrade, and telling its owner they are in the wrong
      // directory would send them looking for something that is already there.
      //
      // `QAT-D004`, not a `QAT-H` code: this command prints the assessment's findings, and a legacy configuration is one
      // the assessment already names. The configuration check that could describe it better — it knows the file is
      // readable JSON in a deprecated format — is not on this output path yet.
      expect(result.exitCode).toBe(ExitCode.InvalidInput);
      expect(result.stdout).toContain("QAT-D004 error");
      expect(result.stdout).toContain("cypress.json");
      expect(result.stdout).toContain(
        "Move the settings into cypress.config.ts",
      );
      expect(result.stdout).toContain(
        "keep the configuration format that release reads",
      );
    });
  });

  describe("the structured document", () => {
    it("emits the assessment itself, for a project that is ready", async () => {
      const root = await temporaryProject();

      const result = await qat(["doctor", root, "--json"]);

      expect(result.exitCode).toBe(ExitCode.Success);

      // The published shape of the report, not a presentation of it: a consumer reads the same contract the command read,
      // so a field added to the assessment appears without the document changing.
      const document = parseDocument(result.stdout);

      expect(document.assessment?.diagnosis?.identity?.name).toBe("demo");
      expect(document.assessment?.diagnosis?.detection).toBe("detected");
      expect(document.assessment?.diagnosis?.compatibility).toBe("consistent");
      expect(
        document.assessment?.diagnosis?.framework?.declaration,
      ).toStrictEqual({
        section: "devDependencies",
        range: "^13.15.0",
      });
      expect(
        document.assessment?.diagnosis?.framework?.installation,
      ).toMatchObject({
        version: "13.15.0",
        source: "project",
      });
      expect(document.assessment?.gates?.execute?.readiness).toBe("ready");
      expect(document.assessment?.gates?.execute?.blocking).toStrictEqual([]);
    });

    it("carries the resolved configuration, so a consumer need not resolve it again", async () => {
      const root = await temporaryProject({
        extra: { "qat.config.json": minimalConfig() },
      });

      const result = await qat(["doctor", root, "--json"]);

      const document = parseDocument(result.stdout);

      // A consumer reading the document gets the same anchors the command printed, from the same resolution — one read of
      // one tree, not two.
      expect(
        document.assessment?.configuration?.reportsDirectory?.absolute,
      ).toBe(join(root, OUTPUT_DEFAULTS.reports));
      expect(document.assessment?.configuration?.reportsDirectory?.source).toBe(
        OUTPUT_DEFAULTS.reports,
      );
      expect(document.assessment?.configuration?.environment?.origin).toBe(
        "none",
      );
    });

    it("omits the configuration when the project has none", async () => {
      const root = await temporaryDirectory();

      const result = await qat(["doctor", root, "--json"]);

      const document = parseDocument(result.stdout);

      // Absent, not `null` and not a defaulted object: a consumer can tell "not known" from "the usual place".
      expect(document.assessment?.configuration).toBeUndefined();
    });

    it("carries the blocking conditions, and exits two", async () => {
      const root = await temporaryProject({
        configured: false,
        extra: { "cypress/cypress.config.ts": "export default {};\n" },
      });

      const result = await qat(["doctor", root, "--json"]);

      expect(result.exitCode).toBe(ExitCode.InvalidInput);

      const document = parseDocument(result.stdout);
      const blocking = document.assessment?.gates?.execute?.blocking ?? [];

      // Two conditions, both true: no configuration was found, and one exists where Cypress does not load it. A report
      // that named only the first would send its owner looking for a file they are looking at.
      //
      // The order is the requirement table's, not the filesystem's: the forwarded diagnosis finding comes first, then the
      // condition validation added. Pinned exactly, because a report whose findings moved would be a different report even
      // though every code was present.
      expect(blocking.map((finding) => finding.code)).toStrictEqual([
        "QAT-D002",
        "QAT-V001",
      ]);
      expect(document.assessment?.gates?.execute?.readiness).toBe("blocked");
    });

    it("carries warnings separately from blockers", async () => {
      const root = await temporaryWarningProject();

      const result = await qat(["doctor", root, "--json"]);

      expect(result.exitCode).toBe(ExitCode.Success);

      const document = parseDocument(result.stdout);

      expect(document.assessment?.gates?.execute?.blocking).toStrictEqual([]);
      expect(
        document.assessment?.gates?.execute?.warnings?.map(
          (finding) => finding.code,
        ),
      ).toStrictEqual(["QAT-D010"]);
    });

    it("writes the document to standard output and nothing to standard error", async () => {
      const root = await temporaryProject();

      const result = await qat(["doctor", root, "--json"]);

      // A consumer parsing stdout must not have to strip a log line, and a pipeline collecting stderr must not receive a
      // copy of what it is already reading.
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(result.stderr).toBe("");
    });
  });

  describe("the runtime and toolchain it did not have to complain about", () => {
    it("adds nothing to a clean report on a supported interpreter", async () => {
      const root = await temporaryProject();

      const result = await qat(["doctor", root]);

      // A passing check produces no finding, so a healthy project's report is exactly what it was before this work
      // existed. The absence assertions below are the load-bearing ones: if any check ever warned on a runtime or a
      // toolchain that is fine, every clean project in every pipeline would start reporting noise, and this is the only
      // case in the suite that would notice.
      expect(result.exitCode).toBe(ExitCode.Success);
      expect(valueOfLabel(result.stdout, "result")).toBe("ready");
      expect(result.stdout).not.toContain("QAT-H001");
      expect(result.stdout).not.toContain("QAT-H008");
      expect(result.stderr).toBe("");
    });

    it("adds nothing to the structured document either", async () => {
      const root = await temporaryProject();

      const result = await qat(["doctor", root, "--json"]);

      const document = parseDocument(result.stdout);

      // The gate the document exposes is the assessment's. A check finding would have to reach that gate to change an
      // exit status, and on a healthy project there is none to reach it — so a consumer sees the same document it saw
      // before any of these checks existed.
      expect(document.assessment?.gates?.execute?.blocking).toStrictEqual([]);
      expect(JSON.stringify(document)).not.toContain("QAT-H");
    });

    it("leaves the exit status of a failing project untouched", async () => {
      const root = await temporaryProject({
        configured: false,
        extra: { "cypress/cypress.config.ts": "export default {};\n" },
      });

      const result = await qat(["doctor", root]);

      // One condition, one status. Adding a second possible blocker must not change what a caller sees for the first, and
      // the code stays `InvalidInput` rather than becoming something check-specific — the exit-code contract is
      // `core/errors`'s to own, and none of this work adds an entry to it.
      expect(result.exitCode).toBe(ExitCode.InvalidInput);
      expect(result.stdout).not.toContain("QAT-H001");
    });
  });

  describe("what it does not do", () => {
    it("does not modify the project it inspects", async () => {
      const root = await temporaryProject({
        extra: { "qat.config.json": minimalConfig() },
      });
      const before = await snapshot(root);

      await qat(["doctor", root]);

      // A detection command that repaired something on the way past would be a different command with a different name,
      // and the repair would happen on the machine where nobody expected it. This now also covers the output locations:
      // they were printed, and nothing was created.
      expect(await snapshot(root)).toStrictEqual(before);
    });

    it("creates no output directory, even though it names one", async () => {
      const root = await temporaryProject({
        extra: { "qat.config.json": minimalConfig() },
      });

      const result = await qat(["doctor", root]);

      expect(valueOfLabel(result.stdout, "reports")).toBe(
        join(root, OUTPUT_DEFAULTS.reports),
      );

      // Asked of the filesystem directly, not of a snapshot: the directory the report just named must not exist. A
      // snapshot comparison would also pass if the directory had never existed for an unrelated reason, which is the shape
      // of assertion that proves nothing.
      await expect(stat(join(root, OUTPUT_DEFAULTS.reports))).rejects.toThrow();
      await expect(
        stat(join(root, OUTPUT_DEFAULTS.evidence)),
      ).rejects.toThrow();
    });

    it("does not need an executable Cypress, and so cannot have run one", async () => {
      const root = await temporaryProject();

      const result = await qat(["doctor", root]);

      // The fixture's installed package declares no binary and none exists on disk, so anything that tried to invoke
      // Cypress would fail rather than quietly succeed. A clean report is the observable form of "it did not".
      expect(result.exitCode).toBe(ExitCode.Success);
      expect(result.stdout).not.toContain("executable could not be invoked");
    });

    it("writes an invalid directory to standard error, because that is an argument defect", async () => {
      const result = await qat([
        "doctor",
        join(tmpdir(), "qat-absent-directory-7f3a"),
      ]);

      // The one thing the command still throws for. A directory that does not exist is not a property of a project, so it
      // is an error rather than a finding — and it never reaches the assessment.
      expect(result.exitCode).toBe(ExitCode.InvalidInput);
      expect(result.stderr).toContain("QAT1001");
      expect(result.stderr).toContain("is not a directory");
    });
  });
});
