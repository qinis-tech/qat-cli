/**
 * `qat init`.
 *
 * Creates a project's QAT configuration, or explains why it did not. The command's whole job is to decide *who* is asked
 * the question and *how* the answer is presented; every decision about whether the directory is a suitable project, what
 * the file should contain and whether anything is already there belongs to the service behind the port.
 *
 * ## It writes one file, and only that file
 *
 * The framework's own configuration is never read for editing, never rewritten and never moved. No directory is created:
 * a project that has been initialised but never run contains exactly one more file than it did before, and nothing else.
 * A command that scaffolded a tree of empty output folders would look helpful and would be the first thing anyone
 * deleted.
 *
 * ## It is create-only
 *
 * If a configuration is already there — valid, broken, or empty — the command reports what it found and exits non-zero.
 * It does not repair, merge into, or back up what somebody else wrote. A tool that silently replaced a file it did not
 * write would be one mistyped path away from destroying a project's settings, and the reader would have no way to tell it
 * had happened.
 *
 * ## It does not throw for a project condition
 *
 * A directory with no Cypress configuration, one in a format nothing reads, a configuration where the framework does not
 * load it: all of those are conditions worth describing, and an exception describes none of them. This is the same
 * division `qat doctor` makes, and for the same reason.
 *
 * The one failure that still arrives as an error is a directory that does not exist. That is a defect in the argument
 * rather than a property of a project, and it is raised by the shared resolver before this handler does anything.
 *
 * ## Where the presentation lives
 *
 * In `../output/initialisation.js`, as a pure function over the result. A command that built its own strings would
 * eventually disagree with the report beside it about a label or a blank line, and the disagreement would be invisible
 * until somebody compared two outputs.
 */
import { InitialisationOutcome } from "../../core/application/initialisation.js";
import { ExitCode } from "../../core/errors/index.js";
import type { CommandDefinition } from "../contracts.js";
import { initialisationLines } from "../output/initialisation.js";
import { reportResult } from "../output/report.js";

/**
 * The status each outcome earns.
 *
 * Declared as a `Record` over the outcome union so that adding an outcome without deciding its status is a compile error
 * rather than a runtime `undefined` handed to the process. One mapping, from one field: everything that decided *why* a
 * result came out this way is already on the result.
 *
 * `already-initialised` earns success. The postcondition a caller cares about — this project has a QAT configuration — is
 * true, and a provisioning script that runs `qat init` twice must not fail on the second run. The status answers "is the
 * project configured", not "did this particular call do the work".
 *
 * `existing-configuration` earns failure even though the project may be perfectly healthy: something is in the way that
 * only a person can resolve, and a script that continued past it would be operating on a file it did not understand.
 */
const STATUS: Readonly<Record<InitialisationOutcome, ExitCode>> = {
  [InitialisationOutcome.Created]: ExitCode.Success,
  [InitialisationOutcome.AlreadyInitialised]: ExitCode.Success,
  [InitialisationOutcome.ExistingConfiguration]: ExitCode.InvalidInput,
  [InitialisationOutcome.ProjectNotUsable]: ExitCode.InvalidInput,
};

export const initCommand: CommandDefinition = {
  name: "init",
  summary: "Create a QAT configuration for this project",
  description: [
    "Writes qat.config.json at the project root so the project can be inspected and run. The file contains only the two settings that have no default — the configuration version and the framework — because everything else is documented and filled in when a command needs it.",
    "Requires a directory QAT recognises as a Cypress project. Never modifies the framework's own configuration, never creates an output directory, and never replaces a qat.config.json that is already present, including one that cannot be read.",
  ].join("\n\n"),
  arguments: [
    {
      name: "directory",
      description:
        "project to initialise; overrides --cwd, and defaults to the working directory",
      required: false,
    },
  ],
  examples: ["qat init", "qat init ./packages/api", "qat init --json"],
  async run({ application, arguments: values, options }) {
    // Resolved before anything is inspected, and by the shared resolver rather than here. A command that worked out its
    // own precedence would eventually work it out slightly differently from its neighbours, and an invalid directory
    // would reach the service before anyone noticed — turning a bad argument into a misleading statement about a
    // project.
    const { directory } = await application.discovery.resolveWorkingDirectory({
      argument: values["directory"],
      option: options.cwd,
    });

    // One call. The service judges the project, checks the path, generates, validates and creates; this handler learns
    // only which of the four outcomes occurred. Passing `options.json` down would hand presentation to a layer that has
    // no business forming a sentence for a terminal.
    const result = await application.initialisation.initialise(directory);

    reportResult(
      {
        // The rendered lines are the human answer and are omitted entirely under `--json`, which is what keeps a
        // redirected stdout parseable.
        lines: initialisationLines(result),
        // The document is the result itself, wrapped rather than bare, so a later field can be added without changing the
        // shape a consumer parses today — and so an unknown outcome cannot be represented.
        document: { initialisation: result },
      },
      { json: options.json },
    );

    // The report is the message: a refusal has already printed its codes, its files and its remedies, and the status says
    // the command failed without saying anything twice.
    return STATUS[result.outcome];
  },
};
