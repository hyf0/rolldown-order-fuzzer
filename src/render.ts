import type {
  EntryModel,
  ModuleFormat,
  ModuleModel,
  ProgramModel,
  ScheduleOperation,
} from "./model.ts";
import { validateProgramModel } from "./validate-model.ts";

export interface RenderedFile {
  readonly path: string;
  readonly contents: string;
}

export interface RenderedScheduleEntry {
  readonly name: string;
  readonly path: string;
  readonly format: ModuleFormat;
}

export interface RenderedScheduleManifest {
  readonly version: 1;
  readonly entries: readonly RenderedScheduleEntry[];
  readonly operations: readonly ScheduleOperation[];
}

export interface RenderedProgram {
  readonly files: readonly RenderedFile[];
  readonly modulePaths: ReadonlyMap<string, string>;
  readonly entryPaths: ReadonlyMap<string, string>;
  readonly schedulePath: string;
  readonly schedule: RenderedScheduleManifest;
}

const RUNTIME_PATH = "runtime.cjs";
const SCHEDULE_PATH = "schedule.json";

export function renderProgram(program: ProgramModel): RenderedProgram {
  const validationErrors = validateProgramModel(program);
  if (validationErrors.length > 0) {
    throw new Error(
      ["Cannot render invalid program:", ...validationErrors.map((error) => `- ${error}`)].join(
        "\n",
      ),
    );
  }

  const modulePaths = new Map(
    program.modules.map((module, index) => [module.id, modulePath(index, module.format)]),
  );
  const requestedExports = collectRequestedExports(program);
  const files: RenderedFile[] = [{ path: RUNTIME_PATH, contents: renderRuntime() }];

  for (const module of program.modules) {
    const path = getRequiredPath(modulePaths, module.id);
    files.push({
      path,
      contents: renderModule(module, modulePaths, requestedExports.get(module.id) ?? []),
    });
  }

  const entryPaths = new Map(
    program.entries.map((entry) => [entry.name, getRequiredPath(modulePaths, entry.moduleId)]),
  );
  const schedule: RenderedScheduleManifest = {
    version: 1,
    entries: program.entries.map((entry) => renderScheduleEntry(entry, modulePaths, program)),
    operations: program.schedule.map((operation) => ({ ...operation })),
  };
  files.push({
    path: SCHEDULE_PATH,
    contents: `${JSON.stringify(schedule, null, 2)}\n`,
  });

  return {
    files,
    modulePaths,
    entryPaths,
    schedulePath: SCHEDULE_PATH,
    schedule,
  };
}

function modulePath(index: number, format: ModuleFormat): string {
  const extension = format === "esm" ? "mjs" : "cjs";
  return `module-${String(index).padStart(4, "0")}.${extension}`;
}

function collectRequestedExports(program: ProgramModel): ReadonlyMap<string, readonly string[]> {
  const requestedExports = new Map<string, string[]>();

  for (const module of program.modules) {
    for (const dependency of module.dependencies) {
      if (dependency.kind !== "esm-value-import") {
        continue;
      }

      const names = requestedExports.get(dependency.target);
      if (names === undefined) {
        requestedExports.set(dependency.target, [dependency.importedName]);
      } else if (!names.includes(dependency.importedName)) {
        names.push(dependency.importedName);
      }
    }
  }

  return requestedExports;
}

