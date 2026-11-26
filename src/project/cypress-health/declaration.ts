/**
 * Reads how a project declares Cypress.
 *
 * This module establishes exactly one of the six Cypress facts — *is Cypress
 * declared?* — and nothing else. It is pure: it takes a parsed package manifest and
 * returns a frozen description of what was found. No filesystem access, no module
 * resolution, no imports of project code, and no judgement about whether a declared
 * specifier is a usable version range (that belongs to the shared version engine,
 * which already owns "is this in range / can this be evaluated at all").
 *
 * Why this is its own module rather than three lines inside a check:
 *
 *  • "Not declared" and "declared but not installed" are different states with
 *    different fixes, and telling them apart reliably requires looking at the
 *    manifest the same way every time. One implementation, one behaviour.
 *  • A manifest is untrusted input. It is user-editable JSON that may contain
 *    non-string values, blank strings, inherited keys or entries in fields that do
 *    not install anything. Handling that defensively is real logic and deserves its
 *    own tests rather than being buried in a diagnostic rule.
 *  • It keeps the diagnostic rules free of manifest-shaped knowledge, so a future
 *    adapter (another framework, another manifest dialect) reuses the rules and
 *    replaces only the declaration reader.
 *
 * Deliberate boundaries, so reviewers do not "helpfully" widen them:
 *
 *  • `dependencies` and `devDependencies` are the only fields that count as a
 *    declaration. Cypress is a hard prerequisite for running Cypress tests, so an
 *    entry in `optionalDependencies` (best-effort install) or `peerDependencies`
 *    (declared by *this* package for *its consumers*, installed by nobody) does not
 *    describe an installed Cypress. Both are still recorded as *mentions*, so a
 *    "not declared" report can show the user the entry they are thinking of
 *    instead of appearing to have missed it.
 *  • Own properties only. A dependency key that arrives via the prototype chain is
 *    not a declaration; ignoring it prevents a crafted or polluted manifest from
 *    making a project look like it declares Cypress.
 *  • The specifier is recorded verbatim (trimmed), including `npm:` aliases,
 *    `file:`, `link:` and `workspace:` protocols. Evaluating those is somebody
 *    else's job; mis-evaluating them here would create a second, divergent
 *    interpretation of "supported version".
 */

import type {
  CypressDeclaration,
  CypressEvidenceDetail,
  DependencyField,
} from "./contracts.js";

/**
 * The package name this module looks for.
 *
 * Declared once, here, because declaration is the first thing that needs it and
 * every later stage (resolution, binary inspection, messaging) should import the
 * same constant rather than repeating a string literal that a rename or a typo could
 * silently break.
 */
export const CYPRESS_PACKAGE_NAME = "cypress";

/**
 * Manifest sections that can mention a dependency, in precedence order.
 *
 * Order is the precedence rule made executable: the first section that *counts as a
 * declaration* and carries a usable specifier wins. Putting the order in a tuple
 * means the rule is visible at a glance and testable directly, rather than being
 * implied by the sequence of `if` statements.
 */
