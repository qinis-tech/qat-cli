# Manual end-to-end testing

|                |                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**     | Normative                                                                                                                                                                                                                                                                                                                                                     |
| **Applies to** | The compiled binary, `dist/cli/index.js`                                                                                                                                                                                                                                                                                                                      |
| **Companion**  | [testing-architecture.md](testing-architecture.md), [cli-output.md](../development/cli-output.md), [cli-commands.md](../development/cli-commands.md), [testing-standards.md](../development/testing-standards.md), [environment-profiles.md](../architecture/environment-profiles.md), [environment-resolution.md](../architecture/environment-resolution.md) |

What a human checks that the automated suite cannot, and how to check it the same way twice.

## 1. Why this exists when there is an end-to-end suite

The suite asserts **facts**: exit statuses, which stream a line went to, which finding codes appear, whether the tree
changed. It runs the same binary a person runs, and it would catch a command that stopped failing or a report that lost a
finding.

It cannot judge whether the report **reads well**. It cannot tell you whether `A directory occupies cypress.config.ts, so
no configuration file can exist under that name.` is a sentence somebody can act on at 2am, whether a remedy names a
command that exists, or whether the whole block is legible in a real terminal rather than in a captured string. Those are
the questions this procedure answers, and they are the ones that decide whether the tool is useful.

It also cannot judge a reassurance. `already-initialised`, `nothing was changed`, `env none selected; declare one, or set
defaultEnvironment` — each is a sentence whose job is to stop somebody worrying, and whether it does that is not a
property a string comparison can express.

And it catches a class of defect the suite is blind to by construction: **anything platform-specific that the CI matrix
does not run.** A legacy Windows code page, a terminal that wraps at 80 columns, a path with a space in it that a shell
mangles before the tool ever sees it.

## 2. When to run this

| Trigger                                                     | Scope                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A release candidate                                         | The whole procedure, on at least Windows and Linux                              |
| Any change to the report's wording, labels or ordering      | Sections 4.3 to 4.7 and 4.11 — the reading checks                               |
| Any change to the exit-status mapping                       | Sections 4.7 and 4.8                                                            |
| Any change to defaults, path resolution or the output block | Sections 4.3, 4.4 and 4.7                                                       |
| Any change to environment profiles, or to the `env` line    | Sections 4.4 and 4.11                                                           |
| Any change to initialisation or the safe writer             | Sections 4.4, 4.9 and the `init` rows in §6                                     |
| A CI platform failure you cannot reproduce                  | The platform section for that OS                                                |
| Before quoting the README's example output                  | Section 4.3, because a README example that no longer matches is worse than none |

Not on every pull request. The suite already runs there, and a manual checklist applied to every diff stops being applied
to any.

**One gap, recorded rather than papered over.** Environment _selection_ — an explicit `--environment`, an approved
`--base-url` — has no manual step, because no command exposes either. The resolution service exists and is specified by
its tests; the first command that selects an environment is what makes this section grow.

## 3. Preconditions

### 3.1 The environment the project claims

```bash
node --version    # v24 or later
npm --version     # 10 or later
```

`npm ci` **warns** rather than fails when the runtime is outside `engines`, and a warning is easy to scroll past. A pass
on an unsupported Node proves nothing about a supported one: the build may succeed and behave subtly differently, and a
finding from it cannot be reproduced where it matters. If `node --version` is below 24, fix that before going further.

### 3.2 Install

```bash
npm ci
npm run build
node dist/cli/index.js --version
```

The last command must print the version in `package.json`. If it prints a stack, stop: nothing below is meaningful, and
the failure is a build rather than a behaviour.

**`npm ci` once per clone**, or after a lockfile change. For a pass against an existing checkout — the usual case, since
most passes follow a change to the report — `npm run build` is enough. A reinstall costs a minute and can fail for reasons
that have nothing to do with the tool.

### 3.3 When the install fails on the hooks

```
sh: 1: husky: Permission denied
npm error code 127
```

This is not a half-installed tree. `npm ci` installs the dependencies and _then_ runs `prepare`, so the failure means
**everything but the git hooks** is in place — which is why `npm run build` still works immediately afterwards. Do not
re-run the install.

Diagnose:

```bash
ls -l node_modules/.bin/husky
./node_modules/.bin/husky --version
```

