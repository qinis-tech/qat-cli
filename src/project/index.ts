/**
 * Public surface of project discovery.
 *
 * No exported singleton and no cached context: a context is a value produced by a call and passed
 * to whatever needs it. A module-level cache would make the result depend on what ran before it,
 * which is the opposite of the determinism this module exists to provide.
 */
export * from "./contracts.js";
export { discoverProject } from "./discovery.js";
export { resolveWorkingDirectory } from "./working-directory.js";
