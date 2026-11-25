/**
 * The QAT configuration file.
 *
 * ## What this schema is for
 *
 * It is the only place that says what a configuration file may contain. The loader reads a file and calls it, the
 * initialisation workflow writes a file that it accepts, the environment resolver reads what it produced, and a test
 * proves each rule — one schema, four consumers, no restatement.
 *
 * ## Two policies, both deliberate
 *
 * **Unknown fields are rejected.** A configuration is written by hand and edited by tooling, so a misspelled key is the
 * most common defect it can have. Ignoring one produces a run that behaves as though the reader had not written it — the
 * worst kind of failure, because nothing says anything is wrong. Rejecting one names the field.
 *
 * **The version is required, and is a literal.** A file without a version cannot be distinguished from one written for a
 * version that did not have the field yet, so there is no safe default to apply. One supported version, stated as a
 * literal, means any other value fails at `version` with the number that was found.
 *
 * ## No configured value in a message
 *
 * The messages this file produces name fields and rules, never the value that failed. That is not fastidiousness: a
 * schema message reaches a terminal, a log line and a pasted issue, and `defaultEnvironment` is a field a reader could
 * have put anything into. Where a value is worth quoting — a profile name, which this file defines the shape of — it is
 * quoted through `profileText`, which quotes only what it can recognise.
 *
 * ## Where the defaults live, and where they stop
 *
 * This file owns the values of the defaulted fields, because it is the file that decides a field may be omitted at all.
 * `output` arrives from parsing already filled, so the resolution stage never supplies it.
 *
 * What this file does *not* do is decide where a project is. `relativeProjectPath` settles admissibility — relative,
 * inside the project, portable — and stops there. Turning an admissible relative path into an absolute one needs the
 * project root, which this schema has no access to and no business knowing. That single step belongs to the resolution
 * stage, and its containment refusal exists for documents that reached it without passing through here, not for the
 * ordinary case.
 *
 * `defaultEnvironment` is the deliberate gap between the two: this file checks that a named default refers to something
 * declared, and refuses to invent one. Choosing a target is a decision about a run, not about a file.
 *
 * ## Where the environments live
 *
 * A profile is its own schema, in `profiles.ts`, and this file composes it rather than describing it again. That module
 * also owns the reserved-name walk, because environments are the only place in the format with user-chosen keys — and
 * therefore the only place `__proto__` can do damage. A composition rather than a second validator: the profile's
 * constraints are the same `constraints.ts` primitives every other field uses, so a rule stated once applies everywhere.
 *
 * ## What is not here
 *
 * No field exists because a later command might want it. `cypress.configFile` exists because detection cannot find a
 * configuration outside the conventional names without listing a directory, and that is a limitation with a date on it.
 * Anything else waits for the consumer that needs it — which is why a profile carries no execution settings yet.
 */
import { z } from "zod";

import { Framework } from "../../core/domain/index.js";

import { environmentName, relativeProjectPath } from "./constraints.js";
import { environmentsSchema } from "./profiles.js";

/**
 * The one configuration version this build reads.
 *
 * A number rather than a string, so a comparison is a comparison. Incremented only when a field changes meaning or
 * disappears — adding an optional field does not need a new version, because an older file remains valid.
 */
export const SUPPORTED_CONFIG_VERSION = 1;

/**
 * The default output locations.
 *
 * The single authority for these two strings, exported because three places must agree and only this one may be written
 * by hand:
 *
 * - each field, so a partially written `output` block fills in the rest;
 * - the block itself, so an absent block fills in entirely;
 * - the resolution stage's catalogue, which documents them and is compared against this constant by a test rather than
 *   repeating the values.
 *
 * The paths are project-relative by construction. A default that named an absolute location would be a value no project
 * could carry between machines, and would defeat the point of defaulting it.
 */
export const OUTPUT_DEFAULTS = {
  reports: "results/reports",
  evidence: "results/evidence",
} as const;

/**
 * What a profile name looks like, for deciding whether one is safe to quote.
 *
 * Mirrors `environmentName`'s rule — the same pattern and the same length bound — because this is not a second definition
 * of a name, it is a test for whether a string is one. A value that fails it is not a name, and is described rather than
 * printed.
 */
const PROFILE_NAME = /^[a-z][a-z0-9-]*$/;
const PROFILE_NAME_MAX = 32;

/**
 * A profile name as it should appear in a sentence.
 *
 * Quoted when it is provably a name, and replaced with the words `a profile` when it is not.
 *
 * ## Why the conditional
 *
 * `defaultEnvironment` takes a name, so a valid value is safe to echo and worth echoing — it is the whole difference
 * between "some profile is not declared" and a one-line fix. An invalid value, though, is a string the reader put in the
 * wrong field, and it could be a token copied from a secret store. A message is the last place that should surface one.
 *
 * The same reasoning as the version field: echo what is provably an identifier or a number, describe anything else.
 */
function profileText(name: string): string {
  return name.length <= PROFILE_NAME_MAX && PROFILE_NAME.test(name)
    ? `"${name}"`
    : "a profile";
}

/**
 * Where a run's output goes, relative to the project root.
 *
 * Both children are defaulted, so a block written as `{"reports": "out/runs"}` keeps its choice and receives the evidence
 * default rather than being replaced wholesale.
 */
const outputSchema = z
  .object({
    reports: relativeProjectPath.default(OUTPUT_DEFAULTS.reports),
    evidence: relativeProjectPath.default(OUTPUT_DEFAULTS.evidence),
  })
  .strict();

