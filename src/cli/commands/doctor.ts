/**
 * `qat doctor`.
 *
 * The one command registered today, and it is registered because its capability exists: project discovery,
 * the environment utilities and the error model between them can already answer the question. Registering it
 * with a stub handler would have put a command in `--help` that does nothing, and a help system describing
 * hypothetical software is worse than a short one.
 *
 * It reports; it does not repair. A command that silently changed the project would be a different command
 * with a different name.
 *
 * Nothing it prints is an inference. Every line restates a fact discovery established, and a fact that is
 * *absent* is printed as absent rather than omitted — a missing manifest and an undeclared dependency are
 * both things the reader needs to know, and leaving a line out would make the two look identical to silence.
 */
import type {
  PackageManagerInfo,
  ProjectInfo,
} from "../../core/domain/index.js";
import type { CommandDefinition } from "../contracts.js";
import { reportResult } from "../output/report.js";

/**
 * One label-and-value line.
 *
 * Padding is computed rather than typed, so adding a label cannot misalign the column beside it. Ten is wide
 * enough for `framework`; a longer label simply gets one space, which stays readable rather than truncating.
 */
function row(label: string, value: string): string {
  return `${label.padEnd(10)} ${value}`;
}

/**
 * How the project's dependencies are managed, and where that came from.
 *
 * The provenance is part of the answer: a lockfile left behind after a migration names a manager the project
 * no longer uses, and a reader who knows it was inferred can discount it.
 */
function describeManager(manager: PackageManagerInfo): string {
  return manager.declared
    ? `${manager.name} (declared)`
    : `${manager.name} (from ${manager.lockfile ?? "a lockfile"})`;
}

/**
 * Every line the command prints, in a fixed order.
 *
 * Separated from the handler so the shape of the report can be read in one place. `framework` and `declared`
 * sit adjacent on purpose: they are the two halves of the same question — what is on disk, and what the
 * manifest claims — and the whole point of reporting them apart is that they can disagree.
 *
 * Output is plain ASCII. An em dash reads well in a document and becomes mojibake in a console using a legacy
 * code page, so the absence of package metadata is stated in words rather than punctuation.
 */
function reportLines(project: ProjectInfo): readonly string[] {
  const metadata = project.packageMetadata;
  const manager = project.packageManager;
  const declaration = project.frameworkDeclaration;

  return [
    row("project", project.name),
    row("root", project.root),
    // Printed even when absent. A bare Cypress project is legal, and saying so is more useful than a line
    // that silently disappears.
    row(
      "package",
      metadata === undefined
        ? "(no package metadata; using the directory name)"
        : `${metadata.name}@${metadata.version}`,
    ),
    ...(manager === undefined
      ? []
      : [row("manager", describeManager(manager))]),
    row(
      "framework",
      `${project.framework} ${project.installation.version} (${project.installation.source} install)`,
    ),
    // Also printed when absent: a hoisted workspace install declares nothing, and that is a fact about the
    // project rather than a gap in the tool.
    row(
      "declared",
      declaration === undefined
        ? "nowhere in this package"
        : `${declaration.section} (${declaration.range})`,
    ),
    row("config", project.paths.configFile),
    row("specs", project.paths.specsDirectory),
  ];
}

export const doctorCommand: CommandDefinition = {
  name: "doctor",
  summary: "Report what QAT can see about this project",
  description: [
    "Inspects the project in the given directory and reports what was found: the package identity, how its dependencies are managed, whether the framework is declared and where its installation comes from, and the paths QAT would use to run tests and to record results.",
    "Intended to be run before the first execution, so an unusual layout or a missing framework is discovered in a second rather than in the middle of a run.",
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
    // Resolved before discovery, and by the shared resolver rather than here. A command that worked out its own
    // precedence would eventually work it out slightly differently from its neighbours, and an invalid
    // directory would reach discovery before anyone noticed.
    const { directory } = await application.discovery.resolveWorkingDirectory({
      argument: values["directory"],
      option: options.cwd,
    });

    const project = await application.discovery.discover(directory);

    reportResult(
      {
        lines: reportLines(project),
        // Wrapped rather than bare, so a later field can be added without changing the shape a consumer parses
        // today. The declaration, the metadata and the package manager all arrive inside `project`, so the
        // machine-readable form gains the same facts with no document change.
        document: { project },
      },
      { json: options.json },
    );
  },
};
