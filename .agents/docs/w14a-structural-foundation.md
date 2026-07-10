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
  W14c: upstream #9998 is a cross-entry leak that only exists at `seo:false`, and the full-order oracle
  would false-positive on the accepted relaxed-order divergences there. So `seo:false` is unrepresentable
  until W14c supplies that oracle.
- **Backward compatible (the v16-artifact reader).** `build` is OPTIONAL; `buildConfigOf(program)`
  resolves a legacy (schema-16) model's config from its top-level chunk arrays + rolldown/fuzzer defaults,
  so an old failure artifact still replays. The schema version is only written, never gated on read, and
  the shrinker reads `model.json` directly. `FAILURE_ARTIFACT_SCHEMA_VERSION` 16→17; the artifact identity
  records the axes so a different config yields a distinct artifact.
- **Smoke-verified honored by the frozen snapshot.** Both `includeDependenciesRecursively` (chunk-graph
  changes) and `lazyBarrel` (wrapped-chunk changes under strict order) produce different snapshot output
  when toggled, so both are real axes worth rolling. The GLOBAL `includeDependenciesRecursively` rides on
  the `codeSplitting` object. As of **W14a.1** manual groups NEVER set it per-group, so this persisted
  global is the SINGLE source of the effective value for every manual-group case (the earlier build did
  set a per-group `false` that shadowed the global — blocker 1 below).
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

## 4. Plan enrichment — PARTIALLY LANDED (W14a.1), rest deferred to W14b

Item (a) LANDED EARLY in **W14a.1** (blocker 2 below): the `ExportDemandPlan`'s `ConsumptionRecord` now
carries a `purpose` dimension (`live` vs `link-required`) — named re-exports are `link-required` demands,
supply-checked but not shape-checked — so an unsupplied named re-export is rejected at validation (NO
`deadHop` flag, no validator-side route walk; the purpose lives on the ONE plan). Still deferred to W14b:
(b) `RouteHop` provenance carrying each hop's target module + exported/imported name pair; (c) a NEW
`export * as ns from` dependency operation (M7 of the spec) through model / generation / render /
validation / plan routes / shrink / tags. All via the plan, keeping the boundary guard tests passing. The
[AnalyzedProgram boundary](./analyzed-program-boundary.md) is the seam these extend.

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

## W14a.1 — codex review patch round (three blockers + adjacent notes)

The codex review of W14a cleared the renderer array-order fix, the #9887 directed shape, and the golden
discipline, but flagged THREE blockers plus cheaper adjacent notes. This round closes all three and folds
in the notes. It is behavior-affecting only where noted (blocker 1); the golden regenerated ONCE, labeled
`golden: IDR single-source`.

### Blocker 1 — manual groups shadowed the persisted IDR axis

`createOutputOptions` (`rolldown-build-child.ts`) hardcoded `includeDependenciesRecursively: false` on
EVERY manual group, so rolldown consumed the group value and IGNORED the persisted global
`build.includeDependenciesRecursively` — the tags/artifact/golden recorded the global while the build ran
the constant. FIX: the child-side per-group override is REMOVED — manual groups omit the field, so the
global fallback (set from the persisted `BuildConfig`) is the SINGLE source of the effective value.
v16 replay is preserved by `buildConfigOf` (`model.ts`): a LEGACY (schema-16, no `build`) manual-group
artifact now resolves its global IDR to `false` (the old effective build), NOT the rolldown default
`true` in `DEFAULT_BUILD_CONFIG` — automatic/organic legacy configs keep `true` (the hardcode never
applied to them). The RULE: `DEFAULT_BUILD_CONFIG.includeDependenciesRecursively` stays `true` (rolldown's
real default); the legacy-manual override lives in `buildConfigOf`. Golden delta: exactly the 25
`template:manual-chunk-separation` cases, `buildAxes.includeDependenciesRecursively` `true → false` (the
manifest now records the EFFECTIVE global; the rendered files and `codeSplitting` are byte-identical, and
every other case is unchanged). Generated manual-group cases whose persisted global is `true` now actually
BUILD with `true` (previously forced `false`) — a real effective-build change invisible to the
source-only golden, so the #9887 proof was re-run (below) to confirm the catch still holds now that the
control is the persisted axis, not the hardcode.

