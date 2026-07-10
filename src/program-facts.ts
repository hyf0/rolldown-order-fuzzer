import type { DependencyOperation, ModuleFormat } from "./model.ts";

/// The minimal module surface the graph/facts service needs: an id, a format, and ordered dependency
/// operations. Both a finalized `ModuleModel` and a mid-generation draft satisfy it, so generation,
/// validation, tags, and shrinking share ONE implementation of every graph fact instead of the five
/// near-identical reachability/cycle/export-origin walks the codebase had drifted into.
export interface ModuleLike {
  readonly id: string;
  readonly format: ModuleFormat;
  readonly dependencies: readonly DependencyOperation[];
  /// Only ESM modules carry this; drafts never do. Used for the require-of-evaluating-ESM exclusion.
  readonly hasTopLevelAwait?: boolean;
}

/// The synchronous cycle structure of a program: which modules sit on a cycle, their clusters (SCCs),
/// the formats present among cyclic members (a mixed-format synchronous SCC is Node-illegal), and the
/// richer topologies coverage certifies (a chord, an interlocking figure-eight, multiple entry members).
export interface CycleFacts {
  readonly cyclicMembers: ReadonlySet<string>;
  readonly sccs: readonly (readonly string[])[];
  /// The union of formats across ALL cyclic members — a program-wide summary.
  readonly formats: ReadonlySet<ModuleFormat>;
  /// The formats present in EACH synchronous SCC, parallel to `sccs`. A per-SCC breakdown is what a
  /// per-format cycle predicate needs: a program with a separate all-ESM SCC and a separate all-CJS SCC
  /// has BOTH an esm-cycle and a cjs-cycle, which the program-wide `formats` (size 2) would hide.
  readonly sccFormats: readonly ReadonlySet<ModuleFormat>[];
  readonly hasChord: boolean;
  readonly hasInterlocking: boolean;
  readonly hasMultiEnter: boolean;
}

/// Where a demanded export name is ultimately synthesized, after following re-export (barrel) chains.
export interface ExportOrigin {
  readonly moduleId: string;
  readonly exportName: string;
}

/// One re-export hop a demanded name travels through on its way to a definer: a named re-export
/// (`export { s as e } from`) or a star re-export (`export * from`), and the barrel module doing it.
export interface RouteHop {
  readonly via: "named" | "star";
  readonly through: string;
}

/// The SUPPLY resolution of a demanded `(module, exportName)` — the supply-aware sibling of
/// `resolveExportOrigin`, which always returns a (possibly fabricated) single origin. A module
/// SYNTHESIZES any demanded name on demand UNLESS it suppresses local synthesis, which an ESM module
/// does exactly when it carries a star re-export (`localExportsFor` renders nothing local then). So:
///
/// - `supplied` — exactly one genuine definer provides the name, reached by `hops` (a unique route);
/// - `ambiguous` — two or more DISTINCT definers provide it (duplicate named exports, or two star
///   re-exports each forwarding a different definer) — a real interop error the renderer would resolve
///   arbitrarily;
/// - `unsupplied` — no definer provides it. The canonical case is a `default` import through a
///   star-only barrel: a star re-export never forwards `default`, and the barrel (carrying a star)
///   synthesizes nothing local, so the demanded `default` has no provider and renders as an undefined
///   import.
export type ExportSupply =
  | {
      readonly status: "supplied";
      readonly origin: ExportOrigin;
      readonly hops: readonly RouteHop[];
    }
  | { readonly status: "ambiguous"; readonly origins: readonly ExportOrigin[] }
  | { readonly status: "unsupplied"; readonly at: ExportOrigin };

/// The strongly-connected components of the synchronous graph: every component, each node's component
/// index, and which component indices are CYCLIC (>= 2 members, or a single member with a self-edge).
interface SccComponents {
  readonly components: readonly (readonly string[])[];
  readonly indexOf: ReadonlyMap<string, number>;
  readonly cyclic: ReadonlySet<number>;
}

