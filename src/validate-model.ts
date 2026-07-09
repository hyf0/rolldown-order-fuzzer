import type {
  CjsRequireOperation,
  DependencyOperation,
  EntryModel,
  ModuleModel,
  ProgramModel,
} from "./model.ts";

const JAVASCRIPT_IDENTIFIER_PATTERN = /^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u;

const INVALID_MODULE_BINDING_IDENTIFIERS = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const RENDERER_RESERVED_BINDING_IDENTIFIERS = new Set(["globalThis"]);

export function validateProgramModel(program: ProgramModel): readonly string[] {
  const errors: string[] = [];
  const modulesById = collectModules(program.modules, errors);
  const dynamicRegistrationOwners = new Map<string, string>();
  const modulesReachingTopLevelAwait = computeTopLevelAwaitReachability(modulesById);

  validateModules(
    program.modules,
    modulesById,
    modulesReachingTopLevelAwait,
    dynamicRegistrationOwners,
    errors,
  );

  const entriesByName = collectEntries(program.entries, modulesById, errors);
  validateSchedule(program, entriesByName, modulesById, dynamicRegistrationOwners, errors);
  validateManualChunkGroups(program, modulesById, errors);

  return errors;
}

function collectModules(
  modules: readonly ModuleModel[],
  errors: string[],
): ReadonlyMap<string, ModuleModel> {
  const modulesById = new Map<string, ModuleModel>();

  for (const [moduleIndex, module] of modules.entries()) {
    if (modulesById.has(module.id)) {
      errors.push(`modules[${moduleIndex}].id: duplicate module id ${quote(module.id)}`);
      continue;
    }

    modulesById.set(module.id, module);
  }

  return modulesById;
}

function validateModules(
  modules: readonly ModuleModel[],
  modulesById: ReadonlyMap<string, ModuleModel>,
  modulesReachingTopLevelAwait: ReadonlySet<string>,
  dynamicRegistrationOwners: Map<string, string>,
  errors: string[],
): void {
  for (const [moduleIndex, module] of modules.entries()) {
    const localBindings = new Set<string>();
    // Each readable binding maps its local name to the member read off it: `undefined` for an ESM
    // value-import (read directly), or the required export name for a CJS readable require.
    const readableBindings = new Map<string, string | undefined>();

    for (const [dependencyIndex, dependency] of module.dependencies.entries()) {
      const path = `modules[${moduleIndex}].dependencies[${dependencyIndex}]`;
      const operation: DependencyOperation = dependency;

      validateDependencySyntax(module, operation, path, errors);
      validateDependencyBinding(operation, path, localBindings, readableBindings, errors);

      const target = modulesById.get(operation.target);
      if (target === undefined) {
        errors.push(`${path}.target: unknown module id ${quote(operation.target)}`);
      } else if (
        operation.kind === "cjs-require" &&
        target.format === "esm" &&
        modulesReachingTopLevelAwait.has(target.id)
      ) {
        errors.push(
          `${path}: cannot require ESM module ${quote(target.id)} because it has top-level await`,
        );
      }

      if (operation.kind === "esm-dynamic-import") {
        if (dynamicRegistrationOwners.has(operation.registration)) {
          errors.push(
            `${path}.registration: duplicate dynamic import registration ${quote(operation.registration)}`,
          );
        } else {
          dynamicRegistrationOwners.set(operation.registration, module.id);
        }
      }
    }

    for (const [eventIndex, event] of module.events.entries()) {
      const eventPath = `modules[${moduleIndex}].events[${eventIndex}]`;
      if (event.module !== module.id) {
        errors.push(
          `${eventPath}.module: expected containing module id ${quote(module.id)}, received ${quote(event.module)}`,
        );
      }

      if (typeof event.value === "number" && !Number.isFinite(event.value)) {
        errors.push(`${eventPath}.value: expected a finite JSON number`);
      }

      validateEventReads(event, eventPath, readableBindings, errors);
    }
  }
}

function validateEventReads(
  event: ModuleModel["events"][number],
  eventPath: string,
  readableBindings: ReadonlyMap<string, string | undefined>,
  errors: string[],
): void {
  if (event.reads === undefined || event.reads.length === 0) {
    return;
  }

  // A folded event emits `value + read0 + …`; the base must stay numeric so the fold stays numeric.
  if (typeof event.value !== "number" || !Number.isFinite(event.value)) {
    errors.push(`${eventPath}.value: expected a finite JSON number when the event carries reads`);
  }

  for (const [readIndex, read] of event.reads.entries()) {
    const readPath = `${eventPath}.reads[${readIndex}]`;
    if (!readableBindings.has(read.binding)) {
      errors.push(
        `${readPath}.binding: unknown readable binding ${quote(read.binding)} in this module`,
      );
      continue;
    }
    const expectedMember = readableBindings.get(read.binding);
    if (read.member !== expectedMember) {
      errors.push(
        `${readPath}.member: expected ${expectedMember === undefined ? "no member" : quote(expectedMember)} for binding ${quote(read.binding)}, received ${read.member === undefined ? "no member" : quote(read.member)}`,
      );
    }
  }
}