/** Cypress-specific settings. Absent when the project needs none, which is the ordinary case. */
const cypressSchema = z
  .object({
    /**
     * An explicit configuration file, for a project whose configuration detection cannot find.
     *
     * Detection reads the conventional filenames at the project root and lists no directory, so a file somewhere else is
     * invisible to it. This is the one setting that turns that limitation into a decision the project can make rather
     * than a failure the tool reports.
     */
    configFile: relativeProjectPath.optional(),
  })
  .strict();

/**
 * The configuration file's fields.
 *
 * Two required and four optional. Required means the tool cannot proceed sensibly without it; optional means its absence
 * is a legitimate state rather than a gap — `environments` absent is a project with no named profiles, not a configuration
 * somebody forgot to finish.
 *
 * Kept separate from the cross-field rule below because `.shape` is lost once a refinement is attached, and the field list
 * exported at the bottom of this file is derived from it. One schema with two views, rather than a copy of the fields for
 * introspection to read.
 */
const rootSchema = z
  .object({
    /** Which version of this schema the file was written against. */
    version: z.literal(SUPPORTED_CONFIG_VERSION),
    /**
     * The framework to drive.
     *
     * Required rather than defaulted, even though Cypress is the only member today. A default would mean that the day a
     * second framework exists, every configuration written before it silently means Cypress — including the ones whose
     * author would have chosen otherwise.
     */
    framework: z.enum([Framework.Cypress]),
    cypress: cypressSchema.optional(),
    /**
     * The environment to use when a command does not name one.
     *
     * Checked against `environments` below, because a default that names nothing is a configuration that fails at the
     * point of use rather than the point of reading.
     *
     * Never defaulted here. A value could be derived — the only declared profile, say — but that is a choice about a run,
     * made where the run is started and reported with the provenance of the choice. Written as a file default, it would be
     * indistinguishable from something the reader asked for.
     */
    defaultEnvironment: environmentName.optional(),
    /**
     * Named environments, selected by `--environment` or by `defaultEnvironment`.
     *
     * Each one is a profile — a target, non-sensitive variables and references to secrets — rather than a bare map of
     * variables. `profiles.ts` explains why, owns the shape, and holds the reserved-name guard that has to run on the raw
     * value; this file only says where the map belongs.
     */
    environments: environmentsSchema.optional(),
    /**
     * Where output goes. Always present after parsing, because both paths have defaults.
     *
     * The default is the whole block rather than `{}`, because `ZodDefault` carries a value of the *output* type — an
     * object whose fields are already resolved. Substituting an output-typed default skips validation of the default
     * itself, which is safe while it is a constant this module owns.
     *
     * Because this block always survives parsing, the resolution stage has nothing to fill here: it joins both paths to
     * the project root and stops. The one authority for the two strings is {@link OUTPUT_DEFAULTS}.
     */
    output: outputSchema.default(OUTPUT_DEFAULTS),
  })
  .strict();

/** The fields, plus the rule that spans them. */
const objectSchema = rootSchema.superRefine((config, ctx) => {
  const selected = config.defaultEnvironment;

  if (selected === undefined) return;

  const declared = config.environments ?? {};

  // `hasOwnProperty` rather than `in`: a name inherited from the prototype is not a profile, and `toString` is not an
  // environment.
  if (Object.prototype.hasOwnProperty.call(declared, selected)) return;

  ctx.addIssue({
    code: "custom",
    path: ["defaultEnvironment"],
    // Quoted only when it is a name this schema defines. Anything else could be a token pasted into the wrong field, and a
    // schema message reaches a terminal, a log line and a pasted issue — the one place a value must not appear.
    message: `names ${profileText(selected)}, which is not declared in environments. Declare it, or remove the default.`,
  });
});

/**
 * The configuration file.
 *
 * One schema, and no outer pipeline. The outer `z.unknown()` stage that used to sit here existed to inspect the raw
 * document for reserved names inside `environments`; that inspection now belongs to {@link environmentsSchema}, where it
 * cannot be bypassed by a consumer that reaches the profile schema directly. The root needs no such stage: its keys are
 * this file's own, and `.strict()` refuses an unrecognised one before anything is assigned.
 */
export const qatConfigSchema = objectSchema;

/**
 * Every configuration field, as a dotted path.
 *
 * Derived from the three object schemas rather than written out, so a field added to the schema appears here whether or
 * not anybody remembers. It exists for one consumer: the test that compares the field table in
 * `docs/architecture/configuration-format.md` against it, which is what turns "every field is documented" from a review
 * promise into an assertion.
 *
 * `environments` contributes one path and not its contents. A record's keys are the *user's*, so there is nothing to
 * enumerate — and the profile's own fields (`baseUrl`, `variables`, `secrets`) are properties of a value rather than
 * paths in a document, which is why they appear in the format documentation's prose and not in this list.
 *
 * Sorted, because the table it is compared against is sorted by whichever order the document was written in, and a set
 * comparison is the claim being made.
 */
export const CONFIG_FIELD_PATHS: readonly string[] = [
  ...Object.keys(rootSchema.shape),
  ...Object.keys(cypressSchema.shape).map((field) => `cypress.${field}`),
  ...Object.keys(outputSchema.shape).map((field) => `output.${field}`),
].sort();

/**
 * A parsed configuration: defaults applied, constraints satisfied.
 *
 * Taken from the object schema rather than from the pipeline, so the type is the shape a consumer receives and not
 * `unknown`, which is what a preprocessed wrapper would infer.
 */
export type QatConfig = z.output<typeof objectSchema>;

/**
 * A configuration as written, before parsing.
 *
 * Every defaulted field optional and every constraint unchecked. Useful for the initialisation workflow, which builds a
 * file rather than reading one — not for a consumer, which should take `QatConfig`.
 */
export type QatConfigInput = z.input<typeof objectSchema>;
