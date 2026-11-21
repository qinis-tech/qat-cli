/**
 * Where log entries go.
 *
 * Two destinations, one rule between them: logs never go to stdout.
 *
 * stdout is the command's output — the thing a pipeline consumes and a test asserts on.
 * stderr is the diagnostic channel. Mixing them means `qat run --json | jq` receives JSON
 * interleaved with log lines, and the failure looks like a bug in the consumer.
 */

import type { DestinationStream } from "pino";

/**
 * Structured JSON to stderr.
 *
 * The production choice: one object per line, parseable, greppable, and cheap. Writing to
 * `process.stderr` directly rather than through a buffered destination keeps shutdown
 * predictable — a log line written immediately before a fatal exit is still written.
 */
export function createJsonDestination(): DestinationStream {
  return process.stderr;
}

export interface PrettyDestinationOptions {
  readonly colour?: boolean;
}

interface PrettyFormatterOptions {
  readonly colorize: boolean;
  readonly translateTime: string;
  readonly ignore: string;
  readonly destination: number;
}

interface PrettyModule {
  readonly default: (options: PrettyFormatterOptions) => DestinationStream;
}

/**
 * Narrows the dynamically imported module without assigning an `any` value to a
 * typed variable. This also gives a useful fallback if the installed package does
 * not expose the expected default export.
 */
function isPrettyModule(value: unknown): value is PrettyModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "default" in value &&
    typeof value.default === "function"
  );
}

/**
 * Human-readable output for local development.
 *
 * `pino-pretty` is a development dependency, imported lazily. A user who installs QAT never
 * gets the module, so the dynamic import fails — and that failure is caught and reported as
 * a fallback to JSON rather than being allowed to crash a command. The alternative, shipping
 * a formatter to every user, is real weight for a feature only contributors use.
 *
 * Async because of the dynamic import; call it from the composition root, which may await
 * before the first log is written.
 */
export async function createPrettyDestination(
  options: PrettyDestinationOptions = {},
): Promise<DestinationStream> {
  try {
    const prettyModule: unknown = await import("pino-pretty");

    if (!isPrettyModule(prettyModule)) {
      throw new TypeError(
        "pino-pretty does not expose a compatible default export",
      );
    }

    return prettyModule.default({
      colorize: options.colour ?? true,
      // Wall-clock, to the millisecond. A relative or epoch timestamp is unreadable when
      // correlating against a CI job's own timestamps.
      translateTime: "SYS:HH:MM:ss.l",
      // Hostname and pid are noise for a single-process CLI, and hostname is mildly
      // identifying.
      ignore: "pid,hostname",
      destination: 2,
    });
  } catch {
    // Reported, not silent. A contributor who expected readable output needs to know why
    // they got JSON, and the run must continue either way.
    process.stderr.write(
      "[logging] pino-pretty is unavailable; falling back to JSON output. Run `npm install` in the repository.\n",
    );

    return process.stderr;
  }
}
