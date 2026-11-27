/**
 * The CFG-004 validation verdict: how far could we safely establish that the
 * configuration is valid, and who said so?
 *
 * Validation is a ladder, in increasing cost and decreasing certainty:
 *
 *   T0-text     non-empty, faithfully decodable UTF-8 text within budget.
 *               Establishes nothing about syntax, but catches the truncated and
 *               binary files that bad merges and corrupted checkouts produce.
 *   T1-json     parse the file. For a `.json` configuration this is definitive:
 *               a parser cannot be wrong about a syntax error, and nothing needs
 *               to be executed.
 *   T2-cypress  ask the project's own loader. Required for executable
 *               configurations, because only Cypress can evaluate them.
 *   —           otherwise `indeterminate`: we looked, and we are not entitled to
 *               an opinion.
 *
 * The ladder exists so that every answer arrives with its authority attached.
 * "Invalid" is only reachable when a mechanism actually established invalidity —
 * a confident wrong verdict about configuration is the most expensive error a
 * doctor can make, and silence is cheaper than a lie.
 *
 * Purity: no filesystem, no clock, no globals. The single concession is that T2
 * awaits an injected port, which reports its own duration so that this module
 * need not read the clock to report a cost.
 */

import type {
  ConfigCheckId,
  ConfigDiscovery,
  ConfigFailure,
  ConfigFileFacts,
  ConfigTextSample,
  ConfigValidation,
  ConfigValidationGapCause,
  CypressConfigFormat,
  ValidationTier,
} from "./contracts.js";

/**
 * Result of asking the project's loader to load the configuration.
 *
 * `unavailable` and `timeout` are deliberately distinct from `failed`: a missing
 * mechanism or an exhausted budget proves nothing about the file, while a
 * failure is a real observation. Collapsing them would let a slow machine look
 * like a broken configuration.
 *
 * `durationMs` is reported by the probe rather than measured here, so this module
 * never reads a clock and stays testable without fake timers.
 */
export type ConfigLoadProbeResult =
  | { readonly outcome: "loaded"; readonly durationMs: number }
  | {
      readonly outcome: "failed";
      readonly message: string;
      readonly durationMs: number;
    }
  | { readonly outcome: "unavailable" }
  | { readonly outcome: "timeout"; readonly durationMs: number };

/**
 * The loader capability, owned by its consumer (dependency inversion).
 *
 * The implementation lives in `preflight.ts`: a bounded, non-interactive
 * invocation of the project's own Cypress CLI. Keeping the interface here is what
 * lets the ladder be unit-tested with a stub and what makes it impossible for
 * this module to acquire an accidental import of a process runner.
 *
 * `projectRoot` is required rather than optional: the probe must run the loader
 * *inside the project*, and a default would silently point it at whatever
 * directory QAT happens to occupy.
 */
export interface ConfigLoadProbePort {
  readonly load: (input: {
    readonly projectRoot: string;
  }) => Promise<ConfigLoadProbeResult>;
}

/**
 * Cap on loader output kept in evidence.
 *
 * A failing loader can emit a full stack trace with an embedded code frame. The
 * useful part is at the top; the rest is noise that makes diagnostics unreadable
 * and evidence large.
 */
export const MAX_LOADER_MESSAGE_CHARS = 800;

/**
 * ANSI CSI sequence matcher, assembled rather than written as a literal.
 *
 * A regex literal containing a raw escape byte trips `no-control-regex`, so the
 * pattern is built from `String.fromCharCode(27)`: identical match, no control
 * character in the source. The global flag is safe here — `String.prototype.
 * replace` runs its own pass and does not depend on a shared `lastIndex`.
 */
