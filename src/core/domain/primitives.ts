/**
 * Identifier and timestamp primitives shared across the domain.
 *
 * These exist so that no domain module has to import another domain module merely to
 * name a value. Before this file, `execution.ts` imported `EvidenceReference` from
 * `evidence.ts` while `evidence.ts` imported `ExecutionId` from `execution.ts` — a
 * circular type-only import.
 *
 * That cycle is harmless today, because `verbatimModuleSyntax` guarantees `import type`
 * is fully erased at runtime. It is fragile anyway: the moment either side gains a value
 * export — a status constant, a factory function — the cycle becomes real, and a real
 * cycle fails as an undefined binding during module evaluation, which is unpleasant to
 * diagnose and easy to introduce by accident.
 *
 * This file imports nothing. That is not a coincidence or a limitation; it is the point.
 */

/**
 * ISO 8601 instant in UTC, e.g. `2026-11-21T09:41:07.123Z`.
 *
 * A string rather than a `Date` because results are serialised, persisted and later read
 * by code that did not write them. A `Date` does not survive JSON in any case, so the
 * type states the truth at the boundary instead of losing it there.
 *
 * UTC, not local time, so two results from different machines are comparable without
 * the reader needing to know the offset.
 */
export type IsoTimestamp = string;

/**
 * Identifier for one execution.
 *
 * System-generated and opaque. No consumer may parse it, derive meaning from its shape,
 * or depend on its format — which is why no format is documented here. Documenting one
 * would be an invitation to parse it, and the first parser turns an implementation
 * detail into a contract that cannot be changed.
 *
 * Constructed by the `IdGenerator` port in the composition root, so a test can supply a
 * deterministic value without stubbing a clock or a UUID library.
 */
export type ExecutionId = string;

/**
 * Identifier for one collected artefact.
 *
 * Same rules as `ExecutionId`: system-generated, opaque, never parsed.
 */
export type EvidenceId = string;

/**
 * Name of a configured environment, e.g. `staging`.
 *
 * Note the difference from the two identifiers above: this one is **user-authored**, so
 * its format is whatever the project's configuration file declares. Code must not assume
 * a shape, a case convention or a character set — validation belongs to the configuration
 * loader, which is the only place that can know what the file allows.
 *
 * Treating a user-supplied name as though it were generated is how a value ends up in a
 * path or a filename without being checked.
 */
export type EnvironmentId = string;
