# Node-legal cycles with value flow

Wave 4 turns the fuzzer's cycle coverage from a single-format side-effect/require RING with one
entering edge into richer, Node-legal cycle shapes that carry VALUE across cycle edges. This is the
dedicated generator for the `init_X is not a function` / `require_X is not a function` bug family —
cross-chunk and CJS init cycles that Rolldown historically mis-ordered (rolldown #3529, #9887, #9946,
#9007, #5277/#5536, #8910/#9401; vite #22341). Builds on [value-carrying-events](./value-carrying-events.md)
and [namespace-and-barrel-reexports](./namespace-and-barrel-reexports.md).

Standing exclusions still hold and are never generated: no top-level await, no mixed-format cycles
(Node's require-of-evaluating-ESM error depends on the runtime entry point), and no plain value read
that closes a cycle (TDZ is not preserved by `strictExecutionOrder`).

## What the model expresses

Two flags make a value read TOTAL across a cycle edge (where the target may still be evaluating when
the read runs). They are the whole mechanism; everything else is topology the generator wires.

- `EsmValueImportOperation.call?: true` — a hoisted-function CALL import. The reader binds a
  `function` export and every read of it is a call (`localName()`); the target synthesizes
  `export function importedName() { return <base> }` instead of a `const`. A function declaration is
  initialized before any other module-body statement, so it is callable even while the defining
  module is mid-evaluation up the cycle stack — the ONLY sound way to fold an ESM value across a cycle
  edge without TDZ. The callable export returns a CONSTANT (the module's base), never folds the
  module's own reads: a callable that called its siblings would mutually recurse around the cycle.
- `CjsRequireOperation.guard?: true` (with `resultBinding` + `readName`) — a guarded partial read,
  rendered `Number.isFinite(r.v) ? r.v : -1`. See the partial-export decision below.
- `ValueRead.call?` / `ValueRead.guard?` — the same flags on the folded read, propagated from the
  dependency by `readableBindingsOf`, so events and value exports render the read identically.

The value oracle still rides on the existing machinery: a callable's return and a guarded read fold
into events and into state-derived value exports (`moduleStateBase + Σ reads`) exactly like any
wave-1 read. In-cycle reads make a mis-ordered init observable (a crash, or a changed number);
post-cycle readers (a module outside every cycle that reads a cycle member's value export on a
forward edge, the member fully evaluated) carry the value that flowed through the cycle downstream.

## The partial-export trap and its handling — DECISION: option (b), the fold guard

A Node CJS cycle legally observes PARTIAL exports: a member required back into a still-evaluating
module sees only the exports assigned so far, and a not-yet-assigned export is `undefined`. This is
deterministic and the differential oracle handles it (source defines truth). BUT the wave-1 fold
would turn `undefined` into NaN, and the event channel rejects a non-finite value (`protocol.ts`
`requireEventValue`) — a crash that fires IDENTICALLY on both sides, a degenerate always-equal case
the oracle must never rely on.

We make mid-cycle CJS reads total with **option (b): an explicit fold guard the model declares**,
`Number.isFinite(EXPR) ? EXPR : -1`, rather than option (a) (only emitting reads the generator can
prove assigned before the reading require runs). Rationale:

- It is self-contained: purely reader-side rendering, needing no fragile generator↔renderer contract
  about the exact order of export assignments relative to the cycle-closing require.
- It is MORE observable: a partial read folds to the sentinel `-1` instead of crashing, so a bundle
  that mis-times an export assignment relative to the cycle diverges as sentinel-vs-value — a visible
  number difference — instead of hiding behind a both-sides crash. The generator is then free to emit
  reads that land in either the assigned or the not-yet-assigned state, covering more of the
  partial-export space, because the guard keeps every one of them total.
- The sentinel only has to be finite (keeping the fold numeric); `-1` is the documented choice.

`validate-model.ts` (`validateCycleValueFlow`) makes unsound models UNREPRESENTABLE. It computes
synchronous (non-dynamic) reachability; an edge `A -> B` closes a cycle exactly when `B` can reach
`A`. On a cycle-closing edge:

- a readable `cjs-require` MUST be `guard: true` (else the partial NaN both-sides-crash);
- an `esm-value-import` MUST be `call: true` AND target ESM (a plain `const` read is TDZ);
- an `esm-namespace-import` is forbidden (any member read risks TDZ).

Forward (non-cycle) edges are unrestricted: a `call`/`guard` there is harmless and a plain read is
sound because the target is fully evaluated. This is a deliberate REVISION of the earlier "validation
does not re-derive cycles" note in value-carrying-events.md: validation now derives cycle edges, but
only to enforce these local totality rules.

## Topologies the generator wires (`buildRandomMixed`)

All single-format, budgeted within `MAX_RANDOM_MODULES`:

- base ring (2–4 members), edges optionally carrying call/guard in-cycle reads;
- a **chord** — one extra non-adjacent intra-ring edge (`mechanism:cycle-chord`);
- **interlocking cycles** — a second cycle sharing the hub, a figure-eight
  (`mechanism:interlocking-cycles`, detected as a cyclic node with internal in-degree ≥2 and
  out-degree ≥2);
- **multiple entering edges** at distinct members from DAG carriers (`mechanism:cycle-multi-enter`);
- the cycle **split across manual chunk groups** (`mechanism:cycle-split-groups`) — a group `test`
  may match a single module, verified accepted by Rolldown, so a 2-member cycle splits one each;
- several cycle members made **entries**, so the schedule enters the cycle at different members;
- **post-cycle readers** (`mechanism:post-cycle-read`).

`insertBarrelChains` never reroutes a `call` import (an in-cycle edge a forward-only barrel would
break). Cycle members are never `sideEffects: false` (they have dependencies, so are ineligible).

## Coverage

`mechanism:cycle-chord`, `mechanism:interlocking-cycles`, `mechanism:cycle-multi-enter`,
`mechanism:cycle-split-groups`, `mechanism:cycle-value-read` (any call/guard read),
`mechanism:post-cycle-read`, `variation:cycle-hoisted-call` (a call read),
`variation:cycle-partial-read` (a guard read). On `random-mixed` at size 8, roughly: cycle ~13%,
cycle-value-read ~11%, cycle-multi-enter ~9%, cycle-split-groups / post-cycle-read / hoisted-call /
partial-read ~5–7% each, interlocking ~4%, chord ~3%.

## Empirical basis

Before wiring the generator, ten representative shapes were hand-probed source-vs-bundle in Node
against the fixed Rolldown (rolldown-pr10104, `fc792209f`) in BOTH wrap modes — ESM hoisted-call
cycle, CJS guarded partial cycle, post-cycle read, #3529-like CJS cross-chunk callable cycle,
#9887-like ESM cross-chunk cycle, multi-member CJS entry, chord, ESM/CJS interlocking figure-eights,
multiple entering edges — all matched. The Node "Accessing non-existent property of module exports
inside circular dependency" warning confirms the CJS partial-export trap is genuinely exercised while
the guard keeps it total and Rolldown-faithful.

## Shrinking

`shrink.ts` adds "drop a redundant synchronous cycle edge": an edge `A -> B` that closes a cycle is
redundant when another out-edge of `A` still reaches back to `A`, so dropping it preserves the
remaining cycle (and its failure) while collapsing a chorded ring toward a bare ring and two
interlocking cycles toward one. Kept only when the failure kind (and crash identity) is preserved.
Dropping a base ring edge is already covered by the generic dependency-drop candidate; it turns a
former cycle edge's call/guard read into a harmless forward read, still valid.
