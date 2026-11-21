/**
 * Public surface of the domain.
 *
 * Everything outside `core/domain` imports from this file, never from a sibling module
 * directly. That single rule is what allows the domain to be reorganised — a type moved
 * from `execution.ts` to `primitives.ts`, a file split in two — without touching a
 * single consumer.
 *
 * It also makes the boundary rule enforceable. `no-restricted-imports` bans the domain
 * from importing other layers; consumers reaching into `core/domain/execution.js`
 * directly would defeat the same boundary from the other direction.
 *
 * Star exports rather than an explicit list, for now. The trade-off is real: an
 * explicit list documents the contract and catches accidental additions, while star
 * exports let any new export become public without review. Star is right while the
 * domain is small and under active construction; switch to explicit named exports when
 * the surface stabilises and accidental exposure starts mattering.
 *
 * Note on ambiguity: two modules exporting the same name from here is an error
 * (TS2308), not a silent override. The shared identifier aliases therefore live only in
 * `primitives.ts` and are deliberately not re-exported by `execution.ts`.
 */

export * from "./configuration.js";
export * from "./evidence.js";
export * from "./execution.js";
export * from "./primitives.js";
export * from "./project.js";
