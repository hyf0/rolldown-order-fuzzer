export type ModuleFormat = "esm" | "cjs";

export type EventValue = string | number | boolean | null;

/// Reads the value carried by a dependency binding in the reading module's scope: an ESM
/// value-import's `localName`, or a CJS require-result binding (then `member` names the exported
/// property read off the required module's exports). Most reads cross forward-only edges (the target
/// is fully evaluated before the reader). The two flags below make a read TOTAL across a cycle edge,
/// where the target may still be evaluating when the read runs, so cycle value flow never hits TDZ
/// and never folds to NaN (see `.agents/docs/node-legal-cycles.md`):
///
/// - `call` — the binding is a hoisted function export, folded as `binding()` (or `binding.member()`).
///   A `function` declaration is initialized before any module-body statement, so calling it is legal
///   even while the defining module is mid-evaluation up the cycle stack — the ONLY sound way to fold
///   an ESM value across a cycle edge (a plain `const` read would hit TDZ). The target synthesizes a
///   callable function export instead of a `const`.
/// - `guard` — the read is wrapped `Number.isFinite(EXPR) ? EXPR : <sentinel>`. A CJS cycle member
///   legally observes a PARTIAL export (a member required back into an evaluating module is `undefined`
///   until assigned); the wave-1 fold would turn that into NaN, which the event channel rejects — a
///   degenerate both-sides crash. The guard turns a partial read into an observable sentinel number,
///   so a mis-timed export assignment diverges visibly instead of crashing identically on both sides.
export interface ValueRead {
  readonly binding: string;
  readonly member?: string;
  readonly call?: true;
  readonly guard?: true;
  /// When `true`, a namespace member read renders as a COMPUTED access `binding[<runtime key>]`
  /// instead of `binding.member`, where the key is a module-level string built at runtime so the
  /// bundler's static analysis cannot see which export is used (the shadcn `ns[k]` consumer shape).
  /// The observed value is identical to the plain member read; only the syntactic visibility differs.
  /// Valid only on a namespace member read (a read with a `member` whose binding is a namespace
  /// import) — see `validate-model.ts`. A statically-invisible use is what family B needs to slip past
  /// on-demand wrapping's per-export liveness (see `.agents/docs/real-app-bug-families.md`).
  readonly computed?: true;
}

export interface EventRecord {
  readonly module: string;
  readonly phase: string;
  readonly value: EventValue;
  /// Optional forward-only dependency reads folded into the emitted payload: the rendered value
  /// becomes `value + read0 + read1 + …`. When present and non-empty, `value` must be a finite
  /// number so the fold stays numeric, and every read must reference one of the module's readable
  /// bindings. Folding a dependency's exported value into an event makes a wrong, dropped, or
  /// reordered upstream initialization observable as a changed number.
  readonly reads?: readonly ValueRead[];
  /// When `true`, the folded reads are rendered INSIDE a local function whose body reads the imported
  /// bindings, and top-level code CALLS that function in the event payload: `value: base + hidden()`
  /// where `function hidden() { return read0 + read1 + … }`. The emitted value is identical to a
  /// plain top-level read (deterministic, synchronous, settles at once), but the read is lexically
  /// hidden inside a function body rather than directly at module top level — the statically-invisible
  /// startup use family B needs (the fuzzer otherwise only emits top-level direct reads, all
  /// statically visible). Valid only on an event that carries a non-empty `reads` (see
  /// `validate-model.ts` and `.agents/docs/real-app-bug-families.md`).
  readonly hiddenReadFn?: true;
  /// An OBJECT-IDENTITY comparison folded into the payload: the value renders `value + ((leftBinding
  /// === rightBinding) ? 0 : <mismatch sentinel>)`, where both bindings are `objectRef` imports of
  /// the SAME object export captured through two different paths (e.g. a direct import and a
  /// barrel-forwarded one). Source ESM evaluates the definer once, so the two captures are the same
  /// object → `+ 0` → the value equals `value`, identical to the bundle on a correct build. If a
  /// bundler ever re-runs the definer, a late capture references a NEW object → `false` → the value
  /// shifts by the sentinel and the differential oracle catches it. This witnesses a SILENT
  /// double-init: a no-events module run twice is invisible to a numeric oracle (numbers are
  /// idempotent), but object identity is not. Mutually exclusive with `reads`/`hiddenReadFn` on one
  /// event, and `value` must be a finite number (see `validate-model.ts`). The legality of preserved
  /// identity across import paths was probed on healthy builds before integrating — see
  /// `.agents/docs/object-identity-and-callable-own-state.md`.
  readonly identityCheck?: {
    readonly leftBinding: string;
    readonly rightBinding: string;
  };
}

export interface EsmSideEffectImportOperation {
  readonly kind: "esm-side-effect-import";
  readonly target: string;
}

