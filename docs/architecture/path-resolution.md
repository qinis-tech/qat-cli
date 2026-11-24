# Path resolution

|                  |                                                                                                                                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**       | Normative                                                                                                                                                                                                                                                                                                       |
| **Module**       | `src/config/resolver/paths.ts`                                                                                                                                                                                                                                                                                  |
| **Entry points** | `resolvePath(value, options)`, `isWithinProjectRoot(absolute, root, tools?)`, `describePathIssue(code, context)`, `PATH_ISSUE_TEMPLATES`                                                                                                                                                                        |
| **Companion**    | [configuration-defaults.md](configuration-defaults.md), [configuration-loading.md](configuration-loading.md), [configuration-precedence.md](configuration-precedence.md), [cli-output.md](../development/cli-output.md), [ADR-0027](./adr/0027-apply-defaults-only-to-omitted-fields-and-resolve-paths-agai.md) |

Turning a path a reader wrote into the absolute location a writer needs — without ever consulting the process working
directory.

## 1. The rule: anchor, never resolve

> **A relative path is joined to the project root. It is never resolved against the process working directory.**

The distinction is a single function call, and it is the whole of this module:

```ts
pathTools.normalize(pathTools.join(projectRoot, source)); // this module
path.resolve(source); // never
```

`path.resolve` takes one argument and behaves as though it took two: the second is `process.cwd()`, supplied silently. The
consequence is that the same configuration file writes to `/home/ana/results/reports` from a shell and
`/builds/app/results/reports` in continuous integration, and neither run says anything about it. That is not a portability
nicety — it means two runs of one project cannot be compared, and a report's location becomes a fact about the machine
rather than about the project.

Anchoring also makes the function pure: a document and a root in, a value out. No clock, no environment lookup, no
filesystem access. That is why it is cheap enough to call on the discovery path and why its tests need no temporary
directories.

## 2. Two forms of one path, and they say different things

A resolved path carries both:

| Member              | What it is                                                | Who reads it                                              |
| ------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| `source`            | Exactly what the reader wrote, or what a default supplied | Diagnostics, so a message can quote the reader's own text |
| `absolute`          | A canonical absolute path                                 | Writers, and anything that opens a file                   |
| `form`              | `"relative"` or `"absolute"`, the form of the _input_     | Anything explaining what happened                         |
| `withinProjectRoot` | Whether the anchored path is the root or beneath it       | The containment decision, recorded rather than recomputed |

**`absolute` is canonical.** One location has one spelling: interior `.` and `..` are collapsed, doubled separators are
collapsed, and a trailing separator is removed. `"reports/"` and `"reports"` therefore produce the same value — equal by
`===`, identical in a log line, and the same key in a report document. Two spellings of one directory is a defect that
only shows up much later, when something compares or deduplicates them.

