/**
 * Health checks: the questions `qat doctor` answers about a project before anything runs.
 *
 * ## A check is a question, not an action
 *
 * Every check in this catalogue is a pure function of evidence somebody else gathered — a runtime version, an
 * assessment, a configuration inspection, a writability fact. Nothing here reads a file, spawns a process or talks to
 * a stream.
 *
 * That is not tidiness. It is what makes the catalogue's own requirement — a documented purpose, four separate outcome
 * conditions and a remedy for each check — verifiable rather than asserted. A rule that touches a disk can only be
 * checked by constructing a disk; a rule that takes a value can be checked by constructing a value, which means the
 * *whole* table can be exercised, including the branches nobody bothered to build a directory for.
 *
 * ## Two vocabularies for outcome, deliberately
 *
 * `CheckSeverity` is declared per check and never changes: it says what an unfavourable answer *means*.
 * `CheckStatus` is what actually happened on this run. They are separate because the same severity produces different
 * statuses depending on which condition fired, and because a check that could set its own severity at the point of
 * failure would let one condition refuse a run today and advise it tomorrow.
 *
 * `Failed` is reserved for checks whose severity is `error`. That is an invariant rather than a convention: the
 * catalogue test holds every entry to it, so an advisory check that reports a failure is a build failure rather than a
 * report that quietly refuses a run.
 *
 * A *finding's* severity may be lower than its check's — an `error` check that answers "nothing is configured, and that
 * is the documented default" attaches an `information` finding to a `Passed` outcome. It may never be higher: a finding
 * louder than the check that produced it would mean the check did not actually pass. The catalogue test holds both
 * halves of that rule, which is why `CheckPassed` carries an optional finding rather than dropping the observation.
 *
 * ## Four code vocabularies, one finding shape
 *
 * `QAT-D` is what detection found wrong with a project, `QAT-V` whether that stops an operation, `QAT-C` what is wrong
 * with a configuration document, and `QAT-H` what is wrong with this machine or this run. A reader can tell which layer
 * raised a finding from the code alone, and `DiagnosticFinding` is generic over the set so nothing has to branch on it.
 *
 * A check that restates another layer's conclusion carries that layer's code **unchanged**. One condition, one code,
 * one sentence — the rule the rest of the diagnostics chain already follows.
 *
 * ## What this file is not
 *
 * It is not the catalogue. It is the vocabulary the catalogue is written in: the identifiers, the statuses, the shape
 * of an outcome, and the three predicates a caller needs. The table itself lives in `src/diagnostics/checks/`, and the
 * prose behind each `QAT-H` code lives beside it. A command will receive a `DoctorReport` through a port, which is why
 * the report's shape belongs here and its production does not.
 */

import type { ConfigurationDiagnosticCode } from "./configuration.js";
import {
  DiagnosticSeverity,
  type DiagnosticCode,
  type DiagnosticFinding,
} from "./diagnostics.js";
import type { ValidationCode } from "./validation.js";

/**
 * The eight groups every check belongs to.
 *
 * Closed, and taken from the approved categories rather than invented: a check belongs to exactly one, and a new
 * category is a decision about how the report is grouped rather than a label a check may choose for itself.
 */
