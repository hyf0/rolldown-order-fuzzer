# Organic chunking, scale, and dynamic-import density

Wave 6 makes three real-app shapes expressible that a 25,000-case green campaign still missed — a
sweep of four real apps (ComfyUI, camunda, shadcn, vben) found four runtime breakages under on-demand
wrapping the fuzzer never caught. The reflection identified three expressibility gaps this wave closes.
Builds on [multi-edge-pairs](./multi-edge-pairs.md), [node-legal-cycles](./node-legal-cycles.md), and
[schedule-phase-markers](./schedule-phase-markers.md).

## Why (the gaps)

1. **Chunk-composition realism.** The build config only supported explicit manual chunk groups (exact
   module lists) and the default automatic chunking. Real Vite apps produce their chunk shapes through
   ORGANIC merging — size / share-count-driven grouping where the BUNDLER decides composition — yielding
   high-in-degree shared chunks, vendor-style merges, and chunks hosting many modules whose intra-chunk
   statement placement matters.
2. **Scale.** Case size was capped at 16 modules; real chunks host hundreds. At least one real breakage
   (an init call placed before a same-chunk `var` assignment) is an intra-chunk placement bug that tiny
   chunks cannot stress.
3. **Dynamic-import density.** Real apps have dozens of route-level dynamic chunks, including dynamic
   imports inside dynamically-imported modules (nested chains).

A campaign that goes RED here with a genuine divergence is a SUCCESS of this wave — the point is to
catch what was missed. Nothing below weakens the replication contract (no top-level await, no
mixed-format cycles, no TDZ value cycles, CJS-namespace enumeration excluded); the validator still
encodes all of it.

## A. Organic chunking axis

A per-case chunking-config dimension rolled by the seeded RNG, with three values, recorded in the model
(`model.json`) so a failed case replays byte-identically through `shrink.ts`:

