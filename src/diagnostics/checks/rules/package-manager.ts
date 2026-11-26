/**
 * The package-manager health rule.
 *
 * Pure: it reads gathered evidence and returns a verdict. No filesystem, no process, no clock, no dependency bag. The
 * snapshot is captured and PATH is searched by the workflow that gathers facts; this file only decides which of the
 * conditions it was told about is worth telling the reader first.
 *
 * ## Why this is one check and not several
 *
 * The conditions form a ladder, and the rungs are mutually exclusive in practice: nothing identified the tool, so there
 * is no version to compare; the binary is absent, so no version could be read; the tree was created by another tool, so
 * "not installed" is not the story. Reporting every rung at once would present consequences of one cause as separate
 * problems — the same reasoning that makes a failed precondition skip a check rather than fail it.
 *
 * The ladder's order is the order a reader fixes things in, so the first applicable rung is also the most useful one:
 *
 *   1. identity      — nothing identified, unusable declaration, unsupported tool
 *   2. agreement     — two lockfiles, or a declaration that contradicts the footprint
 *   3. tooling       — the binary is not on PATH
 *   4. version       — the binary disagrees with what the project declares, or would not say
 *   5. installation  — dependencies created by another tool, or never installed
 *
 * ## What this rule does not do
 *
 * It does not compare versions itself. The requirement arrives as evidence (`required`) and the comparison is delegated
 * to the one compatibility engine, so the range quoted in the message is the range that was actually applied. It also
 * does not repair anything: a diagnostic that changes what it inspects cannot be trusted to describe it.
 *
 * ## Severity
 *
 * The whole check is advisory. A missing or mismatched package manager does not stop QAT from running an
 * already-installed suite — it predicts a confusing install later — so every finding here is `warn` and never `fail`.
 * Strict mode is how a team opts into blocking; the catalogue test holds this check to `warning` so that decision
 * cannot drift.
 */
import {
  CheckCategory,
  CheckId,
  CheckSeverity,
  HealthCode,
} from "../../../core/application/checks.js";
// The current name. `evaluateRequirement` and the runtime-era requirement types survive in `core/compatibility` as
// deprecated aliases so that call sites in flight keep compiling, and this file — which compares a third kind of version
// — is precisely the one that should not be adding to their number.
import { evaluateVersionRequirement } from "../../../core/compatibility/index.js";
import {
  FactGroup,
  PASS,
  present,
  requireFact,
  type CheckDefinition,
  type CheckFacts,
  type CheckVerdict,
  type PackageManagerFacts,
} from "../contracts.js";
import { healthFinding } from "../guidance.js";

/**
 * The check.
 *
 * `requires` names the single group it reads, so the runner can skip it cleanly when the workflow could not gather
 * package-manager evidence — which is a fact about the assembly, not about the project.
 *
 * The scenario identifiers are prefixed by this check's own identifier, as the register requires: each one proves a rung
 * the ladder can reach, plus the pass case, so "every branch has a test" is a list someone can count rather than a claim
 * someone has to trust.
 */
export const packageManagerCheck: CheckDefinition = {
  id: CheckId.PackageManager,
  category: CheckCategory.PackageManager,
  title: "Package manager",
  purpose:
    "Every remedy for a missing dependency names a package manager, and a project whose tooling is inconsistent gets advice the reader has to translate.",
  procedure:
    "Walks the package-manager conditions in the order a reader fixes them, from identification through tooling and version agreement to installation state.",
  requires: [FactGroup.PackageManager],
  severity: CheckSeverity.Warning,
  scenarios: [
    "environment.package-manager.declared",
    "environment.package-manager.inferred",
    "environment.package-manager.none",
    "environment.package-manager.declaration-invalid",
    "environment.package-manager.unsupported",
    "environment.package-manager.conflicting",
    "environment.package-manager.executable-missing",
    "environment.package-manager.version-mismatch",
    "environment.package-manager.version-unverified",
    "environment.package-manager.not-installed",
    "environment.package-manager.foreign-install",
  ],
  // Parameter and return types are supplied by the annotation above. Writing them again is not wrong, but it is a
  // second statement of the same signature — and the one that cannot be checked against `CheckDefinition` for drift.
  evaluate: (facts) => {
    const verdict = decide(present(facts.packageManager), facts);

    return verdict ?? PASS;
  },
};

