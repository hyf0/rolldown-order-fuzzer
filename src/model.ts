import type { GlobalReadBuiltinKind } from "./global-read-builtins.ts";
import type { GlobalReadInstanceofKind } from "./global-read-instanceof.ts";
import type { GlobalReadOptimizerExpressionKind } from "./global-read-optimizer-expressions.ts";

export {
  GLOBAL_READ_BUILTIN_KINDS,
  GLOBAL_READ_BUILTIN_SPECS,
  OPTIMIZER_GLOBAL_READ_BUILTIN_KINDS,
} from "./global-read-builtins.ts";
export type {
  GlobalReadBuiltinKind,
  GlobalReadBuiltinProjection,
  GlobalReadBuiltinSpec,
} from "./global-read-builtins.ts";
export {
  GLOBAL_READ_INSTANCEOF_KINDS,
  GLOBAL_READ_INSTANCEOF_SPECS,
} from "./global-read-instanceof.ts";
export type {
  GlobalReadInstanceofKind,
  GlobalReadInstanceofSpec,
} from "./global-read-instanceof.ts";
export {
  EFFECT_PRESERVATION_OPTIMIZER_EXPRESSION_KINDS,
  GLOBAL_READ_OPTIMIZER_EFFECT_COUNTER,
  GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS,
  GLOBAL_READ_OPTIMIZER_EXPRESSION_SPECS,
} from "./global-read-optimizer-expressions.ts";
export type {
  EffectPreservationOptimizerExpressionSpec,
  GlobalReadOptimizerExpressionFamily,
  GlobalReadOptimizerExpressionKind,
  GlobalReadOptimizerExpressionSpec,
} from "./global-read-optimizer-expressions.ts";

export type ModuleFormat = "esm" | "cjs";

export type EventValue = string | number | boolean | null;

