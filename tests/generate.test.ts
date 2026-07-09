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

      if (template !== "random-mixed") {
        expect(generated.coverageTags).toContain(`template:${template}`);
        expect(generated.coverageTags).toContain("mechanism:mixed-esm-cjs");
        assertTemplateGraph(template, generated.program);
      }
      expect(generated.coverageTags).toEqual([...generated.coverageTags].sort());
      expect(generated.coverageTags).toEqual(deriveCoverageTags(generated.program));
      expect(validateProgramModel(generated.program)).toEqual([]);
    }
  });

  test("generates only valid programs across many seeds and sizes", () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const generated = generateCase(seed, 1 + (seed % 16));
      expect(
        validateProgramModel(generated.program),
        `seed ${seed} produced an invalid program`,
      ).toEqual([]);
      expect(generated.program.schedule.length).toBeGreaterThan(0);
    }
  });

  test("random-mixed reaches the new mechanism coverage from ordinary seeds", () => {
    const wanted = [
      "mechanism:dynamic-import",
      "mechanism:untriggered-dynamic-import",
      "mechanism:cycle",
      "mechanism:esm-cycle",
      "mechanism:cjs-cycle",
      "mechanism:entry-also-imported",
      "mechanism:manual-chunks",
      "mechanism:multiple-entries",
    ];
    const wantedSet = new Set(wanted);
    const reached = new Set<string>();

    for (let seed = 0; seed < 5_000 && reached.size < wanted.length; seed += 1) {
      const generated = generateCase(seed, 8);
      if (generated.template !== "random-mixed") {
        continue;
      }
      for (const tag of generated.coverageTags) {
        if (wantedSet.has(tag)) {
          reached.add(tag);
        }
      }
    }

    expect(wanted.filter((tag) => !reached.has(tag))).toEqual([]);
  });

  test("random-mixed reaches value-read coverage densely", () => {
    let randomTotal = 0;
    let valueRead = 0;
    for (let seed = 0; seed < 2_000; seed += 1) {
      const generated = generateCase(seed, 8);
      if (generated.template !== "random-mixed") {
        continue;
      }
      randomTotal += 1;
      if (generated.coverageTags.includes("variation:value-read")) {
        valueRead += 1;
      }
    }

    expect(randomTotal).toBeGreaterThan(0);
    expect(valueRead).toBeGreaterThan(0);
    // Reads are emitted often enough that value-carrying coverage is dense, not incidental.
    expect(valueRead / randomTotal).toBeGreaterThan(0.3);
  });

  test("random-mixed flags a minority of sound side-effect-free value modules", () => {
    let randomTotal = 0;
    let flaggedCases = 0;
    for (let seed = 0; seed < 3_000; seed += 1) {
      const generated = generateCase(seed, 8);
      if (generated.template !== "random-mixed") {
        continue;
      }
      randomTotal += 1;
      const flaggedModules = generated.program.modules.filter(
        (module) => module.sideEffectFree === true,
      );
      if (flaggedModules.length === 0) {
        expect(generated.coverageTags).not.toContain("variation:side-effect-free-metadata");
        continue;
      }
      flaggedCases += 1;
      expect(generated.coverageTags).toContain("variation:side-effect-free-metadata");

      const valueReadTargets = new Set(
        generated.program.modules.flatMap((module) =>
          module.dependencies.flatMap((dependency) =>
            dependency.kind === "esm-value-import" ||
            (dependency.kind === "cjs-require" && dependency.resultBinding !== undefined)
              ? [dependency.target]
              : [],
          ),
        ),
      );
      const entryIds = new Set(generated.program.entries.map((entry) => entry.moduleId));
      for (const module of flaggedModules) {
        // Each flagged module is a sound value node: an ESM leaf with no events, read by someone,
        // and never an entry — however the bundler DCEs it, the event stream is unchanged.
        expect(module.format, `seed ${seed}: flagged ${module.id} not ESM`).toBe("esm");
        expect(module.events, `seed ${seed}: flagged ${module.id} emits events`).toEqual([]);
        expect(module.dependencies, `seed ${seed}: flagged ${module.id} is not a leaf`).toEqual([]);
        expect(valueReadTargets.has(module.id), `seed ${seed}: flagged ${module.id} unread`).toBe(
          true,
        );
        expect(entryIds.has(module.id), `seed ${seed}: flagged ${module.id} is an entry`).toBe(
          false,
        );
      }
      expect(flaggedModules.length).toBeLessThan(generated.program.modules.length);
      expect(validateProgramModel(generated.program)).toEqual([]);
    }

    expect(randomTotal).toBeGreaterThan(0);
    // A meaningful minority of random-mixed cases carry the metadata, not almost none and not most.
    const density = flaggedCases / randomTotal;
    expect(density).toBeGreaterThan(0.05);
    expect(density).toBeLessThan(0.5);
  });

  test("value reads never target a module on a cycle", () => {
    for (let seed = 0; seed < 2_000; seed += 1) {
      const generated = generateCase(seed, 8);
      const onCycle = cycleMembers(generated.program);
      if (onCycle.size === 0) {
        continue;
      }
      for (const module of generated.program.modules) {
        for (const dependency of module.dependencies) {
          const readsTarget =
            dependency.kind === "esm-value-import" ||
            (dependency.kind === "cjs-require" && dependency.resultBinding !== undefined);
          if (readsTarget) {
            expect(
              onCycle.has(dependency.target),
              `seed ${seed}: readable dependency targets cycle member ${dependency.target}`,
            ).toBe(false);
          }
        }
      }
    }
  });

  test("random-mixed never closes a cycle across module formats", () => {
    for (let seed = 0; seed < 2_000; seed += 1) {
      const generated = generateCase(seed, 8);
      if (
        generated.template !== "random-mixed" ||
        !generated.coverageTags.includes("mechanism:cycle")
      ) {
        continue;
      }
      expect(
        generated.coverageTags.includes("mechanism:esm-cycle") ||
          generated.coverageTags.includes("mechanism:cjs-cycle"),
        `seed ${seed} produced a mixed-format cycle`,
      ).toBe(true);
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

function cycleMembers(program: ProgramModel): Set<string> {
  const modulesById = new Map(program.modules.map((module) => [module.id, module]));
  const members = new Set<string>();
  for (const module of program.modules) {
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
        members.add(module.id);
        break;
      }
      for (const dependency of modulesById.get(moduleId)?.dependencies ?? []) {
        if (dependency.kind !== "esm-dynamic-import") {
          pending.push(dependency.target);
        }
      }
    }
  }
  return members;
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

describe("format regimes", () => {
  test("forced pure regimes produce single-format valid programs on the random generator", () => {
    for (const [regime, format] of [
      ["pure-esm", "esm"],
      ["pure-cjs", "cjs"],
    ] as const) {
      for (let seed = 0; seed < 50; seed += 1) {
        const generated = generateCase(seed, 6, regime);
        expect(generated.template).toBe("random-mixed");
        expect(validateProgramModel(generated.program)).toEqual([]);
        expect(generated.program.modules.every((module) => module.format === format)).toBe(true);
        expect(generated.coverageTags).toContain(`regime:${regime}`);
      }
    }
  });

  test("unforced seeds reach all three regimes on the random generator", () => {
    const reached = new Set<string>();
    for (let seed = 0; seed < 2_000 && reached.size < 3; seed += 1) {
      const generated = generateCase(seed, 6);
      if (generated.template !== "random-mixed") {
        continue;
      }
      const tag = generated.coverageTags.find((candidate) => candidate.startsWith("regime:"));
      if (tag !== undefined) {
        reached.add(tag);
      }
    }
    expect([...reached].sort()).toEqual(["regime:mixed", "regime:pure-cjs", "regime:pure-esm"]);
  });

  test("CJS modules can register dynamic imports, including in pure-cjs programs", () => {
    let sawCjsDynamic = false;
    let sawPureCjsDynamic = false;
    for (let seed = 0; seed < 2_000 && !(sawCjsDynamic && sawPureCjsDynamic); seed += 1) {
      const generated = generateCase(seed, 8);
      if (generated.template !== "random-mixed") {
        continue;
      }
      expect(validateProgramModel(generated.program)).toEqual([]);
      if (!generated.coverageTags.includes("mechanism:cjs-dynamic-import")) {
        continue;
      }
      sawCjsDynamic = true;
      if (generated.coverageTags.includes("regime:pure-cjs")) {
        sawPureCjsDynamic = true;
      }
    }
    expect(sawCjsDynamic).toBe(true);
    expect(sawPureCjsDynamic).toBe(true);
  });
});
