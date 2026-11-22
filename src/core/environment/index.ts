/**
 * Environment access and configuration precedence.
 *
 * Imports nothing from `src/` except the error vocabulary and its own files: no filesystem access,
 * no process spawning, no logging. Everything here is a pure function of a value passed in, which is
 * what makes it testable without touching the real process environment.
 */
export * from "./precedence.js";
export * from "./secrets.js";
export * from "./variables.js";
