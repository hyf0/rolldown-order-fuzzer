# Execution-order fuzzer MVP

## Goal

Build a deterministic differential oracle for Rolldown execution-order correctness. The same generated program and schedule run once as native Node source and once as Rolldown output in fresh processes. A verdict compares structured events, exit class, and normalized errors.

The first campaign targets synchronous ESM/CommonJS interaction. Exact top-level-await event ordering is not part of the oracle contract. TLA cases may be classified by hang/error behavior later, but they must not block the mixed-module MVP.

## Boundaries

- Native Node is the semantic oracle. Rollup may be added later as diagnostic context, not as ground truth.
- Output format is ESM.
- Generated modules use explicit relative paths and `.mjs` or `.cjs` extensions.
- The first model excludes externals, package export conditions, plugins, JSON, WASM, timers, and dishonest `sideEffects: false` metadata.
- Generated programs cannot import Node built-ins, create operating-system child processes, or inject arbitrary source text. Process isolation only needs to terminate the generated-program runner, not sandbox hostile handwritten programs.
- Verdicts compare primitive structured events and error identity. They do not compare CJS namespace/default/named-export object shapes.
- `require(ESM)` is a separate lane and only generates synchronous ESM without TLA.

## Layers

### Model

`ProgramModel` contains modules, named entries, an explicit schedule, and optional manual chunk groups.

Each `ModuleModel` has a stable ID, a format (`esm` or `cjs`), ordered dependency operations, and ordered event operations. The model must reject dangling references, duplicate module IDs, invalid entry IDs, and unsupported syntax combinations.

Initial dependency operations:

- ESM static side-effect import
- ESM static value import
- ESM dynamic import registration
- CJS top-level require

Initial schedules:

- import an ESM entry
- require a CJS entry
- trigger a registered dynamic import

### Renderer

The renderer writes normal `.mjs` and `.cjs` files. Every observable operation calls a shared global event function with primitive JSON data:

```js
globalThis.__orderEvent({ module: "m1", phase: "evaluate", value: 1 });
```

The renderer also writes one schedule file consumed by both source and bundle drivers.

### Execution

Every source or bundle schedule runs in a new Node child process. The child returns one JSON result:

```ts
interface ExecutionOutcome {
  status: "ok" | "error" | "timeout" | "harness-error";
  events: EventRecord[];
  error?: { name: string; message: string };
}
```

The source and bundle paths must use the same child runner and schedule interpreter.
Spawn failures, abnormal runner exits, and invalid/missing result files are harness errors, not program errors. A verdict must never treat matching harness failures as semantic agreement.

### Rolldown adapter

The adapter dynamically imports a configurable Rolldown package specifier. `ROLLDOWN_PACKAGE` defaults to `rolldown` and may point at an absolute file URL or preview package.

It builds named entries with:

- `format: "esm"`
- `strictExecutionOrder: true`
- deterministic entry/chunk names
- optional generated `codeSplitting.groups`

The adapter writes every generated chunk to a separate output directory and maps model entry names to emitted entry filenames.

### Verdict

The source outcome is classified first:

- source timeout: invalid oracle
- source error: comparable only by normalized error class and identity
- source success: compare exact structured event sequence

Bundle-only errors, suppressed source errors, missing/extra/reordered events, and timeout mismatches are distinct signatures.

The runner caps structured events at 512 per execution. Exceeding the cap is a normal program execution error, so a bundle that duplicates events cannot exhaust verdict memory or hide behind a harness classification. Within the cap, event signatures use an exact deterministic sequence diff with no approximate fallback.

### Seeded generation

Generation is deterministic from seed and size. The first mixed campaign covers:

- ESM imports a side-effectful CJS leaf
- multiple ESM carriers share one CJS module
- CJS requires synchronous ESM
- multiple entries with overlapping mixed dependencies
- manual chunk groups that separate carriers from interop modules

Random generation starts after fixed scenarios pass through the complete pipeline.

## Rolldown debug contract

Trace collection is enabled by default and can be disabled with `--no-order-trace`. Campaigns acquire one module-level asynchronous lock around the process-wide environment state, so traced and opt-out campaigns cannot overlap while `ROLLDOWN_STRICT_ORDER_TRACE` is temporarily set. A traced campaign sets the variable once rather than changing it around each build.

Each traced build allocates `devtools.sessionId` from a deterministic process-unique sequence containing the PID and a monotonic counter. Before snapshotting or passing the ID to Rolldown, the adapter checks that its target directory is absent and advances past collisions. Allocation stops after 64 occupied candidates with a `collect-order-trace` harness error.

The adapter then snapshots `node_modules/.rolldown/` before the build and waits for `bundle.close()`. A session directory is owned only when it was absent from the snapshot, exists after close, and has `SessionMeta.inputs` under the build's canonical source directory. This rule applies equally to the requested path and legacy random IDs, and only an owned directory may be parsed or removed.

Rolldown 1.1.4 ignores the supplied session ID and creates an automatic `sid_*` directory. A uniquely owned directory is cleaned even when no strict-order action exists. A pre-existing requested path is never owned or deleted; a separate newly created source-matching legacy directory may still be owned. Package-load failures, zero matches, and multiple matches produce `orderTrace: null` without deleting any unowned candidate. Malformed logs in a uniquely owned session, unsupported action versions, and duplicate matching actions are harness errors.

The collector accepts version 1 of `StrictExecutionOrderPlanReady` and strictly validates the required shapes for:

- root obligations and predicted order
- selected order-wrap modules and reasons
- included modules with original/final wrap kind and chunk mappings
- rendered static and dynamic chunk edges, with every chunk ID and reference constrained to unsigned 32-bit values
- direct and transitive init obligations, including await and TLA facts

The parser constructs a new versioned schema object and discards timestamps, session/build IDs, and unknown transport or nested metadata. The adapter maps canonical rendered source paths back to `ProgramModel` module IDs, rewrites other temporary source-root paths as `<source>/relative`, and preserves stable virtual/runtime IDs. Failure artifacts therefore contain deterministic `order-trace.json` data or `null`, and result lines report the selected plan-module count when an action is present. This data explains failures and reports over-wrapping; it does not affect the semantic verdict.

## Regression policy

Fuzz discoveries are shrunk outside Rolldown first. Only a minimized case with the same concrete failure signature becomes a Rolldown fixture. Do not pre-build a large internal mixed-module matrix.
