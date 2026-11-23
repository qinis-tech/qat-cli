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
 * ## Plain ASCII
 *
 * No em dash, no arrow, no bullet. They render correctly in a document and become mojibake in a console using a
 * legacy code page, and the reader who gets a broken character has no way to tell whether the tool is broken. A
 * colon and two spaces cost nothing.
 *
 * ## What this module does not decide
 *
 * Whether the project is usable, what the findings mean, and what any of them should say. It reads a diagnosis and a
 * gate and lays them out. The only judgement it makes is the exit status, and even that is a mapping from one field
 * rather than a rule.
 */
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
 * The whole human-readable report.
 *
 * Blocking conditions first, then warnings, separated by a blank line: the gate already orders them that way, and a
 * reader who stops after the first block has still read the reason the command failed.
 *
 * An empty list of findings adds nothing at all — not a heading, not a trailing blank line. A clean report is nine
 * lines, which is what makes it recognisably clean.
 */
export function reportLines(assessment: ProjectAssessment): readonly string[] {
  const { blocking, warnings } = assessment.gates[QatOperation.Execute];

  return [
    ...summary(assessment),
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