### Blocker 2 — named re-exports were not supply-validated

`buildExportDemandPlan` recorded value imports / namespace members / readable requires as consumptions but
OMITTED named re-exports, so `validateExportDemand` never supply-checked them — a model-authored
`MISSING_EXPORT` channel (`export { default as x } from` a star-only barrel rendered an invalid source
Rolldown link-errored on, then classified as a catch). FIX: the ONE `ExportDemandPlan` gained a demand
PURPOSE dimension (`live` vs `link-required`) on `ConsumptionRecord`; named re-exports are `link-required`
demands (supply-checked, never shape-checked — a re-export imposes no runtime form, and only `live`
demands aggregate into `resolvedDemands`, keeping the shape reasoning byte-identical). `validateExportDemand`
now rejects an unsupplied/ambiguous link-required name (crafted test pins the codex probe). The
requested-name FIXPOINT (`analyzed-program.ts`) no longer forwards `default` through a star, agreeing with
the supply rule in `ProgramFacts.#collectDefiners` (`program-facts.ts`) — the two projections had drifted.
NO validator-side route walk. The 6000-case sweep confirms zero generated-corpus rejections (the generator
never emits the illegal shape).

### Blocker 3 — link detection accepted harness failures

`buildFailureVerdict` (`program-run.ts`) called `detectLinkFailure` for EVERY non-panic adapter failure,
so a harness failure whose message merely contained `MISSING_EXPORT` (e.g. a package that failed to LOAD,
`status: harness-error`, `stage: load-package`) was mis-classified as `build-failure:link` — a false catch
poisoning artifacts/shrink/dedup. FIX: link detection is GATED to `status === "build-error" && stage ===
"build"` (the only path that reaches the linker). Regression test pins the harness-error/load-package
probe.

### Adjacent notes folded in

- **#9887 re-run + committed evidence.** `scripts/cross-chunk-init-cycle-catch.ts` now validates
  `CASES > 0` (a `CASES=0` vacuous pass is rejected) and FAILS on any `other` signature (a stray/untagged
  verdict no longer slips through), and writes a machine-readable evidence file
  (`.agents/evidence/9887-cross-chunk-init-cycle.json`: per-seed verdicts, HEAD + dirty status, node
  version, target `dist` sha256s, signature histogram). The 4-module variant (consumer removed) builds
  GREEN on rolldown@1.1.5 — the consumer/witness is load-bearing — so the "minimal 5-module repro" claim
  stands (confirmed empirically, not just by the module count).
