import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  // The regression red-set raw fixtures under `regression/raw/**` are VERBATIM historical rolldown
  // regression repros (the fix's own minimal reproduction, translated to the rolldown JS API). They
  // are deliberately kept out of the formatter and linter so they stay byte-faithful to what
  // reproduced each issue signature and a future `vp check --fix` never silently rewrites them. See
  // `.agents/docs/regression-red-set.md`.
  fmt: { ignorePatterns: ["regression/raw/**"] },
  lint: {
    ignorePatterns: ["regression/raw/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