The two filesystem roots keep their separator. Removing it changes what the path means: `/` would become the empty
string, and `C:\` would become `C:`, which is not the drive root but a _drive-relative_ path — a different and much worse
value than the one the reader wrote.

**`source` is verbatim.** A diagnostic that echoed a normalised path would hide the trailing space or the doubled
separator that caused the problem. The reader needs to see what they typed, not what the tool made of it.

## 3. Three policies, because three fields want different rules

A path rule is data, not a branch at the call site. `PathFieldPolicy` has three booleans, and every field names one:

| Policy                       | Absolute allowed | Must stay inside the project | Used for                                       |
| ---------------------------- | ---------------- | ---------------------------- | ---------------------------------------------- |
| `PROJECT_OUTPUT_PATH_POLICY` | no               | yes                          | `output.reports`, `output.evidence`            |
| `PROJECT_INPUT_PATH_POLICY`  | yes              | yes                          | `cypress.configFile`                           |
| `EXTERNAL_INPUT_PATH_POLICY` | yes              | no                           | nothing today — available, deliberately unused |

Output directories are relative-only because they are reviewed in a diff and travel with a run: an absolute path there is
almost always a typo aimed at somebody else's directory. A path the tool merely _reads_ may be spelled either way, but
reading outside the project is a different feature with different review requirements, not an accident to tolerate — which
is why the external policy exists as a named constant and is not applied to anything. Enabling it later is a one-line
change at one call site, and a visible one.

The policy is a **required** argument. A path rule that is not stated where the path is resolved is a rule nobody can
review.

## 4. The eleven refusals

Every way a configured path can be rejected, in the order the checks run:

| Code                          | Means                                                 | What the reader does                                  |
| ----------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| `PATH_NOT_A_STRING`           | The value is a number, object, list, `null` or absent | Write it as text                                      |
| `PATH_EMPTY`                  | Empty or whitespace only                              | Remove the field to accept the default, or set a path |
| `PATH_SURROUNDING_WHITESPACE` | Leading or trailing spaces                            | Remove them; they become part of the directory name   |
| `PATH_NUL_BYTE`               | Contains U+0000                                       | Remove it; it cannot appear in a file path            |
| `PATH_TOO_LONG`               | Over 4096 characters                                  | Shorten it                                            |
| `PATH_BACKSLASH_SEPARATOR`    | Uses `\`                                              | Use forward slashes so the file works on every system |
| `PATH_HOME_ALIAS`             | Starts with `~`                                       | Write a path relative to the project root             |
| `PATH_FILE_URL`               | Looks like a URL (`file:`, `s3:`, …)                  | Write a filesystem path                               |
| `PATH_DRIVE_RELATIVE`         | Windows drive-relative, e.g. `C:reports`              | Fully qualify it, or make it project-relative         |
| `PATH_ABSOLUTE_NOT_PERMITTED` | Absolute where the policy requires relative           | Write it relative to the project root                 |
| `PATH_OUTSIDE_PROJECT_ROOT`   | Anchors outside the root, e.g. `../reports`           | Use a path inside the project                         |

Each issue carries `field`, `value`, `projectRoot`, a one-sentence `message` and a `hint` saying what to write instead.
`severity` is `"error"` for all of them today: every rule here is structural, and a path that breaks one cannot be used
safely. It stays a field so that a future relaxation — a warning for a redundant `../` — is a data change rather than a
signature change.

The catalogue is a `Record` over the code union, so a code added without a message is a compile error. The application
cannot ship a refusal the reader is unable to act on.

## 5. The order the checks run in carries meaning

```
shape  ->  portability  ->  policy  ->  containment
```

A value rejected at the shape stage never reaches path arithmetic, which keeps hostile input out of `join()`. And the
order is chosen so the reported reason is the one the reader should fix first:

- **Backslash before drive-relative.** A reader who pasted `C:\reports` should be told the portable spelling, not
  lectured about drive qualification.
- **Length before portability.** A 5000-character value needs shortening before anything else it contains matters.
- **Shape before everything.** `42` is not a badly-formed path; it is not a path.

One issue per value, not a list. A path has a single problem to fix, and reporting three consequences of one cause makes
the shortest fix look like the hardest.

## 6. Containment is a path question, not a string question

`isWithinProjectRoot` compares **segments**, using `relative()`, rather than prefixes:

```ts
const relativeToRoot = pathTools.relative(
  pathTools.normalize(projectRoot),
  pathTools.normalize(absolute),
);
return (
  relativeToRoot !== ".." &&
  !relativeToRoot.startsWith(`..${pathTools.separator}`) &&
  !pathTools.isAbsolute(relativeToRoot)
);
```

Both of the obvious string tests are wrong, in opposite directions:

| Test                         | `/work/proj-cache` against `/work/proj` | `/work/proj/..data`             |
| ---------------------------- | --------------------------------------- | ------------------------------- |
| `candidate.startsWith(root)` | **inside** — a neighbouring checkout    | inside, correctly               |
| `!relative.startsWith("..")` | outside, correctly                      | **outside** — a legitimate name |
| segment comparison           | outside                                 | inside                          |

The first is how evidence ends up in someone else's directory. The second is how a directory legitimately named `..data`
gets refused. Neither is a security hole in the abstract; both are defects that appear once and are then trusted.

`win32.relative()` compares case-insensitively, which is correct on a case-insensitive filesystem: `C:\WORK\PROJ\out` is
inside `C:\work\proj`.

**The check is lexical.** Symlinks are not followed. A path that is inside the root and symlinked out of it passes here.
Resolving real paths is I/O, and it belongs to the filesystem layer where an I/O boundary already exists — not to a pure
function that the discovery path is allowed to call.

## 7. Portability across machines

A configuration file is committed and shared, so a path in it must mean the same thing on another operating system.

| Refused                | Because                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `evidence\screenshots` | A backslash is a separator on one platform and a legal filename character on others             |
| `~/reports`            | Home expansion would make the configuration machine-specific, and reports land in a home folder |
| `file:///tmp/reports`  | A URL is not a path. `s3://…` and similar are not filesystems this tool writes to               |
| `C:reports`            | Relative to the current directory _on a drive_ — machine state, not intent                      |