export interface EsmValueImportOperation {
  readonly kind: "esm-value-import";
  readonly target: string;
  readonly importedName: string;
  readonly localName: string;
  /// When `true`, the import binds a hoisted FUNCTION export and every read of `localName` is a call
  /// (`localName()`); the target synthesizes `export function importedName() { return <base> }`
  /// instead of a `const`. Because a function declaration is callable before module-body order, this
  /// is the sound way to fold a value across an ESM cycle edge without TDZ. `validate-model.ts`
  /// requires it on a value edge that closes a cycle and requires the target be ESM.
  readonly call?: true;
  /// When `true`, the import binds an OBJECT REFERENCE (from an `objectExport` target, reached
  /// directly or forwarded through a barrel), NOT a folded number. `localName` is never summed into
  /// an event or export (`readableBindingsOf` excludes it, `validate-model.ts` registers it as an
  /// `object` binding a numeric read cannot reference); it is compared for identity in an event's
  /// `identityCheck`. Capturing the SAME object export through two paths and comparing `a === b`
  /// witnesses a silently double-run init: in source ESM the two captures are one object (`true`),
  /// but if a bundler re-runs the definer a late capture is a NEW object (`false`) — a divergence
  /// numbers alone cannot see. See `.agents/docs/object-identity-and-callable-own-state.md`.
  readonly objectRef?: true;
}

/// `import * as <localName> from "..."` — a whole-module namespace binding. Every name in
/// `readMembers` is read as `<localName>.<member>`, folded numerically into events and exports
/// through the same reads machinery as a value import, and demands that export on the target. A
/// namespace member read is forward-only like any value read (the target evaluates before the
/// reader). The generator only ever targets ESM modules: Node's `import * of CJS` namespace shape
/// (it adds a `module.exports` key rolldown's interop omits) legitimately differs from the bundle,
/// so CJS-target namespaces are model-only + a handwritten test — see
/// `.agents/docs/namespace-and-barrel-reexports.md`.
export interface EsmNamespaceImportOperation {
  readonly kind: "esm-namespace-import";
  readonly target: string;
  readonly localName: string;
  readonly readMembers: readonly string[];
  /// The subset of `readMembers` read as CALLS (`localName.member()`), folding the callable export's
  /// RETURN value instead of the binding itself. A call member targets a `callableOwnState` definer's
  /// function export (reached directly or forwarded through a barrel), so the read witnesses the
  /// definer's own-state read through a function call rather than a direct value read — the exact
  /// shape (callable export + own-state read) the shadcn breakage manifested in. Forward-only like any
  /// namespace read (a namespace import may not close a cycle). Must be a subset of `readMembers`;
  /// `validate-model.ts` enforces it. See `.agents/docs/object-identity-and-callable-own-state.md`.
  readonly callMembers?: readonly string[];
}

export interface EsmDynamicImportOperation {
  readonly kind: "esm-dynamic-import";
  readonly target: string;
  readonly registration: string;
}

/// `export { <sourceName> as <exportedName> } from "..."` — a re-export that forwards the target's
/// `sourceName` under `exportedName` without binding it locally. Covers both `export { x } from`
/// (`sourceName === exportedName`) and `export { default as X } from` (`sourceName === "default"`).
/// Barrel modules chain these toward a defining module so a downstream reader's value flows through
/// the barrel; demand for `exportedName` routes to the target's `sourceName`. Forward-only.
export interface EsmReexportNamedOperation {
  readonly kind: "esm-reexport-named";
  readonly target: string;
  readonly sourceName: string;
  readonly exportedName: string;
}

/// `export * from "..."` — re-exports every named export of the target (never `default`). A star
/// barrel forwards a demanded name to its target. Generated export names are unique per defining
/// module, so a star chain never yields an ambiguous duplicate export (the validator keeps this
/// invariant unrepresentable rather than resolving conflicts). Forward-only.
export interface EsmReexportStarOperation {
  readonly kind: "esm-reexport-star";
  readonly target: string;
}

/// `import { <sourceName> as <localName> } from "..."; export { <localName> as <exportedName> };` —
/// a LOCAL re-export (the camunda package-barrel shape, M4): the name is imported into scope as a
/// LIVE binding and re-exported through a SOURCE-LESS export clause, on a module that may ALSO carry
/// its own side effects (events). This is a DIFFERENT rolldown surface from `esm-reexport-named`
/// (`export { s as e } from "..."`, which binds nothing locally): the import record is live, the
/// export references a local binding, and the two statements are decoupled in the module body — the
/// exact shape the camunda breakage manifested in. Demand for `exportedName` on this module routes to
/// the target's `sourceName` (like a named re-export), and the import itself demands `sourceName` as
/// a LIVE numeric consumption (supply- AND shape-checked, strictly stronger than the link-required
/// check a pure re-export gets), so an unsupplied name is rejected at validation, never rendered.
/// `localName` is a readable binding (events may fold it). Forward-only: validate-model.ts rejects a
/// local re-export that closes a cycle (the mid-evaluation read risk is TDZ, like a namespace edge).
export interface EsmLocalReexportOperation {
  readonly kind: "esm-local-reexport";
  readonly target: string;
  readonly sourceName: string;
  readonly localName: string;
  readonly exportedName: string;
}

