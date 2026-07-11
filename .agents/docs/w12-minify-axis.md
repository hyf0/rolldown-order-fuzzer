# W12 — the minify axis (the last audit-priority configuration blind spot)

Production builds are minified; before this wave a minify-only order bug was real-app-only BY
CONSTRUCTION (the fuzzer pinned `minify: false`). W12 adds a persisted `minify` axis, an oracle error
normalizer so error identity survives identifier mangling, and campaigns that compose minify with the
self-rebinding-wrapper shapes. Closes gap-audit Wave 12 (`research/vite-chunk-execution-order/fuzzer-gap-audit.md`
§4 Wave 12 / §1 gap 5 / §4 Pass-4 "Minify-only divergences"). Shares the CJS output path FW-A landed
([fw-a-output-format-axis.md](./fw-a-output-format-axis.md)); builds on the
[regression red-set](./regression-red-set.md) and the [real-app bug families](./real-app-bug-families.md).

## Deliverable 1 — the axis (`BuildConfig.minify: boolean`)

`minify: boolean` on the persisted `BuildConfig` (`model.ts`), default `false`. Threaded END TO END exactly
like FW-A's `outputFormat`:

- **generate** (`finalizeProgram`): rolled at `1/MINIFY_DENOMINATOR` = 1/4 density, **drawn LAST** — after
  the output-format roll AND every source-affecting / W14b-W14c enrichment roll. `rng.integer(N)` consumes
  exactly ONE draw regardless of `N`, and NOTHING draws after the minify roll, so it is provably
  RNG-NEUTRAL: a case's rendered SOURCE bytes AND its every other axis (output format included) are
  UNCHANGED from the pre-W12 corpus. NO gate (unlike `cjs`, minify composes with TLA and every other axis).
  Tag `axis:minify:{true,false}`.
- **build child + adapter**: `output.minify` is now a `boolean` (was the pinned `false`); the request
  threads `build.minify` straight to rolldown's `OutputOptions.minify` via `createOutputOptions`.
  `minify` moved OUT of the cosmetic `ROLLDOWN_BUILD_OPTIONS` baseline (like `format` before it), so the
  identity records the real per-case value.
- **identity + corpus + shrink**: the artifact identity records `minify` (a minified case dedups distinctly
  from its un-minified twin — identical source, different bundle). The corpus golden's `buildAxes` gains
  `minify: true` ONLY for minified cases (un-minified cases byte-identical), and `explain-delta` accounts
  for a minify-only roll (a `minify`-alone buildAxes diff is an allowed axis, not a drift). The shrinker
  carries the whole `build` through `buildConfigOf` on every candidate, and a minify-shrink candidate
  (try `minify:false`) reveals whether minify is load-bearing — a minify-ONLY red keeps `minify:true` in
  the shrunk artifact (the candidate rejects), a red that does not need minify flips to false.

**RNG-neutrality proof (force the draw off → byte-identical):** with the minify draw forced OFF (still
consumed), `corpus:check` is BYTE-IDENTICAL to the pre-W12 golden (458 cases). Regenerating WITH the roll:
`explain-delta` vs the pre-W12 golden — 458 cases, 378 byte-identical, 32 changed with packages, 5 by a new
operation, **43 by an output-format/minify axis roll only, 0 unexplained**; 80 cases now carry `minify:true`.
The ONE labeled golden regen (`golden: W12 minify axis`).

Per-axis densities: `axis:minify:true` 23.5% (tag-density, 3000 random-mixed); 21.1% over the 6000-case
4-regime sweep; the **minify×cjs composition cell 4.3%** of random cases (continuous coverage of the
self-rebinding wrapper under the CJS render arm).

## Deliverable 2 — the oracle normalizer (the seam) + the legality gate

### The legality gate (probed FIRST, empirically, on both snapshots × {esm,cjs} × minify:{false,true})

Handwritten probes (`scratchpad/minify-legality-probe.mjs`, `minify-broad-probe.mjs`) built representative
order-sensitive shapes (a green random-mixed case, a family-A NaN-fold case, the cjs-output witness, the
cross-chunk init cycle, the optimizer cycle) at minify:{false,true} × output-format against the buggy
`pr10104-runtime-snapshot` and npm 1.1.5, diffing the RAW event streams + error strings. A broad sweep ran
60 random-mixed seeds × {esm,cjs} = 120 pairs. Every divergence class minify introduces:

