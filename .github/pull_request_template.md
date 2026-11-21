<!--
QAT Pull Request

Read CONTRIBUTING.md before completing this template.
Pull requests with an incomplete description will not be reviewed.

Rules that CI enforces:
  - Title must follow Conventional Commits: <type>(<scope>): <subject>
  - Every commit must follow Conventional Commits
Both checks fail the build, so fix them before requesting review.
-->

## 1. Change summary

<!--
What changed, and why. 2-5 sentences. Write for someone who has not read the diff.
State the problem this solves, not the files you edited.
-->



## 2. Explain it simply (Feynman technique)

<!--
Explain this change in plain language, as you would to a competent engineer who has
never seen this repository. Write it before you fill in anything below.

Rules for this section:
  - No jargon. No library names, no pattern names, no "refactored the factory".
  - If you cannot explain it without jargon, you do not understand it well enough yet.
  - If it takes more than a short paragraph, the change is probably too large.
-->

**2a. In plain language, what does this change do?**



**2b. What was not obvious, and how did you find out?**

<!--
The gap between what you assumed and what was actually true. This is where most review
value comes from: it shows the reviewer which assumptions to check.
-->



**2c. Where is my own explanation still vague?**

<!--
The honest part, and the point of the exercise. Name the part you are least certain
about, the edge case you did not handle, or the thing you are relying on trust for.
Being specific here is encouraged and will not count against the change.
Write "Nothing — see 2b" only if that is genuinely true.
-->



**2d. What would break first?**

<!--
If this change is wrong, what fails, how loudly, and who notices? "Silent wrong
results" is a materially different answer from "the command errors out".
-->



## 3. Related requirement or issue

<!-- Mandatory for feat/ and fix/. One WBS task or one defect per pull request. -->

- WBS task:
- Issue: <!-- e.g. Closes #42 -->

## 4. Implementation details

<!--
Approach and trade-offs. Where in the codebase does this live and why there.
What did you deliberately not do? That last question matters more than the diff.
-->



## 5. Tests performed

<!-- Exact commands and their outcome. "Ran the tests" is not evidence. -->

```bash
$ npm run lint
$ npm run typecheck
$ npm test
```

**Result:**



- [ ] Unit tests added or updated
- [ ] Integration tests added or updated
- [ ] Regression test added (defects only — confirm below)
- [ ] Verified manually against a real project

<!-- Defects only: the test must fail before the fix and pass after. -->
**Regression test failed before the fix:** <!-- Yes / N/A -->
**Regression test passes after the fix:** <!-- Yes / N/A -->

## 6. Acceptance criteria verification

<!--
Copy each criterion from the WBS task or issue verbatim. No criterion, no merge.
Evidence means a test name, a command, or an observed output — not "done".
-->

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 |  |  |  |
| 2 |  |  |  |
| 3 |  |  |  |

## 7. Breaking changes

<!--
User-visible or API-visible breakage, and the migration path.
Does this change an exit code, a config key, a result-schema field, or a command
signature? If yes, a BREAKING CHANGE footer is required on the commit.
Write "None" if there is none.
-->



## 8. Documentation impact

<!-- A changed command without updated docs is incomplete work. -->

- [ ] `docs/` updated in this pull request — files:
- [ ] No documentation change required, because:

## 9. Where should the reviewer focus?

<!--
Derived from section 2. Do not write "all of it". Name at most three places, and say
what you want checked there. This is the highest-value box in the template.
-->

| File / area | What to check |
| --- | --- |
|  |  |
|  |  |

**Known out of scope:** <!-- Follow-up issues raised: #... -->

## 10. Author checklist

- [ ] Section 2 is written in plain language and honestly names the weak points
- [ ] Title follows Conventional Commits, subject lowercase, no trailing period
- [ ] Branch follows `<type>/<wbs-id>-<slug>`
- [ ] Diff is scoped to one WBS task or defect, under ~400 changed lines
- [ ] `npm run lint`, `npm run typecheck`, `npm test` pass locally
- [ ] CI green on Linux and Windows
- [ ] No secrets, credentials, `.qat/` artefacts, or build output in the diff
- [ ] No real customer data in fixtures, screenshots, or recorded video
- [ ] Self-reviewed the full diff, line by line
- [ ] Follow-up work captured as issues

<!--
Not ready for review yet? Open as a draft. Mark ready only when every box above is
ticked.
-->

---

<sub>Reviewer requirements are in <a href="../blob/main/CONTRIBUTING.md">CONTRIBUTING.md</a> §6.
Merge strategy is squash-only; this title becomes the commit on <code>main</code>.</sub>