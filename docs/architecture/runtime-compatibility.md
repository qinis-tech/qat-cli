# Node.js runtime compatibility

This document is the normative description of how QAT decides whether the Node.js runtime it is executing on is
supported, and what it reports when it is not. It is the reference for the check `runtime.node-version`, for the
advisory `cypress.runtime-supported`, and for the three `QAT-H` codes they can raise.

Read it before changing a supported version, adding a version comparison anywhere, or adding a second consumer of "what
Node does this build support".

Related: [ADR-0033](./adr/0033-derive-the-supported-node-js-range-from-the-package-engine-d.md),
[doctor checks](doctor-checks.md), [diagnostics](diagnostics.md), [error model](error-model.md),
[testing architecture](../quality/testing-architecture.md).

---

## 1. The question, and why it has three answers

A runtime check looks like a boolean and is not one. Every observation can end three ways:

| Outcome           | Meaning                                                       | Consequence                                                   |
| ----------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| **satisfied**     | the runtime was read and belongs to the supported set         | `Passed`, no finding                                          |
| **unsatisfied**   | the runtime was read and does not belong to the supported set | `Failed` for QAT's own requirement, `Warned` for the advisory |
| **indeterminate** | the question could not be answered                            | `Warned`, with a finding that says why                        |

The third answer is not a formality. Treating "I could not read the version" as success is how a green build ships on a
runtime nobody tested; treating it as failure blocks work on the strength of an unanswered question. Both are wrong, so
it is reported and it never counts as clean.

`REASON_STATUS` in `src/core/compatibility/contracts.ts` is the single table mapping reasons to outcomes, and it is
exhaustive by construction: adding a reason without deciding its status does not compile.

---

## 2. The single authority for the supported range

The supported range is declared **once**, in this package's own `package.json`:

```json
{
  "engines": { "node": ">=20.11.0 <21" }
}
```

Why this field, and not a constant:

- a package manager already enforces it on install, so it is not a fresh claim invented for diagnostics;
- it travels with the published artefact, so a globally installed copy carries its own policy;
- it is the one place a release changes when the supported runtime changes.

**No other file may state, restate, narrow or default the range.** That includes prose, CI matrices, documentation
examples and test fixtures. A copy is a copy that drifts, and the drift surfaces as a support claim no test covers.

Two constants were removed to keep this rule true, and both removals are worth remembering:

| Removed                     | Where it lived                               | Why it was a duplicate                                                                                                                    |
| --------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `MINIMUM_NODE_MAJOR`        | the checks layer's guidance                  | a support policy restated from `engines.node`, kept honest by a test comparing the two numbers — a two-place edit on every support change |
| the inline major comparison | the catalogue's `runtime.node-version` entry | an arithmetic in a second place that the version policy could disagree with                                                               |

A version constant that is _not_ a policy restatement is legitimate: `MINIMUM_CYPRESS_MAJOR` records that Cypress 10
introduced `cypress.config.*`, which is a fact about a file format and is declared nowhere else. The rule is _state no
policy twice_, not _delete every version constant_.

### 2.1 Which manifest, and why that is not obvious

`qat doctor` runs **inside a user's project**. `process.cwd()/package.json` therefore belongs to the user, and reading
its `engines.node` would make QAT's support policy depend on whichever project it was pointed at — a project declaring
`>=22` would make QAT claim to support 22.

The reader (`src/shared/utils/package-manifest.ts`) resolves the manifest from **its own module location**, three levels
up. That is the manifest installed alongside the code, and the one a package manager read when it decided whether to
install us at all.

If the manifest is missing or unreadable, the reader returns `undefined` and the requirement is built with an **empty
range**. That is reported as unreadable policy — a visible warning on the one command a user runs _because_ something
is wrong, rather than a crash from it. Publication is guarded separately: a contract test and the package verification
script both fail when `engines.node` is absent.

---

## 3. Detection

`process.versions.node` is read, in-process, through the `RuntimeProbe` port (`src/core/environment/runtime.ts`).

Not `node --version`, for three reasons:

1. **Correctness** — a child process reports the first `node` on `PATH`, which may be a different binary from the one
   running this code (nvm, fnm, volta and wrapper scripts all make that routine). Reporting on the wrong interpreter is
   worse than not reporting at all, because the message is confident.
2. **Cost** — a spawn costs tens of milliseconds; a property read costs nothing, and diagnostics has a tight
   responsiveness budget.
3. **Reliability** — a spawn can fail for reasons unrelated to compatibility (`ENOENT`, `EPERM`, a broken path), and
   that failure would then be reported as a runtime problem.

The probe returns the version **unparsed and unnormalised**, and returns `undefined` when the host reports nothing.
Absence is a distinct answer from malformed, and the two produce different messages.

There is no environment variable that overrides the detected version, and this is deliberate: an override would let CI
fake compatibility and turns a safety check into a checkbox. Tests inject the port instead.

