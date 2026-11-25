/**
 * Detection of the Node.js runtime that is executing QAT.
 *
 * This module is a port adapter and nothing more: it answers one question —
 * "which version is running us?" — and answers it in a single property read.
 * It performs no parsing, no validation, no comparison and no policy. Those live
 * in `core/compatibility`, which is what makes the whole compatibility matrix
 * testable without touching a real interpreter.
 *
 * Why `process.versions.node` and not `exec('node --version')`:
 *
 *   • CORRECTNESS — a child process reports the first `node` on PATH, which may
 *     be a different binary from the one already running this code (nvm, volta,
 *     fnm and hand-rolled wrapper scripts all make this routine). Reporting on
 *     the wrong interpreter is worse than not reporting at all: the message
 *     would confidently name a version the user is not running.
 *   • COST — a spawn costs tens of milliseconds and a process; the property read
 *     costs nothing. Diagnostics has a tight responsiveness budget, and there is
 *     no reason to spend it on information already in memory.
 *   • RELIABILITY — a spawn can fail (ENOENT, EPERM, path corruption) for reasons
 *     that have nothing to do with compatibility, and that failure would then be
 *     reported as a runtime problem. A property read has no such failure mode.
 *
 * The adapter deliberately returns the version UNPARSED. Normalising, validating
 * and ordering are `core/compatibility/version.ts`'s job, and only its job:
 * two normalisation points are two answers waiting to disagree.
 *
 * Security note: this module reads no environment variables, no filesystem paths
 * and no configuration. Nothing it touches can carry a credential, so nothing it
 * returns can leak one into a persisted diagnostic session.
 */

/**
 * The shape this adapter needs from the host.
 *
 * Declared as a minimal structural type rather than the full `NodeJS.ProcessVersions`
 * for two reasons: the adapter cannot accidentally start depending on something
 * it does not need, and tests can pass a one-property object
 * (`{ node: '18.19.0' }`) without a cast.
 */
export interface ProcessVersionSource {
  /** The runtime version, as reported by the host, e.g. `20.11.1`. */
  readonly node?: string;
}

/**
 * Read-only access to the running runtime's identity.
 *
 * A port, not a utility: the diagnostic that consumes it must be testable
 * without mutating globals, and a future non-Node host (or an embedded/edge
 * runtime) can supply its own implementation without the check changing.
 *
 * Declared as a property holding a function rather than a method, so that
 * `const { readNodeVersion } = runtime` is safe — a method shorthand would lose
 * `this` the moment someone destructured it, which is a bug that only appears in
 * the one caller that tried.
 *
 * Returning `string | undefined` is part of the contract, not an inconvenience:
 * "the host did not report a version" is a real state that must reach the
 * verdict as indeterminate, and a `string`-only signature would force callers to
 * invent a value for it.
 */
export interface RuntimePort {
  readonly readNodeVersion: () => string | undefined;
}

/**
 * Creates the standard, process-backed implementation.
 *
 * The version source is injectable so tests can drive the entire boundary matrix
 * (supported, unsupported, pre-release, malformed) through the real check with a
 * two-line fixture, instead of monkey-patching `process`.
 *
 * @param versions the version source, defaulting to the live `process.versions`
 * @returns a frozen port; reading it is a property access, so no caching is
 *          warranted (a cache here would be state to reason about for no gain)
 */
export function createProcessRuntime(
  versions: Readonly<ProcessVersionSource> = currentProcessVersions(),
): RuntimePort {
  return Object.freeze({
    readNodeVersion(): string | undefined {
      const version = versions.node;

      // Absent or blank is reported as absent, not as a strange version. The
      // parser would reject `''` anyway, but naming it correctly at the port
      // keeps the reason accurate: "no version reported" is a different message
      // from "reported something we could not read".
      return typeof version === "string" && version.trim() !== ""
        ? version
        : undefined;
    },
  });
}

/**
 * Reads the live process versions, tolerating hosts that have no `process`.
 *
 * QAT is a Node CLI, so this branch should never be taken in production — but a
 * diagnostic tool must degrade rather than crash when its environment is not
 * what it expects. Returning an empty source produces a clear "no version
 * reported" finding; throwing a `ReferenceError` here would abort the very
 * command a user runs because something is wrong with their setup.
 */
function currentProcessVersions(): Readonly<ProcessVersionSource> {
  return typeof process === "undefined" ? {} : process.versions;
}
