/**
 * Turns raw package-manager evidence into named, individually actionable issues.
 *
 * Pure: takes an immutable snapshot, a detection decision and the resolved executable state, and returns frozen data.
 * No filesystem, no process, no clock. Every scenario in the health matrix is therefore a fixture assertion rather than
 * an integration test with mocks.
 *
 * The reason this module exists separately from detection is that "what is this project?" and "is this project
 * healthy?" are different questions with different answers. A project can be unambiguously pnpm and still be broken,
 * and it can be unhealthy without anybody knowing which manager it uses.
 *
 * ## One code per fix
 *
 * Ten conditions, and each sends a reader somewhere different — which is why they are ten codes and not one "package
 * manager problem". The four that are most often conflated:
 *
 *   PM_UNSUPPORTED                change tooling, or accept reduced support
 *   PM_EXECUTABLE_MISSING         install the tool
 *   PM_DEPENDENCIES_NOT_INSTALLED run an install
 *   PM_UNDECLARED                 declare what this project uses
 *
 * The remaining six describe the cases on the way to those: two lockfiles that disagree, a declaration contradicted by
 * the only lockfile, a declaration that cannot be used, a version that disagrees with what the project declared, a
 * version that could not be read at all, and a dependency tree another tool created. A single message could describe
 * one of the ten and would be wrong for the other nine.
 */

// The current name. The runtime-era alias exists in `core/compatibility` so that call sites in flight keep compiling;
// this file compares a third kind of version through that same engine, which is the reason the function was renamed and
// the last place that should still be spelling it the old way.
import { evaluateVersionRequirement } from "../../core/compatibility/index.js";

