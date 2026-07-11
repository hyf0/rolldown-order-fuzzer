// Vite config wrapper for skeleton extraction (transplant unit 1). Mirrors the real-app study's
// wrapper pattern: load the project's own vite config, then inject the skeleton-extract plugin as a
// `post` plugin. Extraction needs no strict-order / on-demand patching — it dumps whatever graph the
// app's ordinary build produces.
//
//   SKELETON_OUT=<graph.json> SKELETON_APP=<name> \
//   STRICT_ORDER_PROJECT_CONFIG=<vite.config.ts> \
//   node <viteBin> build --config scripts/transplant/extract-wrapper.mjs
//
// The vite used to run the build is the study's shared runtime-env vite by default (override with
// SKELETON_VITE), so every app extracts under one consistent bundler version.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VITE_INDEX =
  process.env.SKELETON_VITE ||
  "/tmp/rolldown-strict-order-study/pr10104-runtime-env/node_modules/vite/dist/node/index.js";
const { defineConfig, loadConfigFromFile, mergeConfig } = await import(VITE_INDEX);

const PLUGIN_PATH = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "extract-plugin.mjs",
);
const { skeletonExtractPlugin } = await import(pathToFileURL(PLUGIN_PATH).href);

function patchConfig(config) {
  config.build ??= {};
  config.build.minify = false; // readable, and avoids a mangling pass we do not need
  config.build.sourcemap = false; // faster; the graph does not need maps
  const outDir = process.env.SKELETON_BUILD_OUT_DIR;
  if (outDir) {
    config.build.outDir = outDir;
    config.build.emptyOutDir = true;
  }
  return config;
}

const forcePlugin = {
  name: "skeleton-force-post",
  enforce: "post",
  config(config) {
    return patchConfig(config);
  },
};

export default defineConfig(async (env) => {
  const projectConfigFile = process.env.STRICT_ORDER_PROJECT_CONFIG;
  const loaded = await loadConfigFromFile(
    env,
    projectConfigFile ? path.resolve(process.cwd(), projectConfigFile) : undefined,
    process.cwd(),
    "info",
  );
  const projectConfig = loaded?.config ?? {};
  return patchConfig(
    mergeConfig(projectConfig, {
      plugins: [forcePlugin, skeletonExtractPlugin()],
    }),
  );
});