const ANSI_ESCAPE_SEQUENCE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`,
  "g",
);

const freeze = (value: ConfigValidation): ConfigValidation =>
  Object.freeze(value);

/**
 * Which discovery verdicts leave something worth validating.
 *
 * Only reasons that name a file we believe Cypress will load. An advisory
 * `MISPLACED` configuration sits beside a working one — validating the ignored
 * file would attach a verdict to a file Cypress never reads.
 *
 * The format is carried because it decides the branch, not because it belongs in
 * the verdict: `tier` already tells a reader which mechanism spoke, and `T1-json`
 * versus `T2-cypress` can only ever mean one shape each.
 */
function loadableTarget(
  discovery: ConfigDiscovery,
): { readonly file: string; readonly format: CypressConfigFormat } | undefined {
  switch (discovery.reason) {
    case "CYPRESS_CONFIG_FOUND":
      return { file: discovery.file, format: discovery.format };

    // A legacy file is readable and parseable even though it is deprecated:
    // deprecation is a format question, validity is a separate one.
    case "CYPRESS_CONFIG_LEGACY_FORMAT":
      return { file: discovery.file, format: "json" };

    default:
      return undefined;
  }
}

/**
 * Explains the skip in terms of the check we are waiting on.
 *
 * Naming the prerequisite means a reader never has to guess why CFG-004 is
 * silent — and it tells them which one problem to fix first.
 */
function skipBecauseOf(discovery: ConfigDiscovery): ConfigValidation {
  const detail =
    discovery.reason === "CYPRESS_CONFIG_NOT_APPLICABLE"
      ? "No Cypress configuration is expected in this project, so there is nothing to validate."
      : `The Cypress configuration could not be located (${discovery.reason}), so there is nothing to validate.`;

  return freeze({
    reason: "CYPRESS_CONFIG_SKIPPED",
    outcome: "skipped",
    prerequisite: "CFG-003" satisfies ConfigCheckId,
    detail,
  });
}

function notValidated(
  file: string,
  cause: ConfigValidationGapCause,
  tier: ValidationTier,
): ConfigValidation {
  return freeze({
    reason: "CYPRESS_CONFIG_NOT_VALIDATED",
    outcome: "indeterminate",
    file,
    tier,
    cause,
  });
}

/**
 * Text-level sanity (T0).
 *
 * Ordered from "we have no bytes" outward: a sample we never took, one we
 * deliberately skipped, one that failed to read, text that is not UTF-8, text
 * that contains NUL bytes, and text with nothing in it. Each produces a different
 * cause, because "this file is binary", "this file is too big" and "we are not
 * allowed to read this file" lead to three different actions.
 */
function classifySample(
  sample: ConfigTextSample | undefined,
):
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly cause: ConfigValidationGapCause } {
  if (sample === undefined)
    return { ok: false, cause: "text-sanity-not-established" };
  if (sample.state === "skipped-too-large")
    return { ok: false, cause: "size-budget-exceeded" };
  if (sample.state === "unreadable")
    return { ok: false, cause: "text-sanity-not-established" };

  if (!sample.decodable) return { ok: false, cause: "undecodable-text" };

  // NUL bytes are valid UTF-8, so decodability alone does not tell binary from
  // text. Handing binary content to a loader would be a wasted process; refusing
  // it here keeps the reason honest.
  if (sample.containsBinary)
    return { ok: false, cause: "text-sanity-not-established" };

  // A whitespace-only file parses as nothing and loads as nothing: it is present
  // but carries no configuration, which is a gap in the evidence rather than an
  // invalidity we can prove about any statement.
  if (sample.text.trim() === "")
    return { ok: false, cause: "text-sanity-not-established" };

  return { ok: true, text: sample.text };
}

/**
 * Parses a JSON configuration (T1).
 *
 * Terminal and authoritative: a parser is never wrong about syntax, so there is
 * no need — and no excuse — to involve the loader afterwards. Node's own message
 * already carries a position, and newer versions include a line, so the line
 * number is extracted rather than guessed whenever it can be.
 *
 * `JSON.parse` is `as unknown` at the boundary: the value is genuinely unknown
 * until the shape check below proves it is an object, and saying so keeps the
 * `any` from travelling any further.
 */
function parseJsonConfiguration(file: string, text: string): ConfigValidation {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The configuration is not valid JSON.";

    return freeze({
      reason: "CYPRESS_CONFIG_INVALID",
      outcome: "fail",
      file,
      tier: "T1-json" as const,
      failure: failureOf("syntax", message, lineFromMessage(text, message)),
    });
  }

  // Cypress expects an object of settings. An array or a primitive parses
  // perfectly and is still unusable, which is a shape problem, not a syntax one
  // — reporting the wrong kind sends people looking for a stray comma.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return freeze({
      reason: "CYPRESS_CONFIG_INVALID",
      outcome: "fail",
      file,
      tier: "T1-json" as const,
      failure: failureOf(
        "shape",
        "The configuration must be a JSON object of settings.",
      ),
    });
  }

  return freeze({
    reason: "CYPRESS_CONFIG_VALIDATED",
    outcome: "pass",
    file,
    tier: "T1-json" as const,
  });
}

function failureOf(
  kind: ConfigFailure["kind"],
  message: string,
  line?: number,
): ConfigFailure {
  return Object.freeze({
    kind,
    message: sanitiseLoaderMessage(message),
    ...(line === undefined ? {} : { line }),
  });
}

/**
 * Recovers a line number from a parser message, falling back to the byte
 * position. Best-effort by design: a wrong line number is worse than none, so a
 * position that cannot be mapped yields no line at all.
 *
 * Captures are read through optional access rather than indexing, so the
 * function is correct under `noUncheckedIndexedAccess` as well as at runtime.
 */
function lineFromMessage(text: string, message: string): number | undefined {
  const explicitLine = /line (\d+)/i.exec(message)?.[1];
  if (explicitLine !== undefined) return Number(explicitLine);

  const position = /position (\d+)/i.exec(message)?.[1];
  if (position === undefined) return undefined;

  const offset = Number(position);
  if (!Number.isFinite(offset) || offset < 0 || offset > text.length)
    return undefined;

  // Count newlines before the offset; a position on the first line is line 1.
  return text.slice(0, offset).split("\n").length;
}

/**
 * Makes loader output safe to store and read.
 *
 * Three transforms, each with a reason: ANSI escapes would corrupt a terminal or
 * a log viewer; whitespace runs would store a code frame as one unreadable
 * paragraph; and an unbounded message would let one failure dominate the report.
 * Nothing here can introduce content — only remove and shorten it.
 */
export function sanitiseLoaderMessage(message: string): string {
  const withoutAnsi = message.replace(ANSI_ESCAPE_SEQUENCE, "");
  const collapsed = withoutAnsi.replace(/\s+/g, " ").trim();

  return collapsed.length <= MAX_LOADER_MESSAGE_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_LOADER_MESSAGE_CHARS - 1)}…`;
}