export interface CjsRequireOperation {
  readonly kind: "cjs-require";
  readonly target: string;
  /// When set, the require is rendered as `const resultBinding = require("./target")` so the
  /// target's exports can be read. `readName` (required whenever `resultBinding` is) names the
  /// target export read through the binding and demands that the target synthesize it.
  readonly resultBinding?: string;
  readonly readName?: string;
  /// When `true`, the read of `resultBinding.readName` is guarded
  /// (`Number.isFinite(...) ? ... : <sentinel>`) so a PARTIAL export observed mid-cycle folds to a
  /// sentinel number instead of NaN. `validate-model.ts` REQUIRES it on a readable require that
  /// closes a cycle (where the target may still be evaluating), so a partial read is never a
  /// degenerate both-sides crash. Harmless (always finite) on a forward edge.
  readonly guard?: true;
}

export type EsmDependencyOperation =
  | EsmSideEffectImportOperation
  | EsmValueImportOperation
  | EsmNamespaceImportOperation
  | EsmDynamicImportOperation
  | EsmReexportNamedOperation
  | EsmReexportStarOperation
  | EsmLocalReexportOperation;

export type DependencyOperation = EsmDependencyOperation | CjsRequireOperation;

/// A module's `dependencies` may hold MORE THAN ONE edge to the same target — the multi-kind pairs
/// real code constantly writes: `import { a } from "./x"` AND `import("./x")` (static + lazy), a
/// side-effect plus a value import of one module, or `require` + `import()`. `validate-model.ts`
/// permits distinct kinds per (importer, target) pair, rejecting only a second side-effect import or
/// a second dynamic registration for one pair (both degenerate); value, namespace, readable-require,
/// and re-export edges may repeat, so `import { a } from "./x"; import { b } from "./x"` and a barrel
/// forwarding several names stay expressible. Value edges still obey the forward-only / TDZ / cycle
/// rules. See `.agents/docs/multi-edge-pairs.md`.

interface ModuleModelBase {
  readonly id: string;
  readonly events: readonly EventRecord[];
  /// LEGACY (schema ≤17): the module-level form of `sideEffects: false` package metadata, which the
  /// package/layout model (W14b, schema 18) SUPERSEDES. `packagesOf` is the one normalization seam:
  /// a flagged module resolves to a single-member `sideEffects: false` package, so every consumer
  /// (renderer layout, the metadata-purity contract, tags, shrink) reads the SAME package view for
  /// old and new models alike. The generator no longer sets this flag — it persists `packages`
  /// directly — and a program carrying BOTH forms is rejected at validation. The semantic contract
  /// (the bundler may legally drop the member, so it must contribute ONLY values and emit NO events)
  /// lives with the package model; see `PackageModel` and `metadataPureModuleIds`.
  readonly sideEffectFree?: true;
  /// When `true`, the module is an INFERRED-pure definer: its top level is only statements the
  /// bundler's side-effect analysis judges pure by INFERENCE (local function declarations, a
  /// `const` assigned from a `/* @__PURE__ */`-annotated call of a local function, exports of those
  /// bindings) — NO events. This is a DIFFERENT mechanism from `sideEffectFree`: there is no
  /// `package.json` `"sideEffects": false` flag; the bundler infers purity from the statements
  /// themselves. The exported value is a NON-INLINABLE runtime binding (a plain `const = <literal>`
  /// would be constant-folded and inlined, masking a dropped init), so a downstream reader that
  /// observes a dropped init sees `undefined` → a NaN fold or a TypeError. Like `sideEffectFree`, an
  /// inferred-pure module must be ESM, emit no events, and carry only value-only ESM dependencies
  /// (a side-effect import would make its top level impure). The two flags are mutually exclusive.
  /// A re-export barrel that STAR-forwards an inferred-pure definer, shared by importers that split
  /// their reads across the barrel's exports, is the family-A conjunction — see
  /// `.agents/docs/real-app-bug-families.md`.
  readonly inferredPure?: true;
  /// The numeric base an inferred-pure definer's synthesized value folds onto (`base + reads`),
  /// returned by its `/* @__PURE__ */`-annotated local build function. Required when `inferredPure`
  /// is set (a finite number); ignored otherwise. A distinct nonzero base per definer keeps folded
  /// values meaningful and un-foldable to a shared literal.
  readonly pureBase?: number;
  /// When `true`, the module is a "callable reads own state" definer — the real d3-scale
  /// `unit`/`rescale` shape and the exact construct the shadcn breakage manifested in. It declares a
  /// module-scope MUTABLE state variable assigned during init from a non-inlinable
  /// `/* @__PURE__ */`-annotated build call (`let __ownState = /* @__PURE__ */ __ownStateBuild()`),
  /// and renders every export it synthesizes LOCALLY as a FUNCTION that READS that state
  /// (`export function name() { return __ownState + <k> }`), not a constant. A consumer imports the
  /// function and CALLS it (a `call` value import or a namespace `callMembers` read), folding the
  /// returned value; the call witnesses "the module's init assigned __ownState before my call ran". A
  /// dropped init leaves __ownState `undefined`, so the call folds to NaN (the event channel rejects
  /// it → a bundle-only crash) — the read-side ingredient wave 7 named for isolating on-demand-only
  /// bugs (the existing `call` import returns a CONSTANT, never its module's own init-assigned state).
  /// The state base is `pureBase` when also `inferredPure`, else the module's first event value. May
  /// be combined with `inferredPure` (the whole module is then only pure statements — a `let` from a
  /// pure call plus a function declaration — so the bundler infers it side-effect-free and drops it
  /// when unused) OR left event-carrying (a real side-effecting module). ESM only; the callable reads
  /// ONLY its own state (never its dependencies), so it never recurses around a cycle. Mutually
  /// exclusive with `objectExport`. See `.agents/docs/object-identity-and-callable-own-state.md`.
  readonly callableOwnState?: true;
  /// When `true`, the module is an OBJECT-EXPORT definer: it synthesizes each demanded export as a
  /// fresh object literal (`export const name = { v: <base> }`) rather than a folded number, and emits
  /// NO events. It is the invisible double-init target of the object-identity witness — a no-events
  /// module whose init running twice is undetectable by a numeric oracle but detectable by object
  /// identity (two evaluations produce two distinct objects). Consumers capture it through `objectRef`
  /// imports and compare identity in an event's `identityCheck`. ESM only, no events; mutually
  /// exclusive with `inferredPure`, `sideEffectFree`, and `callableOwnState` (each has a different
  /// export rendering). See `.agents/docs/object-identity-and-callable-own-state.md`.
  readonly objectExport?: true;
}

