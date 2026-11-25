/**
 * Environment access, runtime detection and configuration precedence.
 *
 * Imports nothing from `src/` except the error vocabulary, its own files, and — for the runtime adapter
 * alone — the port it implements, which is declared by the layer that consumes it rather than by this
 * one. No filesystem access, no process spawning, no logging.
 *
 * Every member here is a pure function of a value passed in. There is exactly one exception, and it is
 * stated rather than implied, because an undocumented exception is how a directory stops being able to
 * promise anything:
 *
 *   `runtime.ts` reads the version of the interpreter that is running QAT. That is a single property
 *   read of `process.versions.node` — no spawn, no file, no environment variable — and even that read
 *   is injectable (`createProcessRuntime({ node: '20.11.1' })`), which is what keeps the claim below
 *   true rather than merely aspirational.
 *
 * The claim itself is unchanged: everything here is testable without touching the real process
 * environment. A module that could not meet that would belong in a different directory, not in this
 * one with an asterisk.
 *
 * ## What is deliberately not re-exported
 *
 * `RuntimeProbe` is declared in `core/application/ports.ts`, beside the layer that consumes it; this
 * directory supplies the implementation. Re-exporting the port from here would invert the dependency
 * direction and let a consumer depend on the adapter while believing it depends on the contract.
 * Import the interface from the application ports and the factory from here — and a test can then take
 * either, including a three-line fake that never imports the adapter at all.
 */
export * from "./precedence.js";
export * from "./secrets.js";
export * from "./variables.js";
// Listed last on purpose: it is the only member that touches the host, so a reader scanning this
// block meets the pure modules first and the single, injectable exception after them.
export * from "./runtime.js";