`-rw-r--r--` means the executable bit was lost on the way to disk:

```bash
chmod +x node_modules/.bin/husky && npm run prepare
```

Executable and still refused means the filesystem is mounted `noexec`:

```bash
findmnt -no OPTIONS --target "$(df --output=target node_modules | tail -1)"
```

If that prints `noexec`, hooks cannot run from this checkout and the correct response is to accept it: hooks are a
courtesy in this project, and `npm run verify` covers what they would have run. Record it in the pass notes, because it is
the first thing to suspect if a later command behaves oddly.

### 3.4 The projects to test against

Two things besides the repository.

**A scratch project.** Detection reads manifests and directory names, so a fabricated tree is enough and costs nothing to
recreate:

```bash
mkdir -p /tmp/qat-manual/{cypress/e2e,node_modules/cypress}
cd /tmp/qat-manual
printf '{"name":"demo","version":"1.0.0","devDependencies":{"cypress":"^13.15.0"}}' > package.json
printf 'export default {};\n' > cypress.config.ts
printf '{"name":"cypress","version":"13.15.0"}' > node_modules/cypress/package.json
```

It deliberately has **no `qat.config.json`**. That is the state a new project is in, and 4.3 checks the report a reader
sees there; 4.4 is where one is created, and 4.11 is where it gains an environment.

**A real Cypress project**, if you have one. A fabricated tree cannot surprise you, and the surprises are the point.
Nothing in QAT should invoke Cypress, so the check is cheap: it either returns in under a second or it is doing something
it promised not to.

### 3.5 What to record

Operating system and version, Node version, package version under test, and the terminal — `cmd.exe`, Windows Terminal,
Git Bash, iTerm, GNOME Terminal. A rendering defect is not reproducible without the last one, and a rendering defect is
the kind only this procedure finds.

## 4. The procedure

Set one variable from the repository root, then run every command below from wherever the step says:

```bash
export QAT="$PWD/dist/cli/index.js"
```

Absolute, so it survives the `cd` into a scratch project, and quoted at every use so a checkout path containing a space
works. `$OLDPWD` is the obvious shortcut and breaks the second time a step changes directory.

### 4.1 Startup and help

```bash
node "$QAT" --help
node "$QAT" doctor --help
node "$QAT" init --help
```

**Expect:** the command list with `doctor` **and** `init`, each with a summary; then usage, the `[directory]` argument and
an `Examples:` block for each command. Exit `0` for all three.

**Read for:** does the command list tell you which command you want? Is the example one you could paste and run? Help
that lists names without saying what they do is help that sends the reader to `man`.

### 4.2 Version and unknown input

```bash
node "$QAT" --version
node "$QAT" docter
node "$QAT" --nope
node "$QAT" init --replace
```

**Expect:** the version on its own line. Then, for `docter`, `QAT1001: Unknown command 'docter'` with
`Did you mean 'doctor'?` and exit `2`. For `--nope` and for `init --replace`, `unknown option` and exit `2`.

**Read for:** the suggestion, and the absence of a replacement flag. The last command is deliberate: the safe writer
implements replacement, and no command exposes it. If `init --replace` is accepted, something shipped a destructive
option without the semantics it needs.

### 4.3 A supported project, before initialisation

```bash
cd /tmp/qat-manual
node "$QAT" doctor ; echo "exit=$?"
```

**Expect** nine lines — `project`, `root`, `package`, `framework`, `declared`, `config`, `detection`, `compatibility`,
`result` — with `result     ready` last, exit `0`, **nothing on standard error**, and **no `reports` or `evidence` line**.

**Read for:** alignment. The values should sit in one column whatever the label's length; `compatibility` is the longest
and takes a single space. A column that steps in by one is the kind of defect nobody reports and everybody notices.

### 4.4 Initialising that project

```bash
node "$QAT" init ; echo "exit=$?"
cat qat.config.json
node "$QAT" doctor ; echo "exit=$?"
```

**Expect:** on the first command, a `created` line naming the absolute path, exit `0`, and an empty standard error. The
file contains exactly two fields — `version` and `framework` — and nothing else. The second `doctor` now prints an output
block between the summary and the verdict:

