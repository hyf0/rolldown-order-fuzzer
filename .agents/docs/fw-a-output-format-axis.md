# FW-A — the non-ESM output-format axis (CJS output, transpiled-CJS interop, deconfliction, RED upgrades)

The largest structurally-invisible fix surface from the fix-history mining: under the historical
ESM-output pin the ENTIRE `render_chunk_exports` CommonJS arm — live getters (`must_keep_live_binding`),
`__toCommonJS` at the entry, the self-rebinding-wrapper defense (`is_order_wrapper_ref`), and the
wrapped-init emission for a CJS entry chunk — was unreachable. FW-A adds a persisted output-format axis
and the interop capability it unlocks, and reaches a genuine CJS-output-arm bug open on the latest
release. Builds on [FW-B machinery-stress](./fw-b-machinery-stress.md), the
[regression red-set](./regression-red-set.md), and the gap-audit
(`research/vite-chunk-execution-order/fuzzer-gap-audit.md` Wave 11) + fix-history mining (P7/T4 cjs
output, P3 interop, P9 deconfliction).

## Deliverable 1 — the output-format axis (`BuildConfig.outputFormat: "esm" | "cjs"`)

`OutputFormat = "esm" | "cjs"` on the persisted `BuildConfig` (`model.ts`). `iife`/`umd` stay out — they
are single-entry, so a code-split multi-entry differential is impossible there. Threaded end to end:

- **generate** (`finalizeProgram`): `cjs` rolled at `1/CJS_OUTPUT_DENOMINATOR` = 1/5 density, **drawn
  LAST** — after every source-affecting roll AND the whole W14b/W14c enrichment. Because the SOURCE run
  is format-neutral (the format is bundle-side only), a cjs case's rendered source bytes are byte-identical
  to its esm twin. Proven: forcing the draw to esm regenerates the pre-wave golden BYTE-FOR-BYTE (the draw
  consumes one RNG value but nothing draws after it, so it perturbs nothing). Gated OFF whenever any module
  carries top-level await (rolldown hard-refuses TLA under cjs — `[UNSUPPORTED_FEATURE]`); the roll is
  consumed either way so the sequence stays deterministic. Tag `axis:output-format:{esm,cjs}`.
- **build child + adapter**: `output.format` accepts `esm`|`cjs`; `outputFormatFileOptions(format)`
  resolves the `format` + `.js`/`.cjs` entry/chunk names. The bundle directory keeps its
  `{"type":"module"}` package.json — a `.cjs` extension is what makes Node load the emitted files as
  CommonJS (a `.js` there would parse as ESM and break cjs output).
- **runner / manifest**: the bundle manifest records the OUTPUT format on each entry, and the schedule
  loads a cjs-output entry via `require-entry` (an esm-output entry via `import-entry`) — the child runner
  already had both paths. `executeManifest` spawns a fresh child per run, so there is no require/ESM cache
  bleed. seo stays as-is (true in the default corpus), so cjs cells run under the strict full-order oracle.
- **identity + corpus**: the artifact identity records `outputFormat`; the corpus golden's `buildAxes`
  gains `outputFormat` ONLY for cjs cases (esm cases byte-identical), and `explain-delta` was extended to
  account for a format-only roll (a buildAxes diff in `outputFormat` alone is an allowed axis, not a drift).

**Empirical loading gate (probed FIRST, both a buggy and the final snapshot):** for a green shape, the
CJS-output events equal the source events equal the ESM-output events on the fixed snapshot; the require
path (and import) load a `.cjs` entry with events equal to the source run. The events channel is
format-neutral (both formats call the same `globalThis.__orderEvent`). Probe scripts under
`scratchpad/fw-a-probe/`.

## Deliverable 2 — deliberate name collisions (P9 deconfliction) — RESIDUAL, honest

The exact RED-2 / #9882 shape is a HYBRID module (`main.js` does ESM `import { … } from` AND writes
`exports.*` AND declares a colliding internal `var sharedValue = class {}`), which the model's disjoint
`EsmModuleModel` / `CjsModuleModel` cannot represent — a module is either ESM (renders `export {}`) or CJS
(renders `exports.*`), never both, and neither can carry a NAMED non-exported internal local. Reproducing
the exact `Cannot read properties of undefined (reading 'EventMatch')` requires three additions (a hybrid
"wrapped" module kind, an author-named internal-local field bypassing the renderer's `freshBinding`
collision avoidance, and a clean-unbundled-source rendering so the differential yields `bundle-only-crash`
rather than a source crash). Per the deliverable-4 discipline — "any entry that still can't reproduce
exactly stays raw — honest per-entry statement" — **RED-2 stays a raw fixture** (`regression/raw/9882/`,
verified RED on npm 1.1.3 / GREEN on 1.1.4 in the standing redset). The unique-names pin itself is NOT a
validator rule (`validateLocalBinding` enforces uniqueness only WITHIN a module — cross-module collisions
are already source-legal); the gap is purely that the model has no way to NAME a colliding internal local.
Landing the hybrid-module + internal-local capability is the natural next step (see Residual gaps).

