/// <reference types="node" />

/// Transplant unit 3 — the ANONYMIZER + EMITTER. Maps a reduced real-app graph to a fuzzer-schema
/// `ProgramModel` at the CURRENT schema: real ids -> `m<index>` (no names, no paths, no code bodies),
/// edges -> the right dependency kind by importer format, dynamic edges -> registrations + triggers
/// for statically-reachable owners, one distinct evaluate event per event-budgeted module. Package
/// boundaries + `sideEffects` metadata are preserved through the W14b `PackageModel`, and the
/// bundle-side `BuildConfig` axes are set to match the app's real build where representable
/// (`outputFormat`, an organic-group chunking approximation of the real chunk composition, seo).
///
/// The default emission is PURE-ORDER: every static edge renders as a side-effect import (ESM) / plain
/// require (CJS), so the skeleton captures execution order with no value-flow or cycle-TDZ concern and
/// is robustly green on a correct bundler. The witness overlay (unit 4) plants the observable bugs on
/// top. A `faithfulReexports` mode (used for the #10044 link-failure transplant) instead renders the
/// real star / named / namespace re-export edges, so a link-time re-export bug survives transplant.

import type {
  BuildConfig,
  EntryModel,
  EsmDependencyOperation,
  ModuleModel,
  PackageModel,
  ProgramModel,
  ScheduleOperation,
} from "../../src/model.ts";
import { DEFAULT_TREESHAKE_CONFIG } from "../../src/model.ts";
import type { ReducedGraph, ReducedModule } from "./reduce.ts";

export interface EmitConfig {
  /// Preserve package boundaries + `sideEffects` metadata as W14b packages (default true).
  readonly includePackages: boolean;
  /// Persisted `BuildConfig` axes. `chunking` approximates the real chunk composition as organic
  /// groups; `outputFormat` / `strictExecutionOrder` match the app's build (default esm / true).
  readonly outputFormat: "esm" | "cjs";
  readonly strictExecutionOrder: boolean;
  /// W12 minify axis. Defaults FALSE — the transplant keeps its output readable (and avoids a mangling
  /// pass it does not need), matching the extract-wrapper convention; a caller may flip it to reproduce a
  /// minify-only real-app bug.
  readonly minify: boolean;
  /// Emit a `build.chunking` organic approximation of the real chunks (default true). Off -> automatic.
  readonly organicChunking: boolean;
  /// Render real re-export edges (star / named / namespace) instead of side-effect imports. Used by the
  /// #10044 transplant to carry a link-time re-export bug (default false). CAVEAT (review finding): the
  /// reducer's mixed-format-cycle break runs over the plain `edges` set only — re-export edges emitted
  /// here are NOT fed into that break, so a CJS re-export target closing a cycle would survive to
  /// validation (which rejects it loudly via `validateSynchronousCycleFormats`, never silently). Fine for
  /// the all-ESM #10044 graph; wire re-export edges into the break before enabling this on a
  /// mixed-format app.
  readonly faithfulReexports: boolean;
}

export const DEFAULT_EMIT_CONFIG: EmitConfig = {
  includePackages: true,
  outputFormat: "esm",
  strictExecutionOrder: true,
  organicChunking: true,
  faithfulReexports: false,
  minify: false,
};

/// A metadata-pure package member must be ESM, emit NO events, and carry only value-only ESM deps
/// (`validate-model.ts`). Under pure-order emission that means: ESM, event-free, and no kept edges we
/// would render as a side-effect import OR a dynamic import (a leaf-package representative, whose
/// same-package siblings were collapsed away, has neither). Such a member can faithfully carry its real
/// `sideEffects:false`.
function isPureEligible(module: ReducedModule): boolean {
  return (
    module.format === "esm" &&
    !module.eventEmitting &&
    module.edges.length === 0 &&
    module.dynamicEdges.length === 0
  );
}

