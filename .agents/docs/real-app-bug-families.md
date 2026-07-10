# Real-app bug families A and B (wave 7)

A sweep of real applications found **4 runtime breakages** in rolldown's `strictExecutionOrder` that a
25,000+ green fuzzer corpus missed, diagnosed to **2 root causes**. Wave 7 makes the fuzzer generate
the shapes of those two families and proves them against the frozen PR-10104 runtime snapshot
(rolldown 1.1.5) that provably contains both bugs. Builds on
[value-carrying-events](./value-carrying-events.md),
[namespace-and-barrel-reexports](./namespace-and-barrel-reexports.md),
[side-effect-free-metadata](./side-effect-free-metadata.md), and
[organic-chunking-and-scale](./organic-chunking-and-scale.md).

Wrap-mode vocabulary (from the harness): `--wrap-all` sets `experimental.onDemandWrapping: false`
(rolldown's default strict mode wraps every module); on-demand is `onDemandWrapping: true` (selective
wrapping, the analysis under test).

## Family A — a barrel init drops an inferred-pure definer (fails on-demand AND wrap-all)

Under strict order, a re-export barrel's `init_*` function fails to forward to a re-exported definer
module that rolldown's tree-shaking judges side-effect-free **by inference** (its top level is only
pure statements). The definer's `init_*` is emitted with **zero call sites**; its exported binding
stays `undefined`; a consumer reading it through the barrel's namespace reads `undefined` — a NaN fold
or a `TypeError`, both caught by the oracle. Real shapes: an enum object `export const X =
/* @__PURE__ */ build()`, a component wrapper, hoisted functions plus a module-level var.

### The three ingredients (all required simultaneously)

- **(a) the definer is order-wrapped.** Free in the `--wrap-all` cell (every module wrapped). In
  on-demand the wrapping is driven by ingredient (c) below — no cycle is needed.
- **(b) the barrel indirection is NOT flattened.** Rolldown flattens a short re-export chain into a
  direct init edge, and a NAMED re-export resolves the binding to its origin (so a consumer calls
  `init_definer` directly — no bug). Two things defeat that:
  - the definer is reached through a **STAR re-export** (`export * from "./definer"`), not a named
    one — a namespace read of the barrel then depends on the barrel's `init_*` populating the
    namespace, and
  - the barrel is **namespace-imported** (`import * as ns`) by **≥2 importers that become entries**,
    so it is a real shared, wrapped chunk rather than an inlined re-exporter.
- **(c) the definer is side-effect-free by statement inference** — NOT the `sideEffects: false`
  metadata flag (a different mechanism, see [side-effect-free-metadata](./side-effect-free-metadata.md)).
  The value must be **non-inlinable**: a plain `const x = <literal>` is constant-folded and inlined,
  masking the dropped init, so the definer emits a `/* @__PURE__ */`-annotated call of a local build
  function.

### The empirically-minimal conjunction that fails BOTH modes

Verified against the snapshot (`scratchpad/smokeA*.mjs`, then end-to-end through the harness):

```
definer.mjs  (inferred pure):  function b(){return N} export const vDef = /* @__PURE__ */ b();
sibling.mjs  (side effects):   globalThis.__orderEvent(...); export const vSib = ...;
barrel.mjs:                    export * from "./definer.mjs";   // STAR — essential
                               export { vSib } from "./sibling.mjs";
entry A:  import * as ns from "./barrel.mjs";  ...ns.vDef...   // reads the definer
entry B:  import * as ns from "./barrel.mjs";  ...ns.vSib...   // reads the SIBLING (the split)
```

The bug in the emitted bundle: `init_barrel()` calls `init_sibling()` but NOT `init_definer()`;
`init_definer` exists with zero call sites; `ns.vDef` is `undefined`.

Two facts pinned by probes:

- **The star re-export is load-bearing.** A named re-export of the definer (`export { vDef } from`)
  is green in both modes — rolldown resolves the binding directly.
- **The split read is the on-demand trigger.** With both entries reading the definer, on-demand is
  green (only `--wrap-all` fails). With one entry reading the definer and another reading the
  sibling, on-demand omits `init_definer` too, so it fails BOTH modes — the family-A signature. The
  sibling with real side effects is what keeps the barrel a wrapped chunk (a pure barrel with no
  sibling flattens and is green).

### How wave 7 generates it

`injectPureDefinerConjunctions` (generate.ts) appends a self-contained cluster — inferred-pure
definer, side-effectful sibling, a 1- or 2-hop STAR-to-definer + NAMED-to-sibling barrel, and two
consumers forced to be entries with split namespace reads — biased so **~22% of random-mixed cases**
(double digits, the target) carry a COMPLETE conjunction. The model additions are `inferredPure` +
`pureBase` (model.ts), validated as ESM/no-events/value-only-deps and mutually exclusive with
`sideEffectFree` (validate-model.ts), rendered as a `/* @__PURE__ */` build call (render.ts). Coverage
tag `mechanism:pure-definer-behind-barrel` counts only COMPLETE conjunctions (a purely structural
check, so it holds for handwritten and shrunk models). The conjunction is inherently ESM, so it is
skipped in the pure-CJS regime.

## Family B — a statically-invisible use at entry startup (fails on-demand ONLY; wrap-all clean)

An entry imports a value binding from a cross-chunk order-wrapped module and uses it INSIDE a
locally-defined function that top-level code invokes during init, or through a computed namespace
access `ns[k]` (the shadcn consumer shape). The use is meant to be invisible to on-demand's static
liveness, so the entry never triggers the target's init; `--wrap-all` unconditionally imports
init+value and is clean. The fuzzer previously generated only top-level direct reads — all statically
visible — which is exactly why it never caught this.

