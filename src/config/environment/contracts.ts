/**
 * Contracts for the environment profile health check.
 *
 * This file is deliberately types-only: no imports, no behaviour, no runtime
 * values. That property is worth protecting, because everything downstream —
 * the inspection facade, the classification step, the diagnostic rules — is
 * expressed in terms of the shapes defined here, and a contracts module with no
 * dependencies can never create an import cycle or drag I/O into a pure step.
 *
 * ─── The one invariant everything else serves ───────────────────────────────
 *
 *   No type in this file has a field capable of holding a variable's *value*.
 *
 * Secrets cannot leak through a shape that cannot represent them. Presence is
 * reported as an enum, never as a string; profiles carry declared references,
 * never resolved strings. If a future change needs a value here, that change is
 * wrong — the value belongs to the runner, not to the diagnostic.
 */

// ─── Selection ───────────────────────────────────────────────────────────────

/**
 * Where the chosen environment came from, highest precedence first.
 *
 * Recorded rather than inferred so that every message can state its own
 * provenance ("selected by --env" vs "from defaultEnvironment"). An environment
 * nobody can trace is an environment nobody can debug.
 */
export type SelectionOrigin =
  "explicit-cli" | "process-environment" | "configuration-default" | "none";

/**
 * The outcome of environment selection.
 *
 * `name` is optional only for `origin: 'none'`. An empty or whitespace-only
 * candidate is represented as `name: ''` with a real origin — never dropped —
 * because falling through to the next candidate would silently run a different
 * environment than the one requested.
 */
export interface EnvironmentSelection {
  readonly origin: SelectionOrigin;
  readonly name?: string;
}

/**
 * A profile name as written by a human.
 *
 * Intentionally not a branded/opaque type: names arrive from untrusted
 * configuration, and pretending otherwise at the type level would only push the
 * validation somewhere less visible. Name validity is an explicit, reportable
 * result (`ENV_REFERENCE_NAME_INVALID`), not a compile-time assumption.
 */
export type EnvironmentName = string;

// ─── Profile declarations (untrusted input) ──────────────────────────────────

/**
 * A variable source exactly as declared in configuration.
 *
 * Typed as `string`, not as an approved literal, on purpose: the check must be
 * able to *report* an unapproved source. Narrowing this at the type level would
 * make the common misconfiguration unrepresentable and therefore unreportable.
 */
export type DeclaredVariableSource = string;

/**
 * The only sources that survive validation.
 *
 * Kept as a closed union so that downstream code physically cannot compare
 * against a source QAT has not approved. Note what is absent: any literal-value
 * source. A secret committed to a configuration file is already in version
 * control by the time QAT sees it, so it is rejected rather than warned about.
 */
export type ApprovedVariableSource = "env";

/**
 * How strongly a profile insists that a variable must be present.
 *
 * `unspecified` is a first-class state, not a missing value: it is exactly the
 * condition under which the catalogue allows a Warning instead of an Error,
 * because the requirement cannot be established from the declaration.
 */
export type VariableRequirement = "required" | "optional" | "unspecified";

/**
 * A variable reference as declared by a profile — a name and a source, never a
 * value. This is the input to validation, and it is untrusted.
 */
export interface VariableReference {
  readonly name: string;
  readonly source: DeclaredVariableSource;
  readonly requirement: VariableRequirement;
}

// ─── Verification results (established facts) ────────────────────────────────

/**
 * What the host reports about a variable.
 *
 * The port that produces this may read the process environment internally, but
 * only these four values are allowed to cross the boundary into the diagnostic
 * layer. A `string` return type here would be a leak waiting to happen; an enum
 * with no value case makes leaking impossible rather than merely discouraged.
 *
 * `blank` (set to an empty or whitespace-only string) is distinct from `unset`:
 * both break authentication, and they break it differently enough that people
 * need to be told which one they have.
 */
export type VariablePresence = "set" | "blank" | "unset" | "unknown";

