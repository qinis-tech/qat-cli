/**
 * The structured logging service.
 *
 * Pino is the implementation; this module is the policy — level resolution, correlation
 * bindings, redaction, and a guarantee that logging can never take down a command.
 *
 * ## Relationship to CLI output
 *
 * The logger is **not** the user-facing output layer and must never be used as one.
 *
 *   Output  → stdout, stable, part of the command's contract, rendered by `src/cli/output`
 *   Logs    → stderr, diagnostic, unstable, for whoever is debugging
 *
 * A user reading a command's result should be able to ignore stderr entirely. A pipeline
 * consuming stdout should never see a log line. If something belongs in both, it is a design
 * question about what the command reports, not a reason to log it twice.
 */
import {
  pino,
  stdTimeFunctions,
  type DestinationStream,
  type Logger as PinoLogger,
} from "pino";

import type { Logger, LogContext } from "../application/ports.js";

import { DEFAULT_LOG_LEVEL, type LogLevel } from "./levels.js";
import { REDACTION_CENSOR, REDACTION_PATHS } from "./redaction.js";

/** Fields bound to a logger once, rather than repeated at every call site. */
export type LogBindings = Readonly<Record<string, unknown>>;

/**
 * The service the rest of the application uses.
 *
 * Extends the `Logger` port, so anything accepting the port accepts this. The extra members
 * are for the composition root and for tests; application code should only ever need the
 * port's six methods.
 */
export interface LoggerService extends Logger {
  /** Derives a logger with additional fields. Does not affect the receiver. */
  child(bindings: LogBindings): LoggerService;
  /** Derives a logger bound to a component name. */
  forComponent(component: string): LoggerService;
  /** Derives a logger bound to a run identifier, so every line from one execution correlates. */
  forRun(runId: string): LoggerService;
  /** Whether a level would be emitted. Use to avoid building expensive context for nothing. */
  isLevelEnabled(level: LogLevel): boolean;
  /** Best-effort drain of any buffered entries. */
  flush(): void;
}

export interface LoggingOptions {
  readonly level?: LogLevel;
  readonly destination?: DestinationStream;
  /** Bound to every entry. Typically the module's own name. */
  readonly component?: string;
  /** Bound to every entry. Typically the current execution identifier. */
  readonly runId?: string;
}

/**
 * Creates a logger.
 *
 * Synchronous on purpose. An async factory would force every module that wants a logger to
 * become async, or to accept a promise, for a decision that belongs at startup. Pretty
 * printing is the only asynchronous part and is resolved by the composition root before this
 * is called.
 */
export function createLogger(options: LoggingOptions = {}): LoggerService {
  const destination = guardDestination(options.destination ?? process.stderr);

  const instance = pino(
    {
      level: options.level ?? DEFAULT_LOG_LEVEL,

      // Omitted rather than defaulted. Pino's defaults are pid and hostname: noise for a
      // single-process CLI, and hostname is mildly identifying in a shared log.
      base: null,

      // ISO 8601 rather than epoch milliseconds. A log a human reads at 2am should not need
      // a converter, and ISO sorts correctly as a string.
      timestamp: stdTimeFunctions.isoTime,

      // Emit `"level":"info"` rather than `"level":30`. The number is an implementation
      // detail of pino; the label is what a person greps for and what a filter matches.
      formatters: { level: (label) => ({ level: label }) },

      // Emit `"message"` rather than pino's default `"msg"`.
      //
      // The rest of the system already says `message`: `toLogObject()` emits it,
      // `describeError` returns it, and the port signature above takes it. Letting the log
      // format use a fourth name for the same concept is a translation tax on every reader
      // and on every consumer that joins a log entry to an error record.
      messageKey: "message",

      redact: { paths: [...REDACTION_PATHS], censor: REDACTION_CENSOR },
    },
    destination,
  );

  const bindings: LogBindings = {
    ...(options.component === undefined
      ? {}
      : { component: options.component }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
  };

  return wrap(instance, bindings);
}

/**
 * Adapts the port's signature onto pino's.
 *
 * The port says `(message, context?)` because that is what reads well at a call site in
 * application code. Pino says `(context, message)` because its first argument is what carries
 * bindings and serialised errors. The difference is confined to this function.
 */
function wrap(instance: PinoLogger, bindings: LogBindings): LoggerService {
  const bound =
    Object.keys(bindings).length === 0 ? instance : instance.child(bindings);

  const emit = (
    level: LogLevel,
    message: string,
    context?: LogContext,
  ): void => {
    const payload = context ?? {};

    // A switch rather than indexing `instance[level]`: pino's methods are separate
    // overloads, and indexing by a union defeats the type checking. The exhaustive switch
    // means a seventh level fails to compile here rather than throwing at runtime.
    switch (level) {
      case "trace":
        bound.trace(payload, message);
        break;
      case "debug":
        bound.debug(payload, message);
        break;
      case "info":
        bound.info(payload, message);
        break;
      case "warn":
        bound.warn(payload, message);
        break;
      case "error":
        bound.error(payload, message);
        break;
      case "fatal":
        bound.fatal(payload, message);
        break;
    }
  };

  return {
    trace: (message, context) => {
      emit("trace", message, context);
    },
    debug: (message, context) => {
      emit("debug", message, context);
    },
    info: (message, context) => {
      emit("info", message, context);
    },
    warn: (message, context) => {
      emit("warn", message, context);
    },
    error: (message, context) => {
      emit("error", message, context);
    },
    fatal: (message, context) => {
      emit("fatal", message, context);
    },

    child: (extra) => wrap(instance, { ...bindings, ...extra }),
    forComponent: (component) => wrap(instance, { ...bindings, component }),
    forRun: (runId) => wrap(instance, { ...bindings, runId }),

    isLevelEnabled: (level) => bound.isLevelEnabled(level),

    flush: () => {
      try {
        bound.flush();
      } catch {
        // Draining is best-effort. A destination that cannot flush has already been reported
        // by the guard below, and failing here would turn shutdown into a crash.
      }
    },
  };
}

/**
 * Wraps a destination so a write failure cannot propagate into application code.
 *
 * The failure mode this prevents: a log call inside a catch block throws because the
 * destination is broken — a closed pipe, a full disk — and replaces the original error. The
 * user then sees a logging failure instead of the reason the command failed, which is the
 * worst possible trade.
 *
 * Reported once, not once per entry: a broken destination would otherwise produce a megabyte
 * of complaint about producing no logs.
 */
function guardDestination(destination: DestinationStream): DestinationStream {
  let reported = false;

  return {
    write(chunk: string): void {
      try {
        destination.write(chunk);
      } catch (error) {
        if (reported) return;
        reported = true;

        try {
          const detail = error instanceof Error ? error.message : String(error);
          process.stderr.write(
            `[logging] a log entry could not be written and was dropped: ${detail}\n`,
          );
        } catch {
          // stderr is unavailable too. There is nowhere left to report to, and throwing here
          // would defeat the purpose of the guard.
        }
      }
    },
  };
}