- **Mechanism tag tightened.** `mechanism:barrel-cross-chunk-init-cycle` (`generate.ts`) now requires an
  actual grouped QUOTIENT cycle (the ESM target's chunk reaches back to the requiring chunk), not merely a
  cross-group CJS→ESM require — codex's acyclic 2-module probe no longer receives it, while the #9887 shape
  still does.
- **Configuration/freeze seam for fixed templates.** Every fixed template now routes through
  `configureFixedTemplate` (`generate.ts`), persisting its resolved `BuildConfig` on `program.build` so a
  persisted object is GENUINELY present on every case (not left to the `buildConfigOf` fallback);
  `manual-chunk-separation` expresses its split on `build.chunking` instead of a legacy top-level
  `manualChunkGroups` array. Corpus-neutral apart from blocker 1's IDR delta; the manifest/axes record the
  effective config (a test asserts persisted === effective).
- **`validateBuildConfig` rejects an unknown `chunking.kind`** (`{ kind: "bogus" }` no longer falls
  through to automatic silently) + test.
- **Link identity + shrink normalization.** `detectLinkFailure` returns an explicit `unknown`-identity
  variant (`build-failure:link:unknown`, a stable identity-free signature) instead of a fabricated
  `("<unknown>", <whole message>)` pair; the shrink signature normalizer also canonicalizes rendered
  module FILENAMES (`module-NNNN.mjs`) by the same numeric identity, so a renumbering shrink is accepted
  (+ regression test).

### Re-run #9887 proof (post blocker-1)

Re-run at 20 seeds vs the npm rolldown@1.1.5 tarball and the frozen PR-10104 snapshot, AFTER blocker 1
made the persisted `includeDependenciesRecursively: false` the effective control (previously the child
hardcode forced it): **RED 20/20 (init-family) on npm 1.1.5, GREEN 20/20 on the snapshot** — the catch
holds on the persisted axis. Machine-readable evidence committed at
`.agents/evidence/9887-cross-chunk-init-cycle.json`.

### W14a.1 verification

`vp check` + `vp test` (331 tests, +6 regression tests) green; `corpus:check` 458 byte-identical to the
regenerated `golden: IDR single-source`; a 6000-case validate sweep 0 rejections; `npm run catching-power`
in-band (23.7%, unchanged from the pre-round baseline); the #9887 directed campaign RED 20/20 / GREEN
20/20 (evidence file committed). Full 6-cell reacceptance vs the frozen snapshot (3 regimes × od/wa ×
300, the catching-power seed range): mixed-od 69/300 (23.0%), mixed-wa 73/300 (24.3%), pure-esm-od 70/300
(23.3%), pure-esm-wa 71/300 (23.7%), pure-cjs 0/300 in both cells (family-A-free, as before) — every red
across all 1800 builds is the ONE known family-A `bundle-only-crash` NaN signature class ("Execution event
value must be a primitive JSON value"); ZERO new divergence classes after the IDR effective-build change.
A directed red/green flip additionally proves the single source end-to-end: the #9887 shape with its
persisted global flipped to `idr:true` builds GREEN on the buggy rolldown (the cycle dissolves), where the
old per-group hardcode would have kept it RED — so shrink's `false → true` candidate now genuinely changes
the effective build.

## W14b must-not-repeat list (carried verbatim from the codex W14a findings)

The next wave inherits these constraints in-repo so the W14a.1 fixes are not undone. Status as of
W14b ([w14b-package-realism](./w14b-package-realism.md)):

- No child-side option overrides absent from persisted BuildConfig. — **HELD in W14b** (the family-B
  chunk group and the directed builder's config are persisted on `build`; the child gained no new
  option).
- Fixed/directed builders must not bypass the common configuration/freeze/analyze seam. — **HELD**
  (`buildFamilyBEagerBarrel` persists a full `BuildConfig`, deep-freezes, and analyzes once, exactly
  like `buildCrossChunkInitCycle`).
- No deadHop flag, no validator-only supply walk — link/live purpose lives on the canonical plan. —
  **HELD** (the new local re-export records a LIVE demand on the one plan; no validator-side walk was
  added).
- Don't extend shrink's manual barrel switch (shrink.ts rewireReadPastBarrel); enrich canonical
  RouteHop (program-facts.ts) with target + name mapping. — **HELD / deferred**: the barrel switch
  was NOT extended for the new op (shrink downgrades a local re-export to the named form instead);
  the full RouteHop target+name enrichment remains W14c scope (W14b only added the `local` hop kind).
- No parallel namespace-member representation for `export * as ns` — extend ValueRead to ONE
  canonical member path. — **untouched** (the `export * as ns` operation is still W14c scope).
- No second CLI/evaluator switch for seo:false — one relaxed-order oracle policy derived from
  persisted BuildConfig. — **untouched** (`seo:false` stays unrepresentable; the relaxed-order oracle
  is still deferred).
- Package model replaces (migrates) module-level sideEffectFree + synthetic directory via one
  legacy-normalization seam — never two live representations; package sideEffects metadata belongs to
  the package/layout model, NOT BuildConfig. — **CONSUMED in W14b**: `packagesOf` (model.ts) is the
  one seam (a legacy flag normalizes to a single-member `sideEffects: false` package, the same
  `sef-<id>` shape the generator now persists), the `side-effect-free/` renderer directory is gone,
  metadata purity left `ModuleProfile`, and a program carrying both forms is rejected. `sideEffects`
  metadata lives on `ProgramModel.packages`, not `BuildConfig`.