```
reports    /tmp/qat-manual/results/reports
evidence   /tmp/qat-manual/results/evidence
env        none selected; declare one, or set defaultEnvironment
```

**Read for:** three things the suite cannot judge.

1. Does the file look like something a person wrote? Two fields and a trailing newline. A scaffold that filled in every
   default would freeze today's values into a decision nobody made — and one that scaffolded an example environment would
   be inventing a target nobody chose.
2. Does `env none selected; declare one, or set defaultEnvironment` read as guidance or as a complaint? It is the one line
   in the report that prevents a failed run six steps later, and it has to be worth reading.
3. Are the output paths obviously _inside the project_? A reader should not have to compare prefixes to work that out.

Then run `init` again:

```bash
node "$QAT" init ; echo "exit=$?"
```

**Expect** an `exists` line, exit `0`, and a file whose bytes are unchanged — `sha256sum qat.config.json` before and
after, if you want the evidence rather than the claim.

**Read for:** whether "nothing was changed" reads as success. Exit `0` is deliberate — a provisioning script that runs
twice must not fail — but the wording has to carry that, because the exit status is silent in a terminal.

### 4.5 A project with warnings

Delete the manifest, run, restore:

```bash
mv package.json package.json.bak
node "$QAT" doctor ; echo "exit=$?"
mv package.json.bak package.json
```

**Expect** `result     ready-with-warnings`, a `QAT-D010 warning` block, and exit `0`.

**Read for:** whether the warning reads as advice rather than as an error. If you would not read past it, the wording is
wrong — and the exit status is deliberately `0`, so the wording is the only thing telling the reader it is survivable.

### 4.6 A project that is blocked

Move the configuration where Cypress will not load it, run, restore:

```bash
mv cypress.config.ts cypress/cypress.config.ts
node "$QAT" doctor ; echo "exit=$?"
mv cypress/cypress.config.ts cypress.config.ts
```

**Expect** `result     blocked`, a `QAT-V001 error` block naming `cypress/cypress.config.ts`, an `at:` line, a `fix:`
line, exit `2`, **and an empty standard error**.

**Read for:** whether `fix:` names something you could do. `Move it to the project root as cypress.config.ts.` is a
one-line fix; `Check your configuration.` is not. Then follow the fix and confirm the report clears — a remedy that does
not work is worse than no remedy, because it has been trusted.

### 4.7 The structured document

```bash
node "$QAT" doctor --json | jq .assessment.diagnosis.identity
node "$QAT" doctor --json | jq '.assessment.configuration'
node "$QAT" doctor --json > /tmp/out.json 2>/tmp/err.txt
wc -c /tmp/err.txt
```

**Expect** one JSON document per invocation, parseable by `jq` with no preprocessing, a populated
`assessment.configuration` because 4.4 created the file, and an empty `/tmp/err.txt`.

**Read for:** whether the document is the thing you would actually consume. Pipe it through `jq '.assessment.gates'` and
ask whether the shape answers a question you have. If you have to join two fields to learn whether the project can run,
the shape is wrong.

### 4.8 Exit statuses, as a pipeline sees them

With the scratch project healthy, and then against a path that does not exist:

```bash
node "$QAT" doctor /tmp/qat-manual >/dev/null 2>&1 ; echo "healthy: $?"
node "$QAT" doctor /nonexistent >/dev/null 2>&1 ; echo "bad argument: $?"
node "$QAT" init /tmp/qat-manual >/dev/null 2>&1 ; echo "already initialised: $?"
```

**Expect** `0`, `2`, then `0`. And — importantly — `1` for none of them. `1` is reserved for a failing test, and a tool
that spends it on a missing directory makes a pipeline unable to tell a bad change from a bad command.

### 4.9 Nothing new appeared

```bash
ls -A /tmp/qat-manual
node "$QAT" doctor >/dev/null
ls -A /tmp/qat-manual
```

**Expect** two identical listings — and note that `qat.config.json` is in both, because 4.4 created it. A detection
command that wrote a cache, a results directory or a repaired configuration on the way past would be a different command
with a different name, and the write happens on whatever machine runs it.

**No `results/` yet.** The report names the directory; nothing creates it. That distinction is the whole of the
lazy-creation policy and it is visible only here:

