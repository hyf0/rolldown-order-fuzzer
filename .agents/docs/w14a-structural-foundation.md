# W14a — barrel-wave structural foundation

The first deliberately behavior-affecting wave since the golden-corpus regime began. It restores the
renderer's array-order contract, introduces the persisted `BuildConfig` axes, adds the
`build-failure:link` verdict class, and lands the **#9887 cross-chunk init-cycle LIVE CATCH** — a red on
the latest released rolldown. It builds on the [AnalyzedProgram boundary](./analyzed-program-boundary.md),
[consolidation wave](./consolidation-wave.md), and [real-app bug families](./real-app-bug-families.md).

The corpus semantics changed ON PURPOSE at two labeled points: `golden: renderer array-order
reacceptance` (step 1, the renderer fix moves emitted bytes) and `golden: W14a structural axes` (step 7,
the manifest now records the BuildConfig axes). Catching power stayed in its committed 21–27% band at
every commit (measured 23.7%, family-A-dominated, unchanged from the pre-wave baseline).

## 1. Renderer dependency order restored (step 1)

`renderModule` (`render.ts`) emits ONE ordered dependency stream in dependency-ARRAY order, not the
category buckets the consolidation wave had pinned. See [renderer-dependency-order](./renderer-dependency-order.md).
This is foundational for the barrel wave: a module that BOTH imports and re-exports (the coming
interop/package barrels) has a requested-module evaluation order that follows source position, so the
emitted order must equal the model's dependency order for the validator's evaluation-order reasoning to
match Rolldown. Re-accepted against the frozen snapshot: catching-power unchanged, and a 6-cell campaign
(3 regimes × od/wa × 500) showed ZERO new divergence classes — every red is the known family-A
`bundle-only-crash` NaN signature (mixed 22.4/23.2%, pure-esm 21.8/22.0%, all in-band; pure-cjs is
family-A-free).

## 2. Persisted BuildConfig (`model.ts`, schema 16→17)

ONE persisted object, `ProgramModel.build?: BuildConfig`, is the single source of the bundle-side build
axes — consumed by generation, the adapter/build-child, the evaluator, replay/shrink, the artifact
identity, the corpus manifest, and the coverage tags. All bundle-side; NONE changes the source run, so
the differential oracle stays valid.

| Field                            | Role                                                                                                            | Rolled?               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------- |
| `chunking`                       | the `Chunking` union, moved in from the two top-level arrays                                                    | (per case, as before) |
| `includeDependenciesRecursively` | the GLOBAL `codeSplitting.includeDependenciesRecursively` fallback; `false` is an ingredient of the #9887 catch | YES (~50/50)          |
| `preserveEntrySignatures`        | moved in from the hardcoded `"allow-extension"`                                                                 | no (fixed)            |
| `lazyBarrel`                     | `experimental.lazyBarrel`, rolldown's barrel-pruning optimization                                               | YES (~50/50)          |
| `strictExecutionOrder`           | plumbed through, default `true`                                                                                 | no (fixed)            |

- **`strictExecutionOrder` is NOT rolled in W14a.** Every case keeps strict order, and the validator
  REJECTS a hand-crafted `seo:false` model. A `seo:false` cell needs a weaker order oracle that lands in
  W14b: upstream #9998 is a cross-entry leak that only exists at `seo:false`, and the full-order oracle
  would false-positive on the accepted relaxed-order divergences there. So `seo:false` is unrepresentable
  until W14b supplies that oracle.
- **Backward compatible (the v16-artifact reader).** `build` is OPTIONAL; `buildConfigOf(program)`
  resolves a legacy (schema-16) model's config from its top-level chunk arrays + rolldown/fuzzer defaults,
  so an old failure artifact still replays. The schema version is only written, never gated on read, and
  the shrinker reads `model.json` directly. `FAILURE_ARTIFACT_SCHEMA_VERSION` 16→17; the artifact identity
  records the axes so a different config yields a distinct artifact.
- **Smoke-verified honored by the frozen snapshot.** Both `includeDependenciesRecursively` (chunk-graph
  changes) and `lazyBarrel` (wrapped-chunk changes under strict order) produce different snapshot output
  when toggled, so both are real axes worth rolling. The GLOBAL `includeDependenciesRecursively` rides on
  the `codeSplitting` object; current generated groups set it per-group, so the global is inert for them —
  it becomes load-bearing for the #9887 shape (whose groups let the global control it).
- **RNG placement.** The two boolean axes roll at the END of `finalizeProgram` (after every
  source-affecting roll), so the rendered-source corpus is byte-identical — the axes never perturbed a
  single earlier draw (`corpus:check` stayed 458 green through steps 2–6). Coverage tags
  `axis:include-dependencies-recursively:*` (50/50) and `axis:lazy-barrel:*` (50/50).

## 3. Package/layout model — RESIDUAL (deferred to W14a-continuation)

NOT landed in this pass. The intended model: modules belong to named packages rendered as fixture-local
`node_modules/<name>/` with a generated `package.json`; cross-package imports use bare specifiers;
`sideEffects` supports boolean AND array-of-globs (the vben/family-B ingredient), migrating the existing
boolean `sideEffectFree` metadata onto this model. This is the un-flattening ENABLER (M9 / W14-2 of the
barrel-coverage spec) that upgrades family-A/B from shared-chunk stand-ins to real package boundaries. See
[real-app-bug-families](./real-app-bug-families.md) and the barrel-coverage spec's W14-2. Groundwork: the
side-effect-free directory rendering (`render.ts` `SIDE_EFFECT_FREE_DIRECTORY`) already proves fixture-local
`package.json` resolution works under the build child.

