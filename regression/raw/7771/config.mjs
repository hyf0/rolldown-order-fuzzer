// Regression bracket RED-6 — rolldown #7771 (dynamic entry merged into common chunk with cjs and
// esm wrap kind). Cluster 1.4 (dynamic-entry chunk placement x wrap-kind). RED on
// rolldown@1.0.0-beta.58 (`SyntaxError: Export 'imp_exports' is not defined in module` — the
// dynamically-imported CJS entry `imp` and the ESM module `imp2` are merged into one common chunk
// (the `imp` group) carrying BOTH a cjs wrap (require_imp) and an esm wrap (init_imp2); the merged
// chunk's export list references a symbol `imp_exports` that the cjs-wrapped module never defines,
// so Node throws when the dynamic import resolves that chunk) -> GREEN on rolldown@1.0.0-beta.59
// (fix #7771), where the merged chunk's exports are threaded correctly and the dynamic imports
// resolve to { imp: 1 } / { imp2: 2 }.
//
// BRACKET NOTE: the fix-history-mining doc pessimistically listed this as a "pre-v1.0.0-beta
// (git-bisect a nightly)" bracket, but the #7771 fix landed exactly at the beta.58 -> beta.59
// release boundary and BOTH versions are published on npm. Verified: beta.58 RED / beta.59 GREEN.
//
// Provenance: the fix's own regression fixture (crates/rolldown/tests/rolldown/optimization/
// chunk_merging/dynamic_entry_merged_in_common_chunk2), translated to the rolldown JS API. The
// upstream main.js asserted inside a non-awaited `.then()` (an unhandled rejection, not a test
// failure); here the dynamic-import results are surfaced as exports so _test.mjs can await and
// assert the forwarded values. `advancedChunks` is the beta-era option name (renamed `codeSplitting`
// later); it is still accepted (as a deprecated alias) on current rolldown, so the fixture stays
// GREEN on the build under test.
// See research/vite-chunk-execution-order/fix-history-mining.md section 4 (RED-6).
export default {
  inputOptions: { input: { main: './main.js' } },
  outputOptions: { format: 'es', dir: 'dist', advancedChunks: { groups: [{ name: 'imp', test: 'imp' }] } },
};
