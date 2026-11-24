/**
 * What configuration discovery reports.
 *
 * ## Three answers, and why absence is one of them
 *
 * A project with no configuration file is legal — the defaults apply — so absence cannot be an error without making the
 * ordinary case exceptional. But a name occupied by a directory is *not* the ordinary case: something has gone wrong, the
 * reader can fix it, and reporting it as absence would send them looking for a file they are standing on.
 *
 * So there are two results and one failure:
 *
 * | Situation | Answer |
 * | --- | --- |
 * | The canonical file exists at the root | `found`, with its absolute path |
 * | Nothing exists at that name | `absent` |
 * | Something exists at that name and is not a regular file | `not-a-file`, naming what is there |
 * | The filesystem could not answer | a thrown `ApplicationError` |
 *
 * The last row is the one a boolean probe destroys. `isFile` answers `false` for a missing file, a directory, a device
 * and a permission failure alike, and three of those four need different things said about them.
 */
import { CONFIG_FILE_NAME } from "../contracts.js";

/** How a configuration file was or was not found. A closed set, so a `switch` over it is exhaustive. */
export const ConfigurationLocation = {
  /** The canonical file exists at the project root. */
  Found: "found",
  /** No configuration file. Legal: the defaults apply and nothing is wrong. */
  Absent: "absent",
  /** The canonical name exists and is not a regular file, so it cannot be a configuration. */
  NotAFile: "not-a-file",
} as const;

export type ConfigurationLocation =
  (typeof ConfigurationLocation)[keyof typeof ConfigurationLocation];

export interface FoundConfiguration {
  readonly kind: typeof ConfigurationLocation.Found;
  /**
   * Absolute, and the only path in the result.
   *
   * Absolute because this is a live value handed to a loader that will open it. Anything shown to a reader is built from
   * `CONFIG_FILE_NAME` instead, so a message never carries a machine's directory layout.
   */
  readonly path: string;
}

export interface AbsentConfiguration {
  readonly kind: typeof ConfigurationLocation.Absent;
  /** The root that was searched. Present so a caller can say where nothing was found without re-deriving it. */
  readonly root: string;
}

export interface OccupiedConfiguration {
  readonly kind: typeof ConfigurationLocation.NotAFile;
  readonly path: string;
  /**
   * What is at that path.
   *
   * `directory` is overwhelmingly the case — a checkout that lost the file and kept a folder, or a generator that wrote a
   * directory where a file belonged. `other` covers a device, a socket, a fifo: rare enough to be one answer, distinct
   * enough not to be called a directory.
   */
  readonly occupiedBy: "directory" | "other";
}

export type ConfigurationDiscovery =
  FoundConfiguration | AbsentConfiguration | OccupiedConfiguration;

/** The name every message uses, re-exported here so a caller rendering a result does not import two modules. */
export { CONFIG_FILE_NAME };
