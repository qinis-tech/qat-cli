# ADR-0024: Treat a missing configuration as a result rather than a failure

Date: 2026-11-24

## Status

Accepted

## Context

Locating a project's configuration file has to answer one question: is there one here? Three situations produce "nothing
usable", and until now nothing had decided whether they are one answer or three.

The first is that the file is not there. That is legal — a project that has never been configured is the ordinary state,
and the defaults apply. The second is that the name is occupied by something that is not a file: a directory where a
configuration should be, most often from a checkout that lost the file and kept the folder, or a generator that wrote a
directory where a document belonged. That is a defect, the reader can fix it, and the fix is one line once they know what
is there. The third is that the filesystem could not answer at all: a permission problem, a failing disk, a symlink loop.
That is a property of the machine rather than of the project.

The obvious implementations cannot tell these apart. A boolean — this repository's filesystem helpers return one — reports
`false` for all three, and three of them need different sentences: _nothing is configured_, _a directory is occupying the
name_, _I could not look_. A thrown error can carry the difference, at the cost of making the first case exceptional, and
the first case is the one that happens on every project that has never been configured. A caller that treats an exception
as absence will catch the permission failure too and apply defaults to a project it could not read.

The repository has one precedent pointing each way. Detection answers with a verdict and evidence rather than throwing —
see ADR-0018 — and that arrangement exists because a report has to describe a project it cannot use, which requires the
diagnosis rather than an exception. The same argument applies here in a smaller form: a command that reports what it can
see should be able to say "no configuration, defaults apply" without catching anything. Against it, an exception is the
idiom for "this module could not do its job", and a locator that returns a result for absence asks every caller to
handle a variant most of them will treat as the normal path anyway.

What makes the decision awkward is that nothing consumes it. There is no loader, no command reads a configuration, and a
boolean would therefore be sufficient today. The shape is being chosen for callers that do not exist yet, which is a
weaker position than choosing it because something broke.

Two facts narrow the space. The format decision — ADR-0024 — established that there is one file, at the root, with no
ascent and no override, so there are no candidates to rank, no search to report on, and no precedence to explain. And the
error model already has categories for both failures that remain: bad input and a filesystem failure. No new vocabulary
is needed to distinguish them.

## Decision

We will return a missing configuration as one of three results, and throw only when the filesystem could not answer.

`locateConfiguration` returns `found` with the absolute path, `absent` with the root that was searched, or `not-a-file`
with the path and what occupies it. A permission failure, a broken disk or a symlink loop throws a filesystem error; a root
that is not a directory throws an invalid-argument error. Neither is a project condition, and both are properties of the
machine or of the caller rather than of what is on disk.

Absence carries the root so a caller reporting it does not re-derive it, and the two root failures carry different
messages — _does not exist_ and _is not a directory_ — because they have different fixes.

The module reaches for `stat` rather than the filesystem helpers, because the helpers answer a yes-or-no question and this
service has a question with four answers. A helper that returned `false` for a permission failure would undo the whole
decision at the call site that matters.

The service takes no path parameter. There is no way to ask it to look somewhere else, which is what makes "one file at
the root" a property rather than a convention.

## Consequences

**Easier**

- The ordinary case is not exceptional, so it is testable and it is tested. A project with no configuration is a normal
  input, not an error path nobody exercises.
- The three situations cannot be conflated by accident. A caller with an exhaustive `switch` over the result has to decide
  what each means for its own command.
- A directory on the configuration filename becomes a finding with a remedy rather than a "no configuration" message that
  sends the reader to look for something they are standing on.
- The failure that is genuinely exceptional — the filesystem refusing to answer — arrives as an exception, which is what
  exceptions are for and what the existing exit-code categories already describe.
- A command that reports can describe a project with no configuration without catching anything, the same shape reporting
  already has for detection.
- The absent answer carries its root, so the sentence "no configuration in _this_ directory" is available without the
  caller keeping a second copy of the path.

**Harder**

