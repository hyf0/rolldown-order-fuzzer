import type { DependencyOperation, EntryModel, ModuleModel, ProgramModel } from "./model.ts";

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

    for (const [dependencyIndex, dependency] of module.dependencies.entries()) {
      const path = `modules[${moduleIndex}].dependencies[${dependencyIndex}]`;
      const operation: DependencyOperation = dependency;

      validateDependencySyntax(module, operation, path, errors);
      validateImportBinding(operation, path, localBindings, errors);

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
      if (event.module !== module.id) {
        errors.push(
          `modules[${moduleIndex}].events[${eventIndex}].module: expected containing module id ${quote(module.id)}, received ${quote(event.module)}`,
        );
      }

      if ("binding" in event && !localBindings.has(event.binding)) {
        errors.push(
          `modules[${moduleIndex}].events[${eventIndex}].binding: unknown imported binding ${quote(event.binding)}`,
        );
      } else if (
        "value" in event &&
        typeof event.value === "number" &&
        !Number.isFinite(event.value)
      ) {
        errors.push(
          `modules[${moduleIndex}].events[${eventIndex}].value: expected a finite JSON number`,
        );
      }
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

function validateImportBinding(
  dependency: DependencyOperation,
  path: string,
  localBindings: Set<string>,
  errors: string[],
): void {
  if (dependency.kind !== "esm-value-import") {
    return;
  }

  if (!JAVASCRIPT_IDENTIFIER_PATTERN.test(dependency.importedName)) {
    errors.push(
      `${path}.importedName: invalid JavaScript identifier ${quote(dependency.importedName)}`,
    );
  }

  if (
    !JAVASCRIPT_IDENTIFIER_PATTERN.test(dependency.localName) ||
    INVALID_MODULE_BINDING_IDENTIFIERS.has(dependency.localName)
  ) {
    errors.push(
      `${path}.localName: invalid JavaScript binding identifier ${quote(dependency.localName)}`,
    );
  } else if (RENDERER_RESERVED_BINDING_IDENTIFIERS.has(dependency.localName)) {
    errors.push(
      `${path}.localName: reserved renderer binding identifier ${quote(dependency.localName)}`,
    );
  } else if (localBindings.has(dependency.localName)) {
    errors.push(`${path}.localName: duplicate ESM local binding ${quote(dependency.localName)}`);
  } else {
    localBindings.add(dependency.localName);
  }
}

function validateDependencySyntax(
  module: ModuleModel,
  dependency: DependencyOperation,
  path: string,
  errors: string[],
): void {
  if (module.format === "esm" && dependency.kind === "cjs-require") {
    errors.push(`${path}: ESM modules cannot use cjs-require`);
  } else if (module.format === "cjs" && dependency.kind !== "cjs-require") {
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
