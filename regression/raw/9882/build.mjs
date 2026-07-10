// Builds this fixture with the rolldown pointed to by $ROLLDOWN (a dist/index.mjs path). The
// regression-redset runner sets $ROLLDOWN to each bracket target and runs this in an isolated
// working copy. Prints BUILD_OK on success; a build error exits non-zero.
const rp = process.env.ROLLDOWN;
const { rolldown } = await import(rp);
const { inputOptions, outputOptions } = (await import('./config.mjs')).default;
const bundle = await rolldown(inputOptions);
await bundle.write(outputOptions);
await bundle.close?.();
console.log('BUILD_OK');
