import { DiagnosticCode } from "../core/application/diagnostics.js";
import type { InitialisationFinding } from "../core/application/initialisation.js";
import {
  QatOperation,
  type ProjectAssessment,
} from "../core/application/validation.js";

/**
 * Conditions that do not stop initialisation, even though they stop a run.
 *
 * All four are about what is missing from *the machine* rather than from *the project*: a dependency that is declared
 * but not installed, a manifest that is absent or incomplete, a dependency installed but undeclared. A team clones a
 * repository, initialises it, and installs afterwards — and a tool that insisted on the install first would be unusable
 * in exactly the moment it is most useful.
 *
 * `ManifestUnreadable` is deliberately absent. A `package.json` that is not JSON means detection cannot be relied on,
 * and configuring a project whose manifest is broken hides the real problem behind a second file.
 *
 * The set is an allow-list rather than a deny-list so that a new blocking condition blocks initialisation until somebody
 * decides otherwise. Default-deny is the safe direction: the cost of wrongly refusing is a message a reader can act on;
 * the cost of wrongly accepting is a configuration file in a project that cannot use it.
 */
export const INSTALLATION_ONLY: ReadonlySet<string> = new Set<string>([
  DiagnosticCode.DependencyNotInstalled,
  DiagnosticCode.ManifestMissing,
  DiagnosticCode.ManifestIncomplete,
  DiagnosticCode.DependencyUndeclared,
]);

/**
 * The findings that stop initialisation, from an assessment that already gathered them.
 *
 * Read from the Execute gate rather than by re-deriving anything: the gate is the one place that knows which conditions
 * block a run, and subtracting the installation-only ones is a smaller, safer statement than listing what blocks.
 */
export function unusableProjectFindings(
  assessment: ProjectAssessment,
): readonly InitialisationFinding[] {
  return assessment.gates[QatOperation.Execute].blocking
    .filter((finding) => !INSTALLATION_ONLY.has(finding.code))
    .map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      explanation: finding.explanation,
      ...(finding.path === undefined ? {} : { path: finding.path }),
      ...(finding.remediation === undefined
        ? {}
        : { remediation: finding.remediation }),
    }));
}
