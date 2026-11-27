# Cypress configuration checks

Two health checks answer the question a broken Cypress project most often asks: _is my configuration the
problem?_

| Check                               | Category                | Identifies                                                                 |
| ----------------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| `cypress.configuration-located`     | `cypress-configuration` | Can exactly one configuration file be found, and is it usable as a file?   |
| `cypress.configuration-validatable` | `cypress-configuration` | Can anything establish that the file is valid, and if so, what did it say? |

They are two checks rather than one for the reason the catalogue gives for its runtime pair: the second has a
**precondition** on the first. A located file can be provably invalid; it can also answer nothing at all because no
mechanism was entitled to speak. One identifier would have to carry two remedies and would hide which of the two
answered.

Both declare `severity: error`. Both also conclude as **warnings** for the conditions a project can run with — a legacy
format, a stale copy in the wrong place, a file nothing inspected. One declared severity, a status decided by which
condition fired; that is what `CheckSeverity` and `CheckStatus` are separate for.

## What these checks do not cover

- **Configured paths** — `fixturesFolder`, `specPattern`, `supportFile`. A different question with a different check
  (`cypress-configuration-paths`, ADR-pending). This document says nothing about them.
- **Adapter compatibility** — whether the installed Cypress release is one QAT will drive. That is
  `cypress.version-supported` and the version policy.
- **QAT's own configuration** — `qat.config.json` is a separate, versioned document with its own checks. Nothing here
  reads it.
- **Whether the project can run** — a project with a perfect configuration and no installed Cypress is fine by these
  two checks and blocked by others. Each condition gets one owner.

## Where the evidence comes from

```
project root
   │
   ├─ cypress-detection      one probe of the tree → CypressDetection
   │                          (verdict, configurations, unsupportedConfigurations, layout)
   │
   ├─ gatherer               inspectConfiguration(detection, facts)      → ConfigDiscovery
   │                         validateConfiguration({projectRoot, …})    → ConfigValidation
   │
   └─ checks                 pure: verdict + code + sentence
```

Three rules hold that shape together.

**Detection does not read file contents.** It probes _names_ at the project root and reports a verdict. Whether a file can
be opened, whether it is a directory, whether a symlink escapes the project — all of that needs bytes, and putting it in
detection would make a name probe responsible for reading a stranger's file.

**The gatherer decides, the checks translate.** `evaluate(facts)` is synchronous by type, so a check cannot await a
probe or open a file. It receives two decided verdicts and produces a code and a status. This is why the whole scenario
matrix is testable with literals.

**One capture, two verdicts.** Both checks read `facts.cypressConfiguration`, which holds the location verdict and the
validation verdict from a single capture of a single file. A second read would be a second answer that can disagree with
the first.

## The location verdict

`ConfigDiscovery` is a discriminated union of thirteen reasons. `FOUND` and `NOT_APPLICABLE` produce no finding; the other
eleven map to one code each, because each has its own remedy.

| Reason                            | Code       | Status | The fix                                                                                                         |
| --------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| `CYPRESS_CONFIG_FOUND`            | —          | passed | Nothing                                                                                                         |
| `CYPRESS_CONFIG_NOT_APPLICABLE`   | —          | passed | Nothing: not a Cypress project                                                                                  |
| `CYPRESS_CONFIG_MISSING`          | `QAT-H018` | failed | Create one — with a clause that distinguishes "nothing here is Cypress" from "Cypress is here but unconfigured" |
| `CYPRESS_CONFIG_AMBIGUOUS`        | `QAT-H019` | failed | Delete all but one; never a guess about which                                                                   |
| `CYPRESS_CONFIG_UNSUPPORTED_NAME` | `QAT-H020` | failed | Rename to `cypress.config.ts` (or `.js` / `.mjs` / `.cjs`) at the root                                          |
| `CYPRESS_CONFIG_MISPLACED`        | `QAT-H021` | warned | Move it out of `cypress/` to the root                                                                           |
| `CYPRESS_CONFIG_PATH_OCCUPIED`    | `QAT-H022` | failed | Remove the directory occupying the path                                                                         |
| `CYPRESS_CONFIG_NOT_A_FILE`       | `QAT-H022` | failed | Replace it with a regular file                                                                                  |
| `CYPRESS_CONFIG_OUTSIDE_PROJECT`  | `QAT-H023` | failed | Keep the target inside the project                                                                              |
| `CYPRESS_CONFIG_UNREADABLE`       | `QAT-H024` | failed | Fix the permission or the lock                                                                                  |
| `CYPRESS_CONFIG_EMPTY`            | `QAT-H025` | failed | Write the configuration, or regenerate it                                                                       |
| `CYPRESS_CONFIG_LEGACY_FORMAT`    | `QAT-H026` | warned | Migrate to `cypress.config.ts`                                                                                  |
| `CYPRESS_CONFIG_NOT_INSPECTED`    | `QAT-H027` | warned | Report it: this is QAT having no opinion                                                                        |

