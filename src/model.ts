export type ModuleFormat = "esm" | "cjs";

export type EventValue = string | number | boolean | null;

export interface EventRecord {
  readonly module: string;
  readonly phase: string;
  readonly value: EventValue;
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