## Deliverable 3 — transpiled-CJS interop (cluster 3, the DCE-vs-order epicenter #8675/#8975)

`CjsModuleModel.esModuleMarker?: true` renders the Babel/tsc shape:
`Object.defineProperty(exports,"__esModule",{value:true}); exports.default = <fold>; exports.<named> =
<fold>`. `buildTranspiledCjsInterop` / `generateTranspiledCjsInteropCase` consume it cross-chunk via a
NAMED import (a clean numeric fold) AND a DEFAULT import (`import { default as x }`, folding the whole
exports object). Tags `mechanism:transpiled-cjs-interop` + `variation:interop-{default,named}-import`.

### The legality gate (probed for every consumption × marker combination, on both snapshots)

Rolldown emits `__toESM(require_x(), 1)` — **isNodeMode** — for a real `.mjs` importer. In Node mode
`__toESM` ALWAYS binds `default = mod` (the whole `module.exports`), IGNORING `__esModule`, which mirrors
Node's own native CJS interop EXACTLY. So there is NO legal Node-vs-rolldown divergence for these shapes —
the legal subset is ALL of them, and nothing is validator-excluded:

| consumption                                | marker                     | source (Node)                                 | rolldown (snapshot) | verdict       |
| ------------------------------------------ | -------------------------- | --------------------------------------------- | ------------------- | ------------- |
| `import def`                               | `__esModule`+default+named | `def` = whole exports (object)                | same                | LEGAL / match |
| `import { named }`                         | `__esModule`+default+named | `named` (number)                              | same                | LEGAL / match |
| `import * as ns` (`ns.default`,`ns.named`) | `__esModule`+default+named | `ns.default`=whole exports, `ns.named`=number | same                | LEGAL / match |
| `import def`                               | none, `module.exports = n` | `def` = n                                     | same                | LEGAL / match |
| `import { named }`                         | none, `exports.named`      | number                                        | same                | LEGAL / match |
| `import def` (`def.named`)                 | none, `exports.named`      | `def` = whole exports                         | same                | LEGAL / match |

Consequence: the numeric witness reads NAMED exports (clean number); the DEFAULT binding folds the whole
exports object (a stringy but stable witness that still crashes on a broken interop → NaN reject). The
campaign (`scripts/transpiled-cjs-interop-catch.ts`, esm/cjs × od/wa × dual-target) is GREEN in every cell
— the interop path is exercised and matches Node, watched for a fresh interop red. Evidence
`.agents/evidence/transpiled-cjs-interop.json`.

## Deliverable 4 — RED-1/2/3 upgrade status (per entry)

`normalizeSignature` never unifies the `raw-crash:` and `bundle-only-crash:` prefixes, so every raw→model
upgrade also rewrites the manifest's `expectedRedSignature` prefix (keeping the `[name,message]` tuple).

| id        | issue | status                    | note                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | ----- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **RED-3** | #9993 | **UPGRADED to generator** | `generateOptimizerCycleCase` (runtime-placement) already reproduced the EXACT `__commonJSMin is not a function` (FW-B). Manifest flipped raw→generator, prefix rewritten to `bundle-only-crash:`; raw dir kept as provenance. Bracket HOLDs (red@1.1.4 / green@1.1.5).                                                                                                                                                                     |
| **RED-1** | #9502 | **stays raw** (residual)  | A barrel-split dangling-init generator is expressible, but the wrapped-init name is derived from the rendered file basename — a root module yields `init_module_NNNN`, not the raw fixture's `init_shared` (only a PACKAGED leaf renders `shared.mjs` → `init_shared`). Reproducing the EXACT `init_shared` signature needs the packaged-leaf barrel-split shape; not landed this wave. RED-1 raw bracket HOLDs (red@1.1.1 / green@1.1.2). |
| **RED-2** | #9882 | **stays raw** (residual)  | Needs the hybrid-module + internal-local capability (deliverable 2). RED-2 raw bracket HOLDs (red@1.1.3 / green@1.1.4).                                                                                                                                                                                                                                                                                                                    |

