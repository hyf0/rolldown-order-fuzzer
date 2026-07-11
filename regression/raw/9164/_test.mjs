import assert from 'node:assert';
// entry-0 reaches the runtime helper (__exportAll) through node1. On the RED build the helper
// is placed in a chunk imported AFTER node1 runs, so node1's top-level __exportAll(...) call
// throws `TypeError: __exportAll is not a function` before this import resolves.
const entry0 = await import('./dist/entry-0.js');
assert.strictEqual(entry0.node_0.value, 0);
console.log('TEST_OK');
