/**
 * Log level vocabulary.
 *
 * Six levels, ordered. `trace` exists for diagnosing the logger itself and should almost
 * never appear in production code; `fatal` exists because a process about to exit has no
 * second chance to report why.
 */

export const LogLevel = {
  Trace: "trace",
  Debug: "debug",
  Info: "info",
  Warn: "warn",
  Error: "error",
  Fatal: "fatal",
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/** Ordered least to most severe. Order is what makes filtering comprehensible. */
export const LOG_LEVELS = [
  LogLevel.Trace,
  LogLevel.Debug,
  LogLevel.Info,
  LogLevel.Warn,
  LogLevel.Error,
  LogLevel.Fatal,
] as const;

/**
 * `info` rather than `warn` or `debug`.
 *
 * A CLI invoked normally prints its own output and says nothing through the logger. The
 * default therefore governs how much *diagnostic* noise accompanies that, and `debug` as a
 * default would make every run produce a wall of text nobody asked for.
 */
export const DEFAULT_LOG_LEVEL: LogLevel = LogLevel.Info;

/**
 * Narrows an arbitrary value to a `LogLevel`.
 *
 * Separate from `resolveLogLevel` so a caller can distinguish "not supplied" from
 * "supplied and wrong". A mistyped `--log-level` deserves an actionable rejection rather
 * than silently falling back, and only the caller knows how to phrase that.
 */
export function isLogLevel(value: unknown): value is LogLevel {
  return (
    typeof value === "string" &&
    (LOG_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Resolves the effective level from the sources that may supply one, in precedence order.
 *
 * Precedence: explicit flag, then environment variable, then default. Invalid values from
 * either source are ignored here — the caller validates its own flag first, and an invalid
 * environment variable is a configuration mistake that must not stop a run.
 */
export function resolveLogLevel(sources: {
  readonly flag?: string | undefined;
  readonly environment?: string | undefined;
}): LogLevel {
  if (isLogLevel(sources.flag)) return sources.flag;
  if (isLogLevel(sources.environment)) return sources.environment;

  return DEFAULT_LOG_LEVEL;
}
