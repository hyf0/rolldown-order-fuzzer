import {
  formConsumptionShape,
  namespaceReexportTarget,
  renderedFormNoun,
  resolvedExportKey,
  type AnalyzedProgram,
  type ConsumptionRecord,
  type ExportDemandPlan,
  type RenderedExportForm,
} from "./analyzed-program.ts";
import { canonicalReadFlags, readKey } from "./capture-analysis.ts";
import type {
  CjsRequireOperation,
  DependencyOperation,
  EntryModel,
  ModuleModel,
  ProgramModel,
  ValueRead,
} from "./model.ts";
import { metadataPureModuleIds, packagesOf, programChunking } from "./model.ts";
import type { ProgramFacts } from "./program-facts.ts";
import { builtinModules } from "node:module";

/// Node's canonical built-in module names (bare specifiers that resolve to a CORE module, e.g. `fs`,
/// `path`, `events`). A package name that collides with one is rejected: a bare `import … from "fs"`
/// of the package main would resolve the core module, not the fixture file. Both the bare and the
/// `node:`-prefixed canonical forms are included, though the prefixed form can never satisfy
/// `PACKAGE_NAME_PATTERN` (the `:` is not a legal package-name character) — it is listed for
/// completeness so the rule reads as "every canonical built-in specifier".
const BUILTIN_MODULE_NAMES: ReadonlySet<string> = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

/// Generated package names: npm-safe, lowercase, deterministic. Restrictive on purpose — the name is
/// a directory AND a bare import specifier, so the model never carries a name whose resolution could
/// surprise (scopes, dots, uppercase).
const PACKAGE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/// A package MEMBER's id becomes its rendered file name (`<id>.mjs` — stable under shrink, unlike the
/// index-named root files), so it must be filename-safe.
const PACKAGE_MEMBER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/// The `sideEffects` array entries the model may carry: an optional `./` prefix, then a flat
/// literal-plus-`*` name (no directory separators — package files are flat). Restricting the syntax
/// keeps the fuzzer's matcher (`sideEffectsPatternMatches`) equivalent to rolldown's glob engine on
/// everything the model can express (both semantics were probed against the frozen snapshot).
const SIDE_EFFECTS_PATTERN = /^(\.\/)?[A-Za-z0-9_.*-]+$/;

/// The `preserveEntrySignatures` values rolldown accepts. The generator only ever produces
/// `"allow-extension"`; the rest are permitted so a future axis (or a hand-crafted model) is not
/// rejected for a legal value.
const VALID_PRESERVE_ENTRY_SIGNATURES: ReadonlySet<
  false | "strict" | "allow-extension" | "exports-only"
> = new Set([false, "strict", "allow-extension", "exports-only"] as const);

const JAVASCRIPT_IDENTIFIER_PATTERN = /^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u;