Two pairs share a code because they share a remedy: a directory sitting on a configuration path and an entry that is not a
regular file both end in "put a regular file there". Everything else is one code per sentence.

### Why two configuration files is an error, not a warning

Cypress refuses to start when more than one configuration file is present. Reporting a warning would contradict the tool
we are diagnosing, and silently preferring one would decide which file the next `install` rewrites. The finding names
every file and stops.

### Why a directory on the path gets its own condition

A file probe cannot see it, so every layer below reports "no configuration found" — correctly — and the reader is told to
create a file that cannot be created. `PATH_OCCUPIED` exists solely to make that case actionable, and it is the one fact
that turns a baffling absence into a one-line fix.

## The validation ladder

Validation is ordered by cost and by what each tier is entitled to claim.

| Tier         | What it does                                                  | What it establishes                                                                        | Cost                 |
| ------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------- |
| `T0-text`    | Non-empty, faithfully decodable UTF-8, within the read budget | Nothing about syntax; catches truncated, binary and empty files                            | No process, no parse |
| `T1-json`    | `JSON.parse` plus a top-level shape check                     | **Definitive**, for a `.json` configuration. A parser cannot be wrong about a syntax error | No process           |
| `T2-cypress` | The project's own loader, invoked once, bounded               | Definitive for an executable configuration, because only Cypress can evaluate one          | One process, ≤ 60 s  |
| —            | Nothing was attempted, or nothing was entitled to speak       | Nothing                                                                                    | —                    |

`T1` is terminal: a JSON configuration is never handed to the loader afterwards. `T2` never runs unless deep validation
was explicitly enabled.

### Outcomes

| Reason                         | Code       | Status                                                    |
| ------------------------------ | ---------- | --------------------------------------------------------- |
| `CYPRESS_CONFIG_VALIDATED`     | —          | passed                                                    |
| `CYPRESS_CONFIG_INVALID`       | `QAT-H028` | failed — **only** when a mechanism established invalidity |
| `CYPRESS_CONFIG_NOT_VALIDATED` | `QAT-H029` | warned                                                    |

The one code for "not validated" covers six causes — deep validation off, no loader available, a probe timeout, text that
is not UTF-8, a file beyond the read budget, no text established at all — because they share one remedy: get a mechanism,
then ask again. The cause still decides the sentence, because "off by default" and "timed out" are different mornings for
whoever debugs it.

**Deep validation disabled is a warning, not a pass.** A healthy TypeScript project with deep mode off would otherwise
show this check as green, which claims a verification that never happened. One line of output — "not checked; enable deep
validation" — is the honest middle.

## The disclosure rule: the configuration is never quoted

A Cypress configuration routinely holds credentials under `env`. A loader's failure message can embed a code frame, and a
code frame is file content. So:

- findings carry the **kind** of failure (`syntax`, `shape`, `load`) and the **line** — never an excerpt, never the
  loader's raw message;
- the raw message stays on `ConfigValidation.failure.message` for a live terminal, and both remediations point at
  `npx cypress config` so the reader can see it themselves;
- the file is never rendered into logs, JSON output or a persisted diagnostic session.

This is not caution about a rare case. It is the same rule the configuration layer states for its own document, applied
to a file more likely to hold secrets.

## Two boundaries enforced at the port

**Local resolution only.** The configuration is found by probing the project root, and a symlink is resolved exactly once
and checked against the project boundary. A link that resolves outside the project is `OUTSIDE_PROJECT` — reported, not
followed. A repository must not be able to point a diagnostic at a file the developer never meant to expose.

