# Execution-order fuzzer MVP implementation plan

## Deliverable 1: typed model and validation

- Create `src/model.ts` with `ProgramModel`, `ModuleModel`, dependency operations, schedules, manual chunk groups, and event records.
- Create `src/validate-model.ts` with deterministic validation errors.
- Add `tests/model.test.ts` covering valid programs, dangling dependencies, duplicate IDs, invalid entries, and `require(ESM)` with a TLA-marked module.

## Deliverable 2: source renderer

- Create `src/render.ts` that writes `.mjs`, `.cjs`, the shared event bootstrap, and a schedule manifest.
- Add `tests/render.test.ts` with ESM static import, CJS require, shared CJS carrier, and deterministic rendering cases.

## Deliverable 3: fresh-process driver and verdict

- Create `src/protocol.ts` for versioned event/outcome JSON.
- Create `src/child-runner.ts` for schedule execution.
- Create `src/execute.ts` for fresh child-process runs and timeout normalization.
- Create `src/verdict.ts` for source validity and exact failure signatures.
- Add driver and verdict tests that verify success, event reorder, bundle-only crash, source crash suppression, and timeout classification.

## Deliverable 4: Rolldown adapter

- Add the `rolldown` development dependency.
- Create `src/rolldown-adapter.ts` with configurable package loading, deterministic output filenames, strict execution order, generated manual chunk groups, output writing, and entry mapping.
- Add an end-to-end test that renders one ESM program, executes source, builds with Rolldown, executes output, and produces a passing verdict.

## Deliverable 5: seeded mixed ESM/CJS generation

- Create `src/rng.ts` and `src/generate.ts`.
- Start from fixed templates for ESM-imports-CJS, multi-carrier CJS, require-of-ESM, overlapping entries, and manual chunk separation.
- Add deterministic seed tests and mechanism coverage tags.
- Update `src/main.ts` into a small CLI supporting seed, case count, Rolldown package specifier, failure directory, and stop/continue behavior.

## Deliverable 6: Rolldown debug integration

- Add a versioned machine-readable strict-order plan/event action in Rolldown.
- Add a fuzzer collector that stores the action beside source/bundle outcomes.
- Keep semantic verdict independent from debug data.

## Validation

- Fuzzer: `vp check`, `vp test`, fixed mixed campaign, deterministic seed replay.
- Rolldown: formatting, Clippy with warnings denied, release check, library tests, strict-order invariants, strict-order fixtures, Node/Vite CI.
- Independent architecture and code-quality review before each repository is pushed.
