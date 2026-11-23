/**
 * The gate.
 *
 * The one place a command is refused. Kept apart from the assessment because deciding is a pure operation on
 * data while refusing is an effect: a test can assert every verdict without an exception, and the single throw
 * lives where a command can see it.
 */
import {
  OperationReadiness,
  type QatOperation,
  type ProjectAssessment,
} from "../../core/application/validation.js";
import { ErrorCode, InvalidProjectError } from "../../core/errors/index.js";

/**
 * Refuses an operation the assessment says cannot proceed.
 *
 * For `execute` this throws when any finding has severity error. For `inspect` it can never throw, because
 * inspection is never blocked — which is the reason the operation set exists rather than a single "may I use
 * this project" question.
 *
 * The message states the first blocking condition rather than counting them: a reader fixes one thing at a
 * time, and the full list is in the context and in the assessment.
 *
 * @throws {InvalidProjectError} `QAT2005` when the operation is blocked.
 */
export function assertReadyFor(
  assessment: ProjectAssessment,
  operation: QatOperation,
): void {
  const gate = assessment.gates[operation];

  if (gate.readiness !== OperationReadiness.Blocked) return;

  const root = assessment.diagnosis.identity.root;
  const [first] = gate.blocking;

  throw new InvalidProjectError(
    ErrorCode.projectInvalid,
    `The project at ${root} cannot be used for ${operation}: ${
      first?.explanation ?? "validation found a blocking condition."
    }`,
    {
      context: {
        root,
        operation,
        blocking: gate.blocking.map((finding) => finding.code).join(", "),
      },
      remediation:
        first?.remediation ??
        "Run qat doctor to see everything that was found.",
    },
  );
}