/// Reads the value carried by a dependency binding in the reading module's scope: an ESM
/// value-import's `localName`, or a CJS require-result binding (then `memberPath` names the exported
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
  /// The CANONICAL member-path representation (W14c): the chain of property accesses applied to
  /// `binding`, rendered `binding.p0.p1.…`. A plain value binding read carries no `memberPath` (or an
  /// empty one). A single-member namespace read (`ns.foo`) or a CJS readable-require member
  /// (`req.name`) is a LENGTH-1 path `["foo"]` / `["name"]`. A LENGTH-≥2 path is a NESTED namespace
  /// member read (`outer.ns.member`), where `binding` is a namespace import, `p0` names a re-exported
  /// namespace (`export * as p0 from …` on the target), and the tail reads through it — the demand for
  /// the deepest member routes to the namespace re-export's origin (see `analyzed-program.ts`). This
  /// ONE representation SUBSUMES the former single-member `member` field: nothing carries a bare
  /// `member` any more.
  readonly memberPath?: readonly string[];
  readonly call?: true;
  readonly guard?: true;
  /// When `true`, the DEEPEST member of a namespace member read renders as a COMPUTED access
  /// `…[<runtime key>]` instead of `….member`, where the key is a module-level string built at runtime
  /// so the bundler's static analysis cannot see which export is used (the shadcn `ns[k]` consumer
  /// shape). Intermediate namespace hops (`outer.ns`) stay static; only the final export access is
  /// hidden. The observed value is identical to the plain member read; only the syntactic visibility
  /// differs. Valid only on a namespace member read (a non-empty `memberPath` whose binding is a
  /// namespace import) — see `validate-model.ts`. A statically-invisible use is what family B needs to
  /// slip past on-demand wrapping's per-export liveness (see `.agents/docs/real-app-bug-families.md`).
  /// Mutually exclusive with `computedHopIndex` (below): `computed` hides the DEEPEST access, that one an
  /// INTERMEDIATE one — one read never needs both.
  readonly computed?: true;
  /// When set (FW-B deliverable 3), an INTERMEDIATE namespace hop renders as a COMPUTED access
  /// `binding[<runtime key>].tail` — the `a[imp].y` exotic read form the rebuilt #10180
  /// `TopLevelImportReadDetector` must still classify as a top-level read of `binding`. The index names
  /// which hop of `memberPath` is computed; it must be an INTERMEDIATE hop (`0 ≤ index < memberPath.length
  /// - 1`), leaving a STATIC tail after it (that is what distinguishes it from `computed`, which hides the
  /// deepest access). Valid only on a namespace member read whose intermediate hops route through
  /// `export * as ns` re-exports (so `binding[key]` resolves to a re-exported namespace whose `.tail`
  /// reads a member) — see `validate-model.ts`. The observed value is identical to the plain member read.
  readonly computedHopIndex?: number;
  /// When `true` (FW-B deliverable 3), the read routes through a module-level LOCAL ALIAS of its
  /// `binding` rather than the binding directly: the renderer emits a fresh local based on
  /// `<binding>_alias` once per aliased binding in the module and every aliased read uses that local.
  /// This is the `const x = ns; x.foo` exotic form the rebuilt #10180 detector must trace back to the
  /// namespace import `ns` (a local binding aliasing an imported namespace — a read through the alias is
  /// still a top-level read of the import). Rendering-only: the demand routing and observed value are
  /// identical to the direct read (the alias is not a separate representation — `binding` still names the
  /// namespace import, so there is ONE canonical read). Valid only on a namespace import binding read
  /// (like `computed`) — see `validate-model.ts`.
  readonly alias?: true;
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
  /// Optional property path read from the imported value (`localName.p0.p1...`) instead of reading
  /// the binding itself. Keeping it on the typed import makes validation and event folds agree on the
  /// exact read shape. A downstream observer can inspect an exported class without adding a second
  /// top-level read in its defining module, which would mask definition-time analyzer gaps (#10322).
  /// Mutually exclusive with `objectRef` and `call`: those import an object identity or a callable
  /// export rather than a numeric carrier whose member can be folded.
  readonly readMemberPath?: readonly string[];
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
  /// The member PATHS read off the namespace binding (W14c). Each entry is a path `localName.p0.p1.…`:
  /// a LENGTH-1 path `[foo]` is a plain `ns.foo`; a LENGTH-≥2 path `[ns, foo]` reads a member through a
  /// re-exported namespace (`export * as ns from …` on the target — the M7 shape), so `ns.foo`'s demand
  /// routes to the namespace re-export's origin. The demand fixpoint / consumption builder in
  /// `analyzed-program.ts` walks each path; `readableBindingsOf` turns each into a `ValueRead` with the
  /// SAME `memberPath`.
  readonly readMembers: readonly (readonly string[])[];
  /// The DEEPEST member names read as CALLS (`localName.….member()`), folding the callable export's
  /// RETURN value instead of the binding itself. A call member targets a `callableOwnState` definer's
  /// function export (reached directly or forwarded through a barrel), so the read witnesses the
  /// definer's own-state read through a function call rather than a direct value read — the exact
  /// shape (callable export + own-state read) the shadcn breakage manifested in. Forward-only like any
  /// namespace read (a namespace import may not close a cycle). Must name deepest members of
  /// `readMembers`; `validate-model.ts` enforces it. See
  /// `.agents/docs/object-identity-and-callable-own-state.md`.
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

