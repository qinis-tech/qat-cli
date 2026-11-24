/**
 * `qat doctor`.
 *
 * The one command registered today, and the tool's whole user-facing answer to "what can you see about this project".
 * It is registered because its capability exists — detection, diagnosis and validation between them can answer the
 * question — and registering it with a stub handler would have put a command in `--help` that does nothing.
 *
 * ## It reports; it does not repair
 *
 * Nothing here writes, installs, or modifies a configuration file, and nothing here executes the framework — not even
 * to ask it a question. A command that silently changed the project would be a different command with a different
 * name, and the change would happen on the machine where nobody expected it.
 *
 * It does not create the output directories either. Those appear when a run first has something to write into them, so
 * a project that has been inspected but never run contains exactly one file: its configuration.
 *
 * ## It coordinates; it does not detect
 *
 * Three calls, all of them to a service: resolve which directory, ask what is there, and print the answer. There is no
 * threshold, no filename and no rule in this file. Everything it shows was decided by a layer that owns the decision,
 * which is what keeps the report honest as those layers change.
 *
 * ## Where the output locations come from
 *
 * The resolved configuration arrives *inside* the assessment rather than from a fourth call. Two reasons, and the
 * second is the one that matters:
 *
 * - This command's own description promises "the configuration QAT would use", so a report that could not say where a
 *   run would write would be answering a narrower question than it claims to.
 * - Reading it separately would mean a second read of one tree, and a second failure path — one that throws where this
 *   report describes. That is the same reasoning that removed the spec directory and the package manager from this
 *   output: one call, one tree, one answer.
 *
 * The value is already anchored and already defaulted by the time it reaches here, which is why this file contains no
 * path arithmetic. A handler that joined a configured path to a root would be re-deciding something the resolution
 * stage owns, and doing it with the working directory rather than the project root.
 *
 * ## It does not throw for a project condition
 *
 * A directory with no configuration, two competing configurations, a configuration in a format nothing reads: all of
 * them are conditions worth describing, and an exception describes none of them. So the command asks for an
 * assessment, prints every condition with its code, its file and its remedy, and returns a status. A caller checking
 * `$?` sees the failure; a reader sees why.
 *
 * A refused output path is one of those conditions, reported the same way. It blocks the assessment upstream — a
 * project whose reports cannot be placed is not one this command should call ready — so the exit status needs no extra
 * rule here.
 *
 * The one failure that still arrives as an error is a directory that does not exist. That is a defect in the
 * argument, not a property of a project, and it is raised by the shared resolver before this handler does anything.
 *
 * ## What it stopped printing, and why
 *
 * Two lines left this report when it moved from the project description to the assessment: the spec directory and the
 * package manager. Both are facts about a project's *shape*, and the assessment carries facts about its
 * *correctness* — which is the question this command now answers. They return when the project description is rebuilt
 * on the assessment, at which point one call answers both; reintroducing `discover` here would mean two reads of one
 * tree and a second failure path that throws where this one reports.
 *
 * ## Where the presentation lives
 *
 * In `../output/diagnostics.js`, as pure functions over an assessment. A command that built its own strings would
 * eventually disagree with its neighbour about a label or a blank line, and the disagreement would be invisible until
 * somebody compared two outputs.
 */
import type { CommandDefinition } from "../contracts.js";
import { exitCodeFor, reportLines } from "../output/diagnostics.js";
import { reportResult } from "../output/report.js";

export const doctorCommand: CommandDefinition = {
  name: "doctor",
  summary: "Report what QAT can see about this project",
  description: [
    "Inspects the project in the given directory and reports what was found: the package identity, whether the framework is declared and where its installation came from, the configuration QAT would use and where it would write, and every condition that would prevent a run.",
    "Each condition is printed with the code it is known by, the file it concerns, and what to do about it. Exits non-zero when a blocking condition is found, having printed it; warnings do not affect the exit status.",
  ].join("\n\n"),
  arguments: [
    {
      name: "directory",
      description:
        "directory to inspect; overrides --cwd, and defaults to the working directory",
      required: false,
    },
  ],
  examples: ["qat doctor", "qat doctor ./packages/api", "qat doctor --json"],
  async run({ application, arguments: values, options }) {
    // Resolved before assessment, and by the shared resolver rather than here. A command that worked out its own
    // precedence would eventually work it out slightly differently from its neighbours, and an invalid directory
    // would reach the service before anyone noticed — turning a bad argument into a misleading report about a project.
    const { directory } = await application.discovery.resolveWorkingDirectory({
      argument: values["directory"],
      option: options.cwd,
    });

    // One call, and it never throws for a project condition. Everything printed below came from it, including the
    // verdict and the anchored output locations, so the lines on screen and the status returned cannot disagree about
    // what was found.
    const assessment = await application.discovery.assess(directory);

    reportResult(
      {
        // The configuration is forwarded as-is. `reportLines` omits the block entirely when it is absent — a project
        // whose configuration could not be read has nowhere to write, and inventing a location would be worse than
        // saying nothing.
        lines: reportLines(assessment, assessment.configuration),
        // Wrapped rather than bare, so a later field can be added without changing the shape a consumer parses today.
        // The document is the assessment itself rather than a presentation of it: a consumer reads the same contract
        // this command read, so a field added to the contract appears without the document changing — which is how the
        // resolved paths reach `--json` with no code here.
        document: { assessment },
      },
      { json: options.json },
    );

    // The report is the message. A blocked project has been described above, and the exit status says the command
    // failed without saying anything twice.
    return exitCodeFor(assessment);
  },
};
