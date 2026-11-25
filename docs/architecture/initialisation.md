# Initialisation

|                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**       | Normative                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Module**       | `src/init/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Entry points** | `Application.initialisation.initialise(root)`, `generateDefaultConfiguration()`, `unusableProjectFindings(assessment)`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Companion**    | [configuration-loading.md](configuration-loading.md), [configuration-defaults.md](configuration-defaults.md), [safe-writes.md](safe-writes.md), [validation.md](validation.md), [cli-output.md](../development/cli-output.md), [cli-commands.md](../development/cli-commands.md), [ADR-0013](./adr/0013-register-a-command-only-when-its-capability-exists.md), [ADR-0028](./adr/0028-create-a-new-configuration-exclusively-rather-than-by-renami.md), [ADR-0029](./adr/0029-require-declared-intent-for-a-destructive-configuration-writ.md) |

Creating a project's QAT configuration, or explaining why it did not.

Initialisation is a **create-only** operation: it writes one file, and only when nothing is at that path. Everything else
here follows from that sentence, including the two things that are easy to get wrong — the check before the write is
advice, and the write itself is the guarantee.

## 1. The four outcomes

| Outcome                  | Means                                                                                       | Status |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------ |
| `created`                | The configuration was written. The only outcome that changed anything on disk               | 0      |
| `already-initialised`    | A configuration is already there and loads. Nothing was written                             | 0      |
| `existing-configuration` | Something is at the path and cannot be used. Nothing was written, and nothing was removed   | 2      |
| `project-not-usable`     | The directory is not a project QAT can configure. Nothing was inspected for a configuration | 2      |

Four sentences rather than one because they send the reader to four places, and one of them — "fix or delete the file you
already have" — is not advice any other outcome should give.

Two things throw, and neither is a property of the project:

| Thrown    | When                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `QAT1001` | The chosen directory does not exist or is not a directory. An argument defect, raised by the shared resolver before this command does anything |
| `QAT5001` | The filesystem could not answer, or refused to create the file: a permission problem, a full disk, a volume that cannot hard-link              |

## 2. The workflow, in the order it runs

The order is the safety argument, not a sequence somebody happened to write.

| #   | Step                                        | Where                                          | On failure                                               |
| --- | ------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| 1   | Resolve the project directory               | The command, via the shared resolver           | throws `QAT1001`                                         |
| 2   | Detect the framework project                | `project` module, through the assessment       | `project-not-usable`                                     |
| 3   | Judge compatibility against the init policy | `policy.ts` over the assessment's execute gate | `project-not-usable`                                     |
| 4   | Is anything at the configuration path?      | The configuration loader                       | `already-initialised` or `existing-configuration`        |
| 5   | Generate the default document               | `generate.ts`                                  | a defect: throws                                         |
| 6   | Validate it against the schema              | The schema                                     | a defect: throws, nothing written                        |
| 7   | Create the file, exclusively                | `writeNewFile` in `core/filesystem`            | `existing` is an outcome; anything else throws `QAT5001` |
| 8   | Present the result                          | `cli/output/initialisation.ts`                 | —                                                        |
| 9   | Return the status                           | The command                                    | —                                                        |

Two orderings carry weight. **Judging precedes reading**: reading a file before deciding the directory is a usable project
produces a refusal that names the wrong problem. **Validating precedes writing**: a generator defect must stop the
command, not leave a file on disk that the next command refuses to read.

## 3. Create-only, and the one window it cannot close

`writeNewFile` writes the contents to a temporary file beside the target, flushes it, and then **hard-links** it to the
final name. The mechanics, and the reason each one is not the obvious alternative, are in [safe-writes.md](safe-writes.md)
§2 and §3.

Not `rename`. `rename` is atomic and it _replaces_ whatever is at the destination without a word — which is exactly right
for an edit and exactly wrong for a create, because a file that appeared between the caller's check and this call would be
destroyed and the caller would be told the write succeeded. `link` performs the same test the caller made earlier, and
fails with `EEXIST` if the name is taken: the check and the effect are one operation, performed by the filesystem.

That leaves one window, which the design names rather than hides. If the link reports `EEXIST`, `initialise` **re-reads**
the path and answers with what is actually there:

| What the re-read finds             | Reported                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A configuration that loads         | `already-initialised` — the answer we would have given a moment earlier                                   |
| A file that does not load          | `existing-configuration`, with its own reason                                                             |
| Nothing (it appeared and vanished) | `existing-configuration` with code `QAT-INIT-EXISTING-DISAPPEARED` and the remedy "Run the command again" |

The third row is not padding. A file that appeared and disappeared leaves nothing to fix, and telling the reader to edit it
would send them looking for a file that is not there.

### Replacement exists, and this command cannot reach it

The same module that provides `writeNewFile` also provides `replaceFileWithBackup`, which replaces a file after copying
the previous contents aside and proving the copy is readable. It is not withheld from this workflow by discipline.

The dependency this service is given is typed `(path, contents) => Promise<NewFileWriteOutcome>`. The replacing function
returns a different union _and_ demands a SHA-256 of the content it is replacing, so it cannot be bound to that dependency
at all — it is a type error, not a review note. Widening the dependency is therefore the visible change that would have to
precede any replacement feature, and [safe-writes.md](safe-writes.md) §8 says what else that change would need: an approved
flag, a caller that has read the file, and a test proving the backup verified before the target moved.

## 4. What the generated document says

```json
{
  "version": 1,
  "framework": "cypress"
}
```

Two fields, because two fields are all a valid configuration requires. Every other field has a documented default, and
writing one into a new file would convert it into a decision: the moment the default changes, every initialised project
keeps the old value and there is no way to tell a deliberate setting from a fossil.

`framework` comes from the domain's enum rather than from a string literal, so a rename in the domain reaches this file
instead of quietly producing a value the schema then rejects. The bytes are fixed — two-space indentation, one trailing
newline, no carriage returns — because the file is a user-facing artefact that somebody will diff and review.

The full table of defaults, and the fields that deliberately have none, is in
[configuration-defaults.md](configuration-defaults.md).

## 5. What makes a project ready to be configured

Initialisation needs a directory QAT recognises as a Cypress project. It does **not** need one it could run tests in.

The policy is one allow-list, applied to the assessment's execute gate:

| Condition                                                  | Blocks initialisation? | Why                                                                                                     |
| ---------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| No framework detected                                      | yes                    | There is nothing to configure                                                                           |
| No configuration, two configurations, an unreadable format | yes                    | The project is not in a state a configuration can describe                                              |
| Configuration where the framework does not load it         | yes                    | The same, from validation rather than detection                                                         |
| Incompatible framework version                             | yes                    | A file written for a version nothing will read                                                          |
| Unreadable manifest                                        | yes                    | Detection cannot be trusted, and configuring such a project hides the real problem behind a second file |
| **Dependency declared but not installed**                  | no                     | The journey is clone, initialise, install, run                                                          |
| **Manifest missing or incomplete**                         | no                     | A fresh clone has no dependencies either                                                                |
| **Dependency installed but undeclared**                    | no                     | Advice about the manifest, not an obstacle                                                              |

The set is an **allow-list**, not a deny-list, so a new blocking condition blocks initialisation until somebody decides
otherwise. Default-deny is the safe direction: the cost of wrongly refusing is a message a reader can act on; the cost of
wrongly accepting is a configuration file in a project that cannot use it.

Two gates were available and neither was right on its own. The inspect gate is never blocked, so gating on it would accept
every directory. The execute gate whole would demand an installed framework — refusing exactly where the command is most
useful. Subtracting the installation-only conditions from the execute gate is the smallest statement that is also true.

## 6. Statuses

`created` and `already-initialised` both exit `0`. The status answers **"is this project configured"**, not "did this call
do the work": after either outcome the postcondition holds, and a provisioning script that runs the command twice must not
fail on the second run. A distinct non-zero status for a re-run would make `qat init && qat run` unusable in every script
that is not run exactly once.

`existing-configuration` and `project-not-usable` exit `2` — the same code a blocked `qat doctor` returns, because both mean
"this directory cannot be used as it stands", which is the category scripts already branch on. No new exit code is
introduced for initialisation.

## 7. What it does not do

| Not done                                        | Because                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Modify the framework's own configuration        | The command's central promise. Nothing reads it for editing, rewrites it, or moves it                                                                  |
| Create an output directory                      | Directories appear when something is written. A project initialised and never run contains exactly one more file than it did before                    |
| Repair, merge into, or back up an existing file | The reader decides what happens to their file. A command that silently replaced one would be a mistyped path away from destroying a project's settings |
| Offer a `--force`                               | There is no version of it that is safe to run by accident, and the alternative — delete the file and run again — is one deliberate action              |
| Ask a question interactively                    | A command that prompts cannot be run in a pipeline, and the prompt would be the only place the decision lived                                          |
| Write a `.gitignore` entry                      | Repository hygiene is the project's business; a command that edited one would be surprising the first time it did                                      |
| Run the framework                               | `init` writes a file. Anything that executed a test runner would belong to a different command                                                         |

## 8. The report

Human lines describe one of the four outcomes and never share a shape with another: a refusal that printed the same lines
as a success with a different word would be scannable as "created", which is the one misreading this must not allow.

```
created    /repo/packages/api/qat.config.json
root       /repo/packages/api