export interface EsmModuleModel extends ModuleModelBase {
  readonly format: "esm";
  readonly dependencies: readonly EsmDependencyOperation[];
  readonly hasTopLevelAwait?: true;
  /// Export names this module DECLARES locally — synthesized state-derived exports that coexist with
  /// a star re-export (the vben `index.js` shape: an own helper next to `export * from "./facade"`).
  /// Without this field a star suppresses ALL local synthesis (`localExportsFor` renders nothing
  /// local), so a barrel could never carry an own included statement — the family-B conjunction's
  /// "one own helper the entry uses keeps the barrel included" ingredient. A declared name is a LOCAL
  /// definer for routing (ES semantics: a local export shadows `export *`, so demand for it never
  /// forwards through the star), rendered by the same synthesized-export templates as any local
  /// export. Optional and additive: models without it behave exactly as before.
  readonly localExports?: readonly string[];
}

/// CJS modules require synchronously and may also register dynamic imports — `import()` is
/// legal inside CommonJS in Node.
export interface CjsModuleModel extends ModuleModelBase {
  readonly format: "cjs";
  readonly dependencies: readonly (CjsRequireOperation | EsmDynamicImportOperation)[];
  readonly hasTopLevelAwait?: never;
}

export type ModuleModel = EsmModuleModel | CjsModuleModel;

/// The two INDEPENDENT behavioral axes a module's correlated boolean flags encode, as one
/// discriminated `ModuleProfile` shared by generation, validation, rendering, tags, and shrinking
/// instead of each re-deriving the combination.
///
/// - purity: `normal` (nothing dropped) or `inferred` (side-effect-free by STATEMENT inference,
///   carrying the fold base). METADATA purity (`sideEffects` package metadata) is deliberately NOT a
///   per-module profile axis any more: it is a PACKAGE-level fact the W14b package model owns, read
///   through `metadataPureModuleIds` over the one `packagesOf` view (the legacy `sideEffectFree`
///   flag normalizes there) — keeping it here too would be a second live representation.
/// - exportShape: `numeric-fold` (folded numbers), `callable-own-state` (state-reading function
///   exports), or `fresh-object` (a fresh object literal per export — the double-init witness).
export type ModulePurity =
  | { readonly kind: "normal" }
  | { readonly kind: "inferred"; readonly base: number };

export type ModuleExportShape =
  | { readonly kind: "numeric-fold" }
  | { readonly kind: "callable-own-state" }
  | { readonly kind: "fresh-object" };

export interface ModuleProfile {
  readonly purity: ModulePurity;
  readonly exportShape: ModuleExportShape;
}

