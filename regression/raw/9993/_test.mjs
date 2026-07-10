import assert from 'node:assert';
const entry2 = await import('./dist/entry-2.js');
assert.strictEqual(entry2.default.node_3, 3);
const entry1 = await import('./dist/entry-1.js');
assert.strictEqual(entry1.default.node_4, 4);
console.log('TEST_OK');
