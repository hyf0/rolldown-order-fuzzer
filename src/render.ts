/// <reference types="node" />

import { posix } from "node:path";

import {
  localExportsFor,
  renderedFormOf,
  type AnalyzedProgram,
  type RenderedExportForm,
} from "./analyzed-program.ts";
import type {
  EntryModel,
  EsmDynamicImportOperation,
  ModuleFormat,
  ModuleModel,
  ProgramModel,
  ValueRead,
} from "./model.ts";
import { moduleProfile, readableBindingsOf } from "./model.ts";
import type { ExecutionManifest, ExecutionManifestEntry } from "./protocol.ts";
import { EXECUTION_PROTOCOL_VERSION } from "./protocol.ts";
import { INVALID_MODULE_BINDING_IDENTIFIERS, validateProgramModel } from "./validate-model.ts";

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

export function renderProgram(analyzed: AnalyzedProgram): RenderedProgram {
  // The consumer takes ONLY the AnalyzedProgram and reads the program from it, so the program can never
  // disagree with the analysis it is rendered against (the mismatch is unrepresentable). A standalone
  // caller wraps `analyzeProgram(program)`.
  const { program, plan } = analyzed;
  const validationErrors = validateProgramModel(analyzed);
  if (validationErrors.length > 0) {
    throw new Error(
      ["Cannot render invalid program:", ...validationErrors.map((error) => `- ${error}`)].join(
        "\n",
      ),
    );
  }

  // The ONE analyzed view: the renderer reads the plan's `requestedNames` (which names each module must
  // expose) and the analyzer's `renderedFormOf` classification (its SINGLE export-form dispatch), instead
  // of re-running its own `collectRequestedExports` fixpoint or re-classifying export shape from the module
  // profile. Threaded in along the case path so demand analysis runs ONCE.
  const isMetadataPure = (module: ModuleModel): boolean =>
    moduleProfile(module).purity.kind === "metadata";
  const modulePaths = new Map(
    program.modules.map((module, index) => [
      module.id,
      modulePath(index, module.format, isMetadataPure(module)),
    ]),
  );
  const files: RenderedFile[] = [];

  for (const module of program.modules) {
    const path = getRequiredPath(modulePaths, module.id);
    files.push({
      path,
      contents: renderModule(
        module,
        modulePaths,
        plan.requestedNames.get(module.id) ?? [],
        (name) => renderedFormOf(module, name, plan.callableNames),
      ),
    });
  }

  // A single synthetic package.json marks every flagged module's directory as side-effect-free.
  if (program.modules.some(isMetadataPure)) {
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

/// Dependencies render ONE statement each in DEPENDENCY-ARRAY ORDER — a single ordered stream, not the
/// category buckets this used to collect (all imports, then all re-exports, then all dynamics). No dedup
/// by specifier, so a multi-kind pair (the same target imported statically AND dynamically) emits
/// several legal statements for one specifier. ESM emits one ordered static-request stream spanning
/// `import` and `export … from` re-exports (interleaved per model order), with dynamic-import
/// registrations in their array slots too; CJS emits one ordered executable stream of requires and
/// dynamic registrations in model order. This restores the long-standing "in array order" contract the
/// consolidation wave had pinned to category order: the model permits a module that BOTH imports and
/// re-exports (the coming interop/package barrels), whose requested-module evaluation order follows
/// source position, so the emitted order MUST equal the model's dependency order for the validator's
/// evaluation-order reasoning to match what Rolldown sees. See
/// `.agents/docs/renderer-dependency-order.md`.
function renderModule(
  module: ModuleModel,
  modulePaths: ReadonlyMap<string, string>,
  requestedExports: readonly string[],
  formOf: (name: string) => RenderedExportForm,
): string {
  const readable = readableBindingsOf(module.dependencies);
  const selfPath = getRequiredPath(modulePaths, module.id);
  const dynamicRegistration = (dependency: EsmDynamicImportOperation, specifier: string): string =>
    `globalThis.__orderDynamicImports[${serializeJavaScriptValue(dependency.registration)}] = () => import("${specifier}");`;

  if (module.format === "cjs") {
    const dependencyLines: string[] = [];
    for (const dependency of module.dependencies) {
      const specifier = importSpecifier(selfPath, getRequiredPath(modulePaths, dependency.target));
      if (dependency.kind === "esm-dynamic-import") {
        // `import()` is legal inside CommonJS in Node.
        dependencyLines.push(dynamicRegistration(dependency, specifier));
      } else if (dependency.resultBinding !== undefined) {
        // Bind the require result so the target's exports can be read into events and exports.
        dependencyLines.push(`const ${dependency.resultBinding} = require("${specifier}");`);
      } else {
        dependencyLines.push(`require("${specifier}");`);
      }
    }

    const sections: string[][] = [];
    if (dependencyLines.length > 0) {
      sections.push(dependencyLines);
    }
    if (module.events.length > 0) {
      sections.push(renderEvents(module));
    }
    if (requestedExports.length > 0) {
      sections.push(renderCjsExports(module, requestedExports, readable));
    }

    return renderSections(sections);
  }

  const dependencyLines: string[] = [];
  const usedBindings = new Set<string>();
  // A LOCAL re-export renders as TWO statements: the live `import { source as local }` in the
  // dependency stream (its array slot — the import is a real record whose order matters), and a
  // source-less `export { local as exported };` clause emitted with the module's exports (the
  // camunda package-barrel shape: the module imports the binding, runs its own side effects, and
  // re-exports the binding it holds).
  const localReexportLines: string[] = [];
  for (const dependency of module.dependencies) {
    const specifier = importSpecifier(selfPath, getRequiredPath(modulePaths, dependency.target));
    if (dependency.kind === "esm-side-effect-import") {
      dependencyLines.push(`import "${specifier}";`);
    } else if (dependency.kind === "esm-value-import") {
      usedBindings.add(dependency.localName);
      dependencyLines.push(
        `import { ${dependency.importedName} as ${dependency.localName} } from "${specifier}";`,
      );
    } else if (dependency.kind === "esm-namespace-import") {
      usedBindings.add(dependency.localName);
      dependencyLines.push(`import * as ${dependency.localName} from "${specifier}";`);
    } else if (dependency.kind === "esm-reexport-named") {
      dependencyLines.push(
        dependency.sourceName === dependency.exportedName
          ? `export { ${dependency.sourceName} } from "${specifier}";`
          : `export { ${dependency.sourceName} as ${dependency.exportedName} } from "${specifier}";`,
      );
    } else if (dependency.kind === "esm-reexport-star") {
      dependencyLines.push(`export * from "${specifier}";`);
    } else if (dependency.kind === "esm-local-reexport") {
      usedBindings.add(dependency.localName);
      dependencyLines.push(
        `import { ${dependency.sourceName} as ${dependency.localName} } from "${specifier}";`,
      );
      localReexportLines.push(
        dependency.localName === dependency.exportedName
          ? `export { ${dependency.localName} };`
          : `export { ${dependency.localName} as ${dependency.exportedName} };`,
      );
    } else {
      dependencyLines.push(dynamicRegistration(dependency, specifier));
    }
  }

  const localExports = localExportsFor(module, requestedExports);
  const sections: string[][] = [];
  if (dependencyLines.length > 0) {
    sections.push(dependencyLines);
  }
  if (module.hasTopLevelAwait === true) {
    sections.push(["await 0;"]);
  }
  if (module.events.length > 0) {
    sections.push(renderEvents(module));
  }
  const exportLines = [
    ...localReexportLines,
    ...(localExports.length > 0
      ? renderEsmExports(module, localExports, usedBindings, readable, formOf)
      : []),
  ];
  if (exportLines.length > 0) {
    sections.push(exportLines);
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
/// The numeric base a definer's synthesized value folds onto, read through the ONE ModuleProfile
/// projection: an inferred-pure definer's build-function base (`purity.base`, the canonical form of the
/// `pureBase` flag), else the module's first event value. The renderer never inspects the raw purity
/// flags directly, so the profile stays the single interpreter of them.
function definerBase(module: ModuleModel): number {
  const purity = moduleProfile(module).purity;
  return purity.kind === "inferred" ? purity.base : moduleStateBase(module);
}

function renderInferredPureExports(
  module: ModuleModel,
  requestedExports: readonly string[],
  usedBindings: Set<string>,
  readable: readonly ValueRead[],
): string[] {
  const base = definerBase(module);
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
  const base = definerBase(module);
  const buildName = freshBinding(usedBindings, "__ownStateBuild");
  const stateName = freshBinding(usedBindings, "__ownState");
  const lines = [
    `function ${buildName}() { return ${base}; }`,
    `let ${stateName} = /* @__PURE__ */ ${buildName}();`,
  ];
  for (const [index, exportName] of requestedExports.entries()) {
    lines.push(
      ...renderSynthesizedExport(
        exportName,
        usedBindings,
        "__ownStateExport",
        (binding) => `function ${binding}() { return ${stateName} + ${index + 1}; }`,
      ),
    );
  }
  return lines;
}

/// Each demanded export rendered as a fresh OBJECT literal (`export const name = { v: <base> }`).
/// The object's own value is immaterial to the witness — identity is compared, not the number — but a
/// base keeps it non-empty. Every module evaluation creates a distinct object, so a consumer that
/// captures the export through two paths sees one object on a correct (single-evaluation) build and
/// two on a silently double-run init. Object exports emit no events (the invisible double-init
/// target). See `.agents/docs/object-identity-and-callable-own-state.md`.
function renderObjectExports(
  module: ModuleModel,
  requestedExports: readonly string[],
  usedBindings: Set<string>,
): string[] {
  const base = moduleStateBase(module);
  return requestedExports.flatMap((exportName) =>
    renderSynthesizedExport(
      exportName,
      usedBindings,
      "__objectExport",
      (binding) => `const ${binding} = { v: ${base} };`,
    ),
  );
}

/// Whether `name` can be a DECLARATION name (`export function name` / `export const name`). A reserved
/// word — notably `default`, from the `export { default as X }` re-export shape — is a valid export name
/// but not a valid declaration name, so a definer synthesizing it must render a fresh local plus
/// `export { local as name }`. Generated export names are always plain identifiers, so the corpus never
/// takes the fresh-local path (this is byte-identical there) and only hand-crafted models exercise it.
function isDeclarableName(name: string): boolean {
  return !INVALID_MODULE_BINDING_IDENTIFIERS.has(name);
}

/// Render one synthesized export as either a direct exported declaration (a plain identifier name) or,
/// for a reserved name, a fresh local declaration plus an `export { local as name }` alias. `define`
/// renders the declaration DEFINING a binding WITHOUT the `export` keyword (a `function binding() {…}`
/// or a `const binding = …`); a declarable name gets `export ` prepended, a reserved one is aliased.
function renderSynthesizedExport(
  exportName: string,
  usedBindings: Set<string>,
  localPrefix: string,
  define: (binding: string) => string,
): string[] {
  if (isDeclarableName(exportName)) {
    return [`export ${define(exportName)}`];
  }
  const local = freshBinding(usedBindings, localPrefix);
  return [define(local), `export { ${local} as ${exportName} };`];
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
  formOf: (name: string) => RenderedExportForm,
): string[] {
  // The analyzer's `renderedFormOf` classification (`formOf`) is the renderer's SINGLE export-form
  // dispatch — the module-profile switch that used to re-classify fresh-object / callable-own-state /
  // inferred-pure HERE is gone, so export-shape classification lives in ONE place. The three whole-module
  // export shapes classify every requested export identically, so the first export's form selects the
  // module template; a numeric-fold definer splits per export (below). `renderedFormOf` derives these
  // forms from the SAME profile the deleted switch read, so the emitted bytes are unchanged.
  const firstName = requestedExports[0];
  if (firstName === undefined) {
    return [];
  }
  switch (formOf(firstName)) {
    case "fresh-object":
      return renderObjectExports(module, requestedExports, usedBindings);
    case "callable-own-state":
      return renderCallableOwnStateExports(module, requestedExports, usedBindings);
    case "inferred-pure":
      return renderInferredPureExports(module, requestedExports, usedBindings, readable);
    case "callable-constant":
    case "numeric-value":
      return renderNumericFoldExports(module, requestedExports, usedBindings, readable, formOf);
  }
}

/// A numeric-fold definer's exports: each name renders a plain folded `const` value, EXCEPT one a DIRECT
/// call import marked callable (`callable-constant`), which renders a hoisted `function` returning the
/// module's constant base. The per-export split is the analyzer's form (`formOf`), NOT a callability set
/// the renderer re-derives — so a call not forwarded through a barrel, or a call of an inferred-pure / CJS
/// numeric export, is rejected at validation rather than mis-rendered here.
function renderNumericFoldExports(
  module: ModuleModel,
  requestedExports: readonly string[],
  usedBindings: Set<string>,
  readable: readonly ValueRead[],
  formOf: (name: string) => RenderedExportForm,
): string[] {
  const base = moduleStateBase(module);
  const lines: string[] = [];
  let candidateIndex = 0;

  for (const exportName of requestedExports) {
    if (formOf(exportName) === "callable-constant") {
      // A hoisted callable export returns a CONSTANT (the module's base), so it is safe to call
      // before this module's body has run (even mid-cycle, up the stack). It deliberately does NOT
      // fold the module's own reads: a callable that called its siblings would mutually recurse
      // around the cycle. The value oracle rides on events and value exports, which fold reads.
      lines.push(
        ...renderSynthesizedExport(
          exportName,
          usedBindings,
          "__callableExport",
          (binding) => `function ${binding}() { return ${base}; }`,
        ),
      );
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