Forward slashes are the spelling, and `join` converts them to the platform's separator on the way out. That way one file
works everywhere and no rule has to be written twice.

**A URL is described, never echoed.** Every other refusal quotes the offending value — a trailing space is the defect, and
printing it is the fastest way to see it. A URL is the one path-shaped string that routinely carries a credential in its
userinfo (`s3://key:secret@bucket/…`), and a diagnostic is the one string guaranteed to be logged and pasted into an issue.
So `PATH_FILE_URL` names the field and says nothing else. See [cli-output.md](../development/cli-output.md) §7.

## 8. Windows, specifically

| Case                         | Treated as                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `C:\work\proj\out`           | Absolute, inside the root                                                    |
| `C:/work/proj/out`           | Absolute, normalised to backslashes                                          |
| `C:\WORK\PROJ\out`           | Inside — containment compares case-insensitively                             |
| `D:\reports`                 | `PATH_OUTSIDE_PROJECT_ROOT` — `relative()` cannot cross drives               |
| `\reports` (no drive letter) | `PATH_OUTSIDE_PROJECT_ROOT` — it anchors to whatever drive the process is on |
| `C:reports`                  | `PATH_DRIVE_RELATIVE`                                                        |

The no-drive-letter case is the interesting one: the path _looks_ absolute to `win32.isAbsolute`, and it is anchored to
machine state. Rather than accept a path whose meaning depends on which drive a shell happened to be in, it fails
containment and says so.

None of this needs a Windows machine to test. `posixPathTools` and `win32PathTools` are injectable, so every rule above is
exercised on every runner — the operating-system matrix is a second opinion, not the first.

## 9. Who decides what, and where the second line sits

Two layers refuse a bad configured path, and it is worth being precise about which is which.

| Question                                          | Decided by                          | When           |
| ------------------------------------------------- | ----------------------------------- | -------------- |
| Is this field a relative path inside the project? | `relativeProjectPath` in the schema | While parsing  |
| Where does an admissible relative path point?     | This module                         | When resolving |
| Is an absolute path allowed for this field?       | The field's `PathFieldPolicy` here  | When resolving |

In practice a document that reaches this module has already had its paths judged: an escaping or absolute `output.*`
value is refused by the schema and never arrives. This module's containment check therefore exists as a **second line of
defence**, for a branded document that skipped validation — a state the runtime cannot rule out, because the brand proves
a document loaded, not that every consumer used the loader it came from.

The check is cheap and it is not redundant: if the two layers ever disagree, this one refuses rather than writing outside
the project. That is the correct failure for the case.

## 10. What this module does not do

| Not done                     | Because                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| Read or write the filesystem | Purity is what lets it run on the discovery path and be tested without temporary directories  |
| Check that a path exists     | Existence is a fact about a moment, and a check here would be stale before it was used        |
| Create the directory         | Directories are created by the operation that first writes — see §11                          |
| Follow symlinks              | Real-path resolution is I/O; the containment check is lexical and says so                     |
| Expand `~` or variables      | A configuration is data, not a shell script; both would make the file machine-specific        |
| Normalise case               | Except inside `win32.relative()`, where the platform itself is case-insensitive               |
| Decide what a field means    | It anchors `output.reports`; it does not know that reports are HTML or that evidence is a PNG |

