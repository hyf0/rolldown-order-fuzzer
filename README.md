# rolldown-order-fuzzer

This repository contains a strongly typed TypeScript differential fuzzer for Rolldown execution-order correctness. It renders a generated mixed ESM/CommonJS program and executes the source in a fresh Node process first. A source timeout or harness error stops the case before Rolldown; otherwise the fuzzer builds with Rolldown, executes the bundle in another fresh process, and compares the structured outcomes.

## Setup

```sh
vp install
vp test
vp check
```

## Run a campaign

```sh
vp exec node src/main.ts \
  --seed 1 \
  --cases 10 \
  --rolldown-package rolldown \
  --out-dir failures \
  --continue-on-fail
```

The CLI accepts:

- `--seed N`: initial unsigned 32-bit seed; defaults to `1`.
- `--cases N`: positive case count; defaults to `1`.
- `--case-size N`: generation size from 1 through 16; defaults to `4`. Larger sizes grow the random graphs.
- `--wrap-all`: build with `experimental.onDemandWrapping` disabled, exercising Rolldown's default wrap-all strict mode; the default fuzzes the on-demand analysis.
- `--format-regime mixed|pure-esm|pure-cjs`: force every case onto the random generator with a fixed module-format regime, for dedicated per-cell campaigns; the default lets the generator roll a weighted regime per case and keeps the fixed templates in the mix.
- `--rolldown-package SPECIFIER`: package specifier or file URL; defaults to `ROLLDOWN_PACKAGE`, then `rolldown`.
- `--out-dir DIRECTORY`: failure artifact root; defaults to `failures`.
- `--continue-on-fail`: run every requested case.
- `--stop-on-fail`: stop after the first failure; this is the default.

Campaign seeds increment by one and wrap as unsigned 32-bit integers. The CLI rejects a seed and case-count combination when its last arithmetic seed would exceed JavaScript's safe-integer range. A reported case can be replayed exactly with:

```sh
vp exec node src/main.ts --seed <reported-seed> --cases 1 --case-size <reported-size>
```

Half of the seeds select the `random-mixed` generator: a forward-edge random DAG of ESM/CJS modules with side-effect, value, and dynamic imports plus top-level `require`, an optional self-contained single-format cycle ring, entries that other modules may also import, optional manual chunk groups, and a schedule that interleaves entry evaluation with dynamic-import triggers (some registrations intentionally never fire). Generated modules read their dependencies' values — an ESM value import's binding, or a bound CJS `require` result member — and fold them into emitted event payloads and into state-derived export values (`variation:value-read`), so cross-module data flow is observable: a wrong, dropped, or reordered initialization changes an observed number instead of staying invisible. Value reads only ever cross forward edges and never target a module on a cycle, so value edges stay acyclic and TDZ stays out. Each random case rolls a format regime — mixed, pure-ESM, or pure-CJS — so the pure ends of the format matrix are exercised deliberately, and CJS modules may register dynamic imports (`import()` is legal inside CommonJS in Node) alongside their requires. Mixed-format cycles and value-import cycles are never generated, keeping Node's require-of-evaluating-ESM error and TDZ (both outside the oracle contract) out of the corpus. The other half keeps the five fixed MVP templates: ESM importing side-effectful CJS, multiple ESM carriers sharing CJS, CJS requiring synchronous ESM, overlapping multiple entries, and manual chunks separating carriers from interop modules. Coverage tags are derived from the resulting `ProgramModel`, not declared by the selected template; `template:*` tags describe structure, so a random program may carry a fixed template's tag or none.

