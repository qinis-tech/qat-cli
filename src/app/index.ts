/**
 * Public surface of the composition root.
 *
 * Imported by the CLI entry and by tests. Nothing else may import it: a service that reaches into the
 * composition root has stopped declaring what it needs, and the lint rules say so.
 */
export * from "./composition.js";
export * from "./contracts.js";
