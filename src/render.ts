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
      contents: renderModule(
        module,
        modulePaths,
        requestedExports.names.get(module.id) ?? [],
        requestedExports.callable.get(module.id) ?? new Set<string>(),
      ),
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

interface RequestedExports {
  /// Per module, the export names it must expose (propagated through re-export chains).
  readonly names: ReadonlyMap<string, readonly string[]>;
  /// Per module, the subset of those names demanded as a CALLABLE function export (`export function
  /// name() { … }`) by a hoisted-function call import. A call import only ever targets a cycle
  /// member directly (never a barrel), so callable-ness is demanded on the definer and never
  /// forwarded through a star re-export.
  readonly callable: ReadonlyMap<string, ReadonlySet<string>>;
}

/// The export names each module must expose, propagated through re-export (barrel) chains. A value
/// import demands its imported name; a namespace import demands each read member; a readable require
/// demands the name it reads; a named re-export always references (demands) its source on the target;
/// a star re-export forwards any name demanded on the barrel down to its target. A call import also
/// records its imported name as callable on the target. The result feeds re-export statements,
/// locally synthesized state-derived exports, and callable function exports (see `localExportsFor`).
function collectRequestedExports(program: ProgramModel): RequestedExports {
  const requestedExports = new Map<string, string[]>();
  const callableExports = new Map<string, Set<string>>();
  const markCallable = (target: string, name: string): void => {
    const names = callableExports.get(target);
    if (names === undefined) {
      callableExports.set(target, new Set([name]));
    } else {
      names.add(name);
    }
  };
  const demand = (target: string, name: string): boolean => {
    const names = requestedExports.get(target);
    if (names === undefined) {
      requestedExports.set(target, [name]);
      return true;
    }
    if (!names.includes(name)) {
      names.push(name);
      return true;
    }
    return false;
  };

  for (const module of program.modules) {
    for (const dependency of module.dependencies) {
      if (dependency.kind === "esm-value-import") {
        demand(dependency.target, dependency.importedName);
        if (dependency.call === true) {
          markCallable(dependency.target, dependency.importedName);
        }
      } else if (dependency.kind === "esm-namespace-import") {
        for (const member of dependency.readMembers) {
          demand(dependency.target, member);
        }
      } else if (dependency.kind === "cjs-require" && dependency.readName !== undefined) {
        demand(dependency.target, dependency.readName);
      } else if (dependency.kind === "esm-reexport-named") {
        // `export { source as exported } from target` references `source` on the target eagerly.
        demand(dependency.target, dependency.sourceName);
      }
    }
  }

  // Fixpoint: a `export * from target` barrel forwards every name demanded on it (that a named
  // re-export does not already provide) to its target, so demand reaches the defining module.
  let changed = true;
  while (changed) {
    changed = false;
    for (const module of program.modules) {
      const starTargets = module.dependencies.flatMap((dependency) =>
        dependency.kind === "esm-reexport-star" ? [dependency.target] : [],
      );
      if (starTargets.length === 0) {
        continue;
      }
      const namedProvided = new Set(
        module.dependencies.flatMap((dependency) =>
          dependency.kind === "esm-reexport-named" ? [dependency.exportedName] : [],
        ),
      );
      // Index iteration tolerates the array growing under a (pathological) self-star; `demand`
      // deduplicates, so the fixpoint still terminates.
      const demandedHere = requestedExports.get(module.id);
      for (let index = 0; index < (demandedHere?.length ?? 0); index += 1) {
        const name = demandedHere?.[index];
        if (name === undefined || namedProvided.has(name)) {
          continue;
        }
        for (const starTarget of starTargets) {
          if (demand(starTarget, name)) {
            changed = true;
          }
        }
      }
    }
  }

  return { names: requestedExports, callable: callableExports };
}

/// The subset of a module's requested exports it must synthesize locally (a state-derived value):
/// everything a re-export does not forward. CJS cannot re-export, so it synthesizes all of them; an
/// ESM barrel forwards names via named re-exports (matched by `exportedName`) or a star re-export
/// (which forwards everything else), leaving a pure barrel with no local exports.
function localExportsFor(module: ModuleModel, requested: readonly string[]): readonly string[] {
  if (module.format === "cjs") {
    return requested;
  }
  const namedProvided = new Set(
    module.dependencies.flatMap((dependency) =>
      dependency.kind === "esm-reexport-named" ? [dependency.exportedName] : [],
    ),
  );
  const hasStar = module.dependencies.some((dependency) => dependency.kind === "esm-reexport-star");
  return requested.filter((name) => !namedProvided.has(name) && !hasStar);
}

function renderModule(
  module: ModuleModel,
  modulePaths: ReadonlyMap<string, string>,
  requestedExports: readonly string[],
  callableExports: ReadonlySet<string>,
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
  const reexportLines: string[] = [];
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
    } else if (dependency.kind === "esm-namespace-import") {
      usedBindings.add(dependency.localName);
      importLines.push(`import * as ${dependency.localName} from "${specifier}";`);
    } else if (dependency.kind === "esm-reexport-named") {
      reexportLines.push(
        dependency.sourceName === dependency.exportedName
          ? `export { ${dependency.sourceName} } from "${specifier}";`
          : `export { ${dependency.sourceName} as ${dependency.exportedName} } from "${specifier}";`,
      );
    } else if (dependency.kind === "esm-reexport-star") {
      reexportLines.push(`export * from "${specifier}";`);
    } else {
      dynamicRegistrationLines.push(
        `globalThis.__orderDynamicImports[${serializeJavaScriptValue(dependency.registration)}] = () => import("${specifier}");`,
      );
    }
  }

  const localExports = localExportsFor(module, requestedExports);
  const sections: string[][] = [];
  if (importLines.length > 0) {
    sections.push(importLines);
  }
  if (reexportLines.length > 0) {
    sections.push(reexportLines);
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
  if (localExports.length > 0) {
    sections.push(renderEsmExports(module, localExports, usedBindings, readable, callableExports));
  }

  return renderSections(sections);
}

/// The sentinel a guarded cycle read folds to when it observes a not-yet-assigned (partial) CJS
/// export. Any finite number works; it only has to keep the fold numeric so the event channel never
/// rejects a NaN. A mis-timed export assignment then diverges as sentinel-vs-value rather than
/// crashing identically on both sides. See the `guard` flag in model.ts.
const PARTIAL_READ_SENTINEL = -1;

function renderRead(read: ValueRead): string {
  const access = read.member === undefined ? read.binding : `${read.binding}.${read.member}`;
  // A call read folds a hoisted function's return value; safe to call before the defining module's
  // body has run (function declarations initialize first), so it never hits TDZ across a cycle edge.
  const expression = read.call === true ? `${access}()` : access;
  // A guarded read stays total when the target export is partial mid-cycle (undefined -> sentinel).
  return read.guard === true
    ? `(Number.isFinite(${expression}) ? ${expression} : ${PARTIAL_READ_SENTINEL})`
    : expression;
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
  callableExports: ReadonlySet<string>,
): string[] {
  const base = moduleStateBase(module);
  const lines: string[] = [];
  let candidateIndex = 0;

  for (const exportName of requestedExports) {
    if (callableExports.has(exportName)) {
      // A hoisted callable export returns a CONSTANT (the module's base), so it is safe to call
      // before this module's body has run (even mid-cycle, up the stack). It deliberately does NOT
      // fold the module's own reads: a callable that called its siblings would mutually recurse
      // around the cycle. The value oracle rides on events and value exports, which fold reads.
      lines.push(`export function ${exportName}() { return ${base}; }`);
      continue;
    }

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
