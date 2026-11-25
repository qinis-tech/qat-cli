/**
 * Public surface of the configuration schema.
 *
 * Two vocabulary groups: what the file is (`./config.js`) and what an environment inside it is (`./profiles.js`). Six
 * values and six types between them, and every one of them has a consumer outside this folder.
 *
 * ## Why the profiles are part of the surface
 *
 * Because a consumer can hold one. A command that selects an environment receives a profile and reads its target, its
 * variables and its secret references; describing those three shapes again in the application layer would be the second
 * definition of a format this module exists to define once. The types travel, and so does `SecretSource`, because
 * comparing `reference.from` against a literal in three places is how a closed set stops being closed.
 *
 * ## What is deliberately absent
 *
 * **The profile schemas themselves.** `profileSchema`, `environmentsSchema` and `secretReferenceSchema` stay in
 * `profiles.ts`. A runtime consumer parses a *document*, and `qatConfigSchema` is the only schema that does that; the
 * profile schemas are the pieces it is built from, and publishing them would invite a caller to validate a fragment and
 * conclude they had validated a configuration. A test that wants one imports the module directly, which is cheaper than
 * a public route maintained for nobody.
 *
 * **The primitives in `constraints.ts`.** A consumer that reached for `relativeProjectPath` or `profileBaseUrl` would be
 * building a second schema — one field at a time, with its own idea of what a path or a URL may be — and the loader, the
 * initialisation workflow and the resolver all want the same one.
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
 *
 * It lists one path for `environments` and none for the profile's own fields. That is not an omission: `baseUrl`,
 * `variables` and `secrets` are properties of a *value* in the document, not paths through it, and the format
 * documentation describes them in prose for the same reason.
 */
export {
  CONFIG_FIELD_PATHS,
  qatConfigSchema,
  OUTPUT_DEFAULTS,
  SUPPORTED_CONFIG_VERSION,
  type QatConfig,
  type QatConfigInput,
} from "./config.js";

export {
  SecretSource,
  type EnvironmentProfile,
  type EnvironmentProfileInput,
  type EnvironmentProfiles,
  type SecretReference,
} from "./profiles.js";
