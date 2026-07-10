import type {
  BuildConfig,
  Chunking,
  CjsModuleModel,
  DependencyOperation,
  EntryModel,
  EsmDependencyOperation,
  EsmModuleModel,
  EventRecord,
  ManualChunkGroup,
  ModuleFormat,
  ModuleModel,
  OrganicChunkGroupConfig,
  PackageModel,
  ProgramModel,
  ScheduleOperation,
  ValueRead,
} from "./model.ts";
import { analyzeProgram, type AnalyzedProgram, type ExportDemandPlan } from "./analyzed-program.ts";
import {
  buildConfigOf,
  DEFAULT_BUILD_CONFIG,
  legacySideEffectFreePackage,
  metadataPureModuleIds,
  moduleProfile,
  packageMemberFileName,
  packageMembershipOf,
  packagesOf,
  programChunking,
  readableBindingsOf,
} from "./model.ts";
import { ProgramFacts, type ExportSupply } from "./program-facts.ts";
import { SeededRng } from "./rng.ts";

export const FIXED_TEMPLATE_NAMES = [
  "esm-imports-cjs",
  "shared-cjs-carriers",
  "cjs-requires-esm",
  "overlapping-entries",
  "manual-chunk-separation",
] as const;

export const MIXED_TEMPLATE_NAMES = [...FIXED_TEMPLATE_NAMES, "random-mixed"] as const;

export type MixedTemplateName = (typeof MIXED_TEMPLATE_NAMES)[number];

export const FORMAT_REGIMES = ["mixed", "pure-esm", "pure-cjs"] as const;

export type FormatRegime = (typeof FORMAT_REGIMES)[number];

export interface GeneratedCase {
  readonly seed: number;
  readonly size: number;
  readonly template: MixedTemplateName;
  readonly coverageTags: readonly string[];
  readonly program: ProgramModel;
  /// The ONE AnalyzedProgram for this case (graph facts + the canonical export-demand plan), carried
  /// IN MEMORY only — the persisted artifact still records just `program`. Validation, rendering, tags,
  /// and evaluation all read THIS instance, so a case path runs demand analysis exactly once.
  readonly analyzed: AnalyzedProgram;
}

export const MAX_CASE_SIZE = 48;

/// Upper bound on modules in a random-mixed program (DAG + optional cycle cluster + inserted
/// barrels). Raised from 16 to 48 (wave 6, scale axis) so a single case can host the dozens of
/// modules a real chunk carries, stressing intra-chunk statement placement. The DAG scales with the
/// requested size (capped at `MAX_RANDOM_MODULES - 2`); the cycle cluster (base ring + optional
/// interlocking sub-cycle) is sized within `MAX_RANDOM_MODULES - dagCount - 2`, reserving two slots
/// for barrel modules.
const MAX_RANDOM_MODULES = 48;

/// Sample a per-case generation size from a weighted small/medium/large spread. A campaign that does
/// not pin `--case-size` draws one of these per case (seeded by the case seed) so a single run covers
/// every scale — small graphs for density and large ones for intra-chunk placement. Deterministic:
/// the same seed always yields the same size. All values stay within `[1, MAX_CASE_SIZE]`.
export function sampleCaseSize(rng: SeededRng): number {
  const roll = rng.integer(100);
  if (roll < 45) {
    return 6 + rng.integer(7); // small: 6..12
  }
  if (roll < 80) {
    return 16 + rng.integer(9); // medium: 16..24
  }
  return 32 + rng.integer(17); // large: 32..48
}

export function generateCase(
  seed: number,
  size: number,
  forcedRegime?: FormatRegime,
): GeneratedCase {
  const rng = new SeededRng(seed);
  if (!Number.isInteger(size) || size < 1 || size > MAX_CASE_SIZE) {
    throw new Error(`size must be an integer from 1 through ${MAX_CASE_SIZE}`);
  }

  // Half the campaign explores random graphs; the other half keeps the audited fixed shapes.
  // A forced regime pins every case to the random generator: the fixed templates carry their
  // own inherent formats and would dilute a pure-format campaign.
  const template =
    forcedRegime !== undefined
      ? "random-mixed"
      : rng.boolean()
        ? "random-mixed"
        : rng.pick(FIXED_TEMPLATE_NAMES);
  const built =
    template === "random-mixed"
      ? buildRandomMixed(rng, size, forcedRegime)
      : TEMPLATE_BUILDERS[template](rng, size);
  // The ONE AnalyzedProgram for the case: finalizeProgram already produced it (and deep-froze its program)
  // for random-mixed; a fixed template's program is a plain literal, so it is routed through the SAME
  // configuration/freeze seam (`configureFixedTemplate`) that persists its resolved `BuildConfig` and
  // deep-freezes it before being analyzed ONCE — so `program.build` is genuinely persisted on EVERY
  // generated case, not left to the `buildConfigOf` fallback. Every GeneratedCase then carries a frozen
  // program + analysis, so an accidental post-generation mutation throws whatever the template, and
  // everything downstream reads THIS instance, so demand analysis runs exactly once per case.
  const analyzed = built.analyzed ?? analyzeProgram(configureFixedTemplate(built.program));
  const coverageTags = deriveCoverageTags(analyzed);
  // `template:*` tags stay purely structural; only fixed templates promise their own shape.
  if (template !== "random-mixed" && !coverageTags.includes(`template:${template}`)) {
    throw new Error(`Generated ${template} program does not match its template`);
  }

  return {
    seed,
    size,
    template,
    coverageTags,
    program: analyzed.program,
    analyzed,
  };
}

/// The common configuration/freeze seam for a FIXED-template program (a plain object literal the template
/// builders assemble). It PERSISTS the resolved `BuildConfig` onto `program.build` — resolved defaults
/// only, via `buildConfigOf`, so it is corpus-neutral apart from making the persisted object genuinely
/// present — and DROPS any legacy top-level chunk arrays so `build.chunking` is the single chunking
/// source, then deep-freezes. The random-mixed path already persists `build` inside `finalizeProgram`, so
/// it never reaches here (its `TemplateResult` carries `analyzed`); this closes the one gap where a fixed
/// template relied on the `buildConfigOf` fallback instead of a persisted object.
function configureFixedTemplate(program: ProgramModel): ProgramModel {
  const configured: ProgramModel = {
    modules: program.modules,
    entries: program.entries,
    schedule: program.schedule,
    build: buildConfigOf(program),
  };
  return deepFreeze(configured);
}

interface TemplateResult {
  readonly program: ProgramModel;
  /// Present when the builder already finalized AND analyzed the program (random-mixed, via
  /// `finalizeProgram`). A fixed template omits it — its program is assembled directly — and
  /// `generateCase` analyzes it once. Either way exactly one `AnalyzedProgram` is built per case.
  readonly analyzed?: AnalyzedProgram;
}

type TemplateBuilder = (rng: SeededRng, size: number) => TemplateResult;

const TEMPLATE_BUILDERS: Readonly<Record<MixedTemplateName, TemplateBuilder>> = {
  "esm-imports-cjs": buildEsmImportsCjs,
  "shared-cjs-carriers": buildSharedCjsCarriers,
  "cjs-requires-esm": buildCjsRequiresEsm,
  "overlapping-entries": buildOverlappingEntries,
  "manual-chunk-separation": buildManualChunkSeparation,
  "random-mixed": buildRandomMixed,
};

