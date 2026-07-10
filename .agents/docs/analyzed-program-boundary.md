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
   state. The registrations are a transient side list ON PURPOSE: the seeded schedule RNG iterates them
   in creation order, so re-deriving them by a final-graph module scan would reorder the trigger pool and
   change the corpus. Membership/owner/target already match the final graph (each entry was recorded as
   its dynamic edge was added), so no reconciliation pass is needed.
2. **At `finalizeProgram`**, the graph and registration order are FROZEN into the `ProgramModel`, and the
   analysis (`ProgramFacts` + `ExportDemandPlan`) is built over the frozen graph. From here nothing about
   the program changes; downstream layers only READ.

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

## Who consumes what

- **Renderer (`render.ts`).** Reads `requestedNames` / `callableNames` from the plan (its own fixpoint is
  deleted) and `localExportsFor` from the boundary module. A reserved export name (`default`) renders via
  a fresh local + `export { local as name }` rather than an invalid declaration.
- **Validator (`validate-model.ts`).** `validateProgramModel` builds the `AnalyzedProgram` and adds
  `validateExportDemand` over the plan: reject `unsupplied` / `ambiguous` demand, incompatible
  consumption (one export consumed as more than one shape), and a call whose resolved definer does not
  render a function (callability not forwarded through a barrel). Per-shape numeric/object soundness stays
  the direct-target capability walk's job — no parallel projection.
- **Coverage tags (`generate.ts`).** The family-A conjunction tag resolves each consumed member through
  `resolveExportRoute` and counts the pure-definer read only when it genuinely travels through a STAR —
  killing the old false tag on an unused star plus a consumed named route. Per-SCC cycle formats come from
  `CycleFacts.sccFormats`. Purity/export-shape classification reads go through `moduleProfile`.
- **Shrinker (`shrink.ts` via `case-evaluator.ts`).** Uses `ProgramFacts` for cycle-edge and route facts;
  the evaluator seam calls the lower `program-run.ts` execution layer, not the campaign/CLI file.

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
