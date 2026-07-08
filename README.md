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
- `--rolldown-package SPECIFIER`: package specifier or file URL; defaults to `ROLLDOWN_PACKAGE`, then `rolldown`.
- `--out-dir DIRECTORY`: failure artifact root; defaults to `failures`.
- `--continue-on-fail`: run every requested case.
- `--stop-on-fail`: stop after the first failure; this is the default.
- `--no-order-trace`: disable strict execution-order trace collection; collection is enabled by default.

Each case uses size `4`. Campaign seeds increment by one and wrap as unsigned 32-bit integers. The CLI rejects a seed and case-count combination when its last arithmetic seed would exceed JavaScript's safe-integer range. A reported case can be replayed exactly with:

```sh
vp exec node src/main.ts --seed <reported-seed> --cases 1
```

Generation selects one controlled template and varies only bounded graph parameters, import forms, event values, and schedule order. The MVP templates cover ESM importing side-effectful CJS, multiple ESM carriers sharing CJS, CJS requiring synchronous ESM, overlapping multiple entries, and manual chunks separating carriers from interop modules. Coverage tags are derived from the resulting `ProgramModel`, not declared by the selected template.

Each result line contains the case index, replay seed, template, coverage tags, and exact verdict signature. When Rolldown emits a strict execution-order plan, the line also reports `wraps=N` using the number of selected plan modules. This diagnostic count does not affect the semantic verdict. The process exits `0` when every case passes, `1` when any case fails, and `2` for invalid arguments or campaign harness errors.

## Strict execution-order trace

Trace collection serializes campaigns around the process-wide `ROLLDOWN_STRICT_ORDER_TRACE` setting and sets it once for each traced campaign. Before snapshotting or invoking Rolldown, the adapter allocates `devtools.sessionId` from a deterministic PID-scoped sequence and skips candidates whose target directory already exists. Allocation is bounded to 64 candidates and reports a harness error rather than asking an honoring producer to write into existing state.

After `bundle.close()` flushes the devtools writer, the adapter examines devtools directories that were absent from its pre-build snapshot. A directory is owned only when its `SessionMeta` inputs belong to the build's canonical source directory; only owned directories may be parsed or removed.

This ownership rule applies both to the requested session path and to the automatic `sid_*` directories produced by Rolldown 1.1.4, which accepts but does not honor `devtools.sessionId`. The uniquely matched directory is cleaned even when it has no strict-order action. A pre-existing requested path is never owned or deleted, but it does not prevent a different newly created legacy directory from being owned. Load failures, ambiguous matches, and absent matches leave every unowned candidate untouched.

Packages that do not emit the action produce `orderTrace: null`, so older Rolldown versions remain usable. A malformed matching action, an unsupported version, invalid JSON, or multiple matching actions is a harness error because the diagnostic data cannot be trusted. The parser validates the required version-1 structure, including unsigned 32-bit bounds for every chunk ID and reference, then constructs a schema-only object that discards transport and unknown metadata.

Before exposure or persistence, every module ID is canonicalized. Rendered source file paths map back to `ProgramModel` module IDs, other paths under the temporary source root become `<source>/relative`, and stable virtual or runtime IDs remain unchanged. This makes semantically identical traces and persisted `order-trace.json` files deterministic across temporary roots, sessions, builds, and timestamps. The trace is stored for diagnosis and over-wrapping analysis only; source-versus-bundle execution remains the semantic oracle.

## Failure artifacts

Every non-pass result is first written to a unique `.case-NNNN-seed-S-HASH.tmp-*` sibling and published by renaming it to `<out-dir>/case-NNNN-seed-S-HASH/`. `HASH` is a SHA-256 identity over the artifact schema and execution protocol versions, case index/seed/size/template/coverage/model, configured and replay CLI options, effective Rolldown build options, observed Node and package identity, source and bundle outcomes, canonical order trace, concrete verdict/signature, path-plus-content hashes for every rendered source and emitted bundle file, and canonical path-plus-content hashes for both manifests, including a `null` bundle manifest. The same observed run identity may reuse an existing complete directory; a changed source, manifest, package build, output, trace, verdict, or option set produces a different path. An existing final directory is never deleted or overwritten. A concurrent loser removes its complete temp directory; an interrupted writer may leave a temp directory but cannot expose a partial final directory.

- `model.json`: the generated `ProgramModel`.
- `case.json`: schema/protocol versions, artifact identity, case index, seed, size, template, derived coverage tags, configured Rolldown package specifier, observed runtime identity, rendered-source hashes, and source/bundle manifest hashes.
- `identity.json`: the SHA-256 hash and every canonical input used to derive it.
- `replay.json`: the command arguments, normalized one-case options, and observed runtime identity needed to assess replay fidelity.
- `source-manifest.json` and `bundle-manifest.json`: the source schedule and emitted bundle schedule; the bundle manifest is `null` when no build ran.
- `source-outcome.json`: the native Node execution outcome.
- `bundle-outcome.json`: the bundle execution outcome, or the exact Rolldown adapter failure when no bundle ran.
- `order-trace.json`: the collected version-1 strict execution-order plan, or `null` when collection was disabled or the package emitted no matching action.
- `verdict.json`: the verdict and exact failure signature.
- `signature.txt`: the exact failure signature.
- `source/`: every rendered source file, including the source schedule.
- `bundle/`: every emitted Rolldown output file, captured before the adapter removes its temporary directories.

Replay is exact for the generated inputs and preserves the original observed outputs as evidence. Rerunning is environment-exact only when the recorded Node version/platform/architecture and package identity can be pinned: requested specifier, resolved entry URL/path, nearest package root/version when available, resolved entry-file hash when readable, deterministic package-content hash, resolved `@rolldown/binding-*` optional sibling package versions/content hashes, and the current fuzzer lockfile hash when available. Missing platform-specific optional bindings are skipped. Compact packages hash every regular file except dependency/VCS/cache directories; larger worktrees hash `package.json`, `dist`, `bin`, and native `.node` files without following symlinks outside the package root. When those dependencies are unavailable or have changed, the artifact still preserves the original manifests, outcomes, trace, emitted bytes, verdict, and identity.

## Context

Read [AGENTS.md](AGENTS.md) first. Durable project context lives under [.agents/docs/](.agents/docs/).
