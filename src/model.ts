export type ModuleFormat = "esm" | "cjs";

export type EventValue = string | number | boolean | null;

/// Reads the value carried by a forward-only dependency binding in the reading module's scope:
/// an ESM value-import's `localName`, or a CJS require-result binding (then `member` names the
/// exported property read off the required module's exports). Every readable binding is created
/// by a dependency that targets a module evaluated strictly before the reader, so a read never
/// closes a cycle and never hits TDZ.
export interface ValueRead {
  readonly binding: string;
  readonly member?: string;
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
}

export interface EsmDynamicImportOperation {
  readonly kind: "esm-dynamic-import";
  readonly target: string;
  readonly registration: string;
}

export interface CjsRequireOperation {
  readonly kind: "cjs-require";
  readonly target: string;
  /// When set, the require is rendered as `const resultBinding = require("./target")` so the
  /// target's exports can be read. `readName` (required whenever `resultBinding` is) names the
  /// target export read through the binding and demands that the target synthesize it. Only ever
  /// set on forward, non-cycle require edges, so the target is fully evaluated before it is read.
  readonly resultBinding?: string;
  readonly readName?: string;
}

export type EsmDependencyOperation =
  | EsmSideEffectImportOperation
  | EsmValueImportOperation
  | EsmDynamicImportOperation;

export type DependencyOperation = EsmDependencyOperation | CjsRequireOperation;

interface ModuleModelBase {
  readonly id: string;
  readonly events: readonly EventRecord[];
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

export interface ProgramModel {
  readonly modules: readonly ModuleModel[];
  readonly entries: readonly EntryModel[];
  readonly schedule: readonly ScheduleOperation[];
  readonly manualChunkGroups?: readonly ManualChunkGroup[];
}

/// The forward-only dependency values a module can read in its own scope, in dependency order: an
/// ESM value-import contributes its `localName`; a CJS readable require contributes its
/// `resultBinding` plus the `readName` member read off the required module's exports. This is a
/// pure model fact shared by the generator (choosing event reads), the renderer (folding exports),
/// and validation.
export function readableBindingsOf(
  dependencies: readonly DependencyOperation[],
): readonly ValueRead[] {
  const reads: ValueRead[] = [];
  for (const dependency of dependencies) {
    if (dependency.kind === "esm-value-import") {
      reads.push({ binding: dependency.localName });
    } else if (
      dependency.kind === "cjs-require" &&
      dependency.resultBinding !== undefined &&
      dependency.readName !== undefined
    ) {
      reads.push({ binding: dependency.resultBinding, member: dependency.readName });
    }
  }
  return reads;
}
