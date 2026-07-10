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
  ProgramModel,
  ScheduleOperation,
  ValueRead,
} from "./model.ts";
import { readableBindingsOf } from "./model.ts";
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

export const MAX_CASE_SIZE = 16;

/// Upper bound on modules in a random-mixed program (DAG + optional cycle cluster + inserted
/// barrels), so a case's rendered graph stays small enough to build and execute quickly. The DAG
/// caps at 11; the cycle cluster (base ring + optional interlocking sub-cycle) is sized within
/// `MAX_RANDOM_MODULES - dagCount - 2`, reserving two slots for barrel modules.
const MAX_RANDOM_MODULES = 16;

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
  const dagCount = Math.min(3 + rng.integer(size + 1), 11);
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
  // `allowRead` gates value edges (readable requires and value imports). It is false only for the
  // single edge into a cycle ring's head, so no readable binding ever targets a ring member and no
  // read crosses into a cycle: value edges stay forward-only, rings keep side-effect/require edges.
  const addDependency = (
    importer: RandomModuleDraft,
    target: RandomModuleDraft,
    allowRead = true,
  ) => {
    const edgeKey = dependencyKey(importer, target.id);
    if (usedEdges.has(edgeKey)) {
      return;
    }
    usedEdges.add(edgeKey);
    if (importer.format === "cjs") {
      if (rng.integer(4) === 0) {
        const registration = `dyn-${importer.id}-${target.id}`;
        importer.dependencies.push({
          kind: "esm-dynamic-import",
          target: target.id,
          registration,
        });
        registrations.push({ owner: importer.id, registration });
      } else if (allowRead && rng.boolean()) {
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
    const roll = rng.integer(6);
    if (roll < 3 || (!allowRead && roll < 5)) {
      importer.dependencies.push({ kind: "esm-side-effect-import", target: target.id });
    } else if (roll < 5) {
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
  drafts.push(...insertBarrelChains(rng, drafts));

  // Turn a meaningful minority of forward pairs into real multi-kind pairs — `import { a } from "./x"`
  // AND `import("./x")` (static + lazy), a side-effect plus a value import of one module, and the
  // like — after barrels so an augmented value edge is never rerouted through one.
  augmentMultiEdgePairs(rng, drafts, registrations);

  const modules = drafts.map((draft): ModuleModel => {
    // A draft only ever accumulates dependency kinds legal for its format, so the filters below are
    // defensive; the reads are chosen from the same forward-only bindings the renderer will fold.
    // A barrel (a pure re-exporter) emits no events — it only forwards a value onward.
    const isBarrel = draft.dependencies.some(isReexportDependency);
    const moduleEvents = isBarrel
      ? []
      : withValueReads(events(draft.id, rng, 1 + rng.integer(2)), draft.dependencies, rng);
    return draft.format === "esm"
      ? esmModule(
          draft.id,
          draft.dependencies.filter((dependency) => dependency.kind !== "cjs-require"),
          moduleEvents,
        )
      : cjsModule(
          draft.id,
          draft.dependencies.filter(
            (dependency) =>
              dependency.kind === "cjs-require" || dependency.kind === "esm-dynamic-import",
          ),
          moduleEvents,
        );
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
  const entries = [...entryIndices]
    .map((index) => drafts[index])
    .filter((draft) => draft !== undefined)
    .map((draft) => ({ name: `entry-${draft.id}`, moduleId: draft.id }));

  const schedule = buildRandomSchedule(rng, modules, entries, registrations);

  const manualChunkGroups = buildRandomManualGroups(rng, drafts, cycleMemberIds);

  // Flag a minority of eligible modules with `sideEffects: false` package metadata. Flagged modules
  // emit no events (their events are stripped), so the bundler's legal DCE cannot silently drop an
  // observed side effect; only their folded value survives downstream. The rolls come last so the
  // rest of a given seed's structure is unchanged.
  const flagged = chooseSideEffectFreeModules(rng, modules, entries);
  const finalModules =
    flagged.size === 0
      ? modules
      : modules.map(
          (module): ModuleModel =>
            flagged.has(module.id) ? { ...module, events: [], sideEffectFree: true } : module,
        );

  return {
    program: {
      modules: finalModules,
      entries,
      schedule,
      ...(manualChunkGroups.length > 0 ? { manualChunkGroups } : {}),
    },
  };
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
      }
      const head = chain[0];
      if (head !== undefined) {
        importer.dependencies[dependencyIndex] = { ...dependency, target: head.id };
        barrels.push(...chain);
      }
    }
  }
  return barrels;
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

/// Synchronous (non-dynamic) reachability over drafts, for the forward-only augmentation gate.
function draftSyncReachability(
  drafts: readonly RandomModuleDraft[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const draftsById = new Map(drafts.map((draft) => [draft.id, draft]));
  const reachability = new Map<string, ReadonlySet<string>>();
  for (const start of draftsById.keys()) {
    const reached = new Set<string>();
    const pending = [start];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) {
        continue;
      }
      for (const dependency of draftsById.get(id)?.dependencies ?? []) {
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
  const reach = draftSyncReachability(drafts);

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
        reach.get(targetId)?.has(importer.id) === true
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
        tags.add(
          dependency.kind === "esm-value-import"
            ? "variation:value-import"
            : "variation:side-effect-import",
        );
        const carriers = esmCarriersByCjsTarget.get(target.id) ?? new Set<string>();
        carriers.add(module.id);
        esmCarriersByCjsTarget.set(target.id, carriers);
      } else if (
        module.format === "cjs" &&
        dependency.kind === "cjs-require" &&
        target?.format === "esm"
      ) {
        tags.add("mechanism:cjs-requires-esm");
        if (!reachesTopLevelAwait(target.id, modulesById)) {
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

  const hasOverlappingEntries = entriesOverlap(program, modulesById);
  if (program.entries.length > 1) {
    tags.add("mechanism:multiple-entries");
  }
  if (hasOverlappingEntries) {
    tags.add("mechanism:overlapping-dependencies");
  }

  const groups = program.manualChunkGroups ?? [];
  if (groups.length > 0) {
    tags.add("mechanism:manual-chunks");
  }
  if (manualGroupsSeparateFormats(groups, modulesById)) {
    tags.add("mechanism:separate-interop");
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
  }

  const dependencyTargets = new Set(
    program.modules.flatMap((module) => module.dependencies.map((dependency) => dependency.target)),
  );
  if (program.entries.some((entry) => dependencyTargets.has(entry.moduleId))) {
    tags.add("mechanism:entry-also-imported");
  }

  const cycles = analyzeCycles(modulesById);
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
    // A value read folded across a cycle edge (a hoisted-function call or a guarded partial read) —
    // cycle data flow, not just cycle side-effect ordering.
    const cycleReads = program.modules.flatMap((module) =>
      module.events.flatMap((event) => event.reads ?? []),
    );
    if (cycleReads.some((read) => read.call === true || read.guard === true)) {
      tags.add("mechanism:cycle-value-read");
    }
    if (cycleReads.some((read) => read.call === true)) {
      tags.add("variation:cycle-hoisted-call");
    }
    if (cycleReads.some((read) => read.guard === true)) {
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

  // Namespace imports (`import * as ns`) with a folded member read exercise the namespace-shape
  // interop surface; re-export (barrel) chains forward a value several hops from its definer.
  const dependencyKinds = new Set(
    program.modules.flatMap((module) => module.dependencies.map((dependency) => dependency.kind)),
  );
  if (dependencyKinds.has("esm-namespace-import")) {
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

  // A module reaches the SAME target through more than one dependency kind — a real multi-edge pair
  // (static + lazy, side-effect + value, require + dynamic, …), the most common shape real code
  // writes that a single edge per pair could not express.
  if (
    program.modules.some((module) => {
      const perTarget = new Map<string, number>();
      for (const dependency of module.dependencies) {
        perTarget.set(dependency.target, (perTarget.get(dependency.target) ?? 0) + 1);
      }
      return [...perTarget.values()].some((count) => count >= 2);
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

function entriesOverlap(
  program: ProgramModel,
  modulesById: ReadonlyMap<string, ModuleModel>,
): boolean {
  const reachedByEntry = program.entries.map((entry) =>
    synchronouslyReachable(entry.moduleId, modulesById),
  );
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

function synchronouslyReachable(
  rootId: string,
  modulesById: ReadonlyMap<string, ModuleModel>,
): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const moduleId = pending.pop();
    if (moduleId === undefined || reached.has(moduleId)) {
      continue;
    }
    reached.add(moduleId);
    for (const dependency of modulesById.get(moduleId)?.dependencies ?? []) {
      if (dependency.kind !== "esm-dynamic-import") {
        pending.push(dependency.target);
      }
    }
  }
  return reached;
}

function reachesTopLevelAwait(
  rootId: string,
  modulesById: ReadonlyMap<string, ModuleModel>,
): boolean {
  return [...synchronouslyReachable(rootId, modulesById)].some(
    (moduleId) =>
      modulesById.get(moduleId)?.format === "esm" &&
      modulesById.get(moduleId)?.hasTopLevelAwait === true,
  );
}

interface CycleAnalysis {
  /// Every module sitting on a synchronous (non-dynamic) cycle.
  readonly cyclicMembers: ReadonlySet<string>;
  /// The strongly connected components of size >= 2 (each a distinct cyclic cluster).
  readonly sccs: readonly (readonly string[])[];
  /// Formats present among cyclic members (single-format cycles keep this size 1).
  readonly formats: ReadonlySet<ModuleFormat>;
  /// A cluster with more internal edges than a bare ring needs (a chord), and no shared hub.
  readonly hasChord: boolean;
  /// A cluster with a shared hub node (internal in-degree >= 2 and out-degree >= 2) joining two
  /// cycles — a figure-eight of interlocking cycles.
  readonly hasInterlocking: boolean;
  /// A cluster entered by external synchronous edges at two or more distinct members.
  readonly hasMultiEnter: boolean;
}

/// Synchronous (non-dynamic) reachability from each module, for cycle analysis.
function synchronousReachability(
  modulesById: ReadonlyMap<string, ModuleModel>,
): Map<string, Set<string>> {
  const reachability = new Map<string, Set<string>>();
  for (const start of modulesById.keys()) {
    const reached = new Set<string>();
    const pending = [start];
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

/// Analyze the synchronous cycle structure: which modules are on a cycle, their clusters (SCCs), and
/// the richer topologies (chord, interlocking figure-eight, multiple entry members). Two modules
/// share a cluster when each synchronously reaches the other; a module is cyclic when it reaches
/// itself through at least one edge.
function analyzeCycles(modulesById: ReadonlyMap<string, ModuleModel>): CycleAnalysis {
  const reach = synchronousReachability(modulesById);
  const syncTargets = (id: string): string[] =>
    (modulesById.get(id)?.dependencies ?? []).flatMap((dependency) =>
      dependency.kind === "esm-dynamic-import" ? [] : [dependency.target],
    );

  const cyclicMembers = new Set<string>();
  for (const id of modulesById.keys()) {
    if (syncTargets(id).some((target) => reach.get(target)?.has(id) === true)) {
      cyclicMembers.add(id);
    }
  }

  // Group cyclic members into clusters by mutual reachability.
  const sccs: string[][] = [];
  const assigned = new Set<string>();
  for (const id of cyclicMembers) {
    if (assigned.has(id)) {
      continue;
    }
    const cluster = [...cyclicMembers].filter(
      (other) => reach.get(id)?.has(other) === true && reach.get(other)?.has(id) === true,
    );
    cluster.push(id);
    const unique = [...new Set(cluster)];
    for (const member of unique) {
      assigned.add(member);
    }
    sccs.push(unique);
  }

  const formats = new Set<ModuleFormat>();
  for (const id of cyclicMembers) {
    const format = modulesById.get(id)?.format;
    if (format !== undefined) {
      formats.add(format);
    }
  }

  let hasChord = false;
  let hasInterlocking = false;
  let hasMultiEnter = false;
  for (const scc of sccs) {
    const members = new Set(scc);
    let internalEdges = 0;
    const internalOut = new Map<string, Set<string>>(scc.map((id) => [id, new Set<string>()]));
    const internalIn = new Map<string, Set<string>>(scc.map((id) => [id, new Set<string>()]));
    for (const id of scc) {
      for (const target of syncTargets(id)) {
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
    for (const [id, module] of modulesById) {
      if (members.has(id)) {
        continue;
      }
      for (const target of (module.dependencies ?? []).flatMap((dependency) =>
        dependency.kind === "esm-dynamic-import" ? [] : [dependency.target],
      )) {
        if (members.has(target)) {
          enteringMembers.add(target);
        }
      }
    }
    if (enteringMembers.size >= 2) {
      hasMultiEnter = true;
    }
  }

  return { cyclicMembers, sccs, formats, hasChord, hasInterlocking, hasMultiEnter };
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
