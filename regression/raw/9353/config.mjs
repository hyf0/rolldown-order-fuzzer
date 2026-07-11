// Regression bracket RED-5 — rolldown #9353 (initialize wrapped-ESM re-export owners).
// Cluster 1.2 (wrapped-ESM init call emission). RED on rolldown@1.0.1
// (`TypeError: Cannot read properties of undefined (reading 'muiName')` — entry2 CJS-`require`s
// the ESM `createIcon.js`, wrapping it as `init_createIcon`; entry1 reads `createIcon` through the
// `reexport.js` barrel, but the re-export owner's `init_createIcon()` is not emitted before the
// forwarded `createIcon('Arrow')` runs, so `SvgIcon` is still undefined) -> GREEN on rolldown@1.0.2
// (fix #9353), where `init_createIcon()` runs first and the call returns 'SvgIcon-Arrow'.
//
// Provenance: the fix's own minimal regression fixture (crates/rolldown/tests/rolldown/issues/8950),
// translated to the rolldown JS API. entry1's top-level `console.log(createIcon('Arrow'))` was
// changed to `export const result = createIcon('Arrow')` so _test.mjs can assert the concrete
// forwarded value; on the RED build the module-init call throws before the assertion is reached.
// See research/vite-chunk-execution-order/fix-history-mining.md section 4 (RED-5).
export default {
  inputOptions: { input: { entry1: './entry1.js', entry2: './entry2.js' } },
  outputOptions: { format: 'es', dir: 'dist' },
};