export function emitModel(
  reduced: ReducedGraph,
  config: EmitConfig = DEFAULT_EMIT_CONFIG,
): ProgramModel {
  const keptIds = reduced.modules.map((module) => module.id).sort();
  const indexOf = new Map(keptIds.map((id, index) => [id, index]));
  const mid = (id: string): string => `m${indexOf.get(id)}`;
  const byId = new Map(reduced.modules.map((module) => [module.id, module]));

  // Which packages can faithfully carry sideEffects:false — every kept member pure-eligible.
  const membersByPackage = new Map<string, ReducedModule[]>();
  for (const module of reduced.modules) {
    if (!module.pkg) continue;
    const list = membersByPackage.get(module.pkg.name) ?? [];
    list.push(module);
    membersByPackage.set(module.pkg.name, list);
  }
  const purePackages = new Set<string>();
  if (config.includePackages) {
    for (const [name, members] of membersByPackage) {
      const first = members[0]!;
      if (first.pkgSideEffects === false && members.every(isPureEligible)) {
        purePackages.add(name);
      }
    }
  }
  const forcedEventFree = new Set<string>();
  if (config.includePackages) {
    for (const name of purePackages) {
      for (const member of membersByPackage.get(name) ?? []) forcedEventFree.add(member.id);
    }
  }

  // ---- static reachability from entries over static edges (for dynamic-trigger scheduling) ----
  const staticReach = new Set<string>();
  {
    const queue = [...reduced.entries];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (staticReach.has(id) || !byId.has(id)) continue;
      staticReach.add(id);
      for (const edge of byId.get(id)!.edges) queue.push(edge.target);
    }
  }

  // ---- emit modules ----
  let registrationCounter = 0;
  const registrations: { readonly registration: string; readonly ownerId: string }[] = [];
  const modules: ModuleModel[] = keptIds.map((id) => {
    const module = byId.get(id)!;
    const eventFree = forcedEventFree.has(id) || !module.eventEmitting;
    const value = (indexOf.get(id) ?? 0) + 1;
    const events = eventFree ? [] : [{ module: mid(id), phase: "evaluate", value }];

    if (module.format === "cjs") {
      const dependencies: (
        | { readonly kind: "cjs-require"; readonly target: string }
        | {
            readonly kind: "esm-dynamic-import";
            readonly target: string;
            readonly registration: string;
          }
      )[] = [];
      const seen = new Set<string>();
      for (const edge of module.edges) {
        if (seen.has(edge.target)) continue;
        seen.add(edge.target);
        dependencies.push({ kind: "cjs-require", target: mid(edge.target) });
      }
      for (const target of module.dynamicEdges) {
        const registration = `r${registrationCounter++}`;
        registrations.push({ registration, ownerId: id });
        dependencies.push({ kind: "esm-dynamic-import", target: mid(target), registration });
      }
      return { id: mid(id), format: "cjs", dependencies, events };
    }

    const dependencies: EsmDependencyOperation[] = config.faithfulReexports
      ? faithfulEsmDependencies(module, mid)
      : pureOrderEsmDependencies(module, mid);
    for (const target of module.dynamicEdges) {
      const registration = `r${registrationCounter++}`;
      registrations.push({ registration, ownerId: id });
      dependencies.push({ kind: "esm-dynamic-import", target: mid(target), registration });
    }
    return { id: mid(id), format: "esm", dependencies, events };
  });

  // ---- entries + schedule ----
  const entryIds = reduced.entries.length > 0 ? reduced.entries : keptIds.slice(0, 1);
  const modelEntries: EntryModel[] = entryIds.map((id, index) => ({
    name: `e${index}`,
    moduleId: mid(id),
  }));
  const modulesById = new Map(modules.map((module) => [module.id, module]));
  const schedule: ScheduleOperation[] = [];
  for (const entry of modelEntries) {
    const format = modulesById.get(entry.moduleId)?.format ?? "esm";
    schedule.push(
      format === "cjs"
        ? { kind: "require-entry", entry: entry.name }
        : { kind: "import-entry", entry: entry.name },
    );
  }
  for (const { registration, ownerId } of registrations) {
    if (staticReach.has(ownerId)) schedule.push({ kind: "trigger-dynamic-import", registration });
  }

  // ---- packages (W14b) ----
  const packages: PackageModel[] = [];
  if (config.includePackages) {
    for (const [name, members] of membersByPackage) {
      // A package is `sideEffects:false` only when the metadata-purity contract holds for every member
      // (`purePackages`); otherwise the boundary survives with `sideEffects:true` (effectful, no purity
      // claim) — a real `sideEffects:false` we cannot honor (a member emits events / has non-value deps)
      // degrades to `true` rather than an unsound contract.
      const sideEffects = !purePackages.has(name);
      packages.push({
        name: anonymizePackageName(name, indexOf, members),
        sideEffects,
        moduleIds: members.map((member) => mid(member.id)),
      });
    }
  }

  // ---- build config ----
  const build: BuildConfig = {
    chunking: config.organicChunking
      ? organicChunkingApproximation(reduced, mid)
      : { kind: "automatic" },
    includeDependenciesRecursively: true,
    preserveEntrySignatures: "allow-extension",
    lazyBarrel: false,
    strictExecutionOrder: config.strictExecutionOrder,
    outputFormat: config.outputFormat,
    minify: config.minify,
    profilerNames: false,
    treeshake: DEFAULT_TREESHAKE_CONFIG,
  };

  const program: ProgramModel = {
    modules,
    entries: modelEntries,
    schedule,
    ...(packages.length > 0 ? { packages } : {}),
    build,
  };
  return program;
}

