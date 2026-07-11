# FW-B — machinery-stress wave (optimizer cycles, dynamic×wrap-kind, wrapping-completeness, brackets)

Directed stress at the two most regression-prone machinery clusters from the fix-history mining, plus
the W14c follow-up leak and the remaining bracket backlog. It builds on
[the W14c demand + flag-off wave](./w14c-demand-and-flagoff.md), the
[W14a structural foundation](./w14a-structural-foundation.md), and the
[standing regression red-set](./regression-red-set.md). Source of the targets: the fix-history mining
doc `research/vite-chunk-execution-order/fix-history-mining.md` (clusters 1, 4, 5 + section 4 brackets).

Five deliverables landed; ONE labeled golden regen (`golden: FW-B exotic import reads`), every delta
proven by the causal `explain-delta` (extended for the new read forms), 0 unexplained.

## Deliverable 1 — optimizer runtime-placement / facade cycle (cluster 1.1, the #1 regression magnet)

`buildOptimizerCycle` / `generateOptimizerCycleCase` (`generate.ts`) — the directed shape family for the
chunk-optimizer inter-chunk cycle. Two variants:

- **`runtime-placement`** — the #9993/#10101 ("a regression of #9224") shape as a GENERATOR: two CJS
  entries write `exports.*` (a third CJS consumer requires both, forcing the exports); one entry
  side-effect-`require()`s an ESM leaf OUTSIDE a manual group; the group captures the two CJS entries but
  NOT the leaf, at `includeDependenciesRecursively:false`. The CJS `__commonJSMin` runtime helper is
  placed into a sibling chunk the group chunk imports back → the bundle throws `TypeError: __commonJSMin
is not a function` at eval on rolldown@1.1.4 (RED), fixed on @1.1.5 (GREEN). **This supersedes the
  mining doc / FW-C verdict that the #9993 shape is "not expressible without new generator capabilities"**
  — it is expressible, and reproduces the EXACT RED-3 signature from a `ProgramModel`.
- **`facade-shared`** — both CJS entries `require()` the shared ESM leaf; a merge/facade probe (green on
  the fixed releases, watched for a fresh red).

Both keep the MODULE graph acyclic (only the chunk graph is cyclic, manufactured by the split), so the
source runs cleanly and the differential oracle is valid. Structural tag
`mechanism:optimizer-runtime-placement-cycle` marks the RECIPE (a manual group capturing a CJS
requirer but not its required ESM leaf, at idr:false); the campaign VERIFIES the actual merge + cycle.

- **Chunk-graph verification** (`scripts/chunk-graph.ts`): the differential-oracle build path only needs
  chunk file names + entry facades, so it does not thread per-chunk module lists / imports. This harness
  builds a rendered program DIRECTLY with a target rolldown and reads the raw `OutputChunk` graph
  (`moduleIds` + `imports`) — the same objects the build child serializes — reconstructing the
  code-splitting config to MATCH `createOutputOptions`. It reports the optimizer MERGE density (a chunk
  holding ≥2 model modules) and the QUOTIENT CYCLE (a cycle in the emitted chunk import graph), so a case
  is counted verified-merged only when the recipe actually fired. (The macOS `/private` symlink is
  realpath-normalized so the manual-group exact-path `test` and the moduleId→id remap both match.)
- **Campaign** (`scripts/optimizer-cycle-catch.ts`, 20 seeds/variant × 3 targets): `runtime-placement`
  RED 20/20 on 1.1.4 (the `__commonJSMin` signature), GREEN on 1.1.5 + snapshot; merge + quotient cycle
  verified 20/20 on 1.1.4 — the RED-3 bracket reproduced by the GENERATOR. Cluster 1.1 is still leaky, so
  any red on 1.1.5/snapshot is a LIVE CATCH (none today). Evidence `.agents/evidence/optimizer-cycle.json`.
  - **Structural finding**: on 1.1.5 the runtime-placement chunk graph STILL merges + STILL has the
    quotient cycle, yet runs GREEN (the #10101 fix follows entry-facade edges so the cyclic graph
    evaluates correctly); on the final snapshot the cycle is ELIMINATED (cycle count 0). The two fixes
    take different routes — recorded because a chunk-cycle count alone would misread 1.1.5 as still buggy.

## Deliverable 2 — dynamic-entry × wrap-kind × merge (cluster 4 / T1, the MISSING cell)

