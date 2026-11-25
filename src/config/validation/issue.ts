/**
 * Turning one validation issue into one diagnostic.
 *
 * ## Why the messages are authored here
 *
 * The library's own messages are good and two of its codes echo the received value — an unrecognised member of a value
 * set and a failed literal both quote what was found. For a configuration that is not acceptable: the field could be an
 * environment variable whose value is a credential, and a diagnostic is the one thing guaranteed to be logged, pasted
 * into an issue and shown in a terminal.
 *
 * So every message below is written by this project, from the rule and the path, never from the value. The library's own
 * text is used under exactly two issue codes — `custom` and `invalid_format` — and both carry messages *this* project
 * wrote: a path rule, a name rule, and the cross-field check.
 *
 * ## The third source: findings from the resolution stage
 *
 * A path rule that needs the project root cannot be decided by a schema, so it is decided later and arrives here as a
 * `PathIssue` instead of a parse issue. That finding is *presented* rather than re-authored: the stage that produced it
 * knows the field, the root and the specific remedy, and restating its sentence here would give the project two wordings
 * for one problem — one of which would drift.
 *
 * ## Where the codes come from
 *
 * `ConfigurationDiagnosticCode` is declared in `core/application/configuration.ts` and imported from there. A code is
 * vocabulary, and vocabulary is what a layer above this one may name without depending on how this module is built. The
 * config barrel deliberately does not re-export it, so an import from `./contracts.js` resolves to nothing — which is
 * exactly the error this file produced when the codes moved.
 *
 * ## Why the issue type is derived rather than named
 *
 * `ZodIssue` is the obvious name and it is deprecated — the library exposes its issue union through the error type now.
 * Deriving it with `ZodError['issues'][number]` uses the public surface and survives that rename, and it says what this
 * function actually receives: whatever the parser put in `issues`.
 *
 * ## Why the switch is typed
 *
 * Switching on `String(issue.code)` avoids pinning a set of codes that differs between majors, and it costs the
 * narrowing: every property of the union becomes unreachable without a cast, and a cast inside an error handler is how an
 * assumption becomes a second exception. Switching on the real discriminant is checked by the compiler, and the `default`
 * below means a code this mapping has never seen gets a generic sentence rather than a compile error — so a new code in a
 * future minor degrades the wording and not the build.
 *
 * The codes are Zod 4's. Zod 3 called these `invalid_string` and `invalid_literal`; Zod 4 has `invalid_format` and folds
 * a failed literal into `invalid_value` with a one-element `values`. A case name that does not exist is a compile error,
 * which is how a major upgrade announces that this mapping needs reading.
 */
import type { ZodError } from "zod";

import { ConfigurationDiagnosticCode } from "../../core/application/configuration.js";
import type { PathIssue } from "../resolver/contracts.js";
import { SUPPORTED_CONFIG_VERSION } from "../schema/index.js";

import type { ConfigurationDiagnostic } from "./contracts.js";

/** One entry of a parse error's issue list, as the library types it. */
type ValidationIssue = ZodError["issues"][number];

/** How a field is named in a sentence. The document itself has no path to print. */
function describe(path: string): string {
  return path === "" ? "the configuration document" : path;
}

/**
 * Whether the document is missing the key an issue points at.
 *
 * ## Why this asks the document rather than the issue
 *
 * The obvious way to tell "missing" from "wrong" is to read what the parser attached to the issue. That was tried, and it
 * was wrong twice over. The property carrying the received value changed name between library majors, and — the part
 * that actually bites — the *issue code* depends on what the field holds: a missing string is a type error, a missing enum
 * member is a value error, a missing literal is a value error too. Three codes, one situation, one next step for the
 * reader.
 *
 * The document has neither problem. A key that is not in it was not supplied, and which code the library chose is
 * irrelevant.
 *
 * ## Why an empty path is not absence
 *
 * An issue about the document itself has no path, so the loop does not run and this returns `false`. That is right: a
 * document that is an array is not a document with a missing field, and reporting it as one would point at nothing.
 *
 * ## Why `hasOwnProperty`
 *
 * A configuration is JSON. `toString` is not a supplied key and an inherited property is not a field, so the prototype is
 * not consulted.
 */
function isAbsent(document: unknown, path: readonly PropertyKey[]): boolean {
  let current: unknown = document;

  for (const key of path) {
    if (typeof current !== "object" || current === null) return false;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return true;

    current = (current as Record<PropertyKey, unknown>)[key];
  }

  return false;
}

/**
 * A size bound as a parenthetical, or nothing.
 *
 * **The leading space is part of the returned string.** Every caller appends this directly to a sentence that ends in
 * `allows` or `requires`, so a bound that ran into the word before it — `allows(4096)` — would be worse than no bound at
 * all. Returning the space here rather than in each of the callers is what stops one of them forgetting it.
 *
 * The value is a number, a bigint, or absent depending on what was measured and on the version. A stringified `undefined`
 * in a message is the other wording defect this avoids.
 */
function boundText(value: number | bigint | undefined): string {
  return value === undefined ? "" : ` (${String(value)})`;
}

/**
 * Renders one parse issue.
 *
 * @param issue One entry from a parse error's issue list.
 * @param document The value that was parsed, so absence can be decided by looking for the key rather than by trusting an
 *   encoding.
 */
