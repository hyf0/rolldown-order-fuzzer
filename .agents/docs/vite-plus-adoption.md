# Vite+ adoption

The project uses Vite+ as its local tool entry point.

Use `vp install` for dependency installation, `vp check` for validation, and `vp exec node src/main.ts` for running the current TypeScript entry directly through Node's native TypeScript support.

`vp migrate --no-interactive --no-agent` was used on 2026-07-07. `--no-agent` was intentional: this repository already has custom `AGENTS.md` instructions and a `CLAUDE.md` symlink to `AGENTS.md`.

Vite+ installed local tooling through the `vite-plus` package and generated `vite.config.ts` plus `.vite-hooks/`. The pre-commit hook runs `vp staged`.

The repository still intentionally uses erasable TypeScript only. Vite+ manages the command surface, but runtime execution remains native Node TypeScript stripping, not transpilation.
