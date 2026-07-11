// Regression bracket RED-7 — rolldown #9164 (chunk-optimizer runtime-placement cycle;
// "pick dominator for runtime placement to avoid cycles"). Cluster 1.1 (the optimizer must not
// create an inter-chunk import cycle). RED on rolldown@1.0.0-rc.17
// (`TypeError: __exportAll is not a function` — the runtime helper `__exportAll` is placed into the
// node1 chunk, and entry-2 statically imports it back, closing an entry-2 <-> node1 cycle; when
// entry-0 loads, node1's top-level `__exportAll(...)` runs before the defining chunk, so the helper
// is still undefined) -> GREEN on rolldown@1.0.0-rc.18 (fix #9164), where the helper is placed in
// the dominator chunk (entry-2.js) that every consumer already reaches via forward static edges.
//
// BRACKET NOTE: the fix-history-mining doc listed this bracket as rc.15 -> rc.16, but the #9164 fix
// commit (5a5f8f5d7, 2026-04-26) is not contained in any release before v1.0.0-rc.18; rc.15/16/17 all
// predate it. Verified empirically: rc.17 RED / rc.18 GREEN. The corrected bracket is rc.17 -> rc.18.
//
// Provenance: the fix's own fuzz-minimized regression fixture (crates/rolldown/tests/rolldown/issues/
// 8920_2), translated to the rolldown JS API. The upstream fixture used `expectExecuted:false` with
// static chunk-structure assertions; here _test.mjs instead imports the built entry-0 and asserts a
// concrete value, converting the structural cycle into a genuine runtime witness. The unused
// `external:["external-0"]` from the upstream config is dropped (no module references it; externals
// are outside the fuzzer contract). `experimental.chunkOptimization:true` is required — the
// runtime-placement bug only exists on the chunk-optimizer path.
// See research/vite-chunk-execution-order/fix-history-mining.md section 4 (RED-7).
export default {
  inputOptions: {
    input: { 'entry-0': './node0.js', 'entry-2': './node2.js' },
    treeshake: false,
    preserveEntrySignatures: 'allow-extension',
    experimental: { chunkOptimization: true },
  },
  outputOptions: { format: 'es', dir: 'dist', strictExecutionOrder: false, minifyInternalExports: false },
};