- **Every caller pays for the third variant.** A command that wants the file or the defaults — which will be most of them
  — has to decide what `not-a-file` means for _it_, and two commands may reasonably decide differently: one refuses, one
  reports and continues. A boolean would have been one line at each call site.
- **The exhaustiveness is a property of how the caller writes, not of the type.** A discriminated union is only checked
  when it is switched over exhaustively; a caller that writes `if (result.kind === 'found')` treats `absent` and
  `not-a-file` as the same silent path, which is the collapse this decision exists to prevent. Nothing can enforce the
  caller's shape.
- **The distinction survives only while the probe is hand-written.** Any future simplification that replaces the `stat`
  call with `isFile` reinstates the collapse, and it will look like a cleanup rather than a regression. The comment in the
  implementation is the only guard.
- **The module now depends on two platform error codes.** `ENOENT` and `ENOTDIR` are treated as absence, and every other
  code is an error. A filesystem that reports a third code for a missing path — a network mount returning an I/O error for
  an unreachable parent, say — becomes a failure rather than an absence, and the reader sees a filesystem error where they
  have no configuration.
- **Nothing consumes it, so the shape is a guess about what callers want.** The first loader may well ask for a two-variant
  result and convert `not-a-file` into its own error — which would make the third variant ceremony, and the record wrong
  about what was needed.
- **A caller that wants absence to be an error must write that error itself**, in its own words, with its own remedy. This
  is the cost of not having a code for it: the vocabulary stops at "there is no configuration" and every caller that
  disagrees invents the next sentence.
- **The absent answer is thin.** No candidates, no searched paths, no suggestion of where a configuration might live.
  Deliberately — there is only one place it could be — but it is a smaller answer than the diagnostics elsewhere in this
  codebase, and a reader who expected more will file it as a gap.

**Neutral**

- No new error code. The bad-root failure reuses the invalid-argument code and the filesystem failure reuses the
  filesystem one, so a caller that only reads exit statuses sees the categories it already knows.
- Two `stat` calls per discovery: one for the root, one for the candidate. Bounded, and cheap enough that caching them
  would be the more expensive decision.
- Symlinks are followed, because `stat` follows them. That behaviour is not decided here — it is a consequence — and it is
  recorded in the design document with its trigger.
- The result is a snapshot of the filesystem at the moment of the call, with no cache, so two calls can differ if
  something changed between them. That is the correct behaviour and it is why there is no memoisation.

## Options considered

| Option                                                                    | Why not                                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Throw for absence, the way a missing required file usually is             | Makes the ordinary case exceptional. Every caller catches, every one decides what to do, and a caller that catches too broadly applies defaults to a project it could not read                                   |
| Return a boolean                                                          | `false` is four situations wearing one word: absent, a directory, a device, a permission failure. Three of them need different sentences                                                                         |
| Return `found` or `undefined`                                             | Shorter, and `undefined` cannot say why. A directory on the name becomes indistinguishable from absence, which is the case that most needs a message                                                             |
| Return a result but only for absence, throwing for a directory            | The useful finding becomes an exception, so a command that wants to _report_ it must catch — and that is the whole reason a reporter needs a result                                                              |
| Return an error-valued result for every failure, including the filesystem | The same collapse in a result type: a reader still cannot tell "no configuration" from "could not read the directory", and the top-level handler loses the ability to treat the second as an environment failure |
| Return the two candidates and let the caller pick                         | There is one candidate name. A list would be a shape invented for a case the format decision forbids                                                                                                             |

## References

- `docs/architecture/configuration-discovery.md` — the three answers, what is not searched, and the two known limits
- `src/config/discovery/contracts.ts` — the result union
- `src/config/discovery/locate.ts` — the probe, and why it is not the filesystem helper
- ADR-0024, which established one file at the root and is what makes a three-answer result sufficient
- ADR-0018, which made detection return a verdict rather than throwing, on the same argument in a larger form
- ADR-0004, which categorised exit codes and is why neither exception here needs a code of its own
