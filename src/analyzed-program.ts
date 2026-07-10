import type { DependencyOperation, ModuleExportShape, ModuleModel, ProgramModel } from "./model.ts";
import { moduleProfile } from "./model.ts";
import type { ExportOrigin, ExportSupply } from "./program-facts.ts";
import { ProgramFacts } from "./program-facts.ts";

/// The finalized, frozen view of ONE program that every downstream layer consumes: the graph facts and
/// the single canonical export-demand plan. Renderer planning, validation, coverage tags, and shrinking
/// all read this instead of each re-deriving demand, callability, and export routes — the parallel
/// projections that had drifted (a renderer fixpoint, a validator capability walk, a tag star walk, a
/// shrink route reconstruction) collapse into one.
export interface AnalyzedProgram {
  readonly program: ProgramModel;
  readonly facts: ProgramFacts;
  readonly plan: ExportDemandPlan;
}

/// How a consumer USES a demanded export — the shape the value must render as for that use to be sound:
///
/// - `numeric` — folded into a number (`base + read`). A plain value import, a plain namespace member,
///   or a readable require.
/// - `callable` — invoked (`x()` / `ns.m()`). A hoisted-function call import or a namespace `callMembers`
///   read. Folding a function's source text instead is a rename-sensitive false positive.
/// - `reference` — captured by identity only (`objectRef`), never folded. Folding or calling an object
///   is a type error.
export type ConsumptionShape = "numeric" | "callable" | "reference";

/// One consumer's demand on ONE readable edge: the demanding module, the edge, the direct-target export
/// it names, how it consumes it, and the supply resolution of that name from the direct target (through
/// barrels). The route provenance is the ACTUAL resolution, not a guessed first route.
export interface ConsumptionRecord {
  readonly consumerModuleId: string;
  readonly dependency: DependencyOperation;
  readonly target: string;
  readonly demandedName: string;
  readonly shape: ConsumptionShape;
  readonly supply: ExportSupply;
}

/// The rendered FORM a definer emits for one export — the single source of truth the renderer and the
/// validator both obey, so callability can never be "demanded by a caller but not forwarded to the
/// definer" without both agreeing it is a mismatch:
///
/// - `value` — a folded numeric `const`/`module.exports` value.
/// - `function` — a callable export: a `callable-own-state` definer's state-reading function, OR a
///   numeric-fold definer whose name a DIRECT call import marked callable (a constant-returning
///   function). Callability is marked only on a direct edge, never forwarded through a barrel.
/// - `object` — a fresh object literal (an `objectExport` definer).
export type RenderedExportForm = "value" | "function" | "object";

/// The aggregated demand on ONE resolved definer export `(moduleId, exportName)`, across ALL consumers
/// that resolve here: the definer's export shape, the rendered form, every consumption shape demanded
/// (a set larger than one is an incompatible-consumption conflict), and whether any route reaches it
/// through a barrel star/named hop.
export interface ResolvedExportDemand {
  readonly origin: ExportOrigin;
  readonly definerShape: ModuleExportShape["kind"];
  readonly renderedForm: RenderedExportForm;
  readonly shapes: ReadonlySet<ConsumptionShape>;
  readonly reachedThroughBarrel: boolean;
}

/// The ONE canonical export-demand plan for a finalized program, keyed by resolved `(moduleId,
/// exportName)`. It carries: the renderer's demand/callability projection (which names each module must
/// expose and which are callable — the relocated fixpoint, byte-identical to the renderer's old one);
/// per-consumer consumption records with real route provenance; and per-resolved-export aggregation
/// (supply status, rendered form, consumption-shape set, barrel-reached). Validator, renderer, tags,
/// and shrink all read from here.
export interface ExportDemandPlan {
  /// Per module, the export names it must expose, propagated through re-export chains, IN DEMAND
  /// ORDER. (The renderer's `collectRequestedExports.names`.)
  readonly requestedNames: ReadonlyMap<string, readonly string[]>;
  /// Per module, the subset of requested names a DIRECT call import marked callable. (The renderer's
  /// `collectRequestedExports.callable`.)
  readonly callableNames: ReadonlyMap<string, ReadonlySet<string>>;
  /// Every consumer demand, in module then dependency order.
  readonly consumptions: readonly ConsumptionRecord[];
  /// Per resolved export `moduleId\0exportName`, the aggregated demand. Only `supplied` consumptions
  /// contribute an entry (an `unsupplied`/`ambiguous` demand has no single resolved definer).
  readonly resolvedDemands: ReadonlyMap<string, ResolvedExportDemand>;
}

export function resolvedExportKey(origin: ExportOrigin): string {
  return `${origin.moduleId}\0${origin.exportName}`;
}

/// Analyze a FINAL program: build its graph facts and the one canonical export-demand plan. Pure over
/// the program (it changes nothing about generation), so it is corpus-preserving by construction — a
/// consumer that switches from its own projection to this plan emits identical output on any program
/// whose demand is unambiguous (the whole generated corpus).
export function analyzeProgram(program: ProgramModel): AnalyzedProgram {
  const facts = ProgramFacts.from(program.modules);
  const plan = buildExportDemandPlan(program, facts);
  return { program, facts, plan };
}

