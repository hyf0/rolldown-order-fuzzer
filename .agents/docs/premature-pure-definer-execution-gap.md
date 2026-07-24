# TODO: premature pure-definer execution is invisible to the oracle

**Status: open gap, no coverage yet.** Found via rolldown issue [#10415](https://github.com/rolldown/rolldown/issues/10415) (filed 2026-07-23 by IWANABETHATGUY), which the fuzzer's all-green cells could not have caught. Related records: [real-app-bug-families](./real-app-bug-families.md) (family A is the dual of this failure mode), [current-target-open-reds](./current-target-open-reds.md).

## The bug class the fuzzer misses

Under `strictExecutionOrder`, a shared re-export barrel's `init_*` forwards `init_definer()` for an inferred-pure definer whenever ANY route retains the binding (the retention evidence is keyed by symbol usedness, which is global). A co-consumer of the same barrel whose only read of that binding was excluded by tree shaking then executes the definer prematurely just by loading the shared wrapper. Reduced shape (#10415): entry A holds a dead `ns.vDef` read, entry B holds a live named import of `vDef` through the same barrel; loading A runs the definer's `/* @__PURE__ */` initializer. `strictExecutionOrder: false` is correct (chunk placement keeps the definer out of A's graph entirely). This is the **opposite direction of family A**: family A drops a required init; this executes one on a route that must not observe it.

## Why the fuzzer cannot catch it — two independent reasons

1. **Pure definers carry no observable execution by construction.** An inferred-pure definer in the model emits NO events (an event would make its top level impure — see the `inferredPure` validation in `generate.ts`), and a callable-own-state definer's state is only read through consumer calls that a dead route never makes. Premature `init_*` execution therefore produces no event and no value difference in any current case.
2. **Even with an execution observable, the source-vs-bundle differential is the wrong oracle for this contract.** Native ESM (the source run, our ground truth) EAGERLY executes the definer when any importer route loads — `import './barrel.js'` runs every transitive import. The "must not run on a route that does not consume it" contract only exists on the bundle side, as a tree-shaking refinement of native semantics. A source-vs-bundle comparison can therefore never flag the premature run: the source run also runs it. The correct reference for this contract is the `strictExecutionOrder: false` bundle (which realizes the refinement through chunk placement and passes the #10415 shape), not the source.

Both reasons must be addressed; fixing only (1) — e.g. giving pure definers an execution counter — would make the differential REJECT correct bundles or accept the premature run, depending on which side runs eagerly.

## What coverage needs (TODO)

- A per-module **execution marker channel separate from the event stream** for inferred-pure and callable-own-state definers (a `globalThis` counter like #10415's `__definerRuns`), excluded from the existing event-sequence oracle so reason (1) is fixed without perturbing purity semantics.
- A **strict-vs-flag-off differential arm** (or an analyzer-computed per-schedule-step "consuming routes loaded so far" prediction) asserting: after each schedule step, a pure definer has executed under strict order **iff** it executed under the flag-off bundle at the same step. Flag-off is a reference, not ground truth — a shared flag-off bug stays invisible — so the analyzer-predicted variant is the stronger long-term option.
- Generator side: the family-A cluster already produces the right graph shapes; the missing ingredient is a **dead co-consumer** (a namespace member read on a statement tree shaking excludes, next to a live consumer of the same binding through the same barrel). Add it as a variation so the conjunction (shared wrapped barrel + live route + dead route) is generated deliberately, not by luck.

Until this lands, all-green sweep cells say nothing about premature pure-definer execution; do not cite them as evidence against #10415-class regressions.