```bash
test -d results && echo "WRONG: doctor created the output directory" || echo "ok: named but not created"
```

### 4.10 No terminal control in the output

```bash
node "$QAT" doctor | cat -v
node "$QAT" init | cat -v
```

**Expect** no `^[` sequences anywhere, in either command. Paths and messages can carry text from a file or a subprocess,
and a sequence that clears the screen can make a reader believe output came from this tool. `cat -v` renders an escape as
`^[`, so a clean run has none.

### 4.11 A project that declares environments

The `env` line is one short sentence that decides whether a run has a target. Four wordings exist, and only a person can
say whether they help. Rewrite the configuration between runs; it is a scratch project.

**A default named by the configuration:**

```bash
cat > qat.config.json <<'JSON'
{
  "version": 1,
  "framework": "cypress",
  "defaultEnvironment": "staging",
  "environments": {
    "staging": {
      "baseUrl": "https://staging.example.test",
      "variables": { "API_URL": "https://api.staging.example.test" }
    },
    "production": { "baseUrl": "https://example.test" }
  }
}
JSON
node "$QAT" doctor | grep '^env'
```

**Expect** `env        staging (from defaultEnvironment)`. Exit `0`.

**The only environment declared:**

```bash
cat > qat.config.json <<'JSON'
{ "version": 1, "framework": "cypress", "environments": { "only": { "baseUrl": "https://only.example.test" } } }
JSON
node "$QAT" doctor | grep '^env'
```

**Expect** `env        only (the only one declared)`.

**Two environments and no default:**

```bash
cat > qat.config.json <<'JSON'
{
  "version": 1,
  "framework": "cypress",
  "environments": {
    "staging": { "baseUrl": "https://staging.example.test" },
    "production": { "baseUrl": "https://example.test" }
  }
}
JSON
node "$QAT" doctor | grep '^env'
```

**Expect** `env        none selected; declare one, or set defaultEnvironment`. Exit `0`, and **no** finding about the
ambiguity — the file is valid, the _run_ is what has no answer.

**Read for:** whether each sentence says what happened and what to do. "The only one declared" should tell an operator
that declaring a second environment will stop this being automatic. "None selected" should read as an instruction, not as
a failure, because the project is fine.

**An unusable configuration is invisible here**, deliberately and for now:

```bash
cat > qat.config.json <<'JSON'
{ "version": 1, "framework": "cypress", "environments": { "staging": {} } }
JSON
node "$QAT" doctor ; echo "exit=$?"
```

**Expect** a report with **no** output block and **no** finding — the empty profile is refused by the schema at load, and
a file that cannot be read produces no attachment. Exit `0` if the rest of the project is healthy. That is §6's known
gap, and this step exists so you see it rather than file it.

Restore the disposable state when done:

```bash
rm qat.config.json
```

## 5. Platform checks

### Windows

| Check                                                                             | Why                                                                                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run in `cmd.exe` with the default code page (check with `chcp`, often 850 or 437) | A tick, an em dash or an arrow renders as mojibake there. The output is ASCII by design, and this is how you confirm it stayed that way           |
| A project under `C:\Users\…\My Projects\demo`                                     | A path with a space is the oldest quoting bug there is, and it fails on Windows before it fails anywhere else                                     |
| `qat doctor` and `qat init` from a Git Bash shell as well as `cmd.exe`            | Two shells, two quoting rules, one argument — and `init` writes a file, so a mangled argument is a file in the wrong place                        |
| Redirect with `>` and confirm the file has no stray carriage returns              | Output written with `\r\n` in one place and `\n` in another produces a file that looks right and diffs badly                                      |
| Open the file `init` wrote in Notepad                                             | One field per line, two-space indentation, and a trailing newline. A JSON file written with `\n` opens correctly; one with mixed endings does not |

### Linux

| Check                                               | Why                                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A terminal narrower than 90 columns                 | The report is not wrapped by the tool, so the terminal wraps it. Confirm a wrapped line is still readable and still greppable |
| A project path containing a character outside ASCII | Confirms nothing breaks on a path the tool did not choose — and it is the realistic case for many users                       |

### macOS

Expected to work and not exercised in CI, so this is where a manual pass has the most to find. The one known platform
difference: a process started in `/var/folders/…` reports its working directory as `/private/var/folders/…`, so the `root`
line may differ from the path you typed when the directory came from the process rather than an argument.

