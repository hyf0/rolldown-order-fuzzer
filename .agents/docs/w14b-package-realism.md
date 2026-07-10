# W14b — package/metadata realism (family-B: the eager-barrel catch)

The package/metadata realism cluster: modules can belong to named `node_modules` packages carrying
`sideEffects` metadata (boolean AND the array/partial form), the module-level `sideEffectFree`
representation is MIGRATED onto that model through one legacy-normalization seam, and the wave's
acceptance crown — the family-B eager-barrel conjunction (the vue-vben-admin
`initPreferences is not a function` breakage) — reproduces on the frozen snapshot as a same-seed
od-RED / wa-GREEN split, both directed and at double-digit random-mixed density. Builds on
[w14a-structural-foundation](./w14a-structural-foundation.md) (whose must-not-repeat list is updated
in place with per-item status), [real-app-bug-families](./real-app-bug-families.md), and
[side-effect-free-metadata](./side-effect-free-metadata.md) (both updated with migration notes).

## 1. Package/layout model (schema 17→18)

`ProgramModel.packages` (`model.ts PackageModel`): named packages whose members render under
fixture-local `node_modules/<name>/<id>.<ext>` with a generated `package.json` carrying `name`,
`main` (the FIRST member — what a bare `import … from "<name>"` resolves to), and `sideEffects`
verbatim. Cross-package imports render as bare specifiers (main) or `"<name>/<file>"` subpaths;
same-package imports stay sibling-relative; a member can climb back out to a root module. All of it
was smoke-verified to resolve identically under Node and the rolldown build child (including
package-to-package bare imports through the flat fixture-local node_modules and a CJS-main package),
and an adapter e2e pins the whole surface differential-green.

- **Member files are named by the STABLE module id**, not the program-order index root modules keep —
  so a shrink step that drops modules never renumbers a package file out from under a `sideEffects`
  array entry. Root modules keep `module-NNNN.<ext>`, so a package-free program renders
  byte-identically (the golden proof below).
- **`sideEffects` semantics** (probed against the frozen snapshot): `false` marks every member
  METADATA-PURE; an ARRAY marks exactly the UNMATCHED members pure (a listed member keeps its side
  effects — the vben partial form, the family-B ingredient); `true` asserts nothing. Array entries
  match with or without a leading `./` and support `*` wildcards; the validator restricts patterns to
  a flat literal-plus-`*` subset so the fuzzer's matcher (`sideEffectsPatternMatches`) cannot diverge
  from rolldown's glob engine on anything the model can express. The value-only/no-events
  oracle-soundness contract binds exactly the metadata-pure-RESOLVED members
  (`metadataPureModuleIds`); a matched file is allowed events.
- **THE migration seam.** `packagesOf` (model.ts) resolves the one packages view: persisted
  `packages` win; a legacy (schema ≤17) `sideEffectFree` flag normalizes to a single-member
  `sideEffects: false` package named `sef-<id>` — the SAME shape the generator's flagger now persists
  (identical RNG draws; only the representation moved), so a legacy artifact and its regenerated
  equivalent render identically. The renderer's `side-effect-free/` directory is DELETED as a
  mechanism; metadata purity left `ModuleProfile` (it is a package-level fact, not a per-module
  profile axis); the purity contract is enforced once, on the package view, for legacy and new models
  alike; and a program carrying BOTH forms is rejected — never two live representations.
- **Deliberate relaxation:** a metadata-pure member MAY also be `inferredPure` (both mechanisms
  assert "no side effects"; the real vben packages carry exactly this combination — the
  retained-reference witness exercises it). `callableOwnState`/`objectExport` stay excluded (their
  witnesses break under legal DCE). The old per-module `inferredPure`+`sideEffectFree` flag exclusion
  is gone WITH the flag's live role, so the flag form and the package form obey identical rules
  through the seam.
