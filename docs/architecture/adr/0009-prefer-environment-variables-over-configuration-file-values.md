# ADR-0009: Prefer environment variables over configuration file values

Date: 2026-11-21

## Status

Accepted

## Context

A configuration value can arrive from four places: a command-line flag, an environment variable, a
project configuration file, or a built-in default.

Two of the four are uncontroversial. A flag wins because it was typed for this invocation and
nothing else can be more deliberate. A default loses because nobody chose it. The disagreement is
between the middle two, and both orders exist in widely used tools.

The two sources differ in ways that matter. A project configuration file is committed, shared across
a team, and changed through review; it describes intent over time. An environment variable is set in
a shell, a CI job, or a container definition, and describes intent for one run on one machine. It is
not reviewed, it is often not recorded anywhere, and it may be inherited from a parent process that
the developer never considered.

The practical question that decides the order: **what is the mechanism for changing one committed
setting for one run, without editing the file and pushing a commit?** If the answer is "there is
none", then a CI job that needs a different output directory, or a container that must point at a
different base URL, has to fork the configuration.

The project has already answered this question once, for log level: `resolveLogLevel` reads the flag,
then the environment, then a default. A different order for other settings would mean the tool has
two precedence rules, which is a defect in its own right.

Nothing reads a configurable value yet. The decision is made before the pain, which is the only time
it is cheap.

## Decision

We will resolve a configuration value from the flag, then the environment variable, then the
configuration file, then the built-in default — in that order, uniformly, for every setting.

The resolver reports which source supplied the value, so "why is it using this?" is answerable from
its output rather than re-derived by reading four places.

A flag is never overridden by anything. That remains the escape hatch for anyone who needs
certainty about what a run will use.

## Consequences

**Easier**

- A committed setting can be overridden for one run without editing it and pushing a commit, which
  is the only thing that makes a shared configuration usable across a team, a CI job and a
  container.
- No secret has to be committed to the file. A token supplied by the pipeline overrides whatever
  placeholder the file contains.
- The tool has one precedence rule rather than one per setting, because log level already behaves
  this way.
- Precedence is testable without a filesystem: pass a source object, assert which level won.
- The resolver's reported source makes the effective configuration auditable in a diagnostic output,
  which is what makes the costs below survivable rather than invisible.

**Harder**

- **The committed file stops describing what actually runs.** Someone reading the configuration
  sees a value that may not be in effect. This is the central cost: configuration files stop being
  documentation, and the file becomes one input among several rather than the answer.
- **A variable set for one purpose silently changes another.** CI configurations commonly export
  broad variables, and a name that collides for an unrelated reason changes behaviour with no
  review, no diff, and no record. This is the failure mode most likely to happen in practice and
  the hardest to see.
- Reproducing a CI failure locally requires knowing the environment that produced it, which is
  invisible unless something displays the resolver's source. The source field helps only if
  something shows it.
- Environment values arrive as strings and are not validated when configuration is loaded. A
  malformed variable fails at the point of use, which is later and further from the cause than a
  malformed file value.
- Anything in the process's ancestry can set a variable. The set of things that can change behaviour
  is therefore larger than the set of things that can change the repository.
- The order is one more thing to teach, and a reader's expectation is genuinely a coin flip: the
  opposite order is common enough that a stated order will sometimes be assumed rather than read.

**Neutral**

- The order is written down in a specification and reported by the resolver, so the risks above are
  mitigable by anyone who reads output. That is a weaker guarantee than making them impossible, and
  it is the trade being accepted.
- A flag is never overridden, so a caller who needs determinism has one.
- An empty environment variable is treated as absent by the resolver rather than parsed. That is a
  separate judgement from this one, documented in the precedence specification, and it deserves its
  own record if it is ever disputed.

## Options considered

| Option                                                        | Why not                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flag, then configuration file, then environment, then default | The other common order, and it makes the committed file authoritative. Rejected because it leaves no override mechanism that does not require editing and pushing: the environment would only matter where the file said nothing, which is not an override |
| Flag and environment only, with no configuration file         | Unambiguous and entirely visible in one place per run. Rejected because a project genuinely needs committed, shared settings — spec patterns, suites, output directories — that a team agrees on once                                                      |
| Configuration file only, with the environment ignored         | The most reproducible and the least surprising to a reader of the file. Rejected because it removes the standard mechanism a CI job or a container uses to adjust one value for one run, and that mechanism exists because the need does                   |
| Flag, then environment, then file, then default               | Chosen. Narrower scope wins, and the environment is the narrowest source that is still shared with a process rather than typed by hand                                                                                                                     |
| Ask the user which order to use                               | A configuration setting for how configuration is read. Two teams on the same project would then have different behaviour, and the first bug report would be about the setting rather than about the tool                                                   |

One refinement is worth recording as considered but not adopted: **requiring every variable to carry
a `QAT_` prefix**. It would eliminate most of the collision risk described above, and the diagnostic
snapshot already defaults to that prefix. It is not enforced today because no setting reads a
variable yet, and imposing a naming rule before there is a name to impose it against would set a
precedent without evidence. It is the first thing to revisit when the first real setting is wired
up.

## References

- `docs/architecture/configuration-precedence.md` — the specification, including the empty-value judgement
- `src/core/environment/precedence.ts` — the resolver
- `src/core/environment/variables.ts` — presence-aware variable reading
- `resolveLogLevel` in `src/core/logging/levels.ts`, which already uses this order
- The twelve-factor treatment of environment-based configuration, as the most widely cited prior art for the chosen order