| channel                               | divergence under minify                                                                                                                                              | verdict                 | handled how                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **events / values**                   | NONE — bundle events byte-identical between minify:false and minify:true on all shapes (120/120 pairs, 5 shapes × 2 targets)                                         | minify-invariant        | event payloads are string / numeric LITERALS the mangler never touches; nothing to normalize                                        |
| **error message — identifier rename** | `init_module_0003 is not a function` → `n is not a function` (a mangled internal identifier)                                                                         | the ONE real divergence | the error normalizer (below) collapses the identifier in known templates before the source-vs-bundle crash comparison               |
| **error message — un-renamable**      | a NaN-fold reject (`Execution event value must be a primitive JSON value`), a `Cannot read properties of undefined (reading 'foo')` (property names are NOT mangled) | rename-immune           | matches NO template → passes through unchanged, keeping its discriminator; the family-A NaN-fold witness is therefore rename-IMMUNE |
| **error NAME**                        | NONE — the constructor name (TypeError / ReferenceError) is preserved                                                                                                | discriminator           | never normalized; stays the discriminator                                                                                           |
| **verdict class**                     | NONE — 0/120 pairs changed reason class                                                                                                                              | —                       | minify never flips pass↔red or one reason class to another                                                                          |
| **`.name` / source positions**        | NONE — no witness reads `Function.prototype.name`; the compared `[name,message]` carries no source position                                                          | out of scope            | nothing relies on it (events identical confirms it)                                                                                 |

Nothing beyond message-identifier renaming diverges legally. Nothing is gated away silently — the events
channel simply has no minify divergence, empirically.

### The normalizer (`verdict.ts`)

The ONLY false-positive risk is the `source=error && bundle=error` branch, where `errorsEqual(source, bundle)`
compares crash identity: an un-minified source throws `x is not a function`, the minified bundle throws
`t is not a function` → without normalization this is a false-positive `error-mismatch`. (A
`bundle-only-crash` — source ok, bundle error — never hits this comparison, so it is unaffected; it stays a
genuine red, only re-signatured with the mangled identifier.)

Design: `classifyVerdict` gains an `errorsEqualFn: ErrorComparator = errorsEqual` seam (mirroring the
`compareEventsFn` order-oracle seam). `program-run.ts` derives it ONCE from `buildConfigOf(program).minify`:
`minify:false` → the exact `errorsEqual` (**behavior UNCHANGED**); `minify:true` → `makeMinifyErrorComparator()`,
which requires the error NAME to match EXACTLY and the messages to match after
`normalizeMinifiedErrorMessage` on BOTH sides. That normalizer collapses the leading identifier-expression
of a small set of KNOWN runtime-error templates to `<id>`:

- `<id> is not a function` · `<id> is not a constructor` · `<id> is not defined` · `<id> is not iterable`
- `Cannot access '<id>' before initialization`

A message matching NO template is returned unchanged. So the normalizer only ever loosens the exact
identifier a legal rename moved — never the error NAME, the message TEMPLATE, or a property name.

Proven (verdict.test.ts + `scratchpad/normalizer-check.mjs`): under the minify comparator a renamed
`x`/`t is not a function` with identical preceding events is the correct PASS; the exact comparator (minify:false)
still reds it (`error-mismatch`); a genuinely different error (different NAME, or same name + different
template) STILL reds; an events divergence after equal errors STILL surfaces. The normalizer does NOT weaken
the minify:false path (the golden is minify:false-dominant and unchanged; catching-power measured on the
esm/minify:false subset is byte-identical → unchanged).

## Deliverable 3 — the wrapper-form witness under minify

