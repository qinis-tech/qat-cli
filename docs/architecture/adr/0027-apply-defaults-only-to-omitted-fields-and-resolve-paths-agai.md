# ADR-0027: Apply defaults only to omitted fields and resolve paths against the project root

Date: 2026-11-24

## Status

Proposed

## Context

QAT now has a configuration file of its own — `qat.config.json`, JSON, at the project root, versioned and validated by a
schema that rejects unknown fields. Six fields exist. Two are required (`version`, `framework`); four are optional
(`output.reports`, `output.evidence`, `environments`, `defaultEnvironment`, `cypress.configFile`).

Three facts about how the tool is run forced a decision about what happens when those optional fields are missing.

**It is run from wherever a person or a job happens to be.** A shell in the repository root, a CI job whose working
directory is the checkout, an editor task runner that starts in the file's directory, a monorepo where the same project is
reached from two levels up. A relative path resolved against the process working directory therefore produces a different
answer for the same file and the same project. Absolute and unpredictable is the worst pair: nothing warns you, and the
second run's output is somewhere the first run's reader will not look.

**A plausible default can be worse than an error.** The absent fields are not equivalent. A default for `output.reports`
saves a line of setup. A default for `framework` would let the tool assume what it is driving, and a default for a
framework's base URL would point a passing suite at the wrong environment — the most expensive failure this product can
produce, because nothing reports it.

**Documentation and code had already started to disagree.** Defaults were described in prose while being applied, or not,
in more than one place. A reader who checked two modules got two answers and no way to tell which one a run used.

Prior decisions constrain the answer. Environment variables outrank the file (ADR-0009), so defaults must rank below both.
A configuration file that exists and cannot be read is a failure and never a reason to run with defaults (ADR-0025), so
defaulting cannot be a fallback for an unreadable file. Framework configuration is not evaluated during discovery
(ADR-0008). A positional directory argment is preferred over the working directory (ADR-0016), and the same reasoning is
what makes the process working directory an unacceptable anchor for a configured path.

## Decision

We will resolve configuration as a function of two inputs — the document and the project root — and of nothing else.

Defaults fill only fields the user omitted. A field is omitted when its value is `undefined`; `false`, `0` and `""` are
values somebody typed and are never replaced. A default is applied by the stage that owns the value: the schema supplies
the values of the fields it declares defaultable, and the resolution stage derives the one value that cannot be a
constant. Each default has one authority and one catalogue entry stating its value and the reason for it.

Configured paths are anchored to the project root, never resolved against the working directory. A relative path is joined
to the root; an absolute path keeps its location but must still satisfy the field's policy. Output directories must be
relative and inside the project. Directories are created by the operation that first writes to them, never during
initialisation.

Four fields are deliberately left without a default and say so in the catalogue: `version`, `framework`,
`cypress.configFile` and `defaultEnvironment`. The last is derived rather than fixed — an environment named `default`,
else the only one declared, else none — because choosing a run's target is a decision about a run.

## Consequences

**Easier**

- A valid configuration is two fields. Everything else has a documented answer.
- The same project resolves to the same absolute paths from any working directory, on any machine.
- The published defaults table is generated from the catalogue the runtime reads and compared against it by a test, so
  documentation cannot describe a default the tool does not apply.
- A refused path produces a diagnostic that names the field, the resolved location and the root it was measured against,
  and the reader can act on it without reading source.
- Adding a default is one constant, one catalogue row, one regenerated table and one test — the shape of the change is
  fixed, which is what keeps the table honest as the schema grows.
- Diagnostics quote the value the reader wrote, not a normalised form of it, so a trailing space or a doubled separator
  is visible in the message that complains about it.

**Harder**

- Two stages now touch a defaulted value. The schema fills `output` while parsing, and the resolution stage re-applies the
  same values idempotently so that the last stage to run holds the last word on precedence. That is safe only while no
  defaulted field is also settable from the environment. If one ever is, the environment overlay must move before parsing,
  and nothing in the type system will say so.
- A caller must learn the wrapper: a successfully loaded configuration is `config.document`, not `config`, because the
  loaded value is branded to make "defaults over a file that never loaded" impossible. That is one property access and one
  new shape to know.
- Refusing absolute output paths removes an escape hatch. A CI job that wants reports on a mounted artefact volume outside
  the workspace cannot configure one; it must arrange a symlink or accept the project-relative location. That is a real
  constraint on a legitimate use, accepted because the alternative lets a typo write into a colleague's directory.
- A derived default environment moves a failure later. A project that declares two environments and no default is a valid
  file and an unusable run; it fails at the point a command needs a target rather than at the point the file is read.
- Default output paths are two segments deep (`results/reports`), so the directory helper must create parents. A
  single-level `mkdir` would fail on the first real run and pass every test that used a single-segment path.
- Every new field owes a catalogue entry, and the coverage test compares the catalogue against the schema's field list in
  both directions. That is cheap per field and non-negotiable, which means a schema change is never a one-file change.

**Neutral**

- Initialisation still creates one file and nothing else. The output directories appear when a run first has something to
  write, so a project that has been set up but never run contains exactly its configuration.
- Resolution is synchronous and pure. No caller gained an `await`, an error path or a timeout; it did gain a function that
  cannot touch the disk, which is what makes it cheap enough to run on the discovery path and to test exhaustively.
- An absent `environments` map and an empty one remain equivalent to every consumer, so nothing had to choose between them.
- The process working directory is still the _default_ working directory for a command; it is simply not an input to path
  resolution once a project root is known.

## Options considered

| Option                                                         | Why not                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apply defaults in the loader, as part of reading the file      | The loader cannot know the project root, and defaults must rank below environment overrides that are merged after reading. A value filled at read time would have been indistinguishable from one the user wrote                                                           |
| Let each consumer default what it needs                        | Two commands would disagree, and the documentation would describe whichever implementation its reader happened to open                                                                                                                                                     |
| Resolve configured paths with `path.resolve()`                 | It anchors to `process.cwd()` as a hidden third argument: same file, two locations, and the difference is silent                                                                                                                                                           |
| Allow absolute output paths, validated as inside the project   | It reads as a feature and behaves as a trap: the value cannot travel between machines, and the containment check is the only thing standing between a typo and somebody else's directory. Refused instead, with the check kept in the resolver as a second line of defence |
| Create the output directories during initialisation            | Leaves empty directories in a project that never ran, adds them to every diff, and survives a setup that failed halfway                                                                                                                                                    |
| Default `defaultEnvironment` to the first declared environment | Points a run at an arbitrary target. A passing suite against the wrong environment is worse than a refusal, because it produces results nobody has reason to doubt                                                                                                         |
| Default `framework` to the only supported framework            | Correct today and wrong the day a second framework exists: every configuration written before that day would silently mean the first one                                                                                                                                   |

## References

- ADR-0008 — do not evaluate the framework configuration during discovery
- ADR-0009 — prefer environment variables over configuration file values
- ADR-0016 — prefer the positional directory over the working directory of the process
- ADR-0025 — never fall back to defaults for a configuration file that exists and cannot be used
- `docs/architecture/configuration-defaults.md` — the defaults table, generated from the catalogue
- `docs/architecture/path-resolution.md` — anchoring, containment and portability rules
- `docs/architecture/configuration-precedence.md` — the four-level chain this decision sits at the bottom of
- `docs/architecture/configuration-loading.md` — the six outcomes, and the branded document a successful load returns