function buildEsmImportsCjs(rng: SeededRng, size: number): TemplateResult {
  const chainLength = 1 + Math.min(size - 1, 3);
  const cjsModules = Array.from({ length: chainLength }, (_, index): CjsModuleModel => {
    const id = `cjs-leaf-${index}`;
    return {
      id,
      format: "cjs",
      dependencies:
        index + 1 < chainLength ? [{ kind: "cjs-require", target: `cjs-leaf-${index + 1}` }] : [],
      events: events(id, rng, 1 + Math.min(size - 1, 2)),
    };
  });
  const useValueImport = rng.boolean();
  const dependency: EsmDependencyOperation = useValueImport
    ? {
        kind: "esm-value-import",
        target: "cjs-leaf-0",
        importedName: "value",
        localName: "cjsValue",
      }
    : { kind: "esm-side-effect-import", target: "cjs-leaf-0" };
  const entry = esmModule("esm-entry", [dependency], events("esm-entry", rng, 1));

  return {
    program: {
      modules: [entry, ...cjsModules],
      entries: [{ name: "main", moduleId: entry.id }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    },
  };
}

function buildSharedCjsCarriers(rng: SeededRng, size: number): TemplateResult {
  const carrierCount = 2 + Math.min(Math.floor((size - 1) / 2), 3);
  const shared = cjsModule("shared-cjs", [], events("shared-cjs", rng, 1));
  const carriers = Array.from({ length: carrierCount }, (_, index) => {
    const id = `carrier-${index}`;
    const dependency: EsmDependencyOperation = rng.boolean()
      ? {
          kind: "esm-value-import",
          target: shared.id,
          importedName: `value${index}`,
          localName: `sharedValue${index}`,
        }
      : { kind: "esm-side-effect-import", target: shared.id };
    return esmModule(id, [dependency], events(id, rng, 1));
  });
  const entry = esmModule(
    "esm-entry",
    carriers.map((carrier) => ({ kind: "esm-side-effect-import", target: carrier.id })),
    events("esm-entry", rng, 1),
  );

  return {
    program: {
      modules: [entry, ...carriers, shared],
      entries: [{ name: "main", moduleId: entry.id }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    },
  };
}

function buildCjsRequiresEsm(rng: SeededRng, size: number): TemplateResult {
  const esmCount = 1 + Math.min(size - 1, 4);
  const esmModules = Array.from({ length: esmCount }, (_, index): EsmModuleModel => {
    const id = `esm-sync-${index}`;
    return esmModule(
      id,
      index + 1 < esmCount
        ? [{ kind: "esm-side-effect-import", target: `esm-sync-${index + 1}` }]
        : [],
      events(id, rng, 1),
    );
  });
  const entry = cjsModule(
    "cjs-entry",
    [{ kind: "cjs-require", target: esmModules[0]?.id ?? "esm-sync-0" }],
    events("cjs-entry", rng, 1 + Math.min(size - 1, 2)),
  );

  return {
    program: {
      modules: [entry, ...esmModules],
      entries: [{ name: "main", moduleId: entry.id }],
      schedule: [{ kind: "require-entry", entry: "main" }],
    },
  };
}

function buildOverlappingEntries(rng: SeededRng, size: number): TemplateResult {
  const shared = cjsModule("shared-cjs", [], events("shared-cjs", rng, 1 + Math.min(size - 1, 2)));
  const branchCount = 1 + Math.min(Math.floor((size - 1) / 3), 2);
  const branchModules = Array.from({ length: branchCount * 2 }, (_, index): CjsModuleModel => {
    const entryIndex = index % 2;
    const branchIndex = Math.floor(index / 2);
    const id = `entry-${entryIndex}-leaf-${branchIndex}`;
    return cjsModule(id, [], events(id, rng, 1));
  });
  const entries = [0, 1].map((index) => {
    const id = `esm-entry-${index}`;
    return esmModule(
      id,
      [
        { kind: "esm-side-effect-import", target: shared.id },
        ...branchModules
          .filter((module) => module.id.startsWith(`entry-${index}-`))
          .map((module) => ({ kind: "esm-side-effect-import" as const, target: module.id })),
      ],
      events(id, rng, 1),
    );
  });
  const scheduleOrder = rng.boolean() ? [0, 1] : [1, 0];

  return {
    program: {
      modules: [...entries, shared, ...branchModules],
      entries: entries.map((entry, index) => ({ name: `entry-${index}`, moduleId: entry.id })),
      schedule: scheduleOrder.map((index) => ({
        kind: "import-entry" as const,
        entry: `entry-${index}`,
      })),
    },
  };
}

function buildManualChunkSeparation(rng: SeededRng, size: number): TemplateResult {
  const interopCount = 1 + Math.min(size - 1, 3);
  const interopModules = Array.from({ length: interopCount }, (_, index): CjsModuleModel => {
    const id = `interop-${index}`;
    return cjsModule(
      id,
      index + 1 < interopCount ? [{ kind: "cjs-require", target: `interop-${index + 1}` }] : [],
      events(id, rng, 1),
    );
  });
  const carriers = [0, 1].map((index) => {
    const id = `carrier-${index}`;
    return esmModule(
      id,
      [{ kind: "esm-side-effect-import", target: interopModules[0]?.id ?? "interop-0" }],
      events(id, rng, 1),
    );
  });
  const entry = esmModule(
    "esm-entry",
    carriers.map((carrier) => ({ kind: "esm-side-effect-import", target: carrier.id })),
    events("esm-entry", rng, 1),
  );

  return {
    program: {
      modules: [entry, ...carriers, ...interopModules],
      entries: [{ name: "main", moduleId: entry.id }],
      schedule: [{ kind: "import-entry", entry: "main" }],
      // The manual split expressed on the persisted `BuildConfig` (not a legacy top-level
      // `manualChunkGroups` array, which the configuration seam would otherwise have to migrate).
      // `includeDependenciesRecursively: false` preserves this template's historical effective build: it
      // predates the persisted axis, when the build child hardcoded per-group `false` on every manual
      // group (W14a.1 made that value the persisted single source).
      build: {
        ...DEFAULT_BUILD_CONFIG,
        chunking: {
          kind: "manual",
          groups: [
            { name: "carriers", moduleIds: carriers.map((carrier) => carrier.id) },
            { name: "interop", moduleIds: interopModules.map((module) => module.id) },
          ],
        },
        includeDependenciesRecursively: false,
      },
    },
  };
}

interface RandomModuleDraft {
  readonly id: string;
  readonly format: ModuleFormat;
  readonly dependencies: DependencyOperation[];
  /// A family-A inferred-pure definer draft: converted to a `ModuleModel` with `inferredPure: true`,
  /// no events, and the `pureBase` below. See `injectPureDefinerConjunctions`.
  inferredPure?: boolean;
  pureBase?: number;
  /// A family-A conjunction consumer that must become an entry (a barrel importer, so the barrel is
  /// shared by >= 2 entry chunks — the "barrel not flattened" ingredient).
  forceEntry?: boolean;
  /// A callable-reads-own-state definer draft (Task 2): converted to a `ModuleModel` with
  /// `callableOwnState: true`. Combined with `inferredPure` it stays a no-events pure definer; alone
  /// it becomes an event-carrying module. See `injectCallableOwnStateClusters`.
  callableOwnState?: boolean;
  /// An object-export definer draft (Task 3): converted to a no-events `objectExport` module (a fresh
  /// object literal per demanded export — the invisible double-init target).
  objectExport?: boolean;
  /// An object-identity consumer draft (Task 3): converted to a module with one `identityCheck` event
  /// comparing two `objectRef` captures of the same object export reached through different paths.
  identityCheck?: { readonly leftBinding: string; readonly rightBinding: string };
}

/// Random mixed graphs: a forward-edge DAG over ESM/CJS modules, an optional self-contained
/// single-format cycle ring, optional manual chunk groups, and a schedule that interleaves
/// entry evaluation with dynamic-import triggers. Mixed-format cycles are never generated:
/// depending on the runtime entry point they can hit Node's require-of-evaluating-ESM error,
/// and value imports never close a cycle, so TDZ (documented as not preserved) stays out.
///
/// Each case rolls a format regime — mixed, pure-esm, or pure-cjs — so the pure ends of the
/// matrix are exercised deliberately instead of only by per-module coincidence. CJS modules
/// may register dynamic imports (legal in Node CJS) alongside their requires.
function buildRandomMixed(
  rng: SeededRng,
  size: number,
  forcedRegime?: FormatRegime,
): TemplateResult {
  const regimeRoll = rng.integer(5);
  const regime: FormatRegime =
    forcedRegime ?? (regimeRoll === 0 ? "pure-esm" : regimeRoll === 1 ? "pure-cjs" : "mixed");
  const rollModuleFormat = (): ModuleFormat => {
    if (regime === "pure-esm") {
      return "esm";
    }
    if (regime === "pure-cjs") {
      return "cjs";
    }
    // Two thirds ESM keeps interop pairs frequent without starving pure-ESM shapes.
    return rng.integer(3) < 2 ? "esm" : "cjs";
  };
  // The DAG scales with the requested size (up to `MAX_RANDOM_MODULES - 2`, reserving room for the
  // cycle cluster and barrels), so a large case really does host dozens of modules. Small sizes keep
  // the historical `3 + rng.integer(size + 1)` shape since the raised cap never binds there.
  const dagCount = Math.min(3 + rng.integer(size + 1), MAX_RANDOM_MODULES - 2);
  const ringCount = rng.integer(4) === 0 ? 2 + rng.integer(2) : 0;
  const drafts: RandomModuleDraft[] = Array.from({ length: dagCount }, (_, index) => ({
    id: `m${index}`,
    format: rollModuleFormat(),
    dependencies: [],
  }));

  const dependencyKey = (importer: RandomModuleDraft, targetId: string) =>
    `${importer.id}->${targetId}`;
  const usedEdges = new Set<string>();
  const registrations: { owner: string; registration: string }[] = [];
  // The DAG's forward-only edge builder. Rings never route through here (they wire their own
  // in-cycle side-effect/require/call edges), so every edge this adds targets a forward module and a
  // value edge stays forward-only, TDZ-free.
  const addDependency = (importer: RandomModuleDraft, target: RandomModuleDraft) => {
    const edgeKey = dependencyKey(importer, target.id);
    if (usedEdges.has(edgeKey)) {
      return;
    }
    usedEdges.add(edgeKey);
    if (importer.format === "cjs") {
      // Dynamic-edge density raised modestly (wave 6): CJS ~1/3 (was 1/4), so route-level dynamic
      // chunks are dense, matching real apps with dozens of dynamically-imported modules.
      if (rng.integer(3) === 0) {
        const registration = `dyn-${importer.id}-${target.id}`;
        importer.dependencies.push({
          kind: "esm-dynamic-import",
          target: target.id,
          registration,
        });
        registrations.push({ owner: importer.id, registration });
      } else if (rng.boolean()) {
        // Readable require: bind the result and read a state-derived export off the target.
        importer.dependencies.push({
          kind: "cjs-require",
          target: target.id,
          resultBinding: `r_${importer.id}_${target.id}`,
          readName: `v${target.id}`,
        });
      } else {
        importer.dependencies.push({ kind: "cjs-require", target: target.id });
      }
      return;
    }
    // Dynamic-edge density raised modestly (wave 6): ESM ~1/4 (was 1/6). `roll >= 6` (of 8) is a
    // dynamic import; side-effect and value each take three of the remaining bands.
    const roll = rng.integer(8);
    if (roll < 3) {
      importer.dependencies.push({ kind: "esm-side-effect-import", target: target.id });
    } else if (roll < 6) {
      // A value edge. When the target is ESM, a minority become namespace imports: `import * as ns`
      // + a folded `ns.v<target>` member read, exercising the namespace-shape interop surface. CJS
      // targets stay value imports — Node's `import * of CJS` namespace shape legitimately differs
      // from rolldown's interop (a `module.exports` key), so CJS-target namespaces are model-only.
      if (target.format === "esm" && rng.integer(3) === 0) {
        importer.dependencies.push({
          kind: "esm-namespace-import",
          target: target.id,
          localName: `ns_${importer.id}_${target.id}`,
          readMembers: [`v${target.id}`],
        });
      } else {
        importer.dependencies.push({
          kind: "esm-value-import",
          target: target.id,
          importedName: `v${target.id}`,
          localName: `${importer.id}_v${target.id}`,
        });
      }
    } else {
      const registration = `dyn-${importer.id}-${target.id}`;
      importer.dependencies.push({ kind: "esm-dynamic-import", target: target.id, registration });
      registrations.push({ owner: importer.id, registration });
    }
  };

  // Every non-root module gets one incoming forward edge, then extra edges add sharing.
  for (let index = 1; index < dagCount; index += 1) {
    const importer = drafts[rng.integer(index)];
    const target = drafts[index];
    if (importer !== undefined && target !== undefined) {
      addDependency(importer, target);
    }
  }
  for (let extra = rng.integer(dagCount + 1); extra > 0; extra -= 1) {
    const importerIndex = rng.integer(dagCount - 1);
    const targetIndex = importerIndex + 1 + rng.integer(dagCount - importerIndex - 1);
    const importer = drafts[importerIndex];
    const target = drafts[targetIndex];
    if (importer !== undefined && target !== undefined) {
      addDependency(importer, target);
    }
  }

  // Nested dynamic chains (wave 6): bias some dynamic edges to ORIGINATE from a module that is
  // itself a dynamic-import target — a dynamic import inside a dynamically-imported module, the
  // dozens-of-nested-route-chunks shape real apps have and which happened only by rare accident
  // before. Such an inner import only evaluates once the outer dynamic import fires. Forward-only
  // (target index strictly greater), reusing `usedEdges` so no duplicate/cyclic edge is created.
  if (rng.integer(3) !== 0) {
    const dynamicTargets = new Set(
      drafts.flatMap((draft) =>
        draft.dependencies.flatMap((dependency) =>
          dependency.kind === "esm-dynamic-import" ? [dependency.target] : [],
        ),
      ),
    );
    for (let importerIndex = 0; importerIndex < dagCount; importerIndex += 1) {
      const importer = drafts[importerIndex];
      if (importer === undefined || !dynamicTargets.has(importer.id) || rng.integer(3) === 0) {
        continue;
      }
      const forwardCandidates: RandomModuleDraft[] = [];
      for (let targetIndex = importerIndex + 1; targetIndex < dagCount; targetIndex += 1) {
        const candidate = drafts[targetIndex];
        if (candidate !== undefined && !usedEdges.has(dependencyKey(importer, candidate.id))) {
          forwardCandidates.push(candidate);
        }
      }
      if (forwardCandidates.length === 0) {
        continue;
      }
      const target = forwardCandidates[rng.integer(forwardCandidates.length)];
      if (target === undefined) {
        continue;
      }
      usedEdges.add(dependencyKey(importer, target.id));
      const registration = `dynnest-${importer.id}-${target.id}`;
      importer.dependencies.push({ kind: "esm-dynamic-import", target: target.id, registration });
      registrations.push({ owner: importer.id, registration });
    }
  }

  // A single-format cycle cluster, richer than a bare ring: optional in-cycle value flow (ESM
  // hoisted-function calls, CJS guarded partial reads), an optional chord, an optional interlocking
  // second cycle sharing a hub, several external edges entering at different members, and post-cycle
  // readers of cycle exports. Every value read across a cycle edge is a `call` (ESM) or `guard` (CJS)
  // so it stays Node-legal, TDZ-free, and NaN-free (see `.agents/docs/node-legal-cycles.md`). The
  // whole cluster is one format, so Node's require-of-evaluating-ESM error stays out.
  let cycleMemberIds: ReadonlySet<string> = new Set();
  const cycleBudget = Math.max(0, MAX_RANDOM_MODULES - dagCount - 2);
  if (ringCount > 0 && cycleBudget >= 2) {
    const ringFormat: ModuleFormat =
      regime === "mixed" ? (rng.boolean() ? "esm" : "cjs") : rollModuleFormat();
    const cycleMembers: RandomModuleDraft[] = [];
    const makeMember = (): RandomModuleDraft => {
      const member: RandomModuleDraft = {
        id: `ring${cycleMembers.length}`,
        format: ringFormat,
        dependencies: [],
      };
      cycleMembers.push(member);
      return member;
    };
    // A single cycle edge from -> toId. When it may carry a read, ESM uses a hoisted-function CALL
    // import and CJS uses a GUARDED readable require — the only Node-legal, total forms across a
    // cycle edge. Otherwise a plain side-effect import / require.
    const wireCycleEdge = (from: RandomModuleDraft, toId: string, allowRead: boolean): void => {
      if (usedEdges.has(dependencyKey(from, toId))) {
        return;
      }
      usedEdges.add(dependencyKey(from, toId));
      if (ringFormat === "cjs") {
        from.dependencies.push(
          allowRead && rng.boolean()
            ? {
                kind: "cjs-require",
                target: toId,
                resultBinding: `rc_${from.id}_${toId}`,
                readName: `v${toId}`,
                guard: true,
              }
            : { kind: "cjs-require", target: toId },
        );
      } else {
        from.dependencies.push(
          allowRead && rng.boolean()
            ? {
                kind: "esm-value-import",
                target: toId,
                importedName: `f${toId}`,
                localName: `cc_${from.id}_${toId}`,
                call: true,
              }
            : { kind: "esm-side-effect-import", target: toId },
        );
      }
    };

    const baseSize = Math.min(ringCount, cycleBudget);
    const base = Array.from({ length: baseSize }, () => makeMember());
    for (const [index, member] of base.entries()) {
      const next = base[(index + 1) % baseSize];
      if (next !== undefined) {
        wireCycleEdge(member, next.id, true);
      }
    }

    // A chord: one extra non-adjacent intra-ring edge (needs at least three members).
    if (baseSize >= 3 && rng.boolean()) {
      const fromIndex = rng.integer(baseSize);
      const from = base[fromIndex];
      const to = base[(fromIndex + 2) % baseSize];
      if (from !== undefined && to !== undefined) {
        wireCycleEdge(from, to.id, rng.boolean());
      }
    }

    // An interlocking second cycle sharing the hub (base[0]), a figure-eight: hub -> s0 -> … -> hub.
    const remaining = cycleBudget - cycleMembers.length;
    const hub = base[0];
    if (remaining >= 1 && hub !== undefined && rng.integer(3) === 0) {
      const subLength = Math.min(1 + rng.integer(2), remaining);
      let previous = hub;
      for (let step = 0; step < subLength; step += 1) {
        const member = makeMember();
        wireCycleEdge(previous, member.id, true);
        previous = member;
      }
      wireCycleEdge(previous, hub.id, true);
    }

    drafts.push(...cycleMembers);
    cycleMemberIds = new Set(cycleMembers.map((member) => member.id));

    // Several external synchronous edges enter the cycle at DISTINCT members (from DAG carriers).
    const enteringMembers = pickDistinct(
      rng,
      cycleMembers,
      1 + rng.integer(Math.min(3, cycleMembers.length)),
    );
    for (const member of enteringMembers) {
      const carrier = drafts[rng.integer(dagCount)];
      if (carrier !== undefined && !usedEdges.has(dependencyKey(carrier, member.id))) {
        usedEdges.add(dependencyKey(carrier, member.id));
        carrier.dependencies.push(
          carrier.format === "cjs"
            ? { kind: "cjs-require", target: member.id }
            : { kind: "esm-side-effect-import", target: member.id },
        );
      }
    }

    // Post-cycle readers: DAG modules that read a cycle member's value export (a forward edge, the
    // member fully evaluated), so the value that flowed through the cycle is observed downstream.
    if (rng.boolean()) {
      for (let reader = 0; reader < 1 + rng.integer(2); reader += 1) {
        const dagReader = drafts[rng.integer(dagCount)];
        const member = cycleMembers[rng.integer(cycleMembers.length)];
        if (
          dagReader !== undefined &&
          member !== undefined &&
          !usedEdges.has(dependencyKey(dagReader, member.id))
        ) {
          usedEdges.add(dependencyKey(dagReader, member.id));
          dagReader.dependencies.push(
            dagReader.format === "cjs"
              ? {
                  kind: "cjs-require",
                  target: member.id,
                  resultBinding: `rp_${dagReader.id}_${member.id}`,
                  readName: `v${member.id}`,
                }
              : {
                  kind: "esm-value-import",
                  target: member.id,
                  importedName: `v${member.id}`,
                  localName: `pc_${dagReader.id}_${member.id}`,
                },
          );
        }
      }
    }
  }

  // Insert barrel (re-export) chains between some ESM readers and their ESM definers. The read now
  // flows through pure re-exporter modules (forward edges only), the classic barrel shape.
  drafts.push(...insertBarrelChains(rng, drafts, usedEdges));

  // Turn a meaningful minority of forward pairs into real multi-kind pairs — `import { a } from "./x"`
  // AND `import("./x")` (static + lazy), a side-effect plus a value import of one module, and the
  // like — after barrels so an augmented value edge is never rerouted through one.
  augmentMultiEdgePairs(rng, drafts, registrations);

  // Inject complete family-A conjunctions (inferred-pure definer star-re-exported through a shared
  // barrel, split reads) — biased HARD so a double-digit fraction of random-mixed cases carry the
  // real-app shape a green 25,000-case corpus missed. Self-contained clusters, appended last. The
  // injector reports its member roles so the W14b end-stage packaging variant can wrap exactly this
  // cluster without re-deriving them from flags.
  const conjunction = injectPureDefinerConjunctions(rng, drafts, regime);
  drafts.push(...conjunction.drafts);
  const conjunctionConsumerIds = new Set(
    conjunction.drafts.filter((draft) => draft.forceEntry === true).map((draft) => draft.id),
  );

  // Witness-enrichment clusters (wave 8), appended after the conjunctions so the conjunction density is
  // unchanged: a callable-reads-own-state cluster (the d3-scale/shadcn read-side ingredient for family
  // B) and an object-identity cluster (a silent double-init witness numbers cannot see). Their entry
  // consumers are NOT skipped in applyStaticallyInvisibleReads — the callable calls are meant to be
  // hidden, and the identity events carry no folded reads to hide.
  drafts.push(...injectCallableOwnStateClusters(rng, drafts, regime));
  drafts.push(...injectObjectIdentityClusters(rng, drafts, regime));

  // finalizeProgram is the SINGLE finalization point: it freezes the generation state into a
  // ProgramModel and returns its one AnalyzedProgram, carried out of here so nothing downstream re-derives.
  const analyzed = finalizeProgram(
    {
      drafts,
      cycleMemberIds,
      registrations,
      conjunctionConsumerIds,
      regime,
      ...(conjunction.cluster === undefined ? {} : { conjunctionCluster: conjunction.cluster }),
    },
    rng,
  );
  return { program: analyzed.program, analyzed };
}

/// The member roles of an injected family-A conjunction cluster, reported by the injector itself
/// (its recipe knows which draft is which), for the W14b packaging variant.
interface ConjunctionClusterInfo {
  readonly definerId: string;
  readonly siblingId: string;
  /// Every barrel in the chain; `outerBarrelId` is the one the consumers namespace-import (the
  /// package MAIN when the cluster is packaged).
  readonly barrelIds: readonly string[];
  readonly outerBarrelId: string;
  readonly consumerIds: readonly string[];
}

/// The barrel/CJS cross-chunk `init_*` cycle shape (rolldown #9887, ingredient D4) — the W14a live catch.
///
/// A MODULE-ACYCLIC graph whose manual chunk split MANUFACTURES a chunk cycle: an `export *` hub barrel
/// with a CJS interop sibling that `require()`s two ESM leaves, split so the hub chunk eagerly calls the
/// dep chunk's `init_dep` before the dep chunk (which imports a binding back out of the hub chunk) has
/// assigned it. Under `includeDependenciesRecursively: false` + strict order this throws
/// `init_dep is not a function` at module-eval on npm rolldown (RED), while the fixed PR-snapshot greens
/// it at strict order (a bidirectional proof pair). The module graph stays ACYCLIC (dep imports its value
/// from `shared`, NOT from the hub — the acyclic variant of the issue's own repro), so the validator
/// agrees there is no mixed-format module cycle: only the CHUNK graph is cyclic, manufactured by the
/// split (rolldown's own #9225-class in-contract shape).
///
/// - `shared` (ESM leaf): a value definer of `extend`.
/// - `dep` (ESM): imports `extend` from `shared` (forward, acyclic) and exports `useDep` folding it.
/// - `interop` (CJS): side-effect `require()`s of `shared` AND `dep` — the eager CJS init of ESM.
/// - `hub` (ESM barrel): side-effect-imports `interop`, then `export *` re-exports `shared` and `dep`.
/// - `consumer` (ESM entry): imports `useDep` + `extend` through the hub barrel and folds them into an
///   event — the witness. The bundle throws before the event fires (bundle-only-crash); the source emits it.
///
/// The manual chunk split places `dep` alone and `{hub, interop, shared}` together, so `hub-chunk` needs
/// `dep-chunk` (interop requires dep) while `dep-chunk` needs `hub-chunk` (dep imports shared's `extend`)
/// — the chunk cycle. `includeDependenciesRecursively: false` keeps `dep` in its own chunk rather than
/// pulling it recursively into the hub chunk (which would dissolve the cycle and green it).
export function buildCrossChunkInitCycle(rng: SeededRng): {
  readonly program: ProgramModel;
  readonly analyzed: AnalyzedProgram;
} {
  const consumerBase = 1 + rng.integer(900_000);
  const modules: readonly ModuleModel[] = [
    {
      id: "cc-consumer",
      format: "esm",
      dependencies: [
        { kind: "esm-value-import", target: "cc-hub", importedName: "useDep", localName: "u" },
        { kind: "esm-value-import", target: "cc-hub", importedName: "extend", localName: "x" },
      ],
      events: [
        {
          module: "cc-consumer",
          phase: "evaluate",
          value: consumerBase,
          reads: [{ binding: "u" }, { binding: "x" }],
        },
      ],
    },
    {
      id: "cc-hub",
      format: "esm",
      dependencies: [
        { kind: "esm-side-effect-import", target: "cc-interop" },
        // NAMED re-export of shared's `extend` and STAR re-export of dep's `useDep`. Disjoint (one named,
        // one star) so the fuzzer's demand-driven definers stay unambiguous — two STAR re-exports over two
        // demand-synthesizing definers would make every name resolve to both (rejected as ambiguous). The
        // star to dep is load-bearing: it keeps dep un-flattened as a real re-exported chunk.
        {
          kind: "esm-reexport-named",
          target: "cc-shared",
          sourceName: "extend",
          exportedName: "extend",
        },
        { kind: "esm-reexport-star", target: "cc-dep" },
      ],
      events: [],
    },
    {
      id: "cc-interop",
      format: "cjs",
      dependencies: [
        { kind: "cjs-require", target: "cc-shared" },
        { kind: "cjs-require", target: "cc-dep" },
      ],
      events: [],
    },
    {
      id: "cc-dep",
      format: "esm",
      dependencies: [
        { kind: "esm-value-import", target: "cc-shared", importedName: "extend", localName: "e" },
      ],
      events: [],
    },
    { id: "cc-shared", format: "esm", dependencies: [], events: [] },
  ];
  const program: ProgramModel = {
    modules,
    entries: [
      { name: "entry-cc-consumer", moduleId: "cc-consumer" },
      { name: "entry-cc-hub", moduleId: "cc-hub" },
    ],
    schedule: [
      { kind: "import-entry", entry: "entry-cc-consumer" },
      { kind: "import-entry", entry: "entry-cc-hub" },
    ],
    build: {
      // The manual split that manufactures the chunk cycle: dep alone vs {hub, interop, shared}.
      chunking: {
        kind: "manual",
        groups: [
          { name: "cc-dep-chunk", moduleIds: ["cc-dep"] },
          { name: "cc-hub-chunk", moduleIds: ["cc-hub", "cc-interop", "cc-shared"] },
        ],
      },
      // The load-bearing axis: false keeps dep in its own chunk so the cross-chunk init cycle forms.
      includeDependenciesRecursively: false,
      preserveEntrySignatures: "allow-extension",
      lazyBarrel: false,
      strictExecutionOrder: true,
    },
  };
  deepFreeze(program);
  return { program, analyzed: analyzeProgram(program) };
}

/// A generated case for the #9887 cross-chunk init-cycle shape (used by the directed W14-10 campaign).
/// The seed only varies the cosmetic fold value, so the structural shape — and its red/green verdict pair
/// — is identical across seeds. Tagged `mechanism:barrel-cross-chunk-init-cycle`.
export function generateCrossChunkInitCycleCase(seed: number): GeneratedCase {
  const { program, analyzed } = buildCrossChunkInitCycle(new SeededRng(seed));
  const coverageTags = [...deriveCoverageTags(analyzed)];
  return {
    seed,
    size: program.modules.length,
    template: "random-mixed",
    coverageTags,
    program,
    analyzed,
  };
}

/// The family-B eager-barrel shape (the vben `initPreferences is not a function` breakage) as a
/// DIRECTED fixed program — the fuzzer-model translation of the real fix's regression fixture
/// (`entry_fn_captures_wrapped_value`), assembled through the same configuration/freeze/analyze seam
/// as every fixed builder (a persisted BuildConfig, deep-frozen, analyzed once):
///
/// - package `fbpkg` with `sideEffects: ["./fb-sib.mjs"]` — the barrel and facade are metadata-pure,
///   the sibling (manager) is the one listed side-effectful member;
/// - `fb-bar` (package main): `export * from fb-def` + a DECLARED call-marked helper (the included
///   own statement — vben's `tag`);
/// - `fb-def` (facade): `const v = 0 + makePref()` — assigned at init from the sibling's function,
///   non-inlinable;
/// - `fb-sib` (manager): side-effectful, exports the hoisted function the facade calls;
/// - `fb-first`: a side-effectful ROOT module the entry imports FIRST (the predicted-order deviation
///   seed: source order runs it before the manager, chunk order runs the manager's chunk first);
/// - `fb-ent` (entry): `import "./fb-first"; import { vFacade, helper } from "fbpkg"` — calls the
///   helper at top level and reads the facade value INSIDE a hiddenReadFn-invoked function;
/// - a manual chunk group splitting {facade, sibling} from the entry chunk, with the fixture's
///   `includeDependenciesRecursively: false` (probed NOT load-bearing — idr:true stays red — but
///   kept fixture-faithful) and `lazyBarrel: false` (the lazyBarrel:true variant is probed red too;
///   the campaign script reports both).
///
/// Against the frozen PR-10104 snapshot this is od-RED (the entry's hidden read folds `undefined`
/// into NaN — `bundle-only-crash`) and wa-GREEN on the SAME seed — the family-B fingerprint the
/// directed campaign (`scripts/family-b-catch.ts`) accepts on, with the wrap-all cell as the internal
/// control (no second build needed).
export function buildFamilyBEagerBarrel(
  rng: SeededRng,
  options: { readonly lazyBarrel?: boolean } = {},
): {
  readonly program: ProgramModel;
  readonly analyzed: AnalyzedProgram;
} {
  const firstBase = 1 + rng.integer(900_000);
  const siblingBase = 1 + rng.integer(900_000);
  const entryBase = 1 + rng.integer(900_000);
  const hiddenBase = 1 + rng.integer(900_000);
  const modules: readonly ModuleModel[] = [
    {
      id: "fb-ent",
      format: "esm",
      dependencies: [
        { kind: "esm-side-effect-import", target: "fb-first" },
        { kind: "esm-value-import", target: "fb-bar", importedName: "vFacade", localName: "vf" },
        {
          kind: "esm-value-import",
          target: "fb-bar",
          importedName: "helper",
          localName: "vb",
          call: true,
        },
      ],
      events: [
        {
          module: "fb-ent",
          phase: "evaluate",
          value: entryBase,
          reads: [{ binding: "vb", call: true }],
        },
        {
          module: "fb-ent",
          phase: "evaluate-1",
          value: hiddenBase,
          reads: [{ binding: "vf" }],
          hiddenReadFn: true,
        },
      ],
    },
    {
      id: "fb-first",
      format: "esm",
      dependencies: [],
      events: [{ module: "fb-first", phase: "evaluate", value: firstBase }],
    },
    {
      id: "fb-bar",
      format: "esm",
      localExports: ["helper"],
      dependencies: [{ kind: "esm-reexport-star", target: "fb-def" }],
      events: [],
    },
    {
      id: "fb-def",
      format: "esm",
      dependencies: [
        {
          kind: "esm-value-import",
          target: "fb-sib",
          importedName: "makePref",
          localName: "mk",
          call: true,
        },
      ],
      events: [],
    },
    {
      id: "fb-sib",
      format: "esm",
      dependencies: [],
      events: [{ module: "fb-sib", phase: "evaluate", value: siblingBase }],
    },
  ];
  const program: ProgramModel = {
    modules,
    entries: [{ name: "entry-fb-ent", moduleId: "fb-ent" }],
    schedule: [{ kind: "import-entry", entry: "entry-fb-ent" }],
    packages: [
      { name: "fbpkg", sideEffects: ["./fb-sib.mjs"], moduleIds: ["fb-bar", "fb-def", "fb-sib"] },
    ],
    build: {
      chunking: {
        kind: "manual",
        groups: [{ name: "fb-pref", moduleIds: ["fb-def", "fb-sib"] }],
      },
      includeDependenciesRecursively: false,
      preserveEntrySignatures: "allow-extension",
      lazyBarrel: options.lazyBarrel ?? false,
      strictExecutionOrder: true,
    },
  };
  deepFreeze(program);
  return { program, analyzed: analyzeProgram(program) };
}

/// A generated case for the directed family-B campaign. The seed only varies the cosmetic fold
/// values, so the structural shape — and its od-red/wa-green verdict split — is identical across
/// seeds. Tagged `mechanism:family-b-eager-barrel` (asserted by the campaign script).
export function generateFamilyBEagerBarrelCase(
  seed: number,
  options: { readonly lazyBarrel?: boolean } = {},
): GeneratedCase {
  const { program, analyzed } = buildFamilyBEagerBarrel(new SeededRng(seed), options);
  const coverageTags = [...deriveCoverageTags(analyzed)];
  return {
    seed,
    size: program.modules.length,
    template: "random-mixed",
    coverageTags,
    program,
    analyzed,
  };
}

/// The ordered generation state at the moment every edge, cluster, and dynamic-import registration
/// has been wired — the mutable graph the random generator built, ready to be FROZEN. `finalizeProgram`
/// is the single point that consumes it.
interface GenerationContext {
  /// The module drafts in creation order (DAG, then cycle cluster, then barrels, then witness clusters).
  readonly drafts: readonly RandomModuleDraft[];
  /// The ids of the single-format cycle cluster's members (empty when the case has no cycle).
  readonly cycleMemberIds: ReadonlySet<string>;
  /// Dynamic-import registrations in CREATION order — the transient ordinals the schedule RNG iterates.
  /// Kept as a creation-ordered side list (not re-derived by a module scan) precisely so that order,
  /// and thus the seeded schedule, stays byte-identical; membership/owner/target already match the final
  /// graph because each entry was recorded as its dynamic edge was added.
  readonly registrations: readonly { readonly owner: string; readonly registration: string }[];
  /// The family-A conjunction consumers, left untouched by the statically-invisible-read rewrite.
  readonly conjunctionConsumerIds: ReadonlySet<string>;
  /// The case's format regime — the W14b end-stage enrichment is ESM-only, so pure-cjs skips it.
  readonly regime: FormatRegime;
  /// The injected family-A conjunction cluster's member roles, when the case rolled one — the W14b
  /// packaging variant wraps exactly this cluster.
  readonly conjunctionCluster?: ConjunctionClusterInfo;
}

/// Freeze a generation context into a finalized, ANALYZED program: turn each draft into a module
/// (asserting special-role drafts, folding value reads), choose entries, build the schedule from the
/// creation-ordered registrations, roll the chunking config, flag side-effect-free modules, and rewrite
/// some reads statically-invisible — then build the ProgramFacts + one canonical ExportDemandPlan over
/// the frozen graph. This is the single finalization point; it consumes the SAME generation RNG in the
/// SAME order the inline tail did, so the corpus is byte-identical, and analysis is pure (no RNG).
function finalizeProgram(context: GenerationContext, rng: SeededRng): AnalyzedProgram {
  const { drafts, cycleMemberIds, registrations, conjunctionConsumerIds, regime } = context;
  // profile-guard:authoring-start — this draft→module map is the ONE place that AUTHORS a module's
  // purity/export-shape flags (a draft is not a ModuleModel, so it reads the draft's authoring intent
  // directly; `moduleProfile` interprets those flags everywhere else). The module-profile guard test
  // allows raw flag reads only between these markers.
  const modules = drafts.map((draft): ModuleModel => {
    // Finalization ASSERTS a draft's dependencies are already legal for its format rather than silently
    // filtering illegal kinds away — a bad future transform then fails loudly at generation instead of
    // being sanitized before the validator can catch it. The reads are chosen from the same
    // forward-only bindings the renderer will fold.
    // An inferred-pure definer emits NO events (an event would make its top level impure) and carries
    // its build-function base; a barrel (a pure re-exporter) emits no events — it only forwards.
    if (draft.inferredPure === true) {
      // Assert the draft is ESM rather than FORCING `format: "esm"` — inferred purity is an ESM-only
      // construct, so a non-ESM draft carrying the flag is a bug that must fail loudly, not be sanitized.
      assertEsmSpecialDraft(draft, "inferred-pure");
      return {
        id: draft.id,
        format: "esm",
        dependencies: esmDraftDependencies(draft),
        events: [],
        inferredPure: true,
        pureBase: draft.pureBase ?? 1 + rng.integer(900_000),
        // A callable-own-state definer may ALSO be inferred-pure: its exports then read a module-scope
        // state var (still only pure statements), so the bundler still infers it side-effect-free.
        ...(draft.callableOwnState === true ? { callableOwnState: true as const } : {}),
      };
    }
    // An object-export definer (Task 3): a no-events ESM leaf exporting fresh object literals — the
    // invisible double-init target of the object-identity witness.
    if (draft.objectExport === true) {
      assertEsmSpecialDraft(draft, "object-export");
      // ASSERT the definer is a leaf rather than silently dropping its dependencies (`dependencies: []`):
      // an object-export module is validated leaf, so a draft that accumulated dependencies is a bug that
      // must surface, not be quietly discarded (which would change the graph the later passes reasoned on).
      if (draft.dependencies.length > 0) {
        throw new Error(
          `object-export draft ${draft.id} must be a leaf, received ${draft.dependencies.length} dependencies`,
        );
      }
      return { id: draft.id, format: "esm", dependencies: [], events: [], objectExport: true };
    }
    // An object-identity consumer (Task 3): its objectRef imports capture the same object export
    // through two paths; a single event compares them for identity. objectRef bindings are never
    // folded numerically, so this event carries no `reads`.
    if (draft.identityCheck !== undefined) {
      assertEsmSpecialDraft(draft, "object-identity consumer");
      return {
        id: draft.id,
        format: "esm",
        dependencies: esmDraftDependencies(draft),
        events: [
          {
            module: draft.id,
            phase: "evaluate",
            value: rng.integer(1_000_000),
            identityCheck: draft.identityCheck,
          },
        ],
      };
    }
    // A plain (not inferred-pure) callable-own-state draft is ESM-only — validation rejects a CJS
    // callable-own-state module (only an ESM function export is callable while its module init is
    // skipped). ASSERT it here, BEFORE the format branch, rather than letting a CJS draft fall through
    // to `cjsModule` and SILENTLY lose the flag: a future transform that mis-formats such a draft then
    // fails loudly at generation instead of producing a model whose dropped flag the validator can no
    // longer catch. (The inferred-pure + callable-own-state combination is asserted in its own branch above.)
    if (draft.callableOwnState === true) {
      assertEsmSpecialDraft(draft, "callable-own-state");
    }
    const isBarrel = draft.dependencies.some(isReexportDependency);
    const moduleEvents = isBarrel
      ? []
      : withValueReads(events(draft.id, rng, 1 + rng.integer(2)), draft.dependencies, rng);
    if (draft.format === "esm") {
      const esm = esmModule(draft.id, esmDraftDependencies(draft), moduleEvents);
      // An event-carrying callable-own-state definer (Task 2): a real side-effecting module whose
      // exports read a module-scope state var assigned during init (its base is its first event value).
      return draft.callableOwnState === true ? { ...esm, callableOwnState: true } : esm;
    }
    return cjsModule(draft.id, cjsDraftDependencies(draft), moduleEvents);
  });
  // profile-guard:authoring-end

  // Module 0 anchors the schedule; extra entries may be modules other modules also import,
  // which exercises entry facades and shared entry chunks.
  const entryIndices = new Set([0]);
  for (let extra = rng.integer(3); extra > 0; extra -= 1) {
    entryIndices.add(rng.integer(drafts.length));
  }
  // Sometimes make several cycle members entries, so the schedule enters the cycle at different
  // members (each import/require-entry a distinct entry point into the same single-format cluster).
  if (cycleMemberIds.size >= 2 && rng.boolean()) {
    const cycleIndices = drafts.flatMap((draft, index) =>
      cycleMemberIds.has(draft.id) ? [index] : [],
    );
    for (let extra = 1 + rng.integer(2); extra > 0 && cycleIndices.length > 0; extra -= 1) {
      const pick = cycleIndices[rng.integer(cycleIndices.length)];
      if (pick !== undefined) {
        entryIndices.add(pick);
      }
    }
  }
  // A family-A conjunction's consumers MUST be entries — the barrel is then shared by >= 2 entry
  // chunks, the "barrel not flattened" ingredient, and the split reads land in distinct entry chunks.
  for (const [index, draft] of drafts.entries()) {
    if (draft.forceEntry === true) {
      entryIndices.add(index);
    }
  }
  const entries = [...entryIndices]
    .map((index) => drafts[index])
    .filter((draft) => draft !== undefined)
    .map((draft) => ({ name: `entry-${draft.id}`, moduleId: draft.id }));

  // Derive the dynamic-import registration sequence from the FINALIZED graph, ordered by each edge's
  // creation ordinal, reconciling it against the creation-ordered side list so the two can never drift.
  const orderedRegistrations = deriveRegistrationSequence(modules, registrations);
  const schedule = buildRandomSchedule(rng, modules, entries, orderedRegistrations);

  const chunking = buildChunkingConfig(rng, drafts, cycleMemberIds, entries.length);

  // Mark a minority of eligible modules with `sideEffects: false` package metadata. Marked modules
  // emit no events (their events are stripped), so the bundler's legal DCE cannot silently drop an
  // observed side effect; only their folded value survives downstream. The rolls come last so the
  // rest of a given seed's structure is unchanged. W14b MIGRATION: the metadata is persisted as
  // single-member PACKAGES (the same `sef-<id>` shape the legacy seam derives for an old flagged
  // artifact), never as the module-level flag — the draws are byte-identical to the flag era, only
  // the representation moved.
  const flagged = chooseSideEffectFreeModules(rng, modules, entries);
  const flaggedModules =
    flagged.size === 0
      ? modules
      : modules.map(
          (module): ModuleModel => (flagged.has(module.id) ? { ...module, events: [] } : module),
        );
  const flaggedPackages = [...flagged].map((id) => legacySideEffectFreePackage(id));

  // Statically-invisible reads (family B): rewrite some folded reads to happen INSIDE a local
  // function called at init, and some namespace member reads to a computed `ns[k]` access, biased
  // toward ENTRIES reading cross-chunk targets. Applied LAST so the rest of a seed's structure
  // (deps, entries, schedule, chunking, flagging) is byte-identical; only the events change. The
  // family-A conjunction consumers are left untouched so that proven shape is unchanged.
  const finalModules = applyStaticallyInvisibleReads(
    rng,
    flaggedModules,
    new Set(entries.map((entry) => entry.moduleId)),
    conjunctionConsumerIds,
  );

  // Roll the persisted BuildConfig axes AFTER every W14a-era source-affecting roll (deps, entries,
  // schedule, chunking, side-effect flagging, statically-invisible reads): these axes are bundle-side
  // only and never change the source run, and appending their rolls here shifts no earlier draw.
  // `includeDependenciesRecursively` (the global codeSplitting fallback) and `lazyBarrel` (the
  // barrel-pruning optimization) are the two W14a axes; `preserveEntrySignatures` and
  // `strictExecutionOrder` are fixed (the latter not rolled — a seo:false cell needs a weaker order
  // oracle, deferred past W14b).
  const includeDependenciesRecursively = rng.boolean();
  const lazyBarrel = rng.boolean();

  // The W14b END-STAGE enrichment — packages, the family-B eager-barrel conjunction, the
  // retained-reference witness, and the camunda local-re-export composition. Every enrichment roll
  // draws AFTER the last pre-W14b draw (the lazyBarrel axis above), so a case where no enrichment
  // fires is byte-identical to the W14a corpus; a case where one fires changes exactly because it
  // gained packages or a new operation (the labeled golden delta).
  const enriched = applyW14bEnrichment(rng, {
    regime,
    modules: finalModules,
    entries,
    schedule,
    chunking,
    packages: flaggedPackages,
    ...(context.conjunctionCluster === undefined
      ? {}
      : { conjunctionCluster: context.conjunctionCluster }),
  });

  const build: BuildConfig = {
    chunking: chunkingUnionOf(enriched.chunking),
    includeDependenciesRecursively,
    preserveEntrySignatures: "allow-extension",
    lazyBarrel,
    strictExecutionOrder: true,
  };

  const program: ProgramModel = {
    modules: enriched.modules,
    entries: enriched.entries,
    schedule: enriched.schedule,
    ...(enriched.packages.length > 0 ? { packages: enriched.packages } : {}),
    build,
  };
  // Deep-freeze the finalized program so accidental post-finalization mutation throws in tests — nothing
  // downstream (render, validate, tags, the artifact writer) mutates it; they only READ. analyzeProgram
  // then freezes the plan and the analyzed view over this frozen graph.
  deepFreeze(program);
  return analyzeProgram(program);
}

/// Recursively freeze a finalized program's plain objects and arrays. Cheap over the bounded model
/// (dozens of modules, a handful of dependencies/events each) and one-shot per case, so an accidental
/// mutation of the frozen generation state surfaces immediately instead of silently corrupting a later
/// pass. Only walks arrays and plain objects; it never recurses into the analysis (that is frozen
/// separately) because the program has no back-reference to it.
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const element of value) {
      deepFreeze(element);
    }
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(value);
  }
  return value;
}

