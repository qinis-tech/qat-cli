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
 * ## Two imports, and the split is the modules'
 *
 * Project shapes come from `./fixtures.js`; running the binary, snapshotting a tree and making a bare directory come
 * from `./harness.js`. Following the imports is the quickest way to see what a case depends on.
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
 * The value begins one column past the wider of the label and the column width. Kept in step with the presenter by the
 * unit suite, which pins the format with literal strings — this file reads values rather than re-asserting spacing,
 * because a `toContain('demo')` would pass whatever column the name happened to land in.
 *
 * The trailing space in the match is load-bearing. Without it a label that is a prefix of another — `package` and a
 * hypothetical `packageMetadata` row — would match whichever came first.
 */
function valueOf(stdout: string, label: string): string | undefined {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith(`${label} `));

  return line === undefined
    ? undefined
    : line.slice(Math.max(label.length, 10) + 1).trim();
}

function parseDocument(stdout: string): DoctorDocument {
  return JSON.parse(stdout) as DoctorDocument;
}

describe("doctor", () => {
  describe("the report", () => {
    it("reports a supported project and exits zero", async () => {
      const root = await temporaryProject();

      const result = await qat(["doctor", root]);

      expect(result.exitCode).toBe(ExitCode.Success);

      // Nine labelled lines, read by label rather than by substring. The spec directory and the package manager are
      // deliberately not among them: they are facts about a project's shape, and the assessment carries the correctness
      // facts this command now reports.
      expect(valueOf(result.stdout, "project")).toBe("demo");
      expect(valueOf(result.stdout, "root")).toBe(root);
      expect(valueOf(result.stdout, "package")).toBe("present");
      expect(valueOf(result.stdout, "framework")).toBe(
        "cypress 13.15.0 (project install)",
      );
      expect(valueOf(result.stdout, "declared")).toBe(
        "devDependencies (^13.15.0)",
      );
      expect(valueOf(result.stdout, "config")).toBe("cypress.config.ts");
      expect(valueOf(result.stdout, "detection")).toBe("detected");
      expect(valueOf(result.stdout, "compatibility")).toBe("consistent");
      expect(valueOf(result.stdout, "result")).toBe("ready");
    });

    it("reports a project with warnings, and still exits zero", async () => {
      const root = await temporaryWarningProject();

      const result = await qat(["doctor", root]);

      // A warning is advice, not a failure. A tool that fails on advice is a tool people pipe through `|| true`, and
      // then it fails on blockers too.
      expect(result.exitCode).toBe(ExitCode.Success);
      expect(valueOf(result.stdout, "result")).toBe("ready-with-warnings");
      expect(result.stdout).toContain("QAT-D010 warning");
      expect(result.stdout).toContain("No package.json was found");
    });

    it("reports a workspace member with a hoisted install as undeclared in the package itself", async () => {
      const { member } = await temporaryWorkspaceMember();

      const result = await qat(["doctor", member]);

      expect(result.exitCode).toBe(ExitCode.Success);
      // The version came from three directories up; the declaration came from nowhere. Both are true, and neither line
      // could be produced by the other.
      expect(valueOf(result.stdout, "framework")).toBe(
        "cypress 13.15.0 (workspace install)",
      );
      expect(valueOf(result.stdout, "declared")).toBe(
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

  describe("a blocking condition", () => {
    it("names it, its file and its fix, and reports the failure on standard output", async () => {
      const root = await temporaryProject({
        configured: false,
        extra: { "cypress/cypress.config.ts": "export default {};\n" },
      });

      const result = await qat(["doctor", root]);

      // The case the previous design could not describe: a Cypress project QAT cannot drive, reported rather than
      // thrown. The status still says the command failed, because a caller checking `$?` is entitled to know.
      expect(result.exitCode).toBe(ExitCode.InvalidInput);
      expect(valueOf(result.stdout, "result")).toBe("blocked");
      expect(result.stdout).toContain("QAT-V001 error");
      expect(result.stdout).toContain("at:  cypress/cypress.config.ts");
      expect(result.stdout).toContain(
        "fix: Move it to the project root as cypress.config.ts.",
      );

      // The failure *is* the report. Nothing was thrown for a project condition, so standard error stays clean — which
      // is what lets a caller separate "found something to say" from "broke".
      expect(result.stderr).toBe("");
    });

    it("reports a directory that is not a project, with a remedy", async () => {
      const root = await temporaryDirectory();

      const result = await qat(["doctor", root]);

      // Previously QAT2001 from a throw. Now the condition is described and the status carries the failure.
      expect(result.exitCode).toBe(ExitCode.InvalidInput);
      expect(valueOf(result.stdout, "detection")).toBe("not-detected");
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
      expect(result.exitCode).toBe(ExitCode.InvalidInput);
      expect(result.stdout).toContain("QAT-D004 error");
      expect(result.stdout).toContain("cypress.json");
      expect(result.stdout).toContain("fix: Upgrade to cypress.config.ts");
    });
  });

  describe("the structured document", () => {
    it("emits the assessment itself, for a project that is ready", async () => {
      const root = await temporaryProject();

      const result = await qat(["doctor", root, "--json"]);

      expect(result.exitCode).toBe(ExitCode.Success);

      // The published shape of the report, not a presentation of it: a consumer reads the same contract the command
      // read, so a field added to the assessment appears without the document changing.
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
      // The order is the requirement table's, not the filesystem's: the forwarded diagnosis finding comes first, then
      // the condition validation added. Pinned exactly, because a report whose findings moved would be a different
      // report even though every code was present.
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
        document.assessment?.gates?.execute?.warnings?.map((f) => f.code),
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

  describe("what it does not do", () => {
    it("does not modify the project it inspects", async () => {
      const root = await temporaryProject();
      const before = await snapshot(root);

      await qat(["doctor", root]);

      // A detection command that repaired something on the way past would be a different command with a different name,
      // and the repair would happen on the machine where nobody expected it.
      expect(await snapshot(root)).toStrictEqual(before);
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

      // The one thing the command still throws for. A directory that does not exist is not a property of a project, so
      // it is an error rather than a finding — and it never reaches the assessment.
      expect(result.exitCode).toBe(ExitCode.InvalidInput);
      expect(result.stderr).toContain("QAT1001");
      expect(result.stderr).toContain("is not a directory");
    });
  });
});
