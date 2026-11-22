/**
 * Classification and redaction of environment variables that carry credentials.
 *
 * ## What this is
 *
 * A name-based judgement, made before any value is read. It exists so that a diagnostic snapshot —
 * `qat doctor`, a debug log, a pasted environment — cannot disclose a credential even when the code
 * that produced it made no decision about what was sensitive.
 *
 * ## What this is not
 *
 * A guarantee. A secret in a variable called `SETTING` is not detected, and no naming rule can fix
 * that. The primary defence remains the same as everywhere else in this project: do not put a
 * credential where it will be printed, and do not print the environment wholesale.
 */

/** What a redacted value is replaced with. Chosen to be obviously not a value. */
export const REDACTED_PLACEHOLDER = "[redacted]";

/**
 * Words that mark a variable as sensitive.
 *
 * Matched against whole words after splitting on non-alphanumeric characters, so `API_KEY` matches
 * on `KEY` while `KEYBOARD` and `MONKEY` do not. `PWD` is deliberately absent: it is the working
 * directory in a shell, not a password.
 */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "KEY",
  "CREDENTIAL",
  "CREDENTIALS",
  "AUTH",
  "AUTHORIZATION",
  "PRIVATE",
  "SESSION",
  "COOKIE",
  "SALT",
  "SIGNATURE",
  "CERT",
  "CERTIFICATE",
  "SEED",
  "DSN",
]);

/**
 * Whether a variable name suggests its value should never be displayed.
 *
 * Errs towards redacting: `AUTH_URL` is classified sensitive even though a URL is rarely secret,
 * because the cost of redacting something harmless is a less useful diagnostic, and the cost of the
 * opposite is a leaked credential.
 */
export function isSensitiveVariable(name: string): boolean {
  const words = name.toUpperCase().split(/[^A-Z0-9]+/);

  return words.some((word) => word.length > 0 && SENSITIVE_WORDS.has(word));
}

/** The value to display for a variable: the value itself, or the placeholder. */
export function displayValue(name: string, value: string): string {
  return isSensitiveVariable(name) ? REDACTED_PLACEHOLDER : value;
}