/// The rolled (pre-union) chunking shape `buildChunkingConfig` produces and the W14b enrichment may
/// extend: at most one of the two group arrays is non-empty.
interface RolledChunking {
  readonly manualChunkGroups?: readonly ManualChunkGroup[];
  readonly organicChunkGroups?: readonly OrganicChunkGroupConfig[];
}

/// The mutable program surface the W14b end-stage enrichment works over. Every roll it makes draws
/// AFTER the last pre-W14b draw (the lazyBarrel axis), so a case where nothing fires is
/// byte-identical to the W14a corpus.
interface W14bEnrichmentInput {
  readonly regime: FormatRegime;
  readonly modules: readonly ModuleModel[];
  readonly entries: readonly EntryModel[];
  readonly schedule: readonly ScheduleOperation[];
  readonly chunking: RolledChunking;
  readonly packages: readonly PackageModel[];
  readonly conjunctionCluster?: ConjunctionClusterInfo;
}

interface W14bEnrichmentResult {
  readonly modules: readonly ModuleModel[];
  readonly entries: readonly EntryModel[];
  readonly schedule: readonly ScheduleOperation[];
  readonly chunking: RolledChunking;
  readonly packages: readonly PackageModel[];
}

/// The probability gates of the W14b enrichment sub-steps, each rolled once per case in this fixed
/// order. Family-B is biased so the COMPLETE conjunction reaches double-digit density in
/// random-mixed (measured by `scripts/tag-density.ts`); the rest are deliberate minorities.
const FAMILY_B_PROBABILITY_PERCENT = 16;
const RETAINED_REFERENCE_PROBABILITY_PERCENT = 10;
const CONJUNCTION_PACKAGING_PROBABILITY_PERCENT = 25;
const PLAIN_PACKAGING_PROBABILITY_PERCENT = 8;
const CAMUNDA_REWRITE_PROBABILITY_PERCENT = 10;

/// The W14b END-STAGE enrichment: the package/metadata realism cluster. Sub-steps in fixed order —
/// (1) the family-B eager-barrel conjunction (the vben shape), (2) the retained-reference witness,
/// (3) the family-A conjunction packaging variant, (4) plain single-member packaging, (5) the
/// camunda local-re-export rewrite. The two injectors are ESM-only constructs, so a pure-CJS case
/// skips them; 3–5 target structures a pure-CJS case simply lacks.
function applyW14bEnrichment(rng: SeededRng, input: W14bEnrichmentInput): W14bEnrichmentResult {
  const modules: ModuleModel[] = [...input.modules];
  const entries: EntryModel[] = [...input.entries];
  const schedule: ScheduleOperation[] = [...input.schedule];
  const packages: PackageModel[] = [...input.packages];
  let chunking = input.chunking;

  if (input.regime !== "pure-cjs") {
    chunking = injectFamilyBEagerBarrel(rng, modules, entries, schedule, chunking, packages);
    injectRetainedReference(rng, modules, entries, schedule, packages);
  }
  applyConjunctionPackaging(rng, input.conjunctionCluster, packages);
  applyPlainPackaging(rng, modules, entries, packages);
  const rewritten = applyCamundaRewrite(rng, modules, entries, schedule, packages);

  return { modules: rewritten, entries, schedule, chunking, packages };
}

