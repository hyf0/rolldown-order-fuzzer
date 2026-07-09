# Namespace imports and re-export (barrel) chains

Wave 3 adds the two dominant real-world interop shapes the value oracle was still blind to:
namespace imports (`import * as ns`) with member reads, and re-export / barrel chains
(`export { x } from`, `export * from`, `export { default as x } from`). Both fold observed values
through the existing [value-carrying-events](./value-carrying-events.md) machinery, so a wrong,
dropped, or reordered initialization several hops from its definer becomes a changed number or a
bundle-only crash instead of staying invisible. Motivating issues: #8675, #4780, #8710, #9320
(namespaces); #8777, #8989, #9299, #4459 (barrels).

## What the model expresses

- `EsmNamespaceImportOperation` — `import * as localName from target`, plus `readMembers`: the
  export names read as `localName.member`. Each member is a `ValueRead { binding: localName, member }`
  (via `readableBindingsOf`), folded into events and state-derived exports, and demands that export on
  the target. Namespace member reads are forward-only like any value read.
- `EsmReexportNamedOperation` — `export { sourceName as exportedName } from target`. Covers
  `export { x } from` (`sourceName === exportedName`) and `export { default as X } from`
  (`sourceName === "default"`, the #9299 shape). Binds nothing locally — a barrel forwards, it does
  not read — so it contributes no readable value.
- `EsmReexportStarOperation` — `export * from target`. Re-exports every named export (never
  `default`).

`render.ts` `collectRequestedExports` is now a demand fixpoint: a value/namespace/require read demands
its name on the direct target; a named re-export always references (demands) its source; a star
re-export forwards every name demanded on the barrel down to its target until the demand reaches the
defining module, which synthesizes it. `localExportsFor` then splits, per module, the names it
synthesizes locally (a state-derived fold) from the names a re-export forwards, so a pure barrel emits
only `export … from` statements and a definer emits only local exports.

## Invariants (do not break)

- **Forward-only, acyclic.** Barrels are inserted as fresh nodes between a reader and its definer
  (reader → barrel(s) → definer), evaluated after the definer and before the reader. The generator
  reroutes only existing forward readable edges, so no read ever closes a cycle and none targets a
  ring member — the same guarantee as wave 1.
- **Ambiguity is unrepresentable.** Every definer's export name is unique to it (`v<id>`), so a
  star-export chain can never forward two modules' identically-named exports into one ambiguous
  export. The validator keeps duplicate module-local bindings and invalid identifiers out; it does
  not resolve star conflicts because generation never creates them.
- **Barrels are pure ESM re-exporters.** A generated barrel is ESM, emits no events, carries only
  re-export dependencies, and forwards only to ESM definers — the whole re-export chain stays ESM.
- **Flagged barrels stay within the no-events / value-only contract.** `validate-model.ts` now lets a
  `sideEffects: false` module carry value-only ESM edges (value/namespace imports and re-exports),
  not just value imports, so the classic #8777 shape — a flagged barrel re-exporting a value — is
  expressible. Whole-chain soundness (the definer is value-only, so the flag can never drop an
  observed event) is the generator's / handwritten test's responsibility, exactly as with flagged
  leaves in [side-effect-free-metadata](./side-effect-free-metadata.md). The generator never flags a
  barrel (only dependency-free leaves are eligible); the flagged-barrel shape is covered by a
  handwritten `rolldown-adapter.test.ts` case with a value-only definer.

## CJS-target namespaces: deferred (probe outcome)

Before enabling CJS-target namespace imports in the generator, one case was hand-probed source vs
bundle in Node. Result: a **numeric member read** (`ns.foo`, the fuzzer's actual mechanism)
round-trips cleanly, but **enumerating the namespace** legitimately differs — Node's
`import * as ns from "./x.cjs"` namespace carries a `module.exports` key (and orders keys) that
Rolldown's interop namespace omits (`Object.keys(ns)` → `bar,default,foo,module.exports` in Node vs
`bar,default,foo` in the bundle). That is a real semantic difference, not a bug, and exactly the
false-positive surface the #8675 family warns about.

Decision: **generator ESM-only for namespaces.** The model still allows any target format, and the
sound numeric-member-read of a CJS target is covered by a handwritten `rolldown-adapter.test.ts`
round-trip. Relying on "we only ever fold numeric members" holding forever across every CJS export
shape (default+named combos, reassigned `module.exports`, `__proto__`) is the kind of latent
false-positive the oracle-soundness discipline avoids, so the generator steps around the whole area.

## Coverage

`variation:namespace-read` (a module has a namespace import), `variation:barrel-reexport` (any
re-export), `variation:reexport-star`, and `variation:reexport-default`. On `random-mixed` at size 8
these run roughly: namespace-read ~30%, barrel-reexport ~15%, reexport-star ~8%, reexport-default ~6%.

## Shrinking

`shrink.ts` adds two candidates: drop a read member from a namespace import (removing its event reads
so a later pass can drop the import), and drop a barrel hop by rewiring a read that targets a pure
single-re-export barrel directly to the barrel's target (adjusting the imported name; a named
re-export maps to its source, a star forwards the same name), which lets the intermediate barrel be
dropped. Both are validated and kept only if the failure kind is preserved.