/// Project a module's flags onto the canonical `ModuleProfile`. The legal combinations and precedence
/// (the flags are mutually exclusive where they conflict, enforced by the validator) live HERE, once.
/// The legacy `sideEffectFree` flag is NOT consulted: metadata purity is a package-level fact
/// resolved through `packagesOf`/`metadataPureModuleIds`, never a per-module profile axis.
export function moduleProfile(module: ModuleModel): ModuleProfile {
  const purity: ModulePurity =
    module.inferredPure === true
      ? { kind: "inferred", base: module.pureBase ?? 0 }
      : { kind: "normal" };
  const exportShape: ModuleExportShape =
    module.objectExport === true
      ? { kind: "fresh-object" }
      : module.callableOwnState === true
        ? { kind: "callable-own-state" }
        : { kind: "numeric-fold" };
  return { purity, exportShape };
}

/// A named package a subset of modules belongs to (W14b, schema 18). Members render under a
/// fixture-local `node_modules/<name>/` directory carrying a generated `package.json` with `name`,
/// `main` (the FIRST member's file — the package index a bare `import … from "<name>"` resolves to),
/// and `sideEffects`; cross-package imports use bare specifiers. `sideEffects` is the tree-shaking
/// metadata axis:
///
/// - `false` — every member is METADATA-PURE: the bundler may legally drop a member or its
///   initializer, so each member must satisfy the value-only/no-events contract (see
///   `validate-model.ts`), exactly like the historical module-level `sideEffectFree` flag.
/// - `string[]` — PARTIAL metadata (the vben / family-B ingredient): a member whose rendered file
///   name matches an entry is side-effectFUL (events allowed); an UNMATCHED member is metadata-pure
///   and must satisfy the contract. Patterns are restricted to a literal-plus-`*` subset so the
///   fuzzer's matcher cannot diverge from rolldown's glob semantics (both match with or without a
///   leading `./`, verified against the frozen snapshot).
/// - `true` — no purity assertion (every member effectful); the field is still written, so the
///   package exercises the resolution/layout surface without a tree-shaking claim.
///
/// This model MIGRATES the module-level `sideEffectFree` representation: `packagesOf` is the ONE
/// legacy-normalization seam (a legacy flag becomes a single-member `sideEffects: false` package),
/// so there is never a second live representation — a program carrying BOTH `packages` and a flagged
/// module is rejected at validation.
export interface PackageModel {
  readonly name: string;
  readonly sideEffects: boolean | readonly string[];
  /// Member module ids; the FIRST is the package main (the bare-specifier target).
  readonly moduleIds: readonly string[];
}

export interface EntryModel {
  readonly name: string;
  readonly moduleId: string;
}

export interface ImportEntryScheduleOperation {
  readonly kind: "import-entry";
  readonly entry: string;
}

export interface RequireEntryScheduleOperation {
  readonly kind: "require-entry";
  readonly entry: string;
}

export interface TriggerDynamicImportScheduleOperation {
  readonly kind: "trigger-dynamic-import";
  readonly registration: string;
}

export type ScheduleOperation =
  | ImportEntryScheduleOperation
  | RequireEntryScheduleOperation
  | TriggerDynamicImportScheduleOperation;

export interface ManualChunkGroup {
  readonly name: string;
  readonly moduleIds: readonly string[];
}

/// A size/share-driven code-splitting group whose composition ROLLDOWN decides — the organic
/// chunk shape real Vite apps produce, as opposed to the exact module lists of a `ManualChunkGroup`.
/// It maps directly onto rolldown's `CodeSplittingGroup` (the `output.codeSplitting.groups` option):
/// a `minShareCount` captures modules referenced by at least that many entry chunks (vendor-style
/// merges / high-in-degree shared chunks), a `maxSize` splits an accumulated group by byte size, an
/// absent/broad `test` lets a single group host many modules (intra-chunk statement placement), and
/// `priority` lets groups compete for modules. `test`, when present, is a regular-expression SOURCE
/// matched against a module's resolved file path (the child reconstructs `new RegExp(test)`); absent
/// means every module matches. Chunking is bundle-side only, so it never changes source-run
/// semantics and the differential oracle stays valid. See
/// `.agents/docs/organic-chunking-and-scale.md`.
export interface OrganicChunkGroupConfig {
  readonly name: string;
  /// Regular-expression source matched against a module's resolved file path. Absent = match all.
  readonly test?: string;
  readonly minSize?: number;
  readonly maxSize?: number;
  /// Capture a module only when at least this many entry chunks reference it (rolldown default 1).
  readonly minShareCount?: number;
  readonly priority?: number;
  readonly includeDependenciesRecursively?: boolean;
}

