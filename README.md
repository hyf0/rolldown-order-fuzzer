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

Each case uses size `4`. Campaign seeds increment by one and wrap as unsigned 32-bit integers. The CLI rejects a seed and case-count combination when its last arithmetic seed would exceed JavaScript's safe-integer range. A reported case can be replayed exactly with:

```sh
vp exec node src/main.ts --seed <reported-seed> --cases 1
```

Generation selects one controlled template and varies only bounded graph parameters, import forms, event values, and schedule order. The MVP templates cover ESM importing side-effectful CJS, multiple ESM carriers sharing CJS, CJS requiring synchronous ESM, overlapping multiple entries, and manual chunks separating carriers from interop modules. Coverage tags are derived from the resulting `ProgramModel`, not declared by the selected template.

Each result line contains the case index, replay seed, template, coverage tags, and exact verdict signature. The process exits `0` when every case passes, `1` when any case fails, and `2` for invalid arguments or campaign harness errors.

## Failure artifacts

Every non-pass result is first written to a unique `.case-NNNN-seed-S-HASH.tmp-*` sibling and published by renaming it to `<out-dir>/case-NNNN-seed-S-HASH/`. `HASH` is a SHA-256 identity over the artifact schema and execution protocol versions, case index/seed/size/template/coverage/model, configured and replay CLI options, effective Rolldown build options, package specifier, and concrete verdict signature. The same identity may reuse an existing complete directory; a different package, verdict, or option set produces a different path. An existing final directory is never deleted or overwritten. A concurrent loser removes its complete temp directory; an interrupted writer may leave a temp directory but cannot expose a partial final directory.

- `model.json`: the generated `ProgramModel`.
- `case.json`: schema/protocol versions, artifact identity, case index, seed, size, template, derived coverage tags, and configured Rolldown package specifier.
- `identity.json`: the SHA-256 hash and every canonical input used to derive it.
- `replay.json`: the command arguments and normalized one-case options needed to replay the seed.
- `source-manifest.json` and `bundle-manifest.json`: the source schedule and emitted bundle schedule; the bundle manifest is `null` when no build ran.
- `source-outcome.json`: the native Node execution outcome.
- `bundle-outcome.json`: the bundle execution outcome, or the exact Rolldown adapter failure when no bundle ran.
- `verdict.json`: the verdict and exact failure signature.
- `signature.txt`: the exact failure signature.
- `source/`: every rendered source file, including the source schedule.
- `bundle/`: every emitted Rolldown output file, captured before the adapter removes its temporary directories.

## Context

Read [AGENTS.md](AGENTS.md) first. Durable project context lives under [.agents/docs/](.agents/docs/).
