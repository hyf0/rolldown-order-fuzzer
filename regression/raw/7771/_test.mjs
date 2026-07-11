import assert from 'node:assert';
const m = await import('./dist/main.js');
// On the RED build, awaiting the dynamic import of the merged `imp` chunk rejects with a
// SyntaxError (the chunk exports an undefined `imp_exports`); on the GREEN build both resolve.
assert.strictEqual(await m.impVal, 1);
assert.strictEqual(await m.imp2Val, 2);
console.log('TEST_OK');
