# FW-C — the standing version-bracketed regression red-set

A permanent corpus cell (`regression/`) where each entry is a shape **proven RED on the released
rolldown BEFORE a historical fix and GREEN AT/after it**, run against every future build so anything
that ever broke twice can never silently break a third time. It institutionalizes 举一反三: every
bracketed instance from the fix-history mining becomes a standing guardrail.

Source of the brackets: `research/vite-chunk-execution-order/fix-history-mining.md` section 4 (the
red-set design + the four spot-verified brackets). This cell builds on the
[#9887 live catch](./w14a-structural-foundation.md) and the
[real-app bug families](./real-app-bug-families.md).

## The four brackets

| id        | issue | cluster                                                | red target | green target      | red signature                                                                          |
| --------- | ----- | ------------------------------------------------------ | ---------- | ----------------- | -------------------------------------------------------------------------------------- |
| **RED-0** | #9887 | 1.2 wrapped-ESM init — cross-chunk init **cycle**      | npm 1.1.5  | PR-10104 snapshot | `bundle-only-crash:["TypeError","init_module_0003 is not a function"]`                 |
| **RED-1** | #9502 | 1.2 wrapped-ESM init — **dangling** init across chunks | npm 1.1.1  | npm 1.1.2         | `raw-crash:["ReferenceError","init_shared is not defined"]`                            |
| **RED-2** | #9882 | 1.9 CJS-wrapped-local **deconfliction**                | npm 1.1.3  | npm 1.1.4         | `raw-crash:["TypeError","Cannot read properties of undefined (reading 'EventMatch')"]` |
| **RED-3** | #9993 | 1.1 chunk-optimizer **runtime-placement cycle**        | npm 1.1.4  | npm 1.1.5         | `raw-crash:["TypeError","__commonJSMin is not a function"]`                            |

RED-0's green target is a **local** PR-10104 strict-order snapshot, not an npm version — the bug is
still OPEN on npm 1.1.5, fixed only on that branch (`final-snapshot-42628c18b`). All four are inside
the replication contract (no top-level await, no mixed-format module cycle, no TDZ value cycle, no
externals), and each RED is a genuine RUNTIME witness (the built bundle throws when the entry runs),
not a build-log string match.

## Two entry forms, and why (model fidelity)

The manifest (`regression/index.json`) records each entry as one of two forms. The choice is a model
**fidelity** decision: an entry must reproduce the EXACT historical signature, so we use the lowest
form that still does.

- **`generator`** — the shape is expressed through an existing fuzzer generator function, run through
  the NORMAL `executeProgram` path (render → run source under Node → build with rolldown → run bundle
  → classify verdict). Only **RED-0** takes this form: `buildCrossChunkInitCycle` (`src/generate.ts`)
  already expresses the cross-chunk init-cycle shape as a validator-passing `ProgramModel`, and it
  reds on npm 1.1.5 / greens on the snapshot at `strictExecutionOrder: true`. This is the same shape
  the [#9887 live catch](../../scripts/cross-chunk-init-cycle-catch.ts) campaigns.

- **`raw`** — a verbatim file-based repro under `regression/raw/<issue>/` (the fix's own minimal
  reproduction, translated to the rolldown JS API by the mining spot-verification). The runner copies
  it into an isolated working dir, builds it with the target's rolldown via its own `build.mjs` +
  `config.mjs`, and runs its own `_test.mjs`. **RED-1/2/3** take this form because their shapes need
  capabilities the fuzzer `ProgramModel` deliberately cannot express, and this wave adds NO generator
  capabilities:
  - **RED-1 (#9502)** — a CJS side-effect import of an ESM module + a named re-export barrel split
    into `shared`/`vue` chunks + a namespace import folding a value identity (`Object.assign`).
  - **RED-2 (#9882)** — one module that BOTH `import { … } from` (ESM) AND writes `exports.*`
    (CJS-wrapped), plus a deliberate NAME COLLISION (`var sharedValue` shadowing the dependency's
    chunk-root `sharedValue`). The fuzzer names every binding uniquely (`v<id>`) by construction, so
    the collision is unrepresentable (mining doc P9).
  - **RED-3 (#9993)** — CJS entries writing `exports.*`, a manual `codeSplitting.groups` with a `test`
    regex, and `includeDependenciesRecursively: false` around a specific import topology.

  A fuzzer-model translation would at best rename modules (`init_module_NNNN` instead of `init_shared`)
  and at worst not reproduce at all — losing the exact signature — so the raw form is BOTH more
  faithful and required by the no-new-capabilities constraint. The raw fixtures are kept byte-verbatim
  and are excluded from the formatter/linter (`vite.config.ts` `ignorePatterns`) so a future
  `vp check --fix` never rewrites the repro.

## How to run

```
npm run regression:redset            # all entries
npm run regression:redset RED-2      # a single entry by id
```

NOT part of `vp test` (it needs network to acquire the npm targets and runs out-of-tree rolldown
builds). It exits non-zero on any bracket violation and writes machine-readable evidence to
`.agents/evidence/regression-redset.json`: per-entry verdicts, each target's `dist/index.mjs` sha256,
the node version, and the HEAD hash + dirty status — so the red/green proof is reproducible from a
committed record.

**Target acquisition.** Each npm target is `npm install rolldown@<version>` into an isolated per-version
prefix under `/tmp/order-fuzzer-regression-targets/<version>` (cached by the presence of the entry
file; a second run reuses the install). It is `install`, not a bare `npm pack`, because rolldown ships
its platform-specific native binding as a SEPARATE optional-dependency package (`@rolldown/binding-*`)
that a bare tarball omits — the isolated prefix carries its own `package.json` so the fuzzer
workspace's `overrides` never leak in.

**Environment overrides:**

- `REDSET_TARGET_CACHE` — the npm-target cache root (default `/tmp/order-fuzzer-regression-targets`).
- `REDSET_GREEN_SNAPSHOT` — the RED-0 green snapshot `dist/index.mjs` (default the manifest's
  `greenSnapshot.path`). Set this if the snapshot lives elsewhere on your machine.
- `REDSET_MANIFEST` / `EVIDENCE_OUT` — manifest and evidence paths.

## How to ADD an entry (the discipline)

Every future real-world escape or repeated-fix cluster gets a bracket entry **when its fix lands**:

1. **Bracket it.** Find the released version that is RED (before the fix) and the one that is GREEN
   (at/after), the way the mining doc's spot-verification did. Confirm the RED is a runtime witness.
2. **Pick the form.** If an existing generator already produces a validator-passing `ProgramModel`
   that reproduces the EXACT signature, use `form: "generator"` and register the generator function in
   the `GENERATORS` table in `scripts/regression-redset.ts`. Otherwise (the common case) drop the fix's
   own minimal repro into `regression/raw/<issue>/` as `form: "raw"` — source files + `config.mjs` +
   `build.mjs` + `_test.mjs` + `package.json`, kept verbatim. Do NOT add generator capabilities just to
   avoid a raw entry; a lossy model that changes the signature is worse than a faithful raw repro.
3. **Record it** in `regression/index.json`: `id`, `issue`, `cluster`, `title`, `form`, the red/green
   `TargetRef`s (`{kind:"npm",version}` or `{kind:"snapshot"}` or `{kind:"path",path}`), the
   normalized `expectedRedSignature`, and `provenance` (fix commit + PR + the mining-doc anchor).
4. **Verify** `npm run regression:redset <id>` HOLDs, then commit the entry and the refreshed evidence.

The backlog RED-4…RED-7 (mining doc section 4) are added this way as the implementation wave verifies
each bracket.

## The standing regime

This cell runs on a scheduled cadence and per rolldown build under test, alongside the full fuzzer
matrix. Its guarantee is bidirectional: the GREEN target must keep passing (a fix must never regress),
and the RED-below target must keep reproducing its signature (a bracket that silently goes
green-on-old means the repro has rotted and is flagged, not silently trusted). A deliberately reverted
fix turns the corresponding entry RED — the guardrail firing. This converts each 举一反三 instance into
a permanent, self-checking regression barrier.

## Signature normalization

`normalizeSignature` (`scripts/regression-redset.ts`, unit-tested in
`tests/regression-redset.test.ts`) collapses a Rolldown content-hash chunk-id suffix a crash message
might quote (e.g. `shared-Bx2qtI_L.js` → `shared-<hash>.js`) so a bracket stays comparable across
builds. The four current signatures carry NO hash (a stable `init_shared` / `init_module_0003` /
`__commonJSMin` / a fixed enum name), so normalization is a no-op on them today; it only future-proofs
a hash-bearing message. The manifest stores signatures already in normalized form.
