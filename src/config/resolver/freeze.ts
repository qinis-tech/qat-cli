/**
 * Recursive freezing for resolved configuration data.
 *
 * Resolution output is shared: validation reads it, the report writer reads it,
 * and the execution adapter reads it long after the run starts. Without a freeze,
 * any one of them can change a value the others already acted on, and the
 * resulting failure appears in whichever consumer happens to read second. Freezing
 * converts that class of bug into an immediate `TypeError` at the point of the
 * mistake, with a stack trace that names the culprit.
 *
 * Scope: this helper is for *plain data* — objects, arrays, strings, numbers,
 * booleans, `null`. Configuration documents arrive through JSON parsing and the
 * schema layer, so that is the only shape it ever sees. Exotic values (`Date`,
 * `Map`, typed arrays) are not part of the contract; freezing them would be
 * misleading, because `Object.freeze` does not stop `map.set()` or
 * `date.setTime()`, and silently skipping them would hide a loader defect.
 *
 * Kept in its own module rather than beside the defaulting service so that both
 * the defaults table and the merge logic can use it without importing each other.
 */

/**
 * Nesting limit.
 *
 * Bounded on purpose. `seen` below stops cycles, but a deeply nested — yet
 * finite — document would still exhaust the call stack, and a stack overflow
 * reports nothing a user can act on. Real configuration documents nest four or
 * five levels deep, so this limit is never approached in practice; when it is,
 * the document is almost certainly malformed and worth saying so explicitly.
 */
export const MAX_FREEZE_DEPTH = 128;

/**
 * Freeze a value and everything reachable from it, returning the same instance.
 *
 * Identity is preserved deliberately: callers keep their existing references, so
 * freezing cannot quietly detach an object from code that already holds it.
 */
export function deepFreeze<T>(value: T): T {
  // The single assertion in this module. `Object.freeze` preserves identity and
  // every property, so the result is the same value with a narrower capability;
  // propagating `Readonly<T>` through every signature would spread a modifier far
  // beyond the one place that depends on it.
  return freezeValue(value, new WeakSet<object>(), 0) as T;
}

/**
 * Walk and freeze one value.
 *
 * `seen` prevents a self-referencing structure from recursing forever and ensures
 * a subtree shared by two parents is visited once rather than twice.
 */
function freezeValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return value;

  if (depth >= MAX_FREEZE_DEPTH) {
    throw new TypeError(
      `Refusing to freeze configuration data nested deeper than ${MAX_FREEZE_DEPTH} levels. ` +
        "A configuration document that deep is almost certainly malformed.",
    );
  }
  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;

    // Accessor properties are skipped rather than invoked. Reading a getter would
    // run code belonging to an object we are in the middle of distrusting, and a
    // getter that throws would turn a freeze into an unexplained resolution
    // failure. Configuration data has data properties only.
    if (!("value" in descriptor)) continue;

    freezeValue(descriptor.value, seen, depth + 1);
  }

  // `Object.isFrozen` is deliberately not used as an early exit: it is shallow.
  // A frozen parent can still hold a mutable child, so short-circuiting on it
  // would leave part of the tree writable while reporting success.
  return Object.freeze(value);
}
