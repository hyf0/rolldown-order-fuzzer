# Value-carrying events

The oracle already compares the `value` of every `[module, phase, value]` event and thrown-error
identity, but for a long time the renderer never read an imported binding: events were static
constants and exports were constant strings. That made an entire class of data-flow bugs invisible
(wrong export value, dropped-but-referenced initializer, interop default/named mixups — rolldown
#9961, #8777, #8675 and relatives). Value-carrying events activate that dormant value oracle by
making generated modules read their dependencies' values and fold them into what they emit and
export. See [redesign-principles.md](./redesign-principles.md) and
[execution-order-fuzzer-mvp.md](./execution-order-fuzzer-mvp.md).

## What the model expresses

- `EventRecord.reads?: ValueRead[]` — a folded event emits `value + read0 + read1 + …`. When reads
  are present, `value` must be a finite number (the fold base), so the payload stays numeric.
- `CjsRequireOperation.resultBinding?` / `readName?` — a readable require renders
  `const resultBinding = require("./target")` and reads `resultBinding.readName`. The two fields
  travel together; `readName` also demands that export on the target.
- `ValueRead` — `{ binding, member? }`. `member` is absent for an ESM value-import binding (read
  directly) and is the `readName` for a CJS readable require. `readableBindingsOf(dependencies)` is
  the shared model fact used by the generator, renderer, and validator so they never disagree.
- Exports stay implicit (synthesized from demand) but carry a **state-derived** value:
  `moduleStateBase(module) + Σ readable bindings`, where the base is the module's first finite
  numeric event value (or 0). So a demanded export folds the values the module imported, and an
  upstream drop/reorder/wrong-value propagates through the chain instead of vanishing.

## Invariants that must hold (do not break these)

- **Reads are forward-only and never close a cycle.** A readable binding always targets a module
  evaluated strictly before the reader, so a read never hits TDZ and never reads a partially
  evaluated cyclic module. The generator enforces this structurally: value imports and readable
  requires are only ever added on forward DAG edges; the single edge into a cycle ring's head is
  created with `allowRead = false`, so no readable binding ever targets a ring member. Rings keep
  side-effect/require edges only. The renderer cannot see cycle structure, so this must stay a
  generator + model guarantee (validation does not re-derive cycles), matching the pre-existing
  "value-import cycles are never generated" exclusion.
- **Folds stay finite and exact.** Bases are small (`< 2^20`); reads sum values that are themselves
  bounded folds over an acyclic graph of ≤ ~16 modules, so totals stay far below `2^53` — integer
  addition is exact and, since `minify:false` keeps `a + b + c` intact, source and bundle compute
  bitwise-identical numbers. A correct build matches; a mis-compile diverges (a different number, or
  an `undefined` read that yields non-finite → the runtime rejects it → a bundle-only crash).
- **Determinism.** Every generator choice goes through `SeededRng`; export bases are a pure function
  of the model baked into the rendered literal (no `Date`/`Math.random`).

## Coverage

`variation:value-read` fires when any module emits an event with non-empty `reads`. It is dense on
`random-mixed` (roughly 40–45% of a mixed campaign's cases, ~89% of random-mixed cases at size 8),
so most random cases exercise the value oracle.

## Shrinking

`shrink.ts` adds a candidate that drops a single read from an event (removing the `reads` key when
it empties). Dropping a read always yields a valid model on its own, which lets a later pass drop
the now-unread dependency. All other candidates remain validated-and-skipped-if-invalid.
