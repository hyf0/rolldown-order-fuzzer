# Callable-reads-own-state exports and the object-identity witness (wave 8)

Wave 8 closes the family-A loop and adds two witness constructs. Builds on
[real-app-bug-families](./real-app-bug-families.md) (wave 7, families A and B) and
[organic-chunking-and-scale](./organic-chunking-and-scale.md) (wave 6).

## Family-A closure proof (the fix works; no residual)

A rolldown build containing the family-A fix (`/tmp/rolldown-strict-order-study/fixA-package-rolldown`,
out-of-tree) was re-run on the two reddest wave-7 cells with the SAME seed base (200000, sizes drawn
per-seed by the campaign mix, so cases are byte-identical to wave 7's):

- fixed build, mixed × on-demand, 800 cases: **0 failures** (was 141).
- fixed build, mixed × wrap-all, 800 cases: **0 failures** (was 151) — including all 161
  complete-conjunction cases per cell, which now PASS.
- old buggy snapshot re-check (same seeds, 200 cases per mode): od 40 / wa 41 failures, all carrying
  `mechanism:pure-definer-behind-barrel` and the family-A crash signature, and the od failing-seed set
  is EXACTLY wave 7's for that range — no environment drift; the red persists where it should.

The known suspicion (2 zero-call-site init functions remaining in one real app after the fix) did NOT
reproduce through the fuzzer's shapes at 800 cases/cell: whatever shape those two functions need, the
generator does not currently assemble it, so it stays an open lead, not a refuted one.

## Construct 1 — callable reads own state (`callableOwnState`)

The read-side ingredient wave 7 named as missing for family B, modeled on the real d3-scale
`unit`/`rescale` mechanism located in the shadcn breakage: a module with module-scope MUTABLE state
assigned at init, and an exported FUNCTION that reads that state; consumers CALL the export at
startup. The existing hoisted-call import returns a constant, so a skipped init was invisible through
it; this construct makes it visible — a skipped init leaves the state `undefined`, the call folds
NaN, the event channel rejects it, a bundle-only crash.

- Model: `ModuleModelBase.callableOwnState`, plus `EsmNamespaceImportOperation.callMembers` (the
  subset of `readMembers` read as CALLS `ns.member()`; validated a subset). `readableBindingsOf`
  yields `{ member, call: true }` reads for call members.
- Render: `let __ownState0 = /* @__PURE__ */ __ownStateBuild0();` then per demanded export
  `export function name() { return __ownState0 + k; }`. The build-call keeps the state a runtime
  binding — a literal would be constant-folded into the function body and mask a dropped init, the
  same non-inlinability trick as the family-A definer value.
- May combine with `inferredPure` (~60% of generated clusters): the whole module is then pure
  statements (a `let` from a `/* @__PURE__ */` call + function declarations). **Smoke-verified against
  the fixed build: an UNUSED inferred-pure callable-own-state definer is dropped from the output
  entirely** — inference still holds for the `let` + assignment form. The event-carrying variant
  (~40%) keeps its events and adds the same callable.
- Generation: `injectCallableOwnStateClusters` appends a self-contained cluster — definer, a 1-hop
  barrel (star or named re-export), two consumers forced to entries that namespace-import the barrel
  and CALL the export. `applyStaticallyInvisibleReads` hides about half the entry calls inside a local
  function (`hiddenReadFn`), composing with the wave-7 family-B shape. Tag
  `variation:callable-own-state`; measured **~17% of random-mixed cases** (double-digit target met).
  ESM-only, skipped in pure-CJS.

### Oracle-soundness rule (do not break)

Every export a callable-own-state module synthesizes is a FUNCTION. Folding a function binding
numerically concatenates its SOURCE TEXT into the payload (`100 + fn` is string concatenation), and
the bundle legally renames/reformats functions — a FALSE-POSITIVE surface, not a witness.
`validate-model.ts` therefore rejects, on DIRECT edges to a callable-own-state module: a value import
without `call`/`objectRef`, a namespace member not in `callMembers`, and any readable require.
Barrel-mediated chains are the generator's responsibility (its consumers always call) — the same
local/whole-chain split as `sideEffects: false` barrels. The renderer also marks namespace
`callMembers` callable on the DIRECT target (like call imports, callable-ness is never forwarded
through a star), so a flat model calling a plain module's member gets a constant-returning function
instead of a const crash.

`mechanism:pure-definer-behind-barrel` (family A) now counts only definers that are inferred-pure and
NOT callable-own-state, keeping the family-A tag specific to the value-read conjunction.

## Construct 2 — object-identity witness (`objectExport` + `objectRef` + `identityCheck`)

Blind spot: a no-events module whose init runs TWICE is invisible to the numeric oracle — numbers are
idempotent. Object identity is not: one evaluation yields one object; a re-run yields a NEW object.

- Model: `objectExport` (a no-events ESM leaf whose demanded exports render
  `export const name = { v: base };`), `EsmValueImportOperation.objectRef` (bind an object reference;
  excluded from `readableBindingsOf`, may not appear in numeric reads), and
  `EventRecord.identityCheck { leftBinding, rightBinding }` rendering
  `value + ((left === right) ? 0 : 987654321)`. On a correct build the fold is `value + 0`, byte-equal
  to source; a double-run init shifts it by the sentinel.
- Generation: `injectObjectIdentityClusters` — definer, a 1-hop barrel, two entry consumers each
  capturing the export DIRECTLY and THROUGH THE BARREL and comparing. Tag
  `variation:object-identity`; measured **~12% of random-mixed cases**.

### The legality gate that admitted it (probe evidence)

Before any integration, 6 handwritten probes ran raw-source vs rolldown-built with the fuzzer's exact
options (`preserveEntrySignatures: allow-extension`, `strictExecutionOrder: true`, `minify: false`),
on BOTH the old buggy snapshot and the fixed build, in BOTH wrap modes (24 runs): direct×direct,
direct×barrel-named, namespace-member×direct, star-barrel-namespace×direct, cross-chunk two-entries
(two entry chunks each capturing from a shared chunk), and the CJS boundary (`exports.obj` required
into an ESM importer both directly and via an interop hop). **All 24 preserved identity** (`a === b`
true in source AND bundle). No divergent shape was found, so no exclusion list was needed — the
witness integrated at full breadth. Probe script: `probe-identity.mjs` (scratchpad, out-of-tree; the
shapes are also covered by `tests/witness-constructs.test.ts` rendering/equivalence tests).

If a future rolldown version legally breaks identity for some shape (e.g. re-evaluating a shared
module per chunk group), the witness will fire there; re-run the probe matrix before trusting a red
`variation:object-identity` case, and record any legal divergence here (like the CJS namespace
`module.exports` key exclusion in
[namespace-and-barrel-reexports](./namespace-and-barrel-reexports.md)).

## Shrinking

Three wave-8 candidates in `shrink.ts`: drop `callableOwnState` (reveals whether the own-state
callable is load-bearing), drop an `identityCheck` (reverts to a plain event; the objectRef imports
become droppable), drop `objectExport` (exports fold to numbers; two captures of the same number keep
`a === b` true, so the model stays sound while the object-ness witness goes dead). All are validated
and kept only when the failure kind is preserved.

`FAILURE_ARTIFACT_SCHEMA_VERSION` stays 16: the artifact FORMAT is unchanged (the new fields ride
inside `model.json`, which the identity already hashes byte-for-byte).

## Acceptance campaign (old buggy snapshot, new constructs active)

4 cells × 600 cases, seed base 800000, `--continue-on-fail` — full detail in
`/tmp/order-fuzzer-w8/FINDINGS.md` (out-of-tree): mixed od 129 / wa 135 fail, pure-esm od 118 / wa
124 fail; densities in-campaign: callable-own-state 16.8% (mixed) / 19.0% (esm), object-identity
10.8% / 12.5%. Every one of the 506 failures has the ONE family-A signature; buckets are exhaustive:
conjunction-tagged (114/120/92/97 per cell) + callable-own-state split clusters WITHOUT the
conjunction tag (15/15/26/27) + zero object-identity-only + zero unexplained. Cross-referencing od vs
wa per seed: 0 od-only (no family-B — the cross-chunk predicted-order deviation on-demand needs
remains unassembled at ≤48 modules, the same named blocker as wave 7, now with the read-side
ingredient built so future scale/topology waves inherit it); 12 wa-only, all family-A-mechanism
(chunking/graph-dependent, as wave 7's 16). A campaign callable failure (seed 800050) was
hand-verified in the bundle — `var __ownState0;` assigned only in a ZERO-call-site init while the
exported reader function IS called, the d3-scale shape one-to-one — and shrunk 10 → 5 modules
(`/tmp/order-fuzzer-w8/shrunk-callable-800050.json`), red BOTH modes on the snapshot, GREEN on the
fixed build: the landed family-A fix covers the callable variant too. The object-identity witness
produced ZERO failures on both builds (armed, sound, no false positives; its value is prospective —
a silent double-init would now be visible).
