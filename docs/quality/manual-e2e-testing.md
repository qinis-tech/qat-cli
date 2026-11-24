# Manual end-to-end testing

|                |                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**     | Normative                                                                                                                                                     |
| **Applies to** | The compiled binary, `dist/cli/index.js`                                                                                                                      |
| **Companion**  | [cli-output.md](../development/cli-output.md), [cli-commands.md](../development/cli-commands.md), [testing-standards.md](../development/testing-standards.md) |

What a human checks that the automated suite cannot, and how to check it the same way twice.

## 1. Why this exists when there is an end-to-end suite

The suite asserts **facts**: exit statuses, which stream a line went to, which finding codes appear, whether the tree
changed. It runs the same binary a person runs, and it would catch a command that stopped failing or a report that lost
a finding.

It cannot judge whether the report **reads well**. It cannot tell you whether `A directory occupies cypress.config.ts,
so no configuration file can exist under that name.` is a sentence somebody can act on at 2am, whether a remedy names a
command that exists, or whether the whole block is legible in a real terminal rather than in a captured string. Those are
the questions this procedure answers, and they are the ones that decide whether the tool is useful.

It also catches a class of defect the suite is blind to by construction: **anything platform-specific that the CI matrix
does not run.** A legacy Windows code page, a terminal that wraps at 80 columns, a path with a space in it that a shell
mangles before the tool ever sees it.

## 2. When to run this

| Trigger                                                | Scope                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| A release candidate                                    | The whole procedure, on at least Windows and Linux                              |
| Any change to the report's wording, labels or ordering | Sections 4.3 to 4.6 — the reading checks                                        |
| Any change to the exit-status mapping                  | Sections 4.3 and 4.7                                                            |
| A CI platform failure you cannot reproduce             | The platform section for that OS                                                |
| Before quoting the README's example output             | Section 4.5, because a README example that no longer matches is worse than none |

Not on every pull request. The suite already runs there, and a manual checklist applied to every diff stops being
applied to any.

## 3. Preconditions

```bash
npm ci
npm run build
node dist/cli/index.js --version
```

The last command must print the version in `package.json`. If it prints a stack, stop: nothing below is meaningful,
and the failure is a build rather than a behaviour.

You need two things besides the repository:

**A scratch project.** Detection reads manifests and directory names, so a fabricated tree is enough and costs nothing
to recreate:

```bash
mkdir -p /tmp/qat-manual/{cypress/e2e,node_modules/cypress}
cd /tmp/qat-manual
printf '{"name":"demo","version":"1.0.0","devDependencies":{"cypress":"^13.15.0"}}' > package.json
printf 'export default {};\n' > cypress.config.ts
printf '{"name":"cypress","version":"13.15.0"}' > node_modules/cypress/package.json
```

**A real Cypress project**, if you have one. It is worth one pass against a project somebody actually maintains,
because a fabricated tree cannot surprise you. Nothing in QAT should invoke Cypress, so the check is cheap: it either
returns in under a second or it is doing something it promised not to.

Record: operating system, Node version, version under test, and the terminal (`cmd.exe`, Windows Terminal, iTerm, GNOME
Terminal). A rendering defect is not reproducible without the last one.

## 4. The procedure

### 4.1 Startup and help

```bash
node dist/cli/index.js --help
node dist/cli/index.js doctor --help
```

**Expect:** the command list with `doctor` and its summary; then usage, the `[directory]` argument, and an `Examples:`
block. Exit `0` for both.

**Read for:** does the command list tell you which command you want? Is the example one you could paste and run? Help
that lists names without saying what they do is help that sends the reader to `man`.

### 4.2 Version and unknown input

```bash
node dist/cli/index.js --version
node dist/cli/index.js docter
node dist/cli/index.js --nope
```

**Expect:** the version on its own line. Then, for `docter`, `QAT1001: Unknown command 'docter'` with
`Did you mean 'doctor'?` and exit `2`. For `--nope`, `unknown option` and exit `2`.