export const CheckCategory = {
  /**
   * The Node.js runtime QAT is running on, and what a framework requires of that runtime.
   *
   * One group rather than two because a reader looking at a report cares about one thing — whether this machine can run
   * the work — and splitting "the runtime" from "the runtime something else needs" would ask them to compare two
   * sections to answer it.
   */
  Runtime: "runtime",
  /**
   * Whether a package manager can be identified, and whether the one identified is usable.
   *
   * Its own group rather than part of `project-structure`, because half the answer is a property of the machine: which
   * binary is on PATH, and what version it reports. A group is a place in the report, and a reader fixing "nothing is
   * installed" is looking here.
   */
  PackageManager: "package-manager",
  /** Whether the directory is a test project at all, and whether its manifest can be read. */
  ProjectStructure: "project-structure",
  /** Whether the framework is installed, and at a version this tool will drive. */
  CypressInstallation: "cypress-installation",
  /**
   * Whether there is exactly one readable configuration and a spec location QAT can drive.
   *
   * Two questions share this group — is the file there, and can anything establish that it is valid — because a reader
   * fixing a configuration problem works through both in one sitting, and a report that put them in different sections
   * would have them scrolling between two halves of one answer.
   */
  CypressConfiguration: "cypress-configuration",
  /**
   * Whether QAT's own configuration file can be read, and whether it conforms to a schema this release supports.
   *
   * Two questions, one group, for the same reason as the framework's configuration: they are halves of one answer, and
   * the second is only meaningful once the first has been concluded.
   */
  QatConfiguration: "qat-configuration",
  /** Whether the environment a command selected exists. */
  EnvironmentProfiles: "environment-profiles",
  /** Whether reports and evidence can be written where the configuration says they go. */
  OutputPermissions: "output-permissions",
} as const;

export type CheckCategory = (typeof CheckCategory)[keyof typeof CheckCategory];

/**
 * The fifteen health checks.
 *
 * An identifier is a dotted slug rather than a code, because it names a *question* and is quoted in documentation and
 * in the identifier of the scenario that verifies it. The diagnostic *code* is attached to the finding a check
 * produces, and is usually another layer's.
 *
 * The first segment names the **subject**, which is not always the category: `cypress` spans both the configuration and
 * the installation categories, because that is how a reader looking for Cypress problems thinks about them. The
 * category is what the report groups by, and the register asserts every category has at least one check.
 *
 * Permanent, for the same reason codes are: a withdrawn check leaves its identifier unused rather than reusing it, so
 * an identifier quoted in a bug report keeps the meaning it had when it was quoted.
 *
 * Identifiers stayed at thirteen when the package-manager vocabulary grew from one code to eight. That is the intended
 * shape rather than an oversight: a check is one *question* — "is this project's package-manager environment
 * healthy?" — and the several conditions it may find are codes, not questions. One identifier per rung would fill the
 * report with rows that can never appear together, because each rung is only reachable when the one above it passed.
 *
 * ### Why the configuration pairs did gain a second identifier
 *
 * Those eight package-manager conditions are rungs of one question: each is only reachable when the one above passed,
 * so they can never appear side by side. Location and validity are not rungs — they are two questions with a
 * **precondition** between them. A file can be located and provably unvalidatable; a file can be located and answer
 * nothing at all because no mechanism was entitled to speak. Collapsing them into one identifier would force one row to
 * carry two different remedies and would hide which of the two answered.
 *
 * A `precondition` link is the mechanism, and it is why the second identifier exists rather than an eleventh code on
 * the first: the runner can skip validity with a named cause — "not located" — which no code on a single check could
 * express without reporting a consequence as a problem in its own right.
 *
 * QAT's own configuration turns out to have the same two-question shape, and for the same reason: a file that cannot be
 * read has nothing to validate, and a file that can be read may still be rejected field by field. So it gained a second
 * identifier too, placed after its precondition rather than at the end of the register — declaration order is the order
 * the report reads in, and a precondition must precede the check that waits on it.
 */