/**
 * The verdict for one declared variable reference.
 *
 * Discriminated by `reason` so a caller cannot read `name` without also knowing
 * what kind of answer it is holding. `requirement` travels with the verdict
 * because severity is derived from the declaration, not from QAT's opinion.
 */
export type VariableStatus =
  | { readonly reason: "ENV_VARIABLE_PRESENT"; readonly name: string }
  | {
      readonly reason: "ENV_VARIABLE_MISSING" | "ENV_VARIABLE_BLANK";
      readonly name: string;
      readonly requirement: VariableRequirement;
    }
  | {
      readonly reason: "ENV_REFERENCE_SOURCE_NOT_APPROVED";
      readonly name: string;
      readonly source: DeclaredVariableSource;
    }
  | { readonly reason: "ENV_REFERENCE_NAME_INVALID"; readonly name: string }
  | { readonly reason: "ENV_VARIABLE_UNVERIFIABLE"; readonly name: string };

/**
 * The verdict for one configured path, resolved against the project root.
 *
 * Only *resolution* is judged here. Whether the directory exists or is writable
 * is a filesystem concern with its own check; conflating the two would produce
 * two different answers for the same problem.
 */
export type PathStatus =
  | { readonly reason: "ENV_PATH_RESOLVED"; readonly field: string }
  | {
      readonly reason:
        "ENV_PATH_OUTSIDE_PROJECT" | "ENV_PATH_ABSOLUTE" | "ENV_PATH_INVALID";
      readonly field: string;
      readonly declared: string;
    };

/**
 * A single field-level problem inside a profile.
 *
 * Shaped as path + code + expectation rather than "path + message": the message
 * is rebuilt from QAT's own catalogue so it stays stable when a validation
 * dependency rewords itself, and so no fragment of a rejected value can be
 * copied into output by accident.
 */
export interface ProfileIssue {
  /** Dotted path within the profile, e.g. `fixtures.directory`. `undefined` = the profile itself. */
  readonly path?: string;
  readonly code: string;
  /** A short expectation, e.g. "a path relative to the project root". */
  readonly expected?: string;
}

// ─── The inspection union ────────────────────────────────────────────────────

/**
 * Everything the environment check can establish, as data.
 *
 * A closed union rather than a nullable result, because the states this check
 * must keep apart are genuinely different and a shape that cannot express them
 * invites callers to guess which one they are looking at:
 *
 *   not-selected      nothing was chosen — guide, do not blame
 *   selection-invalid something was chosen but is unusable (empty/whitespace)
 *   profile-not-found a name was chosen and no such profile exists
 *   profile-invalid   the profile exists and does not satisfy the schema
 *   profile-valid     the profile is usable; per-variable and per-path facts follow
 *
 * Note that "not-selected" and "profile-invalid" are not variations of one
 * another: they have different causes, different remediations and, per the
 * catalogue, different severities.
 */
export type EnvironmentInspection =
  | { readonly state: "not-selected"; readonly origin: "none" }
  | {
      readonly state: "selection-invalid";
      readonly origin: SelectionOrigin;
      readonly raw: string;
    }
  | {
      readonly state: "profile-not-found";
      readonly origin: SelectionOrigin;
      readonly name: EnvironmentName;
      /** Names that do exist, so the message can say what the user probably meant. */
      readonly available: readonly EnvironmentName[];
    }
  | {
      readonly state: "profile-invalid";
      readonly origin: SelectionOrigin;
      readonly name: EnvironmentName;
      readonly issues: readonly ProfileIssue[];
    }
  | {
      readonly state: "profile-valid";
      readonly origin: SelectionOrigin;
      readonly name: EnvironmentName;
      readonly variables: readonly VariableStatus[];
      readonly paths: readonly PathStatus[];
    };

// ─── Reason codes ────────────────────────────────────────────────────────────