function computeTopLevelAwaitReachability(
  modulesById: ReadonlyMap<string, ModuleModel>,
): ReadonlySet<string> {
  const synchronousDependents = new Map<string, string[]>();
  const modulesReachingTopLevelAwait = new Set<string>();
  const pending: string[] = [];

  for (const module of modulesById.values()) {
    if (module.format === "esm" && module.hasTopLevelAwait === true) {
      modulesReachingTopLevelAwait.add(module.id);
      pending.push(module.id);
    }

    for (const dependency of module.dependencies) {
      if (dependency.kind === "esm-dynamic-import" || !modulesById.has(dependency.target)) {
        continue;
      }

      const dependents = synchronousDependents.get(dependency.target);
      if (dependents === undefined) {
        synchronousDependents.set(dependency.target, [module.id]);
      } else {
        dependents.push(module.id);
      }
    }
  }

  for (let index = 0; index < pending.length; index += 1) {
    const moduleId = pending[index];
    if (moduleId === undefined) {
      continue;
    }

    for (const dependentId of synchronousDependents.get(moduleId) ?? []) {
      if (!modulesReachingTopLevelAwait.has(dependentId)) {
        modulesReachingTopLevelAwait.add(dependentId);
        pending.push(dependentId);
      }
    }
  }

  return modulesReachingTopLevelAwait;
}

function validateDependencyBinding(
  dependency: DependencyOperation,
  path: string,
  localBindings: Set<string>,
  readableBindings: Map<string, string | undefined>,
  errors: string[],
): void {
  if (dependency.kind === "esm-value-import") {
    if (!JAVASCRIPT_IDENTIFIER_PATTERN.test(dependency.importedName)) {
      errors.push(
        `${path}.importedName: invalid JavaScript identifier ${quote(dependency.importedName)}`,
      );
    }

    if (validateLocalBinding(dependency.localName, `${path}.localName`, localBindings, errors)) {
      readableBindings.set(dependency.localName, undefined);
    }
    return;
  }

  if (dependency.kind === "cjs-require") {
    validateRequireBinding(dependency, path, localBindings, readableBindings, errors);
  }
}

/// A readable require binds `const resultBinding = require(...)` and reads `resultBinding.readName`.
/// Both fields travel together: the binding is the scope name, the read name is the demanded export.
function validateRequireBinding(
  dependency: CjsRequireOperation,
  path: string,
  localBindings: Set<string>,
  readableBindings: Map<string, string | undefined>,
  errors: string[],
): void {
  if (dependency.resultBinding === undefined && dependency.readName === undefined) {
    return;
  }
  if (dependency.resultBinding === undefined || dependency.readName === undefined) {
    errors.push(`${path}: resultBinding and readName must be set together on a readable require`);
    return;
  }

  if (!JAVASCRIPT_IDENTIFIER_PATTERN.test(dependency.readName)) {
    errors.push(`${path}.readName: invalid JavaScript identifier ${quote(dependency.readName)}`);
  }

  if (
    validateLocalBinding(dependency.resultBinding, `${path}.resultBinding`, localBindings, errors)
  ) {
    readableBindings.set(dependency.resultBinding, dependency.readName);
  }
}

function validateLocalBinding(
  name: string,
  path: string,
  localBindings: Set<string>,
  errors: string[],
): boolean {
  if (!JAVASCRIPT_IDENTIFIER_PATTERN.test(name) || INVALID_MODULE_BINDING_IDENTIFIERS.has(name)) {
    errors.push(`${path}: invalid JavaScript binding identifier ${quote(name)}`);
    return false;
  }
  if (RENDERER_RESERVED_BINDING_IDENTIFIERS.has(name)) {
    errors.push(`${path}: reserved renderer binding identifier ${quote(name)}`);
    return false;
  }
  if (localBindings.has(name)) {
    errors.push(`${path}: duplicate module local binding ${quote(name)}`);
    return false;
  }
  localBindings.add(name);
  return true;
}

function validateDependencySyntax(
  module: ModuleModel,
  dependency: DependencyOperation,
  path: string,
  errors: string[],
): void {
  if (module.format === "esm" && dependency.kind === "cjs-require") {
    errors.push(`${path}: ESM modules cannot use cjs-require`);
  } else if (
    module.format === "cjs" &&
    dependency.kind !== "cjs-require" &&
    dependency.kind !== "esm-dynamic-import"
  ) {
    // `import()` is legal inside CommonJS in Node; static import syntax is not.
    errors.push(`${path}: CJS modules cannot use ${dependency.kind}`);
  }
}