- `default` — no grouping config (rolldown's automatic chunking, `codeSplitting: true`).
- `explicit` — the audited manual-group behavior (exact module lists; includes splitting a cycle across
  groups, the cross-chunk init-cycle shape). Uses `ProgramModel.manualChunkGroups`.
- `organic` — `ProgramModel.organicChunkGroups`: size / share threshold groups whose composition
  ROLLDOWN decides. Maps one-to-one onto rolldown's `output.codeSplitting.groups`
  (`CodeSplittingGroup`).

The two group fields are mutually exclusive (a case is exactly one mode); `validate-model.ts` rejects a
program carrying both. `deriveCoverageTags` reads the fields and emits exactly one of
`chunking:default` / `chunking:explicit` / `chunking:organic` per case, plus `mechanism:organic-chunks`
for organic. `buildChunkingConfig` in `generate.ts` leans organic ~45% so it stays ≥40% of
random-mixed cases even after a mode degrades to `default` when a graph is too small to group.

### The exact option shape (verified against the runtime, not memory)

`OrganicChunkGroupConfig` mirrors the fields the frozen snapshot (rolldown 1.1.5) honors — read from
`node_modules/rolldown` `.d.mts` and confirmed by a smoke build, NOT guessed:

- `name: string` (also the chunk name via `chunkFileNames`'s `[name]`).
- `test?: string` — a regular-expression SOURCE matched against a module's resolved file PATH; absent =
  match every module. Stored as a source string so it round-trips through JSON; the build child
  reconstructs `new RegExp(test)` so rolldown matches by regex, not substring. `\.mjs$` / `\.cjs$` gives
  a format-vendor merge.
- `minShareCount?: number` — capture a module only when at least this many entry chunks reference it
  (rolldown default 1). This is the vendor-merge / high-in-degree lever.
- `minSize?` / `maxSize?: number` — byte-size accumulation / splitting. `maxSize` splits an accumulated
  group into several close-to-`maxSize` chunks.
- `priority?: number` — groups compete for modules; higher priority claims first.
- `includeDependenciesRecursively?: boolean` — the manual groups already set this `false` (safe with the
  `preserveEntrySignatures: allow-extension` + `strictExecutionOrder: true` this fuzzer always sets);
  organic randomizes it.

`buildOrganicChunkGroups` rolls one of five empirically-verified flavors so the axis produces VARIED
compositions rather than dead coverage: vendor-share merge (`minShareCount≥2`), size-split
(`maxSize`), broad merge (`minShareCount:1`, one chunk hosting many modules), format-vendor
(`\.mjs$`/`\.cjs$` test), and two-group priority competition. `minShareCount` is capped at the case's
entry count so a share threshold can actually capture something.

### Why the oracle stays valid

Chunking is BUNDLE-SIDE ONLY — the source run executes the rendered `.mjs`/`.cjs` files directly and
never sees a chunk config, so no chunking value can change source-run semantics. The differential oracle
therefore needs no new validator semantics for this axis. A build that mis-orders under an organic
composition (or panics on a cyclic chunk graph) is a genuine bug: an `events-reordered` /
`bundle-only-crash` / `build-failure:panic` verdict, exactly what this wave hunts.

## B. Scale axis

- `MAX_CASE_SIZE` raised 16 → 48; `MAX_RANDOM_MODULES` raised 16 → 48. `DEFAULT_CASE_SIZE` unchanged (4).
- The DAG scales with the requested size (`dagCount` is `3 + rng.integer(size + 1)` capped at
  `MAX_RANDOM_MODULES` minus 2, reserving room for the cycle cluster and barrels), so a size-48 case
  really hosts dozens of modules — stressing intra-chunk statement placement. Small sizes keep the
  historical shape (the raised cap never binds there).
- **Campaign size mix.** When `--case-size` is NOT given, the campaign draws each case's size from a
  weighted small (6–12) / medium (16–24) / large (32–48) spread (`sampleCaseSize`), seeded by the case
  seed (a separate RNG instance from the generator's, both from `seed`, so the draw and generation stay
  independent and reproducible). `--case-size N` pins the size and turns the mix off
  (`CampaignOptions.sizeMix`). The drawn size is recorded on the case, so a replayed single case passes
  `--case-size <drawn>` and reproduces exactly.
- Event count stays well under the 512 cap even at size 48 (measured max 72 events/case).

## C. Dynamic-import density

- Dynamic-edge density raised modestly: CJS ~1/4 → ~1/3, ESM ~1/6 → ~1/4.
- **Nested dynamic chains.** Before, a dynamic import inside a dynamically-imported module occurred only
  by rare accident. Now a deliberate pass biases some dynamic edges to ORIGINATE from a module that is
  itself a dynamic-import target (forward-only, reusing `usedEdges` so no duplicate/cyclic edge), so the
  inner import only evaluates once the outer dynamic import fires. `mechanism:nested-dynamic` tags a
  module that is a dynamic-import target, is NOT synchronously reachable from any entry, and owns a
  dynamic-import dependency.

## Invariants (do not break)

- One chunking config per case; `manualChunkGroups` and `organicChunkGroups` never coexist (validated).
- Organic groups reference no module id, so they survive a module drop unchanged — `shrink.ts`
  `dropModule` preserves them for byte-identical replay, and a shrink candidate can drop the whole
  organic config to reveal whether chunking is load-bearing for a bug.
- The chunking config is threaded through BOTH the campaign path
  (`main.ts` → `rolldown-adapter.ts` → `rolldown-build-child.ts`) and the replay/shrink path (same
  functions, driven from `shrink.ts`). `FAILURE_ARTIFACT_SCHEMA_VERSION` bumped 14 → 15; the artifact
  identity records the effective `codeSplitting` (organic groups / manual groups / automatic) so a
  different chunking config yields a distinct artifact.
- All standing exclusions hold unchanged (no TLA, no mixed-format cycles, no TDZ value cycles, CJS
  namespace enumeration excluded).

## How verified

- **Option shape:** read the `CodeSplittingGroup` type from the local `rolldown` `.d.mts` and confirmed
  the frozen snapshot (rolldown 1.1.5) exposes the same fields; a standalone smoke build against the
  snapshot proved each lever changes composition — `minShareCount:2` merges shared modules into one
  vendor chunk, `minShareCount:1` broad hosts all modules in one chunk, `maxSize` size-splits, and two
  priority groups compete — with side-effectful modules (constant `export const` leaves get inlined and
  mask the effect, mirroring the fuzzer's real `__orderEvent` output).
- **Tractability:** generate+validate+render at size 48 is ~0.5ms/case; the shrinker loads and replays a
  35-module organic model against the snapshot and terminates (greedy, monotonic size decrease — no
  artificial step limit needed).
- **Acceptance campaigns:** the 6-cell matrix ({pure-esm, pure-cjs, mixed} × {on-demand, wrap-all}) ran
  green against the snapshot with organic ≈ 45–50% of random-mixed cases, sizes spanning all three
  scales, and nested-dynamic dense — confirming the new axes are exercised, not just implemented.

## Shrink wrap-mode (wave-6 residual closed in wave 7)

The wave-6 residual — `shrink.ts` hardcoding `onDemandWrapping: true`, so a wrap-all-only failure could
not reproduce under the shrinker — is CLOSED: `shrink.ts` now selects the wrap mode (`--wrap-all` /
`--on-demand`, auto-read from a failure artifact's `replay.json`). See
[real-app-bug-families](./real-app-bug-families.md).