export const CheckId = {
  /**
   * Is the running Node.js version inside the range QAT declares?
   *
   * "Version", not "major": the declared requirement is a range, and a check that reduced it to a major number would
   * accept every patch above a floor and every pre-release of the next line that happened to share the digit.
   */
  NodeVersion: "runtime.node-version",
  /**
   * Can this project's package-manager environment be named and used?
   *
   * Candidate for renaming to `environment.package-manager-health`, since the check now answers more than "can a manager
   * be named". Not renamed here: the identifier is quoted in scenario names and in stored reports, and a rename is only
   * correct alongside those, in one commit.
   */
  PackageManager: "environment.package-manager",
  /** Is this directory recognisable as a test project at all? */
  ProjectRecognised: "project.recognised",
  /** Can the project's own metadata be read, and does it name itself? */
  PackageMetadata: "project.package-metadata",
  /** Is there exactly one Cypress configuration, in a format QAT can read? */
  CypressConfigurationLocated: "cypress.configuration-located",
  /**
   * Can anything establish that the located configuration is valid?
   *
   * The second half of the configuration pair, and the precondition of nothing — nothing else waits on validity, which
   * is why it comes after location in declaration order and before the layout question that a run actually needs.
   *
   * Appended rather than inserted, for the same reason a code is: the identifiers above keep the positions they had when
   * they were first quoted.
   */
  CypressConfigurationValidatable: "cypress.configuration-validatable",
  /** Is there a spec location QAT can drive? */
  CypressLayoutDriveable: "cypress.layout-driveable",
  /** Is the framework installed here or above? */
  CypressInstalled: "cypress.installed",
  /** Is the installed major inside the range QAT will drive? */
  CypressVersionSupported: "cypress.version-supported",
  /**
   * Does the running Node.js version satisfy what the project's framework requires of it?
   *
   * A second runtime question with a different owner: `runtime.node-version` asks what *QAT* needs, this asks what the
   * project's framework needs. The subject segment keeps the framework's questions together; the category keeps the
   * answer in the Runtime group of the report, where a reader is already looking.
   */
  CypressRuntimeSupported: "cypress.runtime-supported",
  /** Can QAT's own configuration file be read? */
  QatConfigurationLoadable: "qat.configuration-loadable",
  /**
   * Does the readable QAT configuration conform to a schema this release supports?
   *
   * The second half of the QAT configuration pair, and the only check whose precondition is another check in this same
   * group. Placed immediately after that precondition so the report reads causes before consequences, and so the runner
   * can resolve the skip in a single forward pass.
   *
   * Its severity is `error` even though an absent file is merely informational: the two are different questions. This
   * one asks whether a document that exists is one QAT can act on, and the answer "no" always blocks.
   */
  QatConfigurationValid: "qat.configuration-valid",
  /** Does the environment a command selected exist in the configuration? */
  EnvironmentResolvable: "qat.environment-resolvable",
  /** Can reports be written where the configuration says they go? */
  ReportsWritable: "output.reports-writable",
  /** Can evidence be written where the configuration says they go? */
  EvidenceWritable: "output.evidence-writable",
} as const;

export type CheckId = (typeof CheckId)[keyof typeof CheckId];

/**
 * How serious an unfavourable answer is. Declared once per check, never at the point of failure.
 *
 * The same two levels a finding has, and deliberately the same definition rather than a second copy. "How bad is this"
 * is one question whether it is being asked about a check or about a finding it produced, and two identical enumerations
 * would drift the day a third level arrived in one of them.
 *
 * The distinction that survives is between a *severity* and a *status*: this says what a failure means, and
 * `CheckStatus` says what happened.
 */
export const CheckSeverity = DiagnosticSeverity;

export type CheckSeverity = DiagnosticSeverity;

/** What happened when a check ran. Four values, because four conditions are documented for every check. */
export const CheckStatus = {
  /** The condition the check documents was met. */
  Passed: "passed",
  /** The check's milder condition was met. Never blocks. */
  Warned: "warned",
  /** The check's blocking condition was met. Only ever produced by an `error` severity check. */
  Failed: "failed",
  /** The check was not run, and says why. Never blocks. */
  Skipped: "skipped",
} as const;

export type CheckStatus = (typeof CheckStatus)[keyof typeof CheckStatus];

