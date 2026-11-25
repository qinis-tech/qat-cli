import {
  SUPPORTED_CONFIG_VERSION,
  type QatConfigInput,
} from "../config/schema/index.js";
import { Framework } from "../core/domain/index.js";

/**
 * The configuration a newly initialised project receives.
 *
 * Two fields, and that is the whole design. Everything else the format allows has a documented default, and writing a
 * default into the file would convert it into a decision: the moment the default changes, every initialised project
 * keeps the old value and there is no way to tell a deliberate setting from a fossil. A generated file therefore
 * contains exactly what has no default — the schema version it was written against and the framework to drive — and the
 * documented table describes the rest.
 *
 * `framework` comes from the domain's enum rather than from a string literal, so a rename in the domain reaches this
 * file instead of quietly producing a value the schema then rejects.
 */
export function generateDefaultConfiguration(): QatConfigInput {
  return {
    version: SUPPORTED_CONFIG_VERSION,
    framework: Framework.Cypress,
  };
}

/**
 * Render a configuration document as the bytes that go to disk.
 *
 * Two-space indentation and a trailing newline, which is what every other JSON file in a repository looks like and what
 * `prettier` produces for one. A file that arrives pre-formatted survives the first `git commit` without a whitespace
 * diff that obscures what actually changed.
 *
 * `JSON.stringify` is safe here in a way it is not for arbitrary values: the document is built by this module from a
 * literal, so it cannot be circular and contains no bigints.
 */
export function serialiseConfiguration(document: QatConfigInput): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
