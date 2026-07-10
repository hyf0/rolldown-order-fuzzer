/// <reference types="node" />

import { posix } from "node:path";

import { collectRequestedExports, localExportsFor } from "./analyzed-program.ts";
import type { EntryModel, ModuleFormat, ModuleModel, ProgramModel, ValueRead } from "./model.ts";
import { moduleProfile, readableBindingsOf } from "./model.ts";
import type { ExecutionManifest, ExecutionManifestEntry } from "./protocol.ts";
import { EXECUTION_PROTOCOL_VERSION } from "./protocol.ts";
import { validateProgramModel } from "./validate-model.ts";

export interface RenderedFile {
  readonly path: string;
  readonly contents: string;
}

export interface RenderedProgram {
  readonly files: readonly RenderedFile[];
  readonly modulePaths: ReadonlyMap<string, string>;
  readonly entryPaths: ReadonlyMap<string, string>;
  readonly schedulePath: string;
  readonly schedule: ExecutionManifest;
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
        requestedExports.requestedNames.get(module.id) ?? [],
        requestedExports.callableNames.get(module.id) ?? new Set<string>(),
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
  const schedule: ExecutionManifest = {
    version: EXECUTION_PROTOCOL_VERSION,
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

/// Dependencies render one statement each — no dedup by specifier, so a multi-kind pair (the same
/// target imported statically AND dynamically) emits several legal statements for one specifier. The
/// emission order is deterministic but currently BY CATEGORY, not by dependency-array position: CJS
/// emits all requires, then all dynamic registrations; ESM emits all static imports, then all
/// re-exports, then all dynamic registrations. Because generated barrels are re-export-only and a
/// module never mixes imports with re-exports of overlapping requested-module order, this matches
/// array order today — but the model permits a module that both imports and re-exports, whose
/// requested-module evaluation order this category grouping would reorder. Correcting it to a single
/// ordered requested-module stream is scheduled for the next interop wave (which re-accepts the
/// corpus); the current category order is PINNED by `render.test.ts` so the change is deliberate. See
/// `.agents/docs/renderer-dependency-order.md`.
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

/// The offset an object-identity event folds in when the two captured references are NOT the same
/// object (`identityCheck`). Any large, distinctive number works: on a correct build the captures are
/// one object (`+ 0`, value unchanged); only a silently double-run init makes a late capture a new
/// object, shifting the value by this sentinel so the differential oracle catches it. Far above the
/// generator's bounded folds, so it never collides with a legitimate value.
const OBJECT_IDENTITY_MISMATCH_SENTINEL = 987_654_321;

function renderRead(read: ValueRead): string {
  let access: string;
  if (read.member === undefined) {
    access = read.binding;
  } else if (read.computed === true) {
    // `binding[<runtime key>]` — the member name is built at runtime (a split literal the bundler
    // cannot fold to `binding.member`), so which export is used stays statically invisible. Same
    // observed value as `binding.member` (validated to a namespace member).
    access = `${read.binding}[${computedMemberKey(read.member)}]`;
  } else {
    access = `${read.binding}.${read.member}`;
  }
  // A call read folds a hoisted function's return value; safe to call before the defining module's
  // body has run (function declarations initialize first), so it never hits TDZ across a cycle edge.
  const expression = read.call === true ? `${access}()` : access;
  // A guarded read stays total when the target export is partial mid-cycle (undefined -> sentinel).
  return read.guard === true
    ? `(Number.isFinite(${expression}) ? ${expression} : ${PARTIAL_READ_SENTINEL})`
    : expression;
}

/// A runtime-built key for a computed member read `binding[key]`. Splitting the member name into two
/// non-empty string literals joined with `+` yields the exact member name at runtime while keeping
/// the access statically unresolvable (the bundler cannot fold it to `binding.member`), so on-demand
/// wrapping's per-export liveness cannot see which export is used. A single-character name repeats
/// the empty-string base, which is still a runtime concatenation.
function computedMemberKey(member: string): string {
  const split = member.length > 1 ? Math.floor(member.length / 2) : member.length;
  const head = serializeJavaScriptValue(member.slice(0, split));
  const tail = serializeJavaScriptValue(member.slice(split));
  return `${head} + ${tail}`;
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
  const lines: string[] = [];
  let hiddenReadCounter = 0;
  for (const event of module.events) {
    if (event.identityCheck !== undefined) {
      // Fold an object-identity comparison: `value + ((left === right) ? 0 : sentinel)`. The two
      // bindings capture the same object export through different paths; a correct build keeps them
      // one object (`+ 0`), a silently double-run init makes a late capture a new object (`+ sentinel`).
      const identityBase = typeof event.value === "number" ? event.value : 0;
      const { leftBinding, rightBinding } = event.identityCheck;
      lines.push(
        `globalThis.__orderEvent({ module: ${serializeJavaScriptValue(
          event.module,
        )}, phase: ${serializeJavaScriptValue(
          event.phase,
        )}, value: ${identityBase} + ((${leftBinding} === ${rightBinding}) ? 0 : ${OBJECT_IDENTITY_MISMATCH_SENTINEL}) });`,
      );
      continue;
    }
    if (event.reads === undefined || event.reads.length === 0) {
      // No reads: keep the exact compact-JSON payload the oracle has always emitted.
      lines.push(
        `globalThis.__orderEvent(${serializeJavaScriptValue({
          module: event.module,
          phase: event.phase,
          value: event.value,
        })});`,
      );
      continue;
    }
    // Fold the read dependency values into the payload so cross-module data flow is observed.
    // Validation guarantees a finite numeric base whenever reads are present.
    const base = typeof event.value === "number" ? event.value : 0;
    const eventHead = `globalThis.__orderEvent({ module: ${serializeJavaScriptValue(
      event.module,
    )}, phase: ${serializeJavaScriptValue(event.phase)}, value: `;
    if (event.hiddenReadFn === true) {
      // Hide the reads inside a local function called at top level: the observed value is identical
      // to a direct read (`base + hidden()`), but the read is lexically inside a function body, so a
      // bundler that determines init order from top-level uses alone can miss it (family B).
      const functionName = `__hiddenRead${hiddenReadCounter}`;
      hiddenReadCounter += 1;
      lines.push(
        `function ${functionName}() { return ${event.reads.map(renderRead).join(" + ")}; }`,
        `${eventHead}${base} + ${functionName}() });`,
      );
      continue;
    }
    lines.push(`${eventHead}${renderFold(base, event.reads)} });`);
  }
  return lines;
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

/// An inferred-pure definer synthesizes each demanded export as a NON-INLINABLE value: a
/// `/* @__PURE__ */`-annotated call of a local build function (folding the module's own forward
/// reads). The bundler infers the top level pure (so it may order-wrap or drop the module), yet the
/// call form prevents constant-folding the value to a literal, so a dropped init surfaces as an
/// `undefined` read downstream. No events are emitted (validated).
function renderInferredPureExports(
  module: ModuleModel,
  requestedExports: readonly string[],
  usedBindings: Set<string>,
  readable: readonly ValueRead[],
): string[] {
  const base = module.pureBase ?? moduleStateBase(module);
  const lines: string[] = [];
  let index = 0;
  for (const exportName of requestedExports) {
    let buildName: string;
    let valueName: string;
    do {
      buildName = `__pureBuild${index}`;
      valueName = `__pureValue${index}`;
      index += 1;
    } while (usedBindings.has(buildName) || usedBindings.has(valueName));
    usedBindings.add(buildName);
    usedBindings.add(valueName);
    const folded = [`/* @__PURE__ */ ${buildName}()`, ...readable.map(renderRead)].join(" + ");
    lines.push(
      `function ${buildName}() { return ${base}; }`,
      `const ${valueName} = ${folded};`,
      `export { ${valueName} as ${exportName} };`,
    );
  }
  return lines;
}

/// A module-scope MUTABLE state variable assigned during init from a non-inlinable
/// `/* @__PURE__ */`-annotated build call, plus every demanded export rendered as a FUNCTION that
/// READS that state (`export function name() { return __ownState + <k> }`). This is the d3-scale
/// `unit`/`rescale` shape: a consumer that CALLS the export folds `__ownState + <k>`, so a dropped
/// init (which never assigns `__ownState`) surfaces as an `undefined` read → NaN downstream. The
/// build-call form keeps the state a runtime binding (a plain literal would be constant-folded and
/// inlined into the function body, masking the dropped init), exactly as an inferred-pure definer's
/// value does. All statements are pure (a `let` from a pure call, function declarations), so the
/// bundler still infers the module side-effect-free when it carries no events. The state base is the
/// module's `pureBase` when inferred-pure, else its first event value. See
/// `.agents/docs/object-identity-and-callable-own-state.md`.
function renderCallableOwnStateExports(
  module: ModuleModel,
  requestedExports: readonly string[],
  usedBindings: Set<string>,
): string[] {
  const base = module.inferredPure === true ? (module.pureBase ?? 0) : moduleStateBase(module);
  const buildName = freshBinding(usedBindings, "__ownStateBuild");
  const stateName = freshBinding(usedBindings, "__ownState");
  const lines = [
    `function ${buildName}() { return ${base}; }`,
    `let ${stateName} = /* @__PURE__ */ ${buildName}();`,
  ];
  for (const [index, exportName] of requestedExports.entries()) {
    lines.push(`export function ${exportName}() { return ${stateName} + ${index + 1}; }`);
  }
  return lines;
}

/// Each demanded export rendered as a fresh OBJECT literal (`export const name = { v: <base> }`).
/// The object's own value is immaterial to the witness — identity is compared, not the number — but a
/// base keeps it non-empty. Every module evaluation creates a distinct object, so a consumer that
/// captures the export through two paths sees one object on a correct (single-evaluation) build and
/// two on a silently double-run init. Object exports emit no events (the invisible double-init
/// target). See `.agents/docs/object-identity-and-callable-own-state.md`.
function renderObjectExports(module: ModuleModel, requestedExports: readonly string[]): string[] {
  const base = moduleStateBase(module);
  return requestedExports.map((exportName) => `export const ${exportName} = { v: ${base} };`);
}

/// A fresh module-local binding with the given prefix that does not collide with any already-used
/// binding (import locals, other synthesized names). Registers the chosen name so later calls avoid it.
function freshBinding(usedBindings: Set<string>, prefix: string): string {
  let index = 0;
  let name = `${prefix}${index}`;
  while (usedBindings.has(name)) {
    index += 1;
    name = `${prefix}${index}`;
  }
  usedBindings.add(name);
  return name;
}

function renderEsmExports(
  module: ModuleModel,
  requestedExports: readonly string[],
  usedBindings: Set<string>,
  readable: readonly ValueRead[],
  callableExports: ReadonlySet<string>,
): string[] {
  // One dispatch on the module's profile. exportShape decides the export FORM (a callable-own-state
  // definer that is also inferred-pure still renders its state-reading callables, so exportShape is
  // checked before purity); a numeric-fold module then splits on inferred vs normal/metadata purity.
  const profile = moduleProfile(module);
  if (profile.exportShape.kind === "fresh-object") {
    return renderObjectExports(module, requestedExports);
  }
  if (profile.exportShape.kind === "callable-own-state") {
    return renderCallableOwnStateExports(module, requestedExports, usedBindings);
  }
  if (profile.purity.kind === "inferred") {
    return renderInferredPureExports(module, requestedExports, usedBindings, readable);
  }

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
): ExecutionManifestEntry {
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
