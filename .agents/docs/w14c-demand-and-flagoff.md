# W14c — canonical member paths, route enrichment, dead hops, and the #9998 flag-off catch

The final wave of the W14 barrel series. It lands four deliverables on
[the W14a structural foundation](./w14a-structural-foundation.md) and
[W14b package realism](./w14b-package-realism.md): a canonical member-PATH `ValueRead` plus the
`export * as ns from` operation (M7); the enriched canonical `RouteHop`; the dead-barrel-hop witness
family (M5); and the wave's crown — the **#9998 flag-off cross-entry-leak LIVE CATCH** under a new
reachability-isolation oracle, red on BOTH npm rolldown@1.1.5 AND the final PR-10104 snapshot at
`strictExecutionOrder:false`. The golden regenerated ONCE (`golden: W14c member-path + new ops`), every
delta proven by the causal `explain-delta` (extended for the new operations); catching power stayed in
its 21–27% band (22.8%, unchanged from W14b's 22.7%).

## Pre-pin — #9998, verified FIRST (inside this wave)

The issue's own verified repro (`gh issue view 9998`): two entries `a`/`b`; `b` dynamically imports
`shared`; `a` statically imports it and runs its own top-level effect; a manual `codeSplitting` group
`{ entriesAware: true, entriesAwareMergeThreshold: 10_000 }` with `experimental.chunkOptimization`,
built at `strictExecutionOrder: false`. Loading ONLY the built `b` yields
`se === ["a","shared-foo","b","shared-foo"]` — entry `a`'s top-level ran. Reproduced against both
targets (harness `scratchpad/9998-prepin`):

| target                         | seo:false                | seo:true (control) |
| ------------------------------ | ------------------------ | ------------------ |
| npm rolldown@1.1.5             | **RED** (`a` leaked)     | GREEN              |
| final-snapshot-42628c18b       | **RED** (`a` leaked)     | GREEN              |
| automatic chunking @ seo:false | GREEN (isolation intact) | —                  |

For this ESM-output shape, the bug is **OPEN everywhere at seo:false** (`#9997` fixed its strict path), so there is no green
target — a BRACKET-PENDING regression entry (below). The leak is **bidirectional** (loading `a` also
runs `b`) and — a stronger finding than the issue documents — the MINIMAL trigger is just a PLAIN
organic group `test:".*"` co-locating disjoint entries at seo:false: no `entriesAware` or
`chunkOptimization` is required (the issue's "plain groups trigger too"). The directed builder keeps the
faithful `entriesAware` + `entriesAwareMergeThreshold` + `chunkOptimization` config.

## Deliverable 1 — canonical member paths + `export * as ns from`

- **`ValueRead.member?: string` → `ValueRead.memberPath?: readonly string[]`** (`model.ts`), the ONE
  canonical member-path representation, SUBSUMING the former single-member namespace read: a plain
  `ns.foo` is a length-1 path `["foo"]`, a CJS readable-require member a length-1 path, a NESTED
  `outer.ns.member` a length-2 path `["ns","member"]`. `readMembers` on a namespace import is likewise
  a list of PATHS. `computed` renders the DEEPEST access `…[k]` (intermediate namespace hops stay
  static). `normalizeLegacyReads` (`model.ts`) is the v18 legacy reader — a bare `member` / string
  `readMembers` migrates on replay/shrink load, following the `buildConfigOf` / `packagesOf` pattern.
  Render-neutral: single-member reads render byte-identically (the golden proof — 458 cases stayed
  byte-identical after the migration, before the injectors below).
- **`EsmReexportNamespaceOperation` (`export * as ns from`, M7)** — re-exports a target's WHOLE
  namespace object under one named export. It is a LOCAL DEFINER of `exportedName` (it shadows any
  `export *` on the same module). The `starShadowedNames` / `providedExportNames` rule — the ONE
  name-providing surface (W14b.1 blocker 4) — gained the `ns`-as-name provision in ONE place. A nested
  `outer.ns.member` demand routes through the namespace re-export to the origin: `resolveNamespaceReadPath`
  (`analyzed-program.ts`) walks each path component, demanding the first on the barrel and following the
  `export * as ns` op to demand the deeper members on the inner definer — the single owner both the
  requested-name fixpoint and the consumption builder read.
- **Witnesses.** The NESTED numeric fold (`injectNamespaceReexport`, `generate.ts`): an inferred-pure
  inner definer, a `export * as ns` barrel, a consumer folding `outer.ns.v<inner>` — a mis-populated
  namespace surfaces as a wrong/undefined fold; a minority make the deepest access `computed`
  (statically invisible). Source-run-verified clean; a coverage/regression shape (M7 had no live bug).
  The namespace-OBJECT identity capture is a residual (below).
- **Tags / density** (per 6000-case validate sweep, 0 rejections): `variation:reexport-namespace` and
  `variation:nested-namespace-read` at ~7% of the 4-regime sweep (~9.6% of ESM-capable cases, ~12% in
  random-mixed).

## Deliverable 2 — enriched canonical `RouteHop`

`RouteHop` (`program-facts.ts`) gained `target` (the module the hop routes to), `exportedName` (the
name exposed on the barrel), and `importedName` (the name demanded on the target), for each named /
star / local hop `#collectDefiners` records. `shrink.rewireReadPastBarrel` now GENERALIZES over the
enriched hop — it reads the barrel's ONE route hop (`facts.resolveExportRoute`) and rewires a read to
`hop.target` under `hop.importedName`, so a named, star, OR local re-export barrel collapses through the
same path. **The named/star-only switch is DELETED** (the W14a/W14b must-not-repeat item). The plan's
route provenance, the family-A tag route walks, and the validator's dead-hop contract all consume the
enrichment — no parallel walks.

## Deliverable 3 — the dead-barrel-hop witness family (M5)

`injectDeadBarrelHop` (`generate.ts`) builds the `dead_barrel_reexport` shape: a MIXED barrel (a
declared local export `own` beside `export * from common`) shared by two entries with SPLIT demand —
the DEMANDING entry consumes `common`'s value through the barrel star (the hop is LIVE), the
NON-DEMANDING entry consumes ONLY `own` (the star hop is DEAD for it, legally tree-shakeable). `common`
is an event-free `objectExport` definer; the demanding entry captures its object TWO ways (directly and
through the barrel) and compares identity — a bundler that re-runs `common` per chunk group yields a NEW
object (double-init), which the fold catches; a correct build inits `common` EXACTLY ONCE.

**The legality contract (the point):** in SOURCE, importing the barrel evaluates `common` (ESM
evaluates all re-exports) even for the non-demanding entry, but the bundle legally TREE-SHAKES it — a
LEGAL source-vs-bundle divergence. If `common` carried events the standard event oracle would
FALSE-POSITIVE on that legal tree-shake, so **a dead-hop target MUST be event-free** and the witness is
the object-identity side only (the dead hop's silence is CORRECT). `validateDeadHopContract`
(`validate-model.ts`) enforces it PER-CONSUMPTION over the ONE plan (no new route walk): a mixed
barrel's star target must be event-free WHEN some importer routes no live consumption through the star
(the enriched `RouteHop.via === "star"`). A barrel whose sole importer DOES read a star-forwarded value
(the vben `index.js` shape) keeps the star live and an eventful target is accepted. Green regression
guard (the historical bug is fixed); tag `mechanism:dead-reexport-hop` at ~4.4% of the sweep.

## Deliverable 4 — the #9998 flag-off catch + reachability-isolation oracle (the crown)

- **`BuildConfig.strictExecutionOrder` is a ROLLABLE axis** — the validator accepts `seo:false`
  (removing the W14a rejection) and requires only a boolean. It is NOT rolled in random-mixed (a naive
  50/50 would dilute catching power and move the golden's `buildAxes`); it stays `true` by default and
  is flipped only by an explicit generation option, so the default corpus is byte-identical.
- **The reachability-isolation oracle** (`isolation-oracle.ts`), the ONE relaxed-order policy the
  program-run/verdict layer applies whenever the persisted `BuildConfig` says `seo:false` — DERIVED from
  the config in `executeProgram` and threaded as the event comparator through `classifyVerdict`
  (identical in campaign / replay / shrink / identity, because it comes from the program's own
  `BuildConfig`, not a per-caller switch; a `seo:false` case NEVER uses the full-order oracle). The
  invariant: after each schedule op, every module that has EXECUTED in the bundle must be REACHABLE
  (static OR dynamic — `ProgramFacts.reachableAllFrom`) from the entries loaded so far (schedule markers
  attribute per op). Set-based and order-free — a legal relaxed-order reshuffle never violates it (every
  eager module is reachable from its own entry); a CROSS-ENTRY LEAK does (the leaked module is reachable
  only from an entry not yet loaded). The signature is the sorted set of leaked module ids (e.g.
  `reachability-isolation:[le-a]`), so shrink preserves the exact violated-module fingerprint. Defends
  against a reachability-model gap by subtracting any SOURCE violation (Node only runs reachable
  modules, so a source violation means the model — not the bundle — is wrong, never a false catch).
- **Generator.** `buildCrossEntryLeakCase` / `generateCrossEntryLeakCase` (`generate.ts`) — the faithful
  #9998 shape as a directed seo:false program (two entries; `le-b` dynamically imports `le-shared`;
  `le-a` value-imports it and folds it into its OWN top-level event so its execution is visible; an
  `entriesAware` group + `chunkOptimization`). Plus a `crossEntryGroupBias` option that appends an
  `entriesAware` co-locating group over a random program's modules (the seo:false random cell). The
  build child enables `experimental.chunkOptimization` only when a group requests `entriesAware`, and
  maps `entriesAware`/`entriesAwareMergeThreshold` onto rolldown's `CodeSplittingGroup`.
- **Acceptance — the fuzzer catches #9998.** `scripts/cross-entry-leak-catch.ts`, 20 seeds: isolation
  RED 20/20 on npm rolldown@1.1.5 AND 20/20 on the final snapshot (signature `reachability-isolation:[le-a]`),
  seo:true control GREEN — this ESM-output shape is seo:false-only. Evidence
  `.agents/evidence/9998-cross-entry-leak.json`. Shrink preserves the violated-module signature. No
  green target (bug open everywhere) → BRACKET-PENDING entry `RED-9998` in `regression/index.json` (a
  new `bracketPending` form: the bracket HOLDs when the red reproduces on both targets, and graduates to
  a normal bracket when a fix flips the green target).
- **Sanity.** `scripts/seo-false-sanity.ts`, 300 SINGLE-ENTRY seo:false cases (a single entry can have
  NO cross-entry leak by construction, so any isolation verdict is a genuine false positive): ZERO
  isolation false positives, and **39 of the green cases had relaxed-order divergences the FULL-order
  oracle WOULD have red-flagged** — the accepted relaxed-order behavior the isolation oracle correctly
  ignores. Evidence `.agents/evidence/seo-false-sanity.json`.
- **Bonus finding (not escalated).** A MULTI-entry seo:false program can genuinely leak cross-entry even
  with AUTOMATIC chunking (loading a downstream entry runs an upstream entry's top-level — the isolation
  oracle catches it as a true positive; the sanity uses single-entry cases to exclude it). A broader
  manifestation of the #9998 class than the manual-group repro.

## Golden discipline — regenerated ONCE, delta PROVEN CAUSALLY

`golden: W14c member-path + new ops` is the wave's single regeneration. The member-path migration and
RouteHop enrichment are render-neutral (byte-identical). The delta comes from the two END-STAGE W14c
injectors (drawn AFTER every W14b draw, so a non-firing case is byte-identical). `explain-delta` was
extended: `carriesNewOperation` recognizes `esm-reexport-namespace` and a nested namespace read (depth
≥ 2), and the schedule-change check accepts an entry that imports a new-op module (the ns-reexport
barrel / dead-hop mixed barrel). Vs the pre-wave golden: **458 cases — 424 byte-identical, 21 changed
with packages, 13 changed by a new operation only, 0 unexplained.** The 143 package-carrying cases are
unchanged in count (the injectors never perturb a package roll).

## Verification

`vp check` + `vp test` (385 tests) green at every commit; `corpus:check` 458 byte-identical to the
regenerated golden; `explain-delta` 0 unexplained; a 6000-case validate+render sweep across all four
regime settings: 0 rejections, 0 render failures; `npm run catching-power` 22.8% (in the 21–27% band,
mixed-od 24.7% / mixed-wa 21.0%); `npm run regression:redset` all 5 brackets HOLD (RED-0…RED-3 +
RED-9998); the #9998 directed catch RED 20/20 on both targets; the seo:false sanity 300 single-entry
cases 0 false positives / 39 relaxed-order ignored; the 6-cell seo:true reacceptance (evidence
`.agents/evidence/w14c-reacceptance.json`).

## Residual gaps (next: FW-B / FW-A)

- **Namespace-OBJECT identity capture** (D1's second witness) is deferred: capturing `outer.ns` (a
  namespace object) by identity needs a namespace-member `objectRef` capture the current `identityCheck`
  (which compares two `objectRef` VALUE imports) does not express; probed as needing new capture
  machinery, left out to keep the witness sound. The nested numeric witness is the delivered M7 witness.
- The broader automatic-chunking cross-entry leak (the bonus finding) is a real seo:false behavior the
  oracle catches but the wave did not directed-campaign or bracket — a candidate for a follow-up.
- FW-B / FW-A (the skeleton-transplant and real-app-graph waves) are next; the enriched `RouteHop`,
  the member-path representation, and the seo:false oracle are the seams they extend.
