# Renderer dependency order (fixed)

The renderer emits ONE statement per dependency in DEPENDENCY-ARRAY ORDER — a single ordered stream, not
the category buckets it briefly used. `renderModule` (`render.ts`) iterates `module.dependencies` once
and pushes one statement per edge:

- **ESM**: one ordered static-request stream spanning `import` and `export … from` re-exports
  (interleaved per model order), with dynamic-import registrations emitted in their array slots too.
- **CJS**: one ordered executable stream of `require(...)` statements and dynamic-import registrations in
  model order.

Top-level await (`await 0;`), events, and synthesized exports follow the dependency stream, in that
order. Because a dynamic-import registration and `await 0;` are plain synchronous body statements
(static imports/re-exports hoist regardless of textual position), their relative order never changes the
observed source-run event order — but the dependency stream itself now matches the model's array order
exactly.

## Why array order is the contract

The model permits a module that BOTH imports a module AND re-exports (`import { x } from "./a"; export {
y } from "./b"`) — the interop / package barrels of the W14 barrel wave (a plain-import-then-source-less
re-export barrel, a mixed local-export + `export *` barrel). For such a module, requested-module
evaluation order follows SOURCE POSITION, in both the Node source run and Rolldown. The renderer must
therefore emit the requests in the model's dependency order so that:

- the emitted source Rolldown sees matches the model the validator reasoned about (which edge closes a
  cycle, which module evaluates first), and
- a future mixed import/re-export module is not silently reordered by a category grouping that emitted
  all imports before all re-exports.

## History (the earlier PIN-ONLY decision, now superseded)

The consolidation wave temporarily grouped dependencies BY CATEGORY (all imports, then all re-exports,
then all dynamics for ESM; all requires, then all dynamics for CJS) and PINNED that order with two
`render.test.ts` tests, because correcting it changes emitted source bytes and was out of scope for a
byte-identity-preserving consolidation. W14a restored the array-order contract as its first commit: the
category buckets and the pin tests are gone, the golden corpus was regenerated (labeled `golden:
renderer array-order reacceptance`), and the corpus was re-accepted against the frozen Rolldown snapshot
(catching-power in band, the family-A red rate unchanged). This is the deferred correction the
consolidation wave's `renderer-dependency-order` note promised the interop wave would make.
