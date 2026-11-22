/**
 * Public surface of local persistence.
 *
 * Only implementations and the schema. The contract itself belongs to the application layer, where
 * the services that consume it live — a caller should never need to import this module to hold a
 * repository.
 */
export * from "./memory/execution-repository.js";
export * from "./schema.js";
