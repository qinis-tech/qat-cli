# Configuration fixtures

`valid/` holds configurations that must parse. `invalid/` holds one file per broken rule, and **each file is broken in
exactly one way** — a fixture with two defects passes for whichever one the schema happens to report first, and then
stops proving anything when the other is fixed.

The expected issue path lives in the test table rather than in the filename, because a filename that encodes a path
becomes unreadable at three levels deep and wrong the moment the parser nests differently.

Extracted strings are written out rather than escaped where the escape would be the subject — `variable-value-multiline`
contains a real newline, because the rule it tests is about what a value may contain, not about JSON syntax.

Adding a fixture:

1. Break one rule. Nothing else.
2. Add a row to the table in `tests/unit/config/schema.test.ts`, naming the field the issue should point at.
3. Run the suite. If the assertion fails, the schema and the fixture disagree — decide which is right before touching
   either.