/**
 * Why a check did not run.
 *
 * Two reasons, and the difference is the difference between a user's problem and ours. A failed **precondition** is a
 * fact about the project: the question is unanswerable until something else is fixed, and the report names what. A
 * missing **input** is a fact about the caller: nobody gathered the evidence, which is a defect in the assembly rather
 * than in the project — the same distinction an absent configuration file makes between "nothing is configured" and "I
 * could not look".
 */
export const CheckSkipReason = {
  PreconditionFailed: "precondition-failed",
  InputUnavailable: "input-unavailable",
} as const;

export type CheckSkipReason =
  (typeof CheckSkipReason)[keyof typeof CheckSkipReason];

/**
 * Conditions the doctor is the first layer to notice.
 *
 * A fourth prefix, because the three existing ones answer questions about a *project* and these answer questions about
 * the *run*: whether the runtime is new enough, whether a package manager exists, whether output can be written, whether
 * the configuration file is a document at all. Nothing else in the tool asks those, so nothing else owns the codes.
 *
 * `QAT-H003` covers both output directories. One condition, one code: which directory is in the finding's `path`, which
 * is the same arrangement validation uses for two shapes of a misplaced configuration.
 *
 * The runtime is three codes rather than one, and the split is the split between *observed* and *unobtainable*: a
 * mismatch QAT could measure blocks, an answer QAT could not get warns, and a requirement owned by the project's
 * framework is reported on its own so the remedy names the right owner. One code could say "unsupported" for all
 * three; it could not tell a reader which of three different things to do.
 *
 * ## Why the package-manager codes are one per fix
 *
 * Seven conditions arrived with the package-manager check, and they are seven codes because they are seven *remedies*.
 * "Nothing identifies your tool", "two lockfiles disagree", "your field cannot be used", "the tool is not installed",
 * "the tool's version disagrees", "you have not installed yet" and "someone else installed it" send a reader to seven
 * different places; a shared code could describe one of them and would be wrong for the other six.
 *
 * They are all advisory. None of them stops a run of an already-installed suite — they predict a confusing install —
 * so severity lives on the check, and the catalogue test holds each of these entries to `warning`.
 *
 * ## Why the Cypress-configuration codes are split the same way
 *
 * Ten conditions for one file, and the same rule applied: one code per remedy. "There is no configuration", "there are
 * two", "it is in a format Cypress does not load", "it is in a place Cypress does not look", "the path is not a file",
 * "it leads outside the project", "it cannot be read", "it is empty", "it is the pre-v10 format" and "it was located
 * but never inspected" are ten different sentences with ten different fixes. A shared code would have to describe one
 * of them and would be wrong for the other nine.
 *
 * Two more cover the validity question, and they are split on *evidence* rather than on cause: a mechanism spoke and
 * said no, or no mechanism was entitled to speak. That is the distinction the whole configuration pair rests on, and
 * the six ways the second can happen share one code because they share one remedy — get a mechanism, then ask again.
 *
 * These are `QAT-H` and not `QAT-D`, even though a configuration is a property of a project: the codes above for QAT's
 * *own* configuration document (`QAT-H004`–`QAT-H006`) are also about a file in a project, and what a `QAT-H` code
 * denotes is who is speaking — this layer, about something it had to inspect itself — rather than what the inspected
 * thing is.
 *
 * Unlike the package-manager group these are not all advisory. Three are conditions a project can run with (a legacy
 * format, a stale copy in the wrong place, a file nothing would inspect) and the rest block, which is exactly the case
 * `CheckSeverity` and `CheckStatus` are separate for: one declared severity, two statuses, decided by the condition.
 *
 * ## Why QAT's own configuration grew from three codes to eleven
 *
 * The original three described the loader: empty, not JSON, too large. The loader cannot answer the questions a reader
 * actually asks, which begin once the bytes became a document — is the declared schema version one this release
 * understands, is the framework identifier one it can run, is an output path inside the project, which fields did the
 * schema reject. Each of those ends in a different action, so each earns a code under the same rule the two groups
 * above follow.
 *
 * Two of the new codes look like one condition split in half — absent, and absent-when-required — and they are not. A
 * missing file for a command that can proceed on documented defaults is an *observation*: informational, and a pass. A
 * missing file for a command that cannot proceed is a *failure*. One code cannot be both without moving the decision to
 * every call site, and the two produce different statuses as well as different severities.
 *
 * `QAT-H004` remains the empty-file code and is only reachable where the loader distinguishes an empty document from a
 * malformed one; where it cannot, `QAT-H005` speaks. A contract test asserts that whichever path is taken, the reader
 * gets one of the two sentences rather than a silent pass.
 *
 * New codes are appended, never inserted, so a number quoted in a report keeps its meaning.
 */
