/**
 * `qat init`, from the outside.
 *
 * One file for one command's observable surface: what it writes, what it refuses, what it exits with, and what the
 * machine-readable document contains. Everything here runs the compiled binary against a real temporary project,
 * because the questions this command answers — did a file appear, is the one that was there still byte-identical — are
 * facts about a disk and not about a return value.
 *
 * ## What the assertions are careful about
 *
 * Four are easy to write in a way that passes for the wrong reason:
 *
 * - **"Nothing else changed"** is asserted by listing the directory before and after and comparing the two lists, not by
 *   comparing whole-tree snapshots. A snapshot comparison can only say "different"; the list says *one entry was added
 *   and its name is this one*.
 * - **"The framework's configuration is untouched"** is asserted by reading that file's bytes before and after. A
 *   snapshot would pass even if the file had moved, since a move changes two entries into two others.
 * - **"Nothing was written"** is asserted by reading the bytes at the path, not by checking an exit code. The code says
 *   the command refused; the bytes say it refused without touching anything.
 * - **"Replacement is impossible"** is asserted by asking for one and being told the option does not exist. A guarantee
 *   that is only stated in documentation is a guarantee that a future flag can quietly contradict.
 *
 * The fixtures are assumed to be a Cypress project with **no** QAT configuration — the state this command exists for. If
 * `temporaryProject` ever starts writing one, the first case below fails loudly (it would report `exists`), which is the
 * right place for that discovery.
 */
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { temporaryProject, temporaryWarningProject } from "./fixtures.js";
import {
  qat,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./harness.js";

import { SUPPORTED_CONFIG_VERSION } from "~/config/schema/index.js";
import { Framework } from "~/core/domain/index.js";
import { ExitCode } from "~/core/errors/index.js";

afterAll(removeTemporaryDirectories);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const CONFIG_NAME = "qat.config.json";
const BACKUP_NAME = `${CONFIG_NAME}.backup`;

/** The file `qat init` is expected to write, byte for byte. */
const EXPECTED_FILE = `{\n  "version": ${String(SUPPORTED_CONFIG_VERSION)},\n  "framework": "${Framework.Cypress}"\n}\n`;

/** The `--json` document, narrowed to the fields these assertions read. */
interface InitDocument {
  initialisation?: {
    outcome?: string;
    root?: string;
    path?: string;
    reason?: string;
    findings?: readonly {
      code?: string;
      severity?: string;
      explanation?: string;
    }[];
  };
}

/**
 * The value printed beside a label.
 *
 * Same column rule as the report presenter: labels are padded to ten characters, then one space, so a value begins at
 * eleven for any label that fits. The trailing space in the match matters — without it, a label that is a prefix of
 * another would match whichever came first.
 */
function valueOf(stdout: string, label: string): string | undefined {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith(`${label} `));

  return line === undefined
    ? undefined
    : line.slice(Math.max(label.length, 10) + 1).trim();
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Every name in the directory that is not a file this command is expected to write. */
async function strays(root: string): Promise<readonly string[]> {
  return (await readdir(root)).filter(
    (entry) => entry.endsWith(".tmp") || entry.endsWith(".backup"),
  );
}

/* -------------------------------------------------------------------------- */
/* The happy path                                                             */
/* -------------------------------------------------------------------------- */

describe("initialising a supported project", () => {
  it("creates the configuration and exits zero", async () => {
    const root = await temporaryProject();

    const result = await qat(["init", root]);

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(valueOf(result.stdout, "created")).toBe(join(root, CONFIG_NAME));
    expect(valueOf(result.stdout, "root")).toBe(root);
    expect(await exists(join(root, CONFIG_NAME))).toBe(true);
  });

  it("writes the smallest configuration the schema accepts", async () => {
    const root = await temporaryProject();

    await qat(["init", root]);

    // Written out rather than computed: the file is a user-facing artefact that somebody will review, diff and paste
    // into an issue, so its contents are asserted as contents.
    expect(await readFile(join(root, CONFIG_NAME), "utf8")).toBe(EXPECTED_FILE);
  });

  it("leaves the framework's own configuration untouched", async () => {
    const root = await temporaryProject();
    const cypressConfig = join(root, "cypress.config.ts");
    const before = await readFile(cypressConfig, "utf8");

    await qat(["init", root]);

    // The command's central promise. A snapshot would pass even if the file had been replaced by an identical one at a
    // different path, so the bytes are compared directly.
    expect(await readFile(cypressConfig, "utf8")).toBe(before);
  });

  it("adds one entry to the project and no more", async () => {
    const root = await temporaryProject();
    const before = await readdir(root);

    await qat(["init", root]);

    const after = await readdir(root);
    expect(after.sort()).toStrictEqual([...before, CONFIG_NAME].sort());
    // No output directory, in particular: directories are created when something is written, and nothing ran.
    expect(await exists(join(root, "results"))).toBe(false);
  });

  it("leaves no temporary and no backup behind", async () => {
    const root = await temporaryProject();

    await qat(["init", root]);

    // The create path is exclusive: it hard-links a temporary into place and removes the temporary. A `.backup` here would
    // mean something took a copy before a write — which is a replacement, and this command does not do one.
    expect(await strays(root)).toStrictEqual([]);
  });

  it("keeps standard error clean when it succeeds", async () => {
    const root = await temporaryProject();

    const result = await qat(["init", root]);

    // A successful command that also writes to stderr makes a pipeline's error output noise, and teaches whoever collects
    // it to ignore the stream.
    expect(result.stderr).toBe("");
  });

  it("accepts the directory through --cwd", async () => {
    const root = await temporaryProject();

    const result = await qat(["init", "--cwd", root]);

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(await exists(join(root, CONFIG_NAME))).toBe(true);
  });

  it("prefers the positional directory over --cwd", async () => {
    const argument = await temporaryProject();
    const option = await temporaryProject();

    const result = await qat(["init", argument, "--cwd", option]);

    // One precedence rule for every command, decided by the shared resolver rather than by this handler.
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(await exists(join(argument, CONFIG_NAME))).toBe(true);
    expect(await exists(join(option, CONFIG_NAME))).toBe(false);
  });

  it("initialises a project whose manifest is missing", async () => {
    // A missing manifest is advice, not a reason to refuse: the state this command is for is a fresh clone, which has no
    // installed dependencies either.
    const root = await temporaryWarningProject();

    const result = await qat(["init", root]);

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(await exists(join(root, CONFIG_NAME))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Running it twice                                                           */
/* -------------------------------------------------------------------------- */

describe("initialising an already initialised project", () => {
  it("exits zero and reports what it found", async () => {
    const root = await temporaryProject();

    await qat(["init", root]);
    const result = await qat(["init", root]);

    // The postcondition — this project has a configuration — is true, so a provisioning script that runs the command
    // twice must not fail on the second run.
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(valueOf(result.stdout, "exists")).toBe(join(root, CONFIG_NAME));
    expect(result.stdout).toContain("Nothing was changed");
  });

  it("leaves the file byte-identical, and takes no backup of it", async () => {
    const root = await temporaryProject();
    const path = join(root, CONFIG_NAME);

    await qat(["init", root]);
    const first = await readFile(path, "utf8");
    await qat(["init", root]);

    expect(await readFile(path, "utf8")).toBe(first);
    // A backup would mean the second run had decided to replace something. It decided not to write at all.
    expect(await strays(root)).toStrictEqual([]);
  });

  it("keeps a configuration the reader edited", async () => {
    const root = await temporaryProject({
      extra: {
        [CONFIG_NAME]: JSON.stringify({
          version: SUPPORTED_CONFIG_VERSION,
          framework: Framework.Cypress,
          output: { reports: "artifacts/runs", evidence: "artifacts/proof" },
        }),
      },
    });
    const path = join(root, CONFIG_NAME);
    const before = await readFile(path, "utf8");

    const result = await qat(["init", root]);

    // The most damaging thing this command could do. A reader's edits survive a re-run, spaces and all.
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("is not confused by a temporary file left by an interrupted run", async () => {
    const root = await temporaryProject();
    const stray = join(root, `.${CONFIG_NAME}.4242.0f0f0f0f.tmp`);
    await writeFile(stray, "partial");

    const result = await qat(["init", root]);

    // A crash can leave one of these; it is named so that nothing which reads a configuration will open it. This run
    // therefore proceeds, and does not remove something it did not create.
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(await readFile(join(root, CONFIG_NAME), "utf8")).toBe(EXPECTED_FILE);
    expect(await exists(stray)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

describe("a project that is not ready to be configured", () => {
  it("names the missing framework configuration", async () => {
    // Cypress is installed in this fixture and there is no `cypress.config.ts`, so detection succeeds and the missing
    // piece is the file. That is `QAT-D002`, not `QAT-D001` — a distinction the reader cares about, because the two have
    // different remedies.
    const root = await temporaryProject({ configured: false });

    const result = await qat(["init", root]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stdout).toContain("QAT-D002 error");
    expect(result.stdout).toContain("Create cypress.config.ts");
    expect(await exists(join(root, CONFIG_NAME))).toBe(false);
    // A project condition is described on stdout, so a caller can tell "found something to say" from "broke".
    expect(result.stderr).toBe("");
  });

  it("names an absent framework", async () => {
    // A bare directory: no manifest, no Cypress, no configuration. This is the case `QAT-D001` describes.
    const root = await temporaryDirectory();

    const result = await qat(["init", root]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stdout).toContain("QAT-D001 error");
    expect(result.stdout).toContain("Create cypress.config.ts");
    expect(await exists(join(root, CONFIG_NAME))).toBe(false);
    expect(result.stderr).toBe("");
  });

  it("names a configuration the framework does not load", async () => {
    const root = await temporaryProject({
      configured: false,
      extra: { "cypress/cypress.config.ts": "export default {};\n" },
    });

    const result = await qat(["init", root]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stdout).toContain("QAT-V001 error");
    expect(result.stdout).toContain("at:  cypress/cypress.config.ts");
    expect(result.stdout).toContain(
      "fix: Move it to the project root as cypress.config.ts.",
    );
    expect(await exists(join(root, CONFIG_NAME))).toBe(false);
  });

  it("does not create an output directory while refusing", async () => {
    const root = await temporaryProject({ configured: false });

    await qat(["init", root]);

    const entries = await readdir(root);
    expect(entries).not.toContain("results");
    expect(entries).not.toContain(CONFIG_NAME);
  });
});

describe("something already at the configuration path", () => {
  it.each([
    ["a malformed file", "{"],
    ["an empty file", ""],
    [
      "a file for another schema version",
      JSON.stringify({ version: 2, framework: Framework.Cypress }),
    ],
    [
      "a file with an unknown field",
      JSON.stringify({
        version: SUPPORTED_CONFIG_VERSION,
        framework: Framework.Cypress,
        reports: { directory: "out" },
      }),
    ],
  ])(
    "refuses to replace %s, and leaves it byte-identical",
    async (__case__, contents) => {
      const root = await temporaryProject({
        extra: { [CONFIG_NAME]: contents },
      });
      const path = join(root, CONFIG_NAME);

      const result = await qat(["init", root]);

      expect(result.exitCode).toBe(ExitCode.InvalidInput);
      expect(valueOf(result.stdout, "unusable")).toBe(path);
      // Nothing was written and nothing was removed: the reader decides what happens to their file. The bytes are read
      // back rather than compared with a snapshot, because "identical" is the claim.
      expect(await readFile(path, "utf8")).toBe(contents);
    },
  );

  it("says where a malformed file stops", async () => {
    const root = await temporaryProject({
      extra: { [CONFIG_NAME]: '{\n  "version": 1,\n}\n' },
    });

    const result = await qat(["init", root]);

    // A refusal that said only "invalid" would send the reader looking at every line.
    expect(result.stdout).toContain("not valid JSON");
    expect(result.stdout).toMatch(/line \d+ column \d+/u);
  });

  it("passes a schema code through rather than inventing one", async () => {
    const root = await temporaryProject({
      extra: {
        [CONFIG_NAME]: JSON.stringify({
          version: 2,
          framework: Framework.Cypress,
        }),
      },
    });

    const result = await qat(["init", root]);

    // The version check happens before the fields are examined, so this is one diagnostic and it is the schema's own.
    expect(result.stdout).toContain("QAT-C002");
  });

  it("refuses a directory sitting on the configuration name", async () => {
    const root = await temporaryProject({
      extra: { [`${CONFIG_NAME}/placeholder.txt`]: "" },
    });

    const result = await qat(["init", root]);

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    // The directory is still there: a refusal never removes what it found.
    expect(await exists(join(root, CONFIG_NAME))).toBe(true);
  });
});

describe("a directory that does not exist", () => {
  it("reports an argument defect on standard error", async () => {
    const missing = join(await temporaryDirectory(), "absent");

    const result = await qat(["init", missing]);

    // The one failure this command still throws for. A directory that is not there is not a property of a project, so it
    // is an error rather than a finding — and it arrives before anything is inspected.
    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(result.stderr).toContain("QAT1001");
    expect(result.stderr).toContain("is not a directory");
  });
});

/* -------------------------------------------------------------------------- */
/* A replacement that does not exist                                          */
/* -------------------------------------------------------------------------- */

describe("replacement", () => {
  it.each(["--force", "--replace", "--overwrite"])(
    "has no %s option",
    async (flag) => {
      const root = await temporaryProject();

      const result = await qat(["init", root, flag]);

      // The guarantee is the absence, so the absence is what is asserted. A flag that silently did nothing would pass a
      // test that only checked the file; an unknown option is rejected by the parser before the command runs, so the file
      // is not created and the message names what was refused.
      expect(result.exitCode).not.toBe(ExitCode.Success);
      expect(result.stderr).toContain(flag.replace(/^--/u, ""));
      expect(await exists(join(root, CONFIG_NAME))).toBe(false);
    },
  );

  it("does not replace a file when asked through the only option it has", async () => {
    // `init` takes a directory and nothing else. Running it again on an initialised project is the closest thing to a
    // replacement request a caller can make, and it writes nothing.
    const root = await temporaryProject({ extra: { [CONFIG_NAME]: "{" } });
    const path = join(root, CONFIG_NAME);

    await qat(["init", root]);

    expect(await readFile(path, "utf8")).toBe("{");
    expect(await exists(join(root, BACKUP_NAME))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The structured document                                                    */
/* -------------------------------------------------------------------------- */

describe("the structured document", () => {
  it("carries what was created, where", async () => {
    const root = await temporaryProject();

    const result = await qat(["init", root, "--json"]);

    expect(result.exitCode).toBe(ExitCode.Success);

    const document = JSON.parse(result.stdout) as InitDocument;

    // The published shape of the result, not a presentation of it: a consumer reads the same contract the command read.
    expect(document.initialisation?.outcome).toBe("created");
    expect(document.initialisation?.root).toBe(root);
    expect(document.initialisation?.path).toBe(join(root, CONFIG_NAME));
    expect(result.stderr).toBe("");
  });

  it("carries the reason when it refused", async () => {
    const root = await temporaryProject({ extra: { [CONFIG_NAME]: "{" } });

    const result = await qat(["init", root, "--json"]);

    const document = JSON.parse(result.stdout) as InitDocument;

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(document.initialisation?.outcome).toBe("existing-configuration");
    expect(document.initialisation?.reason).toBe("malformed");
    expect(document.initialisation?.findings?.length ?? 0).toBeGreaterThan(0);
  });

  it("carries the findings when the project was refused", async () => {
    const root = await temporaryProject({ configured: false });

    const result = await qat(["init", root, "--json"]);

    const document = JSON.parse(result.stdout) as InitDocument;

    expect(result.exitCode).toBe(ExitCode.InvalidInput);
    expect(document.initialisation?.outcome).toBe("project-not-usable");
    expect(document.initialisation?.findings?.map((one) => one.code)).toContain(
      "QAT-D002",
    );
  });

  it("writes one document to standard output and nothing to standard error", async () => {
    const root = await temporaryProject();

    const result = await qat(["init", root, "--json"]);

    // One line, so a streaming consumer need not buffer; and no human lines, prefixed or otherwise.
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stderr).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/* Non-functional                                                             */
/* -------------------------------------------------------------------------- */

describe("non-functional behaviour", () => {
  it("is deterministic", async () => {
    const first = await temporaryProject();
    const second = await temporaryProject();

    await qat(["init", first]);
    await qat(["init", second]);

    // Same input, same file: no timestamp, hostname or process id in what it writes.
    expect(await readFile(join(first, CONFIG_NAME), "utf8")).toBe(
      await readFile(join(second, CONFIG_NAME), "utf8"),
    );
  });

  it("does not depend on the working directory", async () => {
    const root = await temporaryProject();

    // The harness runs the binary from the repository root, which is not the project. A configuration that landed beside
    // the process rather than beside the project would be found here.
    const result = await qat(["init", root]);

    expect(valueOf(result.stdout, "created")).toBe(join(root, CONFIG_NAME));
    expect(await exists(join(root, CONFIG_NAME))).toBe(true);
  });
});