## 11. Which directories get created, and by whom

This module **names** directories; it never creates them. `outputDirectories(resolved)` returns the two absolute paths, and
the writer that has something to write calls `ensureDirectory` immediately before its first write.

The alternative — creating them during initialisation — leaves empty `results/` trees in projects that never ran, adds them
to every diff, and survives a setup that failed halfway. A project that has been initialised but never run contains
exactly one file: its configuration.

Note that the default output paths are two segments deep (`results/reports`), so the helper must create parents. A
single-level `mkdir` would fail on the first real run and pass every test written against a single-segment path.

## 12. Three things throw

Everything a reader can fix is an `issue` on the returned value. Three things are not:

| Thrown      | When                               | Why not an issue                                                                                      |
| ----------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `TypeError` | `projectRoot` is empty or relative | A relative root reintroduces the working directory; it is a wiring defect, not something a user wrote |
| `TypeError` | `field` is empty                   | A finding with no location cannot be rendered usefully                                                |
| —           | _(nothing else)_                   | —                                                                                                     |

A relative root is the one defect that would silently restore the exact behaviour this module exists to remove, and it
would do so invisibly, so it fails loudly with a stack that points at the caller.

## 13. Testing

| Scenario                                 | Asserted                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Anchoring, eight spellings               | `anchors %s to the project root` — including `.`, `./`, a trailing separator and `results/../reports`            |
| Source preserved, absolute canonicalised | `keeps the source exactly as the reader wrote it` and `anchors a trailing separator…`                            |
| Absolute paths                           | Refused for output, accepted for input, still contained                                                          |
| Containment, seven cases                 | The sibling-prefix trap and the `..data` trap, each named                                                        |
| Shape                                    | Six non-strings, five empty or padded values, one NUL byte                                                       |
| Portability                              | Three backslash forms, a home alias, two URL forms — and one case asserting a URL is not echoed                  |
| Boundaries                               | Exactly 4096 accepted, 4097 refused, and an over-long value that also has a backslash reports the length         |
| Windows, six cases                       | Anchoring, forward-slash absolutes, case-insensitive containment, another drive, no drive letter, drive-relative |
| Programmer errors                        | A relative root and an empty field both throw                                                                    |
| Every code                               | A template that names the field, ends in a sentence, and offers a remedy                                         |
| Non-functional                           | Synchronous, frozen results, independent of `process.cwd()`, ten thousand resolutions without accumulating state |

The Windows cases run through injected tools rather than the host, which is what makes them assertions instead of
wishes on a runner that happens to be Windows.

## 14. Things that will bite

**`path.resolve` will look like a simplification.** It collapses `..` and joins, in one call, and its signature invites it.
The reason it cannot be used is not stylistic: the second argument is the working directory, and the bug it produces is
silent. The test that changes `process.cwd()` between two resolutions exists to make that failure immediate.
.

**A trailing separator is invisible until something compares two paths.** The canonical form exists because
`results/reports/` and `results/reports` are the same directory and two different strings. Anything that deduplicates,
keys or asserts on paths meets the difference eventually, and the reason will be three layers away.

**Containment is lexical, and the doc says so twice.** A path inside the root that symlinks outside passes. If a
writer needs the real-path guarantee, it needs an I/O check, and that check belongs where the write happens — not here,
where the absence of I/O is what makes the function usable at discovery time.

**The schema has usually already refused it.** When a path bug is reported, the first question is which layer saw it: a
message quoting `QAT-C006` came from validation, and one quoting a `PATH_*` code came from here. The field name is the same
in both, which makes the two easy to confuse.

**`EXTERNAL_INPUT_PATH_POLICY` is unused, and that is a decision.** Enabling it turns "may read outside the project" from
a refusal into a setting, which changes what a configuration file can do on another machine. If it is ever applied, it
should be with a note here saying why that trade was made.

**The 4096-character bound is not a platform limit.** It is a bound chosen so a hand-written field that long fails with a
sentence instead of an `ENAMETOOLONG` from the kernel halfway through a run. Do not raise it to match a filesystem; raise
it if a legitimate configuration genuinely needs it, which is unlikely.