/// A program carries at most ONE chunking config (`Chunking`), plus the other bundle-side build axes,
/// in a single persisted `BuildConfig` (`build`). Legacy (schema-16) programs instead carry the two
/// optional top-level chunk-group arrays and no `build`; `buildConfigOf` reconciles both shapes so an
/// old artifact still replays. The two legacy group fields are mutually exclusive (`validate-model.ts`
/// enforces it). `deriveCoverageTags` reads the resolved config to emit `chunking:default|explicit|organic`
/// plus the per-axis tags.
export interface ProgramModel {
  readonly modules: readonly ModuleModel[];
  readonly entries: readonly EntryModel[];
  readonly schedule: readonly ScheduleOperation[];
  /// The named packages (W14b, schema 18) — the SINGLE live representation of package/layout
  /// metadata. Absent on a legacy (schema ≤17) model, where `packagesOf` derives single-member
  /// `sideEffects: false` packages from any module-level `sideEffectFree` flags.
  readonly packages?: readonly PackageModel[];
  /// The single persisted bundle-side build configuration (W14a, schema 17). Present on every
  /// generator-produced program; absent on a legacy (schema-16) model, where `buildConfigOf` derives it
  /// from the legacy top-level arrays + defaults.
  readonly build?: BuildConfig;
  /// LEGACY (schema-16) chunking fields. A generator-produced schema-17 program carries `build.chunking`
  /// instead; these remain only so an old persisted artifact (v16) still parses and replays.
  readonly manualChunkGroups?: readonly ManualChunkGroup[];
  readonly organicChunkGroups?: readonly OrganicChunkGroupConfig[];
}

/// The three mutually-exclusive chunking modes as ONE discriminated union, so tags, artifact identity,
/// adapter options, and shrinking share a single matcher instead of each re-deriving the mode from two
/// optional arrays (where an EMPTY array leaks as a fourth, ambiguous state). `build.chunking` carries it
/// directly on a schema-17 program; `programChunking` normalizes it (an empty groups array is automatic).
export type Chunking =
  | { readonly kind: "automatic" }
  | { readonly kind: "manual"; readonly groups: readonly ManualChunkGroup[] }
  | { readonly kind: "organic"; readonly groups: readonly OrganicChunkGroupConfig[] };

/// `InputOptions.preserveEntrySignatures` — the fuzzer only produces `"allow-extension"` (the historical
/// hardcoded value, now moved into the persisted `BuildConfig`); the other values are here only so the
/// build child's request type accepts what a future axis might roll.
export type PreserveEntrySignatures = false | "strict" | "allow-extension" | "exports-only";

/// The ONE persisted bundle-side build configuration a case builds with — consumed by the adapter/build
/// child, the evaluator, replay/shrink, the artifact identity, the corpus manifest, and the coverage
/// tags. All of these bundle-side; NONE changes the source run, so the differential oracle stays valid.
///
/// - `chunking` — the code-splitting mode (moved in from the top-level arrays).
/// - `includeDependenciesRecursively` — the GLOBAL `codeSplitting.includeDependenciesRecursively`
///   fallback (rolldown default `true`); the W14a axis the generator rolls. `false` is a necessary
///   ingredient of the #9887 cross-chunk init-cycle catch.
/// - `preserveEntrySignatures` — the `InputOptions.preserveEntrySignatures` value (moved in from the
///   hardcoded `"allow-extension"`; not rolled).
/// - `lazyBarrel` — `experimental.lazyBarrel`, rolldown's barrel-pruning optimization (default `false`);
///   the W14-9 axis the generator rolls (smoke-verified honored by the frozen snapshot under strict order).
/// - `strictExecutionOrder` — `OutputOptions.strictExecutionOrder` (default `true`; NOT rolled in W14a —
///   every case keeps `true`, because a `seo:false` cell needs a weaker order oracle that lands in W14c).
export interface BuildConfig {
  readonly chunking: Chunking;
  readonly includeDependenciesRecursively: boolean;
  readonly preserveEntrySignatures: PreserveEntrySignatures;
  readonly lazyBarrel: boolean;
  readonly strictExecutionOrder: boolean;
}

/// The build config a program with no persisted `build` (a legacy v16 artifact) resolves to, minus its
/// chunking (which `buildConfigOf` derives from the legacy arrays): rolldown/fuzzer defaults.
export const DEFAULT_BUILD_CONFIG: BuildConfig = Object.freeze({
  chunking: { kind: "automatic" } as const,
  includeDependenciesRecursively: true,
  preserveEntrySignatures: "allow-extension",
  lazyBarrel: false,
  strictExecutionOrder: true,
});