export const HealthCode = {
  /** The running Node.js version was read and lies outside the range QAT declares. */
  RuntimeUnsupported: "QAT-H001",
  /** Neither a manifest declaration nor a lockfile names a package manager. */
  PackageManagerUnknown: "QAT-H002",
  /** A configured output directory cannot be written. */
  OutputUnwritable: "QAT-H003",
  /** The configuration file exists and contains nothing but whitespace. */
  ConfigurationEmpty: "QAT-H004",
  /** The configuration file is not valid JSON. */
  ConfigurationNotJson: "QAT-H005",
  /** The configuration file is larger than QAT will read. */
  ConfigurationTooLarge: "QAT-H006",
  /** The environment a command selected is not declared in the configuration. */
  EnvironmentUndeclared: "QAT-H007",
  /**
   * The running Node.js version could not be compared with the declared range.
   *
   * Covers the three ways that happens — the host reported no version, reported something that is not a version, or the
   * declared requirement itself could not be read. One code because the reader's next step is the same for all three,
   * and because a code per cause would put QAT's own installation defects in the same list as the project's.
   *
   * Warning, never a pass: an unverified runtime is not a compatible one, and silence would read as consent.
   */
  RuntimeUnknown: "QAT-H008",
  /**
   * The project's framework release declares a Node.js range the running version does not satisfy.
   *
   * Separate from `QAT-H001` because the owner is different and so is the remedy: one is fixed by moving QAT, the other
   * by moving the project's framework — or the runtime the project builds against.
   */
  FrameworkRuntimeUnsupported: "QAT-H009",
  /**
   * The `packageManager` field is present and cannot be used as written.
   *
   * Distinct from `QAT-H002` because the project *did* try to declare its tool: the fix is to correct one field, not to
   * invent a declaration, and the message can quote what the reader wrote.
   */
  PackageManagerDeclarationInvalid: "QAT-H010",
  /**
   * The project installs with a manager outside the supported installation policy.
   *
   * Distinct from `QAT-H002` because the tool was identified successfully. Telling a Bun user that no package manager
   * was found sends them looking for a file that is present.
   */
  PackageManagerUnsupported: "QAT-H011",
  /**
   * Two or more lockfiles, or a declaration and a lockfile, that name different managers.
   *
   * Reported rather than arbitrated: picking a winner here is how CI installs with the wrong tool and rewrites the
   * lockfile the team meant to keep.
   */
  PackageManagerConflicting: "QAT-H012",
  /**
   * The manager is supported, but its executable is not on PATH.
   *
   * A toolchain problem, not a project problem — and not the same as "not installed". Conflating the two is what makes
   * people reinstall Node when the real answer was `corepack enable`.
   */
  PackageManagerExecutableMissing: "QAT-H013",
  /** The executable reported a version outside what the project declares. */
  PackageManagerVersionMismatch: "QAT-H014",
  /**
   * A version was expected and none could be read — timeout, failure, or no parsable version in the output.
   *
   * Advisory and never a pass: an unverified version is not a matching one, but a toolchain that answered oddly must
   * not be reported as a broken project.
   */
  PackageManagerVersionUnverified: "QAT-H015",
  /**
   * The manager and its tooling are fine, and the dependencies are not installed.
   *
   * The one package-manager condition whose remedy is a command rather than a correction, which is why it earns its own
   * code: it is the ordinary state of a fresh clone.
   */
  PackageManagerNotInstalled: "QAT-H016",
  /**
   * `node_modules` exists and a different manager created it.
   *
   * Everything looks installed, so the failure surfaces much later as a resolution error naming a package nobody
   * edited. Naming both managers is the whole value of reporting it early.
   */
  PackageManagerForeignInstall: "QAT-H017",
  /**
   * No Cypress configuration file was found.
   *
   * One code for two situations — nothing about the project says "Cypress", or Cypress is evidenced but never
   * configured — because the remedy is the same sentence with a different opening clause: create one. The distinction
   * survives in the finding's explanation, which is derived from evidence rather than re-read from the directory.
   */
  CypressConfigurationMissing: "QAT-H018",
  /**
   * More than one Cypress configuration file is present.
   *
   * Cypress refuses to start with two, so this is a report of the same fact rather than a preference QAT could resolve.
   * Naming a winner here would decide which file the next install rewrites.
   */
  CypressConfigurationAmbiguous: "QAT-H019",
  /**
   * A configuration-looking file exists in a form Cypress does not load.
   *
   * Distinct from `QAT-H018`: something here is plainly intended as configuration, so telling the reader nothing was
   * found sends them looking for a file they already have.
   */
  CypressConfigurationUnsupportedFormat: "QAT-H020",
  /**
   * A configuration exists where Cypress never reads one — inside `cypress/`.
   *
   * Advisory when it accompanies a working configuration, because the project runs; the stale copy is worth mentioning
   * and not worth blocking. The fix is to move a file rather than to write one.
   */
  CypressConfigurationMisplaced: "QAT-H021",
  /**
   * A configuration path is not a regular file — a directory, or a link that leads nowhere.
   *
   * Covers the case a file probe cannot see at all (a directory on `cypress.config.ts`) and the case it sees and cannot
   * use, because both remedies are the same sentence: put a regular file there. It is the one fact that turns an
   * otherwise baffling "no configuration found" into something a reader can act on.
   */
  CypressConfigurationPathNotAFile: "QAT-H022",
  /**
   * The configuration is a symbolic link that resolves outside the project.
   *
   * A boundary, not a preference: a file outside the project does not describe this project, and reading it would let a
   * repository point a diagnostic at something the developer never meant to expose.
   */
  CypressConfigurationOutsideProject: "QAT-H023",
  /**
   * The configuration exists and cannot be read.
   *
   * Distinct from missing on purpose: the file is there, so telling the reader to create one would be actively
   * misleading. The cause distinguishes "you are not allowed" from "the disk misbehaved".
   */
  CypressConfigurationUnreadable: "QAT-H024",
  /** The configuration exists and carries nothing — no content, or whitespace only. */
  CypressConfigurationEmpty: "QAT-H025",
  /**
   * The configuration is readable and in the pre-v10 format.
   *
   * Advisory, not blocking: it works today, and failing a project that runs would be wrong. Silence would be worse —
   * it would let a team meet this during an upgrade instead of now.
   */
  CypressConfigurationLegacyFormat: "QAT-H026",
  /**
   * The configuration was located and never inspected.
   *
   * A question we could not answer, so a warning: never a pass, because silence must not read as consent, and never a
   * failure, because a question we failed to answer must not block work we can still perform.
   */
  CypressConfigurationNotInspected: "QAT-H027",
  /**
   * A supported mechanism established that the configuration is invalid.
   *
   * The only configuration code that can honestly block, because it is only reachable when a JSON parser or the
   * project's own loader said so. The mechanism is named in the explanation and the location is described by line and
   * kind — never by an excerpt, because a line of a configuration file can hold an environment value and a loader's
   * message can carry a code frame of one.
   */
  CypressConfigurationInvalid: "QAT-H028",
  /**
   * No mechanism was entitled to a verdict about the configuration.
   *
   * Deep validation off, a loader unavailable, a probe that timed out, a file that is not text, a file beyond the read
   * budget, or a sample that never established anything. One code for six causes because the remedy is one thing — get
   * a mechanism, then ask again — while the cause still decides the sentence, since "off by default" and "timed out"
   * are different mornings for whoever has to debug it.
   */
  CypressConfigurationUnverified: "QAT-H029",
  /**
   * No QAT configuration file exists, and the documented defaults apply.
   *
   * Information, and attached to a `Passed` outcome. A project that never ran `qat init` is in a supported state, and
   * marking it a problem is how a doctor teaches people to ignore it. The remedy says the file is optional in as many
   * words, because "create one" would imply otherwise.
   */
  ConfigurationMissing: "QAT-H030",
  /**
   * No QAT configuration file exists, and this command cannot proceed without one.
   *
   * A separate code rather than a severity flag on `QAT-H030`, because a code that could be informational or blocking
   * depending on a flag would move the same decision to every call site that remembered to pass it — and the two
   * outcomes are not merely different weights, they are a pass and a failure.
   */
  ConfigurationMissingRequired: "QAT-H031",
  /**
   * The configuration file is there and cannot be read.
   *
   * Distinct from absent on purpose: the file exists, so telling the reader to create one would send them to overwrite
   * something. The cause — permission, a directory, a link loop — decides the sentence.
   */
  ConfigurationUnreadable: "QAT-H032",
  /**
   * The declared schema version is outside the set this release understands.
   *
   * Reported alone, with no field complaints: there is nothing meaningful to say about fields in a document whose
   * version we do not understand, and a wall of schema errors buries the one fact the reader can act on. Both the
   * declared and the supported versions are printed, because "unsupported" without the pair leaves them unable to tell
   * whether to move QAT or edit the file.
   */
  ConfigurationVersionUnsupported: "QAT-H033",
  /**
   * The schema version is absent or is not a number.
   *
   * Split from `QAT-H033` because the remedies differ by one character: a version written as a string is a typo to
   * correct, while a version from the future means the reader is on the wrong release of QAT. One message covering both
   * would be wrong for whoever it was not written for.
   */
  ConfigurationVersionInvalid: "QAT-H034",
  /**
   * The document parsed and the schema rejected one or more fields.
   *
   * The general field report, and the one code in this group that lists paths: they are the address a reader can act
   * on. Values are never repeated — a value that failed validation is exactly the value a diagnostic must not print —
   * and the command that prints the full detail is named so the reader decides where to disclose it.
   */
  ConfigurationSchemaInvalid: "QAT-H035",
  /**
   * An output path is absolute, escapes the project, or is otherwise not portable.
   *
   * Distinct from the general field report because the fix is a shape rather than a value: a relative path, written
   * with forward slashes, that stays inside the project. Listing the offending field paths is enough; a path on a
   * developer machine routinely contains a username, so the values are not echoed.
   */
  ConfigurationOutputPathInvalid: "QAT-H036",
  /**
   * The framework identifier is not an adapter this release can run.
   *
   * Its own code because its own fix: the rest of the file may be perfectly correct and the reader's next action is to
   * change one word. The declared value is not echoed, for the same reason no other configured value is.
   */
  ConfigurationFrameworkUnsupported: "QAT-H037",
} as const;

