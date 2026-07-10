# Consolidation wave (shared services and validation tightenings)

Before the next capability wave, an architectural review's accepted findings were executed to stop the
duplicated-facts / drifted-predicate / contract-gap drift the codebase had accumulated. The corpus is
byte-identical (a 300-case manifest of rendered files + effective build options is pinned by
`scripts/corpus-manifest.ts`); coverage tags and artifact identity legitimately changed where a
predicate was corrected. This record names the durable shared pieces so a future wave inherits them
instead of re-deriving.

## Shared services (use these; do not re-implement)

- **`program-facts.ts` — `ProgramFacts`**: the ONE graph/facts service over a `ModuleLike` interface (a
  finalized `ModuleModel` and a mid-generation draft both satisfy it). Provides adjacency, synchronous
  reachability (`reachableFrom` excludes self; `closureFrom` includes it), `edgeClosesCycle` (O(1) via
  iterative-Tarjan SCC membership — every caller passes a real edge), cycle topology (`cycles()`:
  SCCs / cyclicMembers / formats / chord / interlocking / multi-enter), top-level-await reachability,
  and export-origin resolution through re-export barrels (`resolveExportOrigin`). Tarjan is ITERATIVE
  on purpose: a 10,000-deep chain must not overflow. Generation, validation, tags, and shrinking all
  consume it; none keeps its own reachability walk.
- **`capture-analysis.ts`**: the canonical read/export-demand model built OVER the current schema (no
  persisted-field migration). `resolveExportCapability` classifies a demanded export as
  `value | callable | object` at its defining module (through barrels); `describeCaptures` yields a
  module's `CaptureDescriptor[]`; `canonicalReadFlags` gives the `call`/`guard` an event read must
  carry. The validator's barrel-aware capability checks and event-read checks read from here.
- **`model.ts` — `moduleProfile` / `programChunking`**: `moduleProfile(module)` projects the five
  correlated flags onto `{ purity: normal|metadata|inferred; exportShape: numeric-fold|callable-own-state|fresh-object }`
  (the two purity mechanisms stay semantically distinct — metadata emits a `package.json`, inferred
  rewrites to a PURE call). `programChunking(program)` projects the two optional chunk arrays onto a
  `Chunking` discriminated union (`automatic|manual|organic`), fixing the artifact-identity bug where an
  empty `manualChunkGroups: []` was recorded as `{ groups: [] }` while the build ran automatic. The
  renderer's export dispatch, the validator, the tag deriver, and the artifact identity all read these.
- **`case-evaluator.ts`**: `evaluateProgram` / `failureSignatureOf` — the seam that runs ONE program
  (render, source, build, bundle, verdict) so the shrinker no longer imports the campaign/CLI layer or
  fabricates a `GeneratedCase` + `CampaignOptions`. (The execution primitives themselves still live in
  `main.ts`; relocating them fully below this seam is a mechanical follow-up.)

## Validation tightenings added (they only reject hand-crafted / drifted models)

The generator never produces any of these, proven by a 6000-case validate sweep (0 rejects) and the
300-seed byte-identity manifest:

- an event read's `call`/`guard` must match its binding's capability (no folding a function's source
  text, no calling a numeric read), including through barrels via export-origin resolution;
- a readable CJS `require` of `default` is rejected (a `module.exports = value` provider has no
  `.default` — a degenerate both-sides NaN crash);
- a value/namespace/require capture that resolves (through barrels) to a `callableOwnState` or
  `objectExport` definer must consume it correctly (call / callMember / objectRef);
- an object-identity check must capture the SAME object origin on both sides;
- a synchronous SCC that mixes ESM and CJS formats is rejected (the documented mixed-cycle exclusion,
  previously generator-only);
- a module cannot be both `sideEffectFree` and `callableOwnState` (a legal DCE may drop the state the
  callable reads).

## Shrinker