## 6. Known behaviour that is not a defect

Read this before filing anything. Each of these is deliberate, and each has a reason recorded somewhere in `docs/`.

| You will see                                                                 | Why it is not a bug                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `specs` or `manager` line in the report                                   | Two facts about a project's _shape_ left the report when it moved to the assessment, which carries _correctness_ facts. Restoring them is a contract change, not a one-line fix |
| `qat init` on an initialised project exits `0`                               | The postcondition — a project with a usable configuration — already holds. A non-zero status would fail every provisioning script that runs twice                               |
| `qat init` leaves an unreadable `qat.config.json` byte-identical             | It never repairs and never replaces. The file is named in the message, and the remedy is to fix or delete it                                                                    |
| `qat init --replace` is an unknown option                                    | The safe writer implements replacement with a declared intent; no command exposes it, so no command line can destroy a configuration by accident                                |
| `qat init` writes two fields and no example environment                      | The document contains only what has no default. An environment scaffolded by default would be a target nobody chose                                                             |
| `qat doctor` says nothing about a `qat.config.json` it cannot read           | A known gap: an unusable configuration produces no finding and no output block. Closing it decides the exit status, so it is a separate decision                                |
| `env none selected; declare one, or set defaultEnvironment` with exit `0`    | The project is valid; the _run_ has no target. Choosing one would be a guess, and the refusal is worth more than a plausible default                                            |
| A profile written as `{}` is refused                                         | It declares nothing and looks configured. The message names the field, and the fix is to add a target, variables or secrets, or to delete the environment                       |
| A variable whose value begins `env:` is refused                              | It is almost always a secret written into the wrong map. The remedy says to declare it under `secrets`, where the value is read at run time                                     |
| A secret reference carrying a `value` is refused                             | Secret values are never stored in the file. The property is unknown, and the message names it rather than committing a credential                                               |
| A profile `baseUrl` with a username or password is refused                   | A credential in a committed URL is a leaked secret that keeps working until somebody rotates it, then fails with a message about the host                                       |
| A duplicate key in the JSON is silently the last one                         | `JSON.parse` cannot report it. A duplicated field is a defect nothing notices, and no validator can see it                                                                      |
| `qat doctor` has no `--environment`                                          | The `env` line reports the environment the configuration _names_, not one this invocation chose. There is no flag yet                                                           |
| The environment resolver exists but no command uses it                       | The run command is the consumer. Until it lands, that service is specified by its tests                                                                                         |
| A `.tmp` file beside the configuration after a killed `init`                 | The writer writes to a temporary name and links it into place. A crash leaves the temporary, which is inert, identifiable and safe to delete                                    |
| A component-testing project is blocked with `QAT-V002`                       | QAT has no component-test execution path, so refusing is more useful than starting a run that collects the wrong directory                                                      |
| A pre-10 project _with_ component tests is refused                           | The classifier prefers component evidence over the legacy folder, because the alternative error — treating every component project as runnable — is worse                       |
| A configuration at `cypress/nested/cypress.config.ts` is invisible           | The tool lists no directory, by design. The misplaced-configuration probe is a fixed list at one depth                                                                          |
| A `cypress.config.yaml` is invisible                                         | Same reason: finding an unknown extension means listing the directory, and determinism is worth more than the coverage                                                          |
| A corrupt `node_modules/cypress/package.json` is reported as "not installed" | The remedy is the same — install again — and blaming the project's own manifest would be wrong                                                                                  |
| `QAT-V004` never appears                                                     | Nothing verifies the executable yet, and `undefined` is never treated as `false`                                                                                                |
| `qat run` does not exist                                                     | It is the next command, not a missing one. `--help` lists what the tool does, not what it intends to                                                                            |

## 7. Recording the result

A manual pass is evidence only if somebody else can read it. For each section, record:

```
4.6 blocked project — PASS on Windows 11 24H2, Node 24.4.0, Windows Terminal, code page 850.
Output:
  result     blocked
  QAT-V001 error
    A Cypress configuration was found at cypress/cypress.config.ts, where Cypress does not load it.
    at:  cypress/cypress.config.ts
    fix: Move it to the project root as cypress.config.ts.
Notes: the remediation worked as written; the report cleared.
```