export type HealthCode = (typeof HealthCode)[keyof typeof HealthCode];

/** Any code a check's finding may carry, from whichever layer owns the condition. */
export type DoctorDiagnosticCode =
  DiagnosticCode | ValidationCode | ConfigurationDiagnosticCode | HealthCode;

/**
 * A finding a check reported.
 *
 * The same shape as every other finding in the project, parameterised over the wider code set — which is what the
 * parameter was added for. Text is carried rather than looked up, so a stored report still reads correctly after the
 * catalogue's wording has changed, and a renderer needs no access to a catalogue to print it.
 */
export type CheckFinding = DiagnosticFinding<DoctorDiagnosticCode>;

/** A check that ran and was satisfied. */
export interface CheckPassed {
  readonly check: CheckId;
  readonly category: CheckCategory;
  /** The check's declared severity, whether or not it mattered this time. */
  readonly severity: CheckSeverity;
  readonly status: typeof CheckStatus.Passed;
  /**
   * An observation attached to a satisfied check.
   *
   * Optional because most passes have nothing to say. It exists so that a genuine finding — "no configuration file,
   * and the documented defaults apply" — is reported rather than discarded, without inventing a fifth status for
   * "passed, and here is a note".
   *
   * Invariant, enforced by the catalogue test: an attached finding's severity is `information`. Anything louder means
   * the check did not actually pass, and the honest status would have been `warned`.
   */
  readonly finding?: CheckFinding;
}