/// Inject the family-B eager-barrel conjunction — the vben `initPreferences is not a function` shape,
/// translated ingredient-for-ingredient from the real fix's regression fixture and probed od-RED /
/// wa-GREEN against the frozen snapshot:
///
/// - a PACKAGE whose `sideEffects` ARRAY lists only the sibling (manager), so the barrel and facade
///   are metadata-pure;
/// - the package MAIN barrel: `export * from facade` (the hop that gets TREE-SHAKEN — a named hop
///   resolves the binding directly and greens) PLUS a DECLARED local export the entry CALLS (the
///   "one own helper keeps the barrel included" ingredient — without an included own statement the
///   delegation never happens and the shape greens);
/// - the facade: metadata-pure, its export assigned at init from a CALL of the sibling's function
///   (non-inlinable, so a dropped init reads `undefined` → NaN → the event channel rejects it);
/// - the sibling: the package's one listed, side-effectful module;
/// - a chunk group splitting {facade, sibling} away from the entry chunk (the predicted-order
///   deviation seed — no group, no bug), merged into whatever chunking mode the case rolled;
/// - a root side-effectful module the entry imports FIRST (source order runs it before the manager;
///   predicted chunk order runs the manager first — the deviation; removing it greens);
/// - the entry: reads the facade's value through the barrel inside a hiddenReadFn-invoked function
///   and calls the barrel's own helper.
///
/// A minority variant also re-exports the sibling's value as BOTH a named and a `default` alias
/// through the same barrel (witness D2), consumed by the entry alongside the core reads.
function injectFamilyBEagerBarrel(
  rng: SeededRng,
  modules: ModuleModel[],
  entries: EntryModel[],
  schedule: ScheduleOperation[],
  chunking: RolledChunking,
  packages: PackageModel[],
): RolledChunking {
  if (rng.integer(100) >= FAMILY_B_PROBABILITY_PERCENT) {
    return chunking;
  }
  if (MAX_RANDOM_MODULES - modules.length < 5) {
    return chunking;
  }
  const counter = modules.length;
  const firstId = `fbfirst${counter}`;
  const barrelId = `fbbar${counter}`;
  const facadeId = `fbdef${counter}`;
  const siblingId = `fbsib${counter}`;
  const entryId = `fbent${counter}`;
  const packageName = `fbpkg${counter}`;
  const facadeName = `v${facadeId}`;
  const helperName = `v${barrelId}`;
  const siblingFnName = `f${siblingId}`;
  const siblingName = `v${siblingId}`;
  const dualDefault = rng.integer(100) < 35;

  modules.push(
    {
      id: firstId,
      format: "esm",
      dependencies: [],
      events: [{ module: firstId, phase: "evaluate", value: rng.integer(1_000_000) }],
    },
    {
      id: barrelId,
      format: "esm",
      localExports: [helperName],
      dependencies: [
        { kind: "esm-reexport-star", target: facadeId },
        ...(dualDefault
          ? ([
              {
                kind: "esm-reexport-named",
                target: siblingId,
                sourceName: siblingName,
                exportedName: siblingName,
              },
              {
                kind: "esm-reexport-named",
                target: siblingId,
                sourceName: siblingName,
                exportedName: "default",
              },
            ] as const)
          : []),
      ],
      events: [],
    },
    {
      id: facadeId,
      format: "esm",
      dependencies: [
        {
          kind: "esm-value-import",
          target: siblingId,
          importedName: siblingFnName,
          localName: `cc_${facadeId}`,
          call: true,
        },
      ],
      events: [],
    },
    {
      id: siblingId,
      format: "esm",
      dependencies: [],
      events: [{ module: siblingId, phase: "evaluate", value: rng.integer(1_000_000) }],
    },
    {
      id: entryId,
      format: "esm",
      dependencies: [
        { kind: "esm-side-effect-import", target: firstId },
        {
          kind: "esm-value-import",
          target: barrelId,
          importedName: facadeName,
          localName: `vf_${entryId}`,
        },
        {
          kind: "esm-value-import",
          target: barrelId,
          importedName: helperName,
          localName: `vb_${entryId}`,
          call: true,
        },
        ...(dualDefault
          ? ([
              {
                kind: "esm-value-import",
                target: barrelId,
                importedName: siblingName,
                localName: `vs_${entryId}`,
              },
              {
                kind: "esm-value-import",
                target: barrelId,
                importedName: "default",
                localName: `vd_${entryId}`,
              },
            ] as const)
          : []),
      ],
      events: [
        {
          module: entryId,
          phase: "evaluate",
          value: rng.integer(1_000_000),
          reads: [
            { binding: `vb_${entryId}`, call: true },
            ...(dualDefault ? [{ binding: `vs_${entryId}` }, { binding: `vd_${entryId}` }] : []),
          ],
        },
        {
          module: entryId,
          phase: "evaluate-1",
          value: rng.integer(1_000_000),
          reads: [{ binding: `vf_${entryId}` }],
          hiddenReadFn: true,
        },
      ],
    },
  );
  entries.push({ name: `entry-${entryId}`, moduleId: entryId });
  schedule.push({ kind: "import-entry", entry: `entry-${entryId}` });
  packages.push({
    name: packageName,
    sideEffects: [`./${siblingId}.mjs`],
    moduleIds: [barrelId, facadeId, siblingId],
  });
  return mergeFamilyBChunkGroup(chunking, counter, packageName, facadeId, siblingId);
}

/// Merge the family-B {facade, sibling} chunk group into whatever chunking mode the case rolled:
/// manual and default modes gain (or start) a manual group with the two exact modules; an organic
/// mode appends an organic group whose regex test selects the two rendered package files (separator-
/// tolerant), with a priority above every generated organic flavor so another group cannot steal the
/// members. The split is load-bearing — without a group the shape greens.
function mergeFamilyBChunkGroup(
  chunking: RolledChunking,
  counter: number,
  packageName: string,
  facadeId: string,
  siblingId: string,
): RolledChunking {
  const groupName = `fb-pref${counter}`;
  if (chunking.organicChunkGroups !== undefined && chunking.organicChunkGroups.length > 0) {
    return {
      organicChunkGroups: [
        ...chunking.organicChunkGroups,
        {
          name: groupName,
          test: `node_modules[\\\\/]${packageName}[\\\\/](${facadeId}|${siblingId})\\.mjs$`,
          priority: 9,
        },
      ],
    };
  }
  return {
    manualChunkGroups: [
      ...(chunking.manualChunkGroups ?? []),
      { name: groupName, moduleIds: [facadeId, siblingId] },
    ],
  };
}

/// Inject the retained-reference witness (the closed #9961/#10123 family): a `sideEffects: false`
/// package member whose top-level reference to a PURE definer is retained by demand elsewhere — a
/// root entry folds the member's export into a KEPT event, so the bundler must keep the member's
/// value code and the definer's init in order; tree-shaking that drops the pure definer while the
/// reference survives is the historical crash. The definer is inferred-pure (a non-inlinable PURE
/// call — an inlinable literal would dissolve the reference), IN the package on one variant
/// (exercising the deliberately-allowed inferred-pure-inside-metadata combination) and a ROOT module
/// on the other (the member then climbs out of node_modules for it). A 50% variant re-exports the
/// member's value as BOTH a named and a `default` alias through the package barrel (witness D2).
function injectRetainedReference(
  rng: SeededRng,
  modules: ModuleModel[],
  entries: EntryModel[],
  schedule: ScheduleOperation[],
  packages: PackageModel[],
): void {
  if (rng.integer(100) >= RETAINED_REFERENCE_PROBABILITY_PERCENT) {
    return;
  }
  if (MAX_RANDOM_MODULES - modules.length < 4) {
    return;
  }
  const counter = modules.length;
  const definerId = `rrdef${counter}`;
  const middleId = `rrmid${counter}`;
  const barrelId = `rrbar${counter}`;
  const entryId = `rrent${counter}`;
  const packageName = `rrpkg${counter}`;
  const definerName = `v${definerId}`;
  const middleName = `v${middleId}`;
  const definerInPackage = rng.boolean();
  const dualDefault = rng.boolean();

  modules.push(
    {
      id: definerId,
      format: "esm",
      dependencies: [],
      events: [],
      inferredPure: true,
      pureBase: 1 + rng.integer(900_000),
    },
    {
      id: middleId,
      format: "esm",
      dependencies: [
        {
          kind: "esm-value-import",
          target: definerId,
          importedName: definerName,
          localName: `rm_${middleId}`,
        },
      ],
      events: [],
    },
    {
      id: barrelId,
      format: "esm",
      dependencies: [
        {
          kind: "esm-reexport-named",
          target: middleId,
          sourceName: middleName,
          exportedName: middleName,
        },
        ...(dualDefault
          ? ([
              {
                kind: "esm-reexport-named",
                target: middleId,
                sourceName: middleName,
                exportedName: "default",
              },
            ] as const)
          : []),
      ],
      events: [],
    },
    {
      id: entryId,
      format: "esm",
      dependencies: [
        {
          kind: "esm-value-import",
          target: barrelId,
          importedName: middleName,
          localName: `re_${entryId}`,
        },
        ...(dualDefault
          ? ([
              {
                kind: "esm-value-import",
                target: barrelId,
                importedName: "default",
                localName: `rd_${entryId}`,
              },
            ] as const)
          : []),
      ],
      events: [
        {
          module: entryId,
          phase: "evaluate",
          value: rng.integer(1_000_000),
          reads: [
            { binding: `re_${entryId}` },
            ...(dualDefault ? [{ binding: `rd_${entryId}` }] : []),
          ],
        },
      ],
    },
  );
  entries.push({ name: `entry-${entryId}`, moduleId: entryId });
  schedule.push({ kind: "import-entry", entry: `entry-${entryId}` });
  packages.push({
    name: packageName,
    sideEffects: false,
    moduleIds: [barrelId, middleId, ...(definerInPackage ? [definerId] : [])],
  });
}

/// Package an injected family-A conjunction cluster (compose family A BEHIND a package boundary):
/// the outer barrel becomes the package MAIN the consumers import bare, and the metadata rolls the
/// vben partial ARRAY (listing only the side-effectful sibling — the definer is then metadata-pure
/// ON TOP of inferred-pure) or a plain `sideEffects: true`.
function applyConjunctionPackaging(
  rng: SeededRng,
  cluster: ConjunctionClusterInfo | undefined,
  packages: PackageModel[],
): void {
  if (cluster === undefined) {
    return;
  }
  if (rng.integer(100) >= CONJUNCTION_PACKAGING_PROBABILITY_PERCENT) {
    return;
  }
  const sideEffects: PackageModel["sideEffects"] =
    rng.integer(100) < 70 ? [`./${cluster.siblingId}.mjs`] : true;
  packages.push({
    name: `fa-${cluster.definerId.toLowerCase()}`,
    sideEffects,
    moduleIds: [
      cluster.outerBarrelId,
      ...cluster.barrelIds.filter((id) => id !== cluster.outerBarrelId),
      cluster.siblingId,
      cluster.definerId,
    ],
  });
}

/// Wrap one or two ordinary modules into single-member `sideEffects: true` packages — no purity
/// claim, purely the node_modules/bare-specifier resolution surface (real graphs import most of
/// their modules from packages). Entries and existing package members are excluded.
function applyPlainPackaging(
  rng: SeededRng,
  modules: readonly ModuleModel[],
  entries: readonly EntryModel[],
  packages: PackageModel[],
): void {
  if (rng.integer(100) >= PLAIN_PACKAGING_PROBABILITY_PERCENT) {
    return;
  }
  const entryIds = new Set(entries.map((entry) => entry.moduleId));
  const packagedIds = new Set(packages.flatMap((pkg) => pkg.moduleIds));
  const usedNames = new Set(packages.map((pkg) => pkg.name));
  const eligible = modules.filter(
    (module) =>
      !entryIds.has(module.id) &&
      !packagedIds.has(module.id) &&
      /^[A-Za-z0-9_-]+$/.test(module.id) &&
      !usedNames.has(`pkg-${module.id.toLowerCase()}`),
  );
  if (eligible.length === 0) {
    return;
  }
  for (const module of pickDistinct(rng, eligible, 1 + rng.integer(2))) {
    packages.push({
      name: `pkg-${module.id.toLowerCase()}`,
      sideEffects: true,
      moduleIds: [module.id],
    });
  }
}

/// Flip ONE named re-export into the camunda LOCAL re-export form (`import { s as l } …;
/// export { l as e };` — supply-identical, but the import is a LIVE record on a different rolldown
/// surface), sometimes adding an OWN event to the flipped module (the package-barrel-with-own-effect
/// composition) when its purity permits one. Composes the M4 operation into whatever named hops the
/// case carries — family-A conjunction barrels, retained-reference package barrels (camunda BEHIND a
/// package), generated barrel chains, or the family-B dual-default hops.
function applyCamundaRewrite(
  rng: SeededRng,
  modules: readonly ModuleModel[],
  entries: readonly EntryModel[],
  schedule: readonly ScheduleOperation[],
  packages: readonly PackageModel[],
): readonly ModuleModel[] {
  if (rng.integer(100) >= CAMUNDA_REWRITE_PROBABILITY_PERCENT) {
    return modules;
  }
  // A named re-export is only LINK-checked, but the local form's import half is a LIVE NUMERIC
  // demand — so a hop is flippable only when its resolved origin renders a value-category form: a
  // numeric-fold definer whose export no direct call edge marked callable (a callable-constant,
  // callable-own-state, or fresh-object origin would make the flipped import an invalid consumption).
  const facts = ProgramFacts.from(modules);
  const modulesById = new Map(modules.map((module) => [module.id, module]));
  const callMarked = new Set<string>();
  for (const module of modules) {
    for (const dependency of module.dependencies) {
      if (dependency.kind === "esm-value-import" && dependency.call === true) {
        callMarked.add(`${dependency.target}\0${dependency.importedName}`);
      }
      if (dependency.kind === "esm-namespace-import") {
        for (const member of dependency.callMembers ?? []) {
          callMarked.add(`${dependency.target}\0${member}`);
        }
      }
    }
  }
  const flippable = (
    dependency: EsmDependencyOperation & { kind: "esm-reexport-named" },
  ): boolean => {
    const supply = facts.resolveExportRoute(dependency.target, dependency.sourceName);
    if (supply.status !== "supplied") {
      return false;
    }
    if (callMarked.has(`${supply.origin.moduleId}\0${supply.origin.exportName}`)) {
      return false;
    }
    const origin = modulesById.get(supply.origin.moduleId);
    return origin === undefined || moduleProfile(origin).exportShape.kind === "numeric-fold";
  };
  const candidates: { readonly moduleIndex: number; readonly depIndex: number }[] = [];
  for (const [moduleIndex, module] of modules.entries()) {
    if (module.format !== "esm") {
      continue;
    }
    const declared = new Set(module.localExports ?? []);
    for (const [depIndex, dependency] of module.dependencies.entries()) {
      if (
        dependency.kind === "esm-reexport-named" &&
        !declared.has(dependency.exportedName) &&
        flippable(dependency)
      ) {
        candidates.push({ moduleIndex, depIndex });
      }
    }
  }
  if (candidates.length === 0) {
    return modules;
  }
  const pick = candidates[rng.integer(candidates.length)];
  if (pick === undefined) {
    return modules;
  }
  const module = modules[pick.moduleIndex];
  if (module === undefined || module.format !== "esm") {
    return modules;
  }
  const flipped = module.dependencies[pick.depIndex];
  if (flipped === undefined || flipped.kind !== "esm-reexport-named") {
    return modules;
  }
  const usedBindings = new Set(
    module.dependencies.flatMap((dependency) => {
      if (
        dependency.kind === "esm-value-import" ||
        dependency.kind === "esm-namespace-import" ||
        dependency.kind === "esm-local-reexport"
      ) {
        return [dependency.localName];
      }
      return [];
    }),
  );
  let localName = `lr_${module.id}`;
  for (let suffix = 0; usedBindings.has(localName); suffix += 1) {
    localName = `lr_${module.id}_${suffix}`;
  }
  const dependencies = module.dependencies.map((dependency, index) =>
    index === pick.depIndex
      ? ({
          kind: "esm-local-reexport",
          target: flipped.target,
          sourceName: flipped.sourceName,
          localName,
          exportedName: flipped.exportedName,
        } as const)
      : dependency,
  );
  // The own-effect roll (the full camunda shape): only when the module carries no events yet and its
  // purity permits one — never on a metadata-pure package member (the value-only contract), an
  // inferred-pure definer (an event is a top-level side effect), or the no-events witness shapes.
  const metadataPure = metadataPureModuleIds({
    modules,
    entries,
    schedule,
    ...(packages.length > 0 ? { packages } : {}),
  });
  const profile = moduleProfile(module);
  const mayCarryEvent =
    module.events.length === 0 &&
    !metadataPure.has(module.id) &&
    profile.purity.kind !== "inferred" &&
    profile.exportShape.kind === "numeric-fold";
  const addEvent = rng.boolean();
  const events =
    mayCarryEvent && addEvent
      ? [{ module: module.id, phase: "evaluate", value: rng.integer(1_000_000) }]
      : module.events;
  return modules.map((candidate, index) =>
    index === pick.moduleIndex
      ? ({ ...candidate, dependencies, events } as ModuleModel)
      : candidate,
  );
}

/// The per-case chunking-config axis (wave 6): roll one of three modes and produce the matching
/// config. The `roll < 9` band (45%) attempts `organic` — size/share-threshold groups whose
/// composition rolldown decides — and always succeeds for a random-mixed graph (≥3 modules), so
/// organic lands at ~43% of random-mixed cases, above the ≥40% target. The `[9, 15)` band attempts
/// `explicit` (the audited manual groups — exact module lists, incl. splitting a cycle across groups),
/// but `buildRandomManualGroups` declines by its own roll on many graphs, so realized explicit is
/// lower (~12%) and every decline falls through to `default`; the `roll >= 15` band is `default`
/// outright. Returns at most one of the two group fields — the modes are mutually exclusive
/// (validated). Chunking is bundle-side only, so no source semantics change.
function buildChunkingConfig(
  rng: SeededRng,
  drafts: readonly RandomModuleDraft[],
  cycleMemberIds: ReadonlySet<string>,
  entryCount: number,
): {
  readonly manualChunkGroups?: readonly ManualChunkGroup[];
  readonly organicChunkGroups?: readonly OrganicChunkGroupConfig[];
} {
  const roll = rng.integer(20);
  if (roll < 9) {
    const organicChunkGroups = buildOrganicChunkGroups(rng, drafts, entryCount);
    if (organicChunkGroups.length > 0) {
      return { organicChunkGroups };
    }
  }
  const manualChunkGroups = buildRandomManualGroups(rng, drafts, cycleMemberIds);
  if (roll < 15 && manualChunkGroups.length > 0) {
    return { manualChunkGroups };
  }
  return {};
}

/// Project the rolled chunking config onto the persisted `Chunking` union stored on `build.chunking`.
/// `buildChunkingConfig` returns at most one non-empty group array, so the union is unambiguous; an
/// absent/empty array is `automatic`.
function chunkingUnionOf(chunking: {
  readonly manualChunkGroups?: readonly ManualChunkGroup[];
  readonly organicChunkGroups?: readonly OrganicChunkGroupConfig[];
}): Chunking {
  if (chunking.organicChunkGroups !== undefined && chunking.organicChunkGroups.length > 0) {
    return { kind: "organic", groups: chunking.organicChunkGroups };
  }
  if (chunking.manualChunkGroups !== undefined && chunking.manualChunkGroups.length > 0) {
    return { kind: "manual", groups: chunking.manualChunkGroups };
  }
  return { kind: "automatic" };
}

