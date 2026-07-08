# Redesign principles

The new fuzzer should be built as four separable layers: model generation, rendering and execution, verdict classification, and shrinking.

The model layer describes programs, not Rolldown failures. It should make invalid states hard to express and should expose graph-level facts that later layers can use for coverage reporting.

The execution layer should run source and bundle through one driver API. Driver events should be structured values, not human-readable console text.

The verdict layer should separate source validity from bundle correctness. First decide whether the source run is a stable oracle. Then compare bundle behavior against that oracle.

The shrinking layer should use the same verdict and signature logic as the campaign runner. A minimized case that preserves only a broad failure class is not trustworthy enough for issue filing.

The fuzzer judges `strictExecutionOrder` through observable source-versus-bundle behavior only. It does not consume Rolldown's internal wrapping, inclusion, or execution-plan state. Output-size and over-wrapping goals belong in separate Rolldown benchmarks and focused tests.
