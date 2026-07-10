# Renderer dependency order (pinned, correction deferred)

The renderer emits one statement per dependency, but the ORDER is currently **by category**, not by
dependency-array position:

- **CJS** (`renderModule`): all `require(...)` statements first, then all dynamic-import registrations.
- **ESM**: all static imports first, then all `export … from` re-exports, then all dynamic-import
  registrations.

This contradicts the long-standing renderer comment that dependencies render "in array order". The
comment was corrected (see `render.ts` `renderModule`) to describe the actual category grouping.

## Why it does not currently matter

Generated barrels are re-export-only, and no generated module both imports a module AND re-exports in a
way that makes the requested-module evaluation order observable across the category boundary. So for the
CURRENT corpus, category order and array order coincide, and the differential oracle is unaffected.

## Why it must be corrected in the next interop wave

The MODEL permits a normal module that also re-exports (`import { x } from "./a"; export { y } from
"./b"`). For such a module, requested-module evaluation order follows source position, but the category
grouping would emit all imports before all re-exports regardless of their interleaving — silently
changing the order Rolldown sees. A wave that generates mixed import/re-export modules must first replace
the category grouping with a single ordered requested-module stream (one ESM static-request stream
spanning imports and `export … from`, one ordered executable CJS dependency stream), and RE-ACCEPT the
corpus (emitted-source equivalence checks plus Rolldown campaigns), because correcting the order changes
emitted source bytes.

## Pinned, not changed (this consolidation wave)

Correcting the order is an **emitted-corpus semantic change** and is out of scope for the consolidation
wave (which preserves the corpus byte-for-byte). The current category order is therefore PINNED by two
tests in `render.test.ts` ("PINS category-ordered dependency emission …") that place a dynamic import
first in the dependency array yet assert the static edge renders first. Those pins make the future
correction a deliberate, reviewed change rather than an accidental drift.

The safe, corpus-preserving part of the review's proposal — extracting the duplicated dynamic-registration
formatter shared by the CJS and ESM branches — can land independently; it does not change emitted bytes.
