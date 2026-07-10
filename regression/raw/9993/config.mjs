// Regression bracket RED-3 — rolldown #9993 (chunk-optimizer runtime-placement cycle;
// #9993/#10101, labelled by upstream "a regression of #9224"). Cluster 1.1 (the optimizer must
// not create an inter-chunk import cycle). RED on rolldown@1.1.4
// (`TypeError: __commonJSMin is not a function` — a CJS entry requires an ESM leaf outside the
// manual group, so the runtime helper is placed into a sibling chunk that is statically imported
// back, forming a cross-chunk cycle) -> GREEN on rolldown@1.1.5 (fix #9993).
//
// Provenance: the fix's own minimal regression fixture, translated to the rolldown JS API by the
// fix-history mining spot-verification (`scratchpad/fix-mining/spot-verify/fix-9993`). Kept RAW
// because the shape needs CJS entries writing `exports.*`, a manual `codeSplitting.groups` with a
// `test` regex, and `includeDependenciesRecursively: false` around a specific import topology —
// not expressible as a fuzzer ProgramModel that reproduces the exact `__commonJSMin` signature
// without new generator capabilities (out of scope this wave).
//
// DEVIATION from the spot-verify fixture: `preserveEntrySignatures: 'allow-extension'` is placed
// in `inputOptions` (its home in current rolldown) instead of `outputOptions`. In outputOptions
// current rolldown warns it is an invalid key and ignores it (the value is implicitly
// allow-extension, which `includeDependenciesRecursively: false` requires). Moving it keeps the
// standing set clean and future-proof; verified to reproduce the identical RED-on-1.1.4 /
// GREEN-on-1.1.5 bracket both ways.
// See research/vite-chunk-execution-order/fix-history-mining.md section 4 (RED-3).
export default {
  inputOptions: {
    input: { 'entry-1': './node4.cjs', 'entry-2': './node3.cjs' },
    preserveEntrySignatures: 'allow-extension',
  },
  outputOptions: { format: 'es', dir: 'dist',
    codeSplitting: { includeDependenciesRecursively: false, groups: [{ name: 'v', test: 'node[0-4]' }] } },
};
