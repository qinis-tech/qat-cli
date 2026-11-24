/**
 * Public surface of the configuration schema.
 *
 * The schema, the version constant and the two inferred types. The primitives in `constraints.ts` are not exported: a
 * consumer that reached for `relativeProjectPath` would be building a second schema, and the loader, the initialisation
 * workflow and the resolver all want the same one.
 *
 * `zod` itself is not re-exported. A consumer that needs `ZodIssue` imports it from `zod`, which is the module that owns
 * it — and re-exporting it here would make this file a second route into a dependency.
 */
export {
  qatConfigSchema,
  SUPPORTED_CONFIG_VERSION,
  type QatConfig,
  type QatConfigInput,
} from "./config.js";
