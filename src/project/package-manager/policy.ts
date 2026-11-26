/**
 * The approved package-manager installation policy.
 *
 * This file is the single source of truth for three facts that must never be
 * duplicated elsewhere in the codebase:
 *
 *   1. which lockfile basenames belong to which package manager;
 *   2. which command would perform an install for that manager;
 *   3. which managers QAT supports diagnosing.
 *
 * Everything else derives from this table — the detection step, the assessment,
 * the executable probe, the remediation wording and the published documentation
 * (asserted by a contract test). Adding a manager is therefore a one-file change
 * with a compiler-enforced completeness check, not a hunt for scattered string
 * literals.
 *
 * Pure module: no filesystem, no environment, no I/O. It is data plus lookups,
 * so it can be imported from anywhere — including tests — without side effects.
 */

import type {
  PackageManagerName,
  PackageManagerPolicy,
  PackageManagerPolicyEntry,
} from "./contracts.js";

// ─────────────────────────────────────────────────────────────────────────────
// The policy table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Freezes one policy entry, deeply enough to matter.
 *
 * Entries are frozen individually *and* as a collection. A shallow
 * `Object.freeze` on the outer object would still allow a caller to push into a
 * `lockfiles` array and change behaviour for the whole process — including other
 * checks running in the same diagnostic session.
 *
 * Named `defineEntry`, not `entry`: `findPolicyConflicts` uses `entry` for its
 * loop variable, where the name reads correctly, and a module-level helper with
 * the same name would shadow it. Renaming the helper is the cheap side of that
 * collision — the loop variable is the one a reader meets mid-sentence.
 */
const defineEntry = (
  value: PackageManagerPolicyEntry,
): PackageManagerPolicyEntry =>
  Object.freeze({
    ...value,
    lockfiles: Object.freeze([...value.lockfiles]),
    executables: Object.freeze([...value.executables]),
  });

/**
 * Supported managers, plus recognised-but-unsupported ones.
 *
 * `bun` is present so that a Bun project is classified precisely ("recognised
 * but not supported") instead of falling through to "we could not detect a
 * package manager" — a message that would send the user looking for a missing
 * file that is not missing.
 *
 * The `PackageManagerPolicy` annotation is load-bearing: it is a total `Record`
 * over the manager union, so a manager added to the union without an entry here
 * fails to compile, and an entry for a manager that does not exist fails too.
 */