---

## 4. Accepted range grammar

The grammar is small, documented, and **refused** rather than guessed at outside its bounds.

```
range       := alternative ( "||" alternative )*
alternative := comparator+
comparator  := operator? version
operator    := ">=" | "<=" | ">" | "<" | "=" | "^" | "~"     (default "=")
version     := MAJOR.MINOR.PATCH ( "-" prerelease )? ( "+" build )?
```

| Accepted                      | Semantics                                                     |
| ----------------------------- | ------------------------------------------------------------- |
| `>=20.11.0 <21`               | floor and exclusive ceiling, space-separated (AND)            |
| `>=20.11.0 <21 \|\| >=22.0.0` | alternatives (OR)                                             |
| `^20.11.0`                    | `[20.11.0, 21.0.0)`                                           |
| `^0.4.2`                      | `[0.4.2, 0.5.0)` — zero major never crosses a minor           |
| `^0.0.3`                      | `[0.0.3, 0.0.4)` — zero major and minor never crosses a patch |
| `~20.11.0`                    | `[20.11.0, 20.12.0)`                                          |
| `>=20.11.0` and `>= 20.11.0`  | both spellings parse identically                              |

| Rejected               | Why                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `20.x`, `*`, `20.11.x` | wildcards describe a set we cannot bound; the patch level would be invented              |
| `18 - 20`              | a hyphen range has no patch levels, so its bounds would be guesses                       |
| `>=20`, `>=20.11`      | a partial tuple: accepting it means inventing the missing components                     |
| `!=20.11.0`            | a negation describes an excluded set, not a supported one                                |
| `>= <20`               | two operators for one bound                                                              |
| `>=20 \|\|`            | an empty alternative is satisfied by _every_ version, so a trailing `\|` must be refused |

A rejected range is `indeterminate`, reported as unreadable policy — never a pass, never an exception. Details and the
reason enum live in `src/core/compatibility/range.ts`.

### 4.1 Pre-releases are opt-in

A pre-release (`21.0.0-rc.1`) satisfies a range only if one of that alternative's comparators explicitly names a
pre-release of the **same** `MAJOR.MINOR.PATCH`. Otherwise an untested release candidate would inherit the "supported"
badge of its stable line — precisely the assumption a compatibility policy exists to stop.

Pre-releases report their own reason (`pre-release-not-listed`) so the remedy can say "use a released version" rather
than "you are too old".

### 4.2 Boundaries are inclusive or exclusive exactly as written

| Range           | 20.10.9     | 20.11.0       | 20.999.999 | 21.0.0      |
| --------------- | ----------- | ------------- | ---------- | ----------- |
| `>=20.11.0 <21` | unsupported | **supported** | supported  | unsupported |

Each of those four cells is a test case. The traceability KPI for this area is that **100% of the approved boundaries
are verified by automated tests** — which means both sides of every edge, not a sample.

---

## 5. Order of evaluation

`evaluateRequirement` (`src/core/compatibility/policy.ts`) runs a fixed sequence, and the order is part of the contract:

| #   | Check                                   | Outcome when it fires                                               |
| --- | --------------------------------------- | ------------------------------------------------------------------- |
| 1   | no version reported                     | `indeterminate` / `runtime-version-missing`                         |
| 2   | version not a `MAJOR.MINOR.PATCH` tuple | `indeterminate` / `runtime-version-unreadable`                      |
| 3   | declared range unreadable               | `indeterminate` / `policy-range-unreadable`                         |
| 4   | version satisfies the range             | `satisfied`                                                         |
| 5   | version is a pre-release                | `unsatisfied` / `pre-release-not-listed`                            |
| 6   | otherwise                               | `unsatisfied` / `below-minimum`, `above-maximum` or `outside-range` |

Step 3 precedes step 4 deliberately: if we cannot read the rule, there is no rule to satisfy, and claiming support
would be a fabrication.

Step 6 exists only to choose wording. Membership is always decided by `satisfiesRange`; `classifyDeviation` never
influences the verdict, because inaccurate wording is survivable and an inaccurate verdict is not.

---

## 6. What is reported

Two checks read the same evidence group (`RuntimeFacts`) and report **separately**:

| Check                               | Identifier                  | Severity  | Raises                                     |
| ----------------------------------- | --------------------------- | --------- | ------------------------------------------ |
| QAT's requirement                   | `runtime.node-version`      | `Error`   | `QAT-H001` unsupported, `QAT-H008` unknown |
| The project's framework requirement | `cypress.runtime-supported` | `Warning` | `QAT-H009`                                 |

They are never merged. The owners differ — one is fixed by moving QAT, the other by moving the project — and a single
merged sentence would name a problem without naming whose it is.

Verdict → status mapping:

