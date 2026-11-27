/**
 * Type contracts for the Cypress configuration health checks (CFG-003, CFG-004).
 *
 * Scope boundary, deliberately narrow: this module does **not** discover
 * anything. Discovery — which configuration files exist, what the layout looks
 * like, whether the directory is a Cypress project at all — belongs to
 * `cypress-detection`, which already gathers it once per run and reports a
 * verdict plus evidence.
 *
 * What lives here is the vocabulary for the two questions detection does not
 * answer:
 *   • "is the file it found actually usable?"      → `ConfigDiscovery` (CFG-003)
 *   • "can anything establish that it is valid?"   → `ConfigValidation` (CFG-004)
 *
 * Declaration-only: no I/O, no thresholds, no filename tables. Reading a
 * contract tells you what can be concluded, never how it is checked.
 *
 * The verdicts are discriminated unions rather than flat records with optional
 * fields, for two reasons: a verdict can only carry the evidence it actually
 * has, and adding a reason here makes every non-exhaustive switch fail to
 * compile — which is how a new condition gets a remediation message before it
 * can ever reach a user.
 */

/** The diagnostic checks this module feeds. Named in skip verdicts as a prerequisite. */
export type ConfigCheckId = "CFG-003" | "CFG-004";

/**
 * How a verdict maps onto the diagnostic result status.
 *
 * `indeterminate` and `skipped` are first-class outcomes, not error states:
 * `indeterminate` means we looked and are not entitled to an opinion; `skipped`
 * means a prerequisite was never established, so nothing was observed at all.
 * Neither may ever aggregate to a clean result.
 */
export type ConfigOutcome =
  "pass" | "warning" | "fail" | "indeterminate" | "skipped";

/**
 * The validation depth a file's shape permits.
 *
 * `json` can be parsed safely and definitively. `executable` cannot be parsed
 * without being loaded, so its validity can only be established by the project's
 * own Cypress loader. Two values, because that is the only distinction that
 * changes what we are allowed to do.
 */
export type CypressConfigFormat = "json" | "executable";

/**
 * State of the one configuration file detection identified, as observed by us.
 *
 * `outside-project` and `dangling-symlink` are distinct on purpose: the first is
 * a security boundary we refuse to cross, the second is a broken checkout. They
 * get different remedies.
 */
export type ConfigFileState =
  "file" | "directory" | "unreadable" | "outside-project" | "dangling-symlink";

/**
 * A bounded, decoded sample of the configuration's bytes.
 *
 * `state` carries the reason no text is present, so the validator maps it to a
 * precise gap cause instead of interpreting an empty string. The text itself is
 * never emitted in diagnostics: a Cypress configuration routinely holds
 * credentials under `env`.
 */
export interface ConfigTextSample {
  readonly state: "sampled" | "skipped-too-large" | "unreadable";
  /** Decoded text; empty when nothing was read. Internal only. */
  readonly text: string;
  readonly bytesRead: number;
  readonly truncated: boolean;
  /** False when the bytes were not valid UTF-8 — a signal, not a crash. */
  readonly decodable: boolean;
  /** True when NUL bytes are present, which reliably indicates binary content. */
  readonly containsBinary: boolean;
}

/**
 * Everything we establish ourselves about the configuration file.
 *
 * `absolutePath` is internal-only: the reporter relativises before emitting, so
 * evidence never leaks a user's home directory into a CI log.
 */
export interface ConfigFileFacts {
  /** Project-relative path, matching the name detection reported. */
  readonly file: string;
  /** Absolute path. Internal use only — never emitted verbatim. */
  readonly absolutePath: string;
  readonly state: ConfigFileState;
  /** `undefined` when the entry could not be inspected. */
  readonly sizeBytes?: number;
  /** Present only when a read was attempted. */
  readonly sample?: ConfigTextSample;
}

/**
 * The location verdict (CFG-003).
 *
 * Every member is reachable from evidence the detection engine already
 * produced, optionally refined by the facts above. Note what is absent from all
 * of them: file contents.
 */