function syncTargetsOf(module: ModuleLike | undefined): string[] {
  if (module === undefined) {
    return [];
  }
  return module.dependencies.flatMap((dependency) =>
    dependency.kind === "esm-dynamic-import" ? [] : [dependency.target],
  );
}

/// A pure graph/facts service over a set of modules. Every fact is derived from the final graph, so a
/// consumer never trusts a side list. All queries are cached; the service is immutable (build a fresh
/// one after mutating the graph, as generation does per pass).
export class ProgramFacts {
  readonly #modulesById: ReadonlyMap<string, ModuleLike>;
  /// Per-node memoized synchronous reachable sets (traversal flavor). Computed on demand per queried
  /// node, so a very long chain never pays for all-pairs reachability it does not use.
  readonly #reachCache = new Map<string, ReadonlySet<string>>();
  #sccComponents: SccComponents | undefined;
  #cycles: CycleFacts | undefined;
  #topLevelAwaitReachers: ReadonlySet<string> | undefined;

  private constructor(modulesById: ReadonlyMap<string, ModuleLike>) {
    this.#modulesById = modulesById;
  }

  static from(modules: Iterable<ModuleLike>): ProgramFacts {
    const modulesById = new Map<string, ModuleLike>();
    for (const module of modules) {
      if (!modulesById.has(module.id)) {
        modulesById.set(module.id, module);
      }
    }
    return new ProgramFacts(modulesById);
  }

  module(id: string): ModuleLike | undefined {
    return this.#modulesById.get(id);
  }

  get moduleIds(): Iterable<string> {
    return this.#modulesById.keys();
  }

