import type {
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
  ProgramModel,
  ScheduleOperation,
  ValueRead,
} from "./model.ts";
import { programChunking, readableBindingsOf } from "./model.ts";
import { ProgramFacts } from "./program-facts.ts";
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
  const generated =
    template === "random-mixed"
      ? buildRandomMixed(rng, size, forcedRegime)
      : TEMPLATE_BUILDERS[template](rng, size);
  const coverageTags = deriveCoverageTags(generated.program);
  // `template:*` tags stay purely structural; only fixed templates promise their own shape.
  if (template !== "random-mixed" && !coverageTags.includes(`template:${template}`)) {
    throw new Error(`Generated ${template} program does not match its template`);
  }

  return {
    seed,
    size,
    template,
    coverageTags,
    program: generated.program,
  };
}

interface TemplateResult {
  readonly program: ProgramModel;
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
      manualChunkGroups: [
        { name: "carriers", moduleIds: carriers.map((carrier) => carrier.id) },
        { name: "interop", moduleIds: interopModules.map((module) => module.id) },
      ],
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
  // real-app shape a green 25,000-case corpus missed. Self-contained clusters, appended last.
  const conjunctionDrafts = injectPureDefinerConjunctions(rng, drafts, regime);
  drafts.push(...conjunctionDrafts);
  const conjunctionConsumerIds = new Set(
    conjunctionDrafts.filter((draft) => draft.forceEntry === true).map((draft) => draft.id),
  );

  // Witness-enrichment clusters (wave 8), appended after the conjunctions so the conjunction density is
  // unchanged: a callable-reads-own-state cluster (the d3-scale/shadcn read-side ingredient for family
  // B) and an object-identity cluster (a silent double-init witness numbers cannot see). Their entry
  // consumers are NOT skipped in applyStaticallyInvisibleReads — the callable calls are meant to be
  // hidden, and the identity events carry no folded reads to hide.
  drafts.push(...injectCallableOwnStateClusters(rng, drafts, regime));
  drafts.push(...injectObjectIdentityClusters(rng, drafts, regime));

  const modules = drafts.map((draft): ModuleModel => {
    // Finalization ASSERTS a draft's dependencies are already legal for its format rather than silently
    // filtering illegal kinds away — a bad future transform then fails loudly at generation instead of
    // being sanitized before the validator can catch it. The reads are chosen from the same
    // forward-only bindings the renderer will fold.
    // An inferred-pure definer emits NO events (an event would make its top level impure) and carries
    // its build-function base; a barrel (a pure re-exporter) emits no events — it only forwards.
    if (draft.inferredPure === true) {
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
      return { id: draft.id, format: "esm", dependencies: [], events: [], objectExport: true };
    }
    // An object-identity consumer (Task 3): its objectRef imports capture the same object export
    // through two paths; a single event compares them for identity. objectRef bindings are never
    // folded numerically, so this event carries no `reads`.
    if (draft.identityCheck !== undefined) {
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

  const schedule = buildRandomSchedule(rng, modules, entries, registrations);

  const chunking = buildChunkingConfig(rng, drafts, cycleMemberIds, entries.length);

  // Flag a minority of eligible modules with `sideEffects: false` package metadata. Flagged modules
  // emit no events (their events are stripped), so the bundler's legal DCE cannot silently drop an
  // observed side effect; only their folded value survives downstream. The rolls come last so the
  // rest of a given seed's structure is unchanged.
  const flagged = chooseSideEffectFreeModules(rng, modules, entries);
  const flaggedModules =
    flagged.size === 0
      ? modules
      : modules.map(
          (module): ModuleModel =>
            flagged.has(module.id) ? { ...module, events: [], sideEffectFree: true } : module,
        );

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

  return {
    program: {
      modules: finalModules,
      entries,
      schedule,
      ...(chunking.manualChunkGroups !== undefined
        ? { manualChunkGroups: chunking.manualChunkGroups }
        : {}),
      ...(chunking.organicChunkGroups !== undefined
        ? { organicChunkGroups: chunking.organicChunkGroups }
        : {}),
    },
  };
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
): RandomModuleDraft[] {
  return injectCluster(rng, drafts, regime, {
    minBudget: 5,
    probabilityPercent: 22,
    build: (rng, counter, budget) => buildPureDefinerConjunction(rng, counter, budget),
  });
}

function buildPureDefinerConjunction(
  rng: SeededRng,
  counter: number,
  budget: number,
): RandomModuleDraft[] {
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

  return [definer, sibling, ...barrels, consumerA, consumerB];
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
  const eligible = modules.filter(
    (module) =>
      module.format === "esm" &&
      module.inferredPure !== true &&
      // The wave-8 witness definers carry their own export rendering and must not be flagged: an
      // objectExport must not be sideEffectFree (a dropped object export defeats the identity witness),
      // and a callable-own-state definer's state must not be stripped.
      module.objectExport !== true &&
      module.callableOwnState !== true &&
      module.dependencies.length === 0 &&
      !entryIds.has(module.id) &&
      valueReadTargets.has(module.id),
  );
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

export function deriveCoverageTags(program: ProgramModel): readonly string[] {
  const tags = new Set<string>();
  const modulesById = new Map(program.modules.map((module) => [module.id, module]));
  const facts = ProgramFacts.from(program.modules);
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
    if (cycles.formats.size === 1 && cycles.formats.has("esm")) {
      tags.add("mechanism:esm-cycle");
    }
    if (cycles.formats.size === 1 && cycles.formats.has("cjs")) {
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
    for (const group of program.manualChunkGroups ?? []) {
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

  // A module carries `sideEffects: false` package metadata: the primary dead-code-elimination
  // versus execution-order trigger. Flagged modules emit no events and contribute only values.
  if (program.modules.some((module) => module.sideEffectFree === true)) {
    tags.add("variation:side-effect-free-metadata");
  }

  // Family A/B mechanisms (`.agents/docs/real-app-bug-families.md`). An inferred-pure definer (judged
  // side-effect-free by STATEMENT inference, not a package flag); a function-hidden read (a folded
  // read run inside a local function called at init); a computed namespace member access (`ns[k]`).
  if (program.modules.some((module) => module.inferredPure === true)) {
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
  if (program.modules.some((module) => module.callableOwnState === true)) {
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
  if (hasCompletePureDefinerConjunction(program, modulesById, facts, entryModuleIds)) {
    tags.add("mechanism:pure-definer-behind-barrel");
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
  facts: ProgramFacts,
  entryModuleIds: ReadonlySet<string>,
): boolean {
  const pureDefinerIds = new Set(
    program.modules
      .filter((module) => module.inferredPure === true && module.callableOwnState !== true)
      .map((module) => module.id),
  );
  if (pureDefinerIds.size === 0) {
    return false;
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
              const supply = facts.resolveExportRoute(barrel.id, member);
              return (
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

function deriveTemplateName(
  program: ProgramModel,
  tags: ReadonlySet<string>,
  hasOverlappingEntries: boolean,
  esmCarriersByCjsTarget: ReadonlyMap<string, ReadonlySet<string>>,
): MixedTemplateName | undefined {
  if ((program.manualChunkGroups?.length ?? 0) > 0) {
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
