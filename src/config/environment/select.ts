/**
 * Environment selection — which profile is in use, and why.
 *
 * This module answers one question and nothing else: given the three places a
 * profile name can come from, which one wins, and what was its origin?
 *
 * Why it is a separate, pure module:
 *  • the precedence order is the whole contract, so it must be assertable by a
 *    single test and comparable against the documentation;
 *  • selection must be deterministic — an environment that depends on the order
 *    of a directory listing is an environment nobody can reproduce;
 *  • the answer has to carry its reason, because "we ran against staging" and
 *    "we ran against staging because you passed --env" are different facts, and
 *    only the second one is debuggable.
 *
 * Deliberately absent: any value lookup, any filesystem access, any defaulting
 * to a well-known name, and any merging of profiles. A selection the user
 * cannot predict is a selection they cannot debug.
 */

import type { EnvironmentSelection, SelectionOrigin } from "./contracts.js";

// ─── Precedence ──────────────────────────────────────────────────────────────

/**
 * The selection order, highest precedence first.
 *
 * Exported because it is quoted by the documentation and asserted by a contract test: one table, one
 * truth. If this array and the documentation ever disagree, one of them is lying about what QAT does.
 *
 * Frozen at runtime, not merely typed as readonly. `as const` is a claim to the compiler; this array
 * leaves the module, so a consumer without types can still push into it — and a mutated precedence list
 * would change behaviour for every later test in the same process, which is the worst kind of
 * test-order dependency.
 */
export const SELECTION_PRECEDENCE = Object.freeze([
  "explicit-cli",
  "process-environment",
  "configuration-default",
] as const satisfies readonly SelectionOrigin[]);

/** The origins that can actually select a profile. `none` is the absence of one. */
export type SelectableOrigin = (typeof SELECTION_PRECEDENCE)[number];

/**
 * Raw candidates, as supplied by the caller.
 *
 * `undefined` means "not supplied". Anything else — including an empty string —
 * means "supplied", and is treated as a deliberate act. That distinction is the
 * reason this file does not use truthiness checks.
 */
export interface EnvironmentSelectionInput {
  /** From the command line, e.g. `--env staging`. */
  readonly explicit?: string;
  /** From the process environment, e.g. `QAT_ENV`. */
  readonly fromProcess?: string;
  /** From configuration, e.g. `defaultEnvironment`. */
  readonly fromConfiguration?: string;
}

/**
 * One reader per origin, keyed exhaustively.
 *
 * Using a `Record` over `SelectableOrigin` (rather than a hand-written if-chain)
 * means adding a fourth source later is a compile error until it is wired up
 * here — the precedence list and the readers cannot drift apart.
 */
const readCandidate: Readonly<
  Record<
    SelectableOrigin,
    (input: EnvironmentSelectionInput) => string | undefined
  >
> = {
  "explicit-cli": (input) => input.explicit,
  "process-environment": (input) => input.fromProcess,
  "configuration-default": (input) => input.fromConfiguration,
};

/** Returned when nothing was supplied. Frozen: it is shared, so it must not mutate. */
const NO_SELECTION: EnvironmentSelection = Object.freeze({ origin: "none" });

// ─── Selection ───────────────────────────────────────────────────────────────

/**
 * Picks the winning candidate and reports where it came from.
 *
 * Two rules do all the work here:
 *
 * 1. The first *supplied* candidate wins — not the first *usable* one.
 *    An empty or whitespace-only name is returned as `name: ''` with its real
 *    origin instead of falling through to the next candidate. Falling through
 *    would silently run against a different environment than the one that was
 *    asked for, which is the single worst outcome this function can produce.
 *    The caller turns `name: ''` into a reportable invalid selection.
 *
 * 2. Surrounding whitespace is trimmed, interior whitespace is not touched.
 *    `--env " staging "` is a shell artefact and is forgiven; `"sta ging"` is
 *    not a name and stays visible so validation can reject it with the user's
 *    own input quoted back.
 */
export function selectEnvironment(
  input: EnvironmentSelectionInput,
): EnvironmentSelection {
  for (const origin of SELECTION_PRECEDENCE) {
    const candidate = readCandidate[origin](input);

    // Defensive rather than decorative: callers pass values that originate
    // outside TypeScript (CLI argv, process.env), so a non-string here is a real
    // possibility and must be treated as "not supplied" rather than coerced.
    if (typeof candidate !== "string") continue;

    return { origin, name: candidate.trim() };
  }

  return NO_SELECTION;
}

// ─── Name rules ──────────────────────────────────────────────────────────────

/** Upper bound, so a pathological input cannot become a pathological message. */
export const MAX_ENVIRONMENT_NAME_LENGTH = 64;

/**
 * Names are single tokens: they appear in CLI arguments, JSON output, evidence
 * and diagnostics, so anything that needs quoting somewhere is refused here
 * rather than supported inconsistently everywhere.
 *
 * Rejected by this pattern: whitespace, control characters, path separators,
 * quotes, glob characters and anything starting with punctuation.
 */
const USABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Whether a selected name is one QAT can act on.
 *
 * Kept separate from `selectEnvironment` because selection and validation are
 * different jobs: selection must always return something (including a bad
 * answer), while validation decides whether that answer is usable. Splitting
 * them is what allows the inspection step to report "you selected something
 * unusable" instead of quietly choosing something else.
 *
 * Case is preserved and compared exactly: `Staging` and `staging` are different
 * profiles, and saying so is friendlier than guessing which was meant.
 */
export function isUsableName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_ENVIRONMENT_NAME_LENGTH &&
    USABLE_NAME.test(name)
  );
}