function pureOrderEsmDependencies(
  module: ReducedModule,
  mid: (id: string) => string,
): EsmDependencyOperation[] {
  const dependencies: EsmDependencyOperation[] = [];
  const seen = new Set<string>();
  for (const edge of module.edges) {
    if (seen.has(edge.target)) continue; // at most one side-effect edge per pair
    seen.add(edge.target);
    dependencies.push({ kind: "esm-side-effect-import", target: mid(edge.target) });
  }
  return dependencies;
}

/// Render the real re-export SHAPE of an ESM module: `export *` -> `esm-reexport-star`, `export {x}
/// from` -> `esm-reexport-named`, `export * as ns` -> `esm-reexport-namespace`; every other static edge
/// stays a side-effect import. This is what carries a link-time re-export resolution bug (#10044)
/// through transplant. Names are anonymized per target so a star chain never yields an ambiguous
/// duplicate export.
function faithfulEsmDependencies(
  module: ReducedModule,
  mid: (id: string) => string,
): EsmDependencyOperation[] {
  const dependencies: EsmDependencyOperation[] = [];
  const reexportTargets = new Set<string>();
  for (const target of module.starReexportTargets) {
    dependencies.push({ kind: "esm-reexport-star", target: mid(target) });
    reexportTargets.add(target);
  }
  for (const reexport of module.nsReexports) {
    dependencies.push({
      kind: "esm-reexport-namespace",
      target: mid(reexport.target),
      exportedName: `ns_${mid(reexport.target)}`,
    });
    reexportTargets.add(reexport.target);
  }
  for (const reexport of module.namedReexports) {
    for (const exported of Object.values(reexport.names)) {
      dependencies.push({
        kind: "esm-reexport-named",
        target: mid(reexport.target),
        sourceName: `x_${exported}`,
        exportedName: `x_${exported}`,
      });
    }
    reexportTargets.add(reexport.target);
  }
  const seen = new Set<string>();
  for (const edge of module.edges) {
    if (reexportTargets.has(edge.target) || seen.has(edge.target)) continue;
    seen.add(edge.target);
    dependencies.push({ kind: "esm-side-effect-import", target: mid(edge.target) });
  }
  return dependencies;
}

/// Anonymize a package name to a stable `pkg<n>` derived from its first member's index, so no real
/// package name leaks while the boundary/layout is preserved.
function anonymizePackageName(
  name: string,
  indexOf: ReadonlyMap<string, number>,
  members: readonly ReducedModule[],
): string {
  void name;
  const first = members[0];
  return `pkg${first ? (indexOf.get(first.id) ?? 0) : 0}`;
}

/// Approximate the real chunk composition as organic groups: one `minShareCount`-style group per real
/// chunk that carries >=2 kept modules, so the transplant builds under a chunking config shaped like the
/// app's, without pinning exact module lists (bundle-side only; source semantics unchanged).
function organicChunkingApproximation(
  reduced: ReducedGraph,
  mid: (id: string) => string,
): BuildConfig["chunking"] {
  void mid;
  const groups = reduced.chunks
    .filter((chunk) => chunk.moduleIds.length >= 2)
    .slice(0, 12)
    .map((chunk, index) => ({
      name: `g${index}`,
      minShareCount: 2,
      priority: index,
    }));
  return groups.length > 0 ? { kind: "organic", groups } : { kind: "automatic" };
}
