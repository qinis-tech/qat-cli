/**
 * Initialisation, as the application sees it.
 *
 * Four outcomes, because they send the reader to four places:
 *
 * | Outcome | What the reader does |
 * | --- | --- |
 * | `created` | Commit the file, or edit it — nothing else is needed |
 * | `already-initialised` | Nothing. The project is configured |
 * | `existing-configuration` | Fix or delete the file QAT found; it will not touch it |
 * | `project-not-usable` | Fix the project conditions named, then run the command again |
 *
 * There is no `failed` outcome. A machine failure — a permission problem, a full disk — rejects with an
 * `ApplicationError`, because absence and bad input are answers and a broken machine is not. That split is this
 * codebase's error contract, not a decision taken here.
 */
import type { DiagnosticSeverity } from "./diagnostics.js";

/**
 * One thing worth telling the reader, from either vocabulary.
 *
 * Deliberately structural rather than reusing `AnyDiagnosticFinding`: that union's `code` is closed over two code sets,
 * and a configuration diagnostic carries a third. Widening the union would let a schema code reach a gate that can never
 * produce one; this shape says only what a renderer needs.
 */
export interface InitialisationFinding {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  /** One sentence, naming the field and never quoting a configured value. */
  readonly explanation: string;
  readonly path?: string;
  readonly remediation?: string;
}

export const InitialisationOutcome = {
  /** The configuration was written. The only outcome that changed anything on disk. */
  Created: "created",
  /** A configuration is already there and could be loaded. Nothing was written. */
  AlreadyInitialised: "already-initialised",
  /** Something is at the configuration path and cannot be used. Nothing was written, and nothing was removed. */
  ExistingConfiguration: "existing-configuration",
  /** The directory is not a supported Cypress project. Nothing was inspected for a configuration. */
  ProjectNotUsable: "project-not-usable",
} as const;

export type InitialisationOutcome =
  (typeof InitialisationOutcome)[keyof typeof InitialisationOutcome];

export type InitialisationResult =
  | {
      readonly outcome: typeof InitialisationOutcome.Created;
      readonly root: string;
      /** Absolute path of the file that was created. */
      readonly path: string;
    }
  | {
      readonly outcome: typeof InitialisationOutcome.AlreadyInitialised;
      readonly root: string;
      readonly path: string;
    }
  | {
      readonly outcome: typeof InitialisationOutcome.ExistingConfiguration;
      readonly root: string;
      readonly path: string;
      /** Which load outcome the existing file produced: `empty`, `malformed`, `invalid` or `too-large`. */
      readonly reason: string;
      readonly findings: readonly InitialisationFinding[];
    }
  | {
      readonly outcome: typeof InitialisationOutcome.ProjectNotUsable;
      readonly root: string;
      readonly findings: readonly InitialisationFinding[];
    };

/**
 * Creates a project's configuration, or explains why it did not.
 *
 * One operation, because there is one thing a caller can want. The nine workflow steps are the implementation's business;
 * exposing them would let a command run four of the nine and report a result that never happened.
 */
export interface InitialisationService {
  /**
   * @param root Absolute path to the project directory. Resolved by the caller, never read from the working directory.
   * @returns Which of the four outcomes occurred, with the findings that explain a refusal.
   * @throws {ApplicationError} when the filesystem could not answer, or refused to create the file.
   */
  initialise(root: string): Promise<InitialisationResult>;
}
