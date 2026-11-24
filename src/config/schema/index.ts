/**
 * Public surface of the configuration schema.
 *
 * Three values and two types: the schema, the version constant, the field list, and the two shapes inferred from the
 * schema.
 *
 * ## What is deliberately absent
 *
 * **The primitives in `constraints.ts`.** A consumer that reached for `relativeProjectPath` would be building a second
 * schema — one field at a time, with its own idea of what a path may be — and the loader, the initialisation workflow
 * and the resolver all want the same one.
 *
 * **`zod`.** A consumer that needs `ZodIssue` imports it from `zod`, which is the module that owns it. Re-exporting it
 * here would make this file a second route into a dependency, and the route through a barrel is the one that goes stale.
 *
 * **The filename.** `CONFIG_FILE_NAME` lives in `../contracts.js`, because a filename is a property of the layer that
 * reads files rather than of what is inside one. A reader looking for it here would conclude it does not exist, which is
 * why this paragraph says where it is.
 *
 * ## Why the field list is part of the surface
 *
 * `CONFIG_FIELD_PATHS` exists for one caller: the test that compares it against the field table in
 * `docs/architecture/configuration-format.md`. It is exported rather than reached for through a deep import because a
 * test proving that the documentation matches the schema should be able to say so without depending on where the schema
 * keeps its internals.
 */
export {
  CONFIG_FIELD_PATHS,
  qatConfigSchema,
  OUTPUT_DEFAULTS,
  SUPPORTED_CONFIG_VERSION,
  type QatConfig,
  type QatConfigInput,
} from "./config.js";