`sameFailure` is now EXACT by default — the candidate's NORMALIZED signature (only Rolldown's
`module_N`/`init_*`/`require_*` chunk-internal names and absolute paths rewritten) must equal the
baseline's, per `redesign-principles.md`, so a reorder cannot minimize into a different failure. A
`--broad` flag restores same-kind matching. Five drifted candidates were fixed (namespace-member
removal drops from `callMembers`; barrel rewiring renames the event member; any/sole event removable;
organic config shrinks field-by-field; `withoutReads` preserves unknown fields). The candidate engine
(`candidates`) and `sameFailure` are exported and unit-tested (`tests/shrink.test.ts`).

## Round 2 — the AnalyzedProgram boundary (shared services, second pass)

A codex re-review named the missing canonical program finalization / export-demand plan as THE blocker
before feature waves. Round 2 built it, still byte-identity-preserving on the generated corpus (the
golden harness below now covers all regimes, all fixed templates, and empty-chunking boundaries, pinned
by `corpus-manifest.golden.json` and `npm run corpus:check`). The boundary contract lives in
[analyzed-program-boundary](./analyzed-program-boundary.md); in short:

- **`finalizeProgram` + `GenerationContext` (`generate.ts`)** — one finalization point that freezes the
  generation state into a `ProgramModel` and returns its `AnalyzedProgram`. The dynamic-import
  registrations stay a creation-ordered side list so the seeded schedule is byte-identical.
- **`analyzeProgram` + `ExportDemandPlan` (`analyzed-program.ts`)** — the ONE plan keyed by resolved
  `(moduleId, exportName)`: supply status (`supplied | ambiguous | unsupplied`), route provenance,
  consumption-shape aggregation across all consumers, and the rendered form. Renderer, validator, tags,
  and shrink read it; the renderer's own demand fixpoint is gone.
- **`ProgramFacts` supply-aware primitives** — `resolveExportRoute` (never a fabricated origin),
  `wouldCloseSynchronousEdge` (the forward mutator predicate), `sccFormats` (per-SCC cycle formats).
- **Validator export-demand rules** — reject unsupplied (default through a star-only barrel), ambiguous
  (duplicate named / two-star), incompatible consumption (one export both called and folded), and a call
  whose definer renders a value (callability not forwarded through a barrel). Proven by a 6000-case
  validate sweep (0 rejects).
- **Enumerated defect fixes** — the multi-edge cycle predicate (A), per-SCC format tags (B), the family-A
  route tag (C), the shrink normalizer restricted to numeric-generated forms (D), two shrink candidate
  fixes (E, including the sole-manual-group non-termination), the execution/verdict layer moved below
  `main.ts` into `program-run.ts` (F), NUL-byte escapes (G), `moduleProfile` as the single flag
  interpreter with a grep guard (I), discriminated finalization asserts (J), the chunking union through
  the adapter (K), and reserved-word (`default`) export declarations via `export { local as name }`.

## Round 3 — the final integration before the barrel wave

A clearance re-review named ten residual findings; round 3 executed exactly those, still
byte-identity-preserving (458 golden, `npm run corpus:check`) and 0 rejections over a 6000-case validate
sweep. The [boundary contract](./analyzed-program-boundary.md) now reflects the ONE carried instance.

- **The ONE `AnalyzedProgram` is threaded through the whole case path (findings 1, 2).** `finalizeProgram`
  produces it; the `GeneratedCase` CARRIES it (`analyzed`, in-memory — the artifact is unchanged);
  validation, rendering, tags, and evaluation all consume THAT instance, so demand analysis runs EXACTLY
  ONCE per case (a counter in `analyzeProgram`, asserted architecturally). `collectRequestedExports` is
  private to the boundary; the validator's `resolveExportOrigin` capability walk, the renderer's demand
  fixpoint + callability set, the tags' rebuilt `ProgramFacts` + direct `resolveExportRoute`, and the
  shrink route reconstruction are all gone — a grep test keeps the killed entry points out of every
  consumer. The finalized program and plan are FROZEN.
- **The plan's `renderedForm` is the renderer's SOLE form dispatch (finding 3).** A CJS and an inferred-pure
  numeric definer render a `value`, never a callable, so a call of one is rejected at validation (the two
  degenerate `TypeError` crash models). Crafted-violation tests pin both.