**Read for:** the suggestion. A typo that produces "unknown command" and nothing else costs the reader a lookup; a
suggestion costs the tool an edit distance and turns a dead end into a fix. Check it corrects the mistakes people
actually make — a transposition, a missing letter — not only a prefix.

### 4.3 A supported project

```bash
cd /tmp/qat-manual
node "$OLDPWD/dist/cli/index.js" doctor
echo "exit=$?"
```

**Expect** nine lines — `project`, `root`, `package`, `framework`, `declared`, `config`, `detection`, `compatibility`,
`result` — with `result     ready` last, exit `0`, and **nothing on standard error**.

**Read for:** alignment. The values should sit in one column whatever the label's length; `compatibility` is the longest
and takes a single space. A column that steps in by one is the kind of defect nobody reports and everybody notices.

### 4.4 A project with warnings

Delete the manifest and run the same command:

```bash
mv package.json package.json.bak
node "$OLDPWD/dist/cli/index.js" doctor ; echo "exit=$?"
mv package.json.bak package.json
```

**Expect** `result     ready-with-warnings`, a `QAT-D010 warning` block, and exit `0`.

**Read for:** whether the warning reads as advice rather than as an error. If you would not read past it, the wording is
wrong — and the exit status is deliberately `0`, so the wording is the only thing telling the reader it is survivable.

### 4.5 A project that is blocked

```bash
mkdir -p cypress && printf 'export default {};\n' > cypress/cypress.config.ts
rm cypress.config.ts
node "$OLDPWD/dist/cli/index.js" doctor ; echo "exit=$?"
```

**Expect** `result     blocked`, a `QAT-V001 error` block naming `cypress/cypress.config.ts`, an `at:` line, a `fix:`
line, exit `2`, **and an empty standard error**.

**Read for:** whether `fix:` names something you could do. `Move it to the project root as cypress.config.ts.` is a
one-line fix; `Check your configuration.` is not. Then follow the fix and confirm the report clears — a remedy that does
not work is worse than no remedy, because it has been trusted.

### 4.6 The structured document

```bash
node "$OLDPWD/dist/cli/index.js" doctor --json | jq .assessment.diagnosis.identity
node "$OLDPWD/dist/cli/index.js" doctor --json > /tmp/out.json 2>/tmp/err.txt
wc -c /tmp/err.txt
```

**Expect** one JSON document per invocation, parseable by `jq` with no preprocessing, and an empty `/tmp/err.txt`.

**Read for:** whether the document is the thing you would actually consume. Pipe it through `jq '.assessment.gates'`
and ask whether the shape answers a question you have. If you have to join two fields to learn whether the project can
run, the shape is wrong.

### 4.7 Exit statuses, as a pipeline sees them

```bash
node "$OLDPWD/dist/cli/index.js" doctor >/dev/null 2>&1 ; echo "ready-ish: $?"
node "$OLDPWD/dist/cli/index.js" doctor /nonexistent >/dev/null 2>&1 ; echo "bad argument: $?"
```

**Expect** `2` for both, and — importantly — `1` for neither. `1` is reserved for a failing test, and a tool that
spends it on a missing directory makes a pipeline unable to tell a bad change from a bad command.

### 4.8 Nothing was modified

```bash
find /tmp/qat-manual -newer package.json -type f | sort
```

**Expect:** no output. A detection command that repaired something on the way past would be a different command with a
different name, and the repair happens on whatever machine runs it.

### 4.9 No terminal control in the output

```bash
node "$OLDPWD/dist/cli/index.js" doctor | cat -v
```

**Expect** no `^[` sequences anywhere. Paths and messages can carry text from a file or a subprocess, and a sequence
that clears the screen can make a reader believe output came from this tool. `cat -v` renders an escape as `^[`, so a
clean run has none.

