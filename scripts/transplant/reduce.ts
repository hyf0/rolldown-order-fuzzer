/// <reference types="node" />

/// Transplant unit 2 — the REDUCER. Turns an extracted real-app graph (thousands of modules) into an
/// order-relevant subgraph of a few hundred, composing the three strategies from the feasibility doc
/// as named passes, then breaking mixed-format cycles and assigning an event budget:
///
///   1. VENDOR/LEAF COLLAPSE (lossless for order) — a self-contained multi-member package (its members
///      import nothing outside the package: lucide-react's 1706 icons, date-fns' 826 locales) carries no
///      execution-order structure among its members, so keep ONE representative (highest external
///      in-degree, with the collapsed count recorded) and drop the rest.
///   2. ORDER-CORE k-HOP — seed at the order-relevant sites (entries, app-source, star-barrels, cycle
///      members, shared hubs) and expand k hops over static+dynamic edges, closing under the induced
///      edges. This is the family-A/B-bearing subgraph; peripheral fan-out beyond k hops is truncated.
///   3. SCC-QUOTIENT (optional) — condense each strongly-connected component to one representative,
///      preserving reachability and relative order exactly (low leverage on shallow apps, composes
///      cleanly for deeper ones).
///
/// Then MIXED-FORMAT-CYCLE BREAK (contract): any strongly-connected component that spans ESM and CJS is
/// Node-illegal (`require` of an evaluating ESM) and unrepresentable, so its cross-format edges are
/// dropped. Single-format side-effect/require cycles are Node-legal and kept. Finally an EVENT BUDGET:
/// at most `eventBudget` kept modules emit execution events (the harness cap is 512 EVENTS, not
/// modules); the rest stay structurally present but event-free.

import {
  indexById,
  modelFormat,
  sccOfAdjacency,
  staticInDegree,
  stronglyConnectedComponents,
  type EdgeKind,
  type GraphModule,
  type GraphPackage,
  type SkeletonGraph,
} from "./graph.ts";

export interface ReduceConfig {
  /// k in the k-hop order-core expansion (default 2).
  readonly kHop: number;
  /// Hard cap on kept modules; a k-hop closure over budget is trimmed by priority (default 260).
  readonly maxModules: number;
  /// Static in-degree at/above which a module is a "shared hub" order-core seed (default 5).
  readonly hubThreshold: number;
  /// At most this many kept modules emit execution events; the rest are event-free (default 500).
  readonly eventBudget: number;
  /// Collapse self-contained multi-member vendor packages to one representative (default true).
  readonly collapseLeafPackages: boolean;
  /// Condense each strongly-connected component to one representative (default false — real
  /// single-format cycles are kept as order structure).
  readonly sccQuotient: boolean;
}

export const DEFAULT_REDUCE_CONFIG: ReduceConfig = {
  kHop: 2,
  maxModules: 260,
  hubThreshold: 5,
  eventBudget: 500,
  collapseLeafPackages: true,
  sccQuotient: false,
};

export interface ReducedEdge {
  readonly target: string;
  readonly kind: EdgeKind;
}

export interface ReducedModule {
  readonly id: string;
  readonly format: "esm" | "cjs";
  readonly isEntry: boolean;
  readonly edges: readonly ReducedEdge[];
  readonly dynamicEdges: readonly string[];
  readonly pkg: GraphPackage | null;
  readonly pkgSideEffects: boolean | readonly string[] | null;
  readonly starReexportTargets: readonly string[];
  readonly nsReexports: readonly { readonly target: string; readonly exportedName: string }[];
  readonly namedReexports: readonly {
    readonly target: string;
    readonly names: Readonly<Record<string, string>>;
  }[];
  readonly inDegree: number;
  /// How many collapsed leaf-package siblings this representative stands in for (0 = none).
  readonly collapsedCount: number;
  /// Whether this module emits an execution event (within the event budget).
  readonly eventEmitting: boolean;
  /// A star-barrel namespace-imported by >=2 consumers is a direct family-A overlay site.
  readonly nsImporterCount: number;
}

export interface ReducedGraph {
  readonly app: string;
  readonly modules: readonly ReducedModule[];
  readonly entries: readonly string[];
  readonly chunks: readonly { readonly name: string; readonly moduleIds: readonly string[] }[];
  readonly meta: {
    readonly originalModuleCount: number;
    readonly keptCount: number;
    readonly eventEmittingCount: number;
    readonly droppedByLeafCollapse: number;
    readonly mixedFormatEdgesBroken: number;
    readonly sccQuotiented: number;
    readonly starBarrelSites: number;
    readonly config: ReduceConfig;
  };
}

