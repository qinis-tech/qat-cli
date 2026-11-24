/**
 * Presenting an assessment.
 *
 * Pure functions over a value: an assessment in, lines or a status out. No stream, no clock, no filesystem, which is
 * what lets the report shape be tested without launching a CLI and lets the same shape be reused by a future report
 * generator that wants to print what a terminal prints.
 *
 * ## Why the presentation lives here and not in the command
 *
 * A command handler that builds its own strings will eventually disagree with its neighbour — a label here, a blank
 * line there — and the disagreement is invisible until someone compares two outputs. One module means one answer to
 * "what does QAT's report look like", and the command stays the six lines that decide *when* to print.
 *
 * ## Why the output locations are in the report
 *
 * Defaults and anchoring are invisible in a configuration file: the reader wrote nothing, or wrote a relative path, and
 * the tool chose an absolute one. A report that does not say where reports and evidence will land leaves the most
 * consequential decision of the run undocumented — and the first time it matters is the first time it is wrong.
 *
 * ## Two indents, two jobs
 *
 * A summary row is a label and a value on one line, aligned into a column. A finding block is a header with a body: the
 * code stays flush so the codes form one scannable column, and everything describing it hangs two spaces beneath. Both
 * are asserted positionally in `tests/unit/cli/diagnostics.test.ts`, because whitespace that nothing checks is
 * whitespace that drifts.
 *
 * ## Plain ASCII
 *
 * No em dash, no arrow, no bullet. They render correctly in a document and become mojibake in a console using a legacy
 * code page, and the reader who gets a broken character has no way to tell whether the tool is broken. A colon and two
 * spaces cost nothing.
 *
 * ## What this module does not decide
 *
 * Whether the project is usable, what the findings mean, and what any of them should say. It reads a diagnosis, a gate
 * and a resolved configuration and lays them out. The only judgement it makes is the exit status, and even that is a
 * mapping from one field rather than a rule.
 */
import type {
  ResolvedEnvironment,
  ResolvedProjectConfiguration,
} from "../../core/application/configuration.js";
import {
  QatOperation,
  isExecutable,
  type AnyDiagnosticFinding,
  type ProjectAssessment,
} from "../../core/application/validation.js";
import { Framework } from "../../core/domain/index.js";
import { ExitCode } from "../../core/errors/index.js";

/** Every label padded to this width, so a longer label added later cannot misalign the column beside it. */
const LABEL_WIDTH = 10;