**Read-only, by construction.** The inspector port has three methods and no write capability: `inspect`, `resolveRealPath`,
`readPrefix`. A diagnostic built on it cannot modify the project it is diagnosing, whatever a future contributor intends.
The only writer in the system is a separate port with a separate purpose.

## Deep validation: the declared method

| Property          | Value                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| Command           | The project's own Cypress CLI, invoked with `config` — load the configuration, nothing else            |
| Interpreter       | The Node binary running QAT, with the resolved CLI file as an argument. No PATH lookup, no `.bin` shim |
| Shell             | Never. Arguments are an array; a path containing `;` is not a command                                  |
| Timeout           | 60 s, hard. A hung loader must not make `qat doctor` appear frozen                                     |
| Output            | Captured, capped at 64 KiB, ANSI-stripped; the message is sanitised before it can reach a finding      |
| Working directory | The project root — the loader must load _this_ project's configuration                                 |
| Enabled by        | Explicit request only. Never a default                                                                 |

It does **not** run tests. `cypress run` and `cypress open` are out of scope by design: the doctor answers "can a run
start?", it does not start one. The argument vector is a frozen constant so that this cannot change by accident.

A loader that does not support the mechanism degrades to "not validated" rather than to a false verdict — an
`unknown command` is `unavailable`, not invalid.

## Performance

| Path                        | Budget                                                                 |
| --------------------------- | ---------------------------------------------------------------------- |
| Location, static validation | Under 20 ms: one `stat`, one `readlink` at most, one bounded read      |
| Deep validation             | Bounded by 60 s; recorded in the finding as `durationMs`               |
| `qat doctor` overall        | Within its documented budget; these checks add no process unless asked |

## Traceability

Every reason and every outcome has a scenario identifier prefixed by its check's identifier, and the catalogue asserts
that each check has at least one.

| Check                               | Scenarios                                                                                                                                                                                                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cypress.configuration-located`     | found, missing, ambiguous, unsupported-name, misplaced, path-occupied, not-a-file, outside-project, unreadable, empty, legacy-format, not-inspected, not-applicable                                                                                      |
| `cypress.configuration-validatable` | validated-json, validated-loader, invalid-syntax, invalid-shape, invalid-load, not-validated-deep-disabled, not-validated-deep-unavailable, not-validated-probe-timeout, not-validated-undecodable, not-validated-size-budget, not-validated-text-sanity |

Test layers:

- **unit** — the location projection, the tier ladder, the guidance entries, and the two rules with literal facts;
- **integration** — a real snapshot over fixture projects, with a fake inspector for the states a filesystem cannot be
  asked to produce on demand;
- **contract** — every reason has a code, every code has an entry, every scenario is prefixed by its check;
- **e2e** — `qat doctor` against a fixture project asserts the code and the sentence a user sees.

## Changing this later

**Adding a location reason** is a compile error in three places — the projection's reason-to-code map, the guidance
record, and this document's table if a contract test compares them. That is deliberate: a new condition cannot reach a
user without a sentence.

**Adding a supported filename** is one edit in the detection registry. Nothing here enumerates filenames; the projection
maps reasons, not names.

**Enabling deep validation by default** would be a policy change with three consequences to decide at once: the 60 s bound
becomes part of every doctor run, the disclosure rule's escape hatch becomes the default path, and the "not validated"
warning disappears for every executable configuration. It is not a one-line change and should not be made as one.

## Known limits

- **Filename matching is case-sensitive.** `Cypress.Config.ts` is not a configuration file. Documented rather than
  fixed: Cypress is case-sensitive here too, and a case-insensitive match would report a file Cypress will not read.
- **One level of symlink resolution.** A configuration reachable only through a chain of links is reported as
  not-a-file rather than resolved. A chain that long is rare enough that "cannot establish" is a better answer than a
  clever resolver.
- **A configuration in an unrecognised format is invisible to detection.** `cypress.config.yaml` is not in the candidate
  list, so it cannot be distinguished from no configuration at all. Detection probes fixed names rather than listing the
  directory, and that determinism is worth more than the coverage.
- **Findings carry no structural evidence.** `CheckFinding` is a code, a severity, a sentence, a remediation and a path.
  The detail an evidence bag would carry is carried by the codes themselves — eleven location codes, two validation
  codes — which is why the reasons did not collapse into one "configuration problem".
