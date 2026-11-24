# ADR-0023: Read configuration from one file at the project root

Date: 2026-11-24

## Status

Accepted

## Context

A project has to be told what to do, and the telling needs a name and a place. Every tool in this ecosystem answers that
with a different convention, and the choice is one a project lives with: `.qatrc` beside `.eslintrc` and `.babelrc`; a
hidden directory like `.qat/config.json`; a key inside `package.json` like `eslintConfig` and `jest`; an executable module
like `cypress.config.ts` and `vite.config.ts`; or several candidate filenames in a precedence order.

Each of those conventions exists because it won an argument somewhere. A dotfile is terse and keeps the root tidy. A key in
`package.json` means one file to edit rather than two. An executable module allows a comment, a computed value and an
import. A precedence list lets a project keep an example beside a real file.

Three decisions already in force constrain the answer. Discovery does not ascend to a parent directory unless it is asked,
on the grounds that a command run in the wrong place should say so rather than silently report a project three levels above
— and a configuration file is the same question with the same failure. The framework's own configuration is never
evaluated, on the grounds that running a user's program to decide something about it is the wrong order of operations. And
stored paths are relative to a declared root, so nothing in a committed file embeds one machine.

Two forces pull against each other. **Convenience** says a monorepo member should inherit its root's settings, and a
developer should be able to point their machine at a different API without editing a committed file. **Determinism** says
two commands run in the same directory must read the same configuration, because the alternative is a bug report that
cannot be reproduced.

The second force has a sharper edge than it first appears. A per-developer override file is, by construction, the file that
is not in version control — so it is invisible in review, present on exactly one machine, and the natural place a
credential ends up. Any decision that creates one has to accept that the guidance "do not commit secrets" loses its only
enforcement, which is that there is nowhere to put one.

There is also a scoping question the `package.json` option answers badly. That file's whole purpose is to be extended by
other tools: npm ignores unknown keys, and a dozen tools each own a namespace inside it. A configuration file owned by one
tool needs the opposite policy — an unrecognised key is a typo — and a strictness rule cannot be scoped to a subtree
without becoming a second, weaker rule.

Nothing consumes a configuration yet. There is one supported framework, one project shape, and no released version, so
whichever convention is chosen is free today and expensive later.

## Decision

We will read configuration from one file, named `qat.config.json`, at the project root.

There is no ascent to a parent directory, no second filename for a local or personal variant, and no precedence between
candidate names. A command run in a subdirectory of a project reads that subdirectory's configuration or none at all.

The file is JSON. It is data rather than a program, so it can be read by anything without trusting the repository, and it
cannot compute a value that is not visible in the diff.

A project with no configuration file is a legitimate state: the defaults apply and nothing is reported as an error.

The filename lives in one constant, `CONFIG_FILE_NAME`, so the loader, the specification and the initialisation workflow
cannot disagree about it — and a test asserts the document names the string the code does.

## Consequences

**Easier**

- Reading a project's configuration is a lookup, not a search. Two commands in the same directory cannot disagree about
  which file they read, and no bug report can be answered with "it depends where you ran it from".
- There is no question of which file won. A hierarchy of configuration files needs a precedence rule, an explanation of
  that rule, and a way to show a user which file a value came from; none of that exists.
- No format negotiation. A JSON document is readable by every language, so a CI script or an editor integration can read
  the same file without a QAT-specific parser.
- A file that is a document can be strict. The unknown-field policy is absolute because the whole file is this tool's, and
  a key it does not recognise is either a typo or a newer version — never another tool's metadata.
- Absence being legal means the tool's behaviour with and without a configuration differs only by the defaults applied,
  which makes "works on my machine but not in CI" a much smaller set of causes.
- The secret rule has one place to live. There is no override file, so the guidance to keep credentials in the environment
  is not competing with an easier local alternative.

**Harder**

- **A monorepo member cannot inherit its root's settings.** Every package repeats what it needs or has nothing. The day a
  command wants workspace-wide settings, this decision blocks it and needs a new record rather than a flag.