export function diagnosticFor(
  issue: ValidationIssue,
  document: unknown,
): ConfigurationDiagnostic {
  const path = issue.path.join(".");

  // Before the switch, once. Every code that can mean "not supplied" leads the reader to the same next step, and deciding
  // it three times is three chances to decide it differently.
  if (isAbsent(document, issue.path)) {
    return {
      code: ConfigurationDiagnosticCode.Missing,
      path,
      message: `${describe(path)} is required.`,
      remediation:
        "Add the field, or remove the file and run with the defaults.",
    };
  }

  switch (issue.code) {
    case "invalid_type":
      // Reached only when the key is present, because absence was answered above. So this is a value of the wrong kind,
      // which needs replacing rather than supplying.
      return {
        code: ConfigurationDiagnosticCode.WrongType,
        path,
        message: `${describe(path)} must be ${issue.expected}.`,
        remediation: "Correct the type of the value at this path.",
      };

    case "unrecognized_keys":
      // An unrecognised top-level key has no path, so the key has to appear in the sentence or the reader learns nothing.
      // Keys are not values: they are the part of the file a reader typed deliberately.
      return {
        code: ConfigurationDiagnosticCode.UnknownField,
        path,
        message: `The key ${issue.keys.join(", ")} is not part of the configuration.`,
        remediation:
          "Remove it, or correct its spelling. A misspelled key is ignored by nothing.",
      };

    case "invalid_value":
      // `values` is the set the schema allows — ours, not the file's — so listing it is safe and it is what a reader needs
      // to retry. The received value is deliberately not read.
      return {
        code: ConfigurationDiagnosticCode.UnsupportedValue,
        path,
        message: `${describe(path)} must be one of: ${issue.values.map(String).join(", ")}.`,
        remediation: "Use one of the supported values.",
      };

    case "too_big":
      return {
        code: ConfigurationDiagnosticCode.RefusedValue,
        path,
        message: `${describe(path)} is longer than the configuration allows${boundText(issue.maximum)}.`,
        remediation: "Shorten the value.",
      };

    case "too_small":
      return {
        code: ConfigurationDiagnosticCode.RefusedValue,
        path,
        message: `${describe(path)} is shorter than the configuration allows${boundText(issue.minimum)}.`,
        remediation: "Lengthen the value.",
      };

    case "invalid_format":
    case "custom":
      // Attached by this project to a refinement, so the sentence is one we wrote and it contains no value.
      return {
        code: ConfigurationDiagnosticCode.RefusedValue,
        path,
        message: `${describe(path)} ${issue.message}`,
        remediation: "Correct the value at this path.",
      };

    default:
      // A code this mapping does not know: a union member, a key issue, a multiple-of, or something added in a future
      // minor. The path still identifies the field, and the sentence says nothing about the value — an unrecognised issue
      // is not a reason to print whatever the library put in its message.
      return {
        code: ConfigurationDiagnosticCode.RefusedValue,
        path,
        message: `${describe(path)} holds a value the configuration does not allow.`,
        remediation:
          "Correct the value at this path, or consult the configuration format.",
      };
  }
}

/** The diagnostic for a document that is not an object at all. */
export function nonObjectDiagnostic(): ConfigurationDiagnostic {
  return {
    code: ConfigurationDiagnosticCode.NotAnObject,
    path: "",
    message: "The configuration document must be a JSON object.",
    remediation:
      "A configuration is an object with at least a `version` and a `framework`.",
  };
}

/**
 * The diagnostic for a version this build does not read.
 *
 * The declared version is echoed only when it is a number. A string in that position is a defect and could be anything —
 * including the kind of value that must never be printed — so it is described rather than quoted. A number is a number.
 */
export function unsupportedVersionDiagnostic(
  found: unknown,
): ConfigurationDiagnostic {
  return {
    code: ConfigurationDiagnosticCode.UnsupportedVersion,
    path: "version",
    message:
      typeof found === "number"
        ? `The configuration declares version ${String(found)}, and this build reads version ${String(SUPPORTED_CONFIG_VERSION)}.`
        : `The configuration declares a version that is not ${String(SUPPORTED_CONFIG_VERSION)}.`,
    remediation: `Bring the file to version ${String(SUPPORTED_CONFIG_VERSION)}, or use the build that reads the version it declares.`,
  };
}

/**
 * Presents a path finding from the resolution stage as a configuration diagnostic.
 *
 * ## Why the sentence is carried rather than authored
 *
 * The stage that produced this knows three things this function does not: which field it was, what the project root is,
 * and which of eleven specific rules was broken. Its message already names the field and ends in a full stop, and its
 * hint already says what to write instead. Re-deriving either here would mean two wordings for one problem, and a reader
 * receiving the version that drifted from the rule it describes.
 *
 * ## Why the path is not prefixed onto the message
 *
 * `describe()` exists for parse issues, whose sentences start without a subject. A path finding's sentence already begins
 * `Configuration field "output.reports" …`, so prefixing the path again would say it twice.
 *
 * ## Why the value is not carried across
 *
 * `PathIssue` holds the offending value for tests and for message composition; a diagnostic does not. That mirrors the
 * rule at the top of this file: a constructor value reaches a log line, and the field could be something the reader
 * should not have written down.
 *
 * ## Severity
 *
 * Every rule in the resolution stage is structural and therefore blocking, so this mapping is total for the only severity
 * that exists today. When that stage gains a warning, `ConfigurationDiagnostic` needs a severity field before this
 * function is extended — otherwise a warning would be reported as an error by being flattened here.
 */
export function pathIssueToDiagnostic(
  issue: PathIssue,
): ConfigurationDiagnostic {
  return {
    code: ConfigurationDiagnosticCode.RefusedValue,
    path: issue.field,
    message: issue.message,
    remediation:
      issue.hint ??
      "Correct the path at this field, or remove it to accept the default.",
  };
}
