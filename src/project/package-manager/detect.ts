/**
 * Decides which package manager a project is actually using.
 *
 * Pure by construction: this module receives a {@link ProjectSnapshot} and returns a decision. No filesystem, no
 * environment, no process, no clock. That is what makes the entire detection matrix — including the awkward cases —
 * testable from fixtures with no mocks, and it is why the collector exists as a separate module at all.
 *
 * Two ideas govern every rule below.
 *
 * 1. Identity comes from evidence, never from execution. We never ask `pnpm --version` who it is: that would run
 *    project-controlled code merely to read a label, and it answers a different question anyway.
 *
 * 2. When the evidence disagrees, we report the disagreement. A detector that silently picks a winner lets CI install
 *    with the wrong tool and rewrite the lockfile the team meant to keep.
 *
 * ## Root means root
 *
 * Both questions this module answers — "which manager is this" and "which lockfiles did I not recognise" — are
 * questions about the *project root*. The snapshot's type says its entries are basenames, and a guard enforces the
 * meaning rather than trusting the type: a collector that ever walked recursively would satisfy the type and break the
 * promise, and the evidence it produced would name a location the project does not have.
 */

import type {
  Detection,
  PackageManagerName,
  ProjectSnapshot,
} from "./contracts.js";
import { managerForLockfile, PACKAGE_MANAGER_POLICY } from "./policy.js";

// ─────────────────────────────────────────────────────────────────────────────
// Root entries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when an entry is a name at the project root rather than a path.
 *
 * Load-bearing rather than defensive. `ProjectSnapshot.rootEntries` is documented as basenames, but the type cannot
 * enforce that — a recursive listing would put `packages/app/package-lock.json` in the set and everything would still
 * compile. Without this check that file is reported as an unrecognised lockfile *at the root*, which is a finding
 * naming a location the project does not have: worse than silence, because it looks like evidence.
 *
 * Both separators, because a Windows-style path in a snapshot is a real possibility and a check that only knew about
 * `/` would pass the tests on one platform and misbehave on the other.
 */
function isRootBasename(entry: string): boolean {
  return entry !== "" && !entry.includes("/") && !entry.includes("\\");
}

// ─────────────────────────────────────────────────────────────────────────────
// Lockfile evidence
// ─────────────────────────────────────────────────────────────────────────────

/** A root-level filename resolved to the manager that owns it. */
interface LockfileEvidence {
  readonly basename: string;
  readonly manager: PackageManagerName;
}

/**
 * Resolves the root entries to known lockfiles.
 *
 * Presence alone is the signal: a zero-byte `pnpm-lock.yaml` still means "this project installs with pnpm". Reading the
 * contents would cost time, risk parsing a 50 MB file, and tell us nothing we need in order to identify the manager.
 *
 * Results are sorted so that two runs over the same directory — however the filesystem orders its entries — produce
 * byte-identical evidence.
 */
function knownLockfilesIn(
  snapshot: ProjectSnapshot,
): readonly LockfileEvidence[] {
  return (
    [...snapshot.rootEntries]
      // Filtered before the lookup, so a path-like entry is excluded *because it is not a root entry* rather than by
      // accident — `managerForLockfile` compares whole strings against a basename index and would return `undefined`
      // anyway, which would make the reason for the exclusion invisible.
      .filter(isRootBasename)
      .map((basename) => ({ basename, manager: managerForLockfile(basename) }))
      .filter(
        (candidate): candidate is LockfileEvidence =>
          candidate.manager !== undefined,
      )
      .sort((a, b) => a.basename.localeCompare(b.basename))
  );
}

/**
 * Lockfiles belonging to ecosystems this project is not about.
 *
 * Automation repositories frequently sit beside a Rust service, a Python tool or a PHP backend. Reporting `Cargo.lock`
 * as an "unrecognised package-manager lockfile" would train users to ignore the finding — and an ignored warning is
 * worse than no warning. The list is deliberately small and explicit rather than a clever pattern, so every
 * suppression is a decision someone can review.
 */
const FOREIGN_LOCKFILES: ReadonlySet<string> = new Set([
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "gemfile.lock",
  "composer.lock",
  "mix.lock",
  "flake.lock",
  "podfile.lock",
  "pubspec.lock",
]);

/** Filenames that look like a lockfile for some ecosystem. */
const LOCKFILE_LIKE = /(\.lockb?|-lock\.(?:json|yaml|yml))$/i;

/**
 * Lockfiles present at the root that identify no manager in the policy.
 *
 * Evidence only — this list never influences identity. It exists so the report can say "we saw `deno.lock` and do not
 * know what to do with it" instead of quietly ignoring a file the user clearly committed on purpose.
 */