/// The single export name a readable ESM/CJS edge demands on its DIRECT target, plus how the edge
/// consumes it, or `undefined` for edges that demand nothing readable. A namespace import demands one
/// name per read member, so it is expanded by the caller.
function directDemandOf(
  dependency: DependencyOperation,
): { readonly name: string; readonly shape: ConsumptionShape } | undefined {
  if (dependency.kind === "esm-value-import") {
    return {
      name: dependency.importedName,
      shape:
        dependency.objectRef === true
          ? "reference"
          : dependency.call === true
            ? "callable"
            : "numeric",
    };
  }
  if (dependency.kind === "cjs-require" && dependency.readName !== undefined) {
    return { name: dependency.readName, shape: "numeric" };
  }
  return undefined;
}

function buildExportDemandPlan(program: ProgramModel, facts: ProgramFacts): ExportDemandPlan {
  const { requestedNames, callableNames } = collectRequestedExports(program);

  const consumptions: ConsumptionRecord[] = [];
  const push = (
    consumerModuleId: string,
    dependency: DependencyOperation,
    target: string,
    demandedName: string,
    shape: ConsumptionShape,
  ): void => {
    consumptions.push({
      consumerModuleId,
      dependency,
      target,
      demandedName,
      shape,
      supply: facts.resolveExportRoute(target, demandedName),
    });
  };

  for (const module of program.modules) {
    for (const dependency of module.dependencies) {
      if (dependency.kind === "esm-namespace-import") {
        const callMembers = new Set(dependency.callMembers ?? []);
        for (const member of dependency.readMembers) {
          push(
            module.id,
            dependency,
            dependency.target,
            member,
            callMembers.has(member) ? "callable" : "numeric",
          );
        }
        continue;
      }
      const demand = directDemandOf(dependency);
      if (demand !== undefined) {
        push(module.id, dependency, dependency.target, demand.name, demand.shape);
      }
    }
  }

  const modulesById = new Map(program.modules.map((module) => [module.id, module]));
  const resolvedDemands = new Map<string, ResolvedExportDemand>();
  for (const consumption of consumptions) {
    if (consumption.supply.status !== "supplied") {
      continue;
    }
    const { origin, hops } = consumption.supply;
    const key = resolvedExportKey(origin);
    const definer = modulesById.get(origin.moduleId);
    const definerShape =
      definer === undefined ? "numeric-fold" : moduleProfile(definer).exportShape.kind;
    const reachedThroughBarrel = hops.length > 0;
    const existing = resolvedDemands.get(key);
    const shapes = new Set(existing?.shapes ?? []);
    shapes.add(consumption.shape);
    resolvedDemands.set(key, {
      origin,
      definerShape,
      renderedForm: renderedFormOf(definer, origin.exportName, callableNames),
      shapes,
      reachedThroughBarrel: (existing?.reachedThroughBarrel ?? false) || reachedThroughBarrel,
    });
  }

  return { requestedNames, callableNames, consumptions, resolvedDemands };
}

/// The rendered form of `exportName` on `definer`: its export-shape decides object/function; a
/// numeric-fold definer renders a callable FUNCTION only when a direct call import marked the name
/// callable ON THE DEFINER (never forwarded through a barrel), else a plain value.
function renderedFormOf(
  definer: ModuleModel | undefined,
  exportName: string,
  callableNames: ReadonlyMap<string, ReadonlySet<string>>,
): RenderedExportForm {
  if (definer === undefined) {
    return "value";
  }
  const shape = moduleProfile(definer).exportShape.kind;
  if (shape === "fresh-object") {
    return "object";
  }
  if (shape === "callable-own-state") {
    return "function";
  }
  return callableNames.get(definer.id)?.has(exportName) === true ? "function" : "value";
}

/// The export names each module must expose, propagated through re-export (barrel) chains — RELOCATED
/// verbatim from the renderer so demand and callability have one owner. A value import demands its
/// imported name; a namespace import demands each read member; a readable require demands the name it
/// reads; a named re-export references its source on the target; a star re-export forwards any name
/// demanded on the barrel down to its target. A call import (or a namespace call member) also records
/// its name as callable on the DIRECT target (callability is never forwarded through a star).
export function collectRequestedExports(program: ProgramModel): {
  readonly requestedNames: ReadonlyMap<string, readonly string[]>;
  readonly callableNames: ReadonlyMap<string, ReadonlySet<string>>;
} {
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
        const callMembers = new Set(dependency.callMembers ?? []);
        for (const member of dependency.readMembers) {
          demand(dependency.target, member);
          if (callMembers.has(member)) {
            markCallable(dependency.target, member);
          }
        }
      } else if (dependency.kind === "cjs-require" && dependency.readName !== undefined) {
        demand(dependency.target, dependency.readName);
      } else if (dependency.kind === "esm-reexport-named") {
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

  return { requestedNames: requestedExports, callableNames: callableExports };
}

/// The subset of a module's requested exports it must synthesize LOCALLY (a state-derived value):
/// everything a re-export does not forward. CJS synthesizes all; an ESM barrel forwards names via named
/// re-exports or a star (which forwards everything else), leaving a pure barrel with no local exports.
/// RELOCATED verbatim from the renderer.
export function localExportsFor(
  module: ModuleModel,
  requested: readonly string[],
): readonly string[] {
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
