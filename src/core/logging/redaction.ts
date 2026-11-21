/**
 * Redaction of values that must never reach a log file.
 *
 * ## What this is
 *
 * A safety net. It catches the common case where a credential is logged because it was
 * part of an object someone logged wholesale.
 *
 * ## What this is not
 *
 * A guarantee. Path matching is finite — it covers the levels listed below and nothing
 * deeper — and it cannot recognise a secret that was put somewhere unexpected. The primary
 * defence is upstream: `ErrorContext` accepts primitives only, so a caller has to choose
 * what to record rather than passing a whole response body.
 *
 * Do not add a path here and consider the problem solved. If a value is secret, the fix is
 * to stop logging it, not to censor it after the fact.
 */

export const REDACTION_CENSOR = "[REDACTED]";

/**
 * Property names redacted at the top level and one level deep.
 *
 * One level below the root is deliberate: that is where a logged object's own fields live,
 * which is the realistic accident. Deeper nesting is rare enough that a broader wildcard
 * would cost more in surprising censored output than it saves in exposure.
 *
 * Wildcards (`*`) match exactly one path segment.
 */
export const REDACTION_PATHS: readonly string[] = [
  // Top level
  "password",
  "passphrase",
  "secret",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "api_key",
  "clientSecret",
  "privateKey",
  "authorization",
  "cookie",
  "credentials",

  // One level deep — the realistic accident shape
  "*.password",
  "*.passphrase",
  "*.secret",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "*.api_key",
  "*.clientSecret",
  "*.privateKey",
  "*.authorization",
  "*.cookie",
  "*.credentials",

  // HTTP-shaped payloads, in case a call site logs a request
  "headers.authorization",
  "headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",

  // Structured error context, which is a deliberate attachment point for diagnostics
  "err.context.password",
  "err.context.token",
  "err.context.secret",
];

/** Ready-made redaction options for the logger factory. */
export const REDACTION = {
  paths: [...REDACTION_PATHS],
  censor: REDACTION_CENSOR,
} as const;
