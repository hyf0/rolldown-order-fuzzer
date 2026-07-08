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
} from "./model.ts";
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

export interface GeneratedCase {
  readonly seed: number;
  readonly size: number;
  readonly template: MixedTemplateName;
  readonly coverageTags: readonly string[];
  readonly program: ProgramModel;
}

export const MAX_CASE_SIZE = 16;

export function generateCase(seed: number, size: number): GeneratedCase {
  const rng = new SeededRng(seed);
  if (!Number.isInteger(size) || size < 1 || size > MAX_CASE_SIZE) {
    throw new Error(`size must be an integer from 1 through ${MAX_CASE_SIZE}`);
  }

  // Half the campaign explores random graphs; the other half keeps the audited fixed shapes.
  const template = rng.boolean() ? "random-mixed" : rng.pick(FIXED_TEMPLATE_NAMES);
  const generated = TEMPLATE_BUILDERS[template](rng, size);
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
function buildRandomMixed(rng: SeededRng, size: number): TemplateResult {
  const dagCount = Math.min(3 + rng.integer(size + 1), 11);
  const ringCount = rng.integer(4) === 0 ? 2 + rng.integer(2) : 0;
  const drafts: RandomModuleDraft[] = Array.from({ length: dagCount }, (_, index) => ({
    id: `m${index}`,
    // Two thirds ESM keeps interop pairs frequent without starving pure-ESM shapes.
    format: rng.integer(3) < 2 ? "esm" : "cjs",
    dependencies: [],
  }));

  const dependencyKey = (importer: RandomModuleDraft, targetId: string) =>
    `${importer.id}->${targetId}`;
  const usedEdges = new Set<string>();
  const registrations: { owner: string; registration: string }[] = [];
  const addDependency = (importer: RandomModuleDraft, target: RandomModuleDraft) => {
    const edgeKey = dependencyKey(importer, target.id);
    if (usedEdges.has(edgeKey)) {
      return;
    }
    usedEdges.add(edgeKey);
    if (importer.format === "cjs") {
      importer.dependencies.push({ kind: "cjs-require", target: target.id });
      return;
    }
    const roll = rng.integer(6);
    if (roll < 3) {
      importer.dependencies.push({ kind: "esm-side-effect-import", target: target.id });
    } else if (roll < 5) {
      importer.dependencies.push({
        kind: "esm-value-import",
        target: target.id,
        importedName: `v${target.id}`,
        localName: `${importer.id}_v${target.id}`,
      });
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

  if (ringCount > 0) {
    const ringFormat: ModuleFormat = rng.boolean() ? "esm" : "cjs";
    const ring: RandomModuleDraft[] = Array.from({ length: ringCount }, (_, index) => ({
      id: `ring${index}`,
      format: ringFormat,
      dependencies: [],
    }));
    for (const [index, member] of ring.entries()) {
      const next = ring[(index + 1) % ringCount];
      if (next !== undefined) {
        member.dependencies.push(
          ringFormat === "cjs"
            ? { kind: "cjs-require", target: next.id }
            : { kind: "esm-side-effect-import", target: next.id },
        );
      }
    }
    const head = ring[0];
    const carrier = drafts[rng.integer(dagCount)];
    if (head !== undefined && carrier !== undefined) {
      addDependency(carrier, head);
    }
    drafts.push(...ring);
  }

  const modules = drafts.map(
    (draft): ModuleModel =>
      draft.format === "esm"
        ? esmModule(
            draft.id,
            draft.dependencies.filter((dependency) => dependency.kind !== "cjs-require"),
            events(draft.id, rng, 1 + rng.integer(2)),
          )
        : cjsModule(
            draft.id,
            draft.dependencies.filter((dependency) => dependency.kind === "cjs-require"),
            events(draft.id, rng, 1 + rng.integer(2)),
          ),
  );

  // Module 0 anchors the schedule; extra entries may be modules other modules also import,
  // which exercises entry facades and shared entry chunks.
  const entryIndices = new Set([0]);
  for (let extra = rng.integer(3); extra > 0; extra -= 1) {
    entryIndices.add(rng.integer(drafts.length));
  }
  const entries = [...entryIndices]
    .map((index) => drafts[index])
    .filter((draft) => draft !== undefined)
    .map((draft) => ({ name: `entry-${draft.id}`, moduleId: draft.id }));

  const schedule = buildRandomSchedule(rng, modules, entries, registrations);

  const manualChunkGroups = buildRandomManualGroups(rng, drafts);

  return {
    program: {
      modules,
      entries,
      schedule,
      ...(manualChunkGroups.length > 0 ? { manualChunkGroups } : {}),
    },
  };
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

function buildRandomManualGroups(
  rng: SeededRng,
  drafts: readonly RandomModuleDraft[],
): ManualChunkGroup[] {
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
  }

  for (const module of program.modules) {
    for (const dependency of module.dependencies) {
      const target = modulesById.get(dependency.target);
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

  const cycleFormats = syncCycleFormats(modulesById);
  if (cycleFormats.size > 0) {
    tags.add("mechanism:cycle");
    if (cycleFormats.size === 1 && cycleFormats.has("esm")) {
      tags.add("mechanism:esm-cycle");
    }
    if (cycleFormats.size === 1 && cycleFormats.has("cjs")) {
      tags.add("mechanism:cjs-cycle");
    }
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

/// Formats of every module sitting on a cycle of synchronous (non-dynamic) dependencies.
function syncCycleFormats(modulesById: ReadonlyMap<string, ModuleModel>): Set<ModuleFormat> {
  const formats = new Set<ModuleFormat>();
  for (const module of modulesById.values()) {
    const pending = module.dependencies.flatMap((dependency) =>
      dependency.kind === "esm-dynamic-import" ? [] : [dependency.target],
    );
    const visited = new Set<string>();
    while (pending.length > 0) {
      const moduleId = pending.pop();
      if (moduleId === undefined || visited.has(moduleId)) {
        continue;
      }
      visited.add(moduleId);
      if (moduleId === module.id) {
        formats.add(module.format);
        break;
      }
      for (const dependency of modulesById.get(moduleId)?.dependencies ?? []) {
        if (dependency.kind !== "esm-dynamic-import") {
          pending.push(dependency.target);
        }
      }
    }
  }
  return formats;
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
