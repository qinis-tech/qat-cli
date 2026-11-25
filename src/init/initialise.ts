import { join } from "node:path";

import { CONFIG_FILE_NAME } from "../config/contracts.js";
import {
  ConfigurationLoad,
  type ConfigurationLoadResult,
} from "../config/loader/index.js";
import { qatConfigSchema } from "../config/schema/index.js";
import {
  InitialisationOutcome,
  type InitialisationFinding,
  type InitialisationService,
} from "../core/application/initialisation.js";
import type { ProjectAssessment } from "../core/application/validation.js";
import type { NewFileWriteOutcome } from "../core/filesystem/index.js";

import {
  generateDefaultConfiguration,
  serialiseConfiguration,
} from "./generate.js";
import { unusableProjectFindings } from "./policy.js";

/**
 * What the service needs in order to work.
 *
 * Four operations, each already implemented elsewhere. They are passed in rather than imported so the workflow can be
 * exercised in memory, and so the assembly stays the only place that names an implementation.
 */
export interface InitialisationDependencies {
  /** The project assessment, which already embeds detection, diagnosis and the per-operation verdict. */
  readonly assess: (root: string) => Promise<ProjectAssessment>;
  /** The configuration loader, which answers "is there a usable file at this path" without reading it twice. */
  readonly readConfiguration: (
    path: string,
  ) => Promise<ConfigurationLoadResult>;
  /**
   * Creates a file, reporting whether one was already there rather than throwing for it.
   *
   * Not "writes a file", and not `Promise<void>`. Two things would go wrong with the weaker signature. A writer that
   * replaces is the wrong contract for this caller, and an interface that permits replacement would let a future change
   * lose somebody's configuration with nothing to review. And a `void` return discards the one piece of information
   * that closes the gap between the check above and this call: whether the file we are about to write was created by us
   * or was already there.
   */
  readonly createFile: (
    path: string,
    contents: string,
  ) => Promise<NewFileWriteOutcome>;
}

/**
 * Builds the initialisation service.
 *
 * The workflow is written in the order it runs, and the order is the safety argument: nothing is generated before the
 * project is judged, nothing is validated after it is written, and nothing is written before the path is known to be
 * free.
 */
export function createInitialisationService(
  dependencies: InitialisationDependencies,
): InitialisationService {
  return {
    async initialise(root: string) {
      // 1 and 2. The assessment is one call, and it is the same one `qat doctor` uses — detection that disagreed with
      // the report a reader had just seen would be worse than no detection at all.
      const assessment = await dependencies.assess(root);

      // 3. Compatibility, from the gate that already decided it.
      const blocking = unusableProjectFindings(assessment);
      if (blocking.length > 0) {
        return {
          outcome: InitialisationOutcome.ProjectNotUsable,
          root,
          findings: blocking,
        };
      }

      const path = join(root, CONFIG_FILE_NAME);

      // 4. Is anything already there? A load rather than an existence check, because the answer distinguishes a project
      // that is initialised from one whose file is broken — and those two get different messages and the same refusal.
      const existing = await dependencies.readConfiguration(path);

      if (existing.kind === ConfigurationLoad.Loaded) {
        return {
          outcome: InitialisationOutcome.AlreadyInitialised,
          root,
          path,
        };
      }

      if (existing.kind !== ConfigurationLoad.NotFound) {
        return {
          outcome: InitialisationOutcome.ExistingConfiguration,
          root,
          path,
          reason: existing.kind,
          findings: describedBy(existing),
        };
      }

      // 5. Generate. Pure, and built from constants, so what follows is a check on this module rather than on the input.
      const document = generateDefaultConfiguration();

      // 6. Validate before writing, never after. A generator defect should stop the command, not leave a file on disk
      // that the next command refuses to read.
      const validation = qatConfigSchema.safeParse(document);
      if (!validation.success) {
        throw new TypeError(
          "The generated configuration does not satisfy the schema. This is a defect in the generator, not a problem " +
            "with the project, and nothing was written.",
        );
      }

      // 7. Create. The writer refuses an occupied path, which is the only part of "do not overwrite" that holds under a
      // race — the load above was a check taken at an earlier moment, and this call is the one that decides.
      const written = await dependencies.createFile(
        path,
        serialiseConfiguration(document),
      );

      // The one window this design cannot close by asking first. Something created the file between the load and the
      // create — a second `qat init`, a checkout, a colleague — and the writer refused rather than replacing it. Their
      // file is now the project's file, so the honest answer is the one we would have given had we seen it a moment
      // earlier: read it and report what is actually there.
      if (written === "exists") {
        const now = await dependencies.readConfiguration(path);

        return now.kind === ConfigurationLoad.Loaded
          ? { outcome: InitialisationOutcome.AlreadyInitialised, root, path }
          : {
              outcome: InitialisationOutcome.ExistingConfiguration,
              root,
              path,
              reason: now.kind,
              findings: describedBy(now),
            };
      }

      // 8 and 9 belong to the command: this service reports what happened, and the command decides what to print and
      // what to exit with.
      return { outcome: InitialisationOutcome.Created, root, path };
    },
  };
}