import type {
  Detection,
  ExecutableAvailability,
  HealthIssue,
  HealthIssueCode,
  HealthIssueDetailValue,
  HealthOutcome,
  InstallState,
  PackageManagerAssessment,
  PackageManagerName,
  ProjectSnapshot,
} from "./contracts.js";
// `managerForLockfile` is imported because one question can only be answered from the filename: whether a conflicting
// detection came from *one* lockfile disagreeing with the declaration, or from *two* lockfiles disagreeing with each
// other. `detection.managers` summarises both cases the same way and cannot tell them apart.
import {
  managerForLockfile,
  PACKAGE_MANAGER_POLICY,
  policyFor,
} from "./policy.js";

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the assessment needs; all of it already resolved and immutable. */
export interface PackageManagerAssessmentInput {
  readonly snapshot: ProjectSnapshot;
  readonly detection: Detection;
  /** `missing` when no manager was identified — never `undefined`. */
  readonly executable: ExecutableAvailability;
  /**
   * How far a previous installation got, when the caller could establish it.
   *
   * Optional because attribution requires reading inside `node_modules`, while the snapshot in this iteration carries
   * root-level presence only. When it is omitted, {@link determineInstallState} derives the honest partial answer:
   * "absent" if nothing is installed, "unknown" if something is installed but cannot be attributed. The union already
   * models `foreign`, so a richer collector can supply it without changing any contract below.
   */
  readonly installState?: InstallState;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Severity ordering used to collapse several issues into one headline outcome.
 *
 * `skipped` outranks `pass` because "we did not check" must never be presented as "we checked and it was fine".
 */
const OUTCOME_RANK: Readonly<Record<HealthOutcome, number>> = Object.freeze({
  pass: 0,
  skipped: 1,
  indeterminate: 2,
  fail: 3,
});

function worstOutcome(outcomes: readonly HealthOutcome[]): HealthOutcome {
  return outcomes.reduce<HealthOutcome>(
    (worst, current) =>
      OUTCOME_RANK[current] > OUTCOME_RANK[worst] ? current : worst,
    "pass",
  );
}

/**
 * Builds one frozen issue.
 *
 * The parameter is typed as `Record<string, HealthIssueDetailValue>` — the export the contracts module actually
 * provides — so no assertion is needed at the call site. An earlier version cast to a non-existent alias, which is both
 * a compile error and, had it compiled, an unchecked assertion on evidence a reader is expected to trust.
 */
function issue(
  code: HealthIssueCode,
  outcome: HealthOutcome,
  manager: PackageManagerName | undefined,
  detail: Record<string, HealthIssueDetailValue>,
): HealthIssue {
  return Object.freeze({
    code,
    outcome,
    manager,
    detail: Object.freeze(detail),
  });
}

/**
 * Derives install state from what the snapshot can actually prove.
 *
 * Deliberately conservative: the presence of `node_modules` is *not* evidence that the detected manager created it.
 * Claiming "installed" here would be a guess, and a guess in a diagnostic is worse than an acknowledged gap.
 */
export function determineInstallState(
  snapshot: ProjectSnapshot,
  detection: Detection,
): InstallState {
  if (detection.status !== "detected") {
    return Object.freeze({
      status: "unknown",
      reason: "no package manager identified",
    });
  }

  if (!snapshot.hasNodeModules) return Object.freeze({ status: "absent" });

  // Managers without a reliable marker can never have their tree attributed.
  if (policyFor(detection.manager).installMarker === null) {
    return Object.freeze({
      status: "unknown",
      reason: `${detection.manager} leaves no install marker`,
    });
  }

  return Object.freeze({
    status: "unknown",
    reason:
      "installation present; attribution requires inspecting node_modules",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Assessment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assesses package-manager health.
 *
 * Issues are produced in a fixed order (see the sections below) so that two runs over the same project yield
 * byte-identical evidence, which is what makes the JSON output diffable in CI and reviewable in a bug report.
 */
export function assessPackageManagerHealth(
  input: PackageManagerAssessmentInput,
): PackageManagerAssessment {
  const { snapshot, detection, executable } = input;
  const issues: HealthIssue[] = [];

  const declared =
    snapshot.declaration.status === "parsed"
      ? snapshot.declaration.declaration
      : undefined;

  // ── Identity problems ──────────────────────────────────────────────────────

  if (detection.status === "conflicting") {
    // A single lockfile that contradicts the declaration is a different story from two lockfiles fighting: the fix is
    // "align the field or the file", not "delete one of two files". Keeping them distinct means the message can name the
    // actual edit.
    //
    // The observation is read back from the *file*. `detection.managers` carries both candidates for this case — the
    // declaration and the observation — so counting its members cannot distinguish one lockfile from two, and a
    // condition built on that count is never satisfied. `lockfiles.length` is the fact that answers the question, and
    // `managerForLockfile` turns the single filename into the manager it proves.
    const [onlyLockfile] = detection.lockfiles;
    const observedByLockfile =
      onlyLockfile === undefined ? undefined : managerForLockfile(onlyLockfile);

    if (
      declared !== undefined &&
      detection.lockfiles.length === 1 &&
      observedByLockfile !== undefined &&
      observedByLockfile !== declared.name
    ) {
      issues.push(
        issue("PM_DECLARATION_MISMATCH", "fail", declared.name, {
          declared: declared.name,
          observed: observedByLockfile,
          lockfiles: detection.lockfiles,
          declaration: declared.raw,
        }),
      );
    } else {
      issues.push(
        issue("PM_LOCKFILES_CONFLICT", "fail", undefined, {
          lockfiles: detection.lockfiles,
          managers: detection.managers,
          declaration: declared?.raw ?? null,
        }),
      );
    }
  }

  if (detection.status === "unsupported") {
    issues.push(
      issue("PM_UNSUPPORTED", "fail", detection.manager, {
        manager: detection.manager,
        lockfile: detection.lockfile,
        supported: PACKAGE_MANAGER_POLICY[detection.manager].supported,
      }),
    );
  }

  if (detection.status === "undeclared") {
    // An unusable declaration is reported in its own right: silently falling back to "we see nothing" would hide the
    // user's own text from them.
    if (snapshot.declaration.status === "unparsable") {
      const { raw, problem } = snapshot.declaration;

      issues.push(
        problem === "unknown-manager"
          ? issue("PM_UNSUPPORTED", "fail", undefined, {
              declaration: raw,
              problem,
            })
          : issue("PM_DECLARATION_UNPARSABLE", "fail", undefined, {
              declaration: raw,
              problem,
            }),
      );
    } else {
      // Nothing identifies the manager. Indeterminate, not fail: the project may be perfectly healthy and simply not
      // declare what it installs with — but we genuinely cannot verify it, so this must never read as a pass.
      issues.push(
        issue("PM_UNDECLARED", "indeterminate", undefined, {
          lockfiles: detection.lockfiles,
        }),
      );
    }
  }

  // ── Tooling and version problems (only meaningful once identity is known) ──

  if (detection.status === "detected") {
    const manager = detection.manager;

    if (executable.status === "missing") {
      issues.push(
        issue("PM_EXECUTABLE_MISSING", "fail", manager, {
          manager,
          executable: PACKAGE_MANAGER_POLICY[manager].executables.join(", "),
          lockfile: detection.lockfile || null,
        }),
      );
    }

    if (executable.status === "found") {
      // The declaration is an exact pin; an `engines` range is a constraint. The pin is more specific, so it wins when
      // both exist — and the loser is still quoted in evidence so nobody has to go hunting for it.
      //
      // Both values are read once into locals. Indexing `snapshot.engineRanges[manager]` twice — once to test it and
      // once to use it — needed an assertion to convince the compiler the second read was the one just tested. A local
      // makes that the same read, so no assertion is required and none is possible.
      const engineRange = snapshot.engineRanges[manager];

      const expected =
        declared?.version !== undefined
          ? { range: declared.version, origin: "package.json#packageManager" }
          : engineRange !== undefined
            ? { range: engineRange, origin: `package.json#engines.${manager}` }
            : undefined;

      const { version } = executable;

      if (expected !== undefined && version.status === "read") {
        const verdict = evaluateVersionRequirement(
          {
            // A member of the widened source union, checked by the compiler rather than cast at the call site.
            source: "package-manager",
            range: expected.range,
            origin: expected.origin,
            severityWhenUnsatisfied: "warning",
          },
          version.value,
        );

        if (verdict.status === "unsatisfied") {
          issues.push(
            issue("PM_EXECUTABLE_VERSION_MISMATCH", "fail", manager, {
              manager,
              detected: version.value,
              expected: expected.range,
              expectedOrigin: expected.origin,
              // The resolved path is console-only evidence: the persisted model keeps the *command* and drops the path,
              // because a home directory in a shared report leaks a username. It is here because a reader debugging a
              // shim needs to see which binary answered.
              executable: executable.path,
            }),
          );
        } else if (verdict.status === "indeterminate") {
          // The requirement or the reported version could not be interpreted; say so instead of letting an unread
          // comparison pass.
          issues.push(
            issue("PM_VERSION_UNVERIFIED", "indeterminate", manager, {
              manager,
              detected: version.value,
              expected: expected.range,
              reason: verdict.reason,
            }),
          );
        }
      } else if (expected !== undefined && version.status === "unreadable") {
        // A version was required and the binary would not answer. Bounded and reported, never fatal: the toolchain is
        // odd, not the project.
        issues.push(
          issue("PM_VERSION_UNVERIFIED", "indeterminate", manager, {
            manager,
            expected: expected.range,
            reason: version.reason,
            executable: executable.path,
          }),
        );
      }
      // `not-probed` produces no issue by design: probing is skipped when no version was declared, and on Windows shims
      // that would require a shell. Reporting those as "unverified" would teach users to ignore the finding.
    }

    // ── Installation indicators ────────────────────────────────────────────

    const installState =
      input.installState ?? determineInstallState(snapshot, detection);

    if (installState.status === "foreign") {
      issues.push(
        issue("PM_FOREIGN_NODE_MODULES", "fail", manager, {
          manager,
          marker: installState.marker,
          createdBy: installState.createdBy,
        }),
      );
    }

    if (
      installState.status === "absent" &&
      (detection.lockfile !== "" || declared !== undefined)
    ) {
      // Only reported when the project clearly intends dependencies: a declared manager plus no lockfile and no install
      // is a fresh checkout, not a fault.
      issues.push(
        issue("PM_DEPENDENCIES_NOT_INSTALLED", "fail", manager, {
          manager,
          lockfile: detection.lockfile || null,
          nodeModules: false,
        }),
      );
    }
  }

  // Deterministic order: identity problems first, then tooling, then install state — the same order in which a reader
  // would work through the fix.
  const ordered = Object.freeze([...issues]);

  return Object.freeze({
    manager: detection.status === "detected" ? detection.manager : undefined,
    outcome: worstOutcome(ordered.map((entry) => entry.outcome)),
    issues: ordered,
  });
}
