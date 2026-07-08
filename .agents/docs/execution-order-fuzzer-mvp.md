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
- Verdicts compare primitive structured events and error identity. A nonprimitive source event is an invalid oracle; a bundle-only nonprimitive event is a compiler mismatch. Other CJS namespace/default/named-export object shapes are out of scope.
- `require(ESM)` is a separate lane and only generates synchronous ESM without TLA.

## Layers

### Model

`ProgramModel` contains modules, named entries, an explicit schedule, and optional manual chunk groups.

Each `ModuleModel` has a stable ID, a format (`esm` or `cjs`), ordered dependency operations, and ordered event operations. Events can record a literal or an imported binding. The model must reject dangling references, unavailable observed bindings, duplicate module IDs, invalid entry IDs, and unsupported syntax combinations.

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

The child runner installs the event function, event array, and dynamic-import registry before loading any generated entry. These harness globals are not emitted as a source module or added to the generated dependency graph. The renderer also writes one schedule file consumed by both source and bundle drivers.

### Execution

Every source or bundle schedule runs in a new Node child process. The child returns one JSON result:

```ts
interface ExecutionOutcome {
  status: "ok" | "error" | "timeout" | "harness-error";
  events: EventRecord[];
  error?: { name: string; message: string };
}
```

The source and bundle paths must use the same child runner and schedule interpreter. Outcomes record the event count at the start of each schedule operation so eager execution cannot hide behind the same final flat event list.
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
- scheduled dynamic entries that execute ordinary ESM before an ESM-to-CJS carrier
- CJS entries that synchronously reference another wrapped entry
- manual-chunked ESM cycles re-entered through CJS

Random generation starts after fixed scenarios pass through the complete pipeline.

## Rolldown build contract

Each build runs in a dedicated Node child process whose working directory is the adapter's unique temporary directory. The parent passes absolute source and bundle paths plus serializable build options; the child reconstructs manual chunk predicates, imports the configured Rolldown package, runs the build, waits for `bundle.close()`, and returns serializable output metadata.

The parent and child strictly validate their versioned protocol. Output filenames must be canonical relative paths confined to the bundle directory. The child inherits only safe Node execution arguments required for TypeScript or loaders; inspector, eval, and print flags are discarded.

Every build has a bounded timeout. Timeout handling terminates the child process tree with TERM followed by KILL and a bounded final-close grace, so a package loader or helper subprocess cannot stall a campaign indefinitely.

The adapter does not enable Rolldown devtools and does not read internal wrapping, inclusion, or execution-plan state. Artifact schema 9 records the generated model, manifests, observed source and bundle outcomes, emitted bytes, exact verdict, and tested runtime/package identity, including package source files, recursive runtime dependencies, compiler and fuzzer lockfiles, fuzzer source, child conditions/loaders, and platform/NAPI selection facts. The adapter compares that identity before and after each build. Replay commands require the recorded fuzzer source and full runtime identity hashes. The differential source-versus-bundle execution result is the sole semantic oracle.

## Regression policy

Fuzz discoveries are shrunk outside Rolldown first. Only a minimized case with the same concrete failure signature becomes a Rolldown fixture. Do not pre-build a large internal mixed-module matrix.
