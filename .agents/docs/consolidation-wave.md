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

## Deferred (corpus-semantic — needs its own re-acceptance wave)

The renderer's category-ordered dependency emission (see
[renderer-dependency-order](./renderer-dependency-order.md)); domain-separated RNGs, feature-budget
reservation, and pass reordering; deriving dynamic registrations from the final graph (changes schedule
RNG); persisted capture/profile/chunking schema migration. Each changes emitted source or RNG and is
out of scope for a byte-identity-preserving consolidation.
