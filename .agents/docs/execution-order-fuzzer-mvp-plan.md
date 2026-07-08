# Execution-order fuzzer MVP implementation plan

## Deliverable 1: typed model and validation

- Create `src/model.ts` with `ProgramModel`, `ModuleModel`, dependency operations, schedules, manual chunk groups, and event records.
- Create `src/validate-model.ts` with deterministic validation errors.
- Add `tests/model.test.ts` covering valid programs, dangling dependencies, duplicate IDs, invalid entries, and `require(ESM)` with a TLA-marked module.

## Deliverable 2: source renderer

- Create `src/render.ts` that writes only modeled `.mjs` and `.cjs` modules plus a schedule manifest; the child runner installs the shared event and dynamic-import globals outside the generated graph.
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

- Part A: add the version-1 machine-readable `StrictExecutionOrderPlanReady` action in Rolldown.
- Part B: allocate a collision-free session ID from a bounded deterministic process sequence, collect the action through one unique devtools session per build, require new-directory plus source-metadata ownership for requested and legacy IDs, canonicalize schema data and module IDs, store the deterministic action or `null` beside source/bundle outcomes, and clean only the uniquely owned session directory.
- Treat malformed, unsupported-version, and duplicate matching actions as harness errors while allowing older packages with no action.
- Serialize campaigns around the process-wide Rolldown trace environment, enable it once per traced campaign, and provide `--no-order-trace` as an opt-out.
- Keep semantic verdict independent from debug data and report the selected wrap count only as diagnostic output.

## Validation

- Fuzzer: `vp check`, `vp test`, fixed mixed campaign, deterministic seed replay.
- Rolldown: formatting, Clippy with warnings denied, release check, library tests, strict-order invariants, strict-order fixtures, Node/Vite CI.
- Independent architecture and code-quality review before each repository is pushed.
