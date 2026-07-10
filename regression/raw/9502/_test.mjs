import assert from 'node:assert';
const { slot } = await import('./dist/tu.js');
assert.equal(slot(), Object.assign);
console.log('TEST_OK');