### The capability wave 7 adds

- `EventRecord.hiddenReadFn` — the folded reads render inside a local function called at init
  (`value: base + hidden()` where `function hidden(){ return read0 + … }`). Deterministic and
  synchronous; identical observed value; only the lexical visibility differs. Coverage tag
  `variation:function-hidden-read`.
- `ValueRead.computed` — a namespace member read renders as `ns[<runtime key>]` (a split-literal key
  the bundler cannot fold to `ns.member`). Coverage tag `variation:computed-member-read`.

`applyStaticallyInvisibleReads` (generate.ts) rewrites reads toward invisibility, biased to ENTRIES
(family B needs the entry to hide a read of a cross-chunk target); the campaign's chunking variety
supplies the cross-chunk, order-wrapped targets. Applied last, so only events change.

### Reproduction status

Hand-probing (`scratchpad/smokeB*.mjs`) could NOT isolate family B against the snapshot in a small
synthetic graph: this rolldown build robustly traces a locally-called function and a namespace access
and still emits `init_target()`, and single-entry graphs collapse into one chunk (nothing is
wrapped). Getting on-demand to WRAP the target yet OMIT the entry's init call needs a genuine
predicted-order deviation across chunks that the small probes did not reach. The capability is built
faithfully and the random campaign (thousands of wrapped cross-chunk configs with function-hidden
entry reads and varied schedules) is the intended hunter; if random misses it, a handwritten model of
the family-B shape isolates "generator can't assemble it" from "harness/oracle can't observe it" from
"the ingredient analysis is wrong". See the acceptance section for the campaign outcome.

## Smoke-proof that inferred purity works

Standalone builds against the snapshot (`scratchpad/smokeA.mjs`) confirmed rolldown treats each
candidate pure-definer shape as side-effect-free: when nothing imports the definer it **vanishes from
the output**. Every shape (scalar `/* @__PURE__ */` call, object return, `var` + hoisted function,
`export class`, and even a plain `const = <literal>`) is inferred pure. The distinguishing fact for
the bug is inlining, not purity: a plain `const = <literal>` is inlined (green — the value survives
the dropped init), whereas the `/* @__PURE__ */ build()` call keeps the value a runtime binding, so a
dropped init surfaces as `undefined` (red). That is why the generated definer always uses the call
form.

## Acceptance evidence

- **Smoke proof of purity:** above (an unused inferred-pure definer is dropped from output).
- **Conjunction density:** `mechanism:pure-definer-behind-barrel` on **22.3%** of random-mixed cases
  (3000-case sweep), every complete conjunction tagged; 0 invalid / 0 render failures.
- **End-to-end reproduction:** both a handwritten family-A model and generator-produced conjunction
  cases (e.g. seed 6004) go RED against the snapshot in BOTH on-demand and `--wrap-all` with
  `bundle-only-crash:["Error","Execution event value must be a primitive JSON value"]`.
- **Campaign (6 cells × 800):** mixed od 141 / wa 151 fail, pure-esm od 144 / wa 150 fail, pure-cjs
  0 / 0 (family A is ESM-only). Cross-referencing od vs wa on the same seed: **285 both-modes
  failures, ALL family-A conjunctions; 0 od-only; 16 wa-only (also conjunctions, organic chunking let
  od init correctly); 0 non-conjunction failures.** One deduped signature. Hand-verified a bundle:
  the definer's `init_*` has zero call sites. Shrunk 16 → 5 modules, still RED in both modes. A
  300-case sanity campaign failed 62 (20.7%), every one the family-A signature, 0 false positives.
  Full detail: `/tmp/order-fuzzer-w7/FINDINGS.md` (out-of-tree).
- **Family B:** the mechanism was located in the real shadcn od build (d3-scale `unit`/`rescale`: an
  exported hoisted function reads its module's own init-assigned state, called at startup via a
  memoized selector; on-demand skips `init_continuous`). The reading-side capability is built and
  dense, but NO od-only failure reproduced in the campaign or in handwritten probes — this rolldown
  build's on-demand robustly emits the target's init at the graph scales the fuzzer (≤48 modules) and
  small handwritten models reach. Named blocker: the missing ingredient is a callable export that
  reads its OWN module state (the existing call import returns a constant) PLUS a cross-chunk
  predicted-order deviation large enough to make on-demand skip the init while wrap-all runs it — not
  assembled at fuzzer scale. The family-A version of the same own-state-read construct reproduces
  immediately (BOTH modes) through a star barrel, so the oracle can observe it; the gap is generation,
  not observation. Wave 8 built the named callable-own-state ingredient and proved family-A closure
  on the fixed build — see
  [object-identity-and-callable-own-state](./object-identity-and-callable-own-state.md).

## Shrinking (wave-6 residual closed)

`shrink.ts` no longer hardcodes on-demand: a `--wrap-all` flag selects the mode, `--on-demand` forces
it, and when the model sits in a failure artifact the failing mode is auto-read from the sibling
`replay.json`. New shrink candidates drop `inferredPure` (revealing whether inference-based purity is
load-bearing — the value then renders inlinable), `hiddenReadFn`, and `computed`, kept only when the
failure kind is preserved. Family A fails in both modes, so on-demand shrinking works for it; the flag
matters for any wrap-all-only failure. `FAILURE_ARTIFACT_SCHEMA_VERSION` bumped 15 → 16.
