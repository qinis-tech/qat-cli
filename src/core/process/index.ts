/**
 * Public surface of the process module.
 *
 * This is the only layer permitted to spawn a child process, and — through the lint exemption on
 * this directory — the only one permitted to terminate the QAT process itself.
 *
 * `errors.ts` is deliberately not exported. Translation from a library's error shape into
 * `ProcessExecutionError` is an implementation detail; consumers catch the application error,
 * which they already know.
 */
export * from "./contracts.js";
export * from "./run.js";