/**
 * Turn a failed load into findings the reader can act on.
 *
 * An `invalid` file already carries diagnostics written for this purpose; the other reasons are one sentence each,
 * because their remedy is short. Nothing here quotes the contents of the file: the reason is enough to act on, and a
 * configuration can contain environment variables.
 *
 * Every branch refuses. The `default` is therefore not a gap — it is the same refusal for a load outcome this function
 * was not written to see — which is the safe direction for something whose job is to answer "may I write here".
 */
function describedBy(
  existing: ConfigurationLoadResult,
): readonly InitialisationFinding[] {
  if (existing.kind === ConfigurationLoad.Invalid) {
    return existing.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: "error" as const,
      explanation:
        diagnostic.path === ""
          ? diagnostic.message
          : `${diagnostic.path}: ${diagnostic.message}`,
      ...(diagnostic.path === "" ? {} : { path: diagnostic.path }),
      ...(diagnostic.remediation === undefined
        ? {}
        : { remediation: diagnostic.remediation }),
    }));
  }

  const remedy = `Fix or delete ${CONFIG_FILE_NAME}, then run the command again. QAT does not replace a file it did not write.`;

  switch (existing.kind) {
    case ConfigurationLoad.Empty:
      return [
        {
          code: "QAT-INIT-EXISTING-EMPTY",
          severity: "error",
          explanation: `${CONFIG_FILE_NAME} exists and is empty.`,
          path: CONFIG_FILE_NAME,
          remediation: remedy,
        },
      ];

    case ConfigurationLoad.Malformed:
      return [
        {
          code: "QAT-INIT-EXISTING-MALFORMED",
          severity: "error",
          explanation: `${CONFIG_FILE_NAME} is not valid JSON, at line ${String(existing.location.line)} column ${String(existing.location.column)}.`,
          path: CONFIG_FILE_NAME,
          remediation: remedy,
        },
      ];

    case ConfigurationLoad.TooLarge:
      return [
        {
          code: "QAT-INIT-EXISTING-TOO-LARGE",
          severity: "error",
          explanation: `${CONFIG_FILE_NAME} is larger than a configuration should be.`,
          path: CONFIG_FILE_NAME,
          remediation: `${remedy} Check that the path is the file you meant.`,
        },
      ];

    case ConfigurationLoad.NotFound:
      // Reachable only through the race branch: the file appeared and was removed again while the command ran. There is
      // nothing to fix, so the remedy is to try again rather than to edit anything.
      return [
        {
          code: "QAT-INIT-EXISTING-DISAPPEARED",
          severity: "error",
          explanation: `A file appeared at ${CONFIG_FILE_NAME} and was removed again while the command was running.`,
          path: CONFIG_FILE_NAME,
          remediation: "Run the command again.",
        },
      ];

    default:
      return [
        {
          code: "QAT-INIT-EXISTING-UNUSABLE",
          severity: "error",
          explanation: `${CONFIG_FILE_NAME} exists and cannot be used.`,
          path: CONFIG_FILE_NAME,
          remediation: remedy,
        },
      ];
  }
}
