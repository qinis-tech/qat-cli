<div align="center">

# QAT

**Quality Automation Toolkit**

_A green build is a claim. QAT is about whether you can believe it._

[![status](https://img.shields.io/badge/status-pre--alpha-orange?style=flat-square)](#status)
[![node](https://img.shields.io/badge/node-%E2%89%A524-339933?style=flat-square&logo=node.js&logoColor=white)](#requirements)
[![license](https://img.shields.io/badge/license-Apache%20License%202.0-blue)](LICENSE)
[![types](https://img.shields.io/badge/types-TypeScript-3178c6?style=flat-square)](tsconfig.json)

</div>

---

## The premise

Your team already has automated tests. They run in CI. They go green, mostly.

The part nobody solved is what happens _after_ that. What does a red build actually mean — broken code, a missing
dependency, a flaky spec, a browser that never started, or a runner that ran out of disk? Which of the two hundred
failures this week are the same failure? Where is the screenshot for the one that matters? Is this suite getting slower,
or is it getting less reliable?

QAT is a CLI that sits on top of the tools you already use and answers those questions. It does not run your tests
differently. It makes the _result_ of running them into evidence you can act on.

The first question it answers is the one everything else depends on: **is this project one QAT can run at all?** That is
what `qat doctor` does, and it is the command that exists today.

```console
$ qat doctor
project      demo
root         /repo/packages/api
package      present
framework    cypress 13.15.0 (project install)
declared     devDependencies (^13.15.0)
config       cypress.config.ts
detection    detected
compatibility consistent
result       ready

$ echo $?
0
```

When something blocks a run, the reason is printed with a code, the file it concerns, and what to do about it — and the
exit status carries the failure.

```console
$ qat doctor ./legacy
…
result       blocked

QAT-V001 error
  A Cypress configuration was found at cypress/cypress.config.ts, where Cypress does not load it.
  at:  cypress/cypress.config.ts
  fix: Move it to the project root as cypress.config.ts.

$ echo $?
2
```

> `qat doctor` is real. `qat run` is next and is not written yet — see [Status](#status).

---

## What QAT is, and what it deliberately is not

| QAT is                                               | QAT is not                  |
| ---------------------------------------------------- | --------------------------- |
| An engineering layer over your existing test tools   | Another test framework      |
| A stable, documented exit-code and result contract   | Another assertion library   |
| Structured evidence you can query, diff and archive  | A browser automation engine |
| A diagnostics tool for the failures you already have | A test management system    |
| Cypress-native first, framework-agnostic by design   | A hosted service            |

Cypress, Playwright, Selenium and Vitest are good at what they do. Rebuilding them would be a way to lose. The gap is
everything _around_ a test run: consistent exit codes, portable results, history, and diagnostics that turn a red build
into a fix.

---

## Status

**Pre-alpha.** The engineering foundation is in place and the first user-facing command works; the product is not
finished, and the package is not published.

| Area                                                      | State       |
| --------------------------------------------------------- | ----------- |
| Domain contracts, error model, exit-code mapping          | Built       |
| Structured logging, safe filesystem utilities             | Built       |
| Package metadata and Cypress project detection            | Built       |
| Diagnostics, validation and per-operation readiness       | Built       |
| CLI entry point, `qat doctor`, exit-status contract       | Built       |
| Lint, format, type, test and decision-record gates        | Built       |
| Continuous integration, git hooks, publication safeguards | Built       |
| Architecture decision records                             | 21 accepted |
| Cypress adapter and `qat run`                             | Not started |
| Reports, history, diff and `qat diagnose`                 | Not started |

This table is updated as work lands. If it says "Built", there is code and a test behind it.

---

## The exit-code contract

This is the smallest part of QAT and the one that matters most, because it is the only part a CI job can read.

| Code  | Meaning                                                                  |
| ----- | ------------------------------------------------------------------------ |
| `0`   | The command completed and everything passed                              |
| `1`   | The tests ran and some failed                                            |
| `2`   | The command or its inputs were wrong — arguments, project, configuration |
| `3`   | The environment or infrastructure prevented the run                      |
| `4`   | An unexpected internal error                                             |
| `130` | Interrupted                                                              |

**`1` means your code is broken.** Nothing else may mean that.

Most CLIs spend `1` on every failure, which makes a configuration typo indistinguishable from a failing test. A pipeline
cannot tell "your change is bad" from "our tool is bad", so a human has to read the log — which is where the time goes.
QAT refuses that trade, and a test asserts that no application error can ever produce `1`.

`qat doctor` already honours it in the direction that matters most: a project that cannot be run exits `2`, and it writes
**nothing to standard error**, because the report _is_ the failure message. A pipeline can therefore separate "this
command found something to say" from "this command broke" without parsing prose.

Full contract and rationale: [error model](docs/architecture/error-model.md).

---

## Command surface

| Command        | Purpose                                                        | State     |
| -------------- | -------------------------------------------------------------- | --------- |
| `qat doctor`   | Report what QAT can see about a project, and what blocks a run | **Built** |
| `qat run`      | Execute a suite through the detected framework                 | Next      |
| `qat init`     | Scaffold a project against a known-good structure              | Planned   |
| `qat report`   | Render a structured result as HTML, JSON or JUnit              | Planned   |
| `qat history`  | Previous runs, and what changed between them                   | Planned   |
| `qat diff`     | Compare two runs: new failures, fixed failures, timing drift   | Planned   |
| `qat diagnose` | Turn a failure into something explainable                      | Planned   |

Framework-agnostic by design, Cypress-native first: the Cypress adapter is the reference implementation, and everything
above it is meant to be unaware that Cypress exists.

---

## Architecture, in one screen

Five layers. Dependencies point one way, downward.

```
   cli ──────────────► application ──────────────► domain
   arguments,          use cases,                  types and
   output,             ports only                  pure logic
   exit codes
        │
        └── composition root: the only place that constructs an implementation

   execution/adapters/cypress · persistence · reporting · evidence
   project · config · core/filesystem · core/process · core/logging · core/errors
        └── implement a port, import domain and leaves
```

The domain imports nothing, so nothing leaks into the vocabulary. The application names capabilities rather than
implementations, so a framework can be added without editing what exists. The CLI is the only place that knows both.

One consequence worth knowing, because it shaped the first command: **detecting a project and deciding whether it may be
run are separate questions.** A directory with no framework configuration is perfectly describable and not runnable, and
a tool that can only answer the second has to refuse to answer the first — which is exactly when a reader most needs it.

Full matrix, prohibited edges, and what is enforced by lint versus by review:
[module boundaries](docs/architecture/module-boundaries.md).

---

## Engineering standards

Every one of these is a real document with a real job, not a placeholder.

| Document                                                             | Covers                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [Module boundaries](docs/architecture/module-boundaries.md)          | Layers, permitted and prohibited dependencies, the composition root      |
| [Error model](docs/architecture/error-model.md)                      | Codes, categories, recoverability, exit-code mapping                     |
| [Project discovery](docs/architecture/project-discovery.md)          | Which project a command is working on, and when a condition blocks a run |
| [Validation](docs/architecture/validation.md)                        | Per-operation readiness, the rule table, the supported-layout policy     |
| [Decision records](docs/architecture/adr/adr-index.md)               | Why the architecture looks the way it does                               |
| [Code standards](docs/development/code-standards.md)                 | Lint rules, severity policy, suppression rules, formatting               |
| [Testing standards](docs/development/testing-standards.md)           | Layout, naming, coverage rules, and why no threshold is enforced yet     |
| [CLI commands](docs/development/cli-commands.md)                     | The command contract, argument conventions, how help is generated        |
| [CLI output](docs/development/cli-output.md)                         | Streams, the report shape, and what a `--json` consumer receives         |
| [Logging](docs/development/logging.md)                               | Levels, correlation, redaction, and the output/log split                 |
| [Continuous integration](docs/development/continuous-integration.md) | Jobs, required checks, the Node policy                                   |
| [Git hooks](docs/development/git-hooks.md)                           | What runs locally, and why it is a courtesy rather than a gate           |
| [Repository hygiene](docs/development/repository-hygiene.md)         | What enters git, what ships to npm, secret protection                    |
| [Commit convention](docs/engineering/commit-convention.md)           | Message format, types, scopes, release mapping                           |

A recurring theme in all of them: a rule that nothing checks is a suggestion. Where a rule can be a lint error, it is
one.

---

## Requirements

- **Node.js 24 LTS or later** — `engines.node: ">=24.0.0"`
- **npm 10 or later**

Windows and Linux are supported and both are exercised in CI. macOS is expected to work and is not currently tested.

---

## Development

```bash
git clone https://github.com/qinis-tech/qat-cli.git
cd qat-cli
npm ci
npm run build
npm run verify
```

`npm run verify` is the definition of a green build. It runs formatting, linting, type checking, the decision-record
index check and the test suite, in that order.

| Command                           | Purpose                                    |
| --------------------------------- | ------------------------------------------ |
| `npm run verify`                  | Everything CI runs, locally                |
| `npm test`                        | Unit and integration tests                 |
| `npm run test:e2e`                | The compiled binary, against real fixtures |
| `npm run test:coverage`           | Tests with a coverage report               |
| `npm run test:watch`              | Watch mode                                 |
| `npm run build`                   | Compile to `dist/`                         |
| `npm run lint` / `npm run format` | ESLint, Prettier                           |
| `npm run adr:new -- "…"`          | Start a decision record                    |

Contribution workflow, review expectations and merge strategy: [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Design principles

**Fail with a code, not a sentence.** Every expected failure has a permanent identifier, a category and, usually,
something the reader can do about it.

**Report, then refuse.** A command that can describe a condition does so, and lets the exit status carry the failure.
Throwing for something the user can see and fix loses the description, and a report cannot be built out of an exception.

**One decision, one record.** Architectural choices go in an ADR at the moment they are made. Records are immutable once
accepted; a reversal supersedes rather than edits, so the reasoning survives.

**Typed at the boundaries.** Anything untrusted — framework output, configuration files, JUnit XML — is parsed behind a
typed boundary. `any` is a lint error for a reason.

**Nothing fails silently.** A log write that breaks cannot take down a command; a test that asserts nothing fails lint;
a rule that only exists in a document is labelled as such.

**Boring where it counts.** Exit codes, file writes and error classification are deliberately unclever, because those are
the parts a pipeline depends on at 3am.

---

## Security

Report vulnerabilities privately via the process in [SECURITY.md](SECURITY.md). Do not open a public issue.

Two things worth knowing: log context accepts primitives only, so a caller cannot accidentally log a whole response
body; and the published package is controlled by an allowlist, verified before every release.

---

## License

[Apache](LICENSE).
