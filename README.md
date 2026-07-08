# rolldown-order-fuzzer

This repository contains a strongly typed TypeScript differential fuzzer for Rolldown execution-order correctness. It renders a generated mixed ESM/CommonJS program and executes the source in a fresh Node process first. A source timeout or harness error stops the case before Rolldown; otherwise the fuzzer builds with Rolldown, executes the bundle in another fresh process, and compares the structured outcomes, including schedule operation boundaries.

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
- `--expected-fuzzer-sha256 HASH`: require the current fuzzer source hash to match a recorded replay.
- `--expected-runtime-sha256 HASH`: require the compiler/runtime identity to match a recorded replay.
- `--continue-on-fail`: run every requested case.
- `--stop-on-fail`: stop after the first failure; this is the default.

Each case uses size `4`. Campaign seeds increment by one and wrap as unsigned 32-bit integers. The CLI rejects a seed and case-count combination when its last arithmetic seed would exceed JavaScript's safe-integer range. A reported case can be replayed exactly with:

```sh
vp exec node src/main.ts --seed <reported-seed> --cases 1
```

Generation selects one controlled template and varies only bounded graph parameters, import forms, event values, and schedule order. The MVP templates cover ESM importing side-effectful CJS, multiple ESM carriers sharing CJS, CJS requiring synchronous ESM, overlapping multiple entries, manual chunks separating carriers from interop modules, scheduled dynamic entries whose eager dependency order crosses an ESM-to-CJS carrier, internal references to wrapped entry modules, and manual-chunked mixed-module cycles. Generated value imports are observed through the imported binding. Coverage tags are derived from the resulting `ProgramModel`, not declared by the selected template.

Each result line contains the case index, replay seed, template, coverage tags, and exact verdict signature. The process exits `0` when every case passes, `1` when any case fails, and `2` for invalid arguments or campaign harness errors.

## Isolated Rolldown builds

Each Rolldown build runs in a dedicated Node child process whose working directory is the adapter's unique temporary directory. The child imports the configured Rolldown package, reconstructs serializable input/output options and manual chunk groups, runs `rolldown`, `bundle.write`, and `bundle.close`, then returns only serializable output metadata.

Both sides structurally validate the versioned child protocol before using it, including absolute paths, manual groups, output metadata, and error fields. The child inherits only safe Node execution arguments needed for TypeScript/loaders; inspector and eval flags are not forwarded.

A campaign records the first case's Node, package source/output, recursive runtime dependencies, compiler and fuzzer lockfiles, fuzzer source, child conditions/loaders, `NODE_OPTIONS` hooks, native-binding hashes, platform/NAPI selection facts, and compiler thread settings. The adapter verifies the identity before and after every build, and the campaign aborts if it changes between cases. Artifact replay commands require both the recorded fuzzer source hash and the full runtime identity hash.

Startup code hooks and loaders from `NODE_OPTIONS` or Node exec arguments are rejected for reproducible campaigns. Conditions such as `-C dev` remain supported and identity-bound.

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
