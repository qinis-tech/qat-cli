# Shared Cypress cache roots

Each directory here is a complete `CYPRESS_CACHE_FOLDER` root, laid out as
`<root>/<version>/<platform entry>`. The harness exports one of them for every fixture, so the
binary checks read a fixed, committed location instead of the developer's real cache.

| Root | State |
| --- | --- |
| `accessible/` | binary present for 13.6.0 and executable |
| `not-executable/` | binary present, mode forced to 0o644 by the harness |
| `relocated/` | a valid root at a non-default path, for the override fixture |
| `empty/` | no version directory at all — the "package installed, binary missing" state |

The three entry paths under each version are all committed, because the correct one depends on the
host platform:

    Cypress/Cypress                                  linux
    Cypress.exe                                      win32
    Cypress.app/Contents/MacOS/Cypress               darwin

Every "binary" is the same four-byte shell stub. The checks inspect these files — size, file-ness,
execute permission — and never run them. `not-executable` is the only root whose modes matter, and
the harness applies them after materialisation because git cannot carry an exec bit to every runner.