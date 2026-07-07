# rolldown-order-fuzzer

This repository is being rebuilt from scratch as a strongly typed TypeScript fuzzer for Rolldown execution-order correctness.

The old implementation was intentionally removed. Its useful behavior is preserved as project context in [.agents/docs/legacy-fuzzer-behavior.md](.agents/docs/legacy-fuzzer-behavior.md).

## Commands

```sh
vp install
vp check
vp exec node src/main.ts
```

`vp exec node src/main.ts` runs TypeScript directly through Node's native type stripping under the Vite+ environment. `vp check` is the validation gate.

## Context

Read [AGENTS.md](AGENTS.md) first. Durable project context lives under [.agents/docs/](.agents/docs/).
