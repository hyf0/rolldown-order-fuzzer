# Real-graph skeleton transplant cell

A corpus cell (`transplant/`) of committed differential cases whose SHAPE comes from real applications,
not the random generator. Each case is a real app's module-graph skeleton — extracted during one
ordinary production build, reduced to its order-relevant core, anonymized, and emitted as a
fuzzer-schema `ProgramModel` at the current schema (no names, paths, or code — only `m<index>` ids).
The point: exercise the differential oracle on the graph SHAPES real apps actually have (barrel density,
package boundaries, chunk composition, dynamic route-splitting), and — with the witness overlay — carry
a known bug shape that reds a buggy bundler and auto-shrinks to its minimal core.

Feasibility was proven end-to-end first; see
`research/vite-chunk-execution-order/skeleton-transplant-feasibility.md`.

## The pipeline (five units)

```
real app  --extract-->  graph.json  --reduce-->  reduced  --emit-->  ProgramModel  --overlay-->  witness variant
          (unit 1)                  (unit 2)              (unit 3)                  (unit 4)
                                                                                        |
                                                       transplant/models/*.json  <------+  (committed)
                                                                                        |
                                                       npm run transplant:cell  <-------+  (unit 5)
```

1. **Extractor** — `scripts/transplant/extract-plugin.mjs` (+ `extract-wrapper.mjs`). A rolldown/Vite
   build-time plugin that dumps the module graph during ONE ordinary build. Core facts come faithfully
   from `ModuleInfo` (module set, per-module input format, static + dynamic import edges, reverse edges,
   export-name lists, entry flags) and `OutputChunk` (the real chunk composition). On top it adds
   edge-precise import KIND / export SHAPE (named / default / namespace / side-effect; reexport-star /
   reexport-named / reexport-namespace) via the plugin context's own AST parser (`this.parse`, correlated
   to the resolved `importedIds` through `this.resolve` — NOT a regex scanner), plus the package BOUNDARY
   from the id path and that package's `sideEffects` metadata read once per package. The plugin never
   throws (a parse/resolve failure degrades to a regex scanner) so it can never break the app's build.
   Measured 100% AST + resolve success on all three apps.

2. **Reducer** — `scripts/transplant/reduce.ts`. Three composable strategies from the feasibility doc:
   VENDOR/LEAF COLLAPSE (a self-contained multi-member vendor package — lucide-react's 1706 icons,
   date-fns' 826 locales — collapses to one representative), ORDER-CORE k-HOP (seed at entries /
   app-source / star-barrels / cycle members / shared hubs, expand k hops, close under induced edges),
   and optional SCC-QUOTIENT. Then the MIXED-FORMAT-CYCLE BREAK contract (a strongly-connected component
   spanning ESM and CJS is Node-illegal and unrepresentable, so its cross-format edges are dropped;
   single-format side-effect/require cycles are Node-legal and kept) and an EVENT BUDGET (at most 500
   modules emit events — the harness cap is 512 EVENTS, not modules; the rest stay structurally present
   but event-free).

3. **Emitter** — `scripts/transplant/emit.ts`. Maps the reduced graph to a `ProgramModel`: ids ->
   `m<index>`, edges -> the right dependency kind by importer format (default PURE-ORDER: every static
   edge a side-effect import / plain require, so the skeleton is robustly green on a correct bundler),
   dynamic edges -> registrations + triggers for statically-reachable owners, one distinct evaluate event
   per event-budgeted module. Package boundaries + `sideEffects` metadata survive as W14b `PackageModel`s
   (a package carries `sideEffects:false` only when every member satisfies the metadata-purity contract —
   event-free, ESM, value-only; else the boundary survives with `sideEffects:true`). The `BuildConfig`
   axes match the app's real build where representable: `outputFormat` (esm), an organic-group chunking
   approximation of the real chunk composition, seo. A `faithfulReexports` mode renders the real
   star/named/namespace re-export shapes (used by the #10044 test).

4. **Overlay** — `scripts/transplant/overlay.ts`. Plants the fuzzer's known witnesses on the skeleton:
   FAMILY A (an inferred-pure definer behind a STAR barrel, split-read by two namespace-importing
   entries) reds a buggy bundler in both wrap modes with the primitive-JSON signature and greens when
   fixed; OBJECT IDENTITY (an object-export definer captured two ways) catches a silent double-init.
   Phase markers come free from the schedule; pure modules stay event-free per the inferred-pure
   discipline.

5. **Runner** — `scripts/transplant-cell.ts` (`npm run transplant:cell`). Executes the committed models
   through the same `executeProgram` seam the campaign uses, in BOTH wrap modes: baselines + overlays
   against the GREEN target (final PR-10104 snapshot) expecting PASS, overlays against the BUGGY target
   (rolldown 1.1.5) expecting RED with the family-A signature. Writes
   `.agents/evidence/transplant-cell.json`. NOT part of `vp test` (it builds against out-of-tree
   snapshots).

## What is committed

- `transplant/index.json` — the manifest (apps, source paths, original/kept module counts, model paths,
  targets, expected signature).
- `transplant/models/<app>.json` — the pure-order BASELINE (organic chunking, green both modes).
- `transplant/models/<app>.overlay.json` — the family-A OVERLAY variant (automatic chunking, reds the
  buggy snapshot both modes, greens the final snapshot, shrinkable).

The three seed apps: **shadcn-admin** (3973 -> 260), **vue-vben-admin web-antd** (7904 -> 260),
**comfyui** (5719 -> 260). Extracted graphs are NOT committed (they are multi-MB and regenerated per
sweep); only the anonymized models are.

## Regeneration flow (per real-app sweep, ~1–3 min piggybacked)

Extraction piggybacks on the sweep builds that already happen — add the plugin to the sweep wrapper. The
marginal cost is the emit + run, not a second build.

```sh
# 1. EXTRACT (per app): build the app with the skeleton extractor injected.
VITE=/tmp/rolldown-strict-order-study/pr10104-runtime-env/node_modules/vite/bin/vite.js
WRAP=scripts/transplant/extract-wrapper.mjs
cd /tmp/rolldown-strict-order-study/pr10104-repos/satnaing__shadcn-admin
SKELETON_OUT=/tmp/graphs/shadcn-admin.json SKELETON_APP=shadcn-admin \
  SKELETON_BUILD_OUT_DIR=/tmp/skeleton-build CI=1 NODE_ENV=production \
  node "$VITE" build --config "$WRAP"
# (comfy adds STRICT_ORDER_PROJECT_CONFIG=vite.config.mts DISTRIBUTION=cloud; vben cwd apps/web-antd,
#  extra vite arg `--mode production`.)

# 2. REDUCE + EMIT + OVERLAY -> committed models.
vp exec node scripts/transplant/build-models.ts /tmp/graphs/shadcn-admin.json transplant/models
vp check --fix   # the model JSON is prettier-normalized (build-models writes JSON.stringify)

# 3. RUN the cell.
npm run transplant:cell
```

Extraction time is bounded by the app's own build: shadcn 6.8s, vben 17.1s, comfy 32.5s (100% AST +
resolve). Reduction is ~20ms. The full cell (3 apps × both targets × both wrap modes) runs in ~6s.

