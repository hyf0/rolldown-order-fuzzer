const rp = process.env.ROLLDOWN;
const { rolldown } = await import(rp);
const { inputOptions, outputOptions } = (await import('./config.mjs')).default;
const bundle = await rolldown(inputOptions);
await bundle.write(outputOptions);
await bundle.close?.();
console.log('BUILD_OK');
