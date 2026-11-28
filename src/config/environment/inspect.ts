/**
 * Environment inspection — turns a selection into a reportable state.
 *
 * This is the only place that decides *which* environmental fact is true. It is
 * a state machine over five outcomes, in the order a user needs to fix them:
 *
 *   not-selected   → nobody chose anything            → guide
 *   selection-invalid → something unusable was chosen → quote it back
 *   profile-not-found → a real name, but undeclared   → list what exists
 *   profile-invalid   → declared, but fails the schema→ name the field
 *   profile-valid     → usable; here are the reference facts
 *
 * Two properties are load-bearing:
 *
 *  1. It never invents an answer. Each step stops at the first failing
 *     precondition, so the user gets one problem to fix rather than a cascade.
 *  2. It never reads a variable's value. Presence arrives as an enum from a
 *     port that has no value accessor, which makes "the doctor must not expose
 *     resolved secrets" a structural property instead of a code-review promise.
 *
 * It does, however, let collaborator *faults* escape. A validator that throws is
 * a bug in an adapter, not a condition of the user's configuration; swallowing
 * it here would turn a defect into a confident verdict about their project. The
 * check runner contains failures per check, which is the right layer for that.
 */

import type {
  EnvironmentInspection,
  EnvironmentName,
  EnvironmentSelection,
  InspectEnvironmentDependencies,
  PathStatus,
  VariableReference,
  VariableRequirement,
  VariableStatus,
} from "./contracts.js";
import { isUsableName } from "./select.js";

// ─── Reference policy ────────────────────────────────────────────────────────

/**
 * The only sources a variable reference may use.
 *
 * Typed as `readonly string[]` rather than a literal tuple on purpose: the value
 * being tested comes from an untrusted configuration file, so the comparison has
 * to accept an arbitrary string. Narrowing the type here would only move the
 * runtime check somewhere less obvious.
 *
 * There is deliberately no literal-value source. A secret committed to a
 * configuration file is already in version control by the time QAT reads it, so
 * it is rejected outright instead of "accepted with a warning".
 */
export const APPROVED_VARIABLE_SOURCES: readonly string[] = Object.freeze([
  "env",
]);

/**
 * POSIX-portable variable names: upper snake case only.
 *
 * Lowercase and dashed names are legal in some shells but are not portable
 * across the shells and CI runners QAT targets, and a name QAT cannot pass
 * faithfully is better refused than silently mangled.
 */
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;

// ─── Inspection ──────────────────────────────────────────────────────────────

/**
 * Establishes the state of the selected environment profile.
 *
 * Order matters and is deliberate: existence is checked before validity (you
 * cannot judge the fields of a profile that is not there), and validity before
 * references (a reference inside a schema-invalid profile is not worth
 * reporting — the shape is wrong, so the contents are not yet meaningful).
 */
export function inspectEnvironment(
  selection: EnvironmentSelection,
  deps: InspectEnvironmentDependencies,
): EnvironmentInspection {
  // 1. Nothing was supplied anywhere. This is a state, not an error: `doctor`
  //    can inspect a project that has no environment, and says so plainly.
  if (selection.origin === "none") {
    return { state: "not-selected", origin: "none" };
  }

  // `?? ''` only protects against a caller that built a malformed selection by
  // hand. It collapses into the same branch as an empty `--env ""`, which is
  // exactly right: both mean "a selection was attempted and it is unusable".
  const name = selection.name ?? "";

  // 2. Supplied but unusable. Reported rather than replaced — falling back to a
  //    default here would run a different environment than the one requested.
  if (!isUsableName(name)) {
    return { state: "selection-invalid", origin: selection.origin, raw: name };
  }

  // 3. A usable name that is not declared. The available names travel with the
  //    finding so the message can say what the user probably meant, instead of
  //    making them open the configuration file to find out.
  if (!deps.profiles.has(name)) {
    return {
      state: "profile-not-found",
      origin: selection.origin,
      name,
      available: sortedNames(deps.profiles),
    };
  }

  // 4. Schema validity, using the existing profile schema. Issues come back as
  //    data (path + code + expectation), never as a thrown error and never as a
  //    message we would have to trust verbatim.
  const profile = deps.profiles.get(name);
  const issues = deps.validateProfile(name, profile);

  if (issues.length > 0) {
    return { state: "profile-invalid", origin: selection.origin, name, issues };
  }

  // 5. Usable. Everything below is factual: what the profile references, and
  //    what the host reports about it — names and enums only.
  return {
    state: "profile-valid",
    origin: selection.origin,
    name,
    variables: verifyReferences(deps.readVariables(name), deps.presence.probe),
    paths: sortedPaths(deps.resolvePaths(name)),
  };
}