`buildDynamicWrapKindMerge` / `generateDynamicWrapKindMergeCase` (`generate.ts`) — the historically
never-crossed cell: a dynamically-imported target the optimizer inlines/merges into a common or user
chunk under a CJS/ESM wrap-kind while ≥2 entries share it. Three variants, each across both wrap-kinds:

- **`shared-dynamic`** — the target is dynamically imported by TWO eager entries (a shared dynamic entry),
  co-located by an `entriesAware` organic group. The target carries an event: at seo:true it must fire
  EXACTLY ONCE, so a wrap-kind that re-evaluates the inlined dynamic entry emits the event twice (caught
  by the full-order oracle).
- **`static-dynamic-merge`** — the target is shared STATIC (a carrier folds its value) AND DYNAMIC (an
  entry triggers it), with a manual group merging {carrier, target} at idr:false (the #7757/#7783 shape).
- **`identity-double-init`** (ESM target only) — the target is an `objectExport` definer captured two
  ways by a carrier (directly and through an `export *` barrel), comparing object IDENTITY, while an entry
  dynamically imports it. Composes the silent-double-init object-identity witness into the T1 cell.

Structural recipe tag `mechanism:dynamic-entry-wrap-kind-merge` (a chunk-splitting config co-locating a
dynamic-import target — a manual group with the target + ≥1 other module, or an entriesAware organic
group). **Campaign** (`scripts/dynamic-wrap-kind-catch.ts`, 20 seeds × 5 variant/format cells × 3
targets): GREEN in every cell, dynamic entry VERIFIED-MERGED 20/20 (chunk inspection: `dw-t` in a chunk
of ≥2 modules) — cluster 4 is believed fixed on 1.1.x, so this is COVERAGE of a cell the fuzzer never
crossed, watched for a fresh red. Evidence `.agents/evidence/dynamic-wrap-kind.json`.

## Deliverable 3 — wrapping-completeness frontier (cluster 5, the #10180 churn)

The order-sensitivity classifier is being rebuilt upstream (#10168 split the metadata, #10180 rebuilt
`TopLevelImportReadDetector`, whose rationale is that the signal "may never miss a top-level read of an
imported binding" and the per-expression-form analyzer "is exactly how gaps slip in"). This lands the
exotic statically-visible-but-tricky read forms that detector must classify, all via the CANONICAL
member-PATH representation — ONE representation, no parallel form (the W14 must-not-repeat rule):

- **`ValueRead.computedHopIndex`** — a COMPUTED INTERMEDIATE hop `binding[<key>].tail` (the `a[imp].y`
  form): the named hop renders a runtime-built key while a STATIC tail follows it. Mutually exclusive with
  `computed` (which hides the DEEPEST access); must be an intermediate hop `0 ≤ index < path.length - 1`.
- **`ValueRead.alias`** — an ALIASED namespace read `const <binding>_alias = <binding>; <alias>.member`
  (the `const x = ns; x.foo` form): a rendering-only local alias of the namespace import. The demand
  routing and observed value are identical to the direct read (`binding` still names the import — ONE
  canonical read), so it is not a parallel representation.
- composed through the existing `esm-reexport-namespace` nested read (the M7 route `outer.ns.member`).

Wired through model / validate (both fields valid only on a namespace import binding; `validateExoticReadForm`)
/ render (`renderRead` handles both; `renderAliasDeclarations` emits the `const x = ns;` before the
events). A gated end-stage injector `injectExoticImportReads` (ESM-only, drawn LAST) seeds them into
random-mixed; the directed `buildExoticImportReads` folds the same inner member all three ways for the
campaign. Because the inner is a non-inlinable inferred-pure value, a detector miss that dropped its init
would fold `undefined` → NaN. Tags `variation:computed-intermediate-read` + `variation:aliased-namespace-read`.

- **The ONE golden regen** (`golden: FW-B exotic import reads`): `explain-delta` vs the pre-wave golden =
  458 cases — 434 byte-identical, 14 changed with packages, 10 changed by a new operation only, **0
  unexplained**. `carriesNewOperation` / `carriesModuleNewOp` were extended so the exotic read forms count
  as a new-operation surface. The model/render changes are additive (byte-identical for every existing
  read: `renderRead` and `renderAliasDeclarations` no-op when the new fields are absent).
- **Campaign** (`scripts/exotic-reads-catch.ts`, 20 seeds, od+wa × npm 1.1.5 + snapshot): GREEN in every
  cell, all three forms tagged — the rebuilt classifier handles them, so this is coverage that the
  generator reaches the churning detector paths. An od-only red (green in the same-seed wa control) would
  be a completeness catch. Evidence `.agents/evidence/exotic-reads.json`.

## Deliverable 4 — the W14c follow-up leak (folded into RED-9998)

W14c recorded a residual "broader automatic-chunking cross-entry leak". FW-B's ablation
(`scratchpad/fw-b-probe/probe-d4b`) PINS the minimal trigger and CORRECTS the characterization:

- **The "automatic chunking" claim is DISPROVEN.** Automatic chunking does NOT leak (verified GREEN on
  both npm 1.1.5 and the snapshot; 0/28 random automatic multi-entry seo:false cases leaked). A
  co-locating ORGANIC GROUP (`entriesAware` OR a plain `test:".*"`) is load-bearing — with automatic
  chunking, one entry's chunk never imports a chunk holding another entry's private module.
- **The genuinely broader surface is PURELY STATIC** (no dynamic import required, and a PLAIN group
  suffices — not only `entriesAware`): two mutually-unreachable entries sharing a static module, each
  owning a private eager module; loading ONE entry runs the OTHER's private top-level
  (`reachability-isolation:[le2-b,le2-pb]`). `buildStaticCrossEntryLeak` / `generateStaticCrossEntryLeakCase`.
- **Same ROOT mechanism as #9998** (a co-locating organic group at seo:false runs a disjoint-reachability
  entry's top-level, caught by the reachability-isolation oracle) — only a broader TRIGGER. Per the
  deliverable's same-root instruction, it FOLDS into the RED-9998 bracket-pending entry's notes rather
  than a new bracket.
- **Campaign** (`scripts/broad-cross-entry-leak-catch.ts`, 20 seeds): isolation RED 20/20 on BOTH npm
  1.1.5 AND the snapshot, seo:true control GREEN. Evidence `.agents/evidence/broad-cross-entry-leak.json`.

## Deliverable 5 — bracket backlog (RED-4…RED-7)

Verified each mining-doc bracket by building a minimal runtime-witness fixture and bracketing it across
the actual npm versions. THREE land as raw runtime-witness entries; ONE does not (honestly residual):

| id        | issue | bracket                 | red signature                                                        | note                                                            |
| --------- | ----- | ----------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| **RED-5** | #9353 | 1.0.1 → 1.0.2           | `TypeError: Cannot read properties of undefined (reading 'muiName')` | wrapped-ESM re-export owner not initialized                     |
| **RED-6** | #7771 | 1.0.0-beta.58 → beta.59 | `SyntaxError: Export 'imp_exports' is not defined in module`         | dynamic entry merged into a common chunk with cjs+esm wrap kind |
| **RED-7** | #9164 | 1.0.0-rc.17 → rc.18     | `TypeError: __exportAll is not a function`                           | dominator runtime-placement cycle                               |
| RED-4     | #9669 | 1.1.0 → 1.1.1           | (build PANIC, not runtime)                                           | NOT landed — see below                                          |

Two **mining-doc bracket corrections** (both evidenced against the actual fix commits): RED-7 is
**rc.17 → rc.18**, not rc.15 → rc.16 (the #9164 fix commit 5a5f8f5d7 lands at rc.18; rc.15/16/17 all
predate it). RED-6 brackets cleanly on **published betas (beta.58 → beta.59)** — no nightly git-bisect
needed (the doc's pessimistic "pre-beta bisect" was wrong).

**RED-4 (#9669) is deliberately NOT landed.** Its pre-fix (1.1.0) manifestation is a Rust BUILD PANIC
(`"init_external" is not in any chunk`), not a runtime witness — the fix adds an `is_included` guard that
makes the finalizer SKIP an `init_*()` for a tree-shaken wrapped owner; before it, the finalizer hits a
defensive panic rather than emitting runnable-but-wrong code, so there is no runtime `undefined`-fold to
witness. Every config that avoids the panic also avoids the bug. The mining doc's "folds `undefined`"
expectation for RED-4 is a mischaracterization; the runtime Family-A coverage it would add is already
provided by RED-1 (#9502) and RED-5 (#9353). Per the discipline ("a bracket that fails verification:
report honestly, do not land it"), it stays a documented residual. The redset now runs 8 brackets, all HOLD.

## Verification (acceptance)

- **golden** regenerated ONCE (`golden: FW-B exotic import reads`); `explain-delta` 0 unexplained (above).
- **`vp check` + `vp test`** green (404 tests, +14 over the W14c baseline of 390).
- **6000-case validate+render sweep** across the 4 regime cells: 0 rejections, 0 render failures.
- **New tag densities** (6000-case sweep): `mechanism:dynamic-entry-wrap-kind-merge` 6.4%,
  `variation:computed-intermediate-read` / `variation:aliased-namespace-read` 5.4% each,
  `mechanism:optimizer-runtime-placement-cycle` 0.37% in random (the directed campaign is the
  concentrated coverage). `mechanism:cross-entry-leak` is 0% in random-mixed (seo:false is not rolled
  there; the directed campaigns cover it).
- **`npm run regression:redset`** — all 8 brackets HOLD (RED-0/1/2/3/5/6/7 + RED-9998).
- **catching-power** 22.8% (mixed-od 24.7%, mixed-wa 21.0%), within the committed 21–27% band and
  unchanged from W14c — the FW-B shapes are green coverage, so they add no reds and do not move the band.
- **seo:false sanity** 300 single-entry cases: 0 isolation false positives, 35 relaxed-order divergences
  correctly ignored.
- Per-deliverable campaign matrices in `.agents/evidence/{optimizer-cycle,dynamic-wrap-kind,exotic-reads,broad-cross-entry-leak}.json`.

## Adversarial review (post-wave)

An independent adversarial review of the full wave diff found NO blockers — it re-verified the D1
module-graph acyclicity + merge/cycle evidence, probed all 8 malformed exotic-read forms against the D3
validation guards (all rejected; the 4 valid forms accepted), re-ran the D5 fixtures against their
bracket versions (signatures match exactly), and independently confirmed the D4 automatic-chunking
disproof. Two of its findings were fixed in follow-up commits: the D4 evidence's ablation result is now
MEASURED by a live automatic-chunking control inside the campaign (not a hardcoded literal), and
`inspectChunkGraph` now threads `onDemandWrapping` (mirroring the run's wrap mode) into the input
experimental options — probed identical merge/cycle verdicts for the FW-B shapes either way, but the
reconstruction must not silently inspect a different build. Two remaining notes, verified harmless and
deliberately NOT code-churned:

- `aliasVarName` (`render.ts`) emits `const <binding>_alias = …` without a collision check. Unreachable
  today (only the exotic generators set `alias`, and their binding names never end in `_alias`), and a
  future collision fails LOUD (a duplicate-const SyntaxError at build), never a silent false-pass. Route
  through `freshBinding` if `alias` ever spreads to arbitrary random-corpus bindings.
- `hasDynamicEntryColocationRecipe`'s organic branch tags any entriesAware group + any dynamic import
  without checking the group captures the target. Harmless today (0 golden occurrences — random chunking
  never sets entriesAware; only opt-in cells could over-tag, and it is a coverage tag with no witness
  impact). Tighten if entriesAware ever joins the rolled organic flavors.

## Residual gaps (next: FW-A — non-ESM output axis)

> **FW-A LANDED** — see [fw-a-output-format-axis.md](./fw-a-output-format-axis.md). The output-format axis
> (`esm|cjs`), transpiled-CJS interop, RED-3→generator upgrade, and the two campaigns landed; it reached a
> genuine CJS-output-arm bug (RED-8: the object-identity double-init witness reds `init_module_NNNN is not
defined` on npm 1.1.5, green on the snapshot — cjs-output + on-demand only). P9 deconfliction (RED-2) and
> RED-1's exact `init_shared` remain residual (they need a hybrid ESM-import+CJS-exports module / a
> packaged leaf) — documented per-entry in the FW-A doc. The notes below are the pre-FW-A plan, kept for
> provenance.

- **FW-A is the non-ESM output axis** (`format: cjs|iife|umd`), which unlocks P7/T4 (CJS output),
  P3 (transpiled-CJS interop), and P9 (deconfliction) — the ~30-fix surface behind the ESM-output +
  unique-names pins. Set up for it here: (1) `scripts/chunk-graph.ts` builds directly with any target
  rolldown and reads the raw output — the `format` is a single option to vary, so a CJS-output chunk
  inspection reuses it wholesale; (2) the D2 dynamic × **wrap-kind** axis already parametrizes the
  CJS/ESM boundary at the module level, the natural seam for a CJS-OUTPUT variant; (3) the object-identity
  double-init witness (D2 `identity-double-init`) is exactly the wave-8 witness FW-A's CJS-output
  self-rebinding-wrapper regression needs — it just needs to run against CJS output.
- The optimizer-cycle chunk-graph finding (1.1.5 tolerates the cyclic chunk graph, the snapshot
  eliminates it) means a future "chunk cycle count" heuristic must not be used as a red oracle on its own
  — the RUNTIME witness is authoritative.
