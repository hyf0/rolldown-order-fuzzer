# Legacy fuzzer behavior worth keeping

This record preserves useful behavior from the pre-reset JavaScript implementation. The code and git history were intentionally deleted on 2026-07-07 so the project can be redesigned from scratch.

## Core contract

The fuzzer's most valuable idea was the differential oracle: run the unbundled source graph under Node as ground truth, build the same graph with Rolldown, run the bundle under the same schedule, then compare observable behavior.

The same driver should execute both source and bundle. A failure should point at Rolldown output, not at harness skew.

Each schedule should run in a fresh Node process. ESM module caches, dynamic import state, globals, timers, and crashes should not leak across schedules.

Schedules should be explicit and deterministic: import these entries, fire these registered dynamic imports, optionally wait for a bounded settle point, then stop. Avoid random timers as the source of truth.

The oracle should compare more than stdout order. It should compare event sequence, exit class, and error identity. A bundle crash when source exits cleanly is a runtime failure; a source crash that the bundle suppresses is a semantic mismatch, not success.

Ground-truth hangs should make the case invalid or not oracle-able. They should never collapse into a passing result.

## Generator behavior to preserve

Generate a structured model first, then render files from the model. This made shrinking possible without producing dangling imports and syntax garbage.

Keep generation deterministic from seed plus size. A failing seed must be byte-reproducible.

Generate cases around mechanisms known to matter for execution order: multiple entries with overlapping dependency order, dynamic imports whose arrival is controlled by the driver, re-export barrels, live binding reads and writes, cycles, and manual chunking that splits import-order neighbors.

Treat `sideEffects:false` honestly. Annotated-pure packages must contain only truthfully pure modules; otherwise the oracle reports legal tree-shaking as a bundler bug.

Store shrunk repros as normal regression cases with pinned expectations. Fuzz discoveries should become part of the replayable corpus.

## Previous finding categories

Default Rolldown output can legitimately be expected to differ for order-sensitive graphs; that class is why strict execution order exists.

Strict execution order previously eliminated silent order divergence in the sampled ESM corpus, but fuzzing found crash families around generated init functions, especially when advanced chunking manufactured cyclic chunk graphs from acyclic source graphs.

Experimental on-demand wrapping had known regressions in the old corpus: at least one missing `init_*` crash and order regressions around barrels or segment ordering. The redesigned fuzzer should keep those as historical classes but should not group all future failures into a vague known bucket.

TDZ behavior was deliberately treated as a boundary: if the source program itself crashes, the oracle should require the bundle to preserve the crash class and useful identity, but design work may still document some TDZ precision as out of scope.

## Design problems to fix in the redesign

Do not use raw `console.log(function)` as an event payload. Function string output can change because of wrapper shape or symbol names. Events should be structured JSON with primitive values.

Shrinking must preserve the same concrete failure signature, not just the same broad verdict. For sequence differences, keep a normalized changed-event signature. For runtime errors, keep normalized error kind and message. For exit mismatch, keep the source crash identity and bundle behavior.

Known failure buckets must not hide new shapes. A campaign may aggregate known families for readability, but it should still count and expose distinct normalized signatures inside each family.

The first redesign should add coverage tracking by mechanism, not just by seed count: dynamic roots, barrel depth, pure package metadata, manual chunking, source cycles, chunk cycles, live binding snapshots, value-only observations, and expected-crash inputs.

Coverage gaps from the old implementation remain open: top-level await, CJS and mixed-module graphs, externals, getters or property side effects, and racing dynamic arrivals.