export const CYPRESS_MANIFEST_FIELDS = [
  "devDependencies",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export type CypressMentionField = (typeof CYPRESS_MANIFEST_FIELDS)[number];

/**
 * How a manifest entry for Cypress was defective.
 *
 *   not-a-string — the value was present but not a string (a number, an object, null)
 *   blank        — the value was a string containing only whitespace
 *
 * Both mean "the project intends to declare Cypress but the manifest cannot be acted
 * on", which needs a correction message rather than an install message.
 */
export type CypressDeclarationDefect = "not-a-string" | "blank";

/**
 * A single manifest section that mentioned Cypress.
 *
 * Two booleans, deliberately separate, because they answer two different questions
 * that get conflated in bug reports:
 *   `installing` — would an install of this project fetch Cypress because of this
 *                  entry?
 *   `accepts`    — does this check treat the entry as a declaration of a required
 *                  Cypress?
 * `peerDependencies` is neither; `optionalDependencies` installs but does not
 * establish Cypress as a requirement.
 */
export interface CypressDeclarationMention {
  readonly field: CypressMentionField;
  /** The declared specifier, trimmed; `null` when present but unusable. */
  readonly specifier: string | null;
  /** True when this section causes Cypress to be installed for the project. */
  readonly installing: boolean;
  /** True when this section counts as a declaration for this check. */
  readonly accepts: boolean;
  readonly defect: CypressDeclarationDefect | null;
}

/**
 * A mention that satisfies both conditions this module cares about.
 *
 * Modelling the satisfied case as its own type is what removes the need for type
 * assertions: once a mention is narrowed here, `field` is provably a declaring
 * section and `specifier` is provably a string, so downstream code reads plain
 * properties instead of casting away nullables.
 */
interface AcceptedMention extends CypressDeclarationMention {
  readonly field: DependencyField;
  readonly specifier: string;
}

/**
 * The complete reading of a manifest, ready to be carried into diagnostic evidence
 * and consumed by the assessment step.
 *
 * `declaration` is the serialisable contract shape; the remaining fields exist so a
 * message can be specific ("declared in devDependencies as ^13.6.0", "mentioned only
 * in peerDependencies", "declared in two sections with different specifiers")
 * without re-reading the manifest and risking a different answer.
 */
export interface CypressDeclarationReading {
  /** Contract-shaped answer: declared (with winning range) or not. */
  readonly declaration: CypressDeclaration;
  /** Which section won, when something was accepted. */
  readonly field: DependencyField | null;
  /** The winning specifier, trimmed, when something was accepted. */
  readonly specifier: string | null;
  /** Every section that mentioned Cypress, in precedence order. */
  readonly mentions: readonly CypressDeclarationMention[];
  /** The defect that prevented acceptance, if any. */
  readonly defect: CypressDeclarationDefect | null;
  /**
   * True when two accepted sections declare Cypress with different specifiers.
   * Recorded rather than resolved silently: precedence still picks a winner so the
   * check can proceed, but the disagreement is a real manifest problem the user
   * should see.
   */
  readonly conflict: boolean;
}

/** The minimum shape this module needs from a parsed manifest. */
export interface CypressDeclaringManifest {
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
  readonly optionalDependencies?: unknown;
  readonly peerDependencies?: unknown;
}

/**
 * Sections whose entry actually installs Cypress for the project.
 * `peerDependencies` is excluded: a peer range is a statement about consumers.
 */
const INSTALLING_FIELDS: ReadonlySet<CypressMentionField> =
  new Set<CypressMentionField>([
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]);

/**
 * The acceptance rule, as a type guard.
 *
 * A guard rather than a lookup set: it narrows `field` to `DependencyField`, which is
 * exactly the knowledge the rest of this file needs in order to build a
 * contract-shaped declaration without asserting anything. The two names here are the
 * authoritative definition of "declared"; `CYPRESS_MANIFEST_FIELDS` supplies the
 * order they are considered in.
 */
function isDeclaringField(
  field: CypressMentionField,
): field is DependencyField {
  return field === "dependencies" || field === "devDependencies";
}

/**
 * Narrows a mention to one that both declares Cypress and carries a usable
 * specifier.
 *
 * This is the single reason no cast is needed later: the predicate teaches the
 * compiler what `filter` would otherwise only know at runtime.
 */
function isAcceptedMention(
  mention: CypressDeclarationMention,
): mention is AcceptedMention {
  return isDeclaringField(mention.field) && mention.specifier !== null;
}

/**
 * Reads the Cypress declaration from a parsed package manifest.
 *
 * Never throws. A manifest that is missing, `null`, not an object, or has malformed
 * sections produces a "not declared" reading with the reason recorded — because the
 * caller is a diagnostic whose entire purpose is to describe broken input, and an
 * exception here would turn "this project looks odd" into "QAT crashed".
 */
export function readCypressDeclaration(
  manifest: CypressDeclaringManifest | null | undefined,
): CypressDeclarationReading {
  const mentions: CypressDeclarationMention[] = [];

  for (const field of CYPRESS_MANIFEST_FIELDS) {
    // `=== null` as well as `undefined`: a manifest parsed from JSON can hold an
    // explicit null for a section, which is not the same as an absent section but is
    // equally unusable.
    const container = manifest?.[field];
    if (container === null || container === undefined) continue;

    const entry = readEntry(container, CYPRESS_PACKAGE_NAME);
    if (entry === undefined) continue; // section does not mention Cypress

    mentions.push({
      field,
      specifier: entry.specifier,
      installing: INSTALLING_FIELDS.has(field),
      accepts: isDeclaringField(field),
      defect: entry.defect,
    });
  }

  const accepted = mentions.filter(isAcceptedMention);
  const winner = accepted[0];

  // A defect is only reported when a *declaring* section is present but unusable. A
  // malformed entry in `peerDependencies` is not a reason to say the project failed
  // to declare Cypress; it was never a declaration to begin with.
  const defect =
    winner === undefined
      ? (mentions.find(
          (mention) =>
            isDeclaringField(mention.field) && mention.defect !== null,
        )?.defect ?? null)
      : null;

  const conflict =
    new Set(accepted.map((mention) => mention.specifier)).size > 1;

  // Annotated for contextual typing, so the union members need no literal
  // assertions; frozen because readings are shared with evidence and reporting.
  const declaration: CypressDeclaration =
    winner === undefined
      ? { declared: false }
      : { declared: true, range: winner.specifier, field: winner.field };

  const reading: CypressDeclarationReading = {
    declaration: Object.freeze(declaration),
    field: winner === undefined ? null : winner.field,
    specifier: winner === undefined ? null : winner.specifier,
    mentions: Object.freeze(mentions),
    defect,
    conflict,
  };

  return Object.freeze(reading);
}

/**
 * Narrows an unknown value to a plain keyed object.
 *
 * Arrays are excluded on purpose: `typeof [] === 'object'` is true, but a dependency
 * section is never an array, so an array here is malformed rather than a map of
 * dependency names. Returning `false` for it keeps the caller's "does this section
 * mention the dependency?" question honest — a malformed section simply does not
 * mention anything, and manifest-shape errors are reported by manifest validation.
 *
 * A predicate is used rather than `as Record<string, unknown>` because TypeScript
 * will not widen `object` to an indexed type: `object` carries no index signature, so
 * an assertion would be the only alternative, and assertions on untrusted input are
 * exactly what this module exists to avoid.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads one dependency entry out of one manifest section.
 *
 * Returns `undefined` when the section does not mention the dependency at all, and a
 * mention (possibly with `specifier: null` and a `defect`) when it does. That
 * distinction matters: "absent" and "present but unusable" produce different
 * remediation, and collapsing them is a common source of wrong advice.
 *
 * Own properties only — a key inherited from the prototype chain is not something the
 * user wrote in their manifest.
 */
function readEntry(
  container: unknown,
  name: string,
):
  | {
      readonly specifier: string | null;
      readonly defect: CypressDeclarationDefect | null;
    }
  | undefined {
  if (!isRecord(container)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(container, name)) return undefined;

  const value = container[name];

  if (typeof value !== "string")
    return { specifier: null, defect: "not-a-string" };

  const trimmed = value.trim();
  if (trimmed === "") return { specifier: null, defect: "blank" };

  // Recorded verbatim. Aliases (`npm:cypress@13.6.0`) and local protocols
  // (`file:`, `link:`, `workspace:`) are legitimate declarations; whether they can be
  // evaluated is the version engine's decision, made once, elsewhere.
  return { specifier: trimmed, defect: null };
}

/**
 * Projects a reading into display-safe diagnostic evidence.
 *
 * Lives here, next to the reading, so field names and shape can never drift apart. It
 * is intentionally flat and free of paths, environment values or anything else that
 * could carry a secret into a persisted diagnostic session.
 */
export function toDeclarationEvidence(
  reading: CypressDeclarationReading,
): CypressEvidenceDetail {
  const evidence: CypressEvidenceDetail = {
    declared: reading.declaration.declared,
    declaredIn: reading.field,
    declaredSpecifier: reading.specifier,
    mentions: reading.mentions.map(
      (mention) => `${mention.field}:${mention.specifier ?? "(unusable)"}`,
    ),
    defect: reading.defect,
    conflict: reading.conflict,
  };

  return Object.freeze(evidence);
}