/// `export * as <exportedName> from "..."` — re-exports the target's whole NAMESPACE OBJECT under one
/// named export (the M7 shape). Unlike `export *` (which spreads the target's names into the barrel's
/// own namespace), this synthesizes ONE new export whose value is the target's namespace object. So the
/// barrel is a LOCAL DEFINER of `exportedName` (it shadows any `export *` on the same module — the ONE
/// `starShadowedNames` rule gains this provision), and a downstream `outer.exportedName.member` read
/// routes the member demand to the target (the namespace's origin). Forward-only; the barrel emits no
/// events. Consumed two ways: a NESTED member read (`outer.ns.member`, folded numerically) or a
/// namespace-object IDENTITY capture (`outer.ns` as an `objectRef`, composing with the object-identity
/// witness where legal). See `.agents/docs/namespace-and-barrel-reexports.md`.
export interface EsmReexportNamespaceOperation {
  readonly kind: "esm-reexport-namespace";
  readonly target: string;
  readonly exportedName: string;
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
  | EsmReexportNamespaceOperation
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

/// The canonical global-read syntax surface. Generation, validation, the release gate, and tests all
/// consume this one list so adding an AST form cannot silently reach only some of those layers.
export const MANUAL_PURE_SIDE_EFFECT_FORMS = [
  "manual-pure-computed-key-effect",
  "manual-pure-call-argument-effect",
  "manual-pure-new-callee-computed-key-effect",
] as const;

export type ManualPureSideEffectForm = (typeof MANUAL_PURE_SIDE_EFFECT_FORMS)[number];

export const MANUAL_PURE_SIDE_EFFECT_COUNTER_GLOBAL =
  "__orderFuzzerManualPureSideEffectCount" as const;

export const GLOBAL_READ_FORMS = [
  "direct",
  "class-static-field-declaration",
  "class-static-field-expression",
  "class-static-field-default-export",
  "class-static-field-iife",
  "class-heritage",
  "class-computed-key",
  "class-computed-accessor-key",
  "class-nested-static-field",
  "class-static-block",
  "direct-arrow-iife",
  "direct-arrow-block-iife",
  "arrow-argument-iife",
  "direct-function-iife",
  "sequence-callee-iife",
  "optional-call-iife",
  "rest-parameter-iife",
  "named-function-iife",
  "local-const-iife",
  "if-body-iife",
  "try-finally-iife",
  "switch-body-iife",
  "returned-class-iife",
  "conditional-callee-iife",
  "logical-callee-iife",
  "array-member",
  "array-member-bigint-index",
  "optional-array-member",
  "sequence-array-member",
  "conditional-array-member",
  "spread-array-member",
  "array-length-call-effect",
  "object-member",
  "nested-object-member",
  "computed-string-object-member",
  "computed-number-object-member",
  "local-computed-object-member",
  "optional-object-member",
  "optional-computed-object-member",
  "nested-optional-object-member",
  "object-binding-default",
  "object-binding-computed-key",
  "nested-object-binding-default",
  "nested-object-binding-computed-key",
  "member-assignment-value",
  "annotated-pure-member",
  "manual-pure-member",
  "manual-pure-computed-member",
  "manual-pure-string-member",
  "manual-pure-numeric-member",
  "manual-pure-nested-member",
  "manual-pure-optional-member",
  "manual-pure-optional-computed-member",
  "manual-pure-member-call",
  "manual-pure-new",
  "manual-pure-class-instance-field",
  "manual-pure-class-default-parameter",
  "manual-pure-returned-class",
  ...MANUAL_PURE_SIDE_EFFECT_FORMS,
] as const;

export type GlobalReadForm = (typeof GLOBAL_READ_FORMS)[number];

const MANUAL_PURE_SIDE_EFFECT_FORM_SET: ReadonlySet<string> = new Set(
  MANUAL_PURE_SIDE_EFFECT_FORMS,
);

export function isManualPureSideEffectForm(form: GlobalReadForm): form is ManualPureSideEffectForm {
  return MANUAL_PURE_SIDE_EFFECT_FORM_SET.has(form);
}

const GLOBAL_READ_CARRIER_MEMBER_PATH = Object.freeze(["value"] as const);
const GLOBAL_READ_NESTED_CLASS_CARRIER_MEMBER_PATH = Object.freeze(["Inner", "value"] as const);

/// The property path a downstream observer must read when a global-read form exports a carrier rather
/// than the numeric value directly. Keeping this projection next to the form union prevents generation,
/// demand analysis, rendering, and validation from independently guessing which forms carry `.value`.
export function globalReadCarrierMemberPath(form: GlobalReadForm): readonly string[] | undefined {
  if (form === "class-nested-static-field") {
    return GLOBAL_READ_NESTED_CLASS_CARRIER_MEMBER_PATH;
  }
  return form.startsWith("class-") ||
    form === "returned-class-iife" ||
    form === "manual-pure-new" ||
    form.startsWith("manual-pure-class-") ||
    form === "manual-pure-returned-class"
    ? GLOBAL_READ_CARRIER_MEMBER_PATH
    : undefined;
}

/// A manual-pure global-read form's exact author-visible callee. The same name drives the persisted
/// Rolldown option, the rendered helper, and collision validation.
export function globalReadManualPureFunction(form: GlobalReadForm): "make" | "Box" | undefined {
  if (
    form === "manual-pure-new" ||
    form === "manual-pure-class-instance-field" ||
    form === "manual-pure-class-default-parameter"
  ) {
    return "Box";
  }
  return form.startsWith("manual-pure-") ? "make" : undefined;
}

export function globalReadFixedHelperName(form: GlobalReadForm): "make" | "Box" | undefined {
  return form === "annotated-pure-member" ? "make" : globalReadManualPureFunction(form);
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
  /// Author-chosen local bindings for demand-synthesized exports. The export-demand model still owns
  /// which exported names exist; this only replaces the renderer's collision-avoiding generated local
  /// (`__orderExportN`, `__objectExportN`, …) with the exact source binding an author wrote. This makes
  /// deconfliction bugs reachable without accepting arbitrary source text — notably collisions with
  /// runtime helpers (`__esmMin` / `__esm`) and generated wrapper/chunk-root names.
  readonly authoredExportBindings?: readonly {
    readonly exportedName: string;
    readonly localName: string;
  }[];
  /// One fixture-owned global function installed by an event-free patch module. The paired reader uses
  /// an annotated optional call (`globalThis.__orderRead?.()`) so the function call itself is declared
  /// pure without assuming that any standard built-in can be monkey-patched. This is the analyzer
  /// witness used by the 54 ordinary analyzer forms. The array-length and manual-pure effect probes
  /// deliberately do not use this field: observing a call side effect after declaring it pure would be
  /// contradictory, while manual-pure probes instead observe effects in the call's children.
  readonly fixtureFunctionAssignment?: {
    readonly value: number;
  };
  readonly builtinAssignments?: readonly {
    readonly kind: GlobalReadBuiltinKind;
    readonly value: number;
    /// Fixture-private global counter incremented whenever the replacement function runs. This makes
    /// calls whose return value is intentionally discarded observable (`[call()].length`).
    readonly counterGlobal?: string;
  }[];
  /// Typed `instanceof` monkey-patches are separate from built-in call assignments. The renderer
  /// replaces the selected global constructor with a forwarding wrapper carrying its own
  /// `Symbol.hasInstance`, leaving the original constructor descriptor untouched.
  readonly instanceofAssignments?: readonly {
    readonly kind: GlobalReadInstanceofKind;
  }[];
  /// A closed optimizer-expression patch. Only the stable registry key is persisted; executable
  /// patch/prelude/expression text and any typed effect counter remain internal to the versioned
  /// renderer registry.
  readonly optimizerExpressionAssignments?: readonly {
    readonly kind: GlobalReadOptimizerExpressionKind;
  }[];
  /// One event-free export whose initializer reads a fixture-private global through a selected syntax
  /// form. Class forms export the class itself so the downstream observer reads `.value`; reading the
  /// field inside this module would add an ordinary top-level read and mask the class-definition analyzer
  /// path. Direct/IIFE/array forms export the numeric value. A downstream module emits the event so the
  /// reader never becomes order-sensitive merely because the witness itself logs an effect.
  readonly globalReadExport?: {
    readonly form: GlobalReadForm;
    readonly exportedName: string;
    readonly read:
      | { readonly kind: GlobalReadBuiltinKind }
      | { readonly kind: "instanceof"; readonly expression: GlobalReadInstanceofKind }
      | {
          readonly kind: "optimizer-expression";
          readonly expression: GlobalReadOptimizerExpressionKind;
        }
      | { readonly kind: "fixture-function-call" }
      | { readonly kind: "global-property"; readonly name: string };
    /// Effect-preservation optimizer specs and the array-length call form may intentionally use the
    /// same expected/fallback value; their separate typed counter observer is the semantic witness.
    /// Every other read keeps distinct values so reordering remains visible directly.
    readonly expectedValue: number;
    readonly fallbackValue: number;
  };
}

/// CJS modules require synchronously and may also register dynamic imports — `import()` is
/// legal inside CommonJS in Node.
export interface CjsModuleModel extends ModuleModelBase {
  readonly format: "cjs";
  readonly dependencies: readonly (CjsRequireOperation | EsmDynamicImportOperation)[];
  readonly hasTopLevelAwait?: never;
  /// When `true` (FW-A deliverable 3), the module renders the TRANSPILED-CJS interop marker
  /// `Object.defineProperty(exports, "__esModule", { value: true });` before its exports, and writes
  /// EVERY demanded export (including `default`) as an `exports.<name> = …` property — the Babel/tsc
  /// `esModuleInterop` shape every transpiled npm package ships. This is the ONLY thing that drives
  /// rolldown's `__esModule` interop DETECTION (the historical DCE-vs-order epicenter, cluster 3 /
  /// #8675/#8975); it exercises that path without changing the observed value, because rolldown targets
  /// Node semantics — a real `.mjs` importer gets `__toESM(require_x(), 1)` (isNodeMode), which IGNORES
  /// `__esModule` and mirrors Node's own CJS interop exactly (an `import def` binds the whole
  /// `module.exports`, a named import binds the named member). LEGALITY GATE: every consumption × marker
  /// combination was probed identical between Node and the final snapshot, so the legal subset is ALL of
  /// them (see `.agents/docs/fw-a-output-format-axis.md`). ESM importers consume it via a named import
  /// (a clean numeric fold) and a default import (`import { default as x }`, folding the whole exports
  /// object — a stringy but stable witness that still crashes on a broken interop).
  readonly esModuleMarker?: true;
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
  /// Split this exact module-id group into per-entry-reachability subgroups before optional merging.
  /// This is the stable-path form of the entries-aware init-cycle random factor: the adapter
  /// reconstructs an exact-path predicate from `moduleIds`, so dropping/renumbering an earlier root
  /// module during shrink cannot make the selector drift to a different module.
  readonly entriesAware?: boolean;
  readonly entriesAwareMergeThreshold?: number;
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
  /// `CodeSplittingGroup.entriesAware` (W14c) — split the group's modules into per-entry-reachability
  /// subgroups instead of one shared chunk. At `strictExecutionOrder:false`, the cross-entry config can
  /// co-locate modules of disjoint entry reachability and leak another entry's top level. Bundle-side only;
  /// the strict init-cycle factor uses the exact-manual form above.
  readonly entriesAware?: boolean;
  /// `CodeSplittingGroup.entriesAwareMergeThreshold` — the byte size below which `entriesAware`
  /// subgroups merge back into one chunk (only meaningful with `entriesAware:true`). A large threshold
  /// forces the merge used by cross-entry co-location shapes.
  readonly entriesAwareMergeThreshold?: number;
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

/// The four mutually-exclusive chunking modes as ONE discriminated union, so tags, artifact identity,
/// adapter options, and shrinking share a single matcher instead of each re-deriving the mode from two
/// optional arrays (where an EMPTY array leaks as a fourth, ambiguous state). `build.chunking` carries it
/// directly on a schema-17 program; `programChunking` normalizes it (an empty groups array is automatic).
export type Chunking =
  | { readonly kind: "disabled" }
  | { readonly kind: "automatic" }
  | { readonly kind: "manual"; readonly groups: readonly ManualChunkGroup[] }
  | { readonly kind: "organic"; readonly groups: readonly OrganicChunkGroupConfig[] };

/// `InputOptions.preserveEntrySignatures` — the fuzzer only produces `"allow-extension"` (the historical
/// hardcoded value, now moved into the persisted `BuildConfig`); the other values are here only so the
/// build child's request type accepts what a future axis might roll.
export type PreserveEntrySignatures = false | "strict" | "allow-extension" | "exports-only";

/// `OutputOptions.format` — the fuzzer's output-format axis (FW-A). Only `esm` and `cjs` are rolled:
/// both support code splitting (multiple entries + shared chunks), so the differential oracle over a
/// multi-entry program stays valid; `iife`/`umd` are single-entry-only and out of scope. A `cjs`-output
/// bundle is a genuine CommonJS program — its entries are loaded via `require` (the runner already has
/// the require-entry path) and its cross-chunk refs route through the CJS-interop machinery
/// (`__toCommonJS`, live getters, the self-rebinding-wrapper defense) that the ESM-output pin kept
/// structurally unreachable. See `.agents/docs/fw-a-output-format-axis.md`.
export type OutputFormat = "esm" | "cjs";

export interface TreeshakeConfig {
  readonly propertyReadSideEffects: false | "always";
  readonly propertyWriteSideEffects: false | "always";
  readonly manualPureFunctions: readonly string[];
}

export const DEFAULT_TREESHAKE_CONFIG: TreeshakeConfig = Object.freeze({
  propertyReadSideEffects: "always",
  propertyWriteSideEffects: "always",
  manualPureFunctions: Object.freeze([]),
});

/// The ONE persisted bundle-side build configuration a case builds with — consumed by the adapter/build
/// child, the evaluator, replay/shrink, the artifact identity, the corpus manifest, and the coverage
/// tags. All of these bundle-side; NONE changes the source run, so the differential oracle stays valid.
///
/// - `chunking` — the code-splitting mode (moved in from the top-level arrays). `disabled` maps to
///   Rolldown's real `codeSplitting: false`; it is not equivalent to one manual group containing every
///   module because the disabled path also controls runtime-module co-hosting and order-wrapper lowering.
/// - `includeDependenciesRecursively` — the GLOBAL `codeSplitting.includeDependenciesRecursively`
///   fallback (rolldown default `true`); the W14a axis the generator rolls. `false` is a necessary
///   ingredient of the #9887 cross-chunk init-cycle catch.
/// - `preserveEntrySignatures` — the `InputOptions.preserveEntrySignatures` value (moved in from the
///   hardcoded `"allow-extension"`; not rolled).
/// - `lazyBarrel` — `experimental.lazyBarrel`, rolldown's barrel-pruning optimization (default `false`);
///   the W14-9 axis the generator rolls (smoke-verified honored by the frozen snapshot under strict order).
/// - `strictExecutionOrder` — `OutputOptions.strictExecutionOrder` (default `true`; NOT rolled in W14a —
///   every case keeps `true`, because a `seo:false` cell needs a weaker order oracle that lands in W14c).
/// - `outputFormat` — `OutputOptions.format` (FW-A; default `esm`). The generator rolls `cjs` at a
///   modest density in random-mixed (drawn LAST so no source-affecting roll shifts), gated OFF whenever
///   any module reaches top-level await (rolldown hard-refuses TLA under a `cjs` output). Source-neutral:
///   the SOURCE run is identical; only the bundle build + load path changes.
/// - `minify` — `OutputOptions.minify` (W12; default `false`). The generator rolls `true` at a modest
///   density in random-mixed, drawn LAST — after the output-format roll — so it too is RNG-neutral (the
///   SOURCE run is byte-identical; only the bundle build changes). Minify mangles internal identifiers
///   and drops whitespace, but the value/event channel is minify-invariant (event payloads are string /
///   numeric LITERALS the mangler never touches). The one seam it opens is error-identity: a bundle that
///   crashes throws with a MANGLED identifier (`t is not a function` vs the source's `x is not a
///   function`), so the oracle normalizes identifier tokens in known error templates before comparing a
///   minified bundle's error to the source's (`verdict.ts`). No gate (unlike `cjs`, minify composes with
///   TLA and every other axis). See `.agents/docs/w12-minify-axis.md`.
/// - `profilerNames` — `OutputOptions.generatedCode.profilerNames` (default `false`). It selects the
///   readable runtime helper family (`__esm` / `__commonJS`) instead of the compact family
///   (`__esmMin` / `__commonJSMin`), so authored-name collision coverage must exercise both paths.
export interface BuildConfig {
  readonly chunking: Chunking;
  readonly includeDependenciesRecursively: boolean;
  readonly preserveEntrySignatures: PreserveEntrySignatures;
  readonly lazyBarrel: boolean;
  readonly strictExecutionOrder: boolean;
  readonly outputFormat: OutputFormat;
  readonly minify: boolean;
  readonly profilerNames: boolean;
  readonly treeshake: TreeshakeConfig;
}

/// The build config a program with no persisted `build` (a legacy v16 artifact) resolves to, minus its
/// chunking (which `buildConfigOf` derives from the legacy arrays): rolldown/fuzzer defaults.
export const DEFAULT_BUILD_CONFIG: BuildConfig = Object.freeze({
  chunking: { kind: "automatic" } as const,
  includeDependenciesRecursively: true,
  preserveEntrySignatures: "allow-extension",
  lazyBarrel: false,
  strictExecutionOrder: true,
  outputFormat: "esm",
  minify: false,
  profilerNames: false,
  treeshake: DEFAULT_TREESHAKE_CONFIG,
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
    // A persisted `build` predating a bundle-side axis carries the older fields but not the newer one;
    // default each MISSING axis to its historical fixed value so an old artifact still resolves and
    // validates — the same "an old persisted artifact still replays" rule `packagesOf` / the v16 chunking
    // fallback follow. `outputFormat` (FW-A) defaults to `esm`; `minify` (W12) defaults to `false`. A
    // present value (a real boolean / format) is preserved untouched.
    const persisted = program.build as BuildConfig & {
      readonly outputFormat?: OutputFormat;
      readonly minify?: boolean;
      readonly profilerNames?: boolean;
      readonly treeshake?: TreeshakeConfig;
    };
    return {
      ...persisted,
      outputFormat: persisted.outputFormat ?? "esm",
      minify: persisted.minify ?? false,
      profilerNames: persisted.profilerNames ?? false,
      treeshake: persisted.treeshake ?? DEFAULT_TREESHAKE_CONFIG,
    };
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
/// ESM value-import contributes its `localName` plus its optional value-member path; an ESM namespace-import contributes one read per
/// `readMembers` PATH (`localName.p0.p1…`, W14c); a CJS readable require contributes its
/// `resultBinding` plus the `readName` member read (a length-1 `memberPath`) off the required module's
/// exports; an ESM LOCAL re-export contributes its `localName` (the binding is genuinely imported into
/// scope, unlike a source-form re-export). Pure re-export dependencies (`export … from`, `export * as
/// ns from`) bind nothing locally and contribute no readable value (a barrel forwards, it does not
/// read). This is a pure model fact shared by the generator (choosing event reads), the renderer
/// (folding exports), and validation.
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
      // A call import binds a hoisted function; every read of it is a direct call (`localName()`). A
      // value-member path instead observes a property of an imported numeric class/object carrier.
      reads.push({
        binding: dependency.localName,
        ...(dependency.readMemberPath === undefined
          ? {}
          : { memberPath: dependency.readMemberPath }),
        ...(dependency.call === true ? { call: true as const } : {}),
      });
    } else if (dependency.kind === "esm-namespace-import") {
      // A member in `callMembers` reads a callable export's RETURN value (`localName.member()`); the
      // rest read the member directly. `readMembers` entries are member PATHS (W14c): a length-1 path
      // is a plain `ns.foo`, a longer one a nested `ns.re.foo` through a re-exported namespace. A call
      // member matches by its DEEPEST name (what `callMembers` records).
      const callMembers = new Set(dependency.callMembers ?? []);
      for (const memberPath of dependency.readMembers) {
        const deepest = memberPath[memberPath.length - 1];
        reads.push(
          deepest !== undefined && callMembers.has(deepest)
            ? { binding: dependency.localName, memberPath, call: true }
            : { binding: dependency.localName, memberPath },
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
          ? { binding: dependency.resultBinding, memberPath: [dependency.readName], guard: true }
          : { binding: dependency.resultBinding, memberPath: [dependency.readName] },
      );
    }
  }
  return reads;
}

/// The deepest member name a read names (the actual export it observes), or `undefined` for a plain
/// binding read (no `memberPath`). This is what callability / call-membership keys off, and the name a
/// namespace member read demands at the end of its path.
export function readDeepestMember(read: ValueRead): string | undefined {
  const path = read.memberPath;
  if (path === undefined || path.length === 0) {
    return undefined;
  }
  return path[path.length - 1];
}

/// Migrate a LEGACY (schema ≤18) program's reads onto the canonical member-PATH representation (W14c),
/// following the `buildConfigOf` / `packagesOf` legacy-reader pattern so an old failure artifact still
/// replays. A v18 namespace read carried a bare `member: string`; a v18 namespace import carried
/// `readMembers: string[]`. Both become the length-1 `memberPath` / path-array shape the current code
/// reads. A program already in the new shape (every namespace `readMembers` entry an array, no read
/// carrying `member`) passes through untouched. Applied ONCE at an artifact load boundary (shrink /
/// replay); freshly generated programs are already canonical.
export function normalizeLegacyReads(program: ProgramModel): ProgramModel {
  let changed = false;
  const migrateRead = (read: ValueRead): ValueRead => {
    const legacyMember = (read as { readonly member?: string }).member;
    if (legacyMember === undefined) {
      return read;
    }
    changed = true;
    const { member: _dropped, ...rest } = read as ValueRead & { member?: string };
    return { ...rest, memberPath: [legacyMember] };
  };
  const modules = program.modules.map((module): ModuleModel => {
    const dependencies = module.dependencies.map((dependency): DependencyOperation => {
      if (dependency.kind !== "esm-namespace-import") {
        return dependency;
      }
      const readMembers = dependency.readMembers.map((entry) => {
        if (typeof entry === "string") {
          changed = true;
          return [entry];
        }
        return entry;
      });
      return { ...dependency, readMembers } as DependencyOperation;
    });
    const events = module.events.map((event) =>
      event.reads === undefined ? event : { ...event, reads: event.reads.map(migrateRead) },
    );
    return { ...module, dependencies, events } as ModuleModel;
  });
  return changed ? ({ ...program, modules } as ProgramModel) : program;
}