// ─── Reference verification ──────────────────────────────────────────────────

/**
 * Verifies each declared reference against policy and host presence.
 *
 * Checks run in dependency order: an unapproved source is reported without ever
 * probing the environment, because asking whether `AUTH_TOKEN` is set is
 * meaningless when the reference was declared as a literal value or an
 * unsupported backend. Cheap, certain failures come first.
 *
 * The returned list is normalised — de-duplicated by name and sorted — because
 * evidence has to be byte-stable across runs for the same inputs. Duplicate
 * declarations keep the strictest requirement, so folding two references never
 * downgrades a required variable to optional.
 */
function verifyReferences(
  references: readonly VariableReference[],
  probe: (
    name: string,
  ) => VariableStatus["reason"] extends never
    ? never
    : ReturnType<InspectEnvironmentDependencies["presence"]["probe"]>,
): readonly VariableStatus[] {
  const merged = mergeByName(references);

  return merged.map((reference) => {
    // 1. Policy: the source must be one QAT is allowed to read from.
    if (!APPROVED_VARIABLE_SOURCES.includes(reference.source)) {
      return {
        reason: "ENV_REFERENCE_SOURCE_NOT_APPROVED" as const,
        name: reference.name,
        source: reference.source,
      };
    }

    // 2. Policy: the name must be one we can pass faithfully to a child process.
    if (!VARIABLE_NAME.test(reference.name)) {
      return {
        reason: "ENV_REFERENCE_NAME_INVALID" as const,
        name: reference.name,
      };
    }

    // 3. Fact: presence only. The value never crosses this boundary.
    switch (probe(reference.name)) {
      case "set":
        return {
          reason: "ENV_VARIABLE_PRESENT" as const,
          name: reference.name,
        };
      case "blank":
        // Distinct from unset: both break authentication, and people need to be
        // told which one they have before they start editing the wrong thing.
        return {
          reason: "ENV_VARIABLE_BLANK" as const,
          name: reference.name,
          requirement: reference.requirement,
        };
      case "unset":
        return {
          reason: "ENV_VARIABLE_MISSING" as const,
          name: reference.name,
          requirement: reference.requirement,
        };
      case "unknown":
        // "I could not look" is reportable and is never treated as present.
        return {
          reason: "ENV_VARIABLE_UNVERIFIABLE" as const,
          name: reference.name,
        };
    }
  });
}

/**
 * Folds duplicate declarations of the same variable into one, keeping the
 * strictest requirement.
 *
 * Two references to the same name are a configuration smell, but they are not
 * this check's business to reject — the schema's business. All we guarantee is
 * that the *diagnostic* does not depend on declaration order.
 */
function mergeByName(
  references: readonly VariableReference[],
): readonly VariableReference[] {
  const strongest = new Map<string, VariableReference>();

  for (const reference of references) {
    const existing = strongest.get(reference.name);
    strongest.set(
      reference.name,
      existing === undefined ||
        rank(reference.requirement) > rank(existing.requirement)
        ? reference
        : existing,
    );
  }

  return [...strongest.values()].sort((a, b) => compare(a.name, b.name));
}

/** `unspecified` ranks lowest, so it never overrides an explicit declaration. */
function rank(requirement: VariableRequirement): number {
  return requirement === "required" ? 2 : requirement === "optional" ? 1 : 0;
}

// ─── Deterministic ordering ──────────────────────────────────────────────────

/**
 * Locale-independent ordering.
 *
 * `localeCompare` would make evidence order depend on the host locale, and
 * "deterministic environment resolution" has to mean deterministic byte-for-byte
 * on every machine, not just the developer's.
 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedNames(
  profiles: ReadonlyMap<EnvironmentName, unknown>,
): readonly EnvironmentName[] {
  return [...profiles.keys()].sort(compare);
}

function sortedPaths(paths: readonly PathStatus[]): readonly PathStatus[] {
  return [...paths].sort((a, b) => compare(a.field, b.field));
}
