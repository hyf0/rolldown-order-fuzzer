// Regression bracket RED-2 — rolldown #9882 (CJS-wrapped-local deconfliction).
// Cluster 1.9 (a wrapper/chunk-root local shadows an author or dependency binding). RED on
// rolldown@1.1.3 (`TypeError: Cannot read properties of undefined (reading 'EventMatch')` — the
// entry's local `var sharedValue = class {}` deconflicts against the dependency's chunk-root
// `sharedValue`, and the mis-renamed read observes `undefined`) -> GREEN on rolldown@1.1.4
// (fix #9882/#9921).
//
// Provenance: the fix's own minimal regression fixture, translated to the rolldown JS API by the
// fix-history mining spot-verification (`scratchpad/fix-mining/spot-verify/fix-9882`). Kept RAW
// because the shape needs a module that BOTH `import { … } from` (ESM) AND writes `exports.*`
// (CJS-wrapped) plus a deliberate NAME COLLISION — the fuzzer names every binding uniquely
// (`v<id>`) by construction, so the collision is unrepresentable without new generator
// capabilities (out of scope this wave).
// See research/vite-chunk-execution-order/fix-history-mining.md section 4 (RED-2).
export default {
  inputOptions: { input: { main: './main.js' } },
  outputOptions: { format: 'es', dir: 'dist' },
};
