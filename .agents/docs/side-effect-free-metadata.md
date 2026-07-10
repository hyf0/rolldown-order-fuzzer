# `sideEffects: false` package metadata

> **W14b migration note:** the module-level `sideEffectFree` flag this record introduced is now the
> LEGACY representation. The package/layout model ([w14b-package-realism](./w14b-package-realism.md))
> owns `sideEffects` metadata — boolean AND the array (partial) form — on named `node_modules`
> packages; `packagesOf` (model.ts) normalizes a legacy flag to a single-member
> `sideEffects: false` package, and the shared `side-effect-free/` rendering directory described
> below is gone. The ORACLE-SOUNDNESS invariant in this record (a metadata-pure module contributes
> only values and emits no events) is unchanged and now binds exactly the members the resolved
> packages assert pure — under the array form, the UNMATCHED members.

`sideEffects: false` in a `package.json` is a user assertion that importing a module runs no side
effects. The bundler consumes it to justify aggressive dead-code elimination (drop the module, or
its initializer, when only some of its bindings are used); Node ignores it entirely. It is the
single biggest historical trigger for DCE fighting `strictExecutionOrder` — rolldown #9961
(`checkGlobals is not defined`), #10123 (`createSelectorCreator is not defined`), #8777, and
relatives. This variation renders some modules under the flag so the differential oracle exercises
that interaction. Builds on [value-carrying-events.md](./value-carrying-events.md).

## The oracle-soundness trap (do not break this)

The bundler is _entitled_ to drop a flagged module's side effects. So if a flagged module emitted an
`__orderEvent`, the bundle could legally drop it while the source (Node, which ignores the flag)
still emits it — a **false differential failure** that has nothing to do with a bug.

The fix is an invariant, not a special case: **a flagged module contributes ONLY values and emits NO
events.** It reads dependency values through the wave-1 read machinery and exports a folded value
that downstream modules read into _their_ events. Both sides then observe the same surface (the
folded numbers downstream), and the bundler's legal DCE cannot change it:

- If the value is used, the bundler must keep the module's value code (and initialize its upstream in
  order), so source and bundle compute the same number.
- If the value is unused, the bundler may drop the module — but it emits no events and (for the
  generated leaf case) has no upstream, so dropping it changes nothing observable.

Any divergence that remains is a real bug: a dropped-but-referenced binding (crash), over-aggressive
DCE removing needed value code, or a wrong/reordered initialization changing a folded number.

`validate-model.ts` enforces the invariant on the RESOLVED metadata-pure members
(`metadataPureModuleIds` over the `packagesOf` view — the legacy flag and the package form share one
rule): a metadata-pure member that **emits events**, is **not ESM**, or carries any dependency
**other than a value-only ESM dependency** is invalid. The value-only set is the imports AND
re-exports that only matter when the pure module's value is used — `esm-value-import`,
`esm-namespace-import`, and the `esm-reexport-named` / `esm-reexport-star` / `esm-local-reexport`
forms (this widened from the original `esm-value-import`-only rule when barrels joined the model). A
side-effect import, dynamic-import registration, or interop require would be droppable under the
metadata yet could drop or reorder another module's events, so those stay excluded.

## Empirical basis

Verified against the local rolldown before wiring the generator: a subdir `package.json` with
`"sideEffects": false` is honored (no `node_modules` needed) — a flagged module's `globalThis.__x =
…` side-effect statement is **dropped** from the output while its used value export and its upstream
module's side effects are **kept**. That both confirms the layout and _is_ the reason flagged
modules must not emit events.

## Rendering (HISTORICAL — the shared directory is deleted)

**This section describes the pre-W14b rendering, kept for provenance.** The single shared
`side-effect-free/` directory (one `side-effect-free/package.json` = `{"sideEffects": false}`, with
flagged modules under it) is **gone**. Under the package/layout model
([w14b-package-realism](./w14b-package-realism.md)) a flagged module resolves through `packagesOf` to
a single-member `sef-<id>` package and renders under `node_modules/sef-<id>/<id>.<ext>` with its own
generated `package.json`; the specifier and layout rules are the package model's. Root modules still
have no `package.json`, and `.mjs`/`.cjs` files still ignore `package.json`, so the source tree
executes identically under Node.

## Generation vs. the handwritten test

The generator flags a minority of **leaf** value-contributing ESM modules (no dependencies, read by
someone, not an entry). A leaf has no upstream side effects, so it is **unconditionally sound**
however the bundler drops it — this is the airtight choice, dense enough (~20% of random-mixed cases
at size 8) to matter. Its events are stripped, so it exports the constant `0`; the bug it catches is
the dropped-but-referenced binding (#9961's core symptom), not a value difference.

The richer **transitive** #9961 shape — a flagged module that itself reads upstream, whose folded
value flows through to a downstream event — is covered by a handwritten test (`render.test.ts` /
`rolldown-adapter.test.ts`), not generated: its soundness needs the folded value to reach a _kept_
event so the bundler cannot drop the flagged module (and its upstream side effects), which the random
generator cannot guarantee locally. The model still supports it, and validation accepts it.

## Shrinking

`shrink.ts` **canonicalizes** a legacy `sideEffectFree`-flag program onto the `packages`
representation ONCE at shrink entry (`canonicalizeLegacyMetadata`), so there is a SINGLE metadata
mutation path. The metadata then shrinks through the package candidates — dropping a package
(members return to root paths), weakening `sideEffects` to `true` (withdraw the purity assertion), or
dropping a member/array-entry — each keeping the failure kind only when the metadata is not
load-bearing, which also reveals whether it is. (The old standalone `sideEffectFree`-flag unflag
candidate is gone with the flag's second representation.)
