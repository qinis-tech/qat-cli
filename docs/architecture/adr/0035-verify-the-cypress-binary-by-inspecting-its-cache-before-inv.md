# ADR-0035: Bound the binary check's execution surface to `cypress verify`

Date: 2026-11-26

## Status

Accepted

## Context

The doctor must answer one question about Cypress: is there a downloaded binary for the installed version, and can it be
run? It is asked on every `qat doctor` invocation, including the one a user runs _because_ something is already wrong, so it
has to be fast, work offline, and never make things worse.

The facts that make this awkward:

- The binary is not in the project. It lives in a **version-keyed cache** outside it — `~/.cache/Cypress`,
  `~/Library/Caches/Cypress`, `%LOCALAPPDATA%\Cypress\Cache` — overridable with `CYPRESS_CACHE_FOLDER`. It is roughly
  150 MB and is fetched by a post-install step that is frequently skipped: `--ignore-scripts`, a read-only cache mount in CI,
  an offline image, a slim container that runs `npm ci --ignore-scripts`.
- The entry point differs per platform (`Cypress.app/Contents/MacOS/Cypress`, `Cypress/Cypress`, `Cypress.exe`), so any
  answer must be computed per platform rather than assumed.
- `npm ci` succeeding tells you nothing. That combination — installed package, missing binary — is the failure users
  misdiagnose most often in this area: they reinstall Node, upgrade Cypress, or blame CI, and none of those is the fix.
- Every cheap way to _prove_ the binary works involves running something the project controls: the downloaded binary itself,
  the project's installed Cypress CLI, or the suite.

Constraints in force: the check must not modify the project or the cache; it must not execute spec files; it must remain
testable from values rather than from a disk; and the whole `qat doctor` run has a responsiveness budget of seconds, so a
30-second worst case has to be a fallback rather than the normal path.

Prior decisions that shape the answer: a non-zero exit status is a result about the environment rather than a defect in QAT
(ADR-0007); detection is separate from validation (ADR-0018); and a check whose precondition failed is skipped, not failed
(ADR-0032).

## Decision

We will treat `cypress verify` as the only thing this diagnostic may execute, and reproduce Cypress's own cache layout to
answer the question statically so that even that command is the exception rather than the rule.

Concretely: the check resolves the cache root (`CYPRESS_CACHE_FOLDER` when absolute, otherwise the platform default), joins
the resolved version and the platform entry, and inspects the file — existence, file-ness, execute permission on POSIX, and a
non-empty size on Windows, which has no execute bit. Only when that evidence is ambiguous does it run the project's installed
Cypress CLI with the frozen argument list `['verify']`, through the shared process runner, with `shell: false`, a 30-second
hard timeout and a 2 KiB output cap. `cypress run` and `cypress open` are never invoked, at any point, by any code path in
this check.

Every result records which method produced it (`verifiedBy`), so "a file with execute bits" and "Cypress started it" are
never presented as the same strength of claim.

## Consequences

**Easier**

- The common case costs a `stat` and an `access`: single-digit milliseconds, no child process, and it works with no network.
- The check is honest offline. A cached binary in an air-gapped CI image is verified without anything being downloaded.
- No spec file is ever executed, so the check cannot fail for a reason that belongs to a test.
- The static path is a pure function of a path and a set of filesystem answers, so every installation state is testable from
  fixtures with no real binary — which is why the whole matrix (absent, non-executable, wrong version, present) is covered.
- `verifiedBy` in the evidence means a reader can calibrate the claim instead of assuming the strongest reading.

**Harder**

- **We now own a copy of someone else's layout.** The cache root, the version directory and the three platform entries are
  facts about Cypress, restated in our code. When Cypress changes them, our check reports a binary as missing when it is not —
  the worst kind of wrong answer for a diagnostic. This has already bitten us once: the cache root was derived by walking two
  directories up from the binary path, which is correct on Linux and four segments short on macOS.
- **A binary can be present and subtly broken and we will call it accessible.** Static inspection proves a file with
  permission bits, nothing more. We mitigate by publishing `verifiedBy`, but that mitigation is only as good as the reader
  who notices it — and a report whose pass means "might work" is a weaker claim than most people expect from a pass.
- **The fallback still spawns project-controlled code.** `cypress verify` runs the CLI the project installed. The timeout,
  `shell: false`, the frozen argument list and the output cap bound the risk rather than removing it, and there is a
  supply-chain surface here that a `stat` does not have.
- **Two code paths, and a translation between them.** Static evidence and a probe result have to be folded together, which
  needed `applyProbeResult` and a rule that "unverified" downgrades the verdict rather than confirming or denying it.
- **A 30-second worst case inside a command with a seconds-scale budget.** Only on the fallback path, but it exists, and the
  timeout is a judgement call that will look too long to some environments and too short to cold filesystems.
- **Windows gets a weaker test.** No execute bit means "non-empty file" is all we can assert statically, so the platform with
  the most variety in how binaries are launched is the one we check least.

**Neutral**

- Probe output is not shown verbatim: it is whitespace-collapsed and truncated to the last 300 characters, because the
  actionable line is nearly always last and the full transcript belongs in a log rather than in evidence.
- The macOS entry is four segments deep, which makes any "walk up from the binary" arithmetic wrong; the root is now resolved
  once and reported, not re-derived.

## Options considered

| Option                                                    | Why not                                                                                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Probe with `cypress run --spec` on a throwaway spec       | Executes the user's project and its configuration, takes minutes, and can open a browser. A diagnostic that runs tests is a test runner with a stethoscope.                                            |
| Run `cypress info`                                        | Spawns a process to answer what a `stat` answers, and does it on every doctor invocation rather than as a fallback.                                                                                    |
| Invoke `node_modules/.bin/cypress`                        | A POSIX symlink and a Windows `.cmd` shim — replaceable, and divergent between platforms. Passing the resolved package's own entry file to the current Node interpreter is unambiguous; `.bin` is not. |
| Launch the binary and see what happens                    | Unbounded, unoffline, and executes project-controlled code on the normal path rather than as a last resort.                                                                                            |
| Infer from `node_modules/cypress` existing                | That is the exact false positive this check exists to catch: the package is present and the 150 MB binary is not.                                                                                      |
| Treat "cannot determine the cache" as a warning-free pass | An unanswered question counted as health is how a report blesses a runtime it never inspected. It is reported as indeterminate and never counted as clean.                                             |

## References

- Cypress cache-folder documentation (`CYPRESS_CACHE_FOLDER`, per-platform cache roots).
- [ADR-0007](0007-treat-a-non-zero-exit-code-as-a-result-not-an-error.md) — a non-zero exit status is a result about the
  environment.
- [ADR-0032](0032-skip-a-check-whose-precondition-failed-rather-than-reporting.md) — a check whose precondition failed is
  skipped, not failed.
- [Cypress health checks](../cypress-health-checks.md) — the six conditions, the reason codes and the published evidence.