| Verdict       | `runtime.node-version` | `cypress.runtime-supported`                     |
| ------------- | ---------------------- | ----------------------------------------------- |
| satisfied     | `Passed`               | `Passed` (or `Passed` when nothing is declared) |
| unsatisfied   | `Failed` — blocks      | `Warned` — does not block                       |
| indeterminate | `Warned`               | `Warned`                                        |

`CheckStatus.Failed` is reserved for `error`-severity checks, so the advisory must return `warn` even for a clear
mismatch. Returning `fail` from it is a catalogue test failure, which is the intended outcome: the alternative is an
advisory that silently refuses a run.

The advisory has **no precondition** on the blocking check. A framework bound can be violated on a runtime QAT supports
perfectly well, and suppressing the advisory in that case would hide the only finding the reader needs.

### 6.1 Evidence

A runtime finding states three things and nothing else:

| Field    | Example                     | Why                                                                      |
| -------- | --------------------------- | ------------------------------------------------------------------------ |
| detected | `v18.19.0`                  | as the process reports it, so it matches the user's own `node --version` |
| expected | `>=20.11.0 <21`             | verbatim from the declaration, never normalised                          |
| origin   | `package.json#engines.node` | the answer to "says who?", and a file the reader can open                |

No paths, no environment values, no interpreter metadata. Nothing here can carry a credential into a persisted
diagnostic session, and a new field must be reviewed against that rule before it is added.

### 6.2 Remediation

Every message names the range and gives a next step:

```
Install a Node release inside >=20.11.0 <21, confirm it with `node --version`,
then run the command again. A newer major is not automatically compatible:
support is only claimed for versions that have been tested.
```

"Not in range" is technically true and practically useless. The unsupported entry exists to print the pair.

---

## 7. Changing the supported range

A support change is a release event, not a code change. The procedure:

1. **Edit `package.json#engines.node`.** That is the only edit the product needs.
2. **Update the CI matrix** so every declared major is exercised, and nothing outside the declaration is. A green matrix
   on an undeclared major is a bug, not a bonus.
3. **Run the contract test** (`tests/contract/node-runtime-policy.contract.test.ts`). It parses the real manifest,
   asserts it is readable, and asserts every matrix major satisfies it while the nearest undeclared major does not.
4. **Update `CHANGELOG.md`** and the release notes. Dropping a major is a breaking change; adding one is a feature.
5. **Leave no prose behind.** README, docs and examples link to this page rather than restating a version.

Adding a range the parser cannot express means extending `range.ts` and its table-driven suite **first** — and adding
the operator to `SUPPORTED_OPERATORS`, which the tests iterate so coverage cannot silently shrink.

---

## 8. Deliberate non-goals

| Not done                                  | Reason                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Version override via environment variable | would let CI fake compatibility; tests inject the port instead                                                 |
| Automatic runtime switching (`nvm use`)   | QAT reports what is wrong; it does not mutate the user's toolchain                                             |
| Per-project support policy                | QAT's support is QAT's claim; the project's requirement is reported separately and never adopted               |
| A `semver` dependency                     | the accepted grammar is small, and an unreadable range must be _reported_, not thrown from inside a dependency |
| Blocking on an unreadable version         | an unanswered question must not stop work we can still perform — it warns                                      |
| Network lookups for release status        | diagnostics runs offline; the declared range is the whole authority                                            |

---

## 9. Test obligations

| Level            | What it must hold                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Unit — `version` | parsing, ordering, pre-release precedence, invalid input returns `undefined`                         |
| Unit — `range`   | every operator, both spellings, OR alternatives, every rejected form, the pre-release gate           |
| Unit — `policy`  | the six-step order, every reason, the `REASON_STATUS` agreement with the discriminated union         |
| Unit — rules     | satisfied/unsatisfied/indeterminate for both checks; no declaration emits nothing; scenario prefixes |
| Contract         | the real manifest parses, and the CI matrix is a subset of it                                        |
| E2E              | `qat doctor` prints the detected version and the declared range, and its JSON validates              |
| Non-functional   | no subprocess, no `cwd` dependence, deterministic verdicts, under a millisecond per evaluation       |

Boundary tests are pairs — the edge and its neighbour — because a single test at `20.11.0` cannot distinguish an
inclusive floor from an exclusive one.

---

## 10. Where the code lives

| Concern                              | Module                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| parsing and ordering a version       | `src/core/compatibility/version.ts`                                          |
| range grammar and membership         | `src/core/compatibility/range.ts`                                            |
| the single decision point            | `src/core/compatibility/policy.ts`                                           |
| vocabulary and reason → status table | `src/core/compatibility/contracts.ts`                                        |
| detection                            | `src/core/environment/runtime.ts`                                            |
| the two checks                       | `src/diagnostics/checks/rules/node-runtime.ts`                               |
| prose behind the codes               | `src/diagnostics/checks/guidance.ts`                                         |
| the declared range, read once        | `src/shared/utils/package-manifest.ts`, resolved in `src/app/composition.ts` |