function row(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)} ${value}`;
}

/**
 * One block per condition, in the order the gate lists them.
 *
 * The code comes first because it is the thing a reader quotes in a bug report and the thing a script greps for. The
 * severity is beside it rather than as a separate heading, because a reader scanning for the word `error` should find
 * it without reading a sentence first.
 *
 * The detail lines are indented two spaces and the header is not. That keeps the left column a scannable list of codes:
 * a reader running an eye down the report sees `QAT-V001`, `QAT-D005`, `QAT-D010` in one straight line, while the
 * sentences that explain them hang beneath their code instead of competing with it. With two conditions in one report
 * the difference stops being cosmetic.
 *
 * `at:` and `fix:` are omitted when absent rather than printed empty: a line saying `at: (none)` is noise, and a
 * consumer parsing a report should be able to tell "no file" from "a file named (none)".
 */
function findingBlock(finding: AnyDiagnosticFinding): readonly string[] {
  return [
    `${finding.code} ${finding.severity}`,
    `  ${finding.explanation}`,
    ...(finding.path === undefined ? [] : [`  at:  ${finding.path}`]),
    ...(finding.remediation === undefined
      ? []
      : [`  fix: ${finding.remediation}`]),
  ];
}

/** Who the project is, what was found about the framework, and what that adds up to. */
function summary(assessment: ProjectAssessment): readonly string[] {
  const { identity, framework, detection, compatibility } =
    assessment.diagnosis;
  const installation = framework.installation;
  const declaration = framework.declaration;

  return [
    row("project", identity.name),
    row("root", identity.root),
    // The status, not the version: the project's own name is already on the `project` line, and its version is on the
    // `framework` line when it is installed. This answers the question the status exists for — could the manifest be
    // read at all.
    row("package", identity.packageMetadata),
    row(
      "framework",
      installation === undefined
        ? `${Framework.Cypress} (not installed)`
        : `${installation.framework} ${installation.version} (${installation.source} install)`,
    ),
    row(
      "declared",
      declaration === undefined
        ? "nowhere in this package"
        : `${declaration.section} (${declaration.range})`,
    ),
    row("config", framework.configuration ?? "(none)"),
    row("detection", detection),
    row("compatibility", compatibility),
    // Last, because it is the conclusion the lines above argue for — and the one line a script or a reader looks for.
    row("result", assessment.gates[QatOperation.Execute].readiness),
  ];
}

/**
 * Which environment a run will use, and whether the tool chose it.
 *
 * The four cases are worded differently on purpose. "The only one declared" tells an operator that declaring a second
 * environment will stop this being automatic, and "none selected" tells them the run has no target at all: that
 * sentence is the one thing this report can say that saves a failure later, so it says what to do as well as what is
 * missing.
 */
function environmentText(environment: ResolvedEnvironment): string {
  switch (environment.origin) {
    case "configured":
      return `${environment.name} (from defaultEnvironment)`;
    case "declared":
      return `${environment.name} (the environment named "default")`;
    case "sole":
      return `${environment.name} (the only one declared)`;
    case "none":
      return "none selected; declare one, or set defaultEnvironment";
  }
}

/**
 * Where this run will write, and against which environment.
 *
 * Absolute paths only. The configured form is deliberately not repeated beside them: a line reading
 * `results/reports -> /work/proj/results/reports` is longer, harder to scan, and answers a question — "what did I
 * write?" — that the reader can answer by opening the file they just edited. What they cannot answer alone is where the
 * tool decided to land.
 *
 * These rows are label/value pairs, so they are not indented: the indent belongs to a finding's body, not to a summary.
 */
export function configurationLines(
  configuration: ResolvedProjectConfiguration,
): readonly string[] {
  return [
    row("reports", configuration.reportsDirectory.absolute),
    row("evidence", configuration.evidenceDirectory.absolute),
    // Present only when the project or its configuration supplied one. Label shortened to keep the column: `row` pads
    // to ten characters and a longer label would shift the value beside it.
    ...(configuration.frameworkConfigFile === undefined
      ? []
      : [row("config", configuration.frameworkConfigFile.absolute)]),
    row("env", environmentText(configuration.environment)),
  ];
}

/**
 * The whole human-readable report.
 *
 * Summary, then where the run will write, then blocking conditions, then warnings. The configuration block sits above
 * the findings because it describes what will happen, not what is wrong with it; the gate already orders blocking
 * before warnings, and a reader who stops after the first finding block has still read the reason the command failed.
 *
 * An empty list of findings adds nothing at all — not a heading, not a trailing blank line. A clean report is the
 * summary, one configuration block and no findings, which is what makes it recognisably clean.
 *
 * The configuration argument is optional so a caller that has no resolved configuration — a run whose configuration
 * failed to load, and therefore has nowhere to write — produces exactly the report it produced before. It is not a
 * default: absence means "not known", and the report then says nothing rather than inventing a location.
 */
export function reportLines(
  assessment: ProjectAssessment,
  configuration?: ResolvedProjectConfiguration,
): readonly string[] {
  const { blocking, warnings } = assessment.gates[QatOperation.Execute];

  return [
    ...summary(assessment),
    ...(configuration === undefined
      ? []
      : ["", ...configurationLines(configuration)]),
    ...(blocking.length === 0 ? [] : ["", ...blocking.flatMap(findingBlock)]),
    ...(warnings.length === 0 ? [] : ["", ...warnings.flatMap(findingBlock)]),
  ];
}

/**
 * The status the command returns.
 *
 * A blocked project is invalid input to this command — it named a directory that cannot be used — so it exits the way
 * every other bad input does. Warnings exit zero: a manifest with no name is worth reading and not worth failing
 * somebody's pipeline over, and a tool that fails on advice is a tool people pass `|| true` to.
 *
 * One mapping, from one field. Everything that decided *why* the project is blocked has already been recorded on the
 * findings, so this function has nothing left to judge.
 */
export function exitCodeFor(assessment: ProjectAssessment): ExitCode {
  return isExecutable(assessment) ? ExitCode.Success : ExitCode.InvalidInput;
}
