/**
 * The configuration file a project is read from.
 *
 * ## One name, at the root, and no search
 *
 * A project's configuration is `qat.config.json` at the project root. There is no ascent to a parent directory, no
 * second filename for a "local" variant, and no negotiation between formats.
 *
 * Each of those refusals is a decision with a cost, and the cost is recorded: a workspace member with settings at its
 * root is not read, and a developer cannot keep a personal override beside the shared file. What each buys is the same
 * thing — that reading a project's configuration is a lookup rather than a search, so two commands in the same directory
 * cannot disagree about which file they read.
 *
 * ## JSON, not JavaScript
 *
 * A configuration file that is a program has to be executed to be understood, which is the same refusal
 * `docs/architecture/adr/0008-do-not-evaluate-the-framework-configuration.md` makes about a framework's own
 * configuration. It also means a configuration cannot be read by anything that does not trust the repository: a JSON
 * document is data, and a `qat.config.js` is code that runs on load.
 */
export const CONFIG_FILE_NAME = "qat.config.json";
