#!/usr/bin/env node
/**
 * The process boundary.
 *
 * Resolves the version, builds the program, and turns whatever comes back into an exit code. It holds
 * no application logic and no command behaviour: everything it could have done lives in a command or in
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
 * good message that Commander has printed; wrapping it in this project's error rendering would print it
 * twice. So a `CommanderError` contributes an exit code and nothing else.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { CommanderError } from "commander";

import { createApplication } from "../app/index.js";
import {
  ExitCode,
  describeError,
  exitCodeForError,
} from "../core/errors/index.js";

import { COMMANDS } from "./commands/index.js";
import { reportError } from "./output/report.js";
import { createProgram, readGlobalOptions } from "./program.js";
import { resolveVersion } from "./version.js";

async function main(): Promise<void> {
  // Resolved from this module's own directory rather than a fixed relative depth, so a change to the
  // output layout cannot silently point at a file that is not there. It runs before the program is
  // built because the version is program metadata.
  const { version } = await resolveVersion(
    dirname(fileURLToPath(import.meta.url)),
  );

  const program = createProgram(
    version,
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
      // Help and version are not failures: the user asked for something and got it. Everything else the
      // parser rejects is a usage error, which the contract calls invalid input.
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
  // Reached before the program exists — a damaged installation, most likely, since nothing else can
  // fail this early. Options have not been parsed, so `--json` and `--debug` are unavailable and this is
  // deliberately plain.
  const rendered = describeError(error);

  // The code is included because it is the one thing worth quoting in a bug report, and this path has no
  // other way to identify the failure.
  process.stderr.write(`error ${rendered.code}: ${rendered.message}\n`);

  process.exitCode = exitCodeForError(error);
}
