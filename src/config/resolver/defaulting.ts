import type {
  DefaultableConfiguration,
  DefaultEnvironmentResolution,
} from "./contracts.js";
import {
  CONFIGURATION_DEFAULTS,
  PREFERRED_ENVIRONMENT_KEY,
} from "./defaults.js";
import { deepFreeze } from "./freeze.js";

/**
 * The defaulting service: fill what the user omitted, and nothing else.
 *
 * This is the only place in the application where a configuration document gains
 * values it did not contain. Three properties follow from that, and each one is
 * tested rather than merely intended:
 *
 * - **Explicit values win.** `undefined` is the only signal that a field was
 *   omitted. A truthiness test would erase `false`, `0` and `""` — values a user
 *   typed on purpose — which is the single most common defaulting bug.
 * - **A malformed value is not a missing one.** When `output` is written as a
 *   string, or a path as a number, that is a validation problem. Replacing it with
 *   something plausible would delete the error the user most needs to see.
 * - **The input is never touched.** A frozen copy is returned, so the document
 *   handed to validation, reporting and execution cannot diverge between
 *   consumers, and re-running the service is a no-op.
 *
 * Only two groups have defaults — the environment map and the output paths.
 * `defaultEnvironment` is derived rather than defaulted, and nothing under
 * `cypress` has a default at all: those are the values QAT must never invent.
 *
 * Import direction is deliberate: this module reads the defaults table and the
 * freeze helper, and neither reads it back, so the resolver graph stays acyclic.
 */

/* -------------------------------------------------------------------------- */
/* Shape helpers                                                              */
/* -------------------------------------------------------------------------- */

/** A configuration group as it exists at runtime: keys of unknown trustworthiness. */
type UnknownRecord = Readonly<Record<string, unknown>>;

/**
 * True for a document-style object, false for anything else.
 *
 * The prototype check matters: a `Map`, a `Date` or a class instance would
 * otherwise be spread into an empty object and silently lose its contents. Those
 * shapes cannot come from JSON, so treating them as malformed — and letting
 * validation say so — is more honest than quietly rebuilding them.
 *
 * Exported because the resolution stage asks the same question when it decides
 * whether a settings group is a document at all. A second copy would eventually
 * disagree about a `Map` or a class instance, and the two callers would disagree
 * about what a valid file looks like.
 */
export function isPlainObject(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Merge one group of settings, defaulting only the children that are absent.
 *
 * - Nothing supplied: take the default group wholesale, so a provider that seeds
 *   extra children is honoured rather than partially ignored.
 * - Something supplied that is not an object: return it untouched. Validation
 *   reports malformed groups; this service does not repair them.
 * - An object supplied: copy it, then fill the listed children that are
 *   `undefined`. Unknown children survive the copy, which keeps the "unknown
 *   field" error pointing at the field the user actually mistyped.
 */
function mergeGroup(
  value: unknown,
  defaults: unknown,
  keys: readonly string[],
): unknown {
  const fallback = isPlainObject(defaults) ? defaults : {};

  if (value === undefined) return { ...fallback };

  if (!isPlainObject(value)) return value;

  const merged: Record<string, unknown> = { ...value };
  for (const key of keys) {
    if (merged[key] === undefined) merged[key] = fallback[key];
  }
  return merged;
}

/* -------------------------------------------------------------------------- */
/* Defaulting                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Apply defaults to a configuration document.
 *
 * Pure: no I/O, no clock, no working-directory lookup. The same document and the
 * same defaults always produce the same frozen result, which is what makes the
 * behaviour cheap to test and safe to call more than once.
 *
 * The two merged groups are written out by name rather than driven by a table.
 * With two entries a loop would save four lines and cost the reader the ability to
 * see, at a glance, exactly which fields this stage may introduce — and that list
 * is the whole contract of the function.
 */
export function applyDefaults(
  document: DefaultableConfiguration,
  defaults: Readonly<DefaultableConfiguration> = CONFIGURATION_DEFAULTS,
): DefaultableConfiguration {
  const merged: UnknownRecord = {
    // Spread first so every field the user wrote — and every unknown field the
    // schema layer will reject — survives untouched.
    ...document,

    // An environment map supplied by the user is taken as written: QAT has no
    // business adding variables nobody declared. When it is absent, the default
    // empty map is inserted, so a consumer never has to distinguish "no
    // environments" from "an empty set of them".
    environments: mergeGroup(document.environments, defaults.environments, []),

    // Output paths are the one place a default genuinely saves setup work, and
    // the one place a wrong value would be visible in every run: two project
    // relative directories, nothing derived from the clock, the host or the
    // working directory.
    output: mergeGroup(document.output, defaults.output, [
      "reports",
      "evidence",
    ]),
  };

  // One narrowing, at the public boundary, and the reason it exists:
  //
  // `merged` is deliberately assembled as a plain record of `unknown` values so
  // that a malformed value (`"output": "reports"`, `"reports": 42`) can be carried
  // through instead of being replaced. The resulting shape is therefore a claim
  // about the document, not a proof, and the schema layer is what actually
  // verifies it. Keeping the single assertion here means there is exactly one
  // place to review whenever that contract changes.
  return deepFreeze(merged as DefaultableConfiguration);
}

/* -------------------------------------------------------------------------- */
/* Default environment selection                                              */
/* -------------------------------------------------------------------------- */

/**
 * Decide which environment a run targets, or report that nobody has said.
 *
 * Preference order, narrowest evidence first:
 *
 * 1. A `defaultEnvironment` the user named.
 * 2. An environment literally called "default", so the conventional name needs
 *    no extra configuration.
 * 3. The only environment the project declares, because there is nothing to
 *    choose between.
 * 4. Otherwise nothing — deliberately. Falling back to the first declared
 *    environment would point a run at an arbitrary target, and a suite that
 *    exercises the wrong environment is the most expensive failure available.
 *
 * The origin is returned alongside the name so an operator can see that QAT
 * inferred the environment rather than being told. Whether a named environment
 * actually exists is a validation question, answered by the schema layer; this
 * function only chooses.
 */
export function selectDefaultEnvironment(
  document: DefaultableConfiguration,
): DefaultEnvironmentResolution {
  const configured = document.defaultEnvironment;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return { origin: "configured", name: configured.trim() };
  }

  const environments = isPlainObject(document.environments)
    ? document.environments
    : {};

  if (
    Object.prototype.hasOwnProperty.call(
      environments,
      PREFERRED_ENVIRONMENT_KEY,
    )
  ) {
    return { origin: "declared", name: PREFERRED_ENVIRONMENT_KEY };
  }

  const declared = Object.keys(environments);
  const [only] = declared;
  if (declared.length === 1 && only !== undefined) {
    return { origin: "sole", name: only };
  }

  return { origin: "none" };
}
