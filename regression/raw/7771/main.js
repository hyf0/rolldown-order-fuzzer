// #7771 repro: a dynamically-imported CJS entry (imp) and an ESM module (imp2) are both
// merged into one common chunk (the `imp` group), so that chunk carries BOTH a cjs wrap
// (require_imp) and an esm wrap (init_imp2). On the RED build the merged chunk's export list
// references a symbol `imp_exports` that the cjs-wrapped module never defines, so Node throws
// `SyntaxError: Export 'imp_exports' is not defined in module` the moment the dynamic import
// resolves that chunk. The dynamic-import results are surfaced as exports so the test can await
// and assert the forwarded values on the green side.
export const impVal = import('./imp.js').then((m) => m.imp);
export const imp2Val = import('./imp2.js').then((m) => m.imp2);