The owner's original worry: minification could break the self-rebinding wrapper form
`function init_x(){ return (init_x = __esmMin(cb))() }` (an inconsistent rename across the rebinding
assignment). `scripts/minify-wrapper-catch.ts` composes `minify:true` with the shapes that stress that
wrapper — the cross-chunk `init_*` cycle (#9887), the runtime-placement optimizer cycle (#9993), the
CJS-output object-identity double-init witness (RED-8) — across `{od,wa} × {esm,cjs}` vs BOTH targets
(npm 1.1.5 + final snapshot). Findings (20 seeds/cell):

- **Every wrapper red on npm 1.1.5 reproduces under BOTH minify:false and minify:true, same reason class**
  (`wrapper-preserved-under-minify: HOLDS`): mangling does NOT hide the wrapper defect — the crash identity
  survives (the normalizer makes the mangled-identifier crash comparable). cross-chunk-init-cycle reds
  esm+cjs × od+wa; optimizer-cycle reds cjs × od+wa (green at esm on 1.1.5, as RED-3's bracket predicts);
  cjs-output-witness reds cjs/od (RED-8, od-only per FW-A).
- **The final snapshot (fixed arc) is GREEN in every cell** — no minify-only red on the fixed build. A red
  there would be a release-relevant minify-only catch (the script escalates it prominently and records it
  in the evidence); none observed. Evidence `.agents/evidence/minify-wrapper.json`.

## Deliverable 4 — campaigns

- **reacceptance (6-cell × 300, seo:true, vs the buggy snapshot)** — the generator now rolls minify, so
  ~24% of the 1800 builds are minified. Every red stays in the ENUMERATED known reason classes
  (`bundle-only-crash` / `events-reordered`); the family-A NaN-fold reds are rename-IMMUNE (a fixed harness
  message with no identifier) so they are caught under minify unchanged. Evidence `w14c-reacceptance.json`.
- **catching-power (esm/minify:false baseline)** — unchanged: the esm/minify:false subset is byte-identical
  to pre-W12 (RNG-neutral), so its verdicts are identical; the red-rate stays in the committed 21-27% band.
- **minify-sanity (`scripts/minify-sanity.ts`, ~300 ordinary shapes, minify:true, vs the final snapshot)** —
  GREEN, with the precise test that NO minify:true red has a GREEN minify:false twin (a minify-INTRODUCED
  red would be a normalizer false-positive OR a real minify-only catch). 0 minify-introduced reds → the
  normalizer has no false-positive gap. Evidence `.agents/evidence/minify-sanity.json`.

## Acceptance (all green)

- **golden** regenerated ONCE (`golden: W12 minify axis`); force-off byte-identical to pre-W12 (458 cases);
  explain-delta 0 unexplained (43 axis-only). `npm run regression:redset` — all 9 brackets HOLD (they are
  minify:false — unchanged). `npm run transplant:cell` green (committed models default minify→false).
  seo:false sanity intact. **6000-case validate+render sweep: 0 rejections, 0 render failures**. `vp check`
  - `vp test` green (410 tests — +6 for the normalizer + legacy default).
- The wrapper campaign holds; the minify-sanity cell is green; reacceptance in-band; catching-power in-band.

## Residual gaps (what minify coverage does NOT cover)

- **Both-crash property-name masking.** `normalizeMinifiedErrorMessage` collapses the WHOLE leading
  identifier-expression to `<id>`, so in the RARE `source=error && bundle=error` case a `mod.foo is not a
function` (source) vs `t.bar is not a function` (bundle) — differing in the PROPERTY, not just a rename —
  would normalize equal. In practice a both-crash whose events match up to the crash but whose crash-property
  genuinely differs is essentially unreachable (the events channel diverges first), and the fuzzer rarely
  produces top-level throws at all; the events channel is the backstop. Not observed in any campaign.
- **Minified bundle-only-crash SIGNATURES carry a mangled identifier** (`n is not a function` rather than
  `init_module_0003 is not a function`). This is a genuine, DETERMINISTIC signature (still a red, correctly),
  not a false positive — but a minified crash does not dedup with its un-minified twin. Deliberate: the spec
  normalizes only the source-vs-bundle COMPARISON, never the emitted signature (normalizing the signature
  would require touching the un-minified side too, weakening minify:false). The campaigns compare reason
  CLASS across minify settings to stay stable.
- **`mangleProps` / property-name mangling is NOT exercised** — rolldown's default minify mangles internal
  variable identifiers and drops whitespace but does NOT rename object property names, so the fuzzer's
  member reads / event keys stay literal. A future `mangleProps`-style axis would need property-key
  normalization; out of scope here (not a default-build divergence).
- **keepNames axis** (gap-audit Wave 12c, flips `init_is_noop`) is NOT landed — a separate QW; minify with
  the default `keepNames:false` is the prod default and the one this wave targets.
