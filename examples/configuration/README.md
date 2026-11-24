# Configuration examples

Two files, and they have different jobs.

- **`qat.config.minimal.json`** is the template — the two fields a project must state, and nothing else. It is what an
  initialisation workflow would write. It is deliberately *minimal*: a template that grows stops being a starting point
  and becomes a list of decisions made on the reader's behalf.
- **`qat.config.json`** is the fully populated example. It exercises every field in the schema, which is asserted rather
  than intended.

Both are validated against the schema by `tests/unit/config/format.test.ts`, and so is every JSON block in
[the format specification](../../docs/architecture/configuration-format.md). Adding a field to the schema without adding
it here fails the suite — which is the point: an example nobody checks is a claim, and a claim in a document is what
somebody copies into their repository.

Nothing in these files is a credential. `environments` holds defaults that are committed and visible, and a value that
must stay secret belongs in the environment the process runs in. See the specification's section on secrets.