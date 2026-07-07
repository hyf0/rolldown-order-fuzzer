# Redesign principles

The new fuzzer should be built as four separable layers: model generation, rendering and execution, verdict classification, and shrinking.

The model layer describes programs, not Rolldown failures. It should make invalid states hard to express and should expose graph-level facts that later layers can use for coverage reporting.

The execution layer should run source and bundle through one driver API. Driver events should be structured values, not human-readable console text.

The verdict layer should separate source validity from bundle correctness. First decide whether the source run is a stable oracle. Then compare bundle behavior against that oracle.

The shrinking layer should use the same verdict and signature logic as the campaign runner. A minimized case that preserves only a broad failure class is not trustworthy enough for issue filing.

Correctness green is not enough for strict execution order work. Over-wrapping can preserve order while failing the size goal. When the fuzzer is used to validate an on-demand wrapping design, it also needs a way to report the set of modules that were wrapped or otherwise forced into init scaffolding.
