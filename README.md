# rolldown-order-fuzzer

This repository is being rebuilt from scratch as a strongly typed TypeScript fuzzer for Rolldown execution-order correctness.

The old implementation was intentionally removed. Its useful behavior is preserved as project context in [.agents/docs/legacy-fuzzer-behavior.md](.agents/docs/legacy-fuzzer-behavior.md).

## Commands

```sh
npm install
npm run check
npm run start
```

`npm run start` runs TypeScript directly through Node's native type stripping. `npm run check` is the separate type-checking gate.

## Context

Read [AGENTS.md](AGENTS.md) first. Durable project context lives under [.agents/docs/](.agents/docs/).