- **A developer cannot point their machine at a different environment without editing a committed file.** They edit it,
  change it back, and hope they remember. That is real friction, and the alternative — an ignored local file — is where
  credentials end up.
- **A command run one directory too deep reads no configuration, and nothing says one exists above it.** This is the same
  trade project discovery makes, and it will be equally surprising to somebody who assumes tools look upward.
- **No executable configuration.** No comments, no computed values, no imports. A retry count that depends on the branch,
  or a path built from an environment variable, cannot be expressed; the workaround is to compute it outside and pass it
  in.
- **JSON gives poor diagnostics.** A malformed file reports a position and a character, not the missing comma the reader
  needs to see. A format-aware parser would say more, and this decision chooses the format over the diagnostic.
- **The file cannot explain itself.** A large `environments` block with no comments is a block whose reasons live in a
  commit message and a design document, and the reader editing it has neither.
- Changing the format later — adding YAML, say — is a breaking change rather than an additional candidate with a
  precedence rule, because there is no precedence machinery to extend.
- The filename is discoverable by anything that walks a repository looking for files by name. That is usually a benefit
  and occasionally a surprise, and there is nothing to do about it except know it.

**Neutral**

- `.qat/` remains available for generated artefacts — the execution database, evidence layouts — so the tool still has a
  directory of its own. This record is about the input file, not about everything named qat.
- The file is at the root and not inside the hidden directory, which means a project has one visible new file rather than
  a hidden tree. Both are conventions; this one is easier to find and to point at in review.
- The specification's field table is checked against the schema, and the filename is checked against the document, so the
  cost of renaming either later is a failing test rather than a silent divergence.
- Nothing about this decision is visible to a user until a command reads a configuration, which is the first time any of
  the consequences above can be observed.

## Options considered

| Option                                                                | Why not                                                                                                                                                                                                                                |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.qatrc`                                                              | The Node convention, and a file with no extension or `type` field is read by different tools as JSON, YAML or JavaScript depending on the parser. That ambiguity is the thing this decision exists to remove                           |
| `.qat/config.json`                                                    | Groups the input with generated output, so a reader looks at the root for configuration and inside `.qat/` for artefacts and finds neither where they expected                                                                         |
| A `qat` key inside `package.json`                                     | No extra file, and it puts this tool's configuration into a document a dozen other tools also edit, where the strictness policy cannot apply: an unknown key beside it belongs to somebody else, and an unknown key under it is a typo |
| `qat.config.{js,ts,mjs}`                                              | Comments and computed values, at the cost of executing the file to read it — the same refusal ADR-0008 makes about a framework's configuration, applied to a file this tool owns                                                       |
| Ascend to the nearest configuration at or above the working directory | Convenient for monorepos, and it means a command run in the wrong place silently reads settings from a project the reader did not know they were inside. The project-root search already refuses this                                  |
| A gitignored local override beside the shared file                    | Where credentials land. A file that is not in review and exists on one machine produces failures nobody else can reproduce, and it removes the only enforcement the secret guidance has                                                |
| A precedence list of candidate filenames                              | Every candidate is a file somebody has to check for, two present at once is an ambiguity with no defensible resolution, and it is the same reasoning that refuses two framework configurations                                         |

## References

- `docs/architecture/configuration-format.md` — the file, its fields, its examples and its secret guidance
- `docs/architecture/configuration-schema.md` — what may be inside the file, and why each rule exists
- `src/config/contracts.ts` — `CONFIG_FILE_NAME`, the one place the filename is written
- ADR-0008, which refuses to execute a configuration file to read it, and is the reason this one is JSON
- ADR-0009, which prefers an environment variable over a configuration file value and is where a per-machine setting belongs
- ADR-0016, which fixed the working-directory precedence on the same principle: being wrong loudly beats being helpful unexpectedly
- ADR-0023, which makes the unknown-field policy possible by treating the whole file as this tool's
