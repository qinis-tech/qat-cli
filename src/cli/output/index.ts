/**
 * Everything the CLI writes to the user.
 *
 * Two streams with two jobs, and the asymmetry is deliberate: standard output carries a command's *result*, standard
 * error carries everything else. A command that failed has no result, so its explanation must not appear where a
 * consumer is reading results — and a successful command must write nothing at all to standard error, or a pipeline's
 * error output becomes noise.
 *
 * Nothing here knows about colour, width or the terminal. That is a rendering decision for later, and getting it wrong
 * now would bake an escape code into a `--json` consumer's input.
 *
 * ## The surface, and who calls it
 *
 * | Export | Writes to | Called by |
 * | --- | --- | --- |
 * | `reportResult` | standard output | A command that produced something |
 * | `reportError` | standard error | The entry point, once, after a failure |
 * | `reportLines` | nothing | A command, to build the lines it hands to `reportResult` |
 * | `exitCodeFor` | nothing | A command, to decide the status it returns |
 * | `hasFindings` | nothing | A command that wants to know whether its report is clean |
 *
 * The last three are pure: they take a value and return lines or a status. That is what lets the shape of a report be
 * tested without launching a CLI, and it is why they are here rather than inside the one command that uses them today.
 *
 * ## Why this file contains no logic
 *
 * A barrel that also holds a function is a function nothing measures — `src/**\/index.ts` is excluded from coverage on
 * the grounds that a barrel contains nothing to measure, and a helper placed here would be invisible to the report
 * without anyone noticing. It is also the file least likely to be read closely: an import list looks like plumbing, so
 * a mistake in it survives review that would catch the same mistake one file over.
 *
 * Everything the CLI writes is therefore in a sibling, and this file only says which siblings a command may reach.
 */
export { exitCodeFor, reportLines } from "./diagnostics.js";
export { reportError } from "./messages.js";
export { reportResult } from "./report.js";
