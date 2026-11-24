/**
 * Validating a parsed configuration document.
 *
 * ## Two checks, in this order, and the order is the decision
 *
 * The schema version is checked **before** the document is validated against the schema. Once a file declares a version
 * this build does not read, its field errors are speculation: a required field may be missing because that version does
 * not have it, and a key may be unrecognised because it was added afterwards. Reporting a page of field complaints
 * beside "this file is for a different version" invites the reader to fix the wrong thing.
 *
 * So an unsupported version produces exactly one diagnostic, and nothing else is looked at.
 *
 * ## Where the paths are decided, and what is not decided here
 *
 * Admissibility is decided by the constraints: `relativeProjectPath` refuses an absolute path, a path that escapes the
 * project, a path written with a separator that would not survive a different operating system. A path that fails those
 * rules produces a diagnostic from this call and never reaches anything downstream.
 *
 * What this layer cannot decide is *where* an admissible path points, because that needs the project root, which is not
 * a property of a file. So the output here is a path relative to the project — `results/reports`, in the default case —
 * and turning it into an absolute location is the next stage's single job. Reading this file as the enforcement point for
 * containment would be reading it wrong; the resolution stage's containment refusal exists for the case where a document
 * reached it without passing through here, not for the ordinary one.
 *
 * ## What is already complete by the time this returns
 *
 * A valid result is not a partly filled document. The schema applies the defaults it owns — today both output paths —
 * because a field's default is part of deciding whether the field may be omitted. Only `defaultEnvironment` is
 * deliberately left open: choosing a target is a decision about a run, made where the run starts and reported with the
 * provenance of that choice, so no file default is invented for it here.
 *
 * ## What it does not do
 *
 * It does not read or parse — the loader did both, and a syntax error never reaches here. That is what makes "syntax"
 * and "schema" distinguishable by construction: they are different outcomes of the load, produced at different stages,
 * by different code. It also does not brand the document as loadable: that claim belongs to the module that read the
 * bytes, not to the one that judged them.
 */
import { qatConfigSchema, SUPPORTED_CONFIG_VERSION } from "../schema/index.js";

import type { ConfigurationValidation } from "./contracts.js";
import {
  diagnosticFor,
  nonObjectDiagnostic,
  unsupportedVersionDiagnostic,
} from "./issue.js";

/**
 * Validates a parsed configuration document.
 *
 * @param value Whatever the JSON parser produced. Untrusted: it may be any JSON value at all.
 * @returns Either a validated configuration with the schema's defaults applied, or one or more diagnostics.
 */
export function validateConfiguration(value: unknown): ConfigurationValidation {
  if (!isObject(value)) {
    return { valid: false, diagnostics: [nonObjectDiagnostic()] };
  }

  // Read before anything else, and compared rather than validated: the question is "does this build understand the
  // file", which the schema cannot answer because the schema is the thing that differs between versions.
  //
  // A missing version is deliberately not handled here. The comparison is against "not the supported number", and an
  // absent value fails that test differently — it is a required field, which the schema reports with its own code and
  // its own message. Treating absence as an unsupported version would replace "version is missing" with a sentence about
  // a version the reader never wrote.
  const declared: unknown = value["version"];

  if (declared !== undefined && declared !== SUPPORTED_CONFIG_VERSION) {
    return {
      valid: false,
      diagnostics: [unsupportedVersionDiagnostic(declared)],
    };
  }

  const result = qatConfigSchema.safeParse(value);

  return result.success
    ? { valid: true, config: result.data }
    : {
        valid: false,
        diagnostics: result.error.issues.map((issue) =>
          diagnosticFor(issue, value),
        ),
      };
}

/** An object and not an array — `typeof []` is `'object'`, and an array is not a configuration. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