/// The resolved `BuildConfig` of a program: its persisted `build` if present (schema 17), else derived
/// from the legacy top-level chunk arrays + defaults (schema 16). This is the ONE place the two persisted
/// shapes reconcile, so every consumer reads the config the same way whatever the artifact vintage.
///
/// v16 replay rule for `includeDependenciesRecursively` (W14a.1): a legacy MANUAL-group artifact
/// resolves its global IDR to `false`, NOT the rolldown default `true` in `DEFAULT_BUILD_CONFIG`. Such an
/// artifact was built when the build child hardcoded `includeDependenciesRecursively: false` on every
/// manual group (the per-group value that shadowed the global). W14a.1 removed that hardcode so the
/// persisted global is the SINGLE source of the effective IDR; this default preserves the OLD effective
/// build for artifacts predating the persisted axis. Automatic/organic legacy configs keep the rolldown
/// default `true` (the hardcode never applied to them — automatic carries no groups, organic set the
/// global per-group only when the roll asked).
export function buildConfigOf(program: ProgramModel): BuildConfig {
  if (program.build !== undefined) {
    return program.build;
  }
  const chunking = legacyChunking(program);
  return {
    ...DEFAULT_BUILD_CONFIG,
    chunking,
    includeDependenciesRecursively:
      chunking.kind === "manual" ? false : DEFAULT_BUILD_CONFIG.includeDependenciesRecursively,
  };
}

/// Derive a legacy (schema-16) program's chunking from its top-level arrays. Organic groups win over
/// manual (mirroring the build child's precedence), and an EMPTY array is automatic (the empty-array
/// identity fix). A program with both arrays is rejected by the validator, so precedence only
/// disambiguates the empty cases.
function legacyChunking(program: ProgramModel): Chunking {
  if (program.organicChunkGroups !== undefined && program.organicChunkGroups.length > 0) {
    return { kind: "organic", groups: program.organicChunkGroups };
  }
  if (program.manualChunkGroups !== undefined && program.manualChunkGroups.length > 0) {
    return { kind: "manual", groups: program.manualChunkGroups };
  }
  return { kind: "automatic" };
}

/// The canonical chunking mode of a program, from its resolved `BuildConfig`. An EMPTY manual/organic
/// groups array normalizes to `automatic` — the durable fix for the artifact identity that recorded
/// `{ groups: [] }` while the build ran automatic chunking, now guarding `build.chunking` too so an empty
/// union never leaks as a distinct mode.
export function programChunking(program: ProgramModel): Chunking {
  const chunking = buildConfigOf(program).chunking;
  if (chunking.kind === "manual" && chunking.groups.length === 0) {
    return { kind: "automatic" };
  }
  if (chunking.kind === "organic" && chunking.groups.length === 0) {
    return { kind: "automatic" };
  }
  return chunking;
}

/// The resolved packages of a program — the ONE legacy-normalization seam through which every
/// consumer (renderer layout, validator contract, tags, shrink) reads the package/layout
/// representation, following the `buildConfigOf` fallback pattern. Persisted `packages` (schema 18)
/// win; a LEGACY (schema ≤17) model instead normalizes each module-level `sideEffectFree` flag to a
/// single-member `sideEffects: false` package named `sef-<id>` — semantically identical metadata
/// (the bundler may drop the member; the value-only contract holds), so an old artifact still
/// validates and replays, though its rendered layout moves from the shared `side-effect-free/`
/// directory to per-package `node_modules/`. The generator emits the SAME `sef-<id>` shape for the
/// modules it flags, so a legacy artifact and its regenerated equivalent render identically. A
/// program carrying BOTH forms is rejected at validation, so there is never a second live
/// representation.
export function packagesOf(program: ProgramModel): readonly PackageModel[] {
  if (program.packages !== undefined) {
    return program.packages;
  }
  return program.modules.flatMap((module) =>
    module.sideEffectFree === true ? [legacySideEffectFreePackage(module.id)] : [],
  );
}

/// The single-member `sideEffects: false` package a module-level `sideEffectFree` flag normalizes to
/// — shared by the legacy seam above and the generator's flagger, so both forms are ONE shape. The
/// name lowercases the id (generated ids are already lowercase; a pathological handwritten collision
/// surfaces as a duplicate-name validation error, never a silent merge).
export function legacySideEffectFreePackage(moduleId: string): PackageModel {
  return {
    name: `sef-${moduleId.toLowerCase()}`,
    sideEffects: false,
    moduleIds: [moduleId],
  };
}

/// One module's package membership: the package it belongs to and whether it is the package MAIN
/// (the first member — the file `package.json#main` points at, which a bare `import "<name>"`
/// resolves to).
export interface PackageMembership {
  readonly package: PackageModel;
  readonly isMain: boolean;
}

/// Per-module package membership, from the ONE resolved packages view. A module is a member of at
/// most one package (validated); non-members are absent from the map.
export function packageMembershipOf(program: ProgramModel): ReadonlyMap<string, PackageMembership> {
  const membership = new Map<string, PackageMembership>();
  for (const pkg of packagesOf(program)) {
    for (const [index, moduleId] of pkg.moduleIds.entries()) {
      if (!membership.has(moduleId)) {
        membership.set(moduleId, { package: pkg, isMain: index === 0 });
      }
    }
  }
  return membership;
}

