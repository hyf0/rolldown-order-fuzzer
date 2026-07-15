# Entries-aware manual code splitting and manufactured chunk cycles

## The missing combination

The fuzzer already generated exact manual chunk groups and other acyclic-source/cyclic-output shapes,
but the ordinary strict random corpus never combined exact manual splitting with `entriesAware`. A
10,000-seed size-12 baseline contained 5,041 random-mixed cases, including 909 exact-manual cases and
2,236 organic cases, but zero ordinary `entriesAware` cases.

The execution-order failure reported in rolldown#10259 shows why the combination matters. Its source
graph is a DAG with several entries. One exact manual group selects entry-private app modules but leaves
an app-private side-effect dependency outside. `entriesAwareMergeThreshold` merges the small per-entry
app subgroups into one common chunk. That common chunk imports an entry chunk for the private dependency,
while the entry chunk imports the common chunk for its app, producing a cyclic output chunk graph from
an acyclic source graph.

The model now allows `entriesAware` and `entriesAwareMergeThreshold` directly on `ManualChunkGroup`.
Membership remains an exact list of stable model ids. The adapter resolves those ids to absolute paths
when it reconstructs Rolldown's group predicate, so module renumbering during shrinking cannot silently
move the selector to another module.

## Deterministic proof shape

`buildEntriesAwareChunkCycle` creates this graph:

```text
personal -> app-personal -> leaf
admin    -> app-admin
theming  -> app-theming
```

Every module has observable top-level work. One exact group selects only the three `app-*` modules and
sets `entriesAware:true` plus `entriesAwareMergeThreshold:102400`; the global
`includeDependenciesRecursively` setting is false. The schedule loads admin first, then theming, then
personal.

The released strict wrapper form enters the common app chunk through admin, follows the chunk-cycle edge
into personal, and calls back into `app-personal` before its `var init_* = ...` assignment. It throws
`init_module_0001 is not a function`. Declaration-form wrappers are callable during module
instantiation, so the same emitted chunk cycle executes correctly.

`scripts/entries-aware-cycle-catch.ts` inspects actual output `moduleIds` and static chunk imports and
then runs the program. Its four cells keep strict execution order enabled and vary only the target and
wrapping policy:

- released Rolldown + on-demand wrapping: chunk cycle present, init-function crash;
- released Rolldown + wrap-all: chunk cycle present, init-function crash;
- declaration-form implementation + on-demand wrapping: chunk cycle present, pass;
- declaration-form implementation + wrap-all: chunk cycle present, pass.

## Random combination factor

The random factor runs after every source-affecting choice and after the output-format and minify rolls.
It only applies to ESM output with strict execution order enabled. It requires:

- at least two effectful ESM entries;
- an acyclic synchronous source graph;
- two distinct, effectful ESM app modules, each directly and exclusively reached by a different entry;
- an effectful, entry-private ESM side-effect dependency from one selected app.

When eligible, it replaces the previous chunk config with one exact manual group containing
the two app ids, enables `entriesAware` with the 102400 merge threshold, and sets the global
`includeDependenciesRecursively` value to false. Replacing the previous groups matters: another group
could capture the private dependency and remove the return edge. The app's edges to the private target
must all be side-effect imports: a value, namespace, or dynamic edge to that same target causes Rolldown
to keep the dependency in a separate shared chunk, which also removes the return edge.

In the deterministic 10,000-seed size-12 window the factor appears in 105 of 5,041 random-mixed cases
(2.1%). Directly inspecting all 105 with released Rolldown found an emitted chunk cycle in 93. The nine
cases that additionally satisfy the stable-return-edge predicate all emit a cycle.

Two tags keep configuration and structure separate:

- `variation:entries-aware-group` means the persisted config contains `entriesAware:true`;
- `mechanism:merged-entry-group-init-cycle` means an exact manual group carries the acyclic-source,
  private-app recipe under strict ESM output and global `includeDependenciesRecursively:false`, with a
  private side-effect leaf that has no dependencies, has no other importer, and is the app's only
  synchronous dependency.

The structural tag intentionally survives an ablation that removes the two entries-aware fields. A
plain exact group can manufacture the same init cycle; the variation tag records what configuration was
used, while the structural tag records why the case is relevant. Actual output-cycle presence remains a
chunk-inspection fact.

## Shrinking and corpus discipline

The shrinker can remove `entriesAware` and `entriesAwareMergeThreshold` independently from exact manual
and organic groups. Exact `moduleIds` shrink with the model, so the group never relies on renderer index
names.

The failure artifact schema is version 20. Both new manual-group fields are optional, so old artifacts
retain their previous behavior. The golden-delta checker recognizes only the reserved single exact group
with two ids, `entriesAware:true`, and the 102400 threshold as this end-stage factor. It permits that
factor to replace the previous chunk config and force global `includeDependenciesRecursively:false`, but
continues to reject source-byte changes or unrelated build-axis drift.

Against the previous 458-case golden manifest, 454 cases are byte-identical and four change only by
this recognized bundle configuration; the causal delta check reports zero unexplained changes.
