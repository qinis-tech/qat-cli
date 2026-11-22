# ADR-0011: Separate dependency assembly from the CLI entry point

Date: 2026-11-21

## Status

Accepted

## Context

The architecture as first written named `src/cli/index.ts` as the composition root. That was one file
doing two jobs, and the two jobs have almost nothing in common.

A process entry point does things **on import**: it reads `process.argv`, registers commands with the
CLI framework, installs signal handlers, and eventually sets an exit code. Module evaluation is
execution. Assembly does none of that — it constructs a logger, chooses a repository, adapts a
discovery function to its port, and returns a value.

The consequence became concrete when the prerequisites for testing the wiring were written down: an
integration test must verify the bootstrap, and the application must be instantiable without launching
a test execution. Neither is possible if instantiating the application means running the CLI. A test
would have to spawn a process — making it slow, and making it assert on terminal output rather than on
the object graph it actually wants to check — or it would have to arrange `process.argv` and mute the
process, which is testing the harness.

The import rules reinforced the problem. The boundaries document permits `src/cli/index.ts` alone to
import implementations, because assembly is what imports implementations. With assembly inside the
entry point, the permitting rule and the assembling code were the same file, and there was nothing for
the entry point to import.

Nothing has been measured, because no CLI exists yet. The decision is being made at the moment the
file would be written, which is the only point at which it costs nothing.

## Decision

We will assemble dependencies in `src/app/composition.ts`, which exports `createApplication` and has no
side effects on import.

`src/cli/index.ts` becomes a thin process boundary: it parses arguments, calls `createApplication`,
runs a command, translates a caught value into an exit code, and disposes.

Import direction is enforced rather than documented: `src/app` may import implementations, and nothing
outside `src/app` and `src/cli/index.ts` may import `src/app`.

## Consequences

**Easier**

- The wiring can be exercised by a test without launching a process, which is what makes the
  composition root testable at all. That single property is the reason for the change.
- The entry point stays small and contains only what must happen once per process: arguments, signals,
  exit code.
- Two acceptance criteria become satisfiable rather than aspirational — the bootstrap can be verified,
  and the application can be constructed without executing anything.
- The boundary rules become expressible. "`src/app` may import implementations" and "nothing else may
  import `src/app`" are both lint rules, which is stronger than a sentence in a document.
- A future second entry — a programmatic API, a test harness, a REPL — can call `createApplication`
  without duplicating the wiring or extracting it then.
- The composition root can be read on its own, without argument parsing around it, which makes "where
  does this dependency come from?" a question with a short answer.

**Harder**

- **One more directory and one more hop** for a reader tracing a dependency back to its origin.
  `src/app` says "assembly" to someone who already knows the arrangement; to someone who does not, it
  is a third place to look after `src/cli` and `src/core`.
- The entry point acquires a dependency it did not have: it must import the assembly, which imports
  implementations. The boundary rule is the same shape, but what it guards is now one level removed
  and therefore harder to see in a diff.
- Lint configuration grows in three places — `src/app` in the implementation-layer list, in the CLI's
  forbidden list, and with its own block so it keeps the alias ban. Each is an opportunity to get the
  ordering wrong, because flat config replaces rules per matching block rather than merging them.
- The split invites a third layer. Nothing in this record says where the line falls if someone
  proposes separating "application services" from "assembly" from "entry", and the answer would be
  judgement rather than structure.
- Two files change when a startup option only the entry knows about needs to reach the assembly: the
  option is threaded from `argv` into `ApplicationOptions`, and that thread is a new coupling that did
  not previously exist.
- Documentation that said one thing now says two, and every diagram naming `cli/index.ts` as the
  composition root needs correcting in the same change.

**Neutral**

- Disposal belongs to the entry point, not the assembly. The assembly returns something disposable;
  deciding when to dispose is a decision about process lifetime, and the composition root does not own
  that.
- Nothing about what is constructed changes, only where it is written down.
- Whether `src/app` should also hold command orchestration — a use case composing discovery,
  configuration and execution — is a separate question and would be a separate record.

## Options considered

| Option                                                       | Why not                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep assembly in `src/cli/index.ts`, as originally specified | One file, one place to look, and untestable without launching a process. Two acceptance criteria require the opposite, and the alternative is a test that asserts on terminal output instead of on the wiring it claims to verify                |
| Put assembly in `src/core/application`                       | Keeps it beside the ports it wires. But the application layer must not import implementations — that rule is what the whole structure rests on, and a composition root inside it would be the single exception that makes the rule unenforceable |
| `src/app` for assembly, `src/cli` for the entry              | Chosen. Two jobs, two files, and the import rules can say what each may do                                                                                                                                                                       |
| A dependency-injection container with decorators             | Replaces roughly thirty lines of explicit construction with a library, a build step and a runtime registry, and makes the wiring discoverable only by reading metadata rather than a file                                                        |
| Assemble lazily inside each service on first use             | Every service would need to know how to construct its collaborators, which is precisely the knowledge the composition root exists to centralise                                                                                                  |

## References

- `docs/architecture/application-composition.md` — lifecycle, disposal order, what a handler receives
- `docs/architecture/module-boundaries.md` — the amended composition-root section
- `src/app/composition.ts` — the assembly
- `src/core/application/ports.ts` — the contracts it wires together
