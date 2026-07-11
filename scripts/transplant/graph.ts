/// <reference types="node" />

/// Shared graph model for the transplant pipeline (units 2–4): the stable JSON the extractor
/// (`extract-plugin.mjs`) writes, plus small graph algorithms (in-degree, Tarjan SCC) the reducer and
/// emitter share. Kept separate from the reducer/emitter so both read ONE schema.

import { readFileSync } from "node:fs";

/// rolldown `ModuleInfo.inputFormat`.
export type InputFormat = "es" | "cjs" | "unknown" | null;

/// The import KIND / export SHAPE the extractor classifies per edge (AST-based, edge-precise).
export type EdgeKind =
  | "named"
  | "default"
  | "namespace"
  | "side-effect"
  | "reexport-named"
  | "reexport-star"
  | "reexport-namespace";

export interface GraphPackage {
  readonly name: string;
  readonly version: string | null;
}

export interface GraphModule {
  readonly id: string;
  readonly isEntry: boolean;
  readonly format: InputFormat;
  readonly exports: readonly string[];
  readonly localExports: readonly string[];
  readonly moduleSideEffects: boolean | "no-treeshake" | null;
  readonly pkg: GraphPackage | null;
  readonly pkgSideEffects: boolean | readonly string[] | null;
  readonly importedIds: readonly string[];
  readonly dynamicallyImportedIds: readonly string[];
  readonly importers: readonly string[];
  readonly dynamicImporters: readonly string[];
  readonly edgeKinds: Readonly<Record<string, readonly EdgeKind[]>>;
  readonly starReexportTargets: readonly string[];
  readonly nsReexports: readonly { readonly target: string; readonly exportedName: string }[];
  readonly namedReexports: readonly {
    readonly target: string;
    readonly names: Readonly<Record<string, string>>;
  }[];
  readonly classifiedBy: "ast" | "regex" | "none";
}

export interface GraphChunk {
  readonly fileName: string;
  readonly name: string;
  readonly isEntry: boolean;
  readonly isDynamicEntry: boolean;
  readonly facadeModuleId: string | null;
  readonly moduleIds: readonly string[];
  readonly exports: readonly string[];
  readonly imports: readonly string[];
  readonly dynamicImports: readonly string[];
}

export interface SkeletonGraph {
  readonly meta: {
    readonly app: string;
    readonly generatedAt: string;
    readonly moduleCount: number;
    readonly chunkCount: number;
    readonly cwd: string;
    readonly classification?: unknown;
  };
  readonly modules: readonly GraphModule[];
  readonly chunks: readonly GraphChunk[];
}

export function loadGraph(path: string): SkeletonGraph {
  return JSON.parse(readFileSync(path, "utf8")) as SkeletonGraph;
}

/// Map id -> module for O(1) lookup.
export function indexById(graph: SkeletonGraph): Map<string, GraphModule> {
  return new Map(graph.modules.map((module) => [module.id, module]));
}

/// The model format a rolldown input format maps to (`unknown` -> `esm`, the model default).
export function modelFormat(format: InputFormat): "esm" | "cjs" {
  return format === "cjs" ? "cjs" : "esm";
}

/// Static in-degree of every module (how many modules statically import it), restricted to a kept set
/// when one is given.
export function staticInDegree(
  modules: readonly GraphModule[],
  kept?: ReadonlySet<string>,
): Map<string, number> {
  const inDegree = new Map<string, number>();
  for (const module of modules) {
    if (kept && !kept.has(module.id)) continue;
    for (const target of module.importedIds) {
      if (kept && !kept.has(target)) continue;
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    }
  }
  return inDegree;
}

/// Iterative Tarjan strongly-connected components over an arbitrary adjacency (real graphs are deep
/// enough to blow a recursive stack). Returns components in reverse-topological order; a component of
/// size > 1 (or a self-loop) is a cycle.
export function sccOfAdjacency(
  nodes: Iterable<string>,
  neighbors: (id: string) => Iterable<string>,
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: { readonly node: string; edgeIndex: number; readonly targets: string[] }[] = [
      { node: root, edgeIndex: 0, targets: [...neighbors(root)] },
    ];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const node = frame.node;
      if (frame.edgeIndex < frame.targets.length) {
        const next = frame.targets[frame.edgeIndex]!;
        frame.edgeIndex += 1;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, edgeIndex: 0, targets: [...neighbors(next)] });
        } else if (onStack.has(next)) {
          low.set(node, Math.min(low.get(node)!, index.get(next)!));
        }
        continue;
      }
      if (low.get(node) === index.get(node)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
          if (popped === node) break;
        }
        components.push(component);
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]!.node;
        low.set(parent, Math.min(low.get(parent)!, low.get(node)!));
      }
    }
  }
  return components;
}

/// Tarjan SCC over the STATIC import edges, restricted to a kept set.
export function stronglyConnectedComponents(
  modules: readonly GraphModule[],
  byId: ReadonlyMap<string, GraphModule>,
  kept: ReadonlySet<string>,
): string[][] {
  void modules;
  return sccOfAdjacency(kept, (id) =>
    (byId.get(id)?.importedIds ?? []).filter((target) => kept.has(target)),
  );
}
