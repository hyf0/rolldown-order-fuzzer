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

/// How a local binding may be read by an event's `reads`: an ESM value import is read directly (no
/// member), a CJS readable require reads exactly one member, an ESM namespace import reads any of a
/// declared member set (`localName.member`).
type ReadableBinding =
  | { readonly kind: "direct" }
  | { readonly kind: "require"; readonly member: string }
  | { readonly kind: "namespace"; readonly members: ReadonlySet<string> }
  // An `objectRef` value import: an object reference, never a folded number. It may only be referenced
  // by an event's `identityCheck`, never a numeric read.
  | { readonly kind: "object" };

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

  validateCycleValueFlow(program.modules, modulesById, errors);

  const entriesByName = collectEntries(program.entries, modulesById, errors);
  validateSchedule(program, entriesByName, modulesById, dynamicRegistrationOwners, errors);
  validateManualChunkGroups(program, modulesById, errors);
  validateOrganicChunkGroups(program, errors);

  return errors;
}

/// The modules each module can reach through SYNCHRONOUS dependency edges (everything except a
/// dynamic import, which defers). A dependency `A -> B` closes a cycle exactly when `B` can
/// synchronously reach `A`; the read across such an edge may observe a still-evaluating target.
function computeSynchronousReachability(
  modulesById: ReadonlyMap<string, ModuleModel>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const reachability = new Map<string, ReadonlySet<string>>();
  for (const start of modulesById.keys()) {
    const reached = new Set<string>();
    const pending: string[] = [start];
    while (pending.length > 0) {
      const moduleId = pending.pop();
      if (moduleId === undefined) {
        continue;
      }
      for (const dependency of modulesById.get(moduleId)?.dependencies ?? []) {
        if (dependency.kind === "esm-dynamic-import" || reached.has(dependency.target)) {
          continue;
        }
        reached.add(dependency.target);
        pending.push(dependency.target);
      }
    }
    reachability.set(start, reached);
  }
  return reachability;
}

