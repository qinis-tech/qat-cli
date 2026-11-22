/**
 * Every command the CLI supports.
 *
 * A command is listed here when its capability exists, not when it is planned. `--help` reads this
 * list, so the list is a statement about what the tool can do rather than about what it intends to
 * do — see ADR-0013.
 *
 * Adding a command: write the definition beside this file, add it to the array, and add a help test.
 * Nothing else changes.
 */
import type { CommandDefinition } from "../contracts.js";

import { doctorCommand } from "./doctor.js";

export const COMMANDS: readonly CommandDefinition[] = [doctorCommand];
