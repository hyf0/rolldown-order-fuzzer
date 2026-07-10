# Schedule-phase marker events

Wave 5 (part A) closes a real oracle hole. The verdict compares one flat event sequence over the
whole schedule run, so it cannot tell WHICH schedule step a module event ran in. That let a whole
family of premature-execution bugs escape:

```
source:  [step 1: A][step 2: B]      flat -> A, B
bundle:  [step 1: A, B][step 2: - ]  flat -> A, B
```

Both flatten to `A, B` and were judged EQUAL — yet the bundle ran module B a full schedule step
early, exactly the mis-ordering this fuzzer hunts. Builds on
[value-carrying-events](./value-carrying-events.md) and [redesign-principles](./redesign-principles.md).

## The fix: runner-emitted markers, not generator changes

The fix lives at the EXECUTOR level, not the generator. After each schedule operation SETTLES (an
entry import/require returned, a dynamic trigger awaited), the child runner appends a marker event
into the same event stream:

```jsonc
{ "version": 1, "marker": "schedule", "schedule": <opIndex>, "kind": "entry" | "dynamic" }
```

Interleaving a marker at every step boundary makes the flat stream PHASE-AWARE: a module event that
ran in the wrong step now lands on the wrong side of a marker, so the ordinary event comparison (and
the failure signature) catches it. The escape above becomes:

```
source:  A, @schedule(0), B, @schedule(1)
bundle:  A, B, @schedule(0), @schedule(1)   ->  events-reordered
```

No generator change and no new false-positive surface, because markers are RUNNER-emitted and
symmetric by construction.

## Why it is sound (zero false-positive surface)

The SAME child runner (`child-runner.ts`) emits markers for both the source run and the bundle run.
The bundle's operation list is the source's schedule with only `require-entry` rewritten to
`import-entry` (the adapter emits all-ESM entries), and that difference is normalized away by the
marker `kind`: both entry-evaluation kinds collapse to `"entry"`, a dynamic trigger is `"dynamic"`
(`scheduleMarkerKind` in `protocol.ts`). So for a given schedule the two runs emit byte-identical
markers at identical indices — the ONLY thing that can differ between the two streams is which MODULE
events fall in which step. That is the property we want to test, and nothing else.

Markers are emitted only after an operation settles successfully; if an operation throws, the marker
after it is not appended (the run is already a crash the oracle classifies by error identity first).

## Where it lives (round-trips through artifacts and signatures)

- `protocol.ts` — `ExecutionEvent` is now a union of `ModuleExecutionEvent` (`[module, phase, value]`)
  and `ScheduleMarkerEvent` (`{marker, schedule, kind}`); `isScheduleMarker`, `scheduleMarkerKind`,
  `makeScheduleMarker`. `parseExecutionEvent` round-trips both shapes, so markers survive
  serialization into `source-outcome.json` / `bundle-outcome.json`. `EXECUTION_PROTOCOL_VERSION`
  stays 1 (the event schema is additive; the artifact schema bump to 14 guards artifacts).
- `child-runner.ts` — `executeSchedule` takes an `emitScheduleMarker` callback and calls it after
  each settled operation.
- `verdict.ts` — `serializeEvent` renders a marker as `["@schedule", <index>, <kind>]`, so markers
  read clearly in every failure signature and participate in the equality / subsequence / multiset /
  LCS-diff comparisons unchanged.

The unit test in `verdict.test.ts` ("catches a premature execution that a flat event stream judged
equal") hand-builds two outcome streams that are flat-equal as module events but phase-different, and
asserts the verdict is a mismatch (and that stripping the markers makes it pass again — proving the
hole the markers close).

## Empirical note

rolldown 1.1.4 mis-orders the multi-edge facade shape (see [multi-edge-pairs](./multi-edge-pairs.md))
in a way the markers catch as `events-reordered` — the bundle ran a second entry before the first
entry's step marker — confirming the markers detect real premature execution, not just synthetic
cases.