/// Build 1–2 organic (size/share-driven) chunk groups whose composition rolldown resolves. Rolls one
/// of a few empirically-verified "flavors" so each run of the axis produces varied compositions
/// rather than dead coverage (thresholds that never change the output). Every module is ~35–635
/// bytes (measured), so the size thresholds below meaningfully split or merge; `minShareCount` is
/// capped at the entry count so a share threshold can actually capture something. `test`, when set,
/// is a regex SOURCE over the module's file path (`\.mjs$` / `\.cjs$` gives a format-vendor merge).
function buildOrganicChunkGroups(
  rng: SeededRng,
  drafts: readonly RandomModuleDraft[],
  entryCount: number,
): readonly OrganicChunkGroupConfig[] {
  if (drafts.length < 2) {
    return [];
  }
  const idr = (): boolean => rng.boolean();
  const shareCap = Math.max(1, entryCount);
  const formatTest = (): string => (rng.boolean() ? "\\.mjs$" : "\\.cjs$");
  switch (rng.integer(5)) {
    case 0:
      // Vendor-share merge: capture modules referenced by >= N entry chunks into one shared chunk.
      return [
        {
          name: "organic-vendor",
          minShareCount: Math.min(1 + rng.integer(3), shareCap),
          includeDependenciesRecursively: idr(),
        },
      ];
    case 1:
      // Size-split: one broad group split by byte size into several close-to-maxSize chunks.
      return [
        {
          name: "organic-sized",
          minShareCount: 1,
          maxSize: 200 + rng.integer(1000),
          includeDependenciesRecursively: idr(),
        },
      ];
    case 2:
      // Broad merge: one group hosting many modules — stresses intra-chunk statement placement.
      return [
        {
          name: "organic-broad",
          minShareCount: 1,
          ...(rng.boolean() ? { minSize: 128 + rng.integer(384) } : {}),
          includeDependenciesRecursively: idr(),
        },
      ];
    case 3:
      // Format vendor: a `.mjs$` / `.cjs$` regex group, a share threshold on top.
      return [
        {
          name: "organic-format",
          test: formatTest(),
          minShareCount: Math.min(1 + rng.integer(2), shareCap),
          includeDependenciesRecursively: idr(),
        },
      ];
    default:
      // Two competing groups with distinct priorities — a "hot" format group and a shared group.
      return [
        {
          name: "organic-hot",
          test: formatTest(),
          priority: 2,
          includeDependenciesRecursively: idr(),
        },
        {
          name: "organic-shared",
          minShareCount: Math.min(2, shareCap),
          priority: 1,
          ...(rng.boolean() ? { maxSize: 300 + rng.integer(700) } : {}),
          includeDependenciesRecursively: idr(),
        },
      ];
  }
}

/// A dependency that forwards an export without binding it locally (a barrel edge).
function isReexportDependency(dependency: DependencyOperation): boolean {
  return dependency.kind === "esm-reexport-named" || dependency.kind === "esm-reexport-star";
}

/// The single export name a readable ESM edge pulls from its target, or null if the edge cannot be
/// routed through a barrel (side-effect / dynamic imports, requires, or multi-member namespaces).
function barrelForwardedName(dependency: DependencyOperation): string | null {
  if (dependency.kind === "esm-value-import") {
    return dependency.importedName;
  }
  if (dependency.kind === "esm-namespace-import" && dependency.readMembers.length === 1) {
    return dependency.readMembers[0] ?? null;
  }
  return null;
}

/// One re-export hop forwarding `name` from `targetId`: a star (`export *`) or a named re-export.
/// The hop adjacent to the definer may instead use `export { default as name }` (the #9299 shape),
/// which routes demand to the definer's `default` export.
function makeReexport(
  rng: SeededRng,
  targetId: string,
  name: string,
  isDefinerHop: boolean,
): EsmDependencyOperation {
  const roll = rng.integer(isDefinerHop ? 3 : 2);
  if (roll === 0) {
    return { kind: "esm-reexport-star", target: targetId };
  }
  if (isDefinerHop && roll === 2) {
    return {
      kind: "esm-reexport-named",
      target: targetId,
      sourceName: "default",
      exportedName: name,
    };
  }
  return { kind: "esm-reexport-named", target: targetId, sourceName: name, exportedName: name };
}

/// Reroute a meaningful minority of ESM readable edges (value or single-member namespace imports of
/// an ESM definer) through fresh ESM barrel chains: reader -> barrel(s) -> definer, forwarding the
/// read name. Forward edges only (the barrels are new nodes evaluated after the definer and before
/// the reader), so acyclicity and the forward-only read invariant hold. Bounded so total modules
/// stay within the case budget. All-ESM chains keep the interop surface clean; CJS interactions (a
/// CJS reader requiring a barrel, an ESM barrel re-exporting a CJS definer) are model + test only.
function insertBarrelChains(
  rng: SeededRng,
  drafts: readonly RandomModuleDraft[],
  usedEdges: Set<string>,
): RandomModuleDraft[] {
  const draftsById = new Map(drafts.map((draft) => [draft.id, draft]));
  const barrels: RandomModuleDraft[] = [];
  let budget = Math.min(2, Math.max(0, MAX_RANDOM_MODULES - drafts.length));
  // Consider barrels in a meaningful minority of cases.
  if (budget === 0 || rng.integer(2) !== 0) {
    return barrels;
  }
  let counter = 0;
  for (const importer of drafts) {
    if (importer.format !== "esm" || budget === 0) {
      continue;
    }
    for (const [dependencyIndex, dependency] of importer.dependencies.entries()) {
      if (budget === 0) {
        break;
      }
      if (dependency.kind !== "esm-value-import" && dependency.kind !== "esm-namespace-import") {
        continue;
      }
      // Never reroute a hoisted-function CALL import: it is an in-cycle edge, and a barrel is a
      // forward-only re-exporter that would break the cycle (and cannot forward a callable export).
      if (dependency.kind === "esm-value-import" && dependency.call === true) {
        continue;
      }
      const forwardedName = barrelForwardedName(dependency);
      const definer = draftsById.get(dependency.target);
      if (
        forwardedName === null ||
        definer === undefined ||
        definer.format !== "esm" ||
        // ~1/3 of eligible edges get a barrel chain.
        rng.integer(3) !== 0
      ) {
        continue;
      }
      const hopCount = budget >= 2 && rng.boolean() ? 2 : 1;
      const chain: RandomModuleDraft[] = [];
      for (let hop = 0; hop < hopCount; hop += 1) {
        chain.push({ id: `barrel${counter}`, format: "esm", dependencies: [] });
        counter += 1;
        budget -= 1;
      }
      for (const [hopIndex, barrel] of chain.entries()) {
        const isDefinerHop = hopIndex === chain.length - 1;
        const nextId = isDefinerHop ? definer.id : (chain[hopIndex + 1]?.id ?? definer.id);
        barrel.dependencies.push(makeReexport(rng, nextId, forwardedName, isDefinerHop));
        usedEdges.add(`${barrel.id}->${nextId}`);
      }
      const head = chain[0];
      if (head !== undefined) {
        importer.dependencies[dependencyIndex] = { ...dependency, target: head.id };
        // Keep the edge index consistent with the rerouted graph: the reader now points at the barrel
        // head, not the definer. The old key was previously left stale (harmless today because no later
        // pass reads it, but a latent trap for a future pass that does).
        usedEdges.delete(`${importer.id}->${dependency.target}`);
        usedEdges.add(`${importer.id}->${head.id}`);
        barrels.push(...chain);
      }
    }
  }
  return barrels;
}

/// The shared scaffold behind the three witness-cluster injectors (family-A conjunction, callable-own-
/// state, object-identity): a self-contained ESM-only cluster — skipped in pure-CJS — appended after
/// the DAG, gated by a module `budget` and a per-family `probabilityPercent`. Only the gate and budget
/// are shared; each family supplies its own definer / barrel / forced-entry consumer drafts as `build`,
/// which consumes the RNG exactly as its wave always did (the gate rolls `integer(100)` once, in the
/// same position, so seeded corpora are byte-identical).
interface ClusterRecipe {
  readonly minBudget: number;
  readonly probabilityPercent: number;
  readonly build: (rng: SeededRng, counter: number, budget: number) => RandomModuleDraft[];
}

function injectCluster(
  rng: SeededRng,
  drafts: readonly RandomModuleDraft[],
  regime: FormatRegime,
  recipe: ClusterRecipe,
): RandomModuleDraft[] {
  const budget = MAX_RANDOM_MODULES - drafts.length;
  if (regime === "pure-cjs" || budget < recipe.minBudget) {
    return [];
  }
  if (rng.integer(100) >= recipe.probabilityPercent) {
    return [];
  }
  return recipe.build(rng, drafts.length, budget);
}

/// Inject complete family-A conjunctions (`.agents/docs/real-app-bug-families.md`): an inferred-pure
/// definer whose value is STAR-re-exported through a barrel (so it is not flattened to a direct init
/// edge and the definer's `init_*` is a barrel-forwarded target), the barrel shared by >= 2 importers
/// that become entries, with SPLIT reads — one entry reads the pure definer's value through the
/// namespace, another reads a side-effectful sibling's value. This is the real-app shape a green
/// 25,000-case corpus missed; biasing HARD toward completing the whole conjunction (not sprinkling
/// ingredients that rarely meet) is the point. Each cluster is self-contained (fresh ids, forward
/// edges only), so acyclicity and every read invariant hold. The star re-export of the pure definer
/// is essential: a NAMED re-export resolves the binding directly and the bug does not fire (verified
/// against the frozen snapshot). Returns the appended drafts; the caller forces the consumers to be
/// entries. A cluster is 5 modules (definer, sibling, barrel, two consumers); a 2-hop barrel adds one.
function injectPureDefinerConjunctions(
  rng: SeededRng,
  drafts: readonly RandomModuleDraft[],
  regime: FormatRegime,
): { readonly drafts: RandomModuleDraft[]; readonly cluster?: ConjunctionClusterInfo } {
  let cluster: ConjunctionClusterInfo | undefined;
  const appended = injectCluster(rng, drafts, regime, {
    minBudget: 5,
    probabilityPercent: 22,
    build: (rng, counter, budget) => {
      const built = buildPureDefinerConjunction(rng, counter, budget);
      cluster = built.cluster;
      return built.drafts;
    },
  });
  return { drafts: appended, ...(cluster === undefined ? {} : { cluster }) };
}

function buildPureDefinerConjunction(
  rng: SeededRng,
  counter: number,
  budget: number,
): { readonly drafts: RandomModuleDraft[]; readonly cluster: ConjunctionClusterInfo } {
  const definerId = `pdef${counter}`;
  const siblingId = `psib${counter}`;
  const outerBarrelId = `pbar${counter}`;
  const consumerAId = `pconsA${counter}`;
  const consumerBId = `pconsB${counter}`;
  const definerName = `v${definerId}`;
  const siblingName = `v${siblingId}`;

  const definer: RandomModuleDraft = {
    id: definerId,
    format: "esm",
    dependencies: [],
    inferredPure: true,
    pureBase: 1 + rng.integer(900_000),
  };
  const sibling: RandomModuleDraft = { id: siblingId, format: "esm", dependencies: [] };

  // The barrel chain: 1 hop (outer forwards both), or 2 hops when budget allows (outer star-forwards
  // an inner that forwards both) — both defeat flattening (verified). The definer is always reached
  // through a STAR re-export; the sibling through a NAMED re-export on the same barrel.
  const barrels: RandomModuleDraft[] = [];
  if (budget >= 6 && rng.boolean()) {
    const innerBarrelId = `pbarin${counter}`;
    barrels.push({
      id: innerBarrelId,
      format: "esm",
      dependencies: [
        { kind: "esm-reexport-star", target: definerId },
        {
          kind: "esm-reexport-named",
          target: siblingId,
          sourceName: siblingName,
          exportedName: siblingName,
        },
      ],
    });
    barrels.push({
      id: outerBarrelId,
      format: "esm",
      dependencies: [{ kind: "esm-reexport-star", target: innerBarrelId }],
    });
  } else {
    barrels.push({
      id: outerBarrelId,
      format: "esm",
      dependencies: [
        { kind: "esm-reexport-star", target: definerId },
        {
          kind: "esm-reexport-named",
          target: siblingId,
          sourceName: siblingName,
          exportedName: siblingName,
        },
      ],
    });
  }

  // Consumers namespace-import the barrel; the split read (definer vs sibling) is what makes on-demand
  // omit the definer's init and fail od too (family A fails BOTH modes). `withValueReads` folds the
  // single readable member into each consumer's events; a fresh namespace binding per consumer.
  const consumerA: RandomModuleDraft = {
    id: consumerAId,
    format: "esm",
    dependencies: [
      {
        kind: "esm-namespace-import",
        target: outerBarrelId,
        localName: `ns_${consumerAId}`,
        readMembers: [definerName],
      },
    ],
    forceEntry: true,
  };
  const consumerB: RandomModuleDraft = {
    id: consumerBId,
    format: "esm",
    dependencies: [
      {
        kind: "esm-namespace-import",
        target: outerBarrelId,
        localName: `ns_${consumerBId}`,
        readMembers: [siblingName],
      },
    ],
    forceEntry: true,
  };

  return {
    drafts: [definer, sibling, ...barrels, consumerA, consumerB],
    cluster: {
      definerId,
      siblingId,
      barrelIds: barrels.map((barrel) => barrel.id),
      outerBarrelId,
      consumerIds: [consumerAId, consumerBId],
    },
  };
}

/// Inject a callable-reads-own-state cluster (`.agents/docs/object-identity-and-callable-own-state.md`):
/// a `callableOwnState` definer whose exported FUNCTION reads a module-scope state var assigned during
/// init, forwarded through a barrel, and CALLED by entry consumers through the barrel's namespace
/// (`ns.vdef()`). This is the read-side ingredient wave 7 named for isolating on-demand-only bugs — the
/// exact d3-scale/shadcn shape (a callable export reading its OWN init-assigned state), which the
/// existing `call` import (returning a constant) could not express. The two entry consumers make the
/// barrel a shared, order-wrapped chunk; about half the clusters SPLIT the second consumer onto a
/// side-effectful sibling (the family-A conjunction with a CALL read side — hand-verified RED both
/// modes against the frozen snapshot), the rest have both consumers call (the pure witness; it
/// flattens green on the snapshot in isolation). `applyStaticallyInvisibleReads` hides ~half the entry
/// calls inside a local function, the statically-invisible startup use family B needs. A
/// dropped/skipped definer init leaves the state `undefined`, so the call folds to NaN (caught).
/// Self-contained (fresh ids, forward edges only). ESM-only and bounded by the module budget. Returns
/// the appended drafts; the caller forces the consumers to be entries.
function injectCallableOwnStateClusters(
  rng: SeededRng,
  drafts: readonly RandomModuleDraft[],
  regime: FormatRegime,
): RandomModuleDraft[] {
  // A cluster is 4 modules (definer, barrel, two entry consumers), 5 with the split sibling; ESM-only
  // (a callable function export forwarded through a barrel and called through a namespace).
  return injectCluster(rng, drafts, regime, {
    minBudget: 4,
    probabilityPercent: 18,
    build: (rng, counter, budget) => buildCallableOwnStateCluster(rng, counter, budget),
  });
}

function buildCallableOwnStateCluster(
  rng: SeededRng,
  counter: number,
  budget: number,
): RandomModuleDraft[] {
  const definerId = `cos${counter}`;
  const siblingId = `cossib${counter}`;
  const barrelId = `cosbar${counter}`;
  const definerName = `v${definerId}`;
  const siblingName = `v${siblingId}`;

  // ~60% inferred-pure (a no-events pure definer whose callable reads its own init-assigned state — the
  // clean family-B-relevant witness, dropped from output when unused), else event-carrying (a real
  // side-effecting module carrying the same construct). Both are leaves (no dependencies), so the
  // callable only ever reads its own state.
  const inferredPure = rng.integer(5) < 3;
  const definer: RandomModuleDraft = {
    id: definerId,
    format: "esm",
    dependencies: [],
    callableOwnState: true,
    ...(inferredPure ? { inferredPure: true, pureBase: 1 + rng.integer(900_000) } : {}),
  };

  // About half the clusters SPLIT the reads across a side-effectful sibling (consumer B then reads the
  // sibling's value instead of calling the definer) — the family-A conjunction shape with a CALL read
  // side, hand-verified RED in both modes against the frozen snapshot (the sibling keeps the barrel a
  // wrapped chunk whose init drops the definer, while both-call clusters flatten green there). The
  // split variant hunts today's bug through the call path; the both-call variant is the pure witness
  // for any future dropped/skipped init.
  const split = budget >= 5 && rng.boolean();
  const sibling: RandomModuleDraft | undefined = split
    ? { id: siblingId, format: "esm", dependencies: [] }
    : undefined;

  // The barrel forwards the callable export: a STAR re-export (the whole definer init may drop) or a
  // NAMED one. Either keeps the definer cross-chunk behind a barrel; the campaign's organic chunking
  // supplies the order-wrapping that can make on-demand skip its init. A split cluster always uses the
  // STAR for the definer (the load-bearing family-A ingredient) plus a NAMED sibling re-export.
  const barrel: RandomModuleDraft = {
    id: barrelId,
    format: "esm",
    dependencies: split
      ? [
          { kind: "esm-reexport-star", target: definerId },
          {
            kind: "esm-reexport-named",
            target: siblingId,
            sourceName: siblingName,
            exportedName: siblingName,
          },
        ]
      : [
          rng.boolean()
            ? { kind: "esm-reexport-star", target: definerId }
            : {
                kind: "esm-reexport-named",
                target: definerId,
                sourceName: definerName,
                exportedName: definerName,
              },
        ],
  };

  // Entry consumers namespace-import the barrel. A caller CALLS the definer's export (`ns.vdef()`),
  // folding the returned own-state value into an event; a split cluster's second consumer reads the
  // SIBLING's value instead (the split that keeps the barrel wrapped).
  const makeCaller = (id: string): RandomModuleDraft => ({
    id,
    format: "esm",
    dependencies: [
      {
        kind: "esm-namespace-import",
        target: barrelId,
        localName: `ns_${id}`,
        readMembers: [definerName],
        callMembers: [definerName],
      },
    ],
    forceEntry: true,
  });
  const makeSiblingReader = (id: string): RandomModuleDraft => ({
    id,
    format: "esm",
    dependencies: [
      {
        kind: "esm-namespace-import",
        target: barrelId,
        localName: `ns_${id}`,
        readMembers: [siblingName],
      },
    ],
    forceEntry: true,
  });

  const consumerA = makeCaller(`coscA${counter}`);
  const consumerB = split ? makeSiblingReader(`coscB${counter}`) : makeCaller(`coscB${counter}`);
  return sibling === undefined
    ? [definer, barrel, consumerA, consumerB]
    : [definer, sibling, barrel, consumerA, consumerB];
}

/// Inject an object-identity cluster (Task 3, `.agents/docs/object-identity-and-callable-own-state.md`):
/// an `objectExport` definer (a no-events module exporting a fresh object literal — the invisible
/// double-init target), forwarded through a barrel, captured by two entry consumers that each hold a
/// DIRECT reference and a BARREL-forwarded reference and compare identity (`a === b`). In source ESM
/// the definer evaluates once, so both captures are one object (`true`); if a bundler ever re-runs the
/// definer (e.g. duplicates it across chunks) a late capture is a NEW object (`false`) — a silent
/// double-init a numeric oracle cannot see (numbers are idempotent). Identity preservation across these
/// import paths was probed LEGAL on both healthy builds before integrating (no false positives).
/// Self-contained (fresh ids, forward edges only). ESM-only and bounded by the module budget. Returns
/// the appended drafts; the caller forces the consumers to be entries (sharing the definer and barrel
/// so organic chunking can pull the definer into two chunks — the double-evaluation the witness hunts).
function injectObjectIdentityClusters(
  rng: SeededRng,
  drafts: readonly RandomModuleDraft[],
  regime: FormatRegime,
): RandomModuleDraft[] {
  // A cluster is 4 modules (object-export definer, barrel, two entry consumers). ESM-only.
  return injectCluster(rng, drafts, regime, {
    minBudget: 4,
    probabilityPercent: 12,
    build: (rng, counter) => buildObjectIdentityCluster(rng, counter),
  });
}