/**
 * Applies the ladder. Returns `undefined` when nothing is wrong.
 *
 * Returning `undefined` rather than `PASS` keeps the "is there a finding at all" question in one place: the caller has
 * exactly one branch to read, and every rung below returns a verdict or falls through to the next attempt.
 */
function decide(
  group: PackageManagerFacts,
  facts: CheckFacts,
): CheckVerdict | undefined {
  const { selection } = group;

  // ── 1. Identity ────────────────────────────────────────────────────────────

  if (selection.status === "undeclared") {
    // An unusable declaration is not the same as no declaration: the project tried, and the reader should be shown what
    // they wrote. A manager we do not recognise is reported as unsupported rather than malformed, because the value is
    // well-formed and the problem is our policy, not their file.
    if (selection.declaration !== undefined) {
      return warn(
        selection.declaration.problem === "unknown-manager"
          ? HealthCode.PackageManagerUnsupported
          : HealthCode.PackageManagerDeclarationInvalid,
        facts,
      );
    }

    return warn(HealthCode.PackageManagerUnknown, facts);
  }

  if (selection.status === "unsupported")
    return warn(HealthCode.PackageManagerUnsupported, facts);

  // ── 2. Agreement ───────────────────────────────────────────────────────────

  // Reported before anything about the tool, because we do not know which tool to ask about: two candidates means the
  // answer to "is pnpm installed" would be true and irrelevant.
  if (selection.status === "conflicting")
    return warn(HealthCode.PackageManagerConflicting, facts);

  // ── 3. Tooling ─────────────────────────────────────────────────────────────

  // Required, not optional, once identity is known: a gatherer that identified a manager and did not look for its binary
  // has left a hole, and `requireFact` says so loudly instead of letting the check claim health it never examined. The
  // facts type marks this optional because an unidentified manager has no binary to look for.
  const executable = requireFact(
    group.executable,
    "the package manager executable state",
  );

  if (!executable.resolved)
    return warn(HealthCode.PackageManagerExecutableMissing, facts);

  // ── 4. Version ─────────────────────────────────────────────────────────────

  const required = group.required;

  if (required !== undefined) {
    if (executable.version !== undefined) {
      const comparison = evaluateVersionRequirement(
        {
          // `'package-manager'` is a member of the widened source union. Before the widening this literal was the reason
          // a hand-written cast appeared at the call site, which is exactly the kind of value that should be checked by
          // the compiler rather than trusted.
          source: "package-manager",
          range: required.range,
          origin: required.origin,
          severityWhenUnsatisfied: "warning",
        },
        executable.version,
      );

      if (comparison.status === "unsatisfied") {
        return warn(HealthCode.PackageManagerVersionMismatch, facts);
      }

      // The requirement or the reported version could not be interpreted. Reported rather than passed: an unread
      // comparison is not an agreement, and silence would read as consent.
      if (comparison.status === "indeterminate") {
        return warn(HealthCode.PackageManagerVersionUnverified, facts);
      }
    } else if (
      executable.reason !== undefined &&
      executable.reason !== "not-probed"
    ) {
      // A version was expected and the binary would not give one. Bounded and advisory: the toolchain is odd, not the
      // project. `not-probed` is excluded on purpose — it means nobody asked, or the platform needs a shell we refuse to
      // enable, and neither is a defect to report.
      return warn(HealthCode.PackageManagerVersionUnverified, facts);
    }
  }

  // ── 5. Installation ────────────────────────────────────────────────────────

  if (group.installState === "foreign")
    return warn(HealthCode.PackageManagerForeignInstall, facts);

  // Only reachable when a manager was identified, so the project has both a tool and evidence of intent: this is a fresh
  // clone, not a misconfiguration.
  if (group.installState === "absent")
    return warn(HealthCode.PackageManagerNotInstalled, facts);

  return undefined;
}

/**
 * Renders a finding for one rung.
 *
 * One helper rather than five inline object literals, and `warn` rather than a verdict chosen per rung: the check's
 * declared severity is `warning`, so the verdict cannot be `fail` without breaking the catalogue invariant that only an
 * `error`-severity check may fail a run.
 */
function warn(code: HealthCode, facts: CheckFacts): CheckVerdict {
  return { verdict: "warn", finding: healthFinding(code, facts) };
}
