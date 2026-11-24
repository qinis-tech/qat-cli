# ADR-0025: Never fall back to defaults for a configuration file that exists

Date: 2026-11-24

## Status

Accepted

## Context

Reading a configuration file is a sequence of things that can fail: the file may not be there, it may be unreadable, it
may not be JSON, or it may be JSON that is not a configuration. A loader has to do something with each of those, and the
shortest implementation of all of them is five lines:

```ts
try {
  return parse(await readFile(path, "utf8"));
} catch {
  return DEFAULTS;
}
```

It is short because it collapses every failure into one answer, and it is tempting for a reason that is not laziness:
a tool that always runs is more pleasant than a tool that refuses, and the person who wrote those five lines was
optimising for the run continuing. In a continuous-integration job the difference is between a pipeline that goes red on
a stray comma and one that keeps going.

What that code does, though, is produce a run whose settings are a mixture nobody can reconstruct afterwards. Some fields
came from the file, some from the defaults, and nothing anywhere says which — not in the output, not in the result
document, not in the exit status. The run is indistinguishable from one where the file was read correctly and happened to
say the same things. When the reader eventually asks why their configured output directory was ignored, there is no
evidence, because the ignoring left none.

The project has already decided most of the surrounding questions, and the remaining one is narrow.

Absence of a configuration file is legal — ADR-0024 established one file at the project root and no search, and made it
clear that a project which has never been configured is ordinary. Absence is reported as a result rather than a failure —
ADR-0025 — so a caller can apply the defaults without catching anything. Neither of those decisions says what to do when
the file _is_ there and cannot be used, which is the gap this record fills.

The schema applies defaults too, and that must not be confused with the fallback above. A file that parses and validates
gets defaults for the fields it omits; that is the format working as documented, and it is what makes a two-field
configuration legitimate. The distinction this record turns on is not "defaults or not" but **whether the file could be
read at all**.

There is a pull in the other direction that is easy to dismiss and should not be. A team whose configuration is generated
by another tool, or edited on a branch by three people, will occasionally have a file that fails to parse at the moment
somebody runs a command. Failing outright means they can do nothing until they fix it. Some would prefer a warning and a
run with defaults, and that preference is not unreasonable — it is a different trade, not a mistake.

Nothing consumes a configuration yet, so the cost of this decision is unmeasured and the temptation to relax it later will
be strongest at the first report of a broken pipeline, which is exactly when relaxing it would be most expensive.

## Decision

We will treat a configuration file that exists and cannot be used as a failure, carrying a reason and no configuration.

The load result has six outcomes and only one of them — `loaded` — carries a `config`. The other five carry a reason and
nothing else, so a caller cannot read a defaulted configuration by accident: the type does not offer one.

Defaults remain in two places and neither is a fallback. A project with **no** configuration file gets the documented
defaults, because absence is legal and is reported as a result. A file that parses and **validates** gets defaults for the
fields it omits, because that is what the schema is for. A file that does not parse, or does not validate, gets a failure.

No flag exists to relax this. There is no `--force`, no "use defaults and warn", and no environment variable that turns a
broken file into a warning, because the first such flag would be left set in a pipeline where nobody remembers adding it.

## Consequences

**Easier**

- A run's settings are either the ones in the file or the ones in the documented defaults, and never a mixture. When
  somebody asks why a setting was ignored, the answer is either "it parsed, and it said that" or "it did not parse, and the
  failure names the line".
- A broken configuration fails identically on every machine. A fallback makes the failure depend on which machines have
  the file, which is the shape of bug that reproduces for one person and never for the other.
- The type is the rule. Only `loaded` has a `config`, so a caller cannot read a defaulted one without writing a branch that
  visibly invents it.
- Defaults have one authority. The schema applies them, in one place, to fields that were omitted — rather than two places
  applying them to two different situations.
- A continuous-integration failure names a line and a column, which is a five-second fix, instead of a green build whose
  behaviour nobody can account for.
