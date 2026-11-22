/**
 * The command registry.
 *
 * Empty, and that is deliberate: this change establishes the mechanism, not any command. Adding one
 * means adding an entry here and a `CommandDefinition` beside it; nothing in the entry point changes.
 */
import type { CommandDefinition } from "../contracts.js";

export const COMMANDS: readonly CommandDefinition[] = [];