function renderModule(
  module: ModuleModel,
  modulePaths: ReadonlyMap<string, string>,
  requestedExports: readonly string[],
): string {
  if (module.format === "cjs") {
    const requireLines = [`require("./${RUNTIME_PATH}");`];
    for (const dependency of module.dependencies) {
      requireLines.push(`require("./${getRequiredPath(modulePaths, dependency.target)}");`);
    }

    const sections: string[][] = [requireLines];
    if (module.events.length > 0) {
      sections.push(renderEvents(module));
    }
    if (requestedExports.length > 0) {
      sections.push(renderCjsExports(requestedExports));
    }

    return renderSections(sections);
  }

  const importLines = [`import "./${RUNTIME_PATH}";`];
  const dynamicRegistrationLines: string[] = [];
  const usedBindings = new Set<string>();
  for (const dependency of module.dependencies) {
    const targetPath = getRequiredPath(modulePaths, dependency.target);
    if (dependency.kind === "esm-side-effect-import") {
      importLines.push(`import "./${targetPath}";`);
    } else if (dependency.kind === "esm-value-import") {
      usedBindings.add(dependency.localName);
      importLines.push(
        `import { ${dependency.importedName} as ${dependency.localName} } from "./${targetPath}";`,
      );
    } else {
      dynamicRegistrationLines.push(
        `globalThis.__orderDynamicImports[${serializeJavaScriptValue(dependency.registration)}] = () => import("./${targetPath}");`,
      );
    }
  }

  const sections: string[][] = [importLines];
  if (module.hasTopLevelAwait === true) {
    sections.push(["await 0;"]);
  }
  if (dynamicRegistrationLines.length > 0) {
    sections.push(dynamicRegistrationLines);
  }
  if (module.events.length > 0) {
    sections.push(renderEvents(module));
  }
  if (requestedExports.length > 0) {
    sections.push(renderEsmExports(requestedExports, usedBindings));
  }

  return renderSections(sections);
}

function renderEvents(module: ModuleModel): string[] {
  return module.events.map(
    (event) => `globalThis.__orderEvent(${serializeJavaScriptValue(event)});`,
  );
}

function renderCjsExports(requestedExports: readonly string[]): string[] {
  if (requestedExports.length === 1 && requestedExports[0] === "default") {
    return ['module.exports = "default";'];
  }

  if (requestedExports.includes("default")) {
    return [
      "module.exports = {};",
      ...requestedExports
        .filter((name) => name !== "default")
        .map((name) => renderCjsNamedExport("module.exports", name)),
    ];
  }

  return requestedExports.map((name) => renderCjsNamedExport("exports", name));
}

function renderCjsNamedExport(target: "exports" | "module.exports", name: string): string {
  return name === "__proto__"
    ? `Object.defineProperty(${target}, "__proto__", { value: "__proto__", enumerable: true });`
    : `${target}.${name} = ${serializeJavaScriptValue(name)};`;
}

function renderEsmExports(
  requestedExports: readonly string[],
  usedBindings: Set<string>,
): string[] {
  const lines: string[] = [];
  let candidateIndex = 0;

  for (const exportName of requestedExports) {
    let bindingName: string;
    do {
      bindingName = `__orderExport${candidateIndex}`;
      candidateIndex += 1;
    } while (usedBindings.has(bindingName));

    usedBindings.add(bindingName);
    lines.push(
      `const ${bindingName} = ${serializeJavaScriptValue(exportName)};`,
      `export { ${bindingName} as ${exportName} };`,
    );
  }

  return lines;
}

function renderSections(sections: readonly (readonly string[])[]): string {
  return `${sections.map((section) => section.join("\n")).join("\n\n")}\n`;
}

function serializeJavaScriptValue(value: unknown): string {
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function renderScheduleEntry(
  entry: EntryModel,
  modulePaths: ReadonlyMap<string, string>,
  program: ProgramModel,
): RenderedScheduleEntry {
  const module = program.modules.find((candidate) => candidate.id === entry.moduleId);
  if (module === undefined) {
    throw new Error(`Missing entry module ${JSON.stringify(entry.moduleId)}`);
  }

  return {
    name: entry.name,
    path: getRequiredPath(modulePaths, entry.moduleId),
    format: module.format,
  };
}

function renderRuntime(): string {
  return [
    "globalThis.__orderEvents ??= [];",
    "globalThis.__orderEvent ??= (event) => {",
    "  globalThis.__orderEvents.push(event);",
    "};",
    "globalThis.__orderDynamicImports ??= Object.create(null);",
    "",
  ].join("\n");
}

function getRequiredPath(paths: ReadonlyMap<string, string>, id: string): string {
  const path = paths.get(id);
  if (path === undefined) {
    throw new Error(`Missing rendered path for module ${JSON.stringify(id)}`);
  }
  return path;
}
