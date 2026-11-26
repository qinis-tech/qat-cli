# Cypress Detection

|                 |                                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Normative                                                                                                                                                                                      |
| **Module**      | `src/project/cypress-detection/`                                                                                                                                                               |
| **Entry point** | `detectCypress(root, options)`                                                                                                                                                                 |
| **Contract**    | `contracts.ts` — the verdict, the evidence and the options                                                                                                                                     |
| **Tests**       | `tests/unit/project/cypress-detection.test.ts`, `tests/e2e/detection.test.ts`                                                                                                                  |
| **Companion**   | [project-discovery.md](project-discovery.md), [ADR-0008](adr/0008-do-not-evaluate-the-framework-configuration-during-discovery.md), [ADR-0018](adr/0018-separate-detection-from-validation.md) |

How QAT decides that a directory is a Cypress project, and what it reports either way.

## 1. Detection is not validation

Detection answers one question: **is this a Cypress project QAT can drive?** It returns evidence with a verdict attached,
and it does not decide whether the project can actually run.

A project with a supported configuration and no installed Cypress is **detected**. It is identifiably a Cypress project; the
missing dependency is a separate problem with a separate remedy, raised by the caller that decides to run something. Two
booleans — "is a Cypress project" and "can run" — that are routinely different, reported as one, is how a tool ends up
telling someone to install a package when they are in the wrong repository.

Nothing in this module throws for an unfavourable verdict. Absence, ambiguity and an unusable format are **answers**. Errors
are reserved for input that cannot be read at all: a manifest that does not parse. "There is nothing here" and "there is
something here and it is broken" need different handling, and only the second is an error.

## 2. The five verdicts

| Verdict       | Means                                               | Evidence that produced it                                   |
| ------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| `detected`    | Exactly one supported configuration file            | `configurations` has one entry                              |
| `absent`      | No Cypress indicators at all                        | No configuration, no declaration, no install, no `cypress/` |
| `incomplete`  | Cypress is evidenced, but no configuration file     | A declaration, an installation, or a `cypress/` directory   |
| `ambiguous`   | More than one supported configuration file          | `configurations` has two or more                            |
| `unsupported` | A Cypress configuration in a format QAT cannot read | `unsupportedConfigurations` is non-empty                    |

The order the verdicts are decided in matters, and it is: ambiguous, then detected, then unsupported, then incomplete or
absent.

- **Ambiguity first**, because two usable configurations is the mistake that gets worse if it is ignored.
- **Detected before unsupported**, because a project holding both `cypress.config.ts` and a legacy `cypress.json` is a
  project part-way through a migration. It works; the stale file is mentioned in the evidence and is not an error.
- **Incomplete before absent**, because "you are in a Cypress project with something missing" and "this is not a Cypress
  project" have different fixes.

The verdict is a closed set and the engine switches over it exhaustively, so a new verdict cannot be added without deciding
where it sits in that order — which is the review this document exists to make deliberate.

## 3. What detection reads, and what it never opens

Five rules, and every one of them is there to make the answer a function of the directory rather than of the moment:

- **Nothing lists a directory.** Every question — _does this file exist_, _does that file exist_ — is an existence probe
  against a fixed candidate list. A listing would make the verdict depend on iteration order, and a verdict that changes
  between two runs on the same tree is a verdict a report cannot quote.
- **The candidate lists are closed.** Supported names, legacy names and misplaced names are explicit tables, shared with the
  cheap marker check that decides whether an ancestor directory is a project root. Anything not on a list is invisible — see
  §4 for why that is a limit rather than a bug.
- **The root is the subject.** Configuration, declaration and lockfile questions are asked of `root`. The only place an
  ancestor is consulted is the explicit marker check, and it asks one question there: _is there a Cypress configuration
  above this directory_.
- **The framework's configuration is never loaded, imported or executed.** A `cypress.config.ts` is identified by its name.
  Reading it would mean running project code to find out whether a project exists, which is the boundary
  [ADR-0008](adr/0008-do-not-evaluate-the-framework-configuration-during-discovery.md) draws: the _validity_ of a
  configuration is a separate question, answered by separate code, with its own supported loading mechanism.
- **Only two things delegate, and both are readers.** Package metadata comes from package discovery, which reads a manifest
  as data; the version comes from that installed manifest, never from executing the package. Everything else here is a
  stat.

## 4. Configuration rules

Supported formats are the ones Cypress 10 and later uses, and the list is shared with the cheap marker check that decides
whether an ancestor directory is a project root. Sharing it is what stops the two from disagreeing about what counts as a
configuration file.