export type ConfigDiscovery =
  | {
      readonly reason: "CYPRESS_CONFIG_FOUND";
      readonly outcome: "pass";
      readonly file: string;
      readonly format: CypressConfigFormat;
      readonly sizeBytes: number;
    }
  | {
      /**
       * Detected and readable, but in the pre-v10 format. Warning, not Error:
       * it still works today, and blocking it would fail projects that run fine
       * — while silence would let a team meet this during an upgrade instead.
       */
      readonly reason: "CYPRESS_CONFIG_LEGACY_FORMAT";
      readonly outcome: "warning";
      readonly file: string;
      readonly sizeBytes: number;
    }
  | {
      readonly reason: "CYPRESS_CONFIG_MISSING";
      readonly outcome: "fail";
      /**
       * Mirrors the detection engine's own split, because the two need
       * different messages: "nothing here is Cypress" is a setup problem, while
       * "Cypress is here but unconfigured" is a half-finished migration.
       */
      readonly context: "no-cypress-evidence" | "cypress-evidenced";
    }
  | {
      readonly reason: "CYPRESS_CONFIG_AMBIGUOUS";
      readonly outcome: "fail";
      /** Every matching file, sorted — never a "winner" chosen for the user. */
      readonly files: readonly string[];
    }
  | {
      readonly reason: "CYPRESS_CONFIG_UNSUPPORTED_NAME";
      readonly outcome: "fail";
      readonly files: readonly string[];
    }
  | {
      /** A configuration exists where Cypress never loads one, e.g. inside `cypress/`. */
      readonly reason: "CYPRESS_CONFIG_MISPLACED";
      readonly outcome: "warning";
      readonly files: readonly string[];
    }
  | {
      /** A directory occupies a configuration filename, so no file probe can see it. */
      readonly reason: "CYPRESS_CONFIG_PATH_OCCUPIED";
      readonly outcome: "fail";
      readonly paths: readonly string[];
    }
  | {
      readonly reason: "CYPRESS_CONFIG_OUTSIDE_PROJECT";
      readonly outcome: "fail";
      readonly file: string;
      /** The one absolute path we report, because it is the actionable fact. */
      readonly resolvedPath: string;
      readonly projectRoot: string;
    }
  | {
      readonly reason: "CYPRESS_CONFIG_NOT_A_FILE";
      readonly outcome: "fail";
      readonly file: string;
    }
  | {
      readonly reason: "CYPRESS_CONFIG_UNREADABLE";
      readonly outcome: "fail";
      readonly file: string;
      readonly cause: "permissions" | "io-error";
    }
  | {
      readonly reason: "CYPRESS_CONFIG_EMPTY";
      readonly outcome: "fail";
      readonly file: string;
    }
  | {
      /** Detection reported a configuration but we could not inspect it at all. */
      readonly reason: "CYPRESS_CONFIG_NOT_INSPECTED";
      readonly outcome: "indeterminate";
      readonly file: string;
    }
  | {
      readonly reason: "CYPRESS_CONFIG_NOT_APPLICABLE";
      readonly outcome: "skipped";
      readonly detail: string;
    };

/**
 * Why validation could not reach a verdict (CFG-004).
 *
 * Separate from the reason so that "we did not validate" stays one message with
 * one knob, while the cause says precisely which door was closed.
 */
export type ConfigValidationGapCause =
  | "deep-validation-disabled"
  | "deep-validation-unavailable"
  | "probe-timeout"
  | "undecodable-text"
  | "size-budget-exceeded"
  | "text-sanity-not-established";

/**
 * Which mechanism spoke. Part of the verdict because the user is entitled to
 * know *who* said the configuration was valid: a JSON parser and the project's
 * own Cypress loader are not equally authoritative.
 */
export type ValidationTier = "T0-text" | "T1-json" | "T2-cypress" | "none";

/** What kind of invalidity was established, so the message can point at a line. */
export interface ConfigFailure {
  readonly kind: "syntax" | "shape" | "load";
  /** Sanitised and length-capped upstream; never raw file contents. */
  readonly message: string;
  readonly line?: number;
}

/**
 * The validation verdict (CFG-004).
 *
 * `CYPRESS_CONFIG_INVALID` is only reachable when a supported mechanism actually
 * established invalidity. Everything else lands on `NOT_VALIDATED`, because an
 * unproven claim of invalidity is a false finding — and a confident wrong answer
 * about configuration is the most expensive error a doctor can make.
 */
export type ConfigValidation =
  | {
      readonly reason: "CYPRESS_CONFIG_VALIDATED";
      readonly outcome: "pass";
      readonly file: string;
      readonly tier: Exclude<ValidationTier, "none">;
      /** Present only for T2, where the cost is worth recording. */
      readonly durationMs?: number;
    }
  | {
      readonly reason: "CYPRESS_CONFIG_INVALID";
      readonly outcome: "fail";
      readonly file: string;
      /** `none` is excluded by the type: a verdict needs an authority. */
      readonly tier: Exclude<ValidationTier, "none">;
      readonly failure: ConfigFailure;
      readonly durationMs?: number;
      /** True when the loader output was capped before sanitising. */
      readonly truncated?: boolean;
    }
  | {
      readonly reason: "CYPRESS_CONFIG_NOT_VALIDATED";
      readonly outcome: "indeterminate";
      readonly file: string;
      readonly tier: ValidationTier;
      readonly cause: ConfigValidationGapCause;
    }
  | {
      readonly reason: "CYPRESS_CONFIG_SKIPPED";
      readonly outcome: "skipped";
      /** The check we were waiting on — named, never implied. */
      readonly prerequisite: ConfigCheckId;
      readonly detail: string;
    };

/** Narrowing helpers, so consumers do not hand-roll `outcome === 'fail'` casts. */
export type ConfigDiscoveryEstablished = Extract<
  ConfigDiscovery,
  { outcome: "pass" | "warning" }
>;
export type ConfigDiscoveryFailed = Extract<
  ConfigDiscovery,
  { outcome: "fail" }
>;

/** What the two rules return together: one verdict per question. */
export interface ConfigHealthVerdicts {
  readonly discovery: ConfigDiscovery;
  readonly validation: ConfigValidation;
}
