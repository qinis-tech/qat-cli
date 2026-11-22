#!/usr/bin/env node
/**
 * The process boundary.
 *
 * Reads the version, builds the program, and turns whatever comes back into an exit code. It holds no
 * application logic and no command behaviour: everything it could have done lives in a command or in
 * the assembly.
 *
 * ## Exit codes
 *
 * Set by assignment, never by `process.exit()`. Calling exit truncates piped stdout, which loses the
 * message the user needs, and it is banned outside `src/core/process` for that reason.
 *
 * ## Why Commander's errors are handled separately
 *
 * `exitOverride` makes the parser throw instead of exiting. A usage error (`--nope`) already carries a
 * good message that Commander has printed; wrapping it in this project's error rendering would print
 * it twice. So a `CommanderError` contributes an exit code and nothing else.
 */
import { fileURLToPath } from "node:url";

import { CommanderError } from "commander";

import { createApplication } from "../app/index.js";
import {
  ExitCode,
  describeError,
  exitCodeForError,
} from "../core/errors/index.js";
import { readJson } from "../core/filesystem/index.js";

import { COMMANDS } from "./commands/index.js";
import { reportError } from "./output/report.js";
import { createProgram, readGlobalOptions } from "./program.js";

/**
 * The package version, read from the manifest beside the compiled output.
 *
 * `../../package.json` resolves to the package root from both `dist/cli/index.js` and
 * `src/cli/index.ts`, so the same code works compiled and under a runner.
 */
async function readVersion(): Promise<string> {
  const manifest = await readJson<{ version?: unknown }>(
    fileURLToPath(new URL("../../package.json", import.meta.url)),
  );

  // A published package always has one; a development tree occasionally does not. Reporting `0.0.0`
  // is better than failing to start over a version string.
  return typeof manifest.version === "string" ? manifest.version : "0.0.0";
}

async function main(): Promise<void> {
  const program = createProgram(
    await readVersion(),
    {
      createApplication: (overrides) => createApplication(overrides),
    },
    COMMANDS,
  );

  try {
    await program.parseAsync(process.argv);

    // Only defaulted, never forced. A command that has run tests is entitled to set `1`, and an
    // assignment here would silently overwrite it — which would make every failing run look like a
    // passing one.
    process.exitCode ??= ExitCode.Success;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version are not failures: the user asked for something and got it. Everything else
      // the parser rejects is a usage error, which the contract calls invalid input.
      process.exitCode =
        error.exitCode === 0 ? ExitCode.Success : ExitCode.InvalidInput;
      return;
    }

    const options = readGlobalOptions(program);

    reportError(describeError(error, { includeDiagnostics: options.debug }), {
      json: options.json,
    });

    process.exitCode = exitCodeForError(error);
  }
}

try {
  await main();
} catch (error) {
  // Reached only if the program could not be built — a missing or malformed manifest, most likely.
  // Diagnostics and JSON output are unavailable because no options were parsed, so this is
  // deliberately plain.
  process.stderr.write(`error: ${describeError(error).message}\n`);
  process.exitCode = exitCodeForError(error);
}