- The distinction between "you have no configuration" and "your configuration is broken" survives all the way to the
  reader, because they are different outcomes with different remedies.

**Harder**

- **There is no degraded mode.** A user with a half-edited configuration can run nothing until they finish editing it. Every
  workflow that would want to proceed anyway — a migration script, a bootstrap command, a first-run experience — has to be
  invented deliberately later, with its own record, rather than arriving as an accident of a `catch` block.
- **A pipeline that could have limped now stops.** Some teams would genuinely prefer a run with slightly-off settings to no
  run at all, particularly on a branch where the configuration is being changed. This record decides against them on their
  behalf, and their workaround will be to fix the file quickly or to stop using the tool.
- **The type stops one caller, not the pattern.** Nothing prevents
  `result.kind === 'loaded' ? result.config : DEFAULTS` two layers up, which is the forbidden behaviour with more ceremony.
  The decision is per-call-site as much as it is per-loader, and the loader can only make the wrong version visible.
- **Editing a configuration becomes a stop-the-world event.** With a warning-and-continue, an invalid file would be a
  nuisance; now it blocks. The documentation has to say so, or the first person to hit it will read it as the tool being
  fragile.
- **Two kinds of default sit one sentence apart and read alike.** "Defaults for omitted fields" and "defaults for a broken
  file" are opposite decisions, and a reader skimming will conflate them. The failure message has to make the difference
  visible, and every future summariser of this record will have to repeat it.
- **Nothing consumes it, so the cost is unmeasured.** The absence of a graceful path will be felt at the first broken
  pipeline, which is the moment a relaxation would be agreed under pressure and least carefully.

**Neutral**

- No new error code. A broken file produces a load _result_, and the command that cares maps it to its own status — which
  for a configuration problem is the invalid-input category the exit-code contract already has.
- The schema's defaults are unchanged, and so is the behaviour of a project with no file at all.
- Empty is treated as broken rather than as absent, which is the one place the "does the file exist" line could have gone
  either way. An empty file exists; reporting it as absent would hide the fact that something wrote it.
- The decision is about a file being _unusable_, not about a file being _wrong_. A configuration that parses and validates
  but names a directory that does not exist is a different problem, belonging to whichever command uses that directory.

## Options considered

| Option                                                                 | Why not                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Return defaults on any failure, with a warning on standard error       | The warning is on a stream a pipeline does not read, and the run proceeds with settings nobody chose. The mixture is the problem, not the silence                                               |
| Return defaults only for syntax errors, and fail for schema violations | Arbitrary. Both mean the file and the tool disagree about what was asked, and the reader's next step is the same: open the file                                                                 |
| Return defaults but record the failure in the result                   | Better, and still produces a run whose settings the reader did not write. A `config` field on a failure variant invites exactly the read this decision exists to prevent                        |
| Refuse to run, with a `--force` flag that uses defaults                | Defensible and premature. It adds a flag for a workflow nobody has asked for, and the flag is the one that gets left in a pipeline where the configuration has been broken for a month          |
| Fail only when the file is newer than the tool understands             | That is already the unknown-field and version policy from ADR-0023, which refuses rather than partially honouring. This record is not about _which_ failures, but about what a failure produces |
| Treat a broken file as an absent one, and apply defaults               | Collapses "your configuration is broken" into "you have no configuration", which sends the reader to check whether the file exists rather than what is wrong with it                            |

## References

- `docs/architecture/configuration-loading.md` — the six outcomes, the parse location, and the known limits
- `src/config/loader/contracts.ts` — the union, in which only `loaded` carries a `config`
- `src/config/loader/load.ts` — the classification, and the one call into the schema
- ADR-0023, which refuses an unrecognised configuration field rather than partially honouring the file — the same position, applied one layer down
- ADR-0024, which established one configuration file at the project root and made absence legal
- ADR-0025, which made absence a result rather than a failure, and is the reason "no file" and "broken file" can be told apart
- ADR-0004, which categorised exit codes and gives a configuration problem a status without a new one being needed
