import type { DependencyOperation, ModuleExportShape, ModuleModel, ProgramModel } from "./model.ts";
import { moduleProfile } from "./model.ts";
import type { ExportOrigin, ExportSupply } from "./program-facts.ts";
import { ProgramFacts, providedExportNames, starShadowedNames } from "./program-facts.ts";

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

/// WHY a name is demanded on a target — the purpose dimension the validator uses to decide what soundness
/// to enforce:
///
/// - `live` — the name is READ / CALLED / CAPTURED at runtime (a value import, namespace member, or
///   readable require). Checked for SUPPLY (a unique provider) AND for SHAPE (its `shape` must match the
///   definer's rendered form).
/// - `link-required` — the name is STATICALLY LINK-CHECKED only, never read: a named re-export
///   (`export { s as e } from`) forwards the name, so Rolldown's linker requires the target to export
///   `s`, but the barrel itself observes no value. Checked for SUPPLY only — a re-export imposes no
///   runtime form, so it never constrains (or aggregates into) the definer's shape.
///
/// The distinction is what closes the model-authored `MISSING_EXPORT` channel: a named re-export of an
/// unsupplied name (e.g. `export { default as x } from` a star-only barrel) is now REJECTED at validation
/// as an unsupplied link-required demand, instead of rendering an invalid source Rolldown then link-errors
/// on. See `.agents/docs/build-panic-verdict.md`.
export type DemandPurpose = "live" | "link-required";

/// One consumer's demand on ONE edge: the demanding module, the edge, the direct-target export it names,
/// its PURPOSE (live vs link-required), how a live consumer uses it, and the supply resolution of that
/// name from the direct target (through barrels). The route provenance is the ACTUAL resolution, not a
/// guessed first route.
export interface ConsumptionRecord {
  readonly consumerModuleId: string;
  readonly dependency: DependencyOperation;
  readonly target: string;
  readonly demandedName: string;
  /// How a LIVE consumer uses the value. INERT for a `link-required` demand (a named re-export imposes
  /// no runtime form): the shape-soundness check and the resolved-demand aggregation both run only for
  /// `live` purpose, so a link-required record's shape is never consulted. Held as `numeric` (a neutral
  /// placeholder) rather than made optional so the field stays a plain `ConsumptionShape` everywhere.
  readonly shape: ConsumptionShape;
  readonly purpose: DemandPurpose;
  readonly supply: ExportSupply;
}

/// The concrete rendered FORM a definer emits for one export — the analyzer's SINGLE classification of
/// export shape. The renderer maps each form DIRECTLY to one emission template (never re-deriving the
/// shape from the module profile), and the validator collapses it to a consumption category
/// (`formConsumptionShape`). It is finer than a value/function/object trichotomy on purpose: two
/// DISTINCT templates share a category, so a coarser vocabulary could not pick the template. A
/// `callable-own-state` state-reading function and a `callable-constant` constant-returning function are
/// both "callable"; an `inferred-pure` non-inlinable `const` and a plain `numeric-value` fold are both
/// "value".
///
/// - `numeric-value` — a folded numeric `const` (ESM) or `exports.x = <fold>` (CJS) value. Also the form
///   of a CJS or a definer-less (require-of-absent) export, which render a value.
/// - `callable-constant` — a numeric-fold definer's export a DIRECT call import marked callable: a
///   hoisted `function` returning the module's constant base. Callability is marked only on a direct
///   edge, never forwarded through a barrel.
/// - `inferred-pure` — an inferred-pure definer's non-inlinable `/* @__PURE__ */`-call `const`.
/// - `callable-own-state` — a callable-own-state definer's export: a `function` reading a module-scope
///   state var assigned from a pure call.
/// - `fresh-object` — a fresh object literal per export (an `objectExport` definer).
export type RenderedExportForm =
  | "numeric-value"
  | "callable-constant"
  | "inferred-pure"
  | "callable-own-state"
  | "fresh-object";

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

/// The consumption SHAPE a rendered form soundly satisfies — the coarse category the per-consumption
/// validation check compares each consumer's `shape` against, collapsing the five concrete forms onto
/// the shape × form diagonal: a `numeric` fold needs a value form (`numeric-value` / `inferred-pure`), a
/// `callable` call needs a function form (`callable-constant` / `callable-own-state`), a `reference`
/// identity capture needs an object form (`fresh-object`). A consumption whose resolved definer renders a
/// form in a DIFFERENT category misreads it — folding a function's source text into a number, calling a
/// number (a TypeError), or comparing folded numbers for identity (a dead witness).
export function formConsumptionShape(form: RenderedExportForm): ConsumptionShape {
  switch (form) {
    case "numeric-value":
    case "inferred-pure":
      return "numeric";
    case "callable-constant":
    case "callable-own-state":
      return "callable";
    case "fresh-object":
      return "reference";
  }
}

