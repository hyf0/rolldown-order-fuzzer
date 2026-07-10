# The finalizeProgram → AnalyzedProgram boundary

The consolidation round-2 wave introduced ONE analyzed view of a program that every downstream layer
reads, replacing the parallel projections that had drifted (a renderer demand fixpoint, a validator
capability walk, a coverage-tag star walk, a shrink route reconstruction). This record is the contract:
what is frozen when, and who consumes what.

## The two halves

- **Generation side — `GenerationContext` + `finalizeProgram` (`generate.ts`).** The random generator
  builds mutable state — module drafts (creation-ordered), the `usedEdges` guard, dynamic-import
  registrations (creation-ordered), the cycle members, the conjunction consumers — and wraps the parts
  finalization needs as a `GenerationContext`. `finalizeProgram(context, rng)` is the SINGLE finalization
  point: it turns each draft into a module (asserting special-role drafts, folding value reads), chooses
  entries, builds the schedule from the creation-ordered registrations, rolls the chunking config, flags
  side-effect-free modules, rewrites some reads statically-invisible, then FREEZES the result into a
  `ProgramModel` and returns its `AnalyzedProgram`. It consumes the generation RNG in the exact order the
  old inline tail did, so the corpus is byte-identical.

- **Analysis side — `analyzeProgram` (`analyzed-program.ts`).** Pure over a final `ProgramModel` (no
  RNG): it builds the graph facts and the one canonical `ExportDemandPlan`. Because it is pure, it is
  corpus-preserving by construction — any consumer that switches from its own projection to the plan
  emits identical output on every program whose demand is unambiguous (the whole generated corpus).

`AnalyzedProgram = { program, facts: ProgramFacts, plan: ExportDemandPlan }`.

## What is frozen when

1. **During generation**, the mutable graph and the creation-ordered registration list are the live
   state. Each dynamic edge carries a CREATION ORDINAL (its position in the side list, keyed by its unique
   registration id). The seeded schedule iterates registrations in creation order, so the ordinal MUST be
   the creation order for byte-identity.
2. **At `finalizeProgram`** (round 3, finding 5), the final registration sequence is DERIVED FROM THE
   FINALIZED GRAPH — every dynamic edge scanned out of the frozen modules, sorted by its creation ordinal —
   rather than iterating the side list on trust. This RECONCILES the two: asserts every graph edge has an
   ordinal (membership), no recorded ordinal is missing from the graph (the reverse), and ordinals are
   unique. Because the ordinal is the creation order, the derived sequence equals the old side-list order
   exactly, so the seeded schedule is byte-identical; a future drift becomes a loud generation failure
   instead of a silently reordered, corpus-moving schedule.
3. **The finalized `program` is DEEP-FROZEN** and `analyzeProgram` freezes the plan, so accidental
   post-finalization mutation throws in tests. From here nothing about the program changes; downstream
   layers only READ.

## The ExportDemandPlan (`analyzed-program.ts`), keyed by resolved `(moduleId, exportName)`

- **`requestedNames` / `callableNames`** — the renderer's demand/callability projection, relocated
  verbatim from the old renderer fixpoint (byte-identical): which export names each module must expose
  (propagated through re-export chains, in demand order) and which a DIRECT call import marked callable.
  Callability is marked only on a direct edge, never forwarded through a barrel — this is the ONE source
  of truth the renderer and the validator both obey.
- **`consumptions`** — every readable consumer demand, each with its `ConsumptionShape`
  (`numeric | callable | reference`) and its `ExportSupply` (the ACTUAL route, via
  `ProgramFacts.resolveExportRoute`): `supplied` (a unique definer), `ambiguous` (duplicate named exports
  or two conflicting stars), or `unsupplied` (a `default` import through a star-only barrel — a star never
  forwards `default`, and a star-carrying barrel synthesizes nothing local).
- **`resolvedDemands`** — per resolved definer export, the aggregation across ALL consumers: the definer's
  export shape, the rendered form (`value | function | object`), the set of consumption shapes (a set
  larger than one is an incompatible-consumption conflict), and whether any route reaches it through a
  barrel.

## Who consumes what — the ONE carried instance (round 3)

Round 3 closed the last gap: the `AnalyzedProgram` `finalizeProgram` returns is now CARRIED on the
`GeneratedCase` (`analyzed`, in-memory only — the persisted artifact is still just `program`) and THREADED
into every downstream consumer, so a case path builds the plan EXACTLY ONCE (a counter in
`analyzeProgram`, asserted by `tests/analyzed-program-boundary.test.ts`). `analyzeProgram` /
`renderProgram` / `validateProgramModel` / `deriveCoverageTags` all take the analysis (a default builds one
only for a standalone caller — a shrink candidate, a handwritten test). `collectRequestedExports` is now
PRIVATE to `analyzed-program.ts`; a grep test asserts it, plus `resolveExportOrigin` and the deleted
capability walk, never appear outside their boundary module.

