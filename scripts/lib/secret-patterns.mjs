/**
 * Credential patterns that indicate a real secret rather than the mention of one.
 *
 * Deliberately HIGH-SIGNAL and deliberately narrow.
 *
 * A hook that flags the word "password" in a documentation file is disabled
 * within a week, and a disabled hook protects nothing. Being narrow means false
 * negatives on generic secrets — that gap is covered by three other layers:
 * provider-side push protection, the npm publication allowlist (an unlisted file
 * cannot ship), and this same scan running over the packed tarball.
 */
export const SECRET_PATTERNS = Object.freeze([
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    reason: "private key block",
  },
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    reason: "AWS access key id",
  },
  {
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/,
    reason: "npm access token",
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    reason: "GitHub token",
  },
  {
    pattern: /\bsk-[A-Za-z0-9]{32,}\b/,
    reason: "provider API key",
  },
]);

/**
 * @param {string} text
 * @returns {ReadonlyArray<string>} Human-readable reasons, one per match.
 */
export function findSecrets(text) {
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ reason }) => reason,
  );
}
