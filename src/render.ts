/// <reference types="node" />

import { posix } from "node:path";

import {
  localExportsFor,
  renderedFormOf,
  type AnalyzedProgram,
  type RenderedExportForm,
} from "./analyzed-program.ts";
import {
  globalReadBuiltinSpec,
  projectGlobalReadBuiltinCall,
  renderGlobalReadBuiltinReplacement,
} from "./global-read-builtins.ts";
import {
  globalReadInstanceofSpec,
  renderGlobalReadInstanceofAssignment,
  renderGlobalReadInstanceofExpression,
} from "./global-read-instanceof.ts";
import { globalReadOptimizerExpressionSpec } from "./global-read-optimizer-expressions.ts";
import type {
  EntryModel,
  EsmDynamicImportOperation,
  ModuleFormat,
  ModuleModel,
  PackageMembership,
  ProgramModel,
  ValueRead,
} from "./model.ts";
import {
  globalReadCarrierMemberPath,
  isManualPureSideEffectForm,
  MANUAL_PURE_SIDE_EFFECT_COUNTER_GLOBAL,
  moduleProfile,
  packageMemberFileName,
  packageMembershipOf,
  packagesOf,
  readableBindingsOf,
} from "./model.ts";
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
  //
  // Package members live under fixture-local `node_modules/<name>/<id>.<ext>`; everything else keeps
  // the historical index-named root path, so a package-free program renders byte-identically. The
  // membership comes from the ONE `packagesOf` seam, so a LEGACY model's `sideEffectFree` flags land
  // here as single-member `sideEffects: false` packages — the old shared `side-effect-free/`
  // directory is gone as a separate mechanism.
  const membership = packageMembershipOf(program);
  const modulePaths = new Map(
    program.modules.map((module, index) => {
      const member = membership.get(module.id);
      return [
        module.id,
        member === undefined
          ? modulePath(index, module.format)
          : `node_modules/${member.package.name}/${packageMemberFileName(module)}`,
      ];
    }),
  );
  const files: RenderedFile[] = [];

  for (const module of program.modules) {
    const path = getRequiredPath(modulePaths, module.id);
    files.push({
      path,
      contents: renderModule(
        module,
        modulePaths,
        membership,
        plan.requestedNames.get(module.id) ?? [],
        (name) => renderedFormOf(module, name, plan.callableNames),
      ),
    });
  }

  // Each package's generated package.json: the `name` a bare specifier resolves, the `main` file the
  // bare form lands on (the FIRST member), and the `sideEffects` metadata verbatim.
  const modulesById = new Map(program.modules.map((module) => [module.id, module]));
  for (const pkg of packagesOf(program)) {
    const mainModule = modulesById.get(pkg.moduleIds[0] ?? "");
    if (mainModule === undefined) {
      throw new Error(`Package ${JSON.stringify(pkg.name)} has no main module`);
    }
    const packageJson = {
      name: pkg.name,
      main: `./${packageMemberFileName(mainModule)}`,
      sideEffects: pkg.sideEffects,
    };
    files.push({
      path: `node_modules/${pkg.name}/package.json`,
      contents: `${JSON.stringify(packageJson, null, 2)}\n`,
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

function modulePath(index: number, format: ModuleFormat): string {
  const extension = format === "esm" ? "mjs" : "cjs";
  return `module-${String(index).padStart(4, "0")}.${extension}`;
}

/// The import specifier from one rendered module to another. A target INSIDE a package that the
/// importer is not a member of resolves through node_modules — the BARE package name when the target
/// is the package MAIN (`import … from "pkg"`), a subpath with the file name otherwise
/// (`"pkg/inner.mjs"`); both were smoke-verified to resolve identically under Node and the rolldown
/// build child, including package-to-package bare imports through the flat fixture-local
/// node_modules. Everything else is a relative path: root-to-root keeps the historical
/// `./module-NNNN.ext` form, same-package members are siblings (`./<id>.mjs`), and a package member
/// reaching a root module climbs out (`../../module-NNNN.ext` — path-legal, if rare in real code).
function importSpecifier(
  fromPath: string,
  toPath: string,
  fromMember: PackageMembership | undefined,
  toMember: PackageMembership | undefined,
): string {
  if (toMember !== undefined && toMember.package !== fromMember?.package) {
    return toMember.isMain
      ? toMember.package.name
      : `${toMember.package.name}/${posix.basename(toPath)}`;
  }
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
  membership: ReadonlyMap<string, PackageMembership>,
  requestedExports: readonly string[],
  formOf: (name: string) => RenderedExportForm,
): string {
  const readable = readableBindingsOf(module.dependencies);
  const selfPath = getRequiredPath(modulePaths, module.id);
  const specifierTo = (targetId: string): string =>
    importSpecifier(
      selfPath,
      getRequiredPath(modulePaths, targetId),
      membership.get(module.id),
      membership.get(targetId),
    );
  const dynamicRegistration = (dependency: EsmDynamicImportOperation, specifier: string): string =>
    `globalThis.__orderDynamicImports[${serializeJavaScriptValue(dependency.registration)}] = () => import("${specifier}");`;

  if (module.format === "cjs") {
    const dependencyLines: string[] = [];
    const usedBindings = new Set<string>();
    for (const dependency of module.dependencies) {
      const specifier = specifierTo(dependency.target);
      if (dependency.kind === "esm-dynamic-import") {
        // `import()` is legal inside CommonJS in Node.
        dependencyLines.push(dynamicRegistration(dependency, specifier));
      } else if (dependency.resultBinding !== undefined) {
        // Bind the require result so the target's exports can be read into events and exports.
        usedBindings.add(dependency.resultBinding);
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
      sections.push(renderEvents(module, usedBindings, new Map()));
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
    const specifier = specifierTo(dependency.target);
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
    } else if (dependency.kind === "esm-reexport-namespace") {
      // `export * as ns from "..."` — one named namespace-object export (M7). Emitted directly from
      // the dependency op (it is not driven by requested names): the demand fixpoint routes a nested
      // `outer.ns.member` read through it to the target's `member`.
      dependencyLines.push(`export * as ${dependency.exportedName} from "${specifier}";`);
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
  // Reserve every author-selected local before minting renderer internals. The authored export path
  // deliberately consumes its reserved name later; generated helpers/state/other exports must avoid it.
  for (const binding of module.authoredExportBindings ?? []) {
    usedBindings.add(binding.localName);
  }
  const aliasBindings = allocateAliasBindings(module, usedBindings);

  const localExports = localExportsFor(module, requestedExports);
  const sections: string[][] = [];
  if (dependencyLines.length > 0) {
    sections.push(dependencyLines);
  }
  if (module.hasTopLevelAwait === true) {
    sections.push(["await 0;"]);
  }
  if (module.fixtureFunctionAssignment !== undefined) {
    const assignment = module.fixtureFunctionAssignment;
    sections.push([`globalThis.__orderRead = () => ${assignment.value};`]);
  }
  if ((module.builtinAssignments?.length ?? 0) > 0) {
    sections.push(
      (module.builtinAssignments ?? []).map((assignment) => {
        const spec = globalReadBuiltinSpec(assignment.kind);
        const replacement = renderGlobalReadBuiltinReplacement(spec, assignment.value);
        const counter =
          assignment.counterGlobal === undefined
            ? undefined
            : `globalThis[${serializeJavaScriptValue(assignment.counterGlobal)}]`;
        const initializeCounter = counter === undefined ? "" : `${counter} = 0;\n`;
        return counter === undefined
          ? `${spec.assignmentTarget} = () => ${replacement};`
          : `${initializeCounter}${spec.assignmentTarget} = () => { ${counter} += 1; return ${replacement}; };`;
      }),
    );
  }
  if ((module.instanceofAssignments?.length ?? 0) > 0) {
    sections.push(
      (module.instanceofAssignments ?? []).map((assignment) =>
        renderGlobalReadInstanceofAssignment(globalReadInstanceofSpec(assignment.kind)),
      ),
    );
  }
  if ((module.optimizerExpressionAssignments?.length ?? 0) > 0) {
    sections.push(
      (module.optimizerExpressionAssignments ?? []).map(
        (assignment) => globalReadOptimizerExpressionSpec(assignment.kind).patchStatement,
      ),
    );
  }
  // Alias declarations (`const x = ns;`) for any aliased event reads, emitted BEFORE the events so the
  // alias binds the imported namespace before an event reads through it (FW-B deliverable 3).
  const aliasDeclarations = renderAliasDeclarations(aliasBindings);
  if (aliasDeclarations.length > 0) {
    sections.push(aliasDeclarations);
  }
  if (module.events.length > 0) {
    sections.push(renderEvents(module, usedBindings, aliasBindings));
  }
  const specialExportName = localExports.find((name) => isGlobalReadExportForm(formOf(name)));
  const ordinaryLocalExports =
    specialExportName === undefined
      ? localExports
      : localExports.filter((name) => name !== specialExportName);
  const exportLines = [
    ...localReexportLines,
    ...(specialExportName === undefined
      ? []
      : renderGlobalReadExport(module, usedBindings, formOf(specialExportName))),
    ...(ordinaryLocalExports.length > 0
      ? renderEsmExports(module, ordinaryLocalExports, usedBindings, readable, formOf)
      : []),
  ];
  if (exportLines.length > 0) {
    sections.push(exportLines);
  }

  return renderSections(sections);
}

function isGlobalReadExportForm(form: RenderedExportForm): boolean {
  return form === "global-read-value" || form === "global-read-carrier";
}

function renderGlobalReadExport(
  module: ModuleModel,
  usedBindings: Set<string>,
  renderedForm: RenderedExportForm,
): string[] {
  if (module.format !== "esm" || module.globalReadExport === undefined) {
    return [];
  }
  const read = module.globalReadExport;
  const expectedForm =
    globalReadCarrierMemberPath(read.form) !== undefined
      ? "global-read-carrier"
      : "global-read-value";
  if (renderedForm !== expectedForm) {
    throw new Error(
      `Global-read export ${JSON.stringify(read.exportedName)} classified as ${renderedForm}, expected ${expectedForm}`,
    );
  }
  let globalRead: string;
  let optimizerReaderPrelude: string | undefined;
  if (read.read.kind === "fixture-function-call") {
    globalRead = "/* @__PURE__ */ globalThis.__orderRead?.()";
  } else if (read.read.kind === "global-property") {
    globalRead = `globalThis[${serializeJavaScriptValue(read.read.name)}]`;
  } else if (read.read.kind === "instanceof") {
    globalRead = renderGlobalReadInstanceofExpression(
      globalReadInstanceofSpec(read.read.expression),
    );
  } else if (read.read.kind === "optimizer-expression") {
    const spec = globalReadOptimizerExpressionSpec(read.read.expression);
    globalRead = spec.numericExpression;
    optimizerReaderPrelude = spec.readerPrelude;
    if ("readerBinding" in spec) {
      if (usedBindings.has(spec.readerBinding)) {
        const freshReaderBinding = freshBinding(usedBindings, spec.readerBinding);
        globalRead = globalRead.replaceAll(spec.readerBinding, freshReaderBinding);
        optimizerReaderPrelude = spec.readerPrelude.replaceAll(
          spec.readerBinding,
          freshReaderBinding,
        );
      } else {
        usedBindings.add(spec.readerBinding);
      }
    }
  } else {
    globalRead = projectGlobalReadBuiltinCall(globalReadBuiltinSpec(read.read.kind));
  }
  const observed =
    read.read.kind === "fixture-function-call" || read.read.kind === "global-property"
      ? `(${globalRead} ?? ${read.fallbackValue})`
      : globalRead;
  const exportValue = (expression: string): string[] => {
    const valueName =
      authoredBindingName(module, read.exportedName) ??
      freshBinding(usedBindings, "__orderGlobalReadValue");
    if (!usedBindings.has(valueName)) {
      usedBindings.add(valueName);
    }
    return [
      `const ${valueName} = ${expression};`,
      valueName === read.exportedName
        ? `export { ${valueName} };`
        : `export { ${valueName} as ${read.exportedName} };`,
    ];
  };

  const exportBinding = (bindingName: string): string =>
    bindingName === read.exportedName
      ? `export { ${bindingName} };`
      : `export { ${bindingName} as ${read.exportedName} };`;

  const globalReadValueBinding = (): string => {
    const bindingName =
      authoredBindingName(module, read.exportedName) ??
      freshBinding(usedBindings, "__orderGlobalReadValue");
    usedBindings.add(bindingName);
    return bindingName;
  };

  if (read.form === "manual-pure-tagged-template") {
    if (usedBindings.has("tag")) {
      throw new Error("manual-pure-tagged-template requires the module-local helper binding tag");
    }
    usedBindings.add("tag");
    return [`function tag() { return ${observed}; }`, ...exportValue("tag``")];
  }

  if (isManualPureSideEffectForm(read.form)) {
    if (
      read.read.kind !== "global-property" ||
      read.read.name !== MANUAL_PURE_SIDE_EFFECT_COUNTER_GLOBAL
    ) {
      throw new Error(`${read.form} requires its fixture-owned effect counter read`);
    }
    if (usedBindings.has("make")) {
      throw new Error(`${read.form} requires the module-local helper binding make`);
    }
    usedBindings.add("make");
    const effectName = freshBinding(usedBindings, "__orderManualPureEffect");
    const counter = `globalThis[${serializeJavaScriptValue(MANUAL_PURE_SIDE_EFFECT_COUNTER_GLOBAL)}]`;
    const common = [`${counter} = 0;`, `function ${effectName}() { ${counter} += 1; return 0; }`];
    if (read.form === "manual-pure-computed-key-effect") {
      return [
        ...common,
        "function make() { return { 0: 1 }; }",
        `make()[${effectName}()];`,
        ...exportValue(observed),
      ];
    }
    if (read.form === "manual-pure-call-argument-effect") {
      return [
        ...common,
        "function make(_) { return { value: 1 }; }",
        `make(${effectName}()).value;`,
        ...exportValue(observed),
      ];
    }
    return [
      ...common,
      "function make() { return { 0: { Box: class {} } }; }",
      `new (make()[${effectName}()].Box)();`,
      ...exportValue(observed),
    ];
  }

  if (read.form === "direct") {
    return [
      ...(optimizerReaderPrelude === undefined ? [] : [optimizerReaderPrelude]),
      ...exportValue(observed),
    ];
  }
  if (read.form === "direct-arrow-iife") {
    return exportValue(`(() => ${observed})()`);
  }
  if (read.form === "direct-arrow-block-iife") {
    return exportValue(`(() => { return ${observed}; })()`);
  }
  if (read.form === "arrow-argument-iife") {
    return exportValue(`((unused) => ${observed})(${read.fallbackValue})`);
  }
  if (read.form === "direct-function-iife") {
    return exportValue(`(function () { return ${observed}; })()`);
  }
  if (read.form === "sequence-callee-iife") {
    return exportValue(`(0, () => ${observed})()`);
  }
  if (read.form === "optional-call-iife") {
    return exportValue(`(() => ${observed})?.()`);
  }
  if (read.form === "rest-parameter-iife") {
    return exportValue(`((...args) => ${observed})()`);
  }
  if (read.form === "named-function-iife") {
    return exportValue(`(function named() { return ${observed}; })()`);
  }
  if (read.form === "local-const-iife") {
    return exportValue(`(() => { const result = ${observed}; return result; })()`);
  }
  if (read.form === "if-body-iife") {
    return exportValue(`(() => { if (true) return ${observed}; return ${read.fallbackValue}; })()`);
  }
  if (read.form === "try-finally-iife") {
    return exportValue(`(() => { try { return ${observed}; } finally {} })()`);
  }
  if (read.form === "switch-body-iife") {
    return exportValue(`(() => { switch (0) { case 0: return ${observed}; } })()`);
  }
  if (read.form === "conditional-callee-iife") {
    return exportValue(`(true ? (() => ${observed}) : (() => ${read.fallbackValue}))()`);
  }
  if (read.form === "logical-callee-iife") {
    return exportValue(`(true && (() => ${observed}))()`);
  }
  if (read.form === "array-member") {
    return exportValue(`[${observed}][0]`);
  }
  if (read.form === "array-member-bigint-index") {
    return exportValue(`[${observed}][0n]`);
  }
  if (read.form === "optional-array-member") {
    return exportValue(`[${observed}]?.[0]`);
  }
  if (read.form === "sequence-array-member") {
    return exportValue(`([${read.fallbackValue}], [${observed}])[0]`);
  }
  if (read.form === "conditional-array-member") {
    return exportValue(`[true ? ${observed} : ${read.fallbackValue}][0]`);
  }
  if (read.form === "spread-array-member") {
    return exportValue(`[...[${observed}]][0]`);
  }
  if (read.form === "array-length-call-effect") {
    return exportValue(`[${observed}].length`);
  }
  if (read.form === "object-member") {
    return exportValue(`({ value: ${observed} }).value`);
  }
  if (read.form === "nested-object-member") {
    return exportValue(`({ inner: { value: ${observed} } }).inner.value`);
  }
  if (read.form === "computed-string-object-member") {
    return exportValue(`({ value: ${observed} })["value"]`);
  }
  if (read.form === "computed-number-object-member") {
    return exportValue(
      `({ [${read.fallbackValue}]: ${read.fallbackValue}, [${read.expectedValue}]: ${read.expectedValue} })[${observed}]`,
    );
  }
  if (read.form === "local-computed-object-member") {
    const tableName = freshBinding(usedBindings, "__orderGlobalReadTable");
    return [
      `const ${tableName} = { [${read.fallbackValue}]: ${read.fallbackValue}, [${read.expectedValue}]: ${read.expectedValue} };`,
      ...exportValue(`${tableName}[${observed}]`),
    ];
  }
  if (read.form === "optional-object-member") {
    return exportValue(`({ value: ${observed} })?.value`);
  }
  if (read.form === "optional-computed-object-member") {
    return exportValue(
      `({ [${read.fallbackValue}]: ${read.fallbackValue}, [${read.expectedValue}]: ${read.expectedValue} })?.[${observed}]`,
    );
  }
  if (read.form === "nested-optional-object-member") {
    return exportValue(`({ inner: { value: ${observed} } })?.inner?.value`);
  }
  if (read.form === "object-binding-default") {
    const valueName = globalReadValueBinding();
    return [`const { value: ${valueName} = ${observed} } = {};`, exportBinding(valueName)];
  }
  if (read.form === "object-binding-computed-key") {
    const valueName = globalReadValueBinding();
    return [
      `const { [${observed}]: ${valueName} } = { [${read.fallbackValue}]: ${read.fallbackValue}, [${read.expectedValue}]: ${read.expectedValue} };`,
      exportBinding(valueName),
    ];
  }
  if (read.form === "nested-object-binding-default") {
    const valueName = globalReadValueBinding();
    return [
      `const { inner: { value: ${valueName} = ${observed} } = {} } = {};`,
      exportBinding(valueName),
    ];
  }
  if (read.form === "nested-object-binding-computed-key") {
    const valueName = globalReadValueBinding();
    return [
      `const { inner: { [${observed}]: ${valueName} } } = { inner: { [${read.fallbackValue}]: ${read.fallbackValue}, [${read.expectedValue}]: ${read.expectedValue} } };`,
      exportBinding(valueName),
    ];
  }
  if (read.form === "member-assignment-value") {
    const boxName = freshBinding(usedBindings, "__orderGlobalReadBox");
    return [`const ${boxName} = {};`, ...exportValue(`${boxName}.value = ${observed}`)];
  }
  if (read.form === "annotated-pure-member") {
    if (usedBindings.has("make")) {
      throw new Error("annotated-pure-member requires the module-local helper binding make");
    }
    usedBindings.add("make");
    return [
      `function make() { return { value: ${observed} }; }`,
      ...exportValue("(/* @__PURE__ */ make()).value"),
    ];
  }
  if (read.form === "manual-pure-member") {
    if (usedBindings.has("make")) {
      throw new Error("manual-pure-member requires the module-local helper binding make");
    }
    usedBindings.add("make");
    return [`function make() { return { value: ${observed} }; }`, ...exportValue("make().value")];
  }
  if (read.form === "manual-pure-computed-member") {
    if (usedBindings.has("make")) {
      throw new Error("manual-pure-computed-member requires the module-local helper binding make");
    }
    usedBindings.add("make");
    return [
      `function make() { return { [${read.fallbackValue}]: ${read.fallbackValue}, [${read.expectedValue}]: ${read.expectedValue} }; }`,
      ...exportValue(`make()[${observed}]`),
    ];
  }
  if (read.form === "manual-pure-string-member") {
    if (usedBindings.has("make")) {
      throw new Error("manual-pure-string-member requires the module-local helper binding make");
    }
    usedBindings.add("make");
    return [
      `function make() { return { value: ${observed} }; }`,
      ...exportValue(`make()["value"]`),
    ];
  }
  if (read.form === "manual-pure-numeric-member") {
    if (usedBindings.has("make")) {
      throw new Error("manual-pure-numeric-member requires the module-local helper binding make");
    }
    usedBindings.add("make");
    return [`function make() { return { 0: ${observed} }; }`, ...exportValue("make()[0]")];
  }
  if (read.form === "manual-pure-nested-member") {
    if (usedBindings.has("make")) {
      throw new Error("manual-pure-nested-member requires the module-local helper binding make");
    }
    usedBindings.add("make");
    return [
      `function make() { return { inner: { value: ${observed} } }; }`,
      ...exportValue("make().inner.value"),
    ];
  }
  if (read.form === "manual-pure-optional-member") {
    if (usedBindings.has("make")) {
      throw new Error("manual-pure-optional-member requires the module-local helper binding make");
    }
    usedBindings.add("make");
    return [`function make() { return { value: ${observed} }; }`, ...exportValue("make()?.value")];
  }
  if (read.form === "manual-pure-optional-computed-member") {
    if (usedBindings.has("make")) {
      throw new Error(
        "manual-pure-optional-computed-member requires the module-local helper binding make",
      );
    }
    usedBindings.add("make");
    return [
      `function make() { return { [${read.fallbackValue}]: ${read.fallbackValue}, [${read.expectedValue}]: ${read.expectedValue} }; }`,
      ...exportValue(`make()?.[${observed}]`),
    ];
  }
  if (read.form === "manual-pure-member-call") {
    if (usedBindings.has("make")) {
      throw new Error("manual-pure-member-call requires the module-local helper binding make");
    }
    usedBindings.add("make");
    return [
      `function make() { return { read() { return ${observed}; } }; }`,
      ...exportValue("make().read()"),
    ];
  }
  if (read.form === "manual-pure-new") {
    if (usedBindings.has("Box")) {
      throw new Error("manual-pure-new requires the module-local helper binding Box");
    }
    usedBindings.add("Box");
    const boxName =
      authoredBindingName(module, read.exportedName) ??
      freshBinding(usedBindings, "__orderGlobalReadBox");
    usedBindings.add(boxName);
    return [
      `function Box() { this.value = ${observed}; }`,
      `const ${boxName} = new Box();`,
      exportBinding(boxName),
    ];
  }
  if (read.form === "manual-pure-class-instance-field") {
    if (usedBindings.has("Box")) {
      throw new Error(
        "manual-pure-class-instance-field requires the module-local helper binding Box",
      );
    }
    usedBindings.add("Box");
    const boxName =
      authoredBindingName(module, read.exportedName) ??
      freshBinding(usedBindings, "__orderGlobalReadBox");
    usedBindings.add(boxName);
    return [
      `class Box { value = ${observed}; }`,
      `const ${boxName} = new Box();`,
      exportBinding(boxName),
    ];
  }
  if (read.form === "manual-pure-class-default-parameter") {
    if (usedBindings.has("Box")) {
      throw new Error(
        "manual-pure-class-default-parameter requires the module-local helper binding Box",
      );
    }
    usedBindings.add("Box");
    const boxName =
      authoredBindingName(module, read.exportedName) ??
      freshBinding(usedBindings, "__orderGlobalReadBox");
    usedBindings.add(boxName);
    return [
      `class Box { constructor(value = ${observed}) { this.value = value; } }`,
      `const ${boxName} = new Box();`,
      exportBinding(boxName),
    ];
  }
  if (read.form === "manual-pure-returned-class") {
    if (usedBindings.has("make")) {
      throw new Error("manual-pure-returned-class requires the module-local helper binding make");
    }
    usedBindings.add("make");
    const boxName =
      authoredBindingName(module, read.exportedName) ??
      freshBinding(usedBindings, "__orderGlobalReadBox");
    usedBindings.add(boxName);
    return [
      `function make() { return class { value = ${observed}; }; }`,
      `const ${boxName} = new (make())();`,
      exportBinding(boxName),
    ];
  }

  const className =
    authoredBindingName(module, read.exportedName) ??
    freshBinding(usedBindings, "__OrderGlobalReadClass");
  if (!usedBindings.has(className)) {
    usedBindings.add(className);
  }
  const exportClass = (): string[] => [exportBinding(className)];
  switch (read.form) {
    case "class-static-field-declaration":
      return [`class ${className} { static value = ${observed}; }`, ...exportClass()];
    case "class-static-field-expression":
      return [`const ${className} = class { static value = ${observed}; };`, ...exportClass()];
    case "class-static-field-default-export":
      return [`export default class ${className} { static value = ${observed}; }`];
    case "class-static-field-iife":
      return [`class ${className} { static value = (() => ${observed})(); }`, ...exportClass()];
    case "class-heritage":
      return [
        `class ${className} extends (${observed} === ${read.expectedValue} ? class { static value = ${read.expectedValue}; } : class { static value = ${read.fallbackValue}; }) {}`,
        ...exportClass(),
      ];
    case "class-computed-key":
      return [
        `class ${className} { static [${observed} === ${read.expectedValue} ? "value" : "other"] = ${read.expectedValue}; }`,
        ...exportClass(),
      ];
    case "class-computed-accessor-key":
      return [
        `class ${className} { static get value() { return ${read.fallbackValue}; } static get [${observed} === ${read.expectedValue} ? "value" : "other"]() { return ${read.expectedValue}; } }`,
        ...exportClass(),
      ];
    case "class-nested-static-field":
      return [
        `class ${className} { static Inner = class { static value = ${observed}; }; }`,
        ...exportClass(),
      ];
    case "class-static-block":
      return [
        `class ${className} { static value = ${read.fallbackValue}; static { this.value = ${observed}; } }`,
        ...exportClass(),
      ];
    case "class-instance-field-immediate-construction":
      return [`const ${className} = new (class { value = ${observed}; })();`, ...exportClass()];
    case "returned-class-iife":
      return [
        `const ${className} = (() => class { static value = ${observed}; })();`,
        ...exportClass(),
      ];
    default:
      throw new Error(`Unsupported global-read form: ${String(read.form)}`);
  }
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

/// The module-level LOCAL ALIAS variable a `ValueRead.alias` read routes through (`const <name> =
/// <binding>;`, then `<name>.member`). Deterministic per binding so one declaration serves every aliased
/// read of that binding in the module (the `const x = ns; x.foo` exotic form — FW-B deliverable 3).
function aliasVarName(binding: string): string {
  return `${binding}_alias`;
}

function renderRead(read: ValueRead, aliasBindings?: ReadonlyMap<string, string>): string {
  // Walk the canonical member path (W14c): `binding.p0.p1.…`. Intermediate hops (a re-exported
  // namespace navigated to reach the export) stay static UNLESS `computedHopIndex` names one to render
  // computed (`binding[<key>].tail` — the `a[imp].y` exotic form, FW-B deliverable 3); the DEEPEST access
  // is rendered COMPUTED when `computed` is set (`…[<runtime key>]` — a split literal the bundler cannot
  // fold to a static member). A `.alias` read starts from a module-level alias of `binding` (`const x =
  // ns; x.foo`). All three keep the observed value identical to a plain read; only syntactic visibility /
  // the binding path differs, stressing the rebuilt #10180 top-level-import-read detector. Empty path is
  // a plain binding read.
  const path = read.memberPath ?? [];
  const aliasBinding = read.alias === true ? aliasBindings?.get(read.binding) : undefined;
  if (read.alias === true && aliasBinding === undefined) {
    throw new Error(`Missing allocated alias binding for ${JSON.stringify(read.binding)}`);
  }
  let access = aliasBinding ?? read.binding;
  for (let index = 0; index < path.length; index += 1) {
    const member = path[index] ?? "";
    const isDeepestComputed = index === path.length - 1 && read.computed === true;
    const isIntermediateComputed = read.computedHopIndex === index;
    access =
      isDeepestComputed || isIntermediateComputed
        ? `${access}[${computedMemberKey(member)}]`
        : `${access}.${member}`;
  }
  // A call read folds a hoisted function's return value; safe to call before the defining module's
  // body has run (function declarations initialize first), so it never hits TDZ across a cycle edge.
  const expression = read.call === true ? `${access}()` : access;
  // A guarded read stays total when the target export is partial mid-cycle (undefined -> sentinel).
  return read.guard === true
    ? `(Number.isFinite(${expression}) ? ${expression} : ${PARTIAL_READ_SENTINEL})`
    : expression;
}

/// Allocate one renderer-local alias per DISTINCT binding used by `ValueRead.alias`. The historical
/// `<binding>_alias` spelling is preserved when free; otherwise it is freshened around imports, authored
/// export locals, and earlier renderer bindings so an exact author-selected name stays source-valid.
function allocateAliasBindings(
  module: ModuleModel,
  usedBindings: Set<string>,
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const event of module.events) {
    for (const read of event.reads ?? []) {
      if (read.alias === true && !aliases.has(read.binding)) {
        const preferred = aliasVarName(read.binding);
        if (!usedBindings.has(preferred)) {
          usedBindings.add(preferred);
          aliases.set(read.binding, preferred);
        } else {
          aliases.set(read.binding, freshBinding(usedBindings, preferred));
        }
      }
    }
  }
  return aliases;
}

/// Render allocated alias declarations after imports and before the events that read through them.
function renderAliasDeclarations(aliasBindings: ReadonlyMap<string, string>): string[] {
  return [...aliasBindings].map(([binding, alias]) => `const ${alias} = ${binding};`);
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
function renderFold(
  base: number,
  reads: readonly ValueRead[],
  aliasBindings?: ReadonlyMap<string, string>,
): string {
  return [String(base), ...reads.map((read) => renderRead(read, aliasBindings))].join(" + ");
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

function renderEvents(
  module: ModuleModel,
  usedBindings: Set<string>,
  aliasBindings: ReadonlyMap<string, string>,
): string[] {
  const lines: string[] = [];
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
      const functionName = freshBinding(usedBindings, "__hiddenRead");
      lines.push(
        `function ${functionName}() { return ${event.reads.map((read) => renderRead(read, aliasBindings)).join(" + ")}; }`,
        `${eventHead}${base} + ${functionName}() });`,
      );
      continue;
    }
    lines.push(`${eventHead}${renderFold(base, event.reads, aliasBindings)} });`);
  }
  return lines;
}

function renderCjsExports(
  module: ModuleModel,
  requestedExports: readonly string[],
  readable: readonly ValueRead[],
): string[] {
  const base = moduleStateBase(module);

  // FW-A deliverable 3: the transpiled-CJS interop shape — `Object.defineProperty(exports,"__esModule",
  // {value:true})` then EVERY demanded export (including `default`) as an `exports.<name> = <fold>`
  // property, the Babel/tsc `esModuleInterop` form. The marker drives rolldown's `__esModule` interop
  // detection without changing the value (rolldown targets Node semantics for a real importer).
  if (module.format === "cjs" && module.esModuleMarker === true) {
    return [
      `Object.defineProperty(exports, "__esModule", { value: true });`,
      ...requestedExports.map((name) => renderCjsNamedExport("exports", name, base, readable)),
    ];
  }

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
    const authoredValueName = authoredBindingName(module, exportName);
    do {
      buildName = `__pureBuild${index}`;
      valueName = authoredValueName ?? `__pureValue${index}`;
      index += 1;
    } while (
      usedBindings.has(buildName) ||
      buildName === valueName ||
      (authoredValueName === undefined && usedBindings.has(valueName))
    );
    usedBindings.add(buildName);
    usedBindings.add(valueName);
    const folded = [
      `/* @__PURE__ */ ${buildName}()`,
      ...readable.map((read) => renderRead(read)),
    ].join(" + ");
    lines.push(
      `function ${buildName}() { return ${base}; }`,
      `const ${valueName} = ${folded};`,
      valueName === exportName
        ? `export { ${valueName} };`
        : `export { ${valueName} as ${exportName} };`,
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
        authoredBindingName(module, exportName),
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
      authoredBindingName(module, exportName),
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

/// Render one synthesized export as either a direct exported declaration (`export function name(){…}`)
/// or a fresh local declaration plus an `export { local as name }` alias. `define` renders the
/// declaration DEFINING a binding WITHOUT the `export` keyword (a `function binding() {…}` or a
/// `const binding = …`). The direct form is taken ONLY when the name is both a legal declaration name
/// AND not already bound in this module — an already-used name (an import local, a prior synthesized
/// binding) or a reserved word takes the aliased form, so the module never emits a DUPLICATE lexical
/// binding (W14b.1 blocker 3: `localExports ["x"]` beside `import { … as x }` would otherwise render
/// `import { … as x }; export function x(){}` = a SyntaxError). The chosen name is registered so a
/// later synthesized export cannot reuse it. Generated export names are plain identifiers that never
/// collide, so the corpus stays on the direct path and is byte-identical.
function renderSynthesizedExport(
  exportName: string,
  usedBindings: Set<string>,
  localPrefix: string,
  define: (binding: string) => string,
  authoredLocal?: string,
): string[] {
  if (authoredLocal !== undefined) {
    usedBindings.add(authoredLocal);
    return authoredLocal === exportName
      ? [`export ${define(authoredLocal)}`]
      : [define(authoredLocal), `export { ${authoredLocal} as ${exportName} };`];
  }
  if (isDeclarableName(exportName) && !usedBindings.has(exportName)) {
    usedBindings.add(exportName);
    return [`export ${define(exportName)}`];
  }
  const local = freshBinding(usedBindings, localPrefix);
  return [define(local), `export { ${local} as ${exportName} };`];
}

function authoredBindingName(module: ModuleModel, exportName: string): string | undefined {
  if (module.format !== "esm") {
    return undefined;
  }
  return module.authoredExportBindings?.find((binding) => binding.exportedName === exportName)
    ?.localName;
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
    case "global-read-value":
    case "global-read-carrier":
      throw new Error("global-read export reached the ordinary ESM export renderer");
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
          authoredBindingName(module, exportName),
        ),
      );
      continue;
    }

    const authoredLocal = authoredBindingName(module, exportName);
    if (authoredLocal !== undefined) {
      usedBindings.add(authoredLocal);
      lines.push(
        `const ${authoredLocal} = ${renderFold(base, readable)};`,
        authoredLocal === exportName
          ? `export { ${authoredLocal} };`
          : `export { ${authoredLocal} as ${exportName} };`,
      );
    } else {
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
