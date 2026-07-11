import assert from 'node:assert';
const entry1 = await import('./dist/entry1.js');
assert.strictEqual(entry1.result, 'SvgIcon-Arrow');
console.log('TEST_OK');
