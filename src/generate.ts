import type {
  CjsModuleModel,
  EsmDependencyOperation,
  EsmModuleModel,
  EventRecord,
  ModuleModel,
  ProgramModel,
} from "./model.ts";
import { SeededRng } from "./rng.ts";

export const MIXED_TEMPLATE_NAMES = [
  "esm-imports-cjs",
  "shared-cjs-carriers",
  "cjs-requires-esm",
  "overlapping-entries",
  "manual-chunk-separation",
] as const;

export type MixedTemplateName = (typeof MIXED_TEMPLATE_NAMES)[number];

export interface GeneratedCase {
  readonly seed: number;
  readonly size: number;
  readonly template: MixedTemplateName;
  readonly coverageTags: readonly string[];
  readonly program: ProgramModel;
}

const MAX_SIZE = 16;

export function generateCase(seed: number, size: number): GeneratedCase {
  const rng = new SeededRng(seed);
  if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE) {
    throw new Error(`size must be an integer from 1 through ${MAX_SIZE}`);
  }

  const template = rng.pick(MIXED_TEMPLATE_NAMES);
  const generated = TEMPLATE_BUILDERS[template](rng, size);
  const coverageTags = deriveCoverageTags(generated.program);
  if (!coverageTags.includes(`template:${template}`)) {
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
