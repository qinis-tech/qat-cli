# ADR-0036: Inspect the Cypress configuration as data and never import it

Date: 2026-11-26

## Status

Accepted

## Context

A Cypress configuration is executable code. `cypress.config.ts` declares `defineConfig`, but nothing prevents it from
importing a helper, reading `process.env`, starting a client, or throwing at module scope — and in real repositories it
does all four. Any tool that wants to say something about that file therefore has to choose what it is allowed to do to
it, and the choices are not equivalent.

Three needs meet here, and they pull in different directions.

**The report has to be useful for a real TypeScript project.** Which is nearly every Cypress project written since
version 10. If the answer to "is my configuration valid?" is "we cannot tell" for all of them, the check earns its place
only by catching the handful that use JSON.

**The report has to be safe on a repository nobody has reviewed.** It runs as a diagnostic, on a developer's machine and
in CI, over a checkout that may be hostile. Importing a file to inspect it means running that file's top-level code with
whatever privileges the doctor has. The consequence is not theoretical: a configuration that reads a token from the
environment and prints it in an error path would put that token into a report, and a configuration that blocks on a
network call would hang the command that was meant to explain a problem.

**The report must not lie.** A configuration can be perfectly readable text and still fail to load — an unresolved import,
a missing dependency, a syntax error the runtime rejects but a regex accepts. Reporting such a file as "valid" because we
decided not to look is worse than reporting nothing, because the user stops looking.

The existing architecture already draws a related line: detection probes _names_ at the project root and deliberately never
reads contents, which is why it can tell you a configuration exists but not whether it is usable. Everything below it —
permissions, symlinks, emptiness, decodability — needs bytes, and the decision was where those bytes are allowed to go.

## Decision

We will inspect the Cypress configuration as **data**, and delegate the only evaluation to the tool that will run it.

Concretely, validation is a ladder of three tiers, and each tier is allowed to claim exactly what its mechanism
establishes:

- **T0, text.** Non-empty, faithfully decodable UTF-8, within a read budget. Says nothing about syntax; catches the
  truncated, binary and whitespace-only files that bad merges produce. Establishes invalidity never, and a gap always.
- **T1, parse.** `JSON.parse` plus a top-level shape check, for a `.json` carrier. Terminal and definitive: a parser
  cannot be wrong about a syntax error, and nothing is executed.
- **T2, load.** The project's own Cypress CLI, invoked with a single `config` argument through the project's Node binary,
  with no shell, a hard 60-second timeout, capped output, and only when the run explicitly asked for depth. The project's
  loader is the only authority entitled to evaluate an executable configuration.

Anything the ladder cannot establish is reported as `indeterminate` — a first-class outcome that is neither a pass nor a
failure and that no aggregation may count as clean.

The tool itself will never `import`, `require`, `eval` or `vm` the configuration. It reads bytes, it parses JSON, and it
runs a bounded subprocess.

## Consequences

**Easier**

- The default path is instant, offline and side-effect free. `qat doctor` on a large repository costs one `stat`, at most
  one bounded read, and no process.
- The honest answer is cheap to give. "Readable text; syntax not validated" is a sentence the ladder can produce in a
  microsecond, and it tells a reader exactly how much to trust the rest of the report.
- Tests drive every state from literals. Unreadable, oversize, binary, escaping symlink, a loader that times out, a loader
  that prints 900 characters of stack trace — each is an object, not a temporary directory.
- Credentials in a configuration cannot reach a report through this path, because no finding carries file content: the
  failures are described by kind and line, and the raw loader message stays on the verdict for a live terminal.

**Harder**

- A TypeScript project's configuration is reported as _not validated_ by default. That is a weaker answer than a user
  might expect from a tool whose job is diagnosing configuration, and it will be read as a gap in the product by some.
- Two mechanisms now exist for the same question, and the boundary between them has to be maintained: T1 must stay
  terminal so a JSON file never reaches T2, and T2 must stay opt-in so a default run never executes project code.
- A configuration that is valid JSON but wrong in shape gets a _shape_ failure rather than a syntax failure, and the two
  need distinct messages. Collapsing them sends a reader hunting for a comma that is not the problem.
- Testing the deep tier for real needs a Cypress installation and a process, so the honest coverage for `QAT-H028` is a
  scripted probe plus a fixture-driven case. That is a permanent asymmetry between what the deep tier can claim and what
  the suite can prove about it.
- The opt-in creates a second way to run the command, and options multiply: `--deep` today, whatever bounds it next. Each
  one has to default to the safe answer, which is the one that says less.

**Neutral**

- The loader's own message is not carried into the finding; both remediations point at `npx cypress config` so the reader
  can see it themselves. That moves a decision to the reader rather than a piece of text into a report, which is neither
  better nor worse in general and is better here.
- Findings carry no structured evidence — the diagnosis code is the detail. Eleven location reasons and two validation
  codes exist precisely so that this substitution is possible.
- Which tier spoke is recorded on the verdict. It is not a consequence of this decision so much as a thing the decision
  makes necessary: a reader comparing two reports needs to know whether a parser or a loader gave the answer.

## Options considered

| Option                                                                      | Why not                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compile the configuration with TypeScript and report what the compiler says | Adds a large runtime dependency for a diagnostic, and compiling is not loading: a type-correct file can still throw on import, so it would answer a narrower question with more machinery                            |
| `import()` the file in a worker and catch the error                         | A sandbox strong enough to be worth claiming is a project in itself, and a weak one is a security claim we cannot defend. It also runs project code on every default run, which is the thing we most wanted to avoid |
| Regex heuristics — brace balancing, `export default` presence               | Confidently mislabels valid files. A false "invalid" on a working project is the one outcome that makes a diagnostic untrustworthy                                                                                   |
| Ask the user to run `npx cypress config` and paste the result               | Puts the work back on the person asking for help, and produces output we then have to parse without any of the containment this decision provides                                                                    |
| Always run the loader, bounded                                              | Makes executing project code the default, which contradicts the read-only promise of every other check and would put a process in front of users who only asked whether a file exists                                |

## References

- [Cypress CLI: `cypress config`](https://docs.cypress.io/app/references/command-line) — the mechanism T2 delegates to.
- [diagnostics.md](../diagnostics.md) — the outcomes a finding may carry, and why `indeterminate` is one of them.
- [doctor-checks.md](../doctor-checks.md) — the catalogue, and the codes this decision produces.
- ADR-0032, _Skip a check whose precondition failed rather than reporting its consequence_ — the rule that makes
  "nothing was located" a skip on validity rather than a second finding.
