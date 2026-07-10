import assert from 'node:assert';
// The spot-verify fixture only imported the built entry (a crash-only witness). We additionally
// assert the deconflicted value, so a FUTURE regression that binds `kind` to a wrong-but-defined
// value (instead of re-crashing) is also caught on the green side. On the RED build the import throws
// at module init BEFORE this assertion runs, so the red signature is unchanged.
const main = await import('./dist/main.js');
assert.strictEqual(main.default.kind, 'event_match');
console.log('TEST_OK');