/// A package is a COLLAPSIBLE LEAF when it has more than one member and no member imports a module
/// outside the package — it is a self-contained vendor fan-out (icons/locales) with no internal order
/// structure. `null`-package (app-source) modules are never leaves.
function collapsibleLeafPackages(
  modules: readonly GraphModule[],
  byId: ReadonlyMap<string, GraphModule>,
): Map<string, GraphModule[]> {
  const membersByPackage = new Map<string, GraphModule[]>();
  for (const module of modules) {
    if (!module.pkg) continue;
    const list = membersByPackage.get(module.pkg.name) ?? [];
    list.push(module);
    membersByPackage.set(module.pkg.name, list);
  }
  const leaves = new Map<string, GraphModule[]>();
  for (const [name, members] of membersByPackage) {
    if (members.length <= 1) continue;
    const selfContained = members.every((member) =>
      member.importedIds.every((target) => byId.get(target)?.pkg?.name === name),
    );
    if (selfContained) leaves.set(name, members);
  }
  return leaves;
}

export function reduceGraph(
  graph: SkeletonGraph,
  config: ReduceConfig = DEFAULT_REDUCE_CONFIG,
): ReducedGraph {
  const byId = indexById(graph);
  const globalInDegree = staticInDegree(graph.modules);

  // ---- pass 1: vendor/leaf collapse -> the set of dropped (non-representative) leaf siblings ----
  const dropped = new Set<string>();
  const collapsedCount = new Map<string, number>();
  if (config.collapseLeafPackages) {
    for (const members of collapsibleLeafPackages(graph.modules, byId).values()) {
      // The representative is the member with the highest EXTERNAL in-degree (most-imported public
      // entry point). Keep it; drop the rest; record how many it stands in for.
      const externalInDegree = (module: GraphModule): number =>
        module.importers.filter((importer) => byId.get(importer)?.pkg?.name !== module.pkg?.name)
          .length;
      const sorted = [...members].sort((a, b) => externalInDegree(b) - externalInDegree(a));
      const representative = sorted[0]!;
      for (const member of sorted.slice(1)) dropped.add(member.id);
      collapsedCount.set(representative.id, members.length - 1);
    }
  }

  const alive = (id: string): boolean => byId.has(id) && !dropped.has(id);

  // ---- pass 2: order-core k-hop ----
  // Seeds: entries, app-source (no package), star-barrels, cycle members, shared hubs.
  const allKept = new Set(
    graph.modules.filter((module) => alive(module.id)).map((module) => module.id),
  );
  const cycleMembers = new Set<string>();
  for (const component of stronglyConnectedComponents(graph.modules, byId, allKept)) {
    if (component.length > 1) for (const id of component) cycleMembers.add(id);
  }
  const seeds = new Set<string>();
  for (const module of graph.modules) {
    if (!alive(module.id)) continue;
    const isHub = (globalInDegree.get(module.id) ?? 0) >= config.hubThreshold;
    if (
      module.isEntry ||
      module.pkg === null ||
      module.starReexportTargets.length > 0 ||
      cycleMembers.has(module.id) ||
      module.dynamicallyImportedIds.length > 0 ||
      module.dynamicImporters.length > 0 ||
      isHub
    ) {
      seeds.add(module.id);
    }
  }
  // k-hop expansion over static + dynamic edges, skipping dropped leaf siblings.
  const kept = new Set(seeds);
  let frontier = [...seeds];
  for (let hop = 0; hop < config.kHop && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const module = byId.get(id);
      if (!module) continue;
      for (const target of [...module.importedIds, ...module.dynamicallyImportedIds]) {
        if (alive(target) && !kept.has(target)) {
          kept.add(target);
          next.push(target);
        }
      }
    }
    frontier = next;
  }
  // Always keep the real entries (a schedule needs them) even if pruned above.
  for (const module of graph.modules) if (module.isEntry && alive(module.id)) kept.add(module.id);

  // Trim to maxModules by priority: entries + seeds first, then by in-degree.
  if (kept.size > config.maxModules) {
    const priority = (id: string): number => {
      const module = byId.get(id)!;
      if (module.isEntry) return 3;
      if (seeds.has(id)) return 2;
      return 1;
    };
    const ordered = [...kept].sort((a, b) => {
      const byPriority = priority(b) - priority(a);
      if (byPriority !== 0) return byPriority;
      return (globalInDegree.get(b) ?? 0) - (globalInDegree.get(a) ?? 0);
    });
    kept.clear();
    for (const id of ordered.slice(0, config.maxModules)) kept.add(id);
  }

  // ---- pass 3 (optional): SCC-quotient — collapse each kept cycle to a representative ----
  let sccQuotiented = 0;
  const quotientOf = new Map<string, string>(); // member -> representative
  if (config.sccQuotient) {
    for (const component of stronglyConnectedComponents(graph.modules, byId, kept)) {
      if (component.length <= 1) continue;
      const representative = component.reduce((best, id) =>
        (globalInDegree.get(id) ?? 0) > (globalInDegree.get(best) ?? 0) ? id : best,
      );
      for (const id of component) {
        if (id !== representative) {
          quotientOf.set(id, representative);
          kept.delete(id);
          sccQuotiented += 1;
        }
      }
    }
  }
  const rep = (id: string): string => quotientOf.get(id) ?? id;

  // ---- induce edges over the kept set (kinds preserved), collapsing quotiented members ----
  const inducedInDegree = staticInDegree(graph.modules, kept);
  const inducedModules: ReducedModule[] = [];
  const keptOrdered = [...kept].sort();
  // Count how many kept consumers namespace-import each star-barrel (family-A site strength).
  const nsImporters = new Map<string, Set<string>>();
  for (const id of keptOrdered) {
    const module = byId.get(id)!;
    for (const [target, kinds] of Object.entries(module.edgeKinds)) {
      const targetRep = rep(target);
      if (kept.has(targetRep) && kinds.includes("namespace")) {
        const set = nsImporters.get(targetRep) ?? new Set<string>();
        set.add(id);
        nsImporters.set(targetRep, set);
      }
    }
  }

  for (const id of keptOrdered) {
    const module = byId.get(id)!;
    const seenEdge = new Set<string>();
    const edges: ReducedEdge[] = [];
    for (const target of module.importedIds) {
      const targetRep = rep(target);
      if (!kept.has(targetRep) || targetRep === id) continue;
      const kinds = module.edgeKinds[target] ?? ["side-effect"];
      for (const kind of kinds) {
        const key = `${targetRep}\0${kind}`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        edges.push({ target: targetRep, kind });
      }
    }
    const dynamicEdges = [
      ...new Set(module.dynamicallyImportedIds.map(rep).filter((t) => kept.has(t) && t !== id)),
    ];
    inducedModules.push({
      id,
      format: modelFormat(module.format),
      isEntry: module.isEntry,
      edges,
      dynamicEdges,
      pkg: module.pkg,
      pkgSideEffects: module.pkgSideEffects,
      starReexportTargets: [...new Set(module.starReexportTargets.map(rep))].filter(
        (t) => kept.has(t) && t !== id,
      ),
      nsReexports: module.nsReexports
        .map((r) => ({ target: rep(r.target), exportedName: r.exportedName }))
        .filter((r) => kept.has(r.target)),
      namedReexports: module.namedReexports
        .map((r) => ({ target: rep(r.target), names: r.names }))
        .filter((r) => kept.has(r.target)),
      inDegree: inducedInDegree.get(id) ?? 0,
      collapsedCount: collapsedCount.get(id) ?? 0,
      eventEmitting: false, // assigned below
      nsImporterCount: nsImporters.get(id)?.size ?? 0,
    });
  }

  // ---- mixed-format-cycle break (contract) ----
  const keptSet = new Set(inducedModules.map((module) => module.id));
  const formatOf = new Map(inducedModules.map((module) => [module.id, module.format]));
  const inducedById = new Map(inducedModules.map((module) => [module.id, module]));
  let mixedFormatEdgesBroken = 0;
  const brokenEdges = new Set<string>(); // `importer\0target`
  for (const component of sccOfAdjacency(keptSet, (id) =>
    (inducedById.get(id)?.edges ?? []).map((edge) => edge.target),
  )) {
    if (component.length <= 1) continue;
    const componentSet = new Set(component);
    const formats = new Set(component.map((id) => formatOf.get(id)));
    if (formats.size < 2) continue; // single-format cycle — Node-legal, keep it
    for (const importer of component) {
      const module = inducedById.get(importer)!;
      for (const edge of module.edges) {
        if (componentSet.has(edge.target) && formatOf.get(importer) !== formatOf.get(edge.target)) {
          brokenEdges.add(`${importer}\0${edge.target}`);
          mixedFormatEdgesBroken += 1;
        }
      }
    }
  }
  const brokenApplied: ReducedModule[] = inducedModules.map((module) => ({
    ...module,
    edges: module.edges.filter((edge) => !brokenEdges.has(`${module.id}\0${edge.target}`)),
    dynamicEdges: module.dynamicEdges,
  }));

  // ---- event budget: mark <= eventBudget modules event-emitting (prefer app-source + hubs) ----
  const eventOrder = [...brokenApplied].sort((a, b) => {
    const score = (module: ReducedModule): number =>
      (module.pkg === null ? 2 : 0) + (module.isEntry ? 1 : 0);
    const byScore = score(b) - score(a);
    if (byScore !== 0) return byScore;
    return b.inDegree - a.inDegree;
  });
  const eventEmitting = new Set(eventOrder.slice(0, config.eventBudget).map((module) => module.id));
  const finalModules = brokenApplied.map((module) => ({
    ...module,
    eventEmitting: eventEmitting.has(module.id),
  }));

  const entries = finalModules.filter((module) => module.isEntry).map((module) => module.id);
  const chunks = graph.chunks
    .map((chunk) => ({
      name: chunk.name || chunk.fileName,
      moduleIds: chunk.moduleIds.map(rep).filter((id) => keptSet.has(id)),
    }))
    .filter((chunk) => chunk.moduleIds.length > 0);

  return {
    app: graph.meta.app,
    modules: finalModules,
    entries,
    chunks,
    meta: {
      originalModuleCount: graph.modules.length,
      keptCount: finalModules.length,
      eventEmittingCount: eventEmitting.size,
      droppedByLeafCollapse: dropped.size,
      mixedFormatEdgesBroken,
      sccQuotiented,
      starBarrelSites: finalModules.filter((module) => module.nsImporterCount >= 2).length,
      config,
    },
  };
}