## 5. Platform checks

### Windows

| Check                                                                             | Why                                                                                                                                     |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Run in `cmd.exe` with the default code page (check with `chcp`, often 850 or 437) | A tick, an em dash or an arrow renders as mojibake there. The output is ASCII by design, and this is how you confirm it stayed that way |
| A project under `C:\Users\…\My Projects\demo`                                     | A path with a space is the oldest quoting bug there is, and it fails on Windows before it fails anywhere else                           |
| `qat doctor` from a Git Bash shell as well as `cmd.exe`                           | Two shells, two quoting rules, one argument                                                                                             |
| Redirect with `>` and confirm the file has no stray carriage returns              | Output written with `\r\n` in one place and `\n` in another produces a file that looks right and diffs badly                            |

### Linux

| Check                                               | Why                                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A terminal narrower than 90 columns                 | The report is not wrapped by the tool, so the terminal wraps it. Confirm a wrapped line is still readable and still greppable |
| A project path containing a character outside ASCII | Confirms nothing breaks on a path the tool did not choose — and it is the realistic case for many users                       |

### macOS

Expected to work and not exercised in CI, so this is where a manual pass has the most to find. The one known
platform difference: a process started in `/var/folders/…` reports its working directory as `/private/var/folders/…`, so
the `root` line may differ from the path you typed when the directory came from the process rather than an argument.

## 6. Known behaviour that is not a defect

Read this before filing anything. Each of these is deliberate, and each has a reason recorded somewhere in `docs/`.

| You will see                                                                 | Why it is not a bug                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `specs` or `manager` line in the report                                   | Two facts about a project's _shape_ left the report when it moved to the assessment, which carries _correctness_ facts. Restoring them is a contract change, not a one-line fix |
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
4.5 blocked project — PASS on Windows 11 24H2, Node 24.4.0, Windows Terminal, code page 850.
Output:
  result     blocked
  QAT-V001 error
    A Cypress configuration was found at cypress/cypress.config.ts, where Cypress does not load it.
    at:  cypress/cypress.config.ts
    fix: Move it to the project root as cypress.config.ts.
Notes: the remediation worked as written; the report cleared.
```

A `PASS` with no output is a claim, not evidence — the same argument this whole tool makes about a green build.

Never paste a real customer path, a repository name you do not own, or a project directory from a machine that is not
yours. Fabricate the fixture instead; section 3 exists for exactly that.

## 8. Raising a defect

A manual finding is worth filing when it meets one of these:

- **The output says something untrue.** A remedy that does not work, a path that is not the one used, a status that
  disagrees with the exit code.
- **The output says something unreadable.** Not "I would have phrased it differently" — a sentence you cannot act on,
  or a block you cannot scan.
- **A platform renders it wrong.** Include the terminal, the code page, and a screenshot if the problem is visual.
- **It contradicts a document.** `docs/` is normative; a behavioural difference between it and the binary is a defect in
  whichever is newer.

A finding is worth _not_ filing when it is in section 6, or when it is a preference about wording with no effect on what
a reader would do next. Those belong in a discussion, and filing them as defects trains people to ignore defects.

## 9. Things that will bite

**A manual pass run against a stale build tests nothing.** `npm run build` before every pass; the binary is not the source
and nothing warns you when the two disagree.

**A fabricated project can be too clean.** It has no lockfile, no workspace, no unusual directory names, and no history.
That is why one pass against a real project matters — it is the only check that sees the shapes the fixtures did not
imagine.

**A rendering defect is invisible in a captured string.** The suite compares arrays of strings; you are comparing what a
terminal drew. If the output looks wrong but the assertions pass, the defect is real and belongs in the presenter — not
in the test.

**Section 6 grows.** Every entry is a deliberate decision somebody will be tempted to file again. When you add one, say
what the reason is and where it is recorded, or the next reader will assume it was an oversight and "fix" it.