/**
 * A check that ran and was not satisfied.
 *
 * `Warned` and `Failed` share a shape because they differ only in what the severity means: a warning is a finding the
 * reader should see before a run, and a failure is one that stops it. Splitting them would duplicate every field to
 * express one bit.
 */
export interface CheckConcluded {
  readonly check: CheckId;
  readonly category: CheckCategory;
  readonly severity: CheckSeverity;
  readonly status: typeof CheckStatus.Warned | typeof CheckStatus.Failed;
  readonly finding: CheckFinding;
}

/**
 * A check that did not run.
 *
 * Carries an explanation because "skipped" on its own is the least useful word in a report. The sentence names the
 * check that stopped it, which is the only actionable thing about a skipped check — and it says "not run" rather than
 * "could not be verified", because those read as two different levels of doubt.
 */
export interface CheckSkipped {
  readonly check: CheckId;
  readonly category: CheckCategory;
  readonly severity: CheckSeverity;
  readonly status: typeof CheckStatus.Skipped;
  readonly reason: CheckSkipReason;
  readonly explanation: string;
}

export type CheckOutcome = CheckPassed | CheckConcluded | CheckSkipped;

/**
 * Everything a doctor run concluded.
 *
 * Ordered by the catalogue's declaration order, which is the order a reader fixes things in — so a report rendered top
 * to bottom is already a plan, with causes before consequences.
 *
 * The diagnosis is deliberately absent. This value is the verdict about the run; a later decision is where the project
 * description sits relative to it, and embedding it here would make every consumer of a report carry a tree of findings
 * it may not print.
 */
