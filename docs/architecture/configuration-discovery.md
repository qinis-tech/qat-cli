# Configuration discovery

| Status | Normative |
| Module | src/config/discovery/ |
| Contract | src/config/contracts.ts → CONFIG_FILE_NAME |
| Companion | configuration-format.md, configuration-schema.md, ADR-0024, ADR-0025 |

## 1. What it answers

A project root in, one of three answers out. It does not read the file.

| Situation | Answer | What a command does |
| found | the absolute path | hands it to the loader |
| absent | the root that was searched | applies the defaults |
| not-a-file | the path and what occupies it | refuses, with a remedy |

## 2. Absence is not a failure

A project with no configuration is legal... (the ordinary case)

## 3. A name occupied by a directory is not absence

## 4. The filesystem failing throws

## 5. What is not searched

- no ascent
- no `.qat/qat.config.json`
- no prefix matching, no backup files
- no explicit path: there is no `--config` and no parameter for one

## 6. Ambiguity cannot arise

One candidate name, so "multiple candidates" has no meaning here. Adding a second requires a
precedence rule or a refusal — the same choice the framework configuration makes — and is a decision,
not a list entry.

## 7. Why `isFile` was not enough

## 8. Testing
