# Application Composition

How QAT's dependencies are constructed and connected, and what happens to them at shutdown.

## Two files, two jobs

| File                     | Job                                                 | Side effects on import          |
| ------------------------ | --------------------------------------------------- | ------------------------------- |
| `src/app/composition.ts` | Builds and connects every dependency                | None                            |
| `src/cli/index.ts`       | Parses arguments, runs a command, sets an exit code | Reads `argv`, installs handlers |

They were one file in the architecture as first written. Splitting them is what allows the wiring to be
tested: importing the entry point executes it.

## What is assembled

| Dependency        | Constructed from                  | Notes                                           |
| ----------------- | --------------------------------- | ----------------------------------------------- |
| Logger            | `core/logging`                    | Level from flag, then environment, then default |
| Repository        | An implementation                 | In-memory today; SQLite when it exists          |
| Project discovery | `src/project` adapted to the port | Adapter lives in the composition root           |

**Not assembled, deliberately:** `core/filesystem` and `core/process` are modules of stateless
functions. Wrapping them so that something can be "constructed" adds a layer that exists only to be
injected, and every caller would need the wrapper instead of the function.

## Lifecycle

Construction is synchronous and ordered: logger first, so anything that fails afterwards can be
reported, then the repository, then the adapters.

Disposal is the reverse, and each step exists for a reason:

1. The repository closes. A database connection released here is one the process will not leak.
2. The logger flushes last, so anything reported during step 1 still has a destination.

`dispose()` is idempotent. Shutdown is reached from a signal handler and from a normal exit, and
neither can be relied on to be the only path.

## Startup failure

One thing can fail: an invalid log level. It produces `QAT1001` with the supported values in the
remediation. Everything else that can go wrong belongs to a command, not to assembly — a missing
project or an uninstalled framework is discovered when something asks, not when the application is
built.

## What a command handler receives

```ts
const application = createApplication({ logLevel: options.logLevel });
try {
  const project = await application.discovery.discover(
    options.cwd ?? process.cwd(),
  );
  // …
} finally {
  await application.dispose();
}
```

A handler receives the assembled application and calls ports on it. It never constructs anything, and
it never imports an implementation.