/// Cycle value-flow soundness (Node-legal, TDZ-free, NaN-free). A read across a cycle-closing edge
/// may run while its target is still evaluating, so it must be made TOTAL by construction:
///
/// - an ESM value read that closes a cycle must be a hoisted-function CALL import (`call: true`),
///   the only form callable before the target's body has run — a plain `const`/`let` read hits TDZ;
/// - an ESM namespace import may not close a cycle at all (any member read risks TDZ);
/// - a readable CJS require that closes a cycle must be GUARDED (`guard: true`) so a partial export
///   folds to a sentinel instead of NaN (a NaN would crash identically on both sides — a degenerate
///   always-equal case the oracle must never rely on).
///
/// A hoisted-function call import must also target an ESM module (only an ESM `function` export is
/// callable while the module is mid-evaluation). Forward (non-cycle) edges are unrestricted: a
/// `call`/`guard` there is harmless, and a plain read is sound because the target is fully evaluated.
function validateCycleValueFlow(
  modules: readonly ModuleModel[],
  modulesById: ReadonlyMap<string, ModuleModel>,
  errors: string[],
): void {
  const reachability = computeSynchronousReachability(modulesById);
  for (const [moduleIndex, module] of modules.entries()) {
    for (const [dependencyIndex, dependency] of module.dependencies.entries()) {
      const path = `modules[${moduleIndex}].dependencies[${dependencyIndex}]`;
      const target = modulesById.get(dependency.target);
      const closesCycle = reachability.get(dependency.target)?.has(module.id) === true;

      if (dependency.kind === "esm-value-import") {
        if (dependency.call === true && target !== undefined && target.format !== "esm") {
          errors.push(
            `${path}: a hoisted-function call import must target an ESM module, target ${quote(dependency.target)} is ${target.format}`,
          );
        }
        if (closesCycle && dependency.call !== true) {
          errors.push(
            `${path}: an ESM value import that closes a cycle must be a hoisted-function call import (call: true) to avoid TDZ`,
          );
        }
      } else if (dependency.kind === "esm-namespace-import") {
        if (closesCycle) {
          errors.push(
            `${path}: an ESM namespace import cannot close a cycle; a member read would hit TDZ`,
          );
        }
      } else if (
        dependency.kind === "cjs-require" &&
        dependency.resultBinding !== undefined &&
        closesCycle &&
        dependency.guard !== true
      ) {
        errors.push(
          `${path}: a readable require that closes a cycle must be guarded (guard: true) so a partial export folds to a sentinel instead of NaN`,
        );
      }
    }
  }
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
    validateSideEffectFreeModule(module, moduleIndex, errors);
    validateInferredPureModule(module, moduleIndex, errors);
    validateCallableOwnStateModule(module, moduleIndex, errors);
    validateObjectExportModule(module, moduleIndex, errors);

    const localBindings = new Set<string>();
    // Each readable binding maps its local name to how it may be read: an ESM value-import (read
    // directly), a CJS readable require (one member), or an ESM namespace import (a member set).
    const readableBindings = new Map<string, ReadableBinding>();
    // Per target, the pair "slots" already used from this module. A (importer, target) pair may carry
    // several DISTINCT dependency kinds (the wave-5 mixed pairs), but at most one edge per slot.
    const pairSlots = new Map<string, Set<string>>();

    for (const [dependencyIndex, dependency] of module.dependencies.entries()) {
      const path = `modules[${moduleIndex}].dependencies[${dependencyIndex}]`;
      const operation: DependencyOperation = dependency;

      validateDependencySyntax(module, operation, path, errors);
      validateDependencyBinding(operation, path, localBindings, readableBindings, errors);
      validatePairSlot(operation, path, pairSlots, errors);

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

      // Every export a callable-own-state module synthesizes is a FUNCTION. Folding a function
      // binding numerically concatenates its SOURCE TEXT into the payload, and the bundle may rename
      // or reformat that function — a false-positive surface, not a bug witness. So a read of a
      // callable-own-state module's export must consume it as a CALL (or capture it as an objectRef,
      // compared only for identity). Checked on DIRECT edges; a chain through a barrel is the
      // generator's responsibility (its consumers always call), the same split as flagged barrels.
      if (target !== undefined && target.callableOwnState === true) {
        if (
          operation.kind === "esm-value-import" &&
          operation.call !== true &&
          operation.objectRef !== true
        ) {
          errors.push(
            `${path}: a value import of callable-own-state module ${quote(target.id)} must be a call import or an objectRef; its export is a function and a numeric fold of it is unsound`,
          );
        }
        if (operation.kind === "esm-namespace-import") {
          const callMembers = new Set(operation.callMembers ?? []);
          for (const member of operation.readMembers) {
            if (!callMembers.has(member)) {
              errors.push(
                `${path}: namespace member ${quote(member)} of callable-own-state module ${quote(target.id)} must be in callMembers; its exports are functions and a plain member fold is unsound`,
              );
            }
          }
        }
        if (operation.kind === "cjs-require" && operation.resultBinding !== undefined) {
          errors.push(
            `${path}: a readable require may not target callable-own-state module ${quote(target.id)}; its exports are functions and a member fold is unsound`,
          );
        }
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

/// The value-only ESM dependency kinds a `sideEffects: false` module may carry: value/namespace
/// imports and re-exports. Each only matters when the flagged module's value is used — the bundler
/// must then keep it (and its upstream) in order — so dropping the flagged module when unused stays
/// invisible. A side-effect import, dynamic-import registration, or interop require would be
/// droppable under the flag yet could reorder or drop another module's events.
const SIDE_EFFECT_FREE_DEPENDENCY_KINDS = new Set([
  "esm-value-import",
  "esm-namespace-import",
  "esm-reexport-named",
  "esm-reexport-star",
]);

/// A `sideEffects: false` module is a user promise the bundler may act on with aggressive dead-code
/// elimination. To keep the oracle sound, such a module must contribute ONLY values and never emit
/// an observable event: an emitted event could be legally dropped in the bundle while the source
/// still emits it. It must also be ESM whose every dependency is a value-only edge (see
/// `SIDE_EFFECT_FREE_DEPENDENCY_KINDS`). This is a LOCAL invariant; whole-chain soundness (nothing
/// only reachable through the flagged module emits events) is the generator's / handwritten test's
/// responsibility, as with flagged leaves. See the `sideEffectFree` doc in model.ts and
/// `.agents/docs/namespace-and-barrel-reexports.md`.
function validateSideEffectFreeModule(
  module: ModuleModel,
  moduleIndex: number,
  errors: string[],
): void {
  if (module.sideEffectFree !== true) {
    return;
  }

  const path = `modules[${moduleIndex}]`;
  if (module.format !== "esm") {
    errors.push(`${path}: a side-effect-free module must be ESM, received ${module.format}`);
  }
  if (module.events.length > 0) {
    errors.push(
      `${path}: a side-effect-free module must not emit events; its events can be legally dropped under sideEffects:false`,
    );
  }
  for (const [dependencyIndex, dependency] of module.dependencies.entries()) {
    if (!SIDE_EFFECT_FREE_DEPENDENCY_KINDS.has(dependency.kind)) {
      errors.push(
        `${path}.dependencies[${dependencyIndex}]: a side-effect-free module may only carry value-only ESM dependencies, received ${dependency.kind}`,
      );
    }
  }
}

/// An inferred-pure definer (`inferredPure`) is judged side-effect-free by the bundler from its
/// STATEMENTS (not a `package.json` flag): local pure functions, a `const` assigned from a
/// `/* @__PURE__ */` call, exports of those bindings. Like a `sideEffects: false` module it must be
/// ESM, emit no events (an event is a side effect that would make its top level impure), and carry
/// only value-only ESM dependencies. It also carries a finite numeric `pureBase` (the build
/// function's return value) and is MUTUALLY EXCLUSIVE with `sideEffectFree` — the two are distinct
/// mechanisms. See the `inferredPure` doc in model.ts and `.agents/docs/real-app-bug-families.md`.
function validateInferredPureModule(
  module: ModuleModel,
  moduleIndex: number,
  errors: string[],
): void {
  if (module.inferredPure !== true) {
    return;
  }

  const path = `modules[${moduleIndex}]`;
  if (module.sideEffectFree === true) {
    errors.push(`${path}: a module cannot be both inferredPure and sideEffectFree`);
  }
  if (module.format !== "esm") {
    errors.push(`${path}: an inferred-pure module must be ESM, received ${module.format}`);
  }
  if (module.events.length > 0) {
    errors.push(
      `${path}: an inferred-pure module must not emit events; an event is a top-level side effect`,
    );
  }
  if (module.objectExport === true) {
    errors.push(`${path}: a module cannot be both inferredPure and objectExport`);
  }
  if (module.pureBase === undefined || !Number.isFinite(module.pureBase)) {
    errors.push(`${path}.pureBase: an inferred-pure module requires a finite numeric pureBase`);
  }
  for (const [dependencyIndex, dependency] of module.dependencies.entries()) {
    if (!SIDE_EFFECT_FREE_DEPENDENCY_KINDS.has(dependency.kind)) {
      errors.push(
        `${path}.dependencies[${dependencyIndex}]: an inferred-pure module may only carry value-only ESM dependencies, received ${dependency.kind}`,
      );
    }
  }
}

/// A callable-reads-own-state definer (`callableOwnState`) synthesizes a module-scope mutable state
/// var assigned during init from a non-inlinable pure call, and renders each local export as a
/// function that reads that state. It must be ESM (only an ESM chunk-scope function export is callable
/// while its module init is skipped — the family-B shape). It may be combined with `inferredPure` (a
/// no-events pure definer whose callable reads its state) but not with `objectExport` (a different
/// export rendering). See the `callableOwnState` doc in model.ts.
function validateCallableOwnStateModule(
  module: ModuleModel,
  moduleIndex: number,
  errors: string[],
): void {
  if (module.callableOwnState !== true) {
    return;
  }
  const path = `modules[${moduleIndex}]`;
  if (module.format !== "esm") {
    errors.push(`${path}: a callable-own-state module must be ESM, received ${module.format}`);
  }
  if (module.objectExport === true) {
    errors.push(`${path}: a module cannot be both callableOwnState and objectExport`);
  }
}

/// An object-export definer (`objectExport`) exports a fresh object literal per demanded name and emits
/// NO events (the invisible double-init target — a module run twice is undetectable by numbers but not
/// by object identity). It must be ESM, a leaf (no dependencies — nothing it could reorder or fold),
/// carry no events, and not combine with another export-rendering flag. See the `objectExport` doc in
/// model.ts.
function validateObjectExportModule(
  module: ModuleModel,
  moduleIndex: number,
  errors: string[],
): void {
  if (module.objectExport !== true) {
    return;
  }
  const path = `modules[${moduleIndex}]`;
  if (module.format !== "esm") {
    errors.push(`${path}: an object-export module must be ESM, received ${module.format}`);
  }
  if (module.events.length > 0) {
    errors.push(
      `${path}: an object-export module must not emit events; it is the invisible double-init target`,
    );
  }
  if (module.dependencies.length > 0) {
    errors.push(`${path}: an object-export module must be a leaf (no dependencies)`);
  }
  if (module.sideEffectFree === true) {
    errors.push(`${path}: a module cannot be both objectExport and sideEffectFree`);
  }
}

function validateEventReads(
  event: ModuleModel["events"][number],
  eventPath: string,
  readableBindings: ReadonlyMap<string, ReadableBinding>,
  errors: string[],
): void {
  // An object-identity event folds `value + ((left === right) ? 0 : sentinel)`: it carries no numeric
  // reads, keeps a finite numeric base, and both sides compare `objectRef` bindings of this module.
  if (event.identityCheck !== undefined) {
    if (event.reads !== undefined && event.reads.length > 0) {
      errors.push(`${eventPath}: an event cannot carry both reads and an identityCheck`);
    }
    if (event.hiddenReadFn === true) {
      errors.push(`${eventPath}: identityCheck cannot combine with hiddenReadFn`);
    }
    if (typeof event.value !== "number" || !Number.isFinite(event.value)) {
      errors.push(
        `${eventPath}.value: expected a finite number when the event carries an identityCheck`,
      );
    }
    for (const side of ["leftBinding", "rightBinding"] as const) {
      const bindingName = event.identityCheck[side];
      const binding = readableBindings.get(bindingName);
      if (binding === undefined || binding.kind !== "object") {
        errors.push(
          `${eventPath}.identityCheck.${side}: ${quote(bindingName)} must be an objectRef import binding in this module`,
        );
      }
    }
    return;
  }

  if (event.reads === undefined || event.reads.length === 0) {
    // A function-hidden read wraps the folded reads in a local function; it is meaningless with no
    // reads to hide.
    if (event.hiddenReadFn === true) {
      errors.push(`${eventPath}: hiddenReadFn requires a non-empty reads array`);
    }
    return;
  }

  // A folded event emits `value + read0 + …`; the base must stay numeric so the fold stays numeric.
  if (typeof event.value !== "number" || !Number.isFinite(event.value)) {
    errors.push(`${eventPath}.value: expected a finite JSON number when the event carries reads`);
  }

  for (const [readIndex, read] of event.reads.entries()) {
    const readPath = `${eventPath}.reads[${readIndex}]`;
    const binding = readableBindings.get(read.binding);
    if (binding === undefined) {
      errors.push(
        `${readPath}.binding: unknown readable binding ${quote(read.binding)} in this module`,
      );
      continue;
    }
    // An objectRef binding holds an object reference; folding it into a numeric payload is a type error
    // (it may only be compared for identity in an `identityCheck`).
    if (binding.kind === "object") {
      errors.push(
        `${readPath}.binding: ${quote(read.binding)} is an objectRef binding and cannot be folded numerically; use an identityCheck`,
      );
      continue;
    }
    if (binding.kind === "namespace") {
      if (read.member === undefined || !binding.members.has(read.member)) {
        errors.push(
          `${readPath}.member: expected a namespace member for binding ${quote(read.binding)}, received ${read.member === undefined ? "no member" : quote(read.member)}`,
        );
      }
      continue;
    }
    // A computed member access (`binding[k]`) is only meaningful on a namespace import; a value
    // import or require binding is read directly, not by a runtime key.
    if (read.computed === true) {
      errors.push(
        `${readPath}.computed: a computed member read is only valid on a namespace import binding, ${quote(read.binding)} is a ${binding.kind} binding`,
      );
    }
    const expectedMember = binding.kind === "require" ? binding.member : undefined;
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
  readableBindings: Map<string, ReadableBinding>,
  errors: string[],
): void {
  if (dependency.kind === "esm-value-import") {
    if (!JAVASCRIPT_IDENTIFIER_PATTERN.test(dependency.importedName)) {
      errors.push(
        `${path}.importedName: invalid JavaScript identifier ${quote(dependency.importedName)}`,
      );
    }
    // An objectRef import binds an object reference (compared for identity, never folded); a plain
    // value import binds a directly-readable value. The two roles are mutually exclusive.
    if (dependency.objectRef === true && dependency.call === true) {
      errors.push(`${path}: an import cannot be both objectRef and a call import`);
    }
    if (validateLocalBinding(dependency.localName, `${path}.localName`, localBindings, errors)) {
      readableBindings.set(
        dependency.localName,
        dependency.objectRef === true ? { kind: "object" } : { kind: "direct" },
      );
    }
    return;
  }

  if (dependency.kind === "esm-namespace-import") {
    for (const [memberIndex, member] of dependency.readMembers.entries()) {
      if (!JAVASCRIPT_IDENTIFIER_PATTERN.test(member)) {
        errors.push(
          `${path}.readMembers[${memberIndex}]: invalid JavaScript identifier ${quote(member)}`,
        );
      }
    }
    // A call member (`ns.member()`) must name a member the namespace actually reads.
    const readMemberSet = new Set(dependency.readMembers);
    for (const [callIndex, callMember] of (dependency.callMembers ?? []).entries()) {
      if (!readMemberSet.has(callMember)) {
        errors.push(
          `${path}.callMembers[${callIndex}]: ${quote(callMember)} must be one of readMembers`,
        );
      }
    }
    if (validateLocalBinding(dependency.localName, `${path}.localName`, localBindings, errors)) {
      readableBindings.set(dependency.localName, {
        kind: "namespace",
        members: new Set(dependency.readMembers),
      });
    }
    return;
  }

  if (dependency.kind === "esm-reexport-named") {
    // A re-export forwards an export; it binds nothing locally, so only its names are validated.
    if (!JAVASCRIPT_IDENTIFIER_PATTERN.test(dependency.sourceName)) {
      errors.push(
        `${path}.sourceName: invalid JavaScript identifier ${quote(dependency.sourceName)}`,
      );
    }
    if (!JAVASCRIPT_IDENTIFIER_PATTERN.test(dependency.exportedName)) {
      errors.push(
        `${path}.exportedName: invalid JavaScript identifier ${quote(dependency.exportedName)}`,
      );
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
  readableBindings: Map<string, ReadableBinding>,
  errors: string[],
): void {
  if (dependency.resultBinding === undefined && dependency.readName === undefined) {
    if (dependency.guard === true) {
      errors.push(
        `${path}: guard is only meaningful on a readable require (set resultBinding + readName)`,
      );
    }
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
    readableBindings.set(dependency.resultBinding, {
      kind: "require",
      member: dependency.readName,
    });
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

/// The per-pair "slot" a dependency occupies, or `undefined` when it may repeat for one pair. This
/// permits the wave-5 mixed pairs (several DISTINCT kinds to one target — `{side-effect + value}`,
/// `{value + dynamic}`, `{side-effect + dynamic}`, `{value + side-effect + dynamic}` for ESM
/// importers, `{require + dynamic}` for CJS) while rejecting the two same-kind duplicates that are
/// genuinely degenerate: a second side-effect import (`import "./t"` twice is identical, carrying no
/// new binding) and a second dynamic import (at most one `__orderDynamicImports` registration per
/// pair). Value, namespace, and readable-require imports may REPEAT for one pair — two named imports
/// from a module (`import { a } from "./t"; import { b } from "./t"`) are common, sound code, and
/// each binds a distinct local name already checked for collisions. Re-exports may repeat too (a
/// barrel forwards several names from one target).
function dependencyPairSlot(kind: DependencyOperation["kind"]): string | undefined {
  switch (kind) {
    case "esm-side-effect-import":
      return "side-effect";
    case "esm-dynamic-import":
      return "dynamic";
    default:
      return undefined;
  }
}

function validatePairSlot(
  dependency: DependencyOperation,
  path: string,
  pairSlots: Map<string, Set<string>>,
  errors: string[],
): void {
  const slot = dependencyPairSlot(dependency.kind);
  if (slot === undefined) {
    return;
  }
  const slots = pairSlots.get(dependency.target) ?? new Set<string>();
  if (slots.has(slot)) {
    errors.push(
      `${path}: a (importer, target) pair to ${quote(dependency.target)} may carry at most one ${slot} dependency`,
    );
    return;
  }
  slots.add(slot);
  pairSlots.set(dependency.target, slots);
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

/// The organic (size/share-driven) chunk groups: rolldown decides composition, so nothing references
/// a module id. A program carries EITHER manual or organic groups, never both (the two are the
/// distinct chunking-config modes). Each group needs a unique name, a compilable `test` regex source
/// (when present), and finite non-negative numeric thresholds. Chunking is bundle-side only, so none
/// of this can change source-run semantics.
function validateOrganicChunkGroups(program: ProgramModel, errors: string[]): void {
  const organicGroups = program.organicChunkGroups ?? [];
  if (organicGroups.length > 0 && (program.manualChunkGroups?.length ?? 0) > 0) {
    errors.push("a program may carry either manualChunkGroups or organicChunkGroups, not both");
  }

  const groupNames = new Set<string>();
  for (const [groupIndex, group] of organicGroups.entries()) {
    const path = `organicChunkGroups[${groupIndex}]`;
    if (group.name.length === 0) {
      errors.push(`${path}.name: must not be empty`);
    } else if (groupNames.has(group.name)) {
      errors.push(`${path}.name: duplicate group name ${quote(group.name)}`);
    } else {
      groupNames.add(group.name);
    }

    if (group.test !== undefined) {
      try {
        new RegExp(group.test);
      } catch {
        errors.push(`${path}.test: invalid regular-expression source ${quote(group.test)}`);
      }
    }

    for (const field of ["minSize", "maxSize", "minShareCount", "priority"] as const) {
      const value = group[field];
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        errors.push(`${path}.${field}: must be a finite non-negative number`);
      }
    }
    if (group.minShareCount !== undefined && !Number.isInteger(group.minShareCount)) {
      errors.push(`${path}.minShareCount: must be an integer`);
    }
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}