/// The coarse value/function/object NOUN a rendered form reads as in a diagnostic — the display
/// vocabulary the crafted-violation messages use, so a mismatch reads "the definer renders a value"
/// regardless of WHICH value-category form (a numeric fold or an inferred-pure `const`) it actually is.
export function renderedFormNoun(form: RenderedExportForm): "value" | "function" | "object" {
  switch (form) {
    case "numeric-value":
    case "inferred-pure":
      return "value";
    case "callable-constant":
    case "callable-own-state":
      return "function";
    case "fresh-object":
      return "object";
  }
}

/// Counts every run of the demand analysis (one per `analyzeProgram`), so an architectural test can
/// assert a single case path builds the ExportDemandPlan EXACTLY ONCE: `finalizeProgram` produces the
/// one carried `AnalyzedProgram`, and validation / rendering / tags / evaluation consume THAT instance
/// rather than each re-running the analysis (the 3×-per-case regression this wave closes). Test-only.
let demandAnalysisRuns = 0;
export function demandAnalysisRunCount(): number {
  return demandAnalysisRuns;
}
export function resetDemandAnalysisRunCount(): void {
  demandAnalysisRuns = 0;
}

/// Analyze a FINAL program: build its graph facts and the one canonical export-demand plan. Pure over
/// the program (it changes nothing about generation), so it is corpus-preserving by construction — a
/// consumer that switches from its own projection to this plan emits identical output on any program
/// whose demand is unambiguous (the whole generated corpus). The returned plan is FROZEN so accidental
/// post-finalization mutation throws in tests.
export function analyzeProgram(program: ProgramModel): AnalyzedProgram {
  demandAnalysisRuns += 1;
  const facts = ProgramFacts.from(program.modules);
  const plan = freezePlan(buildExportDemandPlan(program, facts));
  return Object.freeze({ program, facts, plan });
}

/// Freeze the plan structures so a consumer cannot accidentally mutate the ONE analyzed view. The maps
/// stay Maps (freezing a Map's entries is not cheap), but the plan object, its arrays, and every record
/// it carries are frozen — enough that a stray `record.renderedForm = …` or `consumptions.push(…)` throws.
function freezePlan(plan: ExportDemandPlan): ExportDemandPlan {
  for (const consumption of plan.consumptions) {
    Object.freeze(consumption);
  }
  Object.freeze(plan.consumptions);
  for (const demand of plan.resolvedDemands.values()) {
    Object.freeze(demand.shapes);
    Object.freeze(demand);
  }
  return Object.freeze(plan);
}