function collectEntries(
  entries: readonly EntryModel[],
  modulesById: ReadonlyMap<string, ModuleModel>,
  errors: string[],
): ReadonlyMap<string, EntryModel> {
  const entriesByName = new Map<string, EntryModel>();

  for (const [entryIndex, entry] of entries.entries()) {
    if (entriesByName.has(entry.name)) {
      errors.push(`entries[${entryIndex}].name: duplicate entry name ${quote(entry.name)}`);
    } else {
      entriesByName.set(entry.name, entry);
    }

    if (!modulesById.has(entry.moduleId)) {
      errors.push(`entries[${entryIndex}].moduleId: unknown module id ${quote(entry.moduleId)}`);
    }
  }

  return entriesByName;
}

function validateSchedule(
  program: ProgramModel,
  entriesByName: ReadonlyMap<string, EntryModel>,
  modulesById: ReadonlyMap<string, ModuleModel>,
  dynamicRegistrationOwners: ReadonlyMap<string, string>,
  errors: string[],
): void {
  const evaluatedModules = new Set<string>();

  for (const [scheduleIndex, operation] of program.schedule.entries()) {
    const path = `schedule[${scheduleIndex}]`;

    if (operation.kind === "trigger-dynamic-import") {
      const ownerId = dynamicRegistrationOwners.get(operation.registration);
      if (ownerId === undefined) {
        errors.push(
          `${path}.registration: unknown dynamic import registration ${quote(operation.registration)}`,
        );
      } else if (!evaluatedModules.has(ownerId)) {
        errors.push(
          `${path}.registration: dynamic import registration ${quote(operation.registration)} is unavailable before module ${quote(ownerId)} is evaluated`,
        );
      } else {
        // The runner awaits the trigger, so the dynamic target's synchronous
        // subtree has evaluated and its registrations are available afterwards.
        const target = modulesById
          .get(ownerId)
          ?.dependencies.find(
            (dependency) =>
              dependency.kind === "esm-dynamic-import" &&
              dependency.registration === operation.registration,
          );
        const targetModule = target === undefined ? undefined : modulesById.get(target.target);
        if (targetModule !== undefined) {
          markSynchronouslyEvaluated(targetModule, modulesById, evaluatedModules);
        }
      }
      continue;
    }

    const entry = entriesByName.get(operation.entry);
    if (entry === undefined) {
      errors.push(`${path}.entry: unknown entry name ${quote(operation.entry)}`);
      continue;
    }

    const entryModule = modulesById.get(entry.moduleId);
    if (entryModule === undefined) {
      continue;
    }

    if (operation.kind === "import-entry" && entryModule.format !== "esm") {
      errors.push(`${path}: cannot import CJS entry ${quote(operation.entry)}`);
    } else if (operation.kind === "require-entry" && entryModule.format !== "cjs") {
      errors.push(`${path}: cannot require ESM entry ${quote(operation.entry)}`);
    } else {
      markSynchronouslyEvaluated(entryModule, modulesById, evaluatedModules);
    }
  }
}

function markSynchronouslyEvaluated(
  root: ModuleModel,
  modulesById: ReadonlyMap<string, ModuleModel>,
  evaluatedModules: Set<string>,
): void {
  const pending = [root];

  while (pending.length > 0) {
    const module = pending.pop();
    if (module === undefined || evaluatedModules.has(module.id)) {
      continue;
    }
    evaluatedModules.add(module.id);

    for (const dependency of module.dependencies) {
      if (dependency.kind === "esm-dynamic-import") {
        continue;
      }

      const target = modulesById.get(dependency.target);
      if (target !== undefined) {
        pending.push(target);
      }
    }
  }
}

function validateManualChunkGroups(
  program: ProgramModel,
  modulesById: ReadonlyMap<string, ModuleModel>,
  errors: string[],
): void {
  const groupNames = new Set<string>();

  for (const [groupIndex, group] of (program.manualChunkGroups ?? []).entries()) {
    if (groupNames.has(group.name)) {
      errors.push(
        `manualChunkGroups[${groupIndex}].name: duplicate group name ${quote(group.name)}`,
      );
    } else {
      groupNames.add(group.name);
    }

    for (const [moduleIndex, moduleId] of group.moduleIds.entries()) {
      if (!modulesById.has(moduleId)) {
        errors.push(
          `manualChunkGroups[${groupIndex}].moduleIds[${moduleIndex}]: unknown module id ${quote(moduleId)}`,
        );
      }
    }
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}
