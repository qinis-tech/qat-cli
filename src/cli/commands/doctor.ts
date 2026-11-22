/**
 * `qat doctor`.
 *
 * The one command registered today, and it is registered because its capability exists: project discovery,
 * the environment utilities and the error model between them can already answer the question. Registering
 * it with a stub handler would have put a command in `--help` that does nothing, and a help system
 * describing hypothetical software is worse than a short one.
 *
 * It reports; it does not repair. A command that silently changed the project would be a different command
 * with a different name.
 */
import type { CommandDefinition } from "../contracts.js";
import { reportResult } from "../output/report.js";

export const doctorCommand: CommandDefinition = {
  name: "doctor",
  summary: "Report what QAT can see about this project",
  description: [
    [
      "Inspects the project in the given directory and reports what was found: the project name,",
      "the detected framework and where its installation came from, and the paths QAT would use",
      "to run tests and to record results.",
    ].join(" "),
    [
      "Intended to be run before the first execution, so an unusual layout or a missing framework",
      "is discovered in a second rather than in the middle of a run.",
    ].join(" "),
  ].join("\n\n"),
  arguments: [
    {
      name: "directory",
      description:
        "directory to inspect; overrides --cwd, and defaults to the working directory",
      required: false,
    },
  ],
  examples: ["qat doctor", "qat doctor ./packages/api", "qat doctor --json"],
  async run({ application, arguments: values, options }) {
    // Resolved before discovery, and by the shared resolver rather than here. A command that worked out
    // its own precedence would eventually work it out slightly differently from its neighbours, and an
    // invalid directory would reach discovery before anyone noticed.
    const { directory } = await application.discovery.resolveWorkingDirectory({
      argument: values["directory"],
      option: options.cwd,
    });

    const project = await application.discovery.discover(directory);

    reportResult(
      {
        lines: [
          `project    ${project.name}`,
          `root       ${project.root}`,
          `framework  ${project.framework} ${project.installation.version} (${project.installation.source} install)`,
          `config     ${project.paths.configFile}`,
          `specs      ${project.paths.specsDirectory}`,
        ],
        // Wrapped rather than bare, so a later field can be added without changing the shape a consumer
        // parses today.
        document: { project },
      },
      { json: options.json },
    );
  },
};