/// The rendered file name of a PACKAGE MEMBER: `<id>.<mjs|cjs>` under `node_modules/<name>/`. Named
/// by the STABLE module id — not the program-order index root modules use — so a shrink step that
/// drops modules never renumbers package files, and a `sideEffects` array entry (which names these
/// files) keeps matching across shrinks. Root (non-member) modules keep the historical
/// `module-NNNN.<ext>` index naming, so a package-free program renders byte-identically.
export function packageMemberFileName(module: ModuleModel): string {
  return `${module.id}.${module.format === "esm" ? "mjs" : "cjs"}`;
}

/// Whether a `sideEffects` array PATTERN matches a package member's rendered file name. Semantics
/// pinned against the frozen snapshot: an entry matches with or without a leading `./`, and `*`
/// wildcards within the name match any run of characters (rolldown, like webpack, matches the
/// package-relative path — our package files are flat, so the relative path IS the file name).
/// Patterns are validated to a literal-plus-`*` subset (`validate-model.ts`), so this matcher cannot
/// silently diverge from rolldown's glob engine on syntax the model can never carry.
export function sideEffectsPatternMatches(pattern: string, fileName: string): boolean {
  const normalized = pattern.startsWith("./") ? pattern.slice(2) : pattern;
  const regexSource = `^${normalized
    .split("*")
    .map((literal) => literal.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")}$`;
  return new RegExp(regexSource).test(fileName);
}

/// The module ids the resolved packages assert METADATA-PURE — the modules whose value-only/no-events
/// contract the validator enforces and whose initializer the bundler may LEGALLY drop:
/// `sideEffects: false` marks every member; an ARRAY marks exactly the members whose rendered file
/// name no entry matches (the vben partial form — a matched member keeps its side effects); `true`
/// marks none. This is the package-model successor of the module-level `sideEffectFree` flag.
export function metadataPureModuleIds(program: ProgramModel): ReadonlySet<string> {
  const pure = new Set<string>();
  const modulesById = new Map(program.modules.map((module) => [module.id, module]));
  for (const pkg of packagesOf(program)) {
    if (pkg.sideEffects === true) {
      continue;
    }
    for (const moduleId of pkg.moduleIds) {
      const module = modulesById.get(moduleId);
      if (module === undefined) {
        continue;
      }
      if (pkg.sideEffects === false) {
        pure.add(moduleId);
        continue;
      }
      const fileName = packageMemberFileName(module);
      if (!pkg.sideEffects.some((pattern) => sideEffectsPatternMatches(pattern, fileName))) {
        pure.add(moduleId);
      }
    }
  }
  return pure;
}

/// The forward-only dependency values a module can read in its own scope, in dependency order: an
/// ESM value-import contributes its `localName`; an ESM namespace-import contributes one read per
/// `readMembers` entry (`localName.member`); a CJS readable require contributes its `resultBinding`
/// plus the `readName` member read off the required module's exports; an ESM LOCAL re-export
/// contributes its `localName` (the binding is genuinely imported into scope, unlike a source-form
/// re-export). Pure re-export dependencies (`export … from`) bind nothing locally and contribute no
/// readable value (a barrel forwards, it does not read). This is a pure model fact shared by the
/// generator (choosing event reads), the renderer (folding exports), and validation.
export function readableBindingsOf(
  dependencies: readonly DependencyOperation[],
): readonly ValueRead[] {
  const reads: ValueRead[] = [];
  for (const dependency of dependencies) {
    if (dependency.kind === "esm-local-reexport") {
      reads.push({ binding: dependency.localName });
    } else if (dependency.kind === "esm-value-import") {
      // An objectRef import binds an object reference, never a folded number: it is compared for
      // identity, not summed, so it contributes no numeric readable binding.
      if (dependency.objectRef === true) {
        continue;
      }
      // A call import binds a hoisted function; every read of it is a call (`localName()`).
      reads.push(
        dependency.call === true
          ? { binding: dependency.localName, call: true }
          : { binding: dependency.localName },
      );
    } else if (dependency.kind === "esm-namespace-import") {
      // A member in `callMembers` reads a callable export's RETURN value (`localName.member()`); the
      // rest read the member directly.
      const callMembers = new Set(dependency.callMembers ?? []);
      for (const member of dependency.readMembers) {
        reads.push(
          callMembers.has(member)
            ? { binding: dependency.localName, member, call: true }
            : { binding: dependency.localName, member },
        );
      }
    } else if (
      dependency.kind === "cjs-require" &&
      dependency.resultBinding !== undefined &&
      dependency.readName !== undefined
    ) {
      // A guarded require reads a possibly-partial cyclic export; keep the read total.
      reads.push(
        dependency.guard === true
          ? { binding: dependency.resultBinding, member: dependency.readName, guard: true }
          : { binding: dependency.resultBinding, member: dependency.readName },
      );
    }
  }
  return reads;
}