export interface DoctorReport {
  readonly outcomes: readonly CheckOutcome[];
}

/** One check's outcome, or `undefined` when the run never covered it. */
export function outcomeOf(
  report: DoctorReport,
  check: CheckId,
): CheckOutcome | undefined {
  return report.outcomes.find((outcome) => outcome.check === check);
}

/**
 * Whether anything the doctor found stops a run.
 *
 * A `skipped` outcome never blocks, and that is not an oversight. A check is skipped *because* another check did not
 * pass, and that failure is already in the list — counting the consequence as well would report one condition as
 * several, which is the collapse the whole diagnostics chain exists to prevent.
 *
 * An informational finding attached to a `passed` outcome never blocks either, by construction: it is information.
 */
export function isBlocked(report: DoctorReport): boolean {
  return report.outcomes.some(
    (outcome) => outcome.status === CheckStatus.Failed,
  );
}

/**
 * The checks that failed, in declaration order.
 *
 * Named for what they are rather than for what they cause: `blockedChecks` would read as "checks that were blocked",
 * which is what `skipped` means, and a caller would reach for it expecting the other list.
 */
export function failedChecks(report: DoctorReport): readonly CheckConcluded[] {
  return report.outcomes.filter(
    (outcome): outcome is CheckConcluded =>
      outcome.status === CheckStatus.Failed,
  );
}