## 4. Plan enrichment — RESIDUAL (deferred to W14b)

NOT landed in this pass. Intended: (a) a demand purpose/liveness dimension in `ExportDemandPlan`
distinguishing link-required from live/observed demand (foundation for W14b dead-hop witnesses; NO
`deadHop` flag anywhere); (b) `RouteHop` provenance carrying each hop's target module + exported/imported
name pair; (c) a NEW `export * as ns from` dependency operation (M7 of the spec) through model /
generation / render / validation / plan routes / shrink / tags. All via the plan, keeping the boundary
guard tests passing. The [AnalyzedProgram boundary](./analyzed-program-boundary.md) is the seam these
extend.

## 5. Build/link-failure verdict class (`program-run.ts`)

`build-failure:link` classifies a Rolldown link-time `MISSING_EXPORT` failure (an export a retained
consumer references that the linker cannot resolve — the #10044 family) as a FIRST-CLASS catch, carrying
the missing `(export, module)` identity parsed from the stable `"<name>" is not exported by "<module>"`
phrase, distinct from `build-failure:panic`, a runtime `bundle-only-crash`, and a generic build error.

**Invariant: a GENERATED model never produces a `build-failure:link`.** The plan's supply-status
validation (`validateExportDemand`) rejects any `unsupplied`/`ambiguous` demand, and `renderProgram`
validates BEFORE rendering and throws — so an unsupplied model can never reach Rolldown with an
unresolvable export. A crafted test pins it (an unsupplied default-through-star-only-barrel model is
rejected AND `renderProgram` throws). A `build-failure:link` is therefore ALWAYS a genuine Rolldown linker
bug on a model the fuzzer proved fully supplied. See [build-failure verdicts](./build-panic-verdict.md).

## 6. #9887 cross-chunk init-cycle — the LIVE CATCH (the wave's proof)

`buildCrossChunkInitCycle` / `generateCrossChunkInitCycleCase` (`generate.ts`) express a MODULE-ACYCLIC
graph whose manual chunk split MANUFACTURES a chunk cycle rolldown mis-orders. The shape (5 modules —
already the minimal pre-pin repro):

- `shared` (ESM leaf) — a value definer of `extend`.
- `dep` (ESM) — imports `extend` from `shared` (forward, ACYCLIC — the acyclic variant of the issue's own
  repro, so the validator agrees there is no mixed-format module cycle) and exports `useDep` folding it.
- `interop` (CJS) — side-effect `require()`s of `shared` AND `dep` (the eager CJS init of ESM).
- `hub` (ESM barrel) — side-effect-imports `interop`, NAMED-re-exports shared's `extend`, STAR-re-exports
  `dep`. (Disjoint named+star, so the fuzzer's demand-driven definers stay unambiguous; two stars over two
  synthesizing definers would resolve every name to both — rejected.)
- `consumer` (ESM entry) — imports `useDep` + `extend` through the hub barrel and folds them into an event
  (the witness).

The manual split places `dep` alone vs `{hub, interop, shared}`: the hub chunk needs the dep chunk
(interop requires dep) while the dep chunk needs the hub chunk (dep imports shared's `extend`) — the
manufactured chunk cycle. `includeDependenciesRecursively:false` keeps `dep` in its own chunk (idr:true
pulls it into the hub chunk and dissolves the cycle). Only the CHUNK graph is cyclic (rolldown's own
#9225-class in-contract shape); the module graph is acyclic, so the source runs cleanly and the oracle is
valid. Structural coverage tag `mechanism:barrel-cross-chunk-init-cycle` (manual split + a cross-group
CJS-requires-ESM edge + idr:false), which also fires on ~0.4% of RANDOM cases as bonus coverage.

### Catch evidence (bidirectional, at the fuzzer's seo:true regime)

Proven END-TO-END through the fuzzer build path (`scripts/cross-chunk-init-cycle-catch.ts`, 20 seeds):

- **vs npm rolldown@1.1.5 (the OPEN bug on the latest release): RED 20/20, every one the `init_* is not a
function` family** — `bundle-only-crash:["TypeError","init_module_NNNN is not a function"]`, green 0.
- **vs the fixed PR-10104 snapshot: GREEN 20/20**, red 0 (the strict-order arc fixed the seo:true path).

This is the strongest possible acceptance: a live catch on the latest released rolldown, with a natural
red/green proof pair. The generated shape is already the minimal 5-module repro (removing any module
dissolves the cycle), so it matches the pre-pin repro without shrinking. Pre-pin matrix:
/tmp/w14-red-targets/MATRIX.md. (#10044, the other W14-10 target, was demoted pre-pin — already fixed as
of rolldown 1.1.4, not red-provable on current rolldown/snapshot; the `build-failure:link` class above is
its regression-guard machinery.)

## Verification (all commits green)

`vp check` + `vp test` (325 tests) green at every commit; `corpus:check` 458 byte-identical (the golden
regenerated at the two labeled points only); `npm run catching-power` in-band (23.7%); a 6000-case
validate sweep across all regimes 0 rejections; the #9887 directed campaign RED 20/20 (npm 1.1.5) /
GREEN 20/20 (snapshot).