A meaningful minority of eligible modules additionally carry `sideEffects: false` package metadata (`variation:side-effect-free-metadata`), the single biggest trigger for the aggressive dead-code elimination that fights execution order (rolldown #9961, #10123). A flagged module renders inside a synthetic `side-effect-free/` subdirectory whose `package.json` asserts `"sideEffects": false`, which Rolldown resolves and honors for files under that root (verified empirically) while Node ignores it; root modules have no such `package.json`, so the bundler keeps their side effects by default. **The flag is a user assertion the bundler alone consumes, and it may act on it by legally dropping the module or its initializer. So to keep the oracle sound, a flagged module contributes ONLY values — a demanded export folded downstream through the value-read machinery — and MUST NOT emit `__orderEvent` records: a flagged module that emitted an event could have it dropped in the bundle while the source still emits it, a false differential failure.** With no events, however the bundler eliminates the module the observed event stream is unchanged, so any divergence — a dropped-but-referenced binding, over-aggressive DCE removing needed value code, an initialization change that alters a folded number — is a real bug. `validate-model.ts` enforces this invariant: a flagged module that emits events, is not ESM, or carries a dependency other than a value-only ESM edge (a value or namespace import, or a re-export — all droppable under the flag) is an invalid model. The generator flags a minority of eligible modules — ESM leaves that are read by someone and are not entries — whose lack of upstream keeps them unconditionally sound whatever the bundler drops.

Generated modules also reach two dominant interop shapes. A minority of ESM→ESM value edges become **namespace imports** (`import * as ns from …` with a folded `ns.<export>` member read, `variation:namespace-read`), exercising the namespace-shape rewriting surface (rolldown #8675, #4780, #8710, #9320). Namespace imports only target ESM modules in the generator: Node's `import * of CJS` namespace carries a `module.exports` key that Rolldown's interop omits, so enumerating a CJS namespace legitimately differs from the bundle — a false-positive risk. A single numeric member read of a CJS target does round-trip cleanly and stays model-expressible, so it is covered by a handwritten test rather than generated (see [.agents/docs/namespace-and-barrel-reexports.md](.agents/docs/namespace-and-barrel-reexports.md)). Separately, a meaningful minority of readable ESM edges are rerouted through **barrel chains** (`variation:barrel-reexport`): one or two pure re-exporter modules inserted between a reader and its definer, forwarding the read name with `export { x } from`, `export { default as x } from` (`variation:reexport-default`), or `export * from` (`variation:reexport-star`) — forward edges only, so acyclicity and the forward-only read invariant hold. A downstream value then flows several hops from its defining module through barrels, the canonical shape behind dropped re-export inits and chunking-generated cycles (rolldown #8777, #8989, #9299, #4459). Generated names are unique per definer, so a star-export chain can never produce an ambiguous duplicate export; the renderer routes a reader's demanded name through the chain to the one module that defines it. Barrels are pure ESM re-exporters that emit no events and forward only to ESM definers, keeping the re-export chains all-ESM; a `sideEffects: false` barrel (the classic #8777 shape) is allowed only within the same no-events / value-only contract as any flagged module, with a value-only definer so the flag can never drop an observed side effect.

Each result line contains the case index, replay seed, template, coverage tags, and exact verdict signature. The process exits `0` when every case passes, `1` when any case fails, and `2` for invalid arguments or campaign harness errors.

A failing case's `model.json` can be reduced with the greedy shrinker, which keeps an edit only when the program stays valid and the verdict keeps the same failure kind (and error identity for crashes):

```sh
vp exec node src/shrink.ts --model <artifact>/model.json --out shrunk.json --rolldown-package <specifier>
```

## Isolated Rolldown builds

Each Rolldown build runs in a dedicated Node child process whose working directory is the adapter's unique temporary directory. The child imports the configured Rolldown package, reconstructs serializable input/output options and manual chunk groups, runs `rolldown`, `bundle.write`, and `bundle.close`, then returns only serializable output metadata.

Both sides structurally validate the versioned child protocol before using it, including absolute paths, manual groups, output metadata, and error fields. The child inherits only safe Node execution arguments needed for TypeScript/loaders; inspector and eval flags are not forwarded.

A genuine Rolldown build panic is a failing verdict, not a discarded harness error. A Rust panic or napi fatal surfaced as a thrown error, or a process crash after the Rolldown package has loaded, becomes a distinct `build-failure:panic:...` verdict (`status: build-error`) with a normalized message identity, deduplicated across runs, that writes failure artifacts and exits `1` like any real bug. The child writes a phase marker once the package imports cleanly, so the parent attributes a hard crash to the build rather than to loading: a crash before the marker, a package that fails to import, a missing `rolldown` export, a spawn failure, and a build timeout all stay invalid-harness results (exit `2`), never masquerading as a bug and never letting a real panic hide as one.

Every emitted chunk and asset filename must be a canonical forward-slash relative path confined to the bundle directory; absolute paths, drive/UNC paths, NULs, backslashes, and dot segments are rejected before manifest mapping. Bundle manifest mapping considers only output chunks explicitly marked as entries.

The parent never changes its cwd and does not use parent `globalThis` instrumentation. All Rolldown builds share the same protocol validation, output confinement, timeout, cleanup, and error classification. Any child has an explicit 60-second production timeout, followed by process-tree TERM/KILL shutdown and a deterministic harness error; POSIX uses an isolated process group and Windows uses `taskkill /T /F` with fallback. After forced termination, a bounded final close grace lets cleanup settle even if the child never emits `close`. Tests may inject shorter timeout/grace values.

## Failure artifacts

Every non-pass result is first written to a unique `.case-NNNN-seed-S-HASH.tmp-*` sibling and published by renaming it to `<out-dir>/case-NNNN-seed-S-HASH/`. `HASH` is a SHA-256 identity over the artifact schema and execution protocol versions, case index/seed/size/template/coverage/model, configured and replay CLI options, effective Rolldown build options, observed Node and package identity, source and bundle outcomes, concrete verdict/signature, path-plus-content hashes for every rendered source and emitted bundle file, and canonical path-plus-content hashes for both manifests, including a `null` bundle manifest. The same observed run identity may reuse an existing complete directory; a changed source, manifest, package build, output, verdict, or option set produces a different path. An existing final directory is never deleted or overwritten. A concurrent loser removes its complete temp directory; an interrupted writer may leave a temp directory but cannot expose a partial final directory.

- `model.json`: the generated `ProgramModel`.
- `case.json`: schema/protocol versions, artifact identity, case index, seed, size, template, derived coverage tags, configured Rolldown package specifier, observed runtime identity, rendered-source hashes, and source/bundle manifest hashes.
- `identity.json`: the SHA-256 hash and every canonical input used to derive it.
- `replay.json`: the command arguments, normalized one-case options, and observed runtime identity needed to assess replay fidelity.
- `source-manifest.json` and `bundle-manifest.json`: the source schedule and emitted bundle schedule; the bundle manifest is `null` when no build ran.
- `source-outcome.json`: the native Node execution outcome.
- `bundle-outcome.json`: the bundle execution outcome, or the exact Rolldown adapter failure when no bundle ran.
- `verdict.json`: the verdict and exact failure signature.
- `signature.txt`: the exact failure signature.
- `source/`: every rendered source file, including the source schedule.
- `bundle/`: every emitted Rolldown output file, captured before the adapter removes its temporary directories.

Replay is exact for the generated inputs and preserves the original observed outputs as evidence. Rerunning is environment-exact only when the recorded Node version/platform/architecture and package identity can be pinned: requested specifier, resolved entry URL/path, nearest package root/version when available, resolved entry-file hash when readable, deterministic package-content hash, resolved `@rolldown/binding-*` optional sibling package versions/content hashes, `NAPI_RS_NATIVE_LIBRARY_PATH` requested value plus generated binding-loader candidates/base and resolved/real path/file hash, and the current fuzzer lockfile hash when available. Binding-loader discovery is restricted to the runtime `dist` tree and requires exactly one marker-bearing candidate for relative overrides; no candidate or multiple sorted candidates leaves relative resolution null. Absolute overrides are base-independent and are realpathed/hashed even when loader candidates are ambiguous. Missing platform-specific optional bindings and unresolved native overrides are recorded without failing the campaign. Compact packages hash every regular file except dependency/VCS/cache directories; larger worktrees hash `package.json`, `dist`, `bin`, and native `.node` files. Ordinary symlinks and symlink directories are ignored, while a package-relative `.node` symlink contributes its link path, canonical target path, and target bytes. When those dependencies are unavailable or have changed, the artifact still preserves the original manifests, outcomes, emitted bytes, verdict, and identity.

## Context

Read [AGENTS.md](AGENTS.md) first. Durable project context lives under [.agents/docs/](.agents/docs/).