Plus **RED-8 (NEW, bracket-pending)** — the FW-A cjs-output-arm catch (below), generator form.

## Deliverable 5 — campaigns (dual-target npm 1.1.5 + final snapshot)

### cjs-output campaign — `scripts/cjs-output-catch.ts` — a genuine live catch

The wave-8 object-identity double-init witness (and a function-hidden-read variant) built with
`outputFormat: "cjs"`, classified **od/wa × esm/cjs** against both targets. Stable finding (RED-8):

| cell                               | npm-1.1.5                                 | snapshot         |
| ---------------------------------- | ----------------------------------------- | ---------------- |
| object-identity `esm/od`, `esm/wa` | GREEN                                     | GREEN            |
| object-identity `cjs/wa`           | GREEN                                     | GREEN            |
| **object-identity `cjs/od`**       | **RED `init_module_NNNN is not defined`** | **GREEN**        |
| function-hidden (all cells)        | GREEN                                     | GREEN (coverage) |

The witness reds ONLY at cjs-output + on-demand on npm 1.1.5: a wrapped ENTRY's `init_*` is emitted into
the CJS entry chunk WITHOUT its definition. It is a CJS-output-arm bug OPEN on the latest release, fixed
only on the unreleased PR-10104 arc (the RED-0 bracket shape) — structurally invisible under the ESM-output
pin. Registered as **RED-8** (bracket-pending, generator form). Evidence `.agents/evidence/cjs-output.json`.

### interop campaign — `scripts/transpiled-cjs-interop-catch.ts` — GREEN coverage (legality gate)

See deliverable 3. GREEN across esm/cjs × od/wa × both targets; the legal subset is directly comparable.

## Acceptance (all green)

- **golden** regenerated ONCE (`golden: FW-A output-format axis`); `explain-delta` vs the pre-wave golden:
  458 cases, 387 byte-identical, 40 format-only, 26/5 cases that also carry packages/a new op, **0
  unexplained**. The format axis is provably RNG-neutral (force-esm regenerates the pre-wave golden
  byte-for-byte).
- **catching-power** 24.3% (mixed-od 26.3%, mixed-wa 22.3%) — within the committed 21–27% band. The
  format axis is byte-neutral for the fixed catching-power seeds, and cjs cells build green against the
  pr10104 catching-power target, so esm cells are unchanged.
- **`npm run regression:redset`** — all 9 brackets HOLD (RED-0/1/2/5/6/7/9998 + upgraded RED-3 generator +
  new RED-8).
- **6000-case validate+render sweep** (4 regime cells): 0 rejections, 0 render failures;
  `axis:output-format:cjs` density 17.2% (the TLA gate + esm-only fixed templates bring 1/5 to ~17%).
- **seo:false sanity** intact: 300 single-entry cases, 0 isolation false positives, 38 relaxed-order
  divergences correctly ignored.
- **reacceptance** (1800 builds, seo:true 6-cell): every red is a known reason class
  (`bundle-only-crash` / `events-reordered`) — no new divergence class introduced.
- **`vp check` + `vp test`** green (404 tests).

Per-axis densities: `axis:output-format:cjs` 17.2% (random); collision/interop 0% in random (campaign-only,
a deliberate scoping choice to keep the golden delta format-axis-only and avoid the hybrid-module /
interop-detection complexity in random cases).

## Residual gaps (next: transplant wave and minify axis)

- **P9 deconfliction (RED-2 exact)** — needs a HYBRID module kind (ESM `import` + CJS `exports.*` in one
  module) + an author-named internal-local field (bypassing `freshBinding`) + a clean-unbundled-source
  rendering. The unique-names pin is not a validator rule (cross-module collisions are already legal), so
  the seam is purely model+renderer. This is the deliverable-2 capability; the campaign then plants a
  colliding internal local against a chunk-root binding and witnesses the mis-deconfliction as a numeric
  fold. Landing it makes RED-2 a generator entry.
- **RED-1 exact `init_shared`** — a barrel-split dangling-init generator is expressible; the exact
  file-derived `init_shared` name needs the leaf placed in a package (`node_modules/<pkg>/shared.mjs`), the
  one avenue to a named wrapped-init. The numbered `init_module_NNNN` form is expressible today.
- **minify axis** (gap-audit Wave 12) — the value/event channel is minify-invariant; the seam is an
  error-message normalizer (mangled identifiers → `<id>`) so error identity survives, sharing the CJS
  output path FW-A lands.
- **iife/umd** stay out (single-entry, no code-split differential).
- The cjs-output-arm bug RED-8 is a LIVE bug open on npm 1.1.5 — a transplant/upstream-report candidate.