```
4.4 initialisation — PASS on the same host.
Output:
  created    /tmp/qat-manual/qat.config.json
Second run:
  exists     /tmp/qat-manual/qat.config.json
Notes: sha256sum identical across the second run. reports/evidence named by doctor, results/ not created.
```

```
4.11 environments — PASS on the same host, all three wordings.
Output:
  env        staging (from defaultEnvironment)
  env        only (the only one declared)
  env        none selected; declare one, or set defaultEnvironment
Notes: the third reads as an instruction rather than a failure, which is right for a valid project.
The unusable-profile case produced no output block and no finding, as §6 records.
```

A `PASS` with no output is a claim, not evidence — the same argument this whole tool makes about a green build.

Never paste a real customer path, a repository name you do not own, or a project directory from a machine that is not
yours. Fabricate the fixture instead; section 3.4 exists for exactly that.

## 8. Raising a defect

A manual finding is worth filing when it meets one of these:

- **The output says something untrue.** A remedy that does not work, a path that is not the one used, a status that
  disagrees with the exit code, a `created` line for a file that is not there.
- **The output says something unreadable.** Not "I would have phrased it differently" — a sentence you cannot act on, or a
  block you cannot scan.
- **A refusal names the wrong thing.** A profile refused for its `variables` map when the mistake was an empty profile, or
  a path refused without naming the field.
- **A platform renders it wrong.** Include the terminal, the code page, and a screenshot if the problem is visual.
- **It contradicts a document.** `docs/` is normative; a behavioural difference between it and the binary is a defect in
  whichever is newer.

A finding is worth _not_ filing when it is in section 6, or when it is a preference about wording with no effect on what a
reader would do next. Those belong in a discussion, and filing them as defects trains people to ignore defects.

## 9. Things that will bite

**A manual pass run against a stale build tests nothing.** `npm run build` before every pass; the binary is not the source
and nothing warns you when the two disagree. This matters more now that `init` writes a file: a stale binary writes a
configuration in the previous format, and every step after it reports something true about the wrong document. The same
trap applies to the profile shape — a binary from before environments became objects will reject a document that the
current one accepts, and the message will be about an unknown field.

**An install failure that leaves a working build.** `npm ci` runs `prepare` _after_ installing dependencies, so a failure
there exits non-zero with a tree that is entirely usable except for the git hooks. The trap works both ways: an
`npm error code 127` looks catastrophic and is not, and a successful `npm run build` afterwards looks like proof the
install succeeded when one step of it did not. Read the exit code and the last script name, not the presence of a working
binary.

**`engines` is a warning, not a gate.** Node 20 satisfies `npm ci` and produces a warning nobody reads, so a pass can run
on a runtime the project does not support and look green. Section 3.1 exists because that happened.

**A fabricated project can be too clean.** It has no lockfile, no workspace, no unusual directory names, and no history.
That is why one pass against a real project matters — it is the only check that sees the shapes the fixtures did not
imagine.

**A rendering defect is invisible in a captured string.** The suite compares arrays of strings; you are comparing what a
terminal drew. If the output looks wrong but the assertions pass, the defect is real and belongs in the presenter — not in
the test.

**Doing 4.4 out of order makes 4.3 meaningless.** The report gained a third block, and it appears only when a
configuration resolves. If you run `init` first, the "nine lines" expectation in 4.3 will not be met and you will spend
ten minutes deciding whether the block is a defect. Delete `qat.config.json` and start again.

**An unusable configuration is invisible, so do not teach people to debug one with `doctor`.** A malformed or invalid
`qat.config.json` produces no finding and no output block, and the report stays green. That is a recorded gap, and until
it closes, a colleague who breaks a profile will look at a clean report and conclude the file is fine. Send them to the
file, or to `qat init`'s refusal message, not to `doctor`.

**The `env` line is not a selection.** It reports what the configuration names as the default, and nothing about the
command being run. Reading it as "this is what `qat run` will use" is the natural mistake — and it will be correct only
once a command exists that can choose differently.

**Section 6 grows.** Every entry is a deliberate decision somebody will be tempted to file again. When you add one, say
what the reason is and where it is recorded, or the next reader will assume it was an oversight and "fix" it.
