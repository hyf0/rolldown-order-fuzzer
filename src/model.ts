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
  | EsmReexportStarOperation;

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
  /// When `true`, the module is rendered inside a synthetic package whose `package.json` asserts
  /// `"sideEffects": false`, a user promise the bundler consumes (Node ignores it). Because the
  /// bundler may then LEGALLY drop the module or its initializer, a flagged module must contribute
  /// ONLY values — a demanded export folded downstream — and MUST NOT emit `__orderEvent` records:
  /// an emitted event could be dropped in the bundle while the source still emits it, a false
  /// differential failure. With no events, however the bundler DCEs the module the observed event
  /// stream is unchanged, so any divergence (a dropped-but-referenced binding, a wrong folded value,
  /// a reordering) is a real bug. `validate-model.ts` enforces the no-events invariant; the flag is
  /// only valid on ESM modules whose dependencies are all value edges (see validate-model.ts).
  readonly sideEffectFree?: true;
}

export interface EsmModuleModel extends ModuleModelBase {
  readonly format: "esm";
  readonly dependencies: readonly EsmDependencyOperation[];
  readonly hasTopLevelAwait?: true;
}

/// CJS modules require synchronously and may also register dynamic imports — `import()` is
/// legal inside CommonJS in Node.
export interface CjsModuleModel extends ModuleModelBase {
  readonly format: "cjs";
  readonly dependencies: readonly (CjsRequireOperation | EsmDynamicImportOperation)[];
  readonly hasTopLevelAwait?: never;
}

export type ModuleModel = EsmModuleModel | CjsModuleModel;

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

/// A program carries at most ONE chunking config, the per-case axis rolled by the seeded RNG:
/// `default` (neither field present, rolldown's automatic chunking), `explicit`
/// (`manualChunkGroups` — exact module lists), or `organic` (`organicChunkGroups` — size/share
/// thresholds rolldown resolves). The two group fields are mutually exclusive (`validate-model.ts`
/// enforces it). `deriveCoverageTags` reads the fields to emit `chunking:default|explicit|organic`.
export interface ProgramModel {
  readonly modules: readonly ModuleModel[];
  readonly entries: readonly EntryModel[];
  readonly schedule: readonly ScheduleOperation[];
  readonly manualChunkGroups?: readonly ManualChunkGroup[];
  readonly organicChunkGroups?: readonly OrganicChunkGroupConfig[];
}

/// The forward-only dependency values a module can read in its own scope, in dependency order: an
/// ESM value-import contributes its `localName`; an ESM namespace-import contributes one read per
/// `readMembers` entry (`localName.member`); a CJS readable require contributes its `resultBinding`
/// plus the `readName` member read off the required module's exports. Re-export dependencies bind
/// nothing locally and contribute no readable value (a barrel forwards, it does not read). This is
/// a pure model fact shared by the generator (choosing event reads), the renderer (folding
/// exports), and validation.
export function readableBindingsOf(
  dependencies: readonly DependencyOperation[],
): readonly ValueRead[] {
  const reads: ValueRead[] = [];
  for (const dependency of dependencies) {
    if (dependency.kind === "esm-value-import") {
      // A call import binds a hoisted function; every read of it is a call (`localName()`).
      reads.push(
        dependency.call === true
          ? { binding: dependency.localName, call: true }
          : { binding: dependency.localName },
      );
    } else if (dependency.kind === "esm-namespace-import") {
      for (const member of dependency.readMembers) {
        reads.push({ binding: dependency.localName, member });
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