function buildObjectIdentityCluster(rng: SeededRng, counter: number): RandomModuleDraft[] {
  const definerId = `obj${counter}`;
  const barrelId = `objbar${counter}`;
  const definerName = `v${definerId}`;

  const definer: RandomModuleDraft = {
    id: definerId,
    format: "esm",
    dependencies: [],
    objectExport: true,
  };
  const barrel: RandomModuleDraft = {
    id: barrelId,
    format: "esm",
    dependencies: [
      rng.boolean()
        ? { kind: "esm-reexport-star", target: definerId }
        : {
            kind: "esm-reexport-named",
            target: definerId,
            sourceName: definerName,
            exportedName: definerName,
          },
    ],
  };
  // Each consumer captures the SAME object export directly AND through the barrel, then compares
  // identity in one event.
  const makeConsumer = (id: string): RandomModuleDraft => {
    const directBinding = `od_${id}`;
    const barrelBinding = `ob_${id}`;
    return {
      id,
      format: "esm",
      dependencies: [
        {
          kind: "esm-value-import",
          target: definerId,
          importedName: definerName,
          localName: directBinding,
          objectRef: true,
        },
        {
          kind: "esm-value-import",
          target: barrelId,
          importedName: definerName,
          localName: barrelBinding,
          objectRef: true,
        },
      ],
      forceEntry: true,
      identityCheck: { leftBinding: directBinding, rightBinding: barrelBinding },
    };
  };
  return [definer, barrel, makeConsumer(`objcA${counter}`), makeConsumer(`objcB${counter}`)];
}

/// Kinds an existing forward edge may hold and still be a candidate for multi-edge augmentation.
/// Namespace imports, hoisted-function CALL imports (cycle edges only), and re-exports are excluded:
/// they are not the plain static/lazy shape this pass builds, and the forward-only gate already keeps
/// cycle edges out.
const AUGMENTABLE_EXISTING_KINDS = new Set<DependencyOperation["kind"]>([
  "esm-side-effect-import",
  "esm-value-import",
  "esm-dynamic-import",
  "cjs-require",
]);

/// The per-pair slot a candidate edge occupies (mirrors `dependencyPairSlot` in validate-model.ts):
/// value and namespace share one binding slot, but augmentation never adds a namespace edge.
function augmentSlot(kind: DependencyOperation["kind"]): string | undefined {
  switch (kind) {
    case "esm-value-import":
      return "value";
    case "esm-side-effect-import":
      return "side-effect";
    case "esm-dynamic-import":
      return "dynamic";
    case "cjs-require":
      return "require";
    default:
      return undefined;
  }
}

/// Turn a meaningful minority of FORWARD pairs into real multi-kind pairs — the shape real code
/// constantly writes: `import { a } from "./x"` AND `import("./x")` (static + lazy), or a side-effect
/// import plus a value import of one module. The same (importer, target), already joined by one edge,
/// gains a compatible SECOND (or third) kind from a per-format slot menu — {side-effect, value,
/// dynamic} for ESM importers, {require, dynamic} for CJS — never a duplicate slot (the validator's
/// per-pair rule). Forward-only: it augments a pair only when the target does NOT synchronously reach
/// back to the importer, so an added value read stays forward (fully evaluated target, no TDZ, no
/// cycle) and an added side-effect edge never closes a cycle. Any added dynamic registers through the
/// standard `__orderDynamicImports` mechanism and joins the schedule's trigger pool, so the key order
/// surface — a dynamic import of an ALREADY-STATICALLY-LOADED module — is exercised without re-running
/// the target. Barrels (pure re-exporters) are never touched, as importer or target.
function augmentMultiEdgePairs(
  rng: SeededRng,
  drafts: readonly RandomModuleDraft[],
  registrations: { owner: string; registration: string }[],
): void {
  // Attempt in a meaningful minority of cases; a per-pair roll then decides each eligible pair.
  if (rng.boolean()) {
    return;
  }
  const barrelIds = new Set(
    drafts
      .filter((draft) => draft.dependencies.some(isReexportDependency))
      .map((draft) => draft.id),
  );
  const facts = ProgramFacts.from(drafts);

  for (const importer of drafts) {
    if (barrelIds.has(importer.id)) {
      continue;
    }
    const slotMenu =
      importer.format === "esm" ? ["value", "side-effect", "dynamic"] : ["require", "dynamic"];
    // Every pair holds at most one edge before this pass, but grouping by target keeps it robust.
    for (const targetId of new Set(importer.dependencies.map((dependency) => dependency.target))) {
      if (
        targetId === importer.id ||
        barrelIds.has(targetId) ||
        // Whether ADDING a synchronous edge here would close a cycle — the forward question a mutator
        // needs. `edgeClosesCycle` is an SCC-membership test valid only for an already-synchronous edge;
        // for a pair joined only DYNAMICALLY (dynamic importer -> target, target sync-reaches importer)
        // it wrongly returns false, so the augmenter would add a synchronous value/side-effect edge that
        // silently closes a cycle. The corpus's dynamic edges are forward-only, so this is byte-identical
        // there; it only excludes the dynamic-only back-edge pair a future/handwritten graph could hit.
        facts.wouldCloseSynchronousEdge(importer.id, targetId)
      ) {
        continue; // self-edge, a barrel, or a cycle-closing pair — never augment.
      }
      const existing = importer.dependencies.filter((dependency) => dependency.target === targetId);
      if (
        !existing.every((dependency) => AUGMENTABLE_EXISTING_KINDS.has(dependency.kind)) ||
        existing.some(
          (dependency) => dependency.kind === "esm-value-import" && dependency.call === true,
        )
      ) {
        continue;
      }
      const usedSlots = new Set(
        existing.flatMap((dependency) => {
          const slot = augmentSlot(dependency.kind);
          return slot === undefined ? [] : [slot];
        }),
      );
      const candidateSlots = slotMenu.filter((slot) => !usedSlots.has(slot));
      if (candidateSlots.length === 0 || rng.boolean()) {
        continue;
      }
      let added = candidateSlots.filter(() => rng.boolean());
      if (added.length === 0) {
        added = [rng.pick(candidateSlots)];
      }
      for (const slot of added) {
        appendAugmentedEdge(importer, targetId, slot, registrations);
      }
    }
  }
}

/// Append one augmented edge of `slot` from `importer` to `targetId`, with binding / registration
/// names distinctly prefixed so they never collide with a primary edge's names.
function appendAugmentedEdge(
  importer: RandomModuleDraft,
  targetId: string,
  slot: string,
  registrations: { owner: string; registration: string }[],
): void {
  if (slot === "side-effect") {
    importer.dependencies.push({ kind: "esm-side-effect-import", target: targetId });
    return;
  }
  if (slot === "value") {
    importer.dependencies.push({
      kind: "esm-value-import",
      target: targetId,
      importedName: `v${targetId}`,
      localName: `me_${importer.id}_${targetId}`,
    });
    return;
  }
  if (slot === "require") {
    importer.dependencies.push({
      kind: "cjs-require",
      target: targetId,
      resultBinding: `mr_${importer.id}_${targetId}`,
      readName: `v${targetId}`,
    });
    return;
  }
  const registration = `dynm-${importer.id}-${targetId}`;
  importer.dependencies.push({ kind: "esm-dynamic-import", target: targetId, registration });
  registrations.push({ owner: importer.id, registration });
}

/// Choose a meaningful minority of leaf, value-contributing ESM modules to carry `sideEffects:false`
/// package metadata. Eligibility keeps the oracle sound: a flagged module is ESM, is read by some
/// module through a value edge (so it is not trivially droppable and invisible), is not an entry,
/// and is a leaf with no dependencies. A leaf has no upstream side effects, so however the bundler
/// legally drops it or its initializer under the flag, the observable event stream is unchanged, and
/// any divergence (a dropped-but-referenced binding, over-aggressive DCE removing needed value code)
/// is a real bug (rolldown #9961, #10123). The caller strips a flagged module's events so it emits
/// none, matching the validated no-events invariant. The richer transitive #9961 shape (a flagged
/// module that itself reads upstream) is covered by a handwritten test rather than generated,
/// because its soundness needs the folded value to reach a kept event.
function chooseSideEffectFreeModules(
  rng: SeededRng,
  modules: readonly ModuleModel[],
  entries: readonly EntryModel[],
): ReadonlySet<string> {
  const flagged = new Set<string>();
  const valueReadTargets = new Set<string>();
  for (const module of modules) {
    for (const dependency of module.dependencies) {
      if (
        dependency.kind === "esm-value-import" ||
        (dependency.kind === "cjs-require" && dependency.resultBinding !== undefined)
      ) {
        valueReadTargets.add(dependency.target);
      }
    }
  }
  const entryIds = new Set(entries.map((entry) => entry.moduleId));
  const eligible = modules.filter((module) => {
    // Classified through the ONE ModuleProfile projection, not the raw flags: an inferred-pure definer
    // and the wave-8 witness definers (objectExport, callable-own-state) carry their own export rendering
    // and must not be flagged — an objectExport must not be sideEffectFree (a dropped object export
    // defeats the identity witness), and a callable-own-state definer's state must not be stripped.
    const profile = moduleProfile(module);
    return (
      module.format === "esm" &&
      profile.purity.kind !== "inferred" &&
      profile.exportShape.kind !== "fresh-object" &&
      profile.exportShape.kind !== "callable-own-state" &&
      module.dependencies.length === 0 &&
      !entryIds.has(module.id) &&
      valueReadTargets.has(module.id)
    );
  });
  // Flag in a meaningful minority of eligible cases, then a minority of that case's eligible modules.
  if (eligible.length === 0 || !rng.boolean()) {
    return flagged;
  }
  for (const module of eligible) {
    if (rng.boolean()) {
      flagged.add(module.id);
    }
  }
  if (flagged.size === 0) {
    const fallback = eligible[rng.integer(eligible.length)];
    if (fallback !== undefined) {
      flagged.add(fallback.id);
    }
  }
  return flagged;
}

/// Entries evaluate once each in random order; available dynamic-import triggers are
/// interleaved after entries and flushed at the end. Some registrations intentionally
/// never fire, leaving retained-but-unloaded dynamic entries in the bundle.
/// The dynamic-import registration sequence, DERIVED from the FINALIZED graph and ordered by each edge's
/// CREATION ORDINAL — not the creation-ordered side list iterated on trust. The side list records the
/// creation ordinal of each edge (its position IS the ordinal, keyed by the edge's unique registration);
/// this scans the frozen graph for every dynamic edge, tags it with that ordinal, and sorts. Because the
/// ordinal is the side-list index, the result reproduces the old side-list order EXACTLY, so the seeded
/// schedule — which iterates registrations in creation order — stays byte-identical. The asserts turn a
/// future graph/side-list divergence (a registration with no edge, an edge with no ordinal, or a
/// duplicate) into a loud generation failure instead of a silently reordered, corpus-moving schedule.
export function deriveRegistrationSequence(
  modules: readonly ModuleModel[],
  registrations: readonly { readonly owner: string; readonly registration: string }[],
): { owner: string; registration: string }[] {
  const ordinalOf = new Map<string, number>();
  registrations.forEach((entry, index) => {
    if (ordinalOf.has(entry.registration)) {
      throw new Error(`duplicate dynamic-import registration ordinal for ${entry.registration}`);
    }
    ordinalOf.set(entry.registration, index);
  });
  const graphEdges: { owner: string; registration: string; ordinal: number }[] = [];
  const seen = new Set<string>();
  for (const module of modules) {
    for (const dependency of module.dependencies) {
      if (dependency.kind !== "esm-dynamic-import") {
        continue;
      }
      const ordinal = ordinalOf.get(dependency.registration);
      if (ordinal === undefined) {
        throw new Error(
          `dynamic edge ${dependency.registration} on ${module.id} has no creation ordinal (graph/side-list drift)`,
        );
      }
      if (seen.has(dependency.registration)) {
        throw new Error(`duplicate dynamic edge registration ${dependency.registration} in graph`);
      }
      seen.add(dependency.registration);
      graphEdges.push({ owner: module.id, registration: dependency.registration, ordinal });
    }
  }
  if (seen.size !== ordinalOf.size) {
    throw new Error(
      `dynamic registration/graph mismatch: ${ordinalOf.size} recorded, ${seen.size} present in the finalized graph`,
    );
  }
  graphEdges.sort((left, right) => left.ordinal - right.ordinal);
  return graphEdges.map(({ owner, registration }) => ({ owner, registration }));
}

function buildRandomSchedule(
  rng: SeededRng,
  modules: readonly ModuleModel[],
  entries: readonly EntryModel[],
  registrations: readonly { owner: string; registration: string }[],
): ScheduleOperation[] {
  const modulesById = new Map(modules.map((module) => [module.id, module]));
  const schedule: ScheduleOperation[] = [];
  const evaluated = new Set<string>();
  const triggered = new Set<string>();

  const markEvaluated = (rootId: string) => {
    const pending = [rootId];
    while (pending.length > 0) {
      const moduleId = pending.pop();
      if (moduleId === undefined || evaluated.has(moduleId)) {
        continue;
      }
      evaluated.add(moduleId);
      for (const dependency of modulesById.get(moduleId)?.dependencies ?? []) {
        if (dependency.kind !== "esm-dynamic-import") {
          pending.push(dependency.target);
        }
      }
    }
  };

  const flushTriggers = (probabilityNumerator: number) => {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const { owner, registration } of registrations) {
        if (triggered.has(registration) || !evaluated.has(owner)) {
          continue;
        }
        if (rng.integer(4) >= probabilityNumerator) {
          continue;
        }
        triggered.add(registration);
        schedule.push({ kind: "trigger-dynamic-import", registration });
        const target = modulesById
          .get(owner)
          ?.dependencies.find(
            (dependency) =>
              dependency.kind === "esm-dynamic-import" && dependency.registration === registration,
          );
        if (target !== undefined) {
          markEvaluated(target.target);
          progressed = true;
        }
      }
    }
  };

  const shuffledEntries = [...entries];
  for (let index = shuffledEntries.length - 1; index > 0; index -= 1) {
    const swap = rng.integer(index + 1);
    const left = shuffledEntries[index];
    const right = shuffledEntries[swap];
    if (left !== undefined && right !== undefined) {
      shuffledEntries[index] = right;
      shuffledEntries[swap] = left;
    }
  }

  for (const entry of shuffledEntries) {
    const entryModule = modulesById.get(entry.moduleId);
    if (entryModule === undefined) {
      continue;
    }
    schedule.push(
      entryModule.format === "esm"
        ? { kind: "import-entry", entry: entry.name }
        : { kind: "require-entry", entry: entry.name },
    );
    markEvaluated(entry.moduleId);
    flushTriggers(2);
  }
  flushTriggers(3);

  return schedule;
}

/// A random distinct subset of `items` of size `count`, a Fisher-Yates prefix. Used to pick the
/// cycle members that external edges enter.
function pickDistinct<T>(rng: SeededRng, items: readonly T[], count: number): T[] {
  const pool = [...items];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = rng.integer(index + 1);
    const left = pool[index];
    const right = pool[swap];
    if (left !== undefined && right !== undefined) {
      pool[index] = right;
      pool[swap] = left;
    }
  }
  return pool.slice(0, Math.max(0, Math.min(count, pool.length)));
}

function buildRandomManualGroups(
  rng: SeededRng,
  drafts: readonly RandomModuleDraft[],
  cycleMemberIds: ReadonlySet<string>,
): ManualChunkGroup[] {
  // Deliberately split a cycle across chunk groups — the cross-chunk init-cycle trigger behind the
  // `init_X is not a function` family (rolldown #3529, #9887, #9946). Each group's `test` may match a
  // single module; rolldown accepts that (verified), so a 2-member cycle can split one member each.
  const cycleMembers = drafts.filter((draft) => cycleMemberIds.has(draft.id));
  if (cycleMembers.length >= 2 && rng.boolean()) {
    const first: string[] = [];
    const second: string[] = [];
    for (const [index, member] of cycleMembers.entries()) {
      (index % 2 === 0 ? first : second).push(member.id);
    }
    if (first.length > 0 && second.length > 0) {
      return [
        { name: "cycle-a", moduleIds: first },
        { name: "cycle-b", moduleIds: second },
      ];
    }
  }
  if (rng.integer(3) !== 0 || drafts.length < 4) {
    return [];
  }
  const shuffled = [...drafts];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = rng.integer(index + 1);
    const left = shuffled[index];
    const right = shuffled[swap];
    if (left !== undefined && right !== undefined) {
      shuffled[index] = right;
      shuffled[swap] = left;
    }
  }
  const groupCount = 1 + rng.integer(2);
  const groups: ManualChunkGroup[] = [];
  let cursor = 0;
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const memberCount = 2 + rng.integer(3);
    const members = shuffled.slice(cursor, cursor + memberCount);
    cursor += memberCount;
    if (members.length >= 2) {
      groups.push({
        name: `group-${groupIndex}`,
        moduleIds: members.map((member) => member.id),
      });
    }
  }
  return groups;
}

