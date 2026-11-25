import { z } from "zod";

import {
  RESERVED_NAMES,
  environmentName,
  environmentVariableName,
  environmentVariableValue,
  profileBaseUrl,
} from "./constraints.js";

/**
 * A named environment, as the configuration format models it.
 *
 * ## Why a profile is an object rather than a map of variables
 *
 * The obvious shape for an environment is `"staging": { "API_URL": "https://…" }`. It is wrong twice over, and both
 * failures are of the kind that only surface once somebody depends on them:
 *
 * - **It has nowhere to put anything that is not a string.** A target address or an execution setting would have to be
 *   smuggled in as a variable whose name happens to look special, and every consumer would then contain a list of
 *   reserved variable names — a second schema, spread across the codebase, that nobody reviews.
 * - **It makes a secret and a variable the same kind of thing.** Telling them apart would be a naming convention, which
 *   is to say no mechanism at all once a token is written into the wrong map.
 *
 * A profile has fields with meanings, and each of them may be absent.
 *
 * ## Why `variables` and `secrets` are separate maps
 *
 * This is the load-bearing decision in the file. One map with a prefix — `"SECRET_API_TOKEN": "env:NAME"` — is a
 * convention: followed by whoever read the documentation, broken by whoever did not, and invisible to everything that
 * parses the file. Two maps are enforced by the types. A variable value is a string; a secret reference is an object;
 * putting one where the other belongs is a validation error that names the field.
 *
 * ## Why the reserved-name guard lives here
 *
 * Because this is the only place in the format with user-chosen keys, and therefore the only place `__proto__` can do
 * damage. `JSON.parse` keeps it as an own enumerable key, but a record rebuilds its result by *assigning* each key — and
 * assigning `__proto__` on an ordinary object changes that object's prototype instead of adding a property, so the key
 * is gone before any key schema could refuse it. Walking the raw value is the only point at which it still exists.
 *
 * Guarding it here rather than at the root of the schema means no consumer can obtain a validated `environments` map
 * without the guard having run. The root object does not need the walk: its keys are the schema's own, and `.strict()`
 * refuses an unrecognised one before anything is assigned.
 */

/* -------------------------------------------------------------------------- */
/* Records whose keys are names                                               */
/* -------------------------------------------------------------------------- */

/**
 * The minimum a name schema must be able to do: answer whether a string is an acceptable name, and say why not.
 *
 * Declared as an interface with the two outcomes in the method's return type. An `interface` because the project's lint
 * rule requires one for an object shape; the outcomes stay a union rather than a pair of optional fields because
 * `success: false` guarantees an `error`, and a caller that has checked one should not have to check the other.
 *
 * Structural rather than generic over zod's types, so any name schema — `environmentName`, `environmentVariableName`, or
 * whatever a later rule needs — is accepted without the annotation having to name a version-specific schema type.
 */
interface NameRule {
  safeParse(value: string):
    | { readonly success: true }
    | {
        readonly success: false;
        readonly error: {
          readonly issues: readonly { readonly message: string }[];
        };
      };
}

/**
 * A record whose keys are names, with a diagnostic that names the offending key.
 *
 * ## Why this exists rather than `z.record(environmentName, …)`
 *
 * A record given a key schema refuses a bad key with the fixed sentence *"Invalid key in record"*. The key schema's own
 * message — the part that says what a name must look like — never reaches the reader. For a file edited by hand that is
 * the difference between *"something is wrong with one of your variables"* and *"variable name `api_url` must be
 * uppercase letters, digits and underscores"*.
 *
 * So keys are validated here instead: the record accepts any string key, and each key is put through the name schema so
 * its own sentence reaches the message, at the key's own path. The rule is still stated once — this runs the constraint,
 * it does not restate it — so a change to a name rule changes every message it produces.
 *
 * ## Why quoting the key is safe when quoting a value is not
 *
 * A key is the part of a file its author typed deliberately; a value can be a credential pasted into the wrong field. The
 * diagnostics layer makes the same distinction when it names an unrecognised key and describes an unrecognised value.
 */
