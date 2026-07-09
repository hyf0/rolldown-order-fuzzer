/// <reference types="node" />

import { posix } from "node:path";

import type { EntryModel, ModuleFormat, ModuleModel, ProgramModel, ValueRead } from "./model.ts";
import { readableBindingsOf } from "./model.ts";
import type { ExecutionManifest, ExecutionManifestEntry } from "./protocol.ts";
import { validateProgramModel } from "./validate-model.ts";

export interface RenderedFile {
  readonly path: string;
  readonly contents: string;
}

export type RenderedScheduleEntry = ExecutionManifestEntry;

export type RenderedScheduleManifest = ExecutionManifest;

export interface RenderedProgram {
  readonly files: readonly RenderedFile[];
  readonly modulePaths: ReadonlyMap<string, string>;
  readonly entryPaths: ReadonlyMap<string, string>;
  readonly schedulePath: string;
  readonly schedule: RenderedScheduleManifest;
}

const SCHEDULE_PATH = "schedule.json";

/// Flagged (`sideEffectFree`) modules render under this directory, which carries a `package.json`
/// asserting `"sideEffects": false`. Rolldown resolves the nearest `package.json` per module and
/// honors the flag for files below this root (verified empirically), while the source tree stays
/// executable because `.mjs`/`.cjs` files ignore `package.json`. Root modules have no such
/// `package.json`, so the bundler keeps their side effects by default.
const SIDE_EFFECT_FREE_DIRECTORY = "side-effect-free";
const SIDE_EFFECT_FREE_PACKAGE_JSON = '{\n  "sideEffects": false\n}\n';

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
    program.modules.map((module, index) => [
      module.id,
      modulePath(index, module.format, module.sideEffectFree === true),
    ]),
  );
  const requestedExports = collectRequestedExports(program);
  const files: RenderedFile[] = [];

  for (const module of program.modules) {
    const path = getRequiredPath(modulePaths, module.id);
    files.push({
      path,
      contents: renderModule(module, modulePaths, requestedExports.get(module.id) ?? []),
    });
  }

  // A single synthetic package.json marks every flagged module's directory as side-effect-free.
  if (program.modules.some((module) => module.sideEffectFree === true)) {
    files.push({
      path: `${SIDE_EFFECT_FREE_DIRECTORY}/package.json`,
      contents: SIDE_EFFECT_FREE_PACKAGE_JSON,
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

function modulePath(index: number, format: ModuleFormat, sideEffectFree: boolean): string {
  const extension = format === "esm" ? "mjs" : "cjs";
  const base = `module-${String(index).padStart(4, "0")}.${extension}`;
  return sideEffectFree ? `${SIDE_EFFECT_FREE_DIRECTORY}/${base}` : base;
}

/// A relative import specifier from one rendered module to another, honoring the side-effect-free
/// subdirectory. Root-to-root keeps the historical `./module-NNNN.ext` form; crossing the
/// side-effect-free boundary yields `./side-effect-free/…` or `../…`.
function importSpecifier(fromPath: string, toPath: string): string {
  const specifier = posix.relative(posix.dirname(fromPath), toPath);
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

function collectRequestedExports(program: ProgramModel): ReadonlyMap<string, readonly string[]> {
  const requestedExports = new Map<string, string[]>();
  const demand = (target: string, name: string): void => {
    const names = requestedExports.get(target);
    if (names === undefined) {
      requestedExports.set(target, [name]);
    } else if (!names.includes(name)) {
      names.push(name);
    }
  };

  for (const module of program.modules) {
    for (const dependency of module.dependencies) {
      // A value import demands its imported name; a readable require demands the name it reads off
      // the required module's exports. Both synthesize a state-derived export on the target.
      if (dependency.kind === "esm-value-import") {
        demand(dependency.target, dependency.importedName);
      } else if (dependency.kind === "cjs-require" && dependency.readName !== undefined) {
        demand(dependency.target, dependency.readName);
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
  const readable = readableBindingsOf(module.dependencies);
  const selfPath = getRequiredPath(modulePaths, module.id);

  if (module.format === "cjs") {
    const requireLines: string[] = [];
    const dynamicRegistrationLines: string[] = [];
    for (const dependency of module.dependencies) {
      const specifier = importSpecifier(selfPath, getRequiredPath(modulePaths, dependency.target));
      if (dependency.kind === "esm-dynamic-import") {
        // `import()` is legal inside CommonJS in Node.
        dynamicRegistrationLines.push(
          `globalThis.__orderDynamicImports[${serializeJavaScriptValue(dependency.registration)}] = () => import("${specifier}");`,
        );
      } else if (dependency.resultBinding !== undefined) {
        // Bind the require result so the target's exports can be read into events and exports.
        requireLines.push(`const ${dependency.resultBinding} = require("${specifier}");`);
      } else {
        requireLines.push(`require("${specifier}");`);
      }
    }

    const sections: string[][] = [];
    if (requireLines.length > 0) {
      sections.push(requireLines);
    }
    if (dynamicRegistrationLines.length > 0) {
      sections.push(dynamicRegistrationLines);
    }
    if (module.events.length > 0) {
      sections.push(renderEvents(module));
    }
    if (requestedExports.length > 0) {
      sections.push(renderCjsExports(module, requestedExports, readable));
    }

    return renderSections(sections);
  }

  const importLines: string[] = [];
  const dynamicRegistrationLines: string[] = [];
  const usedBindings = new Set<string>();
  for (const dependency of module.dependencies) {
    const specifier = importSpecifier(selfPath, getRequiredPath(modulePaths, dependency.target));
    if (dependency.kind === "esm-side-effect-import") {
      importLines.push(`import "${specifier}";`);
    } else if (dependency.kind === "esm-value-import") {
      usedBindings.add(dependency.localName);
      importLines.push(
        `import { ${dependency.importedName} as ${dependency.localName} } from "${specifier}";`,
      );
    } else {
      dynamicRegistrationLines.push(
        `globalThis.__orderDynamicImports[${serializeJavaScriptValue(dependency.registration)}] = () => import("${specifier}");`,
      );
    }
  }

  const sections: string[][] = [];
  if (importLines.length > 0) {
    sections.push(importLines);
  }
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
    sections.push(renderEsmExports(module, requestedExports, usedBindings, readable));
  }

  return renderSections(sections);
}

function renderRead(read: ValueRead): string {
  return read.member === undefined ? read.binding : `${read.binding}.${read.member}`;
}

/// A numeric fold: a constant base plus every read, as a JavaScript expression. Used for both
/// value-carrying events and state-derived export initializers. Callers guarantee `base` is a
/// finite number whenever `reads` is non-empty, so the expression stays numeric.
function renderFold(base: number, reads: readonly ValueRead[]): string {
  return [String(base), ...reads.map(renderRead)].join(" + ");
}

/// The module's own contribution to its export values: its first finite numeric event value, or 0.
/// Combining this "own state" with the module's dependency reads yields exports that change when a
/// wrong, dropped, or reordered upstream initialization changes what the module observed.
function moduleStateBase(module: ModuleModel): number {
  const first = module.events[0];
  return first !== undefined && typeof first.value === "number" && Number.isFinite(first.value)
    ? first.value
    : 0;
}

function renderEvents(module: ModuleModel): string[] {
  return module.events.map((event) => {
    if (event.reads === undefined || event.reads.length === 0) {
      // No reads: keep the exact compact-JSON payload the oracle has always emitted.
      return `globalThis.__orderEvent(${serializeJavaScriptValue({
        module: event.module,
        phase: event.phase,
        value: event.value,
      })});`;
    }
    // Fold the read dependency values into the payload so cross-module data flow is observed.
    // Validation guarantees a finite numeric base whenever reads are present.
    const base = typeof event.value === "number" ? event.value : 0;
    const valueExpression = renderFold(base, event.reads);
    return `globalThis.__orderEvent({ module: ${serializeJavaScriptValue(
      event.module,
    )}, phase: ${serializeJavaScriptValue(event.phase)}, value: ${valueExpression} });`;
  });
}

function renderCjsExports(
  module: ModuleModel,
  requestedExports: readonly string[],
  readable: readonly ValueRead[],
): string[] {
  const base = moduleStateBase(module);

  if (requestedExports.length === 1 && requestedExports[0] === "default") {
    return [`module.exports = ${renderFold(base, readable)};`];
  }

  if (requestedExports.includes("default")) {
    return [
      "module.exports = {};",
      ...requestedExports
        .filter((name) => name !== "default")
        .map((name) => renderCjsNamedExport("module.exports", name, base, readable)),
    ];
  }

  return requestedExports.map((name) => renderCjsNamedExport("exports", name, base, readable));
}

function renderCjsNamedExport(
  target: "exports" | "module.exports",
  name: string,
  base: number,
  readable: readonly ValueRead[],
): string {
  const value = renderFold(base, readable);
  return name === "__proto__"
    ? `Object.defineProperty(${target}, "__proto__", { value: ${value}, enumerable: true });`
    : `${target}.${name} = ${value};`;
}

function renderEsmExports(
  module: ModuleModel,
  requestedExports: readonly string[],
  usedBindings: Set<string>,
  readable: readonly ValueRead[],
): string[] {
  const base = moduleStateBase(module);
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
      `const ${bindingName} = ${renderFold(base, readable)};`,
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

function getRequiredPath(paths: ReadonlyMap<string, string>, id: string): string {
  const path = paths.get(id);
  if (path === undefined) {
    throw new Error(`Missing rendered path for module ${JSON.stringify(id)}`);
  }
  return path;
}