export function deriveCoverageTags(analyzed: AnalyzedProgram): readonly string[] {
  const tags = new Set<string>();
  // The consumer takes ONLY the AnalyzedProgram and reads the program from it (no separate program
  // argument that could disagree with the analysis). A standalone caller wraps `analyzeProgram(program)`.
  const { program, facts, plan } = analyzed;
  const modulesById = new Map(program.modules.map((module) => [module.id, module]));
  const formats = new Set(program.modules.map((module) => module.format));
  const esmCarriersByCjsTarget = new Map<string, Set<string>>();
  let requiresSynchronousEsm = false;

  if (formats.has("esm") && formats.has("cjs")) {
    tags.add("mechanism:mixed-esm-cjs");
    tags.add("regime:mixed");
  } else {
    tags.add(formats.has("cjs") ? "regime:pure-cjs" : "regime:pure-esm");
  }

  for (const module of program.modules) {
    for (const dependency of module.dependencies) {
      const target = modulesById.get(dependency.target);
      if (module.format === "cjs" && dependency.kind === "esm-dynamic-import") {
        tags.add("mechanism:cjs-dynamic-import");
      }
      if (module.format === "esm" && target?.format === "cjs") {
        tags.add("mechanism:esm-imports-cjs");
        // Classify by the actual dependency kind: a side-effect import is a bare side effect, a
        // value/namespace import folds a value, and a DYNAMIC import is neither — it defers, so it must
        // not be mislabeled as a side-effect import (the review's finding-8 defect).
        if (dependency.kind === "esm-side-effect-import") {
          tags.add("variation:side-effect-import");
        } else if (
          dependency.kind === "esm-value-import" ||
          dependency.kind === "esm-namespace-import"
        ) {
          tags.add("variation:value-import");
        }
        const carriers = esmCarriersByCjsTarget.get(target.id) ?? new Set<string>();
        carriers.add(module.id);
        esmCarriersByCjsTarget.set(target.id, carriers);
      } else if (
        module.format === "cjs" &&
        dependency.kind === "cjs-require" &&
        target?.format === "esm"
      ) {
        tags.add("mechanism:cjs-requires-esm");
        if (!facts.reachesTopLevelAwait(target.id)) {
          requiresSynchronousEsm = true;
        }
      }
    }
  }

  if ([...esmCarriersByCjsTarget.values()].some((carriers) => carriers.size >= 2)) {
    tags.add("mechanism:multiple-esm-carriers");
    tags.add("mechanism:shared-cjs");
  }
  if (requiresSynchronousEsm) {
    tags.add("mechanism:synchronous-esm");
  }

  const hasOverlappingEntries = entriesOverlap(program, facts);
  if (program.entries.length > 1) {
    tags.add("mechanism:multiple-entries");
  }
  if (hasOverlappingEntries) {
    tags.add("mechanism:overlapping-dependencies");
  }

  // The per-case chunking-config axis (wave 6), driven by the single `programChunking` matcher.
  const chunking = programChunking(program);
  if (chunking.kind === "manual") {
    tags.add("mechanism:manual-chunks");
    tags.add("chunking:explicit");
    if (manualGroupsSeparateFormats(chunking.groups, modulesById)) {
      tags.add("mechanism:separate-interop");
    }
  } else if (chunking.kind === "organic") {
    tags.add("chunking:organic");
    tags.add("mechanism:organic-chunks");
  } else {
    tags.add("chunking:default");
  }

  // The persisted BuildConfig axes (W14a): one tag per rolled value so a density scan sees both settings
  // of each axis. `includeDependenciesRecursively` (the global codeSplitting fallback, `false` an
  // ingredient of the #9887 catch) and `lazyBarrel` (rolldown's barrel-pruning optimization) are rolled;
  // `preserveEntrySignatures` / `strictExecutionOrder` are fixed, so they carry no per-value axis tag.
  const build = buildConfigOf(program);
  tags.add(`axis:include-dependencies-recursively:${String(build.includeDependenciesRecursively)}`);
  tags.add(`axis:lazy-barrel:${String(build.lazyBarrel)}`);

  // The #9887 cross-chunk init-cycle structural signature (W14-10 / ingredient D4): a manual chunk split
  // where a cross-group CJS-requires-ESM edge CLOSES an actual chunk cycle rolldown mis-orders
  // (`init_dep is not a function`). It is NOT enough that the CJS→ESM require crosses groups — an acyclic
  // cross-group edge (a plain `cjs → esm` in two groups with no return path) does not manufacture the
  // cycle. So the predicate requires a grouped QUOTIENT cycle: the ESM target's chunk must reach back to
  // the requiring module's chunk through the static dependency graph, quotiented by manual group
  // (ungrouped modules are singleton chunks; async `import()` edges are excluded — they do not close an
  // eager chunk cycle). With `includeDependenciesRecursively: false` this is the shape rolldown mis-orders.
  // Purely structural, so it holds for a handwritten or shrunk model that preserves the cycle.
  if (chunking.kind === "manual" && build.includeDependenciesRecursively === false) {
    const groupOf = new Map<string, string>();
    for (const group of chunking.groups) {
      for (const id of group.moduleIds) {
        groupOf.set(id, group.name);
      }
    }
    // The chunk-quotient node a module belongs to: its manual group, else the module as a singleton
    // chunk. Prefix-tagged so a group name can never collide with a module id.
    const nodeOf = (moduleId: string): string =>
      groupOf.has(moduleId) ? `group:${groupOf.get(moduleId) ?? ""}` : `module:${moduleId}`;
    const quotientEdges = new Map<string, Set<string>>();
    for (const module of program.modules) {
      const from = nodeOf(module.id);
      for (const dependency of module.dependencies) {
        if (dependency.kind === "esm-dynamic-import" || !modulesById.has(dependency.target)) {
          continue;
        }
        const to = nodeOf(dependency.target);
        if (from === to) {
          continue;
        }
        let targets = quotientEdges.get(from);
        if (targets === undefined) {
          targets = new Set();
          quotientEdges.set(from, targets);
        }
        targets.add(to);
      }
    }
    const reachesInQuotient = (start: string, goal: string): boolean => {
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node === undefined || seen.has(node)) {
          continue;
        }
        seen.add(node);
        for (const next of quotientEdges.get(node) ?? []) {
          if (next === goal) {
            return true;
          }
          stack.push(next);
        }
      }
      return false;
    };
    const closesQuotientCycle = program.modules.some(
      (module) =>
        module.format === "cjs" &&
        groupOf.has(module.id) &&
        module.dependencies.some((dependency) => {
          if (dependency.kind !== "cjs-require" || !groupOf.has(dependency.target)) {
            return false;
          }
          const target = modulesById.get(dependency.target);
          const from = nodeOf(module.id);
          const to = nodeOf(dependency.target);
          return target?.format === "esm" && from !== to && reachesInQuotient(to, from);
        }),
    );
    if (closesQuotientCycle) {
      tags.add("mechanism:barrel-cross-chunk-init-cycle");
    }
  }

  const registrations = program.modules.flatMap((module) =>
    module.dependencies.flatMap((dependency) =>
      dependency.kind === "esm-dynamic-import" ? [dependency.registration] : [],
    ),
  );
  if (registrations.length > 0) {
    tags.add("mechanism:dynamic-import");
    const triggeredRegistrations = new Set(
      program.schedule.flatMap((operation) =>
        operation.kind === "trigger-dynamic-import" ? [operation.registration] : [],
      ),
    );
    if (registrations.some((registration) => !triggeredRegistrations.has(registration))) {
      tags.add("mechanism:untriggered-dynamic-import");
    }
    if (hasNestedDynamicChain(program, facts)) {
      tags.add("mechanism:nested-dynamic");
    }
  }

  const dependencyTargets = new Set(
    program.modules.flatMap((module) => module.dependencies.map((dependency) => dependency.target)),
  );
  if (program.entries.some((entry) => dependencyTargets.has(entry.moduleId))) {
    tags.add("mechanism:entry-also-imported");
  }

  const cycles = facts.cycles();
  if (cycles.cyclicMembers.size > 0) {
    tags.add("mechanism:cycle");
    // Per-SCC, not program-wide: a program with a separate all-ESM SCC AND a separate all-CJS SCC has
    // BOTH an esm-cycle and a cjs-cycle. The old program-wide format union (size 2 then) fired neither.
    if (cycles.sccFormats.some((formats) => formats.size === 1 && formats.has("esm"))) {
      tags.add("mechanism:esm-cycle");
    }
    if (cycles.sccFormats.some((formats) => formats.size === 1 && formats.has("cjs"))) {
      tags.add("mechanism:cjs-cycle");
    }
    if (cycles.hasChord) {
      tags.add("mechanism:cycle-chord");
    }
    if (cycles.hasInterlocking) {
      tags.add("mechanism:interlocking-cycles");
    }
    if (cycles.hasMultiEnter) {
      tags.add("mechanism:cycle-multi-enter");
    }
    // A cycle whose members land in two or more manual chunk groups — the cross-chunk init-cycle
    // shape behind the `init_X is not a function` family (rolldown #3529, #9887, #9946, vite #22341).
    const groupsById = new Map<string, string>();
    const manualChunking = programChunking(program);
    for (const group of manualChunking.kind === "manual" ? manualChunking.groups : []) {
      for (const moduleId of group.moduleIds) {
        groupsById.set(moduleId, group.name);
      }
    }
    if (
      cycles.sccs.some((scc) => {
        const groups = new Set(
          scc.map((id) => groupsById.get(id)).filter((name) => name !== undefined),
        );
        return groups.size >= 2;
      })
    ) {
      tags.add("mechanism:cycle-split-groups");
    }
    // A value read folded across a CYCLE-CLOSING edge (a hoisted-function call or a guarded partial
    // read) — cycle data flow, not just cycle side-effect ordering. Attributed to the edge that closes
    // a cycle, not to any call/guard read anywhere in the program: a forward callable/guarded witness
    // (a callable-own-state cluster, a post-cycle read) must not falsely produce a cycle tag once some
    // unrelated cycle exists (the review's finding-8 defect).
    let hasCycleHoistedCall = false;
    let hasCyclePartialRead = false;
    for (const module of program.modules) {
      for (const dependency of module.dependencies) {
        if (!facts.edgeClosesCycle(module.id, dependency.target)) {
          continue;
        }
        if (dependency.kind === "esm-value-import" && dependency.call === true) {
          hasCycleHoistedCall = true;
        }
        if (dependency.kind === "cjs-require" && dependency.guard === true) {
          hasCyclePartialRead = true;
        }
      }
    }
    if (hasCycleHoistedCall || hasCyclePartialRead) {
      tags.add("mechanism:cycle-value-read");
    }
    if (hasCycleHoistedCall) {
      tags.add("variation:cycle-hoisted-call");
    }
    if (hasCyclePartialRead) {
      tags.add("variation:cycle-partial-read");
    }
    // A module OUTSIDE every cycle reads a cycle member's export (forward, fully-evaluated) — the
    // value that flowed through the cycle observed downstream.
    if (
      program.modules.some(
        (module) =>
          !cycles.cyclicMembers.has(module.id) &&
          module.dependencies.some(
            (dependency) =>
              cycles.cyclicMembers.has(dependency.target) &&
              (dependency.kind === "esm-value-import" ||
                dependency.kind === "esm-namespace-import" ||
                (dependency.kind === "cjs-require" && dependency.resultBinding !== undefined)),
          ),
      )
    ) {
      tags.add("mechanism:post-cycle-read");
    }
  }

  // A module reads an imported value into an event payload — the dormant value oracle is active.
  if (
    program.modules.some((module) => module.events.some((event) => (event.reads?.length ?? 0) > 0))
  ) {
    tags.add("variation:value-read");
  }

  // Metadata purity (`sideEffects` package metadata asserting some member pure): the primary
  // dead-code-elimination versus execution-order trigger, read from the ONE resolved packages view
  // (`metadataPureModuleIds` over the `packagesOf` seam), so legacy flagged models and package models
  // tag identically. Plus the W14b package-surface tags: any package at all, and the partial ARRAY
  // metadata form (the vben/family-B ingredient).
  const packages = packagesOf(program);
  if (metadataPureModuleIds(program).size > 0) {
    tags.add("variation:side-effect-free-metadata");
  }
  if (packages.length > 0) {
    tags.add("variation:package");
  }
  if (packages.some((pkg) => typeof pkg.sideEffects !== "boolean")) {
    tags.add("variation:side-effects-array");
  }

  // Family A/B mechanisms (`.agents/docs/real-app-bug-families.md`). An inferred-pure definer (judged
  // side-effect-free by STATEMENT inference, not a package flag); a function-hidden read (a folded
  // read run inside a local function called at init); a computed namespace member access (`ns[k]`).
  if (program.modules.some((module) => moduleProfile(module).purity.kind === "inferred")) {
    tags.add("variation:inferred-pure-definer");
  }
  if (
    program.modules.some((module) => module.events.some((event) => event.hiddenReadFn === true))
  ) {
    tags.add("variation:function-hidden-read");
  }
  if (
    program.modules.some((module) =>
      module.events.some((event) => (event.reads ?? []).some((read) => read.computed === true)),
    )
  ) {
    tags.add("variation:computed-member-read");
  }
  // A callable-reads-own-state definer (Task 2): an exported function reads its module's own
  // init-assigned state var, called by consumers — the d3-scale/shadcn read-side witness.
  if (
    program.modules.some(
      (module) => moduleProfile(module).exportShape.kind === "callable-own-state",
    )
  ) {
    tags.add("variation:callable-own-state");
  }
  // An object-identity witness (Task 3): an event compares two captures of one object export for
  // identity, catching a silent double-init that idempotent numbers cannot.
  if (
    program.modules.some((module) =>
      module.events.some((event) => event.identityCheck !== undefined),
    )
  ) {
    tags.add("variation:object-identity");
  }
  // The COMPLETE family-A conjunction: an inferred-pure definer STAR-re-exported through a barrel
  // that >= 2 modules namespace-import, at least one reading the definer's value via the star. Only a
  // complete conjunction is tagged, so a campaign summary's count proves conjunction DENSITY (the
  // failure mode that made the old corpus miss these bugs was ingredients that rarely all met).
  const entryModuleIds = new Set(program.entries.map((entry) => entry.moduleId));
  if (hasCompletePureDefinerConjunction(program, modulesById, plan, entryModuleIds)) {
    tags.add("mechanism:pure-definer-behind-barrel");
  }

  // The COMPLETE family-B eager-barrel conjunction (the vben shape): partial-array package metadata
  // keeping a star barrel eager while its facade hop is shaken, an included own helper, a chunk group
  // splitting {facade, sibling} from the entry chunk, an effectful first import, and a
  // hiddenReadFn-consumed facade value. Only a complete conjunction is tagged (density = the
  // conjunction, not sprinkled ingredients); purely structural, so it holds for generated,
  // handwritten, and shrunk models alike.
  if (hasCompleteFamilyBConjunction(program, modulesById, plan, entryModuleIds)) {
    tags.add("mechanism:family-b-eager-barrel");
  }

  // The retained-reference witness: a metadata-pure package member whose top-level reference to a
  // PURE definer is retained by a kept event's demand — the closed #9961/#10123 family's shape.
  if (hasRetainedPureReference(program, modulesById, plan)) {
    tags.add("mechanism:package-retained-reference");
  }

  // Namespace imports (`import * as ns`) with a folded member read exercise the namespace-shape
  // interop surface; re-export (barrel) chains forward a value several hops from its definer.
  const dependencyKinds = new Set(
    program.modules.flatMap((module) => module.dependencies.map((dependency) => dependency.kind)),
  );
  // A namespace import certifies the namespace-read shape only when it actually READS a member; a
  // namespace with no remaining members after shrinking reads nothing (the review's finding-8 defect).
  if (
    program.modules.some((module) =>
      module.dependencies.some(
        (dependency) =>
          dependency.kind === "esm-namespace-import" && dependency.readMembers.length > 0,
      ),
    )
  ) {
    tags.add("variation:namespace-read");
  }
  if (dependencyKinds.has("esm-reexport-named") || dependencyKinds.has("esm-reexport-star")) {
    tags.add("variation:barrel-reexport");
  }
  if (dependencyKinds.has("esm-reexport-star")) {
    tags.add("variation:reexport-star");
  }
  if (
    program.modules.some((module) =>
      module.dependencies.some(
        (dependency) =>
          dependency.kind === "esm-reexport-named" && dependency.sourceName === "default",
      ),
    )
  ) {
    tags.add("variation:reexport-default");
  }
  // The SAME source binding re-exported as BOTH a named alias and `default` through one module
  // (witness D2): two re-export deps (source-form or local) sharing a (target, sourceName) where one
  // exported name is `default` and another is not.
  if (
    program.modules.some((module) => {
      const aliasesBySource = new Map<string, Set<string>>();
      for (const dependency of module.dependencies) {
        if (dependency.kind !== "esm-reexport-named" && dependency.kind !== "esm-local-reexport") {
          continue;
        }
        const key = `${dependency.target}\0${dependency.sourceName}`;
        const names = aliasesBySource.get(key) ?? new Set<string>();
        names.add(dependency.exportedName);
        aliasesBySource.set(key, names);
      }
      return [...aliasesBySource.values()].some((names) => names.has("default") && names.size >= 2);
    })
  ) {
    tags.add("variation:named-and-default-alias");
  }
  // A LOCAL re-export (`import { x } from …; export { x };` — the camunda package-barrel shape, M4).
  if (dependencyKinds.has("esm-local-reexport")) {
    tags.add("variation:reexport-local");
    // The camunda breakage's full shape: the local re-export sits on a module that ALSO carries its
    // own side effect (events) — a barrel with an own effect, not a pure forwarder.
    if (
      program.modules.some(
        (module) =>
          module.events.length > 0 &&
          module.dependencies.some((dependency) => dependency.kind === "esm-local-reexport"),
      )
    ) {
      tags.add("mechanism:local-reexport-with-own-effect");
    }
  }

  // A module reaches the SAME target through more than one dependency KIND — a real multi-edge pair
  // (static + lazy, side-effect + value, require + dynamic, …), the most common shape real code writes
  // that a single edge per pair could not express. Counts DISTINCT kinds, not edge count: repeated
  // same-kind edges (two named value imports, a barrel forwarding several names) are explicitly legal
  // and are NOT a multi-kind pair (the review's finding-8 defect).
  if (
    program.modules.some((module) => {
      const kindsByTarget = new Map<string, Set<string>>();
      for (const dependency of module.dependencies) {
        const kinds = kindsByTarget.get(dependency.target) ?? new Set<string>();
        kinds.add(dependency.kind);
        kindsByTarget.set(dependency.target, kinds);
      }
      return [...kindsByTarget.values()].some((kinds) => kinds.size >= 2);
    })
  ) {
    tags.add("variation:multi-edge-pair");
  }

  const template = deriveTemplateName(program, tags, hasOverlappingEntries, esmCarriersByCjsTarget);
  if (template !== undefined) {
    tags.add(`template:${template}`);
  }

  return [...tags].sort();
}

/// A nested dynamic chain: a module that registers a dynamic import yet is itself NOT synchronously
/// reachable from any entry (so it only evaluates once an outer dynamic import fires) and IS the
/// target of a dynamic import — i.e. a dynamic import inside a dynamically-imported module. This is
/// the dense route-splitting shape wave 6 deliberately produces; before, it occurred only by rare
/// accident.
function hasNestedDynamicChain(program: ProgramModel, facts: ProgramFacts): boolean {
  const syncReachableFromEntries = new Set<string>();
  for (const entry of program.entries) {
    for (const reached of facts.closureFrom(entry.moduleId)) {
      syncReachableFromEntries.add(reached);
    }
  }
  const dynamicTargets = new Set(
    program.modules.flatMap((module) =>
      module.dependencies.flatMap((dependency) =>
        dependency.kind === "esm-dynamic-import" ? [dependency.target] : [],
      ),
    ),
  );
  return program.modules.some(
    (module) =>
      dynamicTargets.has(module.id) &&
      !syncReachableFromEntries.has(module.id) &&
      module.dependencies.some((dependency) => dependency.kind === "esm-dynamic-import"),
  );
}

