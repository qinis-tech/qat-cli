/**
 * Environment access, runtime detection and configuration precedence.
 *
 * The public surface of the environment layer: how configuration resolves across sources, how
 * secrets are redacted for display, how variables are read and judged, and how the running
 * interpreter is identified.
 *
 * ## Host access, stated precisely
 *
 * This directory is testable without touching the real process environment — but the way that is
 * achieved differs per module, and pretending there is a single exception would be the kind of
 * imprecision this layer exists to avoid. Two members can reach the host, and both do it through an
 * injectable default rather than a hard-wired global:
 *
 *   `runtime.ts`       reads `process.versions.node` — one property of the running interpreter, no
 *                      spawn, no file, no variable. Injectable: `createProcessRuntime({ node: '20.11.1' })`.
 *   `variables.ts`     falls back to `process.env` when no `source` is supplied. Every function takes
 *                      an `EnvironmentSource`, so a test passes a plain object and never touches the
 *                      real environment.
 *
 * Both are stated rather than implied: an undocumented exception is how a directory stops being able
 * to promise anything. A module that could not meet this bar would belong somewhere else, not here
 * with an asterisk.
 *
 * ## What each member is for
 *
 *   `precedence.ts`   deterministic resolution across configuration, profiles and process values.
 *   `secrets.ts`      sensitive-name detection and the redaction placeholder used in every output.
 *   `variables.ts`    value-faithful reads (`readVariable`) *and* the value-free usability judgement
 *                     (`probeVariablePresence`) that diagnostics are meant to use.
 *   `runtime.ts`      the injectable adapter over the running interpreter's version.
 *
 * The split inside `variables.ts` is the one worth knowing before using this barrel: `VariableState`
 * answers "what does the source literally contain", `VariablePresence` answers "is this usable". They
 * disagree, on purpose, about whitespace-only values. A caller that needs a value must use the first
 * and accept the responsibility; a caller reporting health must use the second and never see a value
 * at all.
 *
 * ## What is deliberately not re-exported
 *
 * `RuntimeProbe` (and every other port) is declared in `core/application/ports.ts`, beside the layer
 * that consumes it; this directory supplies the implementation. Re-exporting a port from here would
 * invert the dependency direction and let a consumer depend on the adapter while believing it depends
 * on the contract. Import the interface from the application ports and the factory from here — and a
 * test can then take either, including a three-line fake that never imports the adapter at all.
 *
 * ## Why wildcard exports
 *
 * Each submodule already decides what it exports, so internals stay internal; a wildcard barrel only
 * widens what is *already* public. The real consequence is one worth stating plainly: promoting a
 * symbol inside `variables.ts` promotes it here too. Exporting from a submodule in this directory is
 * therefore a public-API decision, and should be reviewed as one.
 */

// Resolution policy first, redaction second, host reads third, the machine last: the barrel reads in
// the order a reader needs the concepts, not the order the files happen to be listed on disk.
export * from "./precedence.js";
export * from "./secrets.js";
export * from "./variables.js";
export * from "./runtime.js";
