/**
 * Reading a version, as opposed to interpreting one.
 *
 * The only question this project asks of a version string is which major it starts with, because the rule that
 * matters is a major-number comparison against a policy. Range resolution, precedence and compatibility
 * checking are deliberately absent: they need a semver implementation, and nobody here performs a comparison
 * that would justify putting one behind every consumer of a version.
 *
 * A trailing component is required, so `13.15.0` reads and `13` does not. Cypress always reports three
 * components; a string without them is a defect rather than a version, and `undefined` says so instead of
 * guessing a major from a prefix.
 */
export function majorOf(version: string): number | undefined {
  const match = /^(\d+)\./.exec(version);

  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}
