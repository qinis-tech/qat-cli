/**
 * Public surface of the logging module.
 *
 * Application code should import the `Logger` port from `core/application/ports` and receive
 * a logger as a dependency. This barrel is for the composition root, which constructs the
 * service, and for tests.
 */
export * from "./destination.js";
export * from "./levels.js";
export * from "./logger.js";
export * from "./redaction.js";