/// The JavaScript reserved words that are valid EXPORT names (any IdentifierName) but not valid
/// declaration/binding names. A local binding cannot be named one of these, and a definer synthesizing
/// such an export must render `export { local as name }` rather than `export function name`/`const name`.
export const INVALID_MODULE_BINDING_IDENTIFIERS = new Set([
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
/// member), a CJS readable require reads exactly one member (a length-1 `memberPath`), an ESM namespace
/// import reads any of a declared set of member PATHS (`localName.p0.p1…`, keyed by `memberPathKey`).
type ReadableBinding =
  | { readonly kind: "direct" }
  | { readonly kind: "require"; readonly member: string }
  | { readonly kind: "namespace"; readonly memberPaths: ReadonlySet<string> }
  // An `objectRef` value import: an object reference, never a folded number. It may only be referenced
  // by an event's `identityCheck`, never a numeric read.
  | { readonly kind: "object" };

/// The canonical key for a read's member path (the same join `readKey` uses), so the namespace binding's
/// declared paths and an event read's path compare identically.
function memberPathKey(memberPath: readonly string[] | undefined): string {
  return (memberPath ?? []).join("\0");
}

export function validateProgramModel(analyzed: AnalyzedProgram): readonly string[] {
  const errors: string[] = [];
  // The consumer takes ONLY the AnalyzedProgram and reads the program from it, so a program can never
  // disagree with the analysis it is validated against (the mismatch is unrepresentable, not merely
  // asserted). A standalone caller (a shrink candidate, a handwritten test) wraps `analyzeProgram(program)`.
  const { program, facts, plan } = analyzed;
  const modulesById = collectModules(program.modules, errors);
  // The ONE analyzed view: graph facts plus the canonical export-demand plan the program-level export
  // soundness reads (supply status, per-consumption shape↔form soundness, cross-consumer aggregation).
  // Threaded in along the case path (finalizeProgram → renderProgram → here) so demand analysis runs
  // EXACTLY ONCE per case.
  const dynamicRegistrationOwners = new Map<string, string>();
  const modulesReachingTopLevelAwait = facts.topLevelAwaitReachers();

  validateModules(
    program.modules,
    modulesById,
    facts,
    plan,
    modulesReachingTopLevelAwait,
    dynamicRegistrationOwners,
    errors,
  );

  validateCycleValueFlow(program.modules, facts, errors);
  validateSynchronousCycleFormats(facts, errors);
  validateExportDemand(plan, errors);

  const entriesByName = collectEntries(program.entries, modulesById, errors);
  validateSchedule(program, entriesByName, modulesById, facts, dynamicRegistrationOwners, errors);
  validateBuildConfig(program, errors);
  validatePackages(program, modulesById, errors);
  validateManualChunkGroups(program, modulesById, errors);
  validateOrganicChunkGroups(program, errors);
  validateDeadHopContract(program, modulesById, plan, errors);
  validateNamespaceReadPaths(program, modulesById, errors);

  return errors;
}

/// A NESTED namespace read (`outer.ns.member`, W14c) demands its DEEPER components through a chain of
/// namespace re-exports (`export * as ns from …`): each INTERMEDIATE path component (every component but
/// the last) must resolve to a namespace re-export on the module its prefix routed to, so the deepest
/// member lands on a real origin. Without this, a malformed nested read (`outer.X.member` where `X` is a
/// plain numeric export, not a namespace) would render `outer.X.member` against a number and fold NaN —
/// a wasted both-sides harness crash. This makes the shape UNREPRESENTABLE rather than merely relying on
/// the generator never building it, using the ONE `namespaceReexportTarget` resolver (no parallel walk).
function validateNamespaceReadPaths(
  program: ProgramModel,
  modulesById: ReadonlyMap<string, ModuleModel>,
  errors: string[],
): void {
  for (const [moduleIndex, module] of program.modules.entries()) {
    for (const [dependencyIndex, dependency] of module.dependencies.entries()) {
      if (dependency.kind !== "esm-namespace-import") {
        continue;
      }
      for (const [memberIndex, memberPath] of dependency.readMembers.entries()) {
        // Only nested paths (depth ≥ 2) route through namespace re-exports; a length-1 read is a plain
        // member the supply route already checks.
        let currentTarget = dependency.target;
        for (let component = 0; component < memberPath.length - 1; component += 1) {
          const name = memberPath[component];
          const inner =
            name === undefined
              ? undefined
              : namespaceReexportTarget(modulesById, currentTarget, name);
          if (inner === undefined) {
            errors.push(
              `modules[${moduleIndex}].dependencies[${dependencyIndex}].readMembers[${memberIndex}][${component}]: ` +
                `${quote(String(name))} is not a namespace re-export on ${quote(currentTarget)}; a nested ` +
                `namespace read must route each intermediate component through an \`export * as ns from\``,
            );
            break;
          }
          currentTarget = inner;
        }
      }
    }
  }
}

/// The DEAD-barrel-hop LEGALITY CONTRACT (M5, W14c). A MIXED barrel — a module with a DECLARED local
/// export (`localExports`) beside an `export * from target` — can be consumed by an importer that reads
/// ONLY the local export, leaving the star hop DEAD for that importer: the bundle legally TREE-SHAKES
/// the star target for it, while SOURCE ESM still evaluates the re-export target (ESM evaluates all
/// static imports). If the star target carried EVENTS, that source-vs-bundle divergence (source runs
/// the target, the bundle drops it) would FALSE-POSITIVE the standard event oracle on a LEGAL
/// tree-shake. So a dead-hop target MUST be event-free — the divergence is then unobservable in events
/// and the witness is the object-identity side only.
///
/// The check is PER-CONSUMPTION over the ONE plan (no new route walk, W14b.1): the star hop is DEAD for
/// an importer only when that importer routes NO live consumption THROUGH the barrel's star (the
/// enriched `RouteHop` records `via:"star"` + `through`). A barrel whose sole importer DOES read a
/// star-forwarded value (the vben `index.js` shape) keeps its star hop LIVE for that importer, so an
/// eventful target there is not a dead hop and is accepted. Only when an importer imports the barrel yet
/// skips the star does an eventful target become the illegal shape.
function validateDeadHopContract(
  program: ProgramModel,
  modulesById: ReadonlyMap<string, ModuleModel>,
  plan: ExportDemandPlan,
  errors: string[],
): void {
  // Per barrel id, the set of consumer modules that route a live consumption through THIS barrel's star
  // hop (so the star is live for them). Read from the plan's enriched route hops — no new walk.
  const starUsersByBarrel = new Map<string, Set<string>>();
  for (const consumption of plan.consumptions) {
    if (consumption.purpose !== "live" || consumption.supply.status !== "supplied") {
      continue;
    }
    for (const hop of consumption.supply.hops) {
      if (hop.via === "star") {
        const users = starUsersByBarrel.get(hop.through) ?? new Set<string>();
        users.add(consumption.consumerModuleId);
        starUsersByBarrel.set(hop.through, users);
      }
    }
  }

  for (const [moduleIndex, module] of program.modules.entries()) {
    if (module.format !== "esm" || (module.localExports?.length ?? 0) === 0) {
      continue;
    }
    const starUsers = starUsersByBarrel.get(module.id) ?? new Set<string>();
    // Every module that imports this barrel (any dependency targeting it).
    const importers = program.modules.filter((candidate) =>
      candidate.dependencies.some((dependency) => dependency.target === module.id),
    );
    // An importer that imports the barrel but routes NO live consumption through its star skips the
    // star — the star hop is DEAD for it.
    const someImporterSkipsStar = importers.some((importer) => !starUsers.has(importer.id));
    if (!someImporterSkipsStar) {
      continue;
    }
    for (const [dependencyIndex, dependency] of module.dependencies.entries()) {
      if (dependency.kind !== "esm-reexport-star") {
        continue;
      }
      const target = modulesById.get(dependency.target);
      if (target !== undefined && target.events.length > 0) {
        errors.push(
          `modules[${moduleIndex}].dependencies[${dependencyIndex}]: a mixed barrel's ` +
            `\`export * from ${quote(dependency.target)}\` is a DEAD hop for an importer that reads only ` +
            `the barrel's local export, so its target must be event-free; ${quote(dependency.target)} ` +
            `carries ${String(target.events.length)} event(s)`,
        );
      }
    }
  }
}

/// The package/layout model (W14b, schema 18). Beyond well-formedness (unique npm-safe names,
/// existing filename-safe members, each module in at most ONE package, restricted `sideEffects`
/// patterns), this enforces the TWO semantic rules:
///
/// - ONE live representation: a program carrying `packages` may not ALSO flag a module
///   `sideEffectFree` — the flag is the legacy form `packagesOf` normalizes, never a parallel one.
/// - The metadata-purity contract applies exactly to the members the resolved packages assert PURE
///   (`metadataPureModuleIds`): all members under `sideEffects: false`, the array-UNMATCHED members
///   under the partial form — a matched or `sideEffects: true` member keeps its side effects and is
///   unconstrained. A pure member must be ESM, emit no events, and carry only value-only ESM
///   dependencies (the same contract the legacy flag enforced); it must not be `callableOwnState`
///   (a legal DCE may drop the state its callable reads) nor `objectExport` (a dropped object export
///   defeats the identity witness). It MAY be `inferredPure`: both mechanisms assert "no side
///   effects" and the inferred-pure rendering stays sound under package metadata — the real vben
///   packages carry exactly this combination (deliberately relaxed from the old per-module
///   flag mutual exclusion, which remains for the two FLAGS on one module).
function validatePackages(
  program: ProgramModel,
  modulesById: ReadonlyMap<string, ModuleModel>,
  errors: string[],
): void {
  // Structural well-formedness over the RESOLVED packages view (`packagesOf`) — persisted `packages`
  // (schema 18) OR the legacy `sideEffectFree`-flag normalization to `sef-<id>` packages — so a
  // legacy artifact or a handwritten model that reaches the rendered package layout is validated by
  // the SAME rules, never bypasses them (W14b.1 blocker 1: the old check ran only on persisted
  // `packages`, so a flagged module whose id collides case-fold (`A`/`a` → one `sef-a`) or escapes
  // the source root (`../../../x`) slipped through). The `packages` field appearing only on
  // package-carrying cases keeps the generated corpus byte-identical: its persisted packages ARE the
  // resolved view, so these checks see exactly what they saw before.
  const resolved = packagesOf(program);
  const names = new Set<string>();
  const memberIds = new Set<string>();
  for (const [packageIndex, pkg] of resolved.entries()) {
    const path = `packages[${packageIndex}]`;
    if (!PACKAGE_NAME_PATTERN.test(pkg.name)) {
      errors.push(`${path}.name: invalid package name ${quote(pkg.name)}`);
    } else if (BUILTIN_MODULE_NAMES.has(pkg.name)) {
      errors.push(
        `${path}.name: package name ${quote(pkg.name)} collides with a Node built-in module; a bare import of its main would resolve the core module, not the package`,
      );
    } else if (names.has(pkg.name)) {
      errors.push(`${path}.name: duplicate package name ${quote(pkg.name)}`);
    } else {
      names.add(pkg.name);
    }
    if (pkg.moduleIds.length === 0) {
      errors.push(`${path}.moduleIds: a package needs at least one member (the main module)`);
    }
    // Case-insensitive filesystems (macOS/Windows) collapse `Foo.mjs` and `foo.mjs` in ONE package
    // directory to a single file (SAFE note 2); member ids differing only in case within a package
    // would render two members onto one path, so reject the collision.
    const memberIdsLowerHere = new Set<string>();
    for (const [memberIndex, moduleId] of pkg.moduleIds.entries()) {
      const memberPath = `${path}.moduleIds[${memberIndex}]`;
      if (!modulesById.has(moduleId)) {
        errors.push(`${memberPath}: unknown module id ${quote(moduleId)}`);
      } else if (!PACKAGE_MEMBER_ID_PATTERN.test(moduleId)) {
        errors.push(
          `${memberPath}: module id ${quote(moduleId)} is not filename-safe (a member id becomes its rendered file name)`,
        );
      }
      const memberIdLower = moduleId.toLowerCase();
      if (memberIdsLowerHere.has(memberIdLower)) {
        errors.push(
          `${memberPath}: module id ${quote(moduleId)} collides case-insensitively with another member of this package; their rendered file names would clash on a case-insensitive filesystem`,
        );
      } else {
        memberIdsLowerHere.add(memberIdLower);
      }
      if (memberIds.has(moduleId)) {
        errors.push(`${memberPath}: module ${quote(moduleId)} belongs to more than one package`);
      } else {
        memberIds.add(moduleId);
      }
    }
    if (typeof pkg.sideEffects !== "boolean") {
      for (const [patternIndex, pattern] of pkg.sideEffects.entries()) {
        if (!SIDE_EFFECTS_PATTERN.test(pattern)) {
          errors.push(
            `${path}.sideEffects[${patternIndex}]: invalid pattern ${quote(pattern)} (a flat literal-plus-* name, optionally ./-prefixed)`,
          );
        }
      }
    }
  }
  // ONE live representation: a program carrying PERSISTED packages may not ALSO flag a module
  // sideEffectFree — the flag is the legacy form `packagesOf` normalizes, never a parallel one.
  if (program.packages !== undefined) {
    for (const [moduleIndex, module] of program.modules.entries()) {
      if (module.sideEffectFree === true) {
        errors.push(
          `modules[${moduleIndex}]: a program carrying packages may not also flag sideEffectFree; the flag is the legacy representation packagesOf normalizes`,
        );
      }
    }
  }

  // The metadata-purity contract over the RESOLVED view (persisted packages, or the legacy-flag
  // normalization once it lands), so the flag and package forms can never enforce different rules.
  const moduleIndexById = new Map(program.modules.map((module, index) => [module.id, index]));
  for (const moduleId of metadataPureModuleIds(program)) {
    const module = modulesById.get(moduleId);
    const moduleIndex = moduleIndexById.get(moduleId);
    if (module === undefined || moduleIndex === undefined) {
      continue;
    }
    const path = `modules[${moduleIndex}]`;
    validateValueOnlyEsmContract(
      module,
      path,
      "a metadata-pure package member",
      "its events can be legally dropped under the package's sideEffects metadata",
      errors,
    );
    if (module.callableOwnState === true) {
      errors.push(
        `${path}: a metadata-pure package member cannot be callableOwnState; a legal DCE may drop the state a callable-own-state export reads`,
      );
    }
    if (module.objectExport === true) {
      errors.push(
        `${path}: a metadata-pure package member cannot be objectExport; a dropped object export defeats the identity witness`,
      );
    }
  }
}

/// Program-level export-demand soundness, read from the ONE canonical plan. Every readable consumer's
/// demand must resolve to a UNIQUE provider — not `unsupplied` (a `default` import through a star-only
/// barrel, or any name a star-only barrel cannot forward, renders as an undefined import), and not
/// `ambiguous` (duplicate named exports, or two star re-exports both providing the name, which the
/// renderer would resolve arbitrarily). And the aggregated consumption of each resolved export must
/// match the SINGLE form its definer renders: a callable-demand must reach a function (callability is
/// marked only on a DIRECT call edge, never forwarded through a barrel — the ONE source of truth the
/// renderer and this check share), an identity capture must reach an object, and one export cannot be
/// both called and folded. The generator never produces any of these, so this only rejects hand-crafted
/// or shrunk-invalid models.
function validateExportDemand(plan: ExportDemandPlan, errors: string[]): void {
  for (const consumption of plan.consumptions) {
    // Every demand — LIVE (read/called/captured) or LINK-REQUIRED (a named re-export Rolldown statically
    // link-checks) — must resolve to a UNIQUE provider. An unsupplied link-required demand is exactly the
    // model-authored MISSING_EXPORT channel this closes: a named re-export of a name a star-only barrel
    // cannot forward now fails validation instead of rendering an invalid source.
    const demandNoun = consumption.purpose === "link-required" ? "re-exported name" : "export";
    const where = `module ${quote(consumption.consumerModuleId)} demand ${quote(consumption.demandedName)} on ${quote(consumption.target)}`;
    if (consumption.supply.status === "unsupplied") {
      errors.push(
        `${where}: the ${demandNoun} is unsupplied — no provider (a star re-export never forwards \`default\`, and a barrel carrying a star synthesizes nothing locally)`,
      );
      continue;
    }
    if (consumption.supply.status === "ambiguous") {
      const origins = consumption.supply.origins
        .map((origin) => quote(origin.moduleId))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .join(", ");
      errors.push(
        `${where}: the ${demandNoun} is ambiguous — it resolves to more than one definer (${origins}); duplicate named exports or two conflicting star re-exports`,
      );
      continue;
    }
    // Supplied AND live: the consumption's SHAPE must match the single FORM its resolved definer renders —
    // the per-shape numeric/callable/object soundness read from the ONE plan's `renderedForm` instead of
    // the old direct-target `resolveExportOrigin` capability walk. Folding a function's source text,
    // calling a number, or comparing folded numbers for identity all surface here; callability-not-forwarded
    // is the callable case. A LINK-REQUIRED demand is supply-checked only — a named re-export imposes no
    // runtime form — so it is never shape-checked (its `shape` is an inert placeholder).
    if (consumption.purpose !== "live") {
      continue;
    }
    const demand = plan.resolvedDemands.get(resolvedExportKey(consumption.supply.origin));
    if (demand !== undefined && formConsumptionShape(demand.renderedForm) !== consumption.shape) {
      errors.push(consumptionMismatchMessage(consumption, demand.renderedForm));
    }
  }

  // The CROSS-CONSUMER conflict the per-consumption check states less directly: one export consumed as
  // more than one shape. A definer renders ONE form, so at least one of those consumers already mismatched
  // above; this aggregate names the conflict at the definer for a clearer diagnostic.
  for (const demand of plan.resolvedDemands.values()) {
    if (demand.shapes.size > 1) {
      const at = `export ${quote(demand.origin.exportName)} on ${quote(demand.origin.moduleId)}`;
      const shapes = [...demand.shapes].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      errors.push(
        `${at}: incompatible consumption — consumed as more than one shape (${shapes.join(", ")}); a definer renders ONE form, so mixing call / numeric fold / identity of one export misreads it`,
      );
    }
  }
}

/// The diagnostic for a supplied consumption whose SHAPE does not match its resolved definer's rendered
/// FORM. Phrased by shape so it reads naturally and preserves the substrings the crafted-violation tests
/// key on (notably "callability is not forwarded through a barrel" for a call routed through a star).
function consumptionMismatchMessage(
  consumption: ConsumptionRecord,
  renderedForm: RenderedExportForm,
): string {
  const origin = consumption.supply.status === "supplied" ? consumption.supply.origin : undefined;
  const at =
    origin === undefined
      ? `demand ${quote(consumption.demandedName)} on ${quote(consumption.target)}`
      : `export ${quote(origin.exportName)} on ${quote(origin.moduleId)}`;
  const by = `consumed by module ${quote(consumption.consumerModuleId)} (demand ${quote(consumption.demandedName)} on ${quote(consumption.target)})`;
  // The coarse value/function/object noun the diagnostic reads as, so a value-category form (a numeric
  // fold or an inferred-pure `const`) both surface as "a value" regardless of the finer render template.
  const noun = renderedFormNoun(renderedForm);
  if (consumption.shape === "callable") {
    const throughBarrel =
      consumption.supply.status === "supplied" && consumption.supply.hops.length > 0;
    return `${at}: called ${by} but the definer renders a ${noun}${throughBarrel ? "; callability is not forwarded through a barrel" : ""} — a call must reach a callable-own-state definer or a directly call-marked export`;
  }
  if (consumption.shape === "reference") {
    return `${at}: captured by identity (objectRef) ${by} but the definer renders a ${noun}; an objectRef must reach a fresh-object export`;
  }
  return `${at}: folded numerically ${by} but the definer renders a ${noun}; folding a ${noun} (a function's source text or an object) is unsound`;
}

/// The object ORIGIN each objectRef capture in `moduleId` resolves to (through barrels), read from the
/// ONE plan's `reference` consumptions, so an identity comparison can require both sides witness the SAME
/// object export. Replaces the old describeCaptures / resolveExportOrigin capability walk.
function objectOriginsForModule(moduleId: string, plan: ExportDemandPlan): Map<string, string> {
  const origins = new Map<string, string>();
  for (const consumption of plan.consumptions) {
    if (
      consumption.consumerModuleId === moduleId &&
      consumption.shape === "reference" &&
      consumption.supply.status === "supplied" &&
      consumption.dependency.kind === "esm-value-import"
    ) {
      origins.set(
        consumption.dependency.localName,
        `${consumption.supply.origin.moduleId} ${consumption.supply.origin.exportName}`,
      );
    }
  }
  return origins;
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
  facts: ProgramFacts,
  errors: string[],
): void {
  for (const [moduleIndex, module] of modules.entries()) {
    for (const [dependencyIndex, dependency] of module.dependencies.entries()) {
      const path = `modules[${moduleIndex}].dependencies[${dependencyIndex}]`;
      const target = facts.module(dependency.target);
      const closesCycle = facts.edgeClosesCycle(module.id, dependency.target);

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
      } else if (dependency.kind === "esm-local-reexport") {
        // The imported binding is a plain (non-hoisted) value read; across a cycle-closing edge it
        // would risk TDZ exactly like a namespace member read, so the edge stays forward-only.
        if (closesCycle) {
          errors.push(
            `${path}: an ESM local re-export cannot close a cycle; its imported binding would hit TDZ`,
          );
        }
      } else if (dependency.kind === "esm-reexport-namespace") {
        // `export * as ns from target` materializes the target's namespace object; a downstream
        // `outer.ns.member` read would hit TDZ across a cycle-closing edge exactly like a namespace
        // import, so it stays forward-only.
        if (closesCycle) {
          errors.push(
            `${path}: an ESM namespace re-export cannot close a cycle; a member read through it would hit TDZ`,
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

/// A synchronous strongly-connected component (a cycle cluster) must be SINGLE-FORMAT. A cycle that
/// mixes ESM and CJS members is Node-illegal — the require of an evaluating ESM module (or the reverse)
/// errors depending on the runtime entry point into the cycle, exactly the shape the mixed-cycle
/// exclusion documents (`.agents/docs/execution-order-fuzzer-mvp.md`). The generator forces each cycle
/// to one `ringFormat`, so this only rejects a handwritten model; it closes the gap where validation
/// checked read totality across cycle edges but never the cluster's format uniformity.
function validateSynchronousCycleFormats(facts: ProgramFacts, errors: string[]): void {
  for (const scc of facts.cycles().sccs) {
    const formats = new Set(
      scc.map((id) => facts.module(id)?.format).filter((f) => f !== undefined),
    );
    if (formats.size > 1) {
      const members = [...scc].sort();
      errors.push(
        `synchronous cycle {${members.map(quote).join(", ")}} mixes module formats (${[...formats].sort().join(", ")}); a mixed-format cycle is Node-illegal`,
      );
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
  facts: ProgramFacts,
  plan: ExportDemandPlan,
  modulesReachingTopLevelAwait: ReadonlySet<string>,
  dynamicRegistrationOwners: Map<string, string>,
  errors: string[],
): void {
  for (const [moduleIndex, module] of modules.entries()) {
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
    // The explicit named re-export names (`export { s as e } from`) this module already declares. A
    // module may not declare the SAME exportedName twice, regardless of source origin: ESM permits one
    // binding per exported name, so a second `export { … as X }` is a Node SyntaxError (Duplicate export
    // of 'X'). `resolveExportRoute` dedups routes by resolved origin, so a duplicate that happens to reach
    // the SAME definer would otherwise pass supply resolution while still rendering invalid ESM.
    const explicitReexportNames = new Set<string>();
    // Where each objectRef binding's captured object is ultimately defined (following barrels), so an
    // identity comparison can require both sides witness the SAME object (not merely both be objectRef
    // captures). Read from the ONE plan's `reference` consumptions for this module, replacing the old
    // describeCaptures/resolveExportOrigin walk.
    const objectOrigins = objectOriginsForModule(module.id, plan);

    for (const [dependencyIndex, dependency] of module.dependencies.entries()) {
      const path = `modules[${moduleIndex}].dependencies[${dependencyIndex}]`;
      const operation: DependencyOperation = dependency;

      validateDependencySyntax(module, operation, path, errors);
      validateDependencyBinding(operation, path, localBindings, readableBindings, errors);
      validatePairSlot(operation, path, pairSlots, errors);

      if (
        operation.kind === "esm-reexport-named" ||
        operation.kind === "esm-local-reexport" ||
        operation.kind === "esm-reexport-namespace"
      ) {
        // Named, LOCAL, and NAMESPACE re-exports share one per-module exported-name space: ESM permits
        // one binding per exported name, so a second `export { … as X }` / `export * as X from` of any
        // form is a Node SyntaxError (Duplicate export of 'X').
        if (explicitReexportNames.has(operation.exportedName)) {
          errors.push(
            `${path}.exportedName: duplicate named re-export of ${quote(operation.exportedName)}; a module may export a name at most once (Node: Duplicate export)`,
          );
        } else {
          explicitReexportNames.add(operation.exportedName);
        }
      }

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

      // A readable require of `default` from a CJS target is unsupplied: a CommonJS provider renders
      // `module.exports = <value>` (or filters `default` out of a `module.exports = {}`), so `.default`
      // never exists and the fold is `undefined` → NaN, a degenerate both-sides crash. This is a CJS
      // INTEROP fact the supply-aware route cannot see (a CJS module is a local definer of every name),
      // so it stays a direct check; every OTHER per-shape capability soundness is now the plan's job
      // (`validateExportDemand`), not a parallel resolveExportOrigin walk.
      if (
        target !== undefined &&
        operation.kind === "cjs-require" &&
        operation.resultBinding !== undefined &&
        operation.readName === "default" &&
        target.format === "cjs"
      ) {
        errors.push(
          `${path}: a readable require cannot read ${quote("default")} from CJS module ${quote(operation.target)}; a CommonJS provider supplies no default property`,
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

    validateLocalExports(module, moduleIndex, explicitReexportNames, errors);

    const readFlags = canonicalReadFlags(module.dependencies);
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

      validateEventReads(event, eventPath, readableBindings, readFlags, objectOrigins, errors);
    }
  }
}

/// DECLARED local exports (`localExports`, the vben own-helper-next-to-a-star shape): ESM-only,
/// valid unique identifier names, never colliding with a re-export's exported name (ESM permits one
/// binding per exported name — Node: Duplicate export), and never colliding with an import's LOCAL
/// binding. Names here are LOCAL definers that render as `export function name(){…}`, so a name an
/// import already binds (`import { … as name }`) would be declared twice — a SyntaxError the renderer
/// now sidesteps with a fresh alias, but the model is still ill-formed and rejected here (W14b.1
/// blocker 3). A collision would also make the demand/supply projections disagree on whether the name
/// is a local definer or a forwarded import.
function validateLocalExports(
  module: ModuleModel,
  moduleIndex: number,
  explicitReexportNames: ReadonlySet<string>,
  errors: string[],
): void {
  const declared = (module as { readonly localExports?: readonly string[] }).localExports;
  if (declared === undefined) {
    return;
  }
  const path = `modules[${moduleIndex}].localExports`;
  if (module.format !== "esm") {
    errors.push(`${path}: only an ESM module may declare local exports`);
    return;
  }
  const importLocalNames = new Set<string>();
  for (const dependency of module.dependencies) {
    if (
      dependency.kind === "esm-value-import" ||
      dependency.kind === "esm-namespace-import" ||
      dependency.kind === "esm-local-reexport"
    ) {
      importLocalNames.add(dependency.localName);
    }
  }
  const seen = new Set<string>();
  for (const [nameIndex, name] of declared.entries()) {
    if (!JAVASCRIPT_IDENTIFIER_PATTERN.test(name)) {
      errors.push(`${path}[${nameIndex}]: invalid JavaScript identifier ${quote(name)}`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`${path}[${nameIndex}]: duplicate declared local export ${quote(name)}`);
      continue;
    }
    seen.add(name);
    if (explicitReexportNames.has(name)) {
      errors.push(
        `${path}[${nameIndex}]: ${quote(name)} collides with a re-export's exported name; a module may export a name at most once (Node: Duplicate export)`,
      );
    }
    if (importLocalNames.has(name)) {
      errors.push(
        `${path}[${nameIndex}]: ${quote(name)} collides with an import's local binding; a declared local export defines the name, so an import already binding it would be declared twice`,
      );
    }
  }
}

/// The value-only ESM dependency kinds a `sideEffects: false` module may carry: value/namespace
/// imports and re-exports (including the LOCAL re-export form, whose two statements are a value
/// import plus an export clause). Each only matters when the flagged module's value is used — the
/// bundler must then keep it (and its upstream) in order — so dropping the flagged module when unused
/// stays invisible. A side-effect import, dynamic-import registration, or interop require would be
/// droppable under the flag yet could reorder or drop another module's events.
const SIDE_EFFECT_FREE_DEPENDENCY_KINDS = new Set([
  "esm-value-import",
  "esm-namespace-import",
  "esm-reexport-named",
  "esm-reexport-star",
  "esm-reexport-namespace",
  "esm-local-reexport",
]);

/// The shared contract of BOTH purity mechanisms (metadata `sideEffects: false` and statement-inferred
/// purity): the module must be ESM, emit NO observable event (an event could be legally dropped by the
/// bundler while the source still emits it), and carry only value-only ESM dependencies (a side-effect
/// import, dynamic registration, or interop require would be droppable under purity yet could reorder
/// or drop another module's events). Only the descriptor and the no-events reason differ between the
/// two mechanisms; the checks are one.
function validateValueOnlyEsmContract(
  module: ModuleModel,
  path: string,
  descriptor: string,
  noEventsReason: string,
  errors: string[],
): void {
  if (module.format !== "esm") {
    errors.push(`${path}: ${descriptor} module must be ESM, received ${module.format}`);
  }
  if (module.events.length > 0) {
    errors.push(`${path}: ${descriptor} module must not emit events; ${noEventsReason}`);
  }
  for (const [dependencyIndex, dependency] of module.dependencies.entries()) {
    if (!SIDE_EFFECT_FREE_DEPENDENCY_KINDS.has(dependency.kind)) {
      errors.push(
        `${path}.dependencies[${dependencyIndex}]: ${descriptor} module may only carry value-only ESM dependencies, received ${dependency.kind}`,
      );
    }
  }
}

/// An inferred-pure definer (`inferredPure`) is judged side-effect-free by the bundler from its
/// STATEMENTS (not package metadata): local pure functions, a `const` assigned from a
/// `/* @__PURE__ */` call, exports of those bindings. It shares the value-only ESM contract, carries a
/// finite numeric `pureBase` (the build function's return value), and is mutually exclusive with
/// `objectExport` (a different export rendering). It MAY additionally sit under package
/// `sideEffects` metadata — both mechanisms assert "no side effects", and real packages (vben) carry
/// exactly that combination — so the historical flag-level exclusion against `sideEffectFree` is
/// gone WITH the flag's live role: metadata purity is validated on the package view
/// (`validatePackages`), through the one `packagesOf` seam, identically for legacy and new models.
/// See the `inferredPure` doc in model.ts and `.agents/docs/real-app-bug-families.md`.
function validateInferredPureModule(
  module: ModuleModel,
  moduleIndex: number,
  errors: string[],
): void {
  if (module.inferredPure !== true) {
    return;
  }

  const path = `modules[${moduleIndex}]`;
  if (module.objectExport === true) {
    errors.push(`${path}: a module cannot be both inferredPure and objectExport`);
  }
  if (module.pureBase === undefined || !Number.isFinite(module.pureBase)) {
    errors.push(`${path}.pureBase: an inferred-pure module requires a finite numeric pureBase`);
  }
  validateValueOnlyEsmContract(
    module,
    path,
    "an inferred-pure",
    "an event is a top-level side effect",
    errors,
  );
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
  // objectExport × metadata purity is rejected on the PACKAGE view (`validatePackages`), through the
  // one `packagesOf` seam — a legacy `sideEffectFree` flag normalizes there, so no flag check here.
}

function validateEventReads(
  event: ModuleModel["events"][number],
  eventPath: string,
  readableBindings: ReadonlyMap<string, ReadableBinding>,
  readFlags: ReadonlyMap<string, { readonly call: boolean; readonly guard: boolean }>,
  objectOrigins: ReadonlyMap<string, string>,
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
    let bothObject = true;
    for (const side of ["leftBinding", "rightBinding"] as const) {
      const bindingName = event.identityCheck[side];
      const binding = readableBindings.get(bindingName);
      if (binding === undefined || binding.kind !== "object") {
        bothObject = false;
        errors.push(
          `${eventPath}.identityCheck.${side}: ${quote(bindingName)} must be an objectRef import binding in this module`,
        );
      }
    }
    // The two captures only witness a double-init when they reference the SAME object export reached
    // through different paths. Comparing captures of two DIFFERENT objects is always false on a correct
    // build too, so the "mismatch" fold fires on a healthy bundle — a false positive.
    if (bothObject) {
      const leftOrigin = objectOrigins.get(event.identityCheck.leftBinding);
      const rightOrigin = objectOrigins.get(event.identityCheck.rightBinding);
      if (leftOrigin !== undefined && rightOrigin !== undefined && leftOrigin !== rightOrigin) {
        errors.push(
          `${eventPath}.identityCheck: leftBinding and rightBinding must capture the SAME object export; they resolve to different origins`,
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
      const key = memberPathKey(read.memberPath);
      if ((read.memberPath?.length ?? 0) === 0 || !binding.memberPaths.has(key)) {
        errors.push(
          `${readPath}.memberPath: expected a declared namespace member path for binding ${quote(read.binding)}, received ${(read.memberPath?.length ?? 0) === 0 ? "no member" : quote((read.memberPath ?? []).join("."))}`,
        );
      } else {
        validateReadCapability(read, readPath, readFlags, errors);
        validateExoticReadForm(read, readPath, errors);
      }
      continue;
    }
    // A computed member access (`binding[k]`), an intermediate computed hop, or a namespace ALIAS is only
    // meaningful on a namespace import; a value import or require binding is read directly, not through an
    // aliased namespace or a runtime key.
    if (read.computed === true) {
      errors.push(
        `${readPath}.computed: a computed member read is only valid on a namespace import binding, ${quote(read.binding)} is a ${binding.kind} binding`,
      );
    }
    if (read.computedHopIndex !== undefined) {
      errors.push(
        `${readPath}.computedHopIndex: a computed member hop is only valid on a namespace import binding, ${quote(read.binding)} is a ${binding.kind} binding`,
      );
    }
    if (read.alias === true) {
      errors.push(
        `${readPath}.alias: an aliased read is only valid on a namespace import binding, ${quote(read.binding)} is a ${binding.kind} binding`,
      );
    }
    const expectedPath = binding.kind === "require" ? [binding.member] : [];
    if (memberPathKey(read.memberPath) !== memberPathKey(expectedPath)) {
      errors.push(
        `${readPath}.memberPath: expected ${expectedPath.length === 0 ? "no member" : quote(expectedPath.join("."))} for binding ${quote(read.binding)}, received ${(read.memberPath?.length ?? 0) === 0 ? "no member" : quote((read.memberPath ?? []).join("."))}`,
      );
    } else {
      validateReadCapability(read, readPath, readFlags, errors);
    }
  }
}

/// An event read's `call`/`guard` must MATCH the dependency that created its binding (the canonical
/// read from `readableBindingsOf`). A read that folds a hoisted-function/callable export WITHOUT a call
/// concatenates the function's source text into a number (a bundle may rename or reformat it — a false
/// positive); a read that calls a plain numeric binding invokes a number (a TypeError). The guard flag
/// (the partial-cycle-read sentinel) must likewise match, so the rendered fold is the intended one.
/// Validate the exotic-read form flags (FW-B deliverable 3) on a NAMESPACE member read: `computed`
/// (deepest computed) and `computedHopIndex` (an intermediate computed hop) are mutually exclusive — one
/// read never hides both a deepest and an intermediate access; a `computedHopIndex` must name a real
/// INTERMEDIATE hop (`0 ≤ index < memberPath.length - 1`, so a static tail follows it), which requires a
/// nested path (depth ≥ 2). `alias` carries no positional constraint (it aliases the whole binding).
function validateExoticReadForm(read: ValueRead, readPath: string, errors: string[]): void {
  const pathLength = read.memberPath?.length ?? 0;
  if (read.computedHopIndex !== undefined) {
    if (read.computed === true) {
      errors.push(
        `${readPath}: a read cannot set both \`computed\` (deepest) and \`computedHopIndex\` (an intermediate hop)`,
      );
    }
    if (
      !Number.isInteger(read.computedHopIndex) ||
      read.computedHopIndex < 0 ||
      read.computedHopIndex >= pathLength - 1
    ) {
      errors.push(
        `${readPath}.computedHopIndex: must be an intermediate hop index (0 ≤ index < ${pathLength - 1}) leaving a static tail, received ${String(read.computedHopIndex)}`,
      );
    }
  }
}

function validateReadCapability(
  read: ValueRead,
  readPath: string,
  readFlags: ReadonlyMap<string, { readonly call: boolean; readonly guard: boolean }>,
  errors: string[],
): void {
  const canonical = readFlags.get(readKey(read));
  if (canonical === undefined) {
    return;
  }
  const memberSuffix = (read.memberPath ?? []).map((member) => `.${member}`).join("");
  if ((read.call === true) !== canonical.call) {
    errors.push(
      `${readPath}.call: read of ${quote(read.binding)}${memberSuffix} must ${canonical.call ? "be a call (call: true)" : "not be a call"} to match its binding's capability`,
    );
  }
  if ((read.guard === true) !== canonical.guard) {
    errors.push(
      `${readPath}.guard: read of ${quote(read.binding)}${memberSuffix} must ${canonical.guard ? "be guarded (guard: true)" : "not be guarded"} to match its binding's capability`,
    );
  }
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
    // Each read member is a PATH `localName.p0.p1…` (W14c); every component must be a valid identifier,
    // and a length-≥2 path is a nested read through a re-exported namespace.
    const deepestMembers = new Set<string>();
    for (const [memberIndex, memberPath] of dependency.readMembers.entries()) {
      if (memberPath.length === 0) {
        errors.push(`${path}.readMembers[${memberIndex}]: a member path must be non-empty`);
        continue;
      }
      for (const [componentIndex, component] of memberPath.entries()) {
        if (!JAVASCRIPT_IDENTIFIER_PATTERN.test(component)) {
          errors.push(
            `${path}.readMembers[${memberIndex}][${componentIndex}]: invalid JavaScript identifier ${quote(component)}`,
          );
        }
      }
      const deepest = memberPath[memberPath.length - 1];
      if (deepest !== undefined) {
        deepestMembers.add(deepest);
      }
    }
    // A call member (`ns.….member()`) must name the DEEPEST member of some read path.
    for (const [callIndex, callMember] of (dependency.callMembers ?? []).entries()) {
      if (!deepestMembers.has(callMember)) {
        errors.push(
          `${path}.callMembers[${callIndex}]: ${quote(callMember)} must be the deepest member of a readMembers path`,
        );
      }
    }
    if (validateLocalBinding(dependency.localName, `${path}.localName`, localBindings, errors)) {
      readableBindings.set(dependency.localName, {
        kind: "namespace",
        memberPaths: new Set(dependency.readMembers.map((memberPath) => memberPathKey(memberPath))),
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

  if (dependency.kind === "esm-local-reexport") {
    // A local re-export BINDS `localName` (a live import read like a value import's) and re-exports
    // it under `exportedName`; both statement halves carry validated names.
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
    if (validateLocalBinding(dependency.localName, `${path}.localName`, localBindings, errors)) {
      readableBindings.set(dependency.localName, { kind: "direct" });
    }
    return;
  }

  if (dependency.kind === "esm-reexport-namespace") {
    // `export * as ns from target` binds nothing locally — it synthesizes ONE named namespace-object
    // export. Only its exported name is validated (the duplicate-export-name space is shared with the
    // other re-export forms in `validateModules`).
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
  facts: ProgramFacts,
  dynamicRegistrationOwners: ReadonlyMap<string, string>,
  errors: string[],
): void {
  const evaluatedModules = new Set<string>();
  const markEvaluated = (rootId: string): void => {
    for (const reached of facts.closureFrom(rootId)) {
      evaluatedModules.add(reached);
    }
  };

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
          markEvaluated(targetModule.id);
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
      markEvaluated(entryModule.id);
    }
  }
}

/// The persisted BuildConfig axes. `strictExecutionOrder` is a ROLLABLE boolean axis as of W14c: a
/// `seo:false` case is now REPRESENTABLE, tied to the reachability-isolation oracle in `program-run.ts`
/// (`executeProgram` derives the order oracle from THIS axis, so a `seo:false` case never uses the
/// full-order oracle that would false-positive on legal relaxed-order divergences). `preserveEntrySignatures`
/// must be one of rolldown's accepted values; the rolled boolean axes must be booleans. Legacy
/// (schema-16) models carry no `build` and resolve to defaults, so they pass.
function validateBuildConfig(program: ProgramModel, errors: string[]): void {
  const build = program.build;
  if (build === undefined) {
    return;
  }
  if (typeof build.strictExecutionOrder !== "boolean") {
    errors.push("build.strictExecutionOrder: must be a boolean");
  }
  if (!VALID_PRESERVE_ENTRY_SIGNATURES.has(build.preserveEntrySignatures)) {
    errors.push(
      `build.preserveEntrySignatures: invalid value ${quote(String(build.preserveEntrySignatures))}`,
    );
  }
  if (typeof build.includeDependenciesRecursively !== "boolean") {
    errors.push("build.includeDependenciesRecursively: must be a boolean");
  }
  if (typeof build.lazyBarrel !== "boolean") {
    errors.push("build.lazyBarrel: must be a boolean");
  }
  // W12 minify axis: a plain rollable boolean with NO gate (unlike `cjs`, minify composes with TLA and
  // every other axis). A persisted `build` predating W12 has no `minify` — tolerated (it resolves to
  // `false` via `buildConfigOf`, the "old artifact still replays" rule). A PRESENT value must be boolean.
  const minify: unknown = (build as { readonly minify?: unknown }).minify;
  if (minify !== undefined && typeof minify !== "boolean") {
    errors.push("build.minify: must be a boolean");
  }
  // The chunking discriminant must be one of the three modes. An unknown `kind` (e.g. `{ kind: "bogus" }`)
  // otherwise falls through `programChunking` / the adapter switch to AUTOMATIC silently — a crafted or
  // shrunk model would build a different chunking than it names. Reject it here so the union stays sound.
  const chunking: unknown = build.chunking;
  const chunkingKind =
    typeof chunking === "object" && chunking !== null && "kind" in chunking
      ? (chunking as { readonly kind: unknown }).kind
      : undefined;
  if (chunkingKind !== "automatic" && chunkingKind !== "manual" && chunkingKind !== "organic") {
    errors.push(
      `build.chunking: unknown chunking kind ${quote(String(chunkingKind))} (expected automatic, manual, or organic)`,
    );
  }
  // FW-A output-format axis: only `esm` / `cjs` are rolled (both keep code splitting). A `cjs` output
  // is Node-illegal when any module carries top-level await — rolldown hard-refuses it
  // (`[UNSUPPORTED_FEATURE] Top-level await is currently not supported with the 'cjs' output`), so a
  // model that pairs the two would only ever produce a build error, not a differential witness. The
  // generator gates `cjs` off whenever a module has TLA; this rejects a handwritten/shrunk model that
  // does not.
  // A persisted `build` predating FW-A has no `outputFormat` — tolerated (it resolves to `esm` via
  // `buildConfigOf`, the "old artifact still replays" rule). A PRESENT value must be `esm` or `cjs`.
  const outputFormat: unknown = (build as { readonly outputFormat?: unknown }).outputFormat;
  if (outputFormat !== undefined && outputFormat !== "esm" && outputFormat !== "cjs") {
    errors.push(
      `build.outputFormat: invalid value ${JSON.stringify(outputFormat)} (expected esm or cjs)`,
    );
  } else if (
    outputFormat === "cjs" &&
    program.modules.some((module) => module.hasTopLevelAwait === true)
  ) {
    errors.push(
      "build.outputFormat: a cjs output cannot be built when any module has top-level await (rolldown refuses TLA under the cjs format)",
    );
  }
}

function validateManualChunkGroups(
  program: ProgramModel,
  modulesById: ReadonlyMap<string, ModuleModel>,
  errors: string[],
): void {
  const chunking = programChunking(program);
  if (chunking.kind !== "manual") {
    return;
  }
  const groupNames = new Set<string>();

  for (const [groupIndex, group] of chunking.groups.entries()) {
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
/// distinct chunking-config modes; a legacy schema-16 model with BOTH top-level arrays is rejected).
/// Each group needs a unique name, a compilable `test` regex source (when present), and finite
/// non-negative numeric thresholds. Chunking is bundle-side only, so none of this can change source-run
/// semantics.
function validateOrganicChunkGroups(program: ProgramModel, errors: string[]): void {
  // Legacy (schema-16) ambiguity: a program with no `build` but BOTH top-level arrays non-empty. A
  // schema-17 program carries a single `build.chunking` union, so this can only fire on an old artifact.
  if (
    program.build === undefined &&
    (program.organicChunkGroups?.length ?? 0) > 0 &&
    (program.manualChunkGroups?.length ?? 0) > 0
  ) {
    errors.push("a program may carry either manualChunkGroups or organicChunkGroups, not both");
  }

  const chunking = programChunking(program);
  if (chunking.kind !== "organic") {
    return;
  }
  const groupNames = new Set<string>();
  for (const [groupIndex, group] of chunking.groups.entries()) {
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

    for (const field of [
      "minSize",
      "maxSize",
      "minShareCount",
      "priority",
      "entriesAwareMergeThreshold",
    ] as const) {
      const value = group[field];
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        errors.push(`${path}.${field}: must be a finite non-negative number`);
      }
    }
    if (group.minShareCount !== undefined && !Number.isInteger(group.minShareCount)) {
      errors.push(`${path}.minShareCount: must be an integer`);
    }
    if (group.entriesAware !== undefined && typeof group.entriesAware !== "boolean") {
      errors.push(`${path}.entriesAware: must be a boolean`);
    }
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}
