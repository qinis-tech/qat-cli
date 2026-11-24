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
 * ## What it does not do
 *
 * It does not read or parse — the loader did both, and a syntax error never reaches here. That is what makes "syntax"
 * and "schema" distinguishable by construction: they are different outcomes of the load, produced at different stages,
 * by different code.
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