  /// The non-dynamic dependency targets of a module, in dependency order (duplicates preserved, for
  /// internal-edge counting). A dynamic import defers, so it is never a synchronous edge.
  syncTargets(id: string): string[] {
    return syncTargetsOf(this.#modulesById.get(id));
  }

  /// The modules reachable from `id` through SYNCHRONOUS edges, EXCLUDING `id` itself unless `id` sits
  /// on a cycle (then a back edge re-reaches it). Memoized per node. Marks a node reached when first
  /// enqueued (as a target) and expands it once when dequeued, so the start is never in the set unless
  /// re-reached.
  reachableFrom(id: string): ReadonlySet<string> {
    const cached = this.#reachCache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const reached = new Set<string>();
    const pending: string[] = [id];
    while (pending.length > 0) {
      const moduleId = pending.pop();
      if (moduleId === undefined) {
        continue;
      }
      for (const target of syncTargetsOf(this.#modulesById.get(moduleId))) {
        if (reached.has(target)) {
          continue;
        }
        reached.add(target);
        pending.push(target);
      }
    }
    this.#reachCache.set(id, reached);
    return reached;
  }

  /// The synchronous closure INCLUDING `id` — the modules that evaluate when `id` evaluates. This is
  /// the traversal flavor (entry coverage, schedule evaluation, nested-dynamic detection).
  closureFrom(id: string): ReadonlySet<string> {
    const closure = new Set<string>([id]);
    for (const reached of this.reachableFrom(id)) {
      closure.add(reached);
    }
    return closure;
  }

  /// Whether the edge `fromId -> toId` closes a synchronous cycle. Every caller passes an EXISTING
  /// synchronous edge, so this is exactly "`from` and `to` sit in one cyclic strongly-connected
  /// component" — an O(1) SCC-membership test after the O(V+E) SCC pass, avoiding all-pairs reachability.
  edgeClosesCycle(fromId: string, toId: string): boolean {
    const components = this.#sccs();
    const fromScc = components.indexOf.get(fromId);
    return (
      fromScc !== undefined &&
      fromScc === components.indexOf.get(toId) &&
      components.cyclic.has(fromScc)
    );
  }

  /// Whether ADDING a synchronous edge `fromId -> toId` (which may not exist yet, or may exist only as
  /// a DYNAMIC edge) would close a synchronous cycle. Unlike `edgeClosesCycle` — which is an
  /// SCC-membership test valid only for an edge that already exists synchronously — this asks the
  /// forward question a graph mutator needs: a new synchronous `from -> to` closes a cycle exactly when
  /// it is a self-edge, or `to` can ALREADY synchronously reach `from` (so `from -> to -> … -> from`).
  /// Use this when deciding whether to introduce an edge (e.g. augmenting a dynamic-only pair with a
  /// synchronous kind); `edgeClosesCycle` would give the wrong answer for a pair joined only dynamically.
  wouldCloseSynchronousEdge(fromId: string, toId: string): boolean {
    return fromId === toId || this.reachableFrom(toId).has(fromId);
  }

  /// Whether `id`'s synchronous closure contains a top-level-await module (so a `require` of it would
  /// reach TLA — forbidden, because `require` of an evaluating-with-await ESM module is illegal).
  reachesTopLevelAwait(id: string): boolean {
    for (const reached of this.closureFrom(id)) {
      const module = this.#modulesById.get(reached);
      if (module?.format === "esm" && module.hasTopLevelAwait === true) {
        return true;
      }
    }
    return false;
  }

  /// The set of modules that synchronously reach a top-level-await module (a TLA module reaches
  /// itself). A `cjs-require` of any module in this set is illegal. Computed by a reverse BFS from the
  /// TLA modules (O(V+E)), not all-pairs reachability, so a very long chain stays cheap.
  topLevelAwaitReachers(): ReadonlySet<string> {
    if (this.#topLevelAwaitReachers === undefined) {
      const synchronousDependents = new Map<string, string[]>();
      const reachers = new Set<string>();
      const pending: string[] = [];
      for (const module of this.#modulesById.values()) {
        if (module.format === "esm" && module.hasTopLevelAwait === true) {
          reachers.add(module.id);
          pending.push(module.id);
        }
        for (const target of syncTargetsOf(module)) {
          if (!this.#modulesById.has(target)) {
            continue;
          }
          const dependents = synchronousDependents.get(target);
          if (dependents === undefined) {
            synchronousDependents.set(target, [module.id]);
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
          if (!reachers.has(dependentId)) {
            reachers.add(dependentId);
            pending.push(dependentId);
          }
        }
      }
      this.#topLevelAwaitReachers = reachers;
    }
    return this.#topLevelAwaitReachers;
  }

  cycles(): CycleFacts {
    if (this.#cycles === undefined) {
      this.#cycles = this.#analyzeCycles();
    }
    return this.#cycles;
  }

  /// Resolve where a demanded export is ultimately synthesized, following named re-exports
  /// (`export { source as exported } from`) and star re-exports (`export * from`) toward the defining
  /// module. Generated barrels forward one definer per name (names are unique), so the walk is
  /// deterministic; a `visited` guard tolerates a pathological self-star in a handwritten model. A
  /// named re-export of `default` (`export { default as X }`) routes demand to the target's `default`.
  resolveExportOrigin(moduleId: string, exportName: string): ExportOrigin | undefined {
    return this.#resolveExportOrigin(moduleId, exportName, new Set<string>());
  }

  #resolveExportOrigin(
    moduleId: string,
    exportName: string,
    visited: Set<string>,
  ): ExportOrigin | undefined {
    const module = this.#modulesById.get(moduleId);
    if (module === undefined) {
      return undefined;
    }
    const key = `${moduleId}\0${exportName}`;
    if (visited.has(key)) {
      return { moduleId, exportName };
    }
    visited.add(key);

    for (const dependency of module.dependencies) {
      if (dependency.kind === "esm-reexport-named" && dependency.exportedName === exportName) {
        return this.#resolveExportOrigin(dependency.target, dependency.sourceName, visited);
      }
    }
    // A star re-export never forwards `default`.
    if (exportName !== "default") {
      for (const dependency of module.dependencies) {
        if (dependency.kind === "esm-reexport-star") {
          const resolved = this.#resolveExportOrigin(dependency.target, exportName, visited);
          if (resolved !== undefined) {
            return resolved;
          }
        }
      }
    }
    return { moduleId, exportName };
  }

  /// The supply-aware resolution of a demanded `(moduleId, exportName)`: which genuine definer(s)
  /// provide it and whether that is unique (`supplied`), conflicting (`ambiguous`), or absent
  /// (`unsupplied`). Unlike `resolveExportOrigin`, this never fabricates a self-origin for a name a
  /// star-only barrel cannot supply, and it collects EVERY definer so duplicate named exports and
  /// two-star conflicts surface as `ambiguous`. Generated barrels forward one unique definer per name,
  /// so on the generated corpus this is always `supplied`; the other verdicts only arise for
  /// hand-crafted models the validator then rejects.
  resolveExportRoute(moduleId: string, exportName: string): ExportSupply {
    const definers = new Map<string, { origin: ExportOrigin; hops: readonly RouteHop[] }>();
    this.#collectDefiners(moduleId, exportName, [], new Set<string>(), definers);
    const entries = [...definers.values()];
    if (entries.length === 0) {
      return { status: "unsupplied", at: { moduleId, exportName } };
    }
    const [only] = entries;
    if (entries.length === 1 && only !== undefined) {
      return { status: "supplied", origin: only.origin, hops: only.hops };
    }
    return { status: "ambiguous", origins: entries.map((entry) => entry.origin) };
  }

  /// Collect every genuine definer of `(moduleId, exportName)`, following named then star re-exports.
  /// A module is a local definer of the name unless it SUPPRESSES local synthesis, which an ESM module
  /// does exactly when it carries a star re-export (mirroring `localExportsFor`). `visited` is
  /// per-path (removed on exit) so a diamond of barrels still discovers a second, distinct definer for
  /// ambiguity; `out` dedupes by resolved origin so two routes to the SAME definer stay one `supplied`.
  #collectDefiners(
    moduleId: string,
    exportName: string,
    hops: readonly RouteHop[],
    visited: Set<string>,
    out: Map<string, { origin: ExportOrigin; hops: readonly RouteHop[] }>,
  ): void {
    const module = this.#modulesById.get(moduleId);
    if (module === undefined) {
      return;
    }
    const key = `${moduleId}\0${exportName}`;
    if (visited.has(key)) {
      return;
    }
    visited.add(key);

    let matchedNamed = false;
    for (const dependency of module.dependencies) {
      if (dependency.kind === "esm-reexport-named" && dependency.exportedName === exportName) {
        matchedNamed = true;
        this.#collectDefiners(
          dependency.target,
          dependency.sourceName,
          [...hops, { via: "named", through: moduleId }],
          visited,
          out,
        );
      }
    }
    if (!matchedNamed) {
      // A star re-export never forwards `default`.
      if (exportName !== "default") {
        for (const dependency of module.dependencies) {
          if (dependency.kind === "esm-reexport-star") {
            this.#collectDefiners(
              dependency.target,
              exportName,
              [...hops, { via: "star", through: moduleId }],
              visited,
              out,
            );
          }
        }
      }
      const hasStar = module.dependencies.some(
        (dependency) => dependency.kind === "esm-reexport-star",
      );
      // A CJS module synthesizes every demanded export; an ESM module synthesizes one unless a star
      // re-export suppresses all local synthesis. Either way, the local definer supplies the name here.
      if (!(module.format === "esm" && hasStar)) {
        const originKey = `${moduleId}\0${exportName}`;
        if (!out.has(originKey)) {
          out.set(originKey, { origin: { moduleId, exportName }, hops });
        }
      }
    }
    visited.delete(key);
  }

  /// Strongly connected components via ITERATIVE Tarjan (O(V+E)). Iterative on purpose: a 10,000-deep
  /// synchronous chain would overflow a recursive DFS. A component is CYCLIC when it has >= 2 members
  /// or a single member with a self-edge; `edgeClosesCycle` and `cycles()` read from this.
  #sccs(): SccComponents {
    if (this.#sccComponents === undefined) {
      const components: string[][] = [];
      const indexOf = new Map<string, number>();
      const cyclic = new Set<number>();
      const indices = new Map<string, number>();
      const lowlink = new Map<string, number>();
      const onStack = new Set<string>();
      const stack: string[] = [];
      let counter = 0;

      const push = (node: string): { node: string; targets: string[]; next: number } => {
        indices.set(node, counter);
        lowlink.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);
        return { node, targets: syncTargetsOf(this.#modulesById.get(node)), next: 0 };
      };

      for (const start of this.#modulesById.keys()) {
        if (indices.has(start)) {
          continue;
        }
        const work = [push(start)];
        while (work.length > 0) {
          const frame = work[work.length - 1];
          if (frame === undefined) {
            break;
          }
          let recursed = false;
          while (frame.next < frame.targets.length) {
            const target = frame.targets[frame.next];
            frame.next += 1;
            if (target === undefined || !this.#modulesById.has(target)) {
              continue;
            }
            if (!indices.has(target)) {
              work.push(push(target));
              recursed = true;
              break;
            }
            if (onStack.has(target)) {
              lowlink.set(
                frame.node,
                Math.min(lowlink.get(frame.node) ?? 0, indices.get(target) ?? 0),
              );
            }
          }
          if (recursed) {
            continue;
          }
          if (lowlink.get(frame.node) === indices.get(frame.node)) {
            const componentIndex = components.length;
            const component: string[] = [];
            let member: string | undefined;
            do {
              member = stack.pop();
              if (member === undefined) {
                break;
              }
              onStack.delete(member);
              indexOf.set(member, componentIndex);
              component.push(member);
            } while (member !== frame.node);
            components.push(component);
            if (
              component.length >= 2 ||
              syncTargetsOf(this.#modulesById.get(frame.node)).includes(frame.node)
            ) {
              cyclic.add(componentIndex);
            }
          }
          work.pop();
          const parent = work[work.length - 1];
          if (parent !== undefined) {
            lowlink.set(
              parent.node,
              Math.min(lowlink.get(parent.node) ?? 0, lowlink.get(frame.node) ?? 0),
            );
          }
        }
      }

      this.#sccComponents = { components, indexOf, cyclic };
    }
    return this.#sccComponents;
  }

  #analyzeCycles(): CycleFacts {
    const components = this.#sccs();
    const sccs = [...components.cyclic]
      .map((index) => components.components[index])
      .filter((component): component is string[] => component !== undefined);
    const cyclicMembers = new Set<string>(sccs.flat());

    const formats = new Set<ModuleFormat>();
    const sccFormats = sccs.map((scc) => {
      const perScc = new Set<ModuleFormat>();
      for (const id of scc) {
        const format = this.#modulesById.get(id)?.format;
        if (format !== undefined) {
          perScc.add(format);
          formats.add(format);
        }
      }
      return perScc;
    });

    let hasChord = false;
    let hasInterlocking = false;
    let hasMultiEnter = false;
    for (const scc of sccs) {
      const members = new Set(scc);
      let internalEdges = 0;
      const internalOut = new Map<string, Set<string>>(scc.map((id) => [id, new Set<string>()]));
      const internalIn = new Map<string, Set<string>>(scc.map((id) => [id, new Set<string>()]));
      for (const id of scc) {
        for (const target of this.syncTargets(id)) {
          if (members.has(target)) {
            internalEdges += 1;
            internalOut.get(id)?.add(target);
            internalIn.get(target)?.add(id);
          }
        }
      }
      const interlocking = scc.some(
        (id) => (internalOut.get(id)?.size ?? 0) >= 2 && (internalIn.get(id)?.size ?? 0) >= 2,
      );
      if (interlocking) {
        hasInterlocking = true;
      } else if (internalEdges > scc.length) {
        hasChord = true;
      }
      const enteringMembers = new Set<string>();
      for (const [id, module] of this.#modulesById) {
        if (members.has(id)) {
          continue;
        }
        for (const target of syncTargetsOf(module)) {
          if (members.has(target)) {
            enteringMembers.add(target);
          }
        }
      }
      if (enteringMembers.size >= 2) {
        hasMultiEnter = true;
      }
    }

    return { cyclicMembers, sccs, formats, sccFormats, hasChord, hasInterlocking, hasMultiEnter };
  }
}
