import { describe, expect, test } from "vite-plus/test";

import {
  deriveCoverageTags,
  generateCase,
  MIXED_TEMPLATE_NAMES,
  type MixedTemplateName,
} from "../src/generate.ts";
import type { ModuleModel, ProgramModel } from "../src/model.ts";
import { validateProgramModel } from "../src/validate-model.ts";

describe("generateCase", () => {
  test("replays the same seed and size byte-for-byte", () => {
    const first = generateCase(0x1234_5678, 4);
    const second = generateCase(0x1234_5678, 4);

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("uses the seed to produce diverse controlled cases", () => {
    const cases = Array.from({ length: 20 }, (_, seed) => generateCase(seed, 4));
    const serialized = new Set(cases.map((generated) => JSON.stringify(generated)));

    expect(serialized.size).toBeGreaterThanOrEqual(10);
  });

  test("makes every mixed-module template reachable from ordinary seeds", () => {
    const reached = new Set<MixedTemplateName>();

    for (let seed = 0; seed < 1_000 && reached.size < MIXED_TEMPLATE_NAMES.length; seed += 1) {
      reached.add(generateCase(seed, 4).template);
    }

    expect([...reached].sort()).toEqual([...MIXED_TEMPLATE_NAMES].sort());
  });

  test("generates scheduled dynamic entries that execute through a CJS carrier", () => {
    const generated = Array.from({ length: 1_000 }, (_, seed) => generateCase(seed, 4)).find(
      (candidate) =>
        candidate.coverageTags.includes("mechanism:scheduled-dynamic-import") &&
        candidate.coverageTags.includes("mechanism:esm-imports-cjs"),
    );

    expect(generated).toBeDefined();
  });

  test("observes every generated value import", () => {
    let valueImportCount = 0;

    for (let seed = 0; seed < 1_000; seed += 1) {
      const generated = generateCase(seed, 4);
      for (const module of generated.program.modules) {
        for (const dependency of module.dependencies) {
          if (dependency.kind !== "esm-value-import") {
            continue;
          }
          valueImportCount += 1;
          expect(
            module.events.some(
              (event) => "binding" in event && event.binding === dependency.localName,
            ),
          ).toBe(true);
        }
      }
    }

    expect(valueImportCount).toBeGreaterThan(0);
  });

  test("generates internal references to wrapped entry modules", () => {
    const generated = Array.from({ length: 1_000 }, (_, seed) => generateCase(seed, 4)).find(
      (candidate) => candidate.coverageTags.includes("mechanism:internal-entry-reference"),
    );

    expect(generated).toBeDefined();
  });

  test("generates synchronous mixed-module cycles", () => {
    const generated = Array.from({ length: 1_000 }, (_, seed) => generateCase(seed, 4)).find(
      (candidate) => candidate.coverageTags.includes("mechanism:source-cycle"),
    );

    expect(generated).toBeDefined();
  });

  test("returns valid programs with template and mechanism coverage tags", () => {
    const casesByTemplate = new Map<MixedTemplateName, ReturnType<typeof generateCase>>();

    for (
      let seed = 0;
      seed < 1_000 && casesByTemplate.size < MIXED_TEMPLATE_NAMES.length;
      seed += 1
    ) {
      const generated = generateCase(seed, 4);
      casesByTemplate.set(generated.template, generated);
    }

    for (const template of MIXED_TEMPLATE_NAMES) {
      const generated = casesByTemplate.get(template);
      expect(generated, `template ${template} was not reached`).toBeDefined();
      if (generated === undefined) {
        continue;
      }

      expect(generated.coverageTags).toContain(`template:${template}`);
      expect(generated.coverageTags).toContain("mechanism:mixed-esm-cjs");
      expect(generated.coverageTags).toEqual([...generated.coverageTags].sort());
      expect(generated.coverageTags).toEqual(deriveCoverageTags(generated.program));
      assertTemplateGraph(template, generated.program);
      expect(validateProgramModel(generated.program)).toEqual([]);
    }
  });

  test("bounds size-driven variation and rejects invalid generation inputs", () => {
    const small = generateCase(42, 1);
    const large = generateCase(42, 8);

    expect(small.size).toBe(1);
    expect(large.size).toBe(8);
    expect(large.program.modules.length).toBeLessThanOrEqual(16);
    expect(large.program.modules.length).toBeGreaterThanOrEqual(small.program.modules.length);
    expect(() => generateCase(-1, 4)).toThrowError("seed must be an unsigned 32-bit integer");
    expect(() => generateCase(1, 0)).toThrowError("size must be an integer from 1 through 16");
    expect(() => generateCase(1, 17)).toThrowError("size must be an integer from 1 through 16");
  });
});

function assertTemplateGraph(template: MixedTemplateName, program: ProgramModel): void {
  const modulesById = new Map(program.modules.map((module) => [module.id, module]));

  if (template === "esm-imports-cjs") {
    expect(esmToCjsEdges(program, modulesById).length).toBeGreaterThan(0);
    return;
  }

  if (template === "shared-cjs-carriers") {
    expect(maxEsmCarrierCount(program, modulesById)).toBeGreaterThanOrEqual(2);
    return;
  }

  if (template === "cjs-requires-esm") {
    const requiredEsm = program.modules.some(
      (module) =>
        module.format === "cjs" &&
        module.dependencies.some(
          (dependency) => modulesById.get(dependency.target)?.format === "esm",
        ),
    );
    expect(requiredEsm).toBe(true);
    expect(
      program.modules.some((module) => module.format === "esm" && module.hasTopLevelAwait === true),
    ).toBe(false);
    return;
  }

  if (template === "overlapping-entries") {
    expect(program.entries.length).toBeGreaterThanOrEqual(2);
    const reachable = program.entries.map((entry) =>
      synchronouslyReachable(entry.moduleId, modulesById),
    );
    expect(intersection(reachable[0] ?? new Set(), reachable[1] ?? new Set()).size).toBeGreaterThan(
      0,
    );
    return;
  }

  if (template === "dynamic-entry-cjs-carrier") {
    expect(program.entries.length).toBeGreaterThanOrEqual(2);
    const dynamicRegistrations = new Set(
      program.modules.flatMap((module) =>
        module.dependencies
          .filter((dependency) => dependency.kind === "esm-dynamic-import")
          .map((dependency) => dependency.registration),
      ),
    );
    const dynamicTargets = program.modules.flatMap((module) =>
      module.dependencies
        .filter((dependency) => dependency.kind === "esm-dynamic-import")
        .map((dependency) => dependency.target),
    );
    expect(dynamicRegistrations.size).toBeGreaterThan(0);
    expect(
      program.schedule.some(
        (operation) =>
          operation.kind === "trigger-dynamic-import" &&
          dynamicRegistrations.has(operation.registration),
      ),
    ).toBe(true);
    const carrierIds = new Set(
      program.modules
        .filter(
          (module) =>
            module.format === "esm" &&
            module.dependencies.some(
              (dependency) => modulesById.get(dependency.target)?.format === "cjs",
            ),
        )
        .map((module) => module.id),
    );
    expect(carrierIds.size).toBeGreaterThan(0);
    expect(
      dynamicTargets.some((target) =>
        [...synchronouslyReachable(target, modulesById)].some((id) => carrierIds.has(id)),
      ),
    ).toBe(true);
    expect(
      program.entries.some((entry) =>
        [...synchronouslyReachable(entry.moduleId, modulesById)].some((id) => carrierIds.has(id)),
      ),
    ).toBe(true);
    return;
  }

  if (template === "internal-wrapped-entry-order") {
    const entryModuleIds = new Set(program.entries.map((entry) => entry.moduleId));
    expect(
      program.modules.some((module) =>
        module.dependencies.some(
          (dependency) => module.id !== dependency.target && entryModuleIds.has(dependency.target),
        ),
      ),
    ).toBe(true);
    expect(
      program.modules.some(
        (module) =>
          module.format === "cjs" &&
          module.dependencies.some(
            (dependency) => modulesById.get(dependency.target)?.format === "esm",
          ),
      ),
    ).toBe(true);
    return;
  }

  if (template === "wrapped-entry-cycle") {
    expect(hasSynchronousCycle(program, modulesById)).toBe(true);
    expect(program.manualChunkGroups?.length).toBeGreaterThanOrEqual(2);
    return;
  }

  const groups = program.manualChunkGroups ?? [];
  expect(groups.length).toBeGreaterThanOrEqual(2);
  const groupFormats = groups.map(
    (group) =>
      new Set(group.moduleIds.map((moduleId) => modulesById.get(moduleId)?.format).filter(Boolean)),
  );
  expect(groupFormats.some((formats) => formats.size === 1 && formats.has("esm"))).toBe(true);
  expect(groupFormats.some((formats) => formats.size === 1 && formats.has("cjs"))).toBe(true);
}

function esmToCjsEdges(
  program: ProgramModel,
  modulesById: ReadonlyMap<string, ModuleModel>,
): readonly string[] {
  return program.modules.flatMap((module) =>
    module.format === "esm"
      ? module.dependencies
          .filter((dependency) => modulesById.get(dependency.target)?.format === "cjs")
          .map((dependency) => `${module.id}->${dependency.target}`)
      : [],
  );
}

function maxEsmCarrierCount(
  program: ProgramModel,
  modulesById: ReadonlyMap<string, ModuleModel>,
): number {
  const carriersByTarget = new Map<string, Set<string>>();
  for (const module of program.modules) {
    if (module.format !== "esm") {
      continue;
    }
    for (const dependency of module.dependencies) {
      if (modulesById.get(dependency.target)?.format !== "cjs") {
        continue;
      }
      const carriers = carriersByTarget.get(dependency.target) ?? new Set<string>();
      carriers.add(module.id);
      carriersByTarget.set(dependency.target, carriers);
    }
  }
  return Math.max(0, ...[...carriersByTarget.values()].map((carriers) => carriers.size));
}

function synchronouslyReachable(
  rootId: string,
  modulesById: ReadonlyMap<string, ModuleModel>,
): Set<string> {
  const reached = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const moduleId = pending.pop();
    if (moduleId === undefined || reached.has(moduleId)) {
      continue;
    }
    reached.add(moduleId);
    const module = modulesById.get(moduleId);
    for (const dependency of module?.dependencies ?? []) {
      if (dependency.kind !== "esm-dynamic-import") {
        pending.push(dependency.target);
      }
    }
  }
  return reached;
}

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((value) => right.has(value)));
}

function hasSynchronousCycle(
  program: ProgramModel,
  modulesById: ReadonlyMap<string, ModuleModel>,
): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (moduleId: string): boolean => {
    if (visiting.has(moduleId)) {
      return true;
    }
    if (visited.has(moduleId)) {
      return false;
    }
    visiting.add(moduleId);
    for (const dependency of modulesById.get(moduleId)?.dependencies ?? []) {
      if (dependency.kind !== "esm-dynamic-import" && visit(dependency.target)) {
        return true;
      }
    }
    visiting.delete(moduleId);
    visited.add(moduleId);
    return false;
  };
  return program.modules.some((module) => visit(module.id));
}