- **Per-consumption shape↔form soundness over the plan (finding 2).** `validateExportDemand` replaced the
  capability walk: every consumption's shape must match its resolved definer's `renderedForm`
  (`numeric↔value`, `callable↔function`, `reference↔object`). Only the CJS-`default`-require interop check
  stays direct.
- **Smaller tightenings.** Shrink signature normalizer keys by the shared numeric module identity across
  `init_`/`require_`/plain prefixes (finding 4); a duplicate explicit named re-export of one name is
  rejected (finding 6); `moduleProfile` guard narrowed to authoring + constraint-validation sites, with
  generate.ts gated to a marked authoring section and capture-analysis dropped (finding 7); finalize
  asserts a plain callable-own-state draft is ESM (finding 8); `executeProgram(program, minimalOptions)` is
  the seam the campaign and the shrinker's evaluator both wrap (finding 10).
- **Catching-power baseline (finding 9).** `npm run catching-power` (NOT part of `vp test` — it needs the
  frozen snapshot) builds a fixed 2×300 seed set (mixed od/wa) against
  `pr10104-runtime-snapshot/rolldown/dist/index.mjs` and asserts the family-A red-rate band (21–27%).

## Round 4 — the clearance-gate final two

A codex clearance re-review named two residual blockers; round 4 closed exactly those, still
byte-identity-preserving (458 golden, `npm run corpus:check`) with `vp check` + `vp test` green and the
catching-power red-rate inside its committed 21–27% band. The [boundary contract](./analyzed-program-boundary.md)
now records the consumer contract and the single form dispatch.

- **Consumers take the `AnalyzedProgram` ONLY (mismatched-pair blocker).** `renderProgram`,
  `validateProgramModel`, and `deriveCoverageTags` no longer take a separate `program` argument — they read
  it from `analyzed.program`, so an analysis of program A can never be supplied alongside program B (the
  mismatch is unrepresentable at the call site, not merely asserted). The codex probe (an ESM-derived
  analysis over an otherwise-identical CJS numeric-definer program → validation `[]`, then `ns.vx()` against
  `exports.vx = 5`) can no longer be formed. The one transition seam that still carries both,
  `executeProgram(program, options, overrides, analyzed?)`, hard-asserts `analysis.program === program` and
  throws otherwise. Fixed-template programs are now deep-frozen on the SAME path as random-mixed
  (`generateCase` deep-freezes before `analyzeProgram`), so every `GeneratedCase` carries a frozen program.
  A compile-time `@ts-expect-error` regression + the transition-throw + a frozen-fixed-template test pin it.
- **`renderedFormOf` is the renderer's SINGLE export-form dispatch (mirrored-switch blocker).** The renderer
  had a moduleProfile export-form switch (`profile.exportShape.kind === …`) in parallel with the analyzer's
  classification. `RenderedExportForm` is now a FIVE-way discriminated form (`numeric-value` /
  `callable-constant` / `inferred-pure` / `callable-own-state` / `fresh-object`) the analyzer returns and the
  renderer maps DIRECTLY to one emission template; the mirrored switch in `render.ts` is deleted (it never
  reads `exportShape` again — a grep guard fails if it does). The validator collapses the fine form to a
  consumption category (`formConsumptionShape`) for soundness and to a `value|function|object` noun
  (`renderedFormNoun`) for diagnostics, so the crafted-violation messages are unchanged. Byte-identical: the
  fine forms derive from the same profile the deleted switch read.

## Deferred (corpus-semantic — needs its own re-acceptance wave)

The renderer's category-ordered dependency emission (see
[renderer-dependency-order](./renderer-dependency-order.md)); domain-separated RNGs, feature-budget
reservation, and pass reordering; persisted capture/profile/chunking schema migration. Each changes
emitted source or RNG and is out of scope for a byte-identity-preserving consolidation. (Round 3 DID
reconcile dynamic registrations against the finalized graph — finding 5 — but byte-identically, by sorting
the graph's edges on their creation ordinal rather than re-deriving order from a module scan, so the
seeded schedule is unchanged.)