- **Schema decision:** `FAILURE_ARTIFACT_SCHEMA_VERSION` 17→18. `packagesOf` is the v17 reader,
  following the `buildConfigOf` fallback pattern: an old artifact still validates and replays with
  semantically identical metadata (its rendered layout moves into `node_modules/`, which a replay
  re-renders anyway).
- **`localExports`** (`EsmModuleModel`): export names a module DECLARES locally beside a star
  re-export — the vben `index.js` own-helper shape a star-suppressed barrel could not express, and
  the family-B "one own helper keeps the barrel included" ingredient. A declared name is a LOCAL
  definer that shadows `export *` in BOTH routing projections (the requested-name fixpoint and the
  supply walk agree by construction) and renders through the ordinary synthesized-export templates
  (call-marked → the hoisted `export function name() { … }` the entry's call keeps included).

## 2. The camunda local re-export (M4, `esm-local-reexport`)

`import { s as l } from target; export { l as e };` — a SOURCE-LESS re-export of an imported binding,
on a module that may also carry its own events (the package-barrel-with-own-effect shape from the
camunda breakage; unblocked by W14a's renderer array-order fix). One operation threaded through the
canonical seams: the plan records the import half as a LIVE numeric demand (supply- AND shape-checked
— strictly stronger than a pure re-export's link-required check, so the MISSING_EXPORT channel stays
closed) and demand for the exported name forwards via a new `local` RouteHop kind; the renderer emits
the import in its dependency-array slot and the export clause with the exports; the local binding is
readable (events may fold it); the validator shares the duplicate-export-name space with named
re-exports, requires ESM, and rejects a cycle-closing edge (TDZ). Shrink DOWNGRADES a local re-export
to the named form (revealing whether the live-import form is load-bearing) — the manual barrel-rewire
switch was deliberately NOT extended. Composition: the end-stage camunda rewrite flips ONE named hop
per rolled case into the local form (guarded to value-category origins — a callable/object origin
would make the live import an invalid consumption), sometimes adding an own event when purity
permits; it reaches family-A conjunction barrels, retained-reference package barrels (camunda BEHIND
a package), generated barrel chains, and family-B dual-default hops. Tags: `variation:reexport-local`
(5.4% of random-mixed), `mechanism:local-reexport-with-own-effect` (2.0%).

## 3. Family-B assembly — the eager-barrel conjunction (the wave's acceptance crown)

The real fix's regression fixture (`entry_fn_captures_wrapped_value`, the vben shape) was translated
ingredient-for-ingredient after a snapshot bisection pinned what is load-bearing. The conjunction —
removing ANY ingredient greens the shape:

1. a package whose `sideEffects` ARRAY lists only the sibling/manager (`no metadata` and
   `sideEffects: true` both green — the partial form is the point);
2. the package-main barrel: `export * from facade` (a NAMED hop resolves the binding directly and
   greens) PLUS an own INCLUDED statement — a DECLARED call-marked helper the entry calls (vben's
   `tag`; without it the "included same-chunk forwarder owns downstream init" delegation never
   happens and the shape greens);
3. the facade: metadata-pure, its export assigned at init from a CALL of the sibling's function
   (non-inlinable — a dropped init folds `undefined` → NaN → the event channel rejects it);
4. the sibling: the package's one listed, side-effectful module;
5. a chunk group splitting {facade, sibling} away from the entry chunk (no group, no bug); the
   fixture's `includeDependenciesRecursively:false` is NOT load-bearing (idr:true stays red), so the
   random conjunction rides whatever the case rolled;
6. a side-effectful root module the entry imports FIRST (source order runs it before the manager,
   predicted chunk order runs the manager's chunk first — the deviation that seeds the wrap plan;
   removing it greens);
7. the entry reads the facade's value through the barrel in an event so the oracle observes it —
   HIDDEN (a hiddenReadFn-invoked function, the brief's shape) OR VISIBLE (the bisection found even a
   plain top-level read fails on this build): the READ is the load-bearing ingredient, not its
   visibility, so the shrunken repro below reveals the read and stays BOTH red and tagged.

**Generator:** `injectFamilyBEagerBarrel` — part of the W14b END-STAGE enrichment in
`finalizeProgram`, every roll drawn AFTER the last W14a draw (the lazyBarrel axis), so a case where
no enrichment fires is byte-identical to the W14a corpus. The cluster merges its {facade, sibling}
group into whatever chunking mode the case rolled (manual/default: a manual group; organic: an
appended organic group whose separator-tolerant regex test selects the two package files, priority
above every generated flavor). A 35% variant adds the D2 witness (below). Complete conjunctions are
tagged `mechanism:family-b-eager-barrel` by a CAUSAL structural predicate over the analyzed program
(`hasCompleteFamilyBConjunction`), requiring EVERY ingredient — and specifically: the barrel is the
package MAIN (`moduleIds[0]`, what a bare `import … from "P"` resolves — not "any member tried as a
barrel"); the entry is provably OUTSIDE the `{facade, sibling}` chunk group (the group holds both
members but not the entry); and the entry ACTUALLY invokes the helper via a `ValueRead.call` in an
event (a `call:true` import the entry never calls runs no forwarder and is NOT the shape — a decoy
that keeps the call-marked import but drops the event call is correctly rejected). The entry's facade
read is counted whether HIDDEN or VISIBLE
(the snapshot fails both, so the read is the ingredient, not its visibility), so the tag holds for
generated, directed, handwritten, and shrunk models alike. Recomputed with the causal predicate:
**15.4% of random-mixed** (3000-case scan; the ≥10% double-digit target) — unchanged, because the
injector already emits the full causal shape, so the tightened predicate rejects only hand-crafted
decoys, never a random case.

**Directed acceptance** (`buildFamilyBEagerBarrel` via the standard freeze/analyze seam;
`scripts/family-b-catch.ts`, 20 seeds × {od, wa} × {lazyBarrel false, true} against the frozen
PR-10104 snapshot, which contains bug B): **od-RED 20/20** (every red the NaN-family
`bundle-only-crash`) / **wa-GREEN 20/20** on the SAME seeds — and the same 20/20-vs-20/20 split under
`lazyBarrel: true` (deliverable 3c: the lazy barrel path does not mask the bug). The same-seed
od-red/wa-green split IS the family-B fingerprint (family A reds both modes); the wa cell is the
internal control, no second rolldown build needed. Machine-readable evidence committed at
`.agents/evidence/family-b-eager-barrel.json` (per-seed verdicts in all four cells, signature
histograms, HEAD, node, target dist sha256).

**Shrunken repro** (`.agents/evidence/family-b-shrunken-model.json`, produced by `src/shrink.ts
--on-demand` against the snapshot, split re-verified od-red/wa-green): 5 modules. The shrinker
proved several ingredients SIMPLIFIABLE while preserving the exact signature: the sibling's events
and the package membership of barrel+sibling drop (a root no-events barrel is inferred pure anyway —
metadata purity must only cover the FACADE, a single-member `sideEffects: false` package), the
hiddenReadFn reveals to a plain top-level read, and idr flips to true — while the package on the
facade, the star hop, the declared call-marked helper, the {facade, sibling} chunk group, and the
effectful first import all stayed (each was tried and rejected — load-bearing). Because the causal tag
counts a VISIBLE facade read, the shrunken model is itself `mechanism:family-b-eager-barrel`-tagged:
the "held by shrunk models" claim is now TRUE by the predicate, not contradicted by the reveal (the
earlier tag required `hiddenReadFn` and so would have un-tagged this exact repro).

## 4. Witness shapes (deliverable 3)

- **(a) retained-reference** (`injectRetainedReference`, ~10%; tag
  `mechanism:package-retained-reference`, 9.5%): the closed #9961/#10123 family — a
  `sideEffects: false` package member whose top-level reference to an inferred-pure definer (IN the
  package on one variant — the deliberately-allowed inferred-under-metadata combination — or a ROOT
  module on the other) is retained by a kept event's demand downstream. Witnessed through the
  existing value folds; green on the snapshot (the bugs are fixed there), standing regression
  coverage.
- **(b) named-AND-default alias (D2)** (tag `variation:named-and-default-alias`): the SAME source
  binding re-exported through one barrel as both a named alias and `default`, consumed both ways —
  rolled into the family-B cluster (35%) and the retained-reference cluster (50%).
- **(c) lazyBarrel interaction:** the enrichment never touches the rolled `lazyBarrel` axis, so every
  witness shape lands on both values (the 50/50 axis tags), and the directed campaign runs explicit
  `lazyBarrel: true` cells: family-B splits od-red/wa-green identically there — no
  lazy-path-specific divergence surfaced on the frozen snapshot (none escalated).

Plus two package composition variants: the family-A conjunction packaged behind a partial-array or
`sideEffects: true` package (25% of conjunction cases — family A BEHIND a package boundary), and
plain single-member `sideEffects: true` packaging of ordinary modules (~8% — pure resolution-surface
realism). Package tags: `variation:package` 56.2%, `variation:side-effects-array` 19.1%,
`variation:side-effect-free-metadata` 51.0% (now the resolved package view).

## 5. Golden discipline — regenerated ONCE, delta PROVEN CAUSALLY

`golden: W14b package realism` is the wave's single regeneration. `scripts/corpus-manifest.ts` gained
an `explain-delta <old-golden>` command that PROVES the label CAUSALLY — not by feature presence
(the earlier version bucketed any changed case with `packages.length > 0` as package-caused, so a
codeSplitting or schedule move riding along was never actually proven package-caused). It regenerates
against an old golden and, for each changed case, requires the delta to be accounted for by the
ALLOWED W14b transformations ONLY, failing otherwise: a render error fails; a `buildAxes` drift fails
(the package enrichment is END-STAGE — drawn after the BuildConfig axes are rolled — so it cannot move
a pre-enrichment axis); a codeSplitting change that is not an appended PACKAGE chunk group fails (the
family-B `{facade, sibling}` cluster group is verified over package members / a `node_modules` regex,
and no base group may drop); and an in-place root file whose module imports no package member and
carries no new operation fails. Vs the `787d2da` golden: **458 cases — 311 byte-identical, 143 changed
with packages, 4 changed by a new operation only, 0 unexplained; 315 package-free = 311 unchanged + 4
new-op.** (The 311 byte-identical count is NOT "the package-free corpus" — 315 cases carry no packages,
4 of them changed by a new operation; the earlier record conflated the two.) The manifest's optional
`packages` field appears only on package-carrying cases, so the golden stays self-explaining.

## 6. Reacceptance vs the frozen snapshot

**Catching power** (`npm run catching-power`, 300 seeds × od/wa, mixed regime): mixed-od 73/300
(24.3%), mixed-wa 63/300 (21.0%), combined **22.7% — IN the committed 21–27% band** with no band
change. The composition shifted as the wave intends: family-B adds od-ONLY reds (the od>wa asymmetry
is its fingerprint), while the deliberate family-A packaging/camunda variants trade some family-A
redness for composition coverage (family-A-red 100/136 reds; 75.8% of family-A-tagged runs red, down
from 89.4% — the traded cases mostly moved to the reorder class below, still red).

**6-cell × 300** (3 regimes × od/wa, seeds 200000–200299): mixed-od 73 (24.3%) / mixed-wa 63
(21.0%), pure-esm-od 75 (25.0%) / pure-esm-wa 58 (19.3%), pure-cjs 0/0 (family-free, as always).
Signature classes enumerated — exactly TWO across all 1800 builds, both classified:

1. `bundle-only-crash:["Error","Execution event value must be a primitive JSON value"]` — the NaN
   fold class: family-A conjunctions and wave-8 callable-own-state clusters (both modes), plus
   family-B (od-only). The dominant class in every red cell.
2. `events-reordered` on family-A-cluster modules (6–8 per mixed cell, 1–2 per pure-esm cell) — a
   W14b-COMPOSITION variant of family A, not a new mechanism: the conjunction behind an `fa-*`
   package (or with a camunda-flipped hop) turns the same barrel-init mishandling into an observable
   ORDER deviation instead of a dropped-init crash. Not an oracle artifact: `sideEffects` metadata
   licenses dropping PURE members, never reordering a LISTED (side-effectful) member's events, and
   `sideEffects: true` licenses nothing. Triaged instance: seed 200063 (mixed), reproduced with
   RETAINED artifacts at `.agents/evidence/seed-200063-reorder.json` (model, both-mode verdicts,
   source+bundle event arrays, emitted init order, ablations; regenerated by `scripts/seed-200063-catch.ts`).
   On the frozen buggy snapshot: od-GREEN / wa-RED-`events-reordered` — the source runs the LISTED
   side-effectful sibling `psib10` third (`… psib10 psib10 pconsA10 …`) while wrap-all DEFERS it to the
   very end (`… pconsA10 … psib10 psib10 pconsB10`). The family-A root cause is now CAUSALLY tied by
   ABLATION (not merely by ancestry): dropping the `fa-` package resurfaces the classic family-A NaN
   `bundle-only-crash` (the same conjunction underneath), and withdrawing the partial `sideEffects`
   array (→ `true`) GREENS the wa cell — so the partial-metadata packaging is exactly what
   re-manifests the family-A init mishandling as an order deviation rather than a crash. On the FINAL
   snapshot (`final-snapshot-42628c18b`, the shipped strict-order fixes) it is GREEN in BOTH modes: a
   snapshot-specific expression of the already-known family-A init-ordering arc, closed upstream —
   recorded as a triaged finding, not escalated.

Same-seed od/wa cross-reference: **every od-only red is family-B-tagged** — the mixed cell
RE-VERIFIED fresh with the CAUSAL predicate (300 seeds 200000–200299 od+wa against the buggy
snapshot: 14 od-only reds, 14 family-B-tagged, 0 unexplained; combined 22.7%, family-A red 80.3% of
tagged), the pure-esm 17/17 from the committed 6-cell campaign; wa-only reds are 4 (mixed) — the known
W7 "organic chunking
let od init correctly" family-A class (200213, 200217) plus two packaged-family-A variants (200063
reorder above, 200165); both-red is family-A + the wave-8 callable-own-state class. Family-B was
also probed on npm rolldown@1.1.5 (latest release): GREEN both modes — bug B lives in the
snapshot's eager-forwarder delegation (the PR-10104 arc mid-state), not in the released wrapper, so
the catch is exactly the brief's target (the frozen snapshot that contains bug B) with no
live-release escalation warranted.

## Verification

`vp check` + `vp test` green at every commit; `corpus:check` 458 byte-identical to the regenerated
golden; `explain-delta` vs the `787d2da` golden PROVES the delta causally (0 unexplained; buildAxes,
codeSplitting, and every root-file change accounted for by the allowed W14b transformations); a
6000-case validate+render sweep across all four regime settings: 0 rejections, 0 render failures; the
family-B directed campaign od-RED 20/20 / wa-GREEN 20/20 under both lazyBarrel values (evidence +
shrunken repro committed); the seed-200063 reorder reproduced with retained artifacts and its family-A
root cause tied by ablation (`.agents/evidence/seed-200063-reorder.json`); tag densities as listed
above (family-A conjunction unchanged at 22.7%).

## Residual gaps (W14c scope — deliberately untouched)

- Member-path `ValueRead` / canonical `RouteHop` target+name enrichment / dead-hop witnesses.
- The `export * as ns` operation (M7).
- The `seo:false` relaxed-order oracle (#9998 isolation).