Edit the file to change the framework or add environments, then run `qat doctor`.
```

A refusal prints the findings as blocks, using the same renderer `qat doctor` uses: the code and severity flush, the
sentence, `at:` and `fix:` hanging two spaces beneath. A reader who has learned one command's output can read the other's.

Under `--json` the human lines are absent and exactly one document is written, `{ "initialisation": … }`. Error rendering,
stream separation and the ASCII rule are in [cli-output.md](../development/cli-output.md).

## 9. Testing

| Scenario                              | Asserted                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A supported project                   | `creates the configuration and exits zero`; the file is present and named on stdout                    |
| The file's contents                   | `writes the smallest configuration the schema accepts` — exact bytes, written out rather than computed |
| The framework's configuration         | `leaves the framework's own configuration untouched` — bytes before and after                          |
| Nothing else created                  | `adds one entry to the project and no more` — directory listing before and after                       |
| A `--cwd` directory                   | `accepts the directory through --cwd`; `prefers the positional directory over --cwd`                   |
| A missing manifest                    | `initialises a project whose manifest is missing` — advice does not block                              |
| A re-run                              | `exits zero and reports what it found`; `leaves the file byte-identical`                               |
| A hand-edited configuration           | `keeps a configuration the reader edited` — bytes unchanged                                            |
| Neither a project nor configured      | `QAT-D002` with its remedy, nothing written, stderr clean                                              |
| No framework at all                   | `QAT-D001`, nothing written                                                                            |
| A misplaced configuration             | `QAT-V001` with `at:` and `fix:`                                                                       |
| Four kinds of unusable existing file  | `refuses to replace %s`, each byte-identical afterwards                                                |
| A malformed existing file             | `says where a malformed file stops` — line and column                                                  |
| A directory on the configuration name | `refuses a directory sitting on the configuration name`                                                |
| A missing directory                   | `reports an argument defect on standard error` — `QAT1001`                                             |
| `--json`, three outcomes              | the outcome, the path, the reason, the findings, one line on stdout                                    |
| Determinism, working directory        | `is deterministic`; `does not depend on the working directory`                                         |