/**
 * The validation verdict for a located configuration.
 *
 * Contract with the caller: this function never throws for a configuration
 * problem. Every outcome — valid, invalid, not attempted, skipped — is a value,
 * because a diagnostic that raises on bad input cannot report on bad input.
 *
 * `projectRoot` is an input rather than something read from the environment: the
 * loader must run inside the project being diagnosed, and the only layer that
 * knows which project that is, is the caller.
 */
export async function validateConfiguration(input: {
  /** Absolute project root. Used solely to run the loader in the right place. */
  readonly projectRoot: string;
  readonly discovery: ConfigDiscovery;
  /** Facts and sample for the located file. */
  readonly facts: ConfigFileFacts | undefined;
  /** Whether deeper loading is permitted for this run. */
  readonly deep?: { readonly enabled: boolean };
  readonly probe?: ConfigLoadProbePort;
}): Promise<ConfigValidation> {
  const target = loadableTarget(input.discovery);

  // Nothing located means nothing to validate. Skipping with the prerequisite
  // named is the honest answer; inventing a verdict here would fabricate an
  // observation we never made.
  if (target === undefined) return skipBecauseOf(input.discovery);

  const located = classifySample(input.facts?.sample);

  if (!located.ok) {
    // A size overrun never read a byte, so no tier spoke: reporting `T0-text`
    // there would imply a text judgement that did not happen.
    return notValidated(
      target.file,
      located.cause,
      located.cause === "size-budget-exceeded" ? "none" : "T0-text",
    );
  }

  // JSON is terminal: parse it and stop. Involving the loader would add a
  // process, a timeout and a failure mode in exchange for no extra certainty.
  if (target.format === "json") {
    return parseJsonConfiguration(target.file, located.text);
  }

  // Executable configuration: only the project's own loader can evaluate it, and
  // only when the run explicitly asked for depth. Describing the gap precisely is
  // the whole point — "not validated" with no cause is a shrug.
  if (input.deep?.enabled !== true) {
    return notValidated(target.file, "deep-validation-disabled", "T0-text");
  }

  if (input.probe === undefined) {
    return notValidated(target.file, "deep-validation-unavailable", "T0-text");
  }

  const result = await input.probe.load({ projectRoot: input.projectRoot });

  switch (result.outcome) {
    case "loaded":
      return freeze({
        reason: "CYPRESS_CONFIG_VALIDATED",
        outcome: "pass",
        file: target.file,
        tier: "T2-cypress" as const,
        durationMs: result.durationMs,
      });

    case "failed":
      // The loader spoke: this is a real observation and worth an Error.
      return freeze({
        reason: "CYPRESS_CONFIG_INVALID",
        outcome: "fail",
        file: target.file,
        tier: "T2-cypress" as const,
        failure: failureOf("load", result.message),
        durationMs: result.durationMs,
        truncated: result.message.length > MAX_LOADER_MESSAGE_CHARS,
      });

    case "timeout":
      // An exhausted budget proves nothing about the file. Reporting the
      // timeout as invalidity would blame the user for our own bound.
      return notValidated(target.file, "probe-timeout", "T0-text");

    case "unavailable":
      return notValidated(
        target.file,
        "deep-validation-unavailable",
        "T0-text",
      );
  }
}
