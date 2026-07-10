# Multiple dependency kinds per importer/target pair

Wave 5 (part B) lets one `(importer, target)` pair carry MORE THAN ONE dependency kind — the most
common real-world shape that a single edge per pair could not express. Real code constantly does
`import { a } from "./x"` AND `import("./x")` (a static and a lazy import of one module), or a
side-effect import plus a value import, or `require` + `import()`. Builds on
[value-carrying-events](./value-carrying-events.md) and [node-legal-cycles](./node-legal-cycles.md).

## What is now expressible

Per pair, the real combinations:

- ESM importer: `{side-effect + value}`, `{value + dynamic}`, `{side-effect + dynamic}`,
  `{value + side-effect + dynamic}`.
- CJS importer: `{require + dynamic}`.

The model already held `dependencies` as an array, so nothing in `model.ts` changed structurally;
the constraint that limited a pair to one edge lived only in the generator (`usedEdges`) and is now
relaxed.

## Rules (validate-model.ts)

`dependencyPairSlot` gives each dependency a per-pair "slot" and the validator rejects a second edge
in the same slot, while permitting distinct kinds to coexist:

- at most one **side-effect** import per pair (`import "./t"` twice is identical — degenerate);
- at most one **dynamic** import per pair (one `__orderDynamicImports` registration per pair);
- **value**, **namespace**, **readable-require**, and **re-export** edges MAY repeat for one pair —
  two named imports from a module (`import { a } from "./t"; import { b } from "./t"`) are common,
  sound code (the #8675 shape), each binding a distinct local name already checked for collisions, and
  a barrel forwards several names from one target.

NOTE / deviation from the literal wave-5 brief: the brief said "at most one static value import per
pair (one local binding)". Enforcing that would reject the two-named-imports shape above, which the
`#8675-like` handwritten test relies on and which real code writes constantly, so value imports are
left repeatable. The generator's augmentation still adds at most one value edge per augmented pair, so
the practical effect matches the brief's intent (mixed pairs use DISTINCT kinds), while the model
stays able to express two named imports. Value edges still obey the forward-only / TDZ / cycle rules
of `validateCycleValueFlow` (each edge is checked independently), and the dynamic edge of a mixed pair
still registers through the standard `__orderDynamicImports` mechanism.

## Generation (generate.ts)

`augmentMultiEdgePairs` runs after barrel insertion (so an augmented value edge is never rerouted
through a barrel). It is FORWARD-ONLY: it computes synchronous reachability and augments a pair only
when the target does not reach back to the importer, so an added value read is forward (fully
evaluated target, no TDZ) and an added side-effect edge never closes a cycle. For each eligible pair
it adds a random non-empty subset of the still-free per-format slots, with distinctly prefixed
binding / registration names (`me_`, `mr_`, `dynm-`) that never collide with a primary edge. Barrels
are never touched, as importer or target. Coverage tag `variation:multi-edge-pair` fires when any
module reaches one target through more than one dependency. On `random-mixed` at size 8 it lands in
roughly half of cases, and the static-plus-dynamic surface (a dynamic import of an
already-statically-loaded module) is dense within those.

## The key order surface

The valuable shape is a dynamic import of an ALREADY-STATICALLY-LOADED module: the static edge loads
the target when the importer evaluates, then the schedule triggers the dynamic import, which must find
the target cached and NOT re-run it (and its rewritten chunk reference must not fire foreign
triggers). This interacts with the entry-facade machinery in `rolldown-adapter.ts`, especially when
the target also sits in a manual chunk group with an entry. The handwritten test
"builds a static+dynamic multi-edge target grouped with its entry (facade-sensitive shape)" in
`rolldown-adapter.test.ts` locks expressibility, rendering (multiple statements for one specifier in
deterministic array order), the adapter's facade mapping, and source soundness (the target evaluates
exactly once). It does NOT assert the execution verdict kind: rolldown 1.1.4 mis-orders this shape
(`init_module_XXXX is not defined`, or a marker-caught reorder), so a fixed rolldown is required for a
passing differential — that is the campaign's job, not a unit test's.

## Rendering (render.ts)

No dedup by specifier: dependencies render one statement each in array order, so a multi-kind pair
emits several legal statements for one specifier deterministically. The existing render loop already
did this; only a clarifying note was added.

## Shrinking (shrink.ts)

A candidate collapses a mixed pair by dropping one of its kinds and cleaning up any event read bound
to the removed edge, so the candidate is valid on its own (the generic dependency-drop would leave a
dangling read and be skipped). This lets the shrinker reduce a mixed pair toward a single kind while
the greedy pass keeps whichever kind the failure needs.