## Add an app

1. Pick an app from `/tmp/rolldown-strict-order-study/{pr10104-repos,more-repos,next-repos}/` with
   `node_modules` installed and a buildable config.
2. Extract its graph (step 1 above), noting any per-app config file / env / mode.
3. `build-models.ts <graph> transplant/models` — it validates both models at the current schema before
   writing, and fails loudly if the skeleton can't be expressed.
4. Add an entry to `transplant/index.json` (source path, module counts, model paths).
5. `npm run transplant:cell <app>` — baseline green both modes, overlay green on final + red on buggy.

## The #10044 transplant thesis test — an HONEST LIMIT

The proof obligation was to reproduce rolldown #10044 (a 1.1.3 link failure `[MISSING_EXPORT] "RESET"`,
where `@griffel/react` does `export { RESET, … } from '@griffel/core'` but `@griffel/core` exposes RESET
only transitively via `export * from './constants.js'`; fixed 1.1.4) via transplant — the case a
25,000-green fuzzer corpus and five hand-written synthetics all MISSED, reproducing only with the real
@fluentui/@griffel graph.

`scripts/transplant/repro-10044.ts` extracts that real graph (2122 modules, via the extractor on a
working rolldown ≥1.1.4) and builds a FAITHFUL transplant preserving the full topology, the exact
`RESET`-only-via-star re-export chain, a retained `RESET` read, and the package boundaries. Result
(`.agents/evidence/transplant-10044-limit.json`): **the transplant does NOT reproduce** — it is GREEN on
rolldown 1.1.3 at every scope (griffel-only and full 2122, with and without packages, direct and
sibling retention), even though the RENDERED model provably contains the exact `export { RESET } from
"…"` + `export *` shape (`module-2046.mjs: export { RESET } from "./module-1963.mjs"`, where
module-1963 obtains RESET only via `export *`). The real graph reproduces via bare rolldown 1.1.3
(`import { Title1 } from '@fluentui/react-text'`); the transplant of that same graph does not.

**The precise limit — which ingredient the model cannot carry:** not the re-export chain shape (present),
not module scale (2122 preserved), not the package boundary (preserved), not `sideEffects:false`
(preserved where the metadata-purity contract allows). What is lost is the emergent LINK ORDER the bug
depends on — the specific order in which rolldown 1.1.3's linker visits and resolves the real
`@fluentui/react-text` modules, which emerges from their real BODIES and rolldown's own scheduling of
them. The anonymized fuzzer skeleton reconstructs the graph STRUCTURE but not that order: it has no real
module bodies, it renders each re-export NAME as a SEPARATE `export { x } from` statement (rolldown's
real barrels carry many names on one statement, so retaining one sibling retains RESET — the model's
renderer cannot express that co-retention), and module order is fixed by synthetic sorted ids rather than
the real resolution schedule. This matches the prior investigation's conclusion (the trigger is an
emergent property of the real graph's scale + link order, not an isolable structural motif — every
representable motif was shown necessary-but-insufficient) and is consistent with the honest-limit branch
the plan anticipated. No RED-10044 bracket is registered; the finding stands as the documented boundary
of the technique.

## Acceptance evidence

- **Golden UNCHANGED** — `corpus:check` 458 cases byte-identical (the transplant cell is entirely
  separate; no generator change). `vp check` + `vp test` green. `regression:redset` all 9 brackets hold.
  `seo-false-sanity` + `catching-power` intact.
- **Three transplants GREEN** on the final snapshot (both wrap modes) via `npm run transplant:cell`;
  evidence `.agents/evidence/transplant-cell.json`.
- **Witness fires** — every app's overlay reds the buggy snapshot in BOTH wrap modes with
  `bundle-only-crash:["Error","Execution event value must be a primitive JSON value"]` and greens on the
  final snapshot. The shadcn overlay (265 modules) auto-shrinks to the 5-module family-A core with the
  signature preserved (`src/shrink.ts --model transplant/models/shadcn-admin.overlay.json
--rolldown-package <buggy-snapshot>`); the shrunk core is committed at
  `.agents/evidence/transplant-shrink-shadcn-overlay.json` (valid, red on buggy, green on final).
- **#10044** — the honest limit above; evidence `.agents/evidence/transplant-10044-limit.json`.