function keyedRecord<TValue extends z.ZodType>(
  keyRule: NameRule,
  valueSchema: TValue,
  noun: string,
): z.ZodType<Record<string, z.infer<TValue>>> {
  return z.record(z.string(), valueSchema).superRefine((entries, ctx) => {
    for (const name of Object.keys(entries)) {
      const parsed = keyRule.safeParse(name);

      if (parsed.success) continue;

      ctx.addIssue({
        code: "custom",
        path: [name],
        message: `${noun} ${JSON.stringify(name)} ${parsed.error.issues[0]?.message ?? "is not valid"}`,
      });
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Secrets                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where a secret comes from.
 *
 * One member today, stated as a closed set so the field cannot promise a source nothing implements. The member exists at
 * all — rather than a bare name being enough — so that the day a second source is added, every existing entry keeps
 * meaning exactly what it meant before.
 */
export const SecretSource = {
  Environment: "environment",
} as const;

export type SecretSource = (typeof SecretSource)[keyof typeof SecretSource];

/**
 * A reference to a secret — never the secret.
 *
 * `name` is the environment variable that holds the value; the value itself never appears in the file, which is the whole
 * point of the field existing.
 *
 * `.strict()` is a security control rather than tidiness. A reader who writes the credential beside the name gets "the key
 * `value` is not part of the configuration" — addressed to the line they typed — instead of a secret in a pull request and
 * a rotation nobody planned. That is a rule the parser enforces; "never put secrets in this file" is only advice, and
 * advice loses to a deadline.
 */
export const secretReferenceSchema = z
  .object({
    from: z.literal(SecretSource.Environment),
    name: environmentVariableName,
  })
  .strict();

export type SecretReference = z.output<typeof secretReferenceSchema>;

/* -------------------------------------------------------------------------- */
/* The profile                                                                */
/* -------------------------------------------------------------------------- */

/** Non-sensitive values handed to the framework, exactly as they will be given to it. */
const variablesSchema = keyedRecord(
  environmentVariableName,
  environmentVariableValue,
  "variable name",
);

/** Secrets the framework should be given, each one named and none of them written down. */
const secretsSchema = keyedRecord(
  environmentVariableName,
  secretReferenceSchema,
  "secret name",
);

/**
 * One named environment.
 *
 * Every field is optional, because an environment that only sets a target is legitimate. The refinements below are what
 * stop "every field is optional" from degenerating into "the profile is empty", which is a different thing and a worse
 * one.
 *
 * The messages start lowercase and are written to follow the dotted path, because that is how the diagnostic renderer
 * presents them: `environments.staging declares no base URL, variables or secrets…`. A message that began with a capital
 * would read as two sentences spliced together.
 */
export const profileSchema = z
  .object({
    /**
     * The target this environment addresses.
     *
     * Not a variable, and not a free-form string: it is checked as an absolute http(s) URL with no credentials in it, so
     * a password pasted into a URL is refused here rather than committed.
     */
    baseUrl: profileBaseUrl.optional(),

    /** Non-sensitive values for this environment. */
    variables: variablesSchema.optional(),

    /** Names of secrets to resolve at run time. Never values. */
    secrets: secretsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // An empty profile is a typo wearing a name: it validates, it can be selected as the default, and it changes nothing —
    // so the first symptom is a run against whatever the previous command left behind, reported as though `staging` had
    // applied. Refusing it here turns that into a message at the moment the file is read.
    if (
      value.baseUrl === undefined &&
      value.variables === undefined &&
      value.secrets === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message:
          "declares no base URL, variables or secrets. Add one of them, or remove the environment.",
      });
    }

    // A present-but-empty map is the same defect one level down: it says "these apply" and applies none of them.
    if (
      value.variables !== undefined &&
      Object.keys(value.variables).length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["variables"],
        message:
          "declares no variables. Remove the field, or list the ones this environment sets.",
      });
    }

    if (
      value.secrets !== undefined &&
      Object.keys(value.secrets).length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["secrets"],
        message:
          "declares no secrets. Remove the field, or name the ones this environment needs.",
      });
    }
  });

export type EnvironmentProfile = z.output<typeof profileSchema>;
export type EnvironmentProfileInput = z.input<typeof profileSchema>;

/* -------------------------------------------------------------------------- */
/* The collection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Refuses reserved names before the record schema can reassign them.
 *
 * Runs on the raw value, which is the only place `__proto__` still exists — see the note at the top of this file for why
 * that is true and why the assignment, not the key schema, is what makes it vanish.
 *
 * It stops at the first problem in a bag and continues to the next bag, rather than collecting everything: a document
 * that is trying to change a prototype is not one whose remaining field errors are worth compiling, and the pipeline
 * short-circuits once a stage fails anyway.
 */
function refuseReservedProfileNames(
  value: unknown,
  ctx: z.RefinementCtx,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return;

  /** The two maps whose keys are the user's, and therefore the two that need checking. */
  const maps = [
    { field: "variables", label: "variable name" },
    { field: "secrets", label: "secret name" },
  ] as const;

  for (const name of Object.keys(value)) {
    if (RESERVED_NAMES.has(name)) {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: `"${name}" is reserved by the language and cannot be used as a profile name`,
      });
      continue;
    }

    const profile = (value as Record<string, unknown>)[name];

    if (
      typeof profile !== "object" ||
      profile === null ||
      Array.isArray(profile)
    )
      continue;

    for (const map of maps) {
      const entries = (profile as Record<string, unknown>)[map.field];

      if (
        typeof entries !== "object" ||
        entries === null ||
        Array.isArray(entries)
      )
        continue;

      for (const key of Object.keys(entries)) {
        if (!RESERVED_NAMES.has(key)) continue;

        ctx.addIssue({
          code: "custom",
          path: [name, map.field, key],
          message: `"${key}" is reserved by the language and cannot be used as a ${map.label}`,
        });
      }
    }
  }
}

/**
 * Every environment the project declares, keyed by name.
 *
 * A pipeline rather than one record: the first stage inspects the raw value for reserved keys, the second validates the
 * shape. `z.unknown()` is what lets the first stage see an input the second will have transformed.
 *
 * The two layers are not redundant, and the order matters. The walk catches `__proto__` while it is still a key; by the
 * time the record rebuilds the object the key has become a prototype assignment and no longer exists to be refused. A
 * name schema then refines the same rule again on each key, which costs nothing and covers a caller that reached this
 * record some other way.
 *
 * The keys are the user's, so this contributes one field path to the schema's own field list and nothing more — there is
 * no finite set of names to enumerate, and a catalogue that tried would be describing documents rather than the format.
 */
export const environmentsSchema = z
  .unknown()
  .superRefine(refuseReservedProfileNames)
  .pipe(keyedRecord(environmentName, profileSchema, "profile name"));

export type EnvironmentProfiles = z.output<typeof environmentsSchema>;
