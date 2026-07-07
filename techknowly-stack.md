# Technology stack

This project uses Vite+ for package management, environment execution, formatting, linting, type checking, and git hooks.

Source files run directly with Node's native TypeScript support through Vite+: https://nodejs.org/learn/typescript/run-natively.

Runtime command: `vp exec node src/main.ts`.

Validation command: `vp check`.

Node's native TypeScript support strips erasable TypeScript syntax and then runs the remaining JavaScript. It does not type-check. That means every meaningful workflow must run `vp check` separately.

Use Node v22.18.0 or newer for flagless native TypeScript execution. Prefer current LTS or newer when running long fuzz campaigns.

Keep TypeScript syntax erasable at runtime. Allowed examples include type annotations, interfaces, type aliases, and `import type`. Avoid syntax that requires JavaScript code generation: `enum`, parameter properties, runtime namespaces, decorators, and TypeScript import aliases.

Use ESM. `package.json` must keep `"type": "module"`. Relative imports in `.ts` files must include the `.ts` extension, for example `import { run } from "./run.ts"`.

Do not rely on `tsconfig.json` for runtime behavior. Node ignores `tsconfig.json` while stripping types. `tsconfig.json` exists for editor support and the type-checking portion of `vp check`.

Compiler settings should match Node's behavior: `module: "nodenext"`, `target: "esnext"`, `rewriteRelativeImportExtensions: true`, `erasableSyntaxOnly: true`, and `verbatimModuleSyntax: true`.