- **Renderer (`render.ts`).** Reads the ONE plan's `requestedNames` (which names each module exposes) and
  `resolvedDemands.renderedForm` as the SOLE value/function/object dispatch — its own demand fixpoint and
  its separate callability set are both gone. The module's export SHAPE still picks the concrete renderer
  (object literal / state-reading callable / inferred-pure `const`), which the plan's `renderedForm` agrees
  with by construction. A reserved export name (`default`) renders via a fresh local + `export { local as
name }`.
- **Validator (`validate-model.ts`).** `validateExportDemand` over the plan is now the WHOLE per-shape
  soundness check: reject `unsupplied` / `ambiguous` demand, and every consumption whose SHAPE does not
  match its resolved definer's `renderedForm` (`numeric↔value`, `callable↔function`, `reference↔object`) —
  folding a function's source text, calling a number, calling an object, an identity capture of a non-object,
  and callability-not-forwarded-through-a-barrel all surface here. The legacy `resolveExportOrigin`
  capability walk (`describeCaptures` / `resolveExportCapability`) is DELETED; only the CJS-`default`-require
  interop check stays a direct check (the supply route cannot see it). Object-identity same-origin comes
  from the plan's `reference` consumptions, not a capability walk.
- **Coverage tags (`generate.ts`).** `deriveCoverageTags` consumes the carried `facts` + `plan` (no rebuilt
  `ProgramFacts`); the family-A conjunction tag reads each member's route from the plan's `consumptions`
  (not a direct `resolveExportRoute`) and classifies definers through `moduleProfile`. Per-SCC cycle formats
  come from `CycleFacts.sccFormats`.
- **Shrinker (`shrink.ts` via `case-evaluator.ts`).** Uses `ProgramFacts` for cycle-edge and route facts;
  the evaluator seam now wraps `program-run.ts`'s `executeProgram(program, minimalOptions)` directly — it no
  longer fabricates a `GeneratedCase` + full `CampaignOptions`. The signature normalizer canonicalizes by the
  shared numeric module identity (preserving `init_`/`require_`/plain prefix), so a cross-prefix
  two-module failure never collapses to a one-module one.

### The rendered form is the SOLE dispatch (finding 3)

`renderedFormOf` mirrors the renderer EXACTLY: a CJS definer and an inferred-pure numeric definer render a
`value` (numeric export / non-inlinable `const`), NEVER a callable — even when a caller marked them callable.
So a direct call of an inferred-pure numeric export, and a namespace `callMembers` against a numeric CJS
export, are REJECTED at validation instead of rendering a value the caller then invokes (a `TypeError` —
a degenerate both-sides crash). Byte-identical on the corpus: the generator never call-marks a CJS or
inferred-pure export.

## ProgramFacts supply-aware primitives (`program-facts.ts`)

- **`resolveExportRoute(moduleId, exportName): ExportSupply`** — the supply-aware sibling of
  `resolveExportOrigin` (which always returns a possibly-fabricated single origin). It collects EVERY
  genuine definer, so a unique route is `supplied`, a conflict is `ambiguous`, and a name no definer
  provides is `unsupplied`. A module is a local definer of a name unless it suppresses local synthesis,
  which an ESM module does exactly when it carries a star re-export (mirroring `localExportsFor`).
- **`wouldCloseSynchronousEdge(from, to)`** — the forward "adding this synchronous edge would close a
  cycle" predicate a graph mutator needs (`from === to || reachableFrom(to).has(from)`), distinct from
  `edgeClosesCycle` (an SCC-membership test valid only for an already-synchronous edge).
- **`CycleFacts.sccFormats`** — the format set per SCC, so a program with a separate all-ESM SCC and a
  separate all-CJS SCC gets BOTH per-format cycle tags.

## Byte-identity guarantee and its harness

This whole wave is byte-identity-preserving on the generated corpus. `scripts/corpus-manifest.ts` renders
a fixed reproducible case set — all three forced regimes, all five fixed templates plus un-forced
random-mixed, and empty-chunking-array boundary cases — to a committed golden digest
(`corpus-manifest.golden.json`); `npm run corpus:check` regenerates and diffs it. Every change in this
wave was verified against the golden. Coverage tags and artifact identity are deliberately EXCLUDED from
the manifest — they legitimately change when a predicate is corrected (the family-A false-tag fix is the
one intended tag move).