/// The single export name a readable ESM/CJS edge demands on its DIRECT target, plus how the edge
/// consumes it, or `undefined` for edges that demand nothing readable. A namespace import demands one
/// name per read member, so it is expanded by the caller. A LOCAL re-export's import half is a plain
/// LIVE numeric demand — the binding is genuinely in scope (readable), so it is supply- AND
/// shape-checked exactly like a value import (strictly stronger than the link-required check a pure
/// `export … from` re-export gets), which also keeps every event read of the binding sound.
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
  if (dependency.kind === "esm-local-reexport") {
    return { name: dependency.sourceName, shape: "numeric" };
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
    purpose: DemandPurpose,
  ): void => {
    consumptions.push({
      consumerModuleId,
      dependency,
      target,
      demandedName,
      shape,
      purpose,
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
            "live",
          );
        }
        continue;
      }
      if (dependency.kind === "esm-reexport-named") {
        // A named re-export forwards `sourceName` from its target: Rolldown statically link-checks that
        // the target exports it, but nothing READS the value here. A LINK-REQUIRED demand — supply-checked
        // (a unique provider must exist), never shape-checked (a re-export imposes no runtime form). The
        // `numeric` shape is the inert placeholder link-required demands never consult.
        push(
          module.id,
          dependency,
          dependency.target,
          dependency.sourceName,
          "numeric",
          "link-required",
        );
        continue;
      }
      const demand = directDemandOf(dependency);
      if (demand !== undefined) {
        push(module.id, dependency, dependency.target, demand.name, demand.shape, "live");
      }
    }
  }

  const modulesById = new Map(program.modules.map((module) => [module.id, module]));
  const resolvedDemands = new Map<string, ResolvedExportDemand>();
  for (const consumption of consumptions) {
    // Only LIVE consumptions aggregate a rendered-form / shape here — a link-required named re-export
    // observes no value, so it contributes no consumption shape (keeping the aggregation, and the
    // incompatible-consumption diagnostic it drives, byte-identical to before the purpose dimension).
    if (consumption.supply.status !== "supplied" || consumption.purpose !== "live") {
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

/// The rendered form of `exportName` on `definer` — the analyzer's ONE classification of export shape,
/// which the renderer consumes DIRECTLY as its emission-template dispatch (so it never re-derives shape
/// from the module profile) and the validator collapses to a consumption category. It reads the export
/// path precisely, in the profile-precedence order the renderer's templates require:
///
/// - a CJS definer (or a definer-less name) renders a numeric value (`exports.x = <fold>`) → `numeric-value`;
/// - a fresh-object definer renders an object literal → `fresh-object`;
/// - a callable-own-state definer renders a state-reading function → `callable-own-state`;
/// - an inferred-pure definer renders a non-inlinable `const` (this branch takes precedence over any call
///   marking) → `inferred-pure`;
/// - else a numeric-fold definer renders a callable constant-returning function ONLY when a DIRECT call
///   import marked the name callable ON THE DEFINER (never forwarded through a barrel) → `callable-constant`,
///   otherwise a plain folded value → `numeric-value`.
///
/// The CJS and inferred-pure cases stay VALUE-category even when call-marked (the two degenerate crash
/// models finding 3 closes): a callable consumption of one is rejected at validation rather than rendering
/// a `const`/`exports.x = 5` the caller then invokes (a `TypeError`). Byte-identical on the corpus: the
/// generator never call-marks a CJS export (a call import must target ESM) nor an inferred-pure definer's
/// exports (read as numeric folds through the barrel), so those never rendered as functions anyway.
export function renderedFormOf(
  definer: ModuleModel | undefined,
  exportName: string,
  callableNames: ReadonlyMap<string, ReadonlySet<string>>,
): RenderedExportForm {
  if (definer === undefined) {
    return "numeric-value";
  }
  if (definer.format !== "esm") {
    return "numeric-value";
  }
  const profile = moduleProfile(definer);
  if (profile.exportShape.kind === "fresh-object") {
    return "fresh-object";
  }
  if (profile.exportShape.kind === "callable-own-state") {
    return "callable-own-state";
  }
  if (profile.purity.kind === "inferred") {
    return "inferred-pure";
  }
  return callableNames.get(definer.id)?.has(exportName) === true
    ? "callable-constant"
    : "numeric-value";
}

/// The export names each module must expose, propagated through re-export (barrel) chains — RELOCATED
/// verbatim from the renderer so demand and callability have one owner. A value import demands its
/// imported name; a namespace import demands each read member; a readable require demands the name it
/// reads; a named re-export references its source on the target; a star re-export forwards any name
/// demanded on the barrel down to its target. A call import (or a namespace call member) also records
/// its name as callable on the DIRECT target (callability is never forwarded through a star).
/// PRIVATE to the boundary: the renderer no longer runs this fixpoint itself — it reads the plan's
/// `requestedNames` / `callableNames` — so demand analysis has ONE owner (a no-parallel-projection grep
/// test asserts it is not referenced outside this module).
function collectRequestedExports(program: ProgramModel): {
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
      } else if (
        dependency.kind === "esm-reexport-named" ||
        dependency.kind === "esm-local-reexport"
      ) {
        // Both re-export forms demand their source name on the target; a LOCAL re-export's demand is
        // additionally a live import (see `directDemandOf`), but the requested-name projection is one.
        demand(dependency.target, dependency.sourceName);
      }
    }
  }

  // Fixpoint: a `export * from target` barrel forwards every name demanded on it (that a named
  // re-export does not already provide) to its target, so demand reaches the defining module. `default`
  // is NEVER forwarded — a star re-export does not re-export the default export (ES semantics) — so this
  // AGREES with the supply rule in `ProgramFacts.#collectDefiners` (`program-facts.ts`), which also skips
  // `default` through stars. Forwarding it here would let the renderer synthesize a `default` on a definer
  // the supply route reports as unsupplied — the two projections disagreeing, the drift this closes.
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
      const namedProvided = starShadowedNames(module);
      const demandedHere = requestedExports.get(module.id);
      for (let index = 0; index < (demandedHere?.length ?? 0); index += 1) {
        const name = demandedHere?.[index];
        if (name === undefined || name === "default" || namedProvided.has(name)) {
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
/// everything a re-export (named, star, or local) does not provide. CJS synthesizes all; an ESM barrel
/// forwards names via named/local re-exports or a star (which forwards everything else), leaving a
/// pure barrel with no local exports — EXCEPT names the module DECLARES in `localExports`, which
/// synthesize locally even beside a star (a local export shadows `export *`). Reads the SAME shadowing
/// rule as the supply routing (`starShadowedNames`) — never `localExports` directly — so the demand
/// and supply projections agree by construction (W14b.1 blocker 4): a name is synthesized locally when
/// it is not re-export-provided AND either there is no star to suppress it or it is star-shadowed here.
export function localExportsFor(
  module: ModuleModel,
  requested: readonly string[],
): readonly string[] {
  if (module.format === "cjs") {
    return requested;
  }
  const namedProvided = providedExportNames(module);
  const shadowed = starShadowedNames(module);
  const hasStar = module.dependencies.some((dependency) => dependency.kind === "esm-reexport-star");
  return requested.filter((name) => !namedProvided.has(name) && (!hasStar || shadowed.has(name)));
}
