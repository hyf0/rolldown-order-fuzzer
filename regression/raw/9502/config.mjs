// Regression bracket RED-1 — rolldown #9502 (dangling wrapped-ESM `init_*()` emission).
// Cluster 1.2 (wrapped-ESM init call emission). RED on rolldown@1.1.1
// (`ReferenceError: init_shared is not defined` — the finalizer emits the init call in a
// chunk that does not import it) -> GREEN on rolldown@1.1.2 (fix #9502/#9717).
//
// Provenance: this is the fix's own minimal regression fixture, translated from its
// `_config.json` to the rolldown JS API by the fix-history mining spot-verification
// (`scratchpad/fix-mining/spot-verify/fix-9502`). Kept as a RAW file-based repro because the
// shape (a CJS side-effect import of an ESM module, a named re-export barrel split into
// `shared`/`vue` chunks, a namespace import that folds a value identity) is not expressible in
// the fuzzer ProgramModel without new generator capabilities (out of scope this wave), and a
// lossy translation would lose the exact `init_shared` signature.
// See research/vite-chunk-execution-order/fix-history-mining.md section 4 (RED-1).
export default {
  inputOptions: { input: { tu: './test-utils.js' } },
  outputOptions: { format: 'es', dir: 'dist', codeSplitting: { groups: [
    { name: 'shared', test: 'shared\\.js$' },
    { name: 'vue', test: 'vue\\.js$' },
  ] } },
};