function unrecognisedLockfilesIn(snapshot: ProjectSnapshot): readonly string[] {
  return (
    [...snapshot.rootEntries]
      // Same guard as above, and here it changes the answer: a nested lockfile matches the name pattern and maps to no
      // manager, so without it the entry would be reported as an unrecognised root file.
      .filter(isRootBasename)
      .filter((basename) => LOCKFILE_LIKE.test(basename))
      .filter((basename) => managerForLockfile(basename) === undefined)
      .filter((basename) => !FOREIGN_LOCKFILES.has(basename.toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
  );
}

/**
 * Picks the lockfile to quote as evidence when a manager declares several.
 *
 * `npm-shrinkwrap.json` and `package-lock.json` both mean npm, so quoting either is truthful. We use policy declaration
 * order and document it, because "whichever the directory listing returned first" would make reports unstable.
 *
 * Reads the policy array by index-free iteration so the compiler carries the element type; an explicit assertion here
 * would have been a second, unchecked statement of what the policy table already declares.
 */
function preferredLockfileFor(
  manager: PackageManagerName,
  evidence: readonly LockfileEvidence[],
): string {
  const declared = PACKAGE_MANAGER_POLICY[manager].lockfiles;
  const owned = evidence.filter((candidate) => candidate.manager === manager);

  for (const basename of declared) {
    const match = owned.find(
      (candidate) =>
        candidate.basename.toLowerCase() === basename.toLowerCase(),
    );
    if (match !== undefined) return match.basename;
  }

  return owned[0]?.basename ?? "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies the project's package-manager context.
 *
 * Precedence is fixed and documented, because the answer must not depend on iteration order or on which field happened
 * to be read first:
 *
 *   1. lockfiles at the root — what the project actually did;
 *   2. `packageManager` — what the project says it does;
 *   3. disagreement between (1) and (2) is a conflict, never a tie-break;
 *   4. no evidence at all is `undeclared`, never "npm by default".
 *
 * An unusable declaration (`absent`, `malformed`, or a manager we do not recognise) is ignored for the purpose of
 * *identity* here — it cannot name a manager we can act on — but it is not lost: the assessment step reads the
 * declaration independently and reports it as unparsable or unsupported. One snapshot, two readers, no duplicated
 * truth.
 */
export function detectPackageManager(snapshot: ProjectSnapshot): Detection {
  const evidence = knownLockfilesIn(snapshot);

  // Filenames are collected once and reused by both conflict branches. Two identical `evidence.map(...)` expressions
  // were a second place for the two reports to drift, for no gain.
  const lockfiles = evidence.map((candidate) => candidate.basename);

  // De-duplicated and sorted: two lockfiles from the same manager are one manager, and the report should never depend
  // on directory order.
  //
  // No assertion: `candidate.manager` is already `PackageManagerName`, and `Set`, spread and `sort` all preserve it.
  // Where an explicit type is wanted for readability, annotate the binding — `const managers: PackageManagerName[]` —
  // rather than asserting the finished expression, because the annotation is checked against the initialiser while the
  // assertion replaces it.
  const managers = [
    ...new Set(evidence.map((candidate) => candidate.manager)),
  ].sort();

  if (managers.length > 1) {
    return Object.freeze({
      status: "conflicting",
      lockfiles,
      managers,
    });
  }

  const observed = managers[0];
  const declared =
    snapshot.declaration.status === "parsed"
      ? snapshot.declaration.declaration.name
      : undefined;

  // Declaration and footprint disagree. Both are quoted: the user needs to see which claim came from where before
  // deciding which file to delete.
  //
  // Both operands are narrowed to `PackageManagerName` by the guard above, so the array literal is already that type and
  // needs no assertion.
  if (
    declared !== undefined &&
    observed !== undefined &&
    declared !== observed
  ) {
    return Object.freeze({
      status: "conflicting",
      lockfiles,
      managers: [declared, observed].sort(),
    });
  }

  const manager = declared ?? observed;

  // Nothing usable, anywhere. Note that `lockfiles` here is *only* the unrecognised set — the recognised-but-
  // contradictory case was handled above.
  if (manager === undefined) {
    return Object.freeze({
      status: "undeclared",
      lockfiles: unrecognisedLockfilesIn(snapshot),
    });
  }

  // Recognised but outside the supported installation policy. Reported as its own outcome so the message can say "not
  // supported" instead of the far more confusing "not detected".
  if (!PACKAGE_MANAGER_POLICY[manager].supported) {
    return Object.freeze({
      status: "unsupported",
      manager,
      lockfile: preferredLockfileFor(manager, evidence),
    });
  }

  return Object.freeze({
    status: "detected",
    manager,
    lockfile: preferredLockfileFor(manager, evidence),
    // True when the project's own declaration agreed with, or supplied, the identity. Surfaced so evidence can
    // distinguish "declared and confirmed" from "inferred from a lockfile only" — a difference reviewers care about when
    // the two later drift apart.
    declared: declared !== undefined,
  });
}