/// A COMPLETE family-A conjunction (`.agents/docs/real-app-bug-families.md`), requiring ALL of the
/// documented ingredients — not merely a star path and two importers, which the old predicate accepted
/// and which certified conjunction density for cases missing the entries / sibling / split the bug
/// actually needs (the review's finding-8 defect). A barrel:
///
/// - STAR-re-exports (transitively) an inferred-pure definer (not callable-own-state, a distinct
///   wave-8 witness) — the star is load-bearing (a named re-export resolves the binding directly and
///   the bug does not fire);
/// - NAMED-re-exports a SIDE-EFFECTFUL sibling (a module that emits events), which keeps the barrel a
///   real wrapped chunk rather than an inlined pure re-exporter;
/// - is namespace-imported by >= 2 modules that BECOME ENTRIES (so it is a shared, order-wrapped chunk);
/// - with SPLIT reads across those entries: at least one entry reads the definer through the star (a
///   member the barrel does not NAMED-provide) AND at least one reads the named-provided sibling.
///
/// Purely structural, so it holds for generated, handwritten, and shrunk models alike.
function hasCompletePureDefinerConjunction(
  program: ProgramModel,
  modulesById: ReadonlyMap<string, ModuleModel>,
  plan: ExportDemandPlan,
  entryModuleIds: ReadonlySet<string>,
): boolean {
  // An inferred-pure (not callable-own-state) definer, read through the ONE ModuleProfile projection
  // rather than the raw flags — the tag deriver is a pure consumer of a module's purity/export-shape.
  const pureDefinerIds = new Set(
    program.modules
      .filter((module) => {
        const profile = moduleProfile(module);
        return (
          profile.purity.kind === "inferred" && profile.exportShape.kind !== "callable-own-state"
        );
      })
      .map((module) => module.id),
  );
  if (pureDefinerIds.size === 0) {
    return false;
  }
  // Each namespace member read THROUGH a barrel is already a consumption in the ONE plan, whose `supply`
  // is `resolveExportRoute(barrel, member)` — so the split is read from the plan instead of re-calling
  // the route resolver here. Keyed by `${barrel}\0${member}` (the route is a pure function of the pair).
  const routeByTargetName = new Map<string, ExportSupply>();
  for (const consumption of plan.consumptions) {
    routeByTargetName.set(`${consumption.target}\0${consumption.demandedName}`, consumption.supply);
  }
  for (const barrel of program.modules) {
    const entryNamespaceImporters = program.modules.filter(
      (module) =>
        entryModuleIds.has(module.id) &&
        module.dependencies.some(
          (dependency) =>
            dependency.kind === "esm-namespace-import" && dependency.target === barrel.id,
        ),
    );
    if (entryNamespaceImporters.length < 2) {
      continue;
    }
    // Resolve each entry's read members THROUGH the barrel to their GENUINE definer via the supply-aware
    // route (not a greedy first-star guess that could misattribute a consumed named/second-star member to
    // an UNUSED star path to some pure definer — the false tag this replaces). The SPLIT that makes
    // on-demand drop the definer's init: one entry reads a member that routes THROUGH A STAR to the pure
    // definer (the star is load-bearing — a named route resolves the binding directly and the bug does
    // not fire) AND one reads a member routing to a SIDE-EFFECTFUL sibling (which keeps the barrel a
    // wrapped chunk).
    const readsMemberVia = (
      wantOrigin: (originId: string) => boolean,
      requireStar: boolean,
    ): boolean =>
      entryNamespaceImporters.some((module) =>
        module.dependencies.some(
          (dependency) =>
            dependency.kind === "esm-namespace-import" &&
            dependency.target === barrel.id &&
            dependency.readMembers.some((member) => {
              const supply = routeByTargetName.get(`${barrel.id}\0${member}`);
              return (
                supply !== undefined &&
                supply.status === "supplied" &&
                wantOrigin(supply.origin.moduleId) &&
                (!requireStar || supply.hops.some((hop) => hop.via === "star"))
              );
            }),
        ),
      );
    const readsPureDefiner = readsMemberVia((originId) => pureDefinerIds.has(originId), true);
    const readsSideEffectfulSibling = readsMemberVia(
      (originId) => (modulesById.get(originId)?.events.length ?? 0) > 0,
      false,
    );
    if (readsPureDefiner && readsSideEffectfulSibling) {
      return true;
    }
  }
  return false;
}

/// A COMPLETE family-B eager-barrel conjunction (`mechanism:family-b-eager-barrel`), requiring EVERY
/// ingredient the snapshot bisection proved load-bearing (probed od-RED / wa-GREEN; removing any one
/// greens the shape):
///
/// - a package P with ARRAY (partial) `sideEffects` metadata;
/// - a metadata-pure member barrel B of P carrying a STAR re-export to a facade F (a named hop
///   resolves the binding directly and greens);
/// - B declares a local export that is CALL-marked and demanded — the included own statement (an
///   inlinable const, or nothing, greens: the delegation only happens for an INCLUDED forwarder);
/// - F: a metadata-pure member of P whose init assigns its value from a CALL of a listed member S
///   (S carries events — the package's one side-effectful module);
/// - a chunk group placing F and S together AWAY from the entry chunk: a manual group containing
///   both, or an organic group whose regex test matches both rendered package files;
/// - an ENTRY E that (a) consumes a name whose supply is F reached through B's star, (b) reads that
///   binding inside a hiddenReadFn event, (c) calls B's declared helper, and (d) side-effect-imports
///   an event-carrying non-member module at a LOWER dependency index than the facade import (source
///   order runs it before S; predicted chunk order runs S first — the deviation seed).
function hasCompleteFamilyBConjunction(
  program: ProgramModel,
  modulesById: ReadonlyMap<string, ModuleModel>,
  plan: ExportDemandPlan,
  entryModuleIds: ReadonlySet<string>,
): boolean {
  const packages = packagesOf(program);
  const metadataPure = metadataPureModuleIds(program);
  const chunking = programChunking(program);

  const splitsAcrossChunkGroup = (facade: ModuleModel, sibling: ModuleModel): boolean => {
    if (chunking.kind === "manual") {
      return chunking.groups.some(
        (group) => group.moduleIds.includes(facade.id) && group.moduleIds.includes(sibling.id),
      );
    }
    if (chunking.kind === "organic") {
      const membership = packageMembershipOf(program);
      const renderedPath = (module: ModuleModel): string | undefined => {
        const member = membership.get(module.id);
        return member === undefined
          ? undefined
          : `node_modules/${member.package.name}/${packageMemberFileName(module)}`;
      };
      const facadePath = renderedPath(facade);
      const siblingPath = renderedPath(sibling);
      if (facadePath === undefined || siblingPath === undefined) {
        return false;
      }
      return chunking.groups.some((group) => {
        if (group.test === undefined) {
          return false;
        }
        try {
          const test = new RegExp(group.test);
          return test.test(facadePath) && test.test(siblingPath);
        } catch {
          return false;
        }
      });
    }
    return false;
  };

  for (const pkg of packages) {
    if (typeof pkg.sideEffects === "boolean") {
      continue;
    }
    const members = new Set(pkg.moduleIds);
    for (const barrelId of pkg.moduleIds) {
      const barrel = modulesById.get(barrelId);
      if (barrel === undefined || barrel.format !== "esm" || !metadataPure.has(barrelId)) {
        continue;
      }
      const starTargets = barrel.dependencies.flatMap((dependency) =>
        dependency.kind === "esm-reexport-star" ? [dependency.target] : [],
      );
      if (starTargets.length === 0) {
        continue;
      }
      // The included own statement: a DECLARED local export the plan call-marked and demanded.
      const declared = barrel.localExports ?? [];
      const demandedOnBarrel = new Set(plan.requestedNames.get(barrelId) ?? []);
      const callable = plan.callableNames.get(barrelId) ?? new Set<string>();
      const hasIncludedHelper = declared.some(
        (name) => demandedOnBarrel.has(name) && callable.has(name),
      );
      if (!hasIncludedHelper) {
        continue;
      }
      for (const facadeId of starTargets) {
        const facade = modulesById.get(facadeId);
        if (facade === undefined || !members.has(facadeId) || !metadataPure.has(facadeId)) {
          continue;
        }
        // The facade's init-assigned value: a CALL import of a LISTED (side-effectful) member.
        const managerEdge = facade.dependencies.find(
          (dependency) =>
            dependency.kind === "esm-value-import" &&
            dependency.call === true &&
            members.has(dependency.target) &&
            !metadataPure.has(dependency.target) &&
            (modulesById.get(dependency.target)?.events.length ?? 0) > 0,
        );
        if (managerEdge === undefined) {
          continue;
        }
        const sibling = modulesById.get(managerEdge.target);
        if (sibling === undefined || !splitsAcrossChunkGroup(facade, sibling)) {
          continue;
        }
        // The entry: facade value through B's star, read inside a hiddenReadFn event, plus the
        // helper call and the earlier effectful side-effect import.
        for (const entryId of entryModuleIds) {
          const entry = modulesById.get(entryId);
          if (entry === undefined || entry.format !== "esm") {
            continue;
          }
          const facadeImportIndex = entry.dependencies.findIndex((dependency) => {
            if (dependency.kind !== "esm-value-import" || dependency.target !== barrelId) {
              return false;
            }
            const consumption = plan.consumptions.find(
              (record) => record.consumerModuleId === entryId && record.dependency === dependency,
            );
            return (
              consumption !== undefined &&
              consumption.supply.status === "supplied" &&
              consumption.supply.origin.moduleId === facadeId &&
              consumption.supply.hops.some((hop) => hop.via === "star" && hop.through === barrelId)
            );
          });
          if (facadeImportIndex < 0) {
            continue;
          }
          const facadeDependency = entry.dependencies[facadeImportIndex];
          if (facadeDependency === undefined || facadeDependency.kind !== "esm-value-import") {
            continue;
          }
          const facadeBinding = facadeDependency.localName;
          const hiddenRead = entry.events.some(
            (event) =>
              event.hiddenReadFn === true &&
              (event.reads ?? []).some((read) => read.binding === facadeBinding),
          );
          const callsHelper = entry.dependencies.some(
            (dependency) =>
              dependency.kind === "esm-value-import" &&
              dependency.target === barrelId &&
              dependency.call === true &&
              declared.includes(dependency.importedName),
          );
          const effectfulFirst = entry.dependencies.some(
            (dependency, index) =>
              index < facadeImportIndex &&
              dependency.kind === "esm-side-effect-import" &&
              !members.has(dependency.target) &&
              (modulesById.get(dependency.target)?.events.length ?? 0) > 0,
          );
          if (hiddenRead && callsHelper && effectfulFirst) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/// The retained-reference witness (`mechanism:package-retained-reference`, the closed #9961/#10123
/// family): a METADATA-PURE package member M whose top level references a PURE definer (metadata- or
/// inferred-pure — either way legally droppable), while M's own export is retained by a LIVE demand
/// from an event-carrying consumer. Tree-shaking that drops the definer while M's reference survives
/// is the historical dropped-binding crash; on a correct build the kept event pins the whole chain.
function hasRetainedPureReference(
  program: ProgramModel,
  modulesById: ReadonlyMap<string, ModuleModel>,
  plan: ExportDemandPlan,
): boolean {
  const metadataPure = metadataPureModuleIds(program);
  if (metadataPure.size === 0) {
    return false;
  }
  const retainedOrigins = new Set(
    plan.consumptions.flatMap((consumption) => {
      if (consumption.purpose !== "live" || consumption.supply.status !== "supplied") {
        return [];
      }
      const consumer = modulesById.get(consumption.consumerModuleId);
      return consumer !== undefined && consumer.events.length > 0
        ? [consumption.supply.origin.moduleId]
        : [];
    }),
  );
  for (const moduleId of metadataPure) {
    if (!retainedOrigins.has(moduleId)) {
      continue;
    }
    const module = modulesById.get(moduleId);
    if (module === undefined) {
      continue;
    }
    const referencesPureDefiner = module.dependencies.some((dependency) => {
      if (dependency.kind !== "esm-value-import") {
        return false;
      }
      const target = modulesById.get(dependency.target);
      return (
        target !== undefined &&
        (metadataPure.has(target.id) || moduleProfile(target).purity.kind === "inferred")
      );
    });
    if (referencesPureDefiner) {
      return true;
    }
  }
  return false;
}

function deriveTemplateName(
  program: ProgramModel,
  tags: ReadonlySet<string>,
  hasOverlappingEntries: boolean,
  esmCarriersByCjsTarget: ReadonlyMap<string, ReadonlySet<string>>,
): MixedTemplateName | undefined {
  if (programChunking(program).kind === "manual") {
    return "manual-chunk-separation";
  }
  if (program.entries.length > 1 && hasOverlappingEntries) {
    return "overlapping-entries";
  }
  if (tags.has("mechanism:cjs-requires-esm") && tags.has("mechanism:synchronous-esm")) {
    return "cjs-requires-esm";
  }
  if ([...esmCarriersByCjsTarget.values()].some((carriers) => carriers.size >= 2)) {
    return "shared-cjs-carriers";
  }
  if (tags.has("mechanism:esm-imports-cjs")) {
    return "esm-imports-cjs";
  }
  return undefined;
}

function entriesOverlap(program: ProgramModel, facts: ProgramFacts): boolean {
  const reachedByEntry = program.entries.map((entry) => facts.closureFrom(entry.moduleId));
  for (let leftIndex = 0; leftIndex < reachedByEntry.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < reachedByEntry.length; rightIndex += 1) {
      const left = reachedByEntry[leftIndex];
      const right = reachedByEntry[rightIndex];
      if (left !== undefined && right !== undefined && [...left].some((id) => right.has(id))) {
        return true;
      }
    }
  }
  return false;
}

function manualGroupsSeparateFormats(
  groups: NonNullable<ProgramModel["manualChunkGroups"]>,
  modulesById: ReadonlyMap<string, ModuleModel>,
): boolean {
  const formats = groups.map(
    (group) =>
      new Set(group.moduleIds.map((moduleId) => modulesById.get(moduleId)?.format).filter(Boolean)),
  );
  return (
    formats.some((groupFormats) => groupFormats.size === 1 && groupFormats.has("esm")) &&
    formats.some((groupFormats) => groupFormats.size === 1 && groupFormats.has("cjs"))
  );
}

/// Assert a special-role draft (inferred-pure, object-export, object-identity consumer) is ESM. These
/// are ESM-only constructs — a CJS module cannot express statement-inferred purity, a fresh-object
/// export, or an objectRef capture — so finalization ASSERTS the draft's format instead of forcing
/// `format: "esm"`, turning a future transform that mis-formats such a draft into a loud failure rather
/// than a silent sanitization the validator can no longer catch.
function assertEsmSpecialDraft(draft: RandomModuleDraft, role: string): void {
  if (draft.format !== "esm") {
    throw new Error(`${role} draft ${draft.id} must be ESM, received ${draft.format}`);
  }
}

/// Assert a draft's dependencies are all ESM-legal (no `cjs-require`) and return them typed. A draft
/// only ever accumulates format-legal kinds, so this never throws in practice; it converts a would-be
/// silent sanitization into a loud generation-time failure for a future transform that violates it.
function esmDraftDependencies(draft: RandomModuleDraft): EsmModuleModel["dependencies"] {
  for (const dependency of draft.dependencies) {
    if (dependency.kind === "cjs-require") {
      throw new Error(`ESM draft ${draft.id} carries an illegal cjs-require dependency`);
    }
  }
  return draft.dependencies as EsmModuleModel["dependencies"];
}

/// Assert a draft's dependencies are all CJS-legal (only `cjs-require` or `esm-dynamic-import`) and
/// return them typed. As with `esmDraftDependencies`, an assertion rather than a silent filter.
function cjsDraftDependencies(draft: RandomModuleDraft): CjsModuleModel["dependencies"] {
  for (const dependency of draft.dependencies) {
    if (dependency.kind !== "cjs-require" && dependency.kind !== "esm-dynamic-import") {
      throw new Error(`CJS draft ${draft.id} carries an illegal ${dependency.kind} dependency`);
    }
  }
  return draft.dependencies as CjsModuleModel["dependencies"];
}

function esmModule(
  id: string,
  dependencies: EsmModuleModel["dependencies"],
  moduleEvents: readonly EventRecord[],
): EsmModuleModel {
  return {
    id,
    format: "esm",
    dependencies,
    events: moduleEvents,
  };
}

function cjsModule(
  id: string,
  dependencies: CjsModuleModel["dependencies"],
  moduleEvents: readonly EventRecord[],
): CjsModuleModel {
  return {
    id,
    format: "cjs",
    dependencies,
    events: moduleEvents,
  };
}

function events(id: string, rng: SeededRng, count: number): readonly EventRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    module: id,
    phase: index === 0 ? "evaluate" : `evaluate-${index}`,
    value: rng.integer(1_000_000),
  }));
}

/// Fold a module's forward-only dependency reads into some of its events so cross-module data flow
/// is observed. Each event carries reads with meaningful probability, and any module with a
/// readable binding ends up with at least one folded event, keeping value-read coverage dense. The
/// event value stays a finite number (the fold base), so the emitted payload stays numeric. Reads
/// only ever reference bindings the renderer will bind, and those target strictly earlier modules,
/// so a read never closes a cycle.
function withValueReads(
  baseEvents: readonly EventRecord[],
  dependencies: readonly DependencyOperation[],
  rng: SeededRng,
): readonly EventRecord[] {
  const readable = readableBindingsOf(dependencies);
  if (readable.length === 0 || baseEvents.length === 0) {
    return baseEvents;
  }

  const pickSome = (): readonly ValueRead[] => {
    const chosen = readable.filter(() => rng.boolean());
    if (chosen.length > 0) {
      return chosen;
    }
    const fallback = readable[rng.integer(readable.length)];
    return fallback === undefined ? [] : [fallback];
  };

  const enriched = baseEvents.map((event) =>
    rng.boolean() ? { ...event, reads: pickSome() } : event,
  );
  if (!enriched.some((event) => (event.reads?.length ?? 0) > 0)) {
    const index = rng.integer(enriched.length);
    const target = enriched[index];
    if (target !== undefined) {
      enriched[index] = { ...target, reads: pickSome() };
    }
  }
  return enriched;
}

/// Rewrite some folded reads to be STATICALLY INVISIBLE (family B): a function-hidden read (the fold
/// runs inside a local function called at init — `value: base + hidden()`) and/or a computed
/// namespace member access (`ns[k]`, k built at runtime). Both keep the observed value identical
/// (deterministic, synchronous), but move the read out of direct top-level view, so a bundler that
/// decides init order from top-level uses alone can miss that the module needs its cross-chunk target
/// initialized first. Biased toward ENTRIES (family B specifically needs the entry to hide a read of
/// a cross-chunk order-wrapped target); the campaign's chunking variety supplies the cross-chunk,
/// order-wrapped targets. Applied LAST, so it only decorates events and never perturbs graph
/// structure. The family-A conjunction consumers are skipped so that proven shape stays intact.
function applyStaticallyInvisibleReads(
  rng: SeededRng,
  modules: readonly ModuleModel[],
  entryIds: ReadonlySet<string>,
  skipIds: ReadonlySet<string>,
): readonly ModuleModel[] {
  return modules.map((module) => {
    if (skipIds.has(module.id) || module.events.length === 0) {
      return module;
    }
    const namespaceBindings = new Set(
      module.dependencies.flatMap((dependency) =>
        dependency.kind === "esm-namespace-import" ? [dependency.localName] : [],
      ),
    );
    const isEntry = entryIds.has(module.id);
    let changed = false;
    const events = module.events.map((event): EventRecord => {
      if (event.reads === undefined || event.reads.length === 0) {
        return event;
      }
      let reads = event.reads;
      // Computed member access on a minority of namespace member reads (the `ns[k]` shadcn shape).
      if (namespaceBindings.size > 0) {
        const rewritten = reads.map(
          (read): ValueRead =>
            read.member !== undefined &&
            read.computed !== true &&
            namespaceBindings.has(read.binding) &&
            rng.integer(3) === 0
              ? { ...read, computed: true }
              : read,
        );
        if (rewritten.some((read, index) => read !== reads[index])) {
          reads = rewritten;
          changed = true;
        }
      }
      // Function-hidden fold: entries hide about half their folded events, others about a quarter.
      const hide = isEntry ? rng.boolean() : rng.integer(4) === 0;
      if (hide) {
        changed = true;
        return { ...event, reads, hiddenReadFn: true };
      }
      return reads === event.reads ? event : { ...event, reads };
    });
    return changed ? ({ ...module, events } as ModuleModel) : module;
  });
}