export const PACKAGE_MANAGER_POLICY: PackageManagerPolicy = Object.freeze({
  npm: defineEntry({
    // A shrinkwrap is the authoritative npm lockfile, but both identify npm, so
    // their co-existence is not a conflict and needs no precedence rule.
    lockfiles: ["package-lock.json", "npm-shrinkwrap.json"],
    executables: ["npm"],
    // Written by `npm install`; its absence after an install attempt is the
    // cheapest reliable signal that the tree was pruned or never completed.
    installMarker: "node_modules/.package-lock.json",
    supported: true,
  }),

  pnpm: defineEntry({
    lockfiles: ["pnpm-lock.yaml"],
    executables: ["pnpm"],
    // pnpm keeps its content-addressed store under this directory, so its
    // presence proves pnpm (and only pnpm) built the tree.
    installMarker: "node_modules/.pnpm",
    supported: true,
  }),

  yarn: defineEntry({
    lockfiles: ["yarn.lock"],
    executables: ["yarn"],
    installMarker: "node_modules/.yarn-integrity",
    supported: true,
  }),

  bun: defineEntry({
    // Bun has used both filenames across releases; recognising both avoids a
    // false "undeclared" for projects on either side of the rename.
    lockfiles: ["bun.lockb", "bun.lock"],
    executables: ["bun"],
    // No documented marker we are willing to rely on, so install state for Bun
    // is reported as unknown rather than inferred from a guess.
    installMarker: null,
    supported: false,
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Derived lookups
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lockfile basename → manager, built once at module load.
 *
 * Keys are lower-cased because the same repository can be checked out on a
 * case-insensitive volume (Windows, default macOS) where `PNPM-LOCK.yaml`
 * resolves to the same file. Building the index here — rather than scanning the
 * policy on every lookup — keeps detection O(1) per directory entry.
 *
 * A plain `Map` is used deliberately: it cannot be frozen, so it is kept
 * module-private and never handed out, which is the only way to make that
 * guarantee hold.
 */
const LOCKFILE_INDEX: ReadonlyMap<string, PackageManagerName> = (() => {
  const index = new Map<string, PackageManagerName>();

  for (const [name, policy] of Object.entries(PACKAGE_MANAGER_POLICY) as [
    PackageManagerName,
    PackageManagerPolicyEntry,
  ][]) {
    for (const lockfile of policy.lockfiles) {
      index.set(lockfile.toLowerCase(), name);
    }
  }

  return index;
})();

/**
 * Resolves a root-level basename to the manager that owns it.
 *
 * Returns `undefined` for anything that is not a known lockfile, which lets the
 * caller decide what an unrecognised `*.lock` file means instead of this module
 * guessing on its behalf.
 */
export function managerForLockfile(
  basename: string,
): PackageManagerName | undefined {
  return LOCKFILE_INDEX.get(basename.toLowerCase());
}

/** Every lockfile basename the policy recognises. Derived, never restated. */
export function knownLockfiles(): readonly string[] {
  return Object.freeze([...LOCKFILE_INDEX.keys()]);
}

/**
 * Managers QAT supports, in policy declaration order.
 *
 * Order is meaningful: it is the order used when listing candidates in a report,
 * so keeping it stable keeps diagnostic output diffable across runs.
 */
export function supportedManagers(): readonly PackageManagerName[] {
  return Object.freeze(
    (Object.keys(PACKAGE_MANAGER_POLICY) as PackageManagerName[]).filter(
      (name) => PACKAGE_MANAGER_POLICY[name].supported,
    ),
  );
}

/** True when the manager is inside the supported installation policy. */
export function isSupportedManager(name: PackageManagerName): boolean {
  return PACKAGE_MANAGER_POLICY[name].supported;
}

/**
 * The policy entry for a manager.
 *
 * Total function: the parameter is a closed union, so no `undefined` branch is
 * possible and callers never need a null check for a name that cannot exist.
 */
export function policyFor(name: PackageManagerName): PackageManagerPolicyEntry {
  return PACKAGE_MANAGER_POLICY[name];
}

/**
 * The command a user would run to install dependencies with this manager.
 *
 * Derived from the policy rather than written into remediation strings, so the
 * advice cannot drift from the set of managers we claim to support.
 *
 * Two separate guarantees, deliberately not merged:
 *
 *   • the `switch` is exhaustive over the manager union, so a new manager fails
 *     to compile until someone decides which install mode respects a lockfile
 *     for it — the question that actually matters, rather than a string;
 *   • the executable name is read with a fallback, because an indexed read is
 *     typed as possibly absent and a template literal would interpolate
 *     `undefined` into a command that looks runnable and is not.
 */
export function installCommandFor(name: PackageManagerName): string {
  const executable = PACKAGE_MANAGER_POLICY[name].executables[0] ?? name;

  // `--frozen-lockfile` and `npm ci` are the install modes that respect the
  // committed lockfile instead of silently rewriting it; recommending anything
  // else would invite the very drift this check exists to detect.
  switch (name) {
    case "npm":
      return `${executable} ci`;
    case "pnpm":
      return `${executable} install --frozen-lockfile`;
    case "yarn":
      return `${executable} install --immutable`;
    case "bun":
      return `${executable} install --frozen-lockfile`;
  }
}

/**
 * Documentation cross-reference used by the contract test that keeps
 * `docs/architecture/package-managers.md` in step with this table.
 *
 * Held here, not in the test, so a future move of the document fails in one
 * obvious place.
 */
export const PACKAGE_MANAGER_POLICY_DOC =
  "docs/architecture/package-managers.md";

// ─────────────────────────────────────────────────────────────────────────────
// Self-consistency
// ─────────────────────────────────────────────────────────────────────────────

/** A policy defect detected by {@link findPolicyConflicts}. */
export interface PolicyConflict {
  readonly kind:
    | "duplicate-lockfile"
    | "duplicate-executable"
    | "no-lockfile"
    | "no-executable";
  readonly detail: string;
}

/**
 * Reports internal contradictions in a policy table.
 *
 * Exposed as a pure function instead of a `throw` at module load so that tests
 * can assert the shipped policy is clean, and so a future delivery could load an
 * extended policy without crashing the process at import time.
 *
 * A lockfile claimed by two managers is the dangerous case: detection would
 * silently resolve it to whichever entry happened to be indexed last, producing
 * a confident and wrong answer.
 */
export function findPolicyConflicts(
  policy: PackageManagerPolicy = PACKAGE_MANAGER_POLICY,
): readonly PolicyConflict[] {
  const conflicts: PolicyConflict[] = [];
  const lockfiles = new Map<string, PackageManagerName>();
  const executables = new Map<string, PackageManagerName>();

  for (const [name, entry] of Object.entries(policy) as [
    PackageManagerName,
    PackageManagerPolicyEntry,
  ][]) {
    if (entry.lockfiles.length === 0) {
      conflicts.push({
        kind: "no-lockfile",
        detail: `${name} declares no lockfile and could never be detected`,
      });
    }
    if (entry.executables.length === 0) {
      conflicts.push({
        kind: "no-executable",
        detail: `${name} declares no executable and could never be verified`,
      });
    }

    for (const lockfile of entry.lockfiles) {
      const key = lockfile.toLowerCase();
      const owner = lockfiles.get(key);
      if (owner !== undefined && owner !== name) {
        conflicts.push({
          kind: "duplicate-lockfile",
          detail: `${lockfile} is claimed by both ${owner} and ${name}`,
        });
      }
      lockfiles.set(key, name);
    }

    for (const executable of entry.executables) {
      const owner = executables.get(executable);
      if (owner !== undefined && owner !== name) {
        conflicts.push({
          kind: "duplicate-executable",
          detail: `${executable} is claimed by both ${owner} and ${name}`,
        });
      }
      executables.set(executable, name);
    }
  }

  return Object.freeze(conflicts);
}