| Format     | Files                               |
| ---------- | ----------------------------------- |
| TypeScript | `cypress.config.ts`, `.mts`, `.cts` |
| JavaScript | `cypress.config.js`, `.mjs`, `.cjs` |

`cypress.json` is **recognised as Cypress and reported as unusable**. It was the configuration format before Cypress 10
replaced it with a module. A directory holding only one of these is a Cypress project, and telling its owner they are in the
wrong place would be wrong — they need to upgrade, not to move.

**Anything else is invisible.** A file called `cypress.config.yaml` is in neither list and is indistinguishable from no
configuration at all. Finding it would mean listing the directory, which the determinism rule in §3 forbids. This is a
deliberate limit rather than an oversight, and it is the reason the unsupported list is finite and explicit.

### Misplaced files are a list, not a guess

`MISPLACED_CONFIG_FILES` is the third rule table: the _supported_ names in the place Cypress does not load them from, most
commonly `cypress/cypress.config.ts`. It exists because that shape is common in projects migrated from the pre-10 layout, and
because the two available messages without it are both wrong: detection would report the project as `incomplete` (technically
true, unhelpfully vague) and nothing else would mention the file the owner can see in their editor.

Detection exports the list as evidence; **validation turns it into the finding** (`QAT-V001`, "move it to the project root").
The split is the same one the whole module draws: detection says what is on disk, validation says what to do about it. A
project in that state therefore produces two findings, not one — `QAT-D002` for the missing root configuration and
`QAT-V001` for the one in the wrong place — because they are two facts with two remedies.

## 5. Dependency and version rules

Declaration and installation come from package discovery and are reported separately — see
[ADR-0017](adr/0017-record-dependency-declaration-separately-from-installation.md). Detection neither merges them nor prefers
one.

**The version is taken from the installed package**, when there is one. There is no separate version field, because two
fields holding the same string is the duplication that eventually disagrees. A project that is only declared has a _range_ in
`declaration.range` and no version, which is the honest answer: the range is what was asked for, and nothing has reported
what was delivered.

**The version is not judged.** Whether an installed version is supported is a validation question, and detection reporting a
number it then passes sentence on would put a policy in the wrong module. Nothing here compares the declared range with the
installed version either; that comparison needs a range implementation, and nothing needs the answer yet.

## 6. Layout evidence

| Field                                     | Question                                                      |
| ----------------------------------------- | ------------------------------------------------------------- |
| `specDirectories`                         | Which conventional spec directories exist, in candidate order |
| `supportFiles`                            | Which conventional support files exist                        |
| `screenshotsDirectory`, `videosDirectory` | Present only when the conventional directory exists           |
| `hasCypressDirectory`                     | Whether `cypress/` exists at all                              |

These are evidence, never deciding factors. A project with a custom `specPattern` in its configuration has none of the
conventional directories and is still a Cypress project. What the layout does is turn _no configuration file_ into _no
configuration file, though it is clearly a Cypress project_ — a different message, and a more useful one.

`hasCypressDirectory` overlaps with the `cypress` entry in the spec-directory candidates, and is not derived from it. The two
answer different questions, and tying them together would make one silently depend on the other list's contents.

## 7. What detection does not do

- **It modifies nothing.** Every operation is a read. There is no write path in this module or in the two it delegates to,
  and a test asserts that the directory tree is byte-identical afterwards.
- **It does not load the framework's configuration.** A configuration file is a name on disk here; whether it is valid is
  answered elsewhere, by code that owns a supported loading mechanism. Nothing in this module imports a project file.
- **It does not run Cypress.** The installed package is identified by reading its manifest, never by executing it. A project
  whose Cypress is not installed is still detected. An explicit verification operation that needs to invoke the binary is a
  separate thing, and does not belong here.
- **It does not install anything.** Remediation is text in an error raised by the caller.

## 8. Adding a rule

| Rule                       | Where                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A new configuration format | The shared candidate list, and a row in §4                                                                          |
| A new legacy format        | `LEGACY_CONFIG_FILES`, and a row in §4                                                                              |
| A new misplaced location   | `MISPLACED_CONFIG_FILES`, and the §4 note on why detection stops at the list                                        |
| A new layout indicator     | `CypressLayout` and the layout reader — plus the `evidenced` predicate in the engine if it should count as evidence |
| A new verdict              | The closed set, the exhaustive `switch` in discovery, and §2                                                        |

A new verdict is the only one that is not additive: it breaks the exhaustive switch, which is the point. The compiler asks
where the new case sits in the decision order, and §2 has to answer.