Unit level, against stubbed dependencies: the call order (judges, then reads, then writes), the generator's document
written byte for byte, the race branch in three shapes, and propagation of failures that are not outcomes.

The writer itself is tested separately, including the property this command depends on and cannot test from above: that a
create finding an occupied path leaves the existing bytes alone, and that two concurrent creates produce exactly one
`"created"`. See [safe-writes.md](safe-writes.md) §11.

## 10. Known limits

| Limit                                                        | Why it is one                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The refusal codes are bespoke                                | `QAT-INIT-EXISTING-EMPTY`, `-MALFORMED`, `-TOO-LARGE`, `-DISAPPEARED` and `-UNUSABLE` are authored in `initialise.ts` rather than registered in the diagnostics catalogue with a permanent range. Every other code in the product is minted in one place, and these are the exception; they need a `QAT-I` range and a catalogue entry each |
| Replacement is not available to this command                 | The mechanism exists and is tested; nothing can reach it, and the dependency's type is what enforces that rather than an intention to avoid it. See §3                                                                                                                                                                                      |
| Filesystems without hard links are refused                   | `link` fails with `EPERM` or `ENOSYS` on some network mounts and FAT volumes. That is reported with its own message rather than silently degrading to a direct write, because degrading would trade crash atomicity for portability without telling anybody                                                                                 |
| A crash can leave a temporary file                           | `.<name>.<pid>.<uuid>.tmp` beside the target. It is named so it is attributable, and the next run does not read it — but nothing sweeps it                                                                                                                                                                                                  |
| No interactive mode                                          | The command takes a directory and does what the project requires. Anything a prompt would ask is either derivable or belongs in an edit of the file it just wrote                                                                                                                                                                           |
| An invalid configuration produces no finding in `qat doctor` | The assessment attaches a resolved configuration when the file loads and nothing when it does not. Closing that means merging the loader's diagnostics into the assessment's gate, which decides an exit status and therefore needs its own decision                                                                                        |

## 11. Things that will bite

**The check is advice; the write is the rule.** The load at step 4 and the create at step 7 are two moments, and only the
second one commits. Anyone who "simplifies" the writer back to `writeFileAtomic` — which is right for every other caller in
the product — reintroduces a silent overwrite under a race, and the test that catches it is the one asserting that a
concurrent create leaves the existing bytes alone.

**A relative path in a refusal.** Every path this command prints is absolute and built from the resolved project root. A
message naming a relative path would be a message the reader has to interpret, and in a CI log there is nothing to
interpret it against.

**The generated file is deliberately small.** It will look incomplete to a reader who expects a scaffold, and the
temptation to "fill it in so they can see the options" is the one change that quietly converts every documented default
into a value nobody chose. The options are in the architecture document, which does not go stale when a default changes.

**`already-initialised` exiting zero is a decision, not an accident.** If a pipeline needs to distinguish "I created it"
from "it was already there", the answer is the `--json` document's `outcome`, not the status — the status is a question
about the project, and the document is a question about the run.

**A re-read after `EEXIST` is not redundant work.** It is the only place the check-then-write gap is observable, and it
turns a race into the outcome the reader expected. Removing it would make a concurrent second run fail with a filesystem
error about a name being taken — accurate, and useless to whoever is running two deploys.

**Do not "upgrade" step 7 to `replaceFileWithBackup` when a reader asks for a re-init.** The function is right there, it
takes the same arguments plus a hash, and wiring it would take ten minutes. It would also make `qat init --replace`
possible, which is the one thing §7 promises is not. If replacement is wanted, it is a product decision with a written
specification — [safe-writes.md](safe-writes.md) §5 lists the questions it has to answer — not an implementation shortcut.