/**
 * The complete vocabulary of environment findings.
 *
 * One flat union, because these codes are persisted in evidence and consumed by
 * JSON output, so they are a contract with the outside world. Kept here (rather
 * than in the classifier) so that remediation text, tests and documentation can
 * all reference the same closed set. Adding a code is a deliberate act; the
 * classifier's exhaustive switch will refuse to compile until the new code is
 * handled.
 */
export type EnvironmentReason =
  | "ENV_NO_SELECTION"
  | "ENV_SELECTION_INVALID"
  | "ENV_PROFILE_NOT_FOUND"
  | "ENV_REFERENCE_DANGLING"
  | "ENV_PROFILE_INVALID"
  | "ENV_SETTING_MISSING"
  | "ENV_REFERENCE_SOURCE_NOT_APPROVED"
  | "ENV_REFERENCE_NAME_INVALID"
  | "ENV_PATH_INVALID"
  | "ENV_VARIABLE_MISSING"
  | "ENV_VARIABLE_BLANK"
  | "ENV_VARIABLE_UNVERIFIABLE";

// ─── Evidence ────────────────────────────────────────────────────────────────

/**
 * The evidence attached to an environment finding.
 *
 * Assembled from the union above and nothing else. Every field here is a name, a
 * path, a count or an enum — there is no slot for a value, which is what makes
 * "the doctor must not expose resolved secrets" a structural property rather
 * than a promise in a code review.
 *
 * Paths are project-relative wherever they appear, so a shared CI log never
 * reveals a user's home directory structure.
 */
export interface EnvironmentEvidence {
  /** The profile the finding is about, when one was selected. */
  readonly profile: EnvironmentName | null;
  readonly selectionOrigin: SelectionOrigin;
  readonly configPath: string | null;
  /** Names only — never values. */
  readonly variables: readonly string[];
  readonly paths: readonly string[];
  readonly issueCount: number;
}

// ─── Ports and dependencies ──────────────────────────────────────────────────

/**
 * Presence probe for host-provided variables.
 *
 * Deliberately one method returning one enum. The implementation may read the
 * process environment; the *contract* permits only `VariablePresence` to escape.
 * Exposing a `getValue` here would make a future leak a one-line mistake, and
 * this check has no legitimate use for a value.
 */
export interface EnvironmentPresencePort {
  readonly probe: (name: string) => VariablePresence;
}

/**
 * Everything the inspection facade needs, injected.
 *
 * All collaborators are interfaces defined by the consumer: the facade decides
 * what it needs, and adapters in the configuration and core layers satisfy them.
 * Nothing here reaches for a global, a filesystem or a clock, which is what makes
 * the facade testable with plain objects and deterministic by construction.
 *
 * Note that `validateProfile` returns issues instead of throwing: an invalid
 * profile is an expected, reportable condition, not an exceptional one.
 */
export interface InspectEnvironmentDependencies {
  /** Declared profiles as opaque data, keyed by name — untrusted until validated. */
  readonly profiles: ReadonlyMap<EnvironmentName, unknown>;

  /**
   * Schema validity for one profile.
   *
   * Returns issues rather than throwing: an invalid profile is an expected,
   * reportable condition, not an exceptional one.
   */
  readonly validateProfile: (
    name: EnvironmentName,
    profile: unknown,
  ) => readonly ProfileIssue[];

  /**
   * The variables a *validated* profile declares.
   *
   * Separate from `profiles` because references only become meaningful once the
   * profile has passed validation — reading them from raw, untrusted data would
   * mean re-implementing shape knowledge the schema already owns.
   *
   * Returns names, sources and requirements. Never values: `VariableReference`
   * has no field that could hold one.
   */
  readonly readVariables: (
    name: EnvironmentName,
  ) => readonly VariableReference[];

  /** Configured paths for this profile, already resolved against the project root. */
  readonly resolvePaths: (name: EnvironmentName) => readonly PathStatus[];

  /** Presence only — see `EnvironmentPresencePort`. */
  readonly presence: EnvironmentPresencePort;

  /** Project-relative path of the configuration file, for evidence. */
  readonly configPath: string | null;
}
