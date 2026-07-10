import { describe, expect, test } from "vite-plus/test";

import {
  deriveCoverageTags,
  generateCase,
  MAX_CASE_SIZE,
  MIXED_TEMPLATE_NAMES,
  sampleCaseSize,
  type MixedTemplateName,
} from "../src/generate.ts";
import type { ModuleModel, ProgramModel } from "../src/model.ts";
import { SeededRng } from "../src/rng.ts";
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

  test("random-mixed reaches namespace-read and barrel-reexport coverage densely", () => {
    let randomTotal = 0;
    let namespaceRead = 0;
    let barrelReexport = 0;
    for (let seed = 0; seed < 3_000; seed += 1) {
      const generated = generateCase(seed, 8);
      if (generated.template !== "random-mixed") {
        continue;
      }
      randomTotal += 1;
      if (generated.coverageTags.includes("variation:namespace-read")) {
        namespaceRead += 1;
      }
      if (generated.coverageTags.includes("variation:barrel-reexport")) {
        barrelReexport += 1;
      }
    }

    expect(randomTotal).toBeGreaterThan(0);
    // Both wave-3 mechanisms are dense enough to matter across a campaign, not incidental.
    expect(namespaceRead / randomTotal).toBeGreaterThan(0.1);
    expect(barrelReexport / randomTotal).toBeGreaterThan(0.05);
  });

  test("generated namespace imports only target ESM modules (CJS namespaces are deferred)", () => {
    for (let seed = 0; seed < 3_000; seed += 1) {
      const generated = generateCase(seed, 8);
      const modulesById = new Map(generated.program.modules.map((module) => [module.id, module]));
      for (const module of generated.program.modules) {
        for (const dependency of module.dependencies) {
          if (dependency.kind === "esm-namespace-import") {
            expect(
              modulesById.get(dependency.target)?.format,
              `seed ${seed}: namespace import targets non-ESM ${dependency.target}`,
            ).toBe("esm");
          }
        }
      }
    }
  });

  test("generated barrels are pure re-exporter ESM modules with no events, forwarding an ESM definer", () => {
    let sawBarrel = false;
    for (let seed = 0; seed < 3_000; seed += 1) {
      const generated = generateCase(seed, 8);
      const modulesById = new Map(generated.program.modules.map((module) => [module.id, module]));
      for (const module of generated.program.modules) {
        const reexports = module.dependencies.filter(
          (dependency) =>
            dependency.kind === "esm-reexport-named" || dependency.kind === "esm-reexport-star",
        );
        if (reexports.length === 0) {
          continue;
        }
        sawBarrel = true;
        // A barrel is a pure ESM re-exporter: ESM, no events, only re-export dependencies.
        expect(module.format, `seed ${seed}: barrel ${module.id} not ESM`).toBe("esm");
        expect(module.events, `seed ${seed}: barrel ${module.id} emits events`).toEqual([]);
        expect(
          module.dependencies.length,
          `seed ${seed}: barrel ${module.id} carries non-re-export deps`,
        ).toBe(reexports.length);
        // Every hop forwards to another ESM module (an all-ESM chain), never a CJS target.
        for (const dependency of reexports) {
          expect(
            modulesById.get(dependency.target)?.format,
            `seed ${seed}: barrel ${module.id} forwards non-ESM ${dependency.target}`,
          ).toBe("esm");
        }
      }
      expect(validateProgramModel(generated.program)).toEqual([]);
    }
    expect(sawBarrel).toBe(true);
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

  test("random-mixed reaches multi-edge-pair coverage densely with valid programs", () => {
    let randomTotal = 0;
    let multiEdge = 0;
    let sawStaticPlusDynamic = false;
    for (let seed = 0; seed < 3_000; seed += 1) {
      const generated = generateCase(seed, 8);
      if (generated.template !== "random-mixed") {
        continue;
      }
      randomTotal += 1;
      if (!generated.coverageTags.includes("variation:multi-edge-pair")) {
        continue;
      }
      multiEdge += 1;
      expect(validateProgramModel(generated.program), `seed ${seed}`).toEqual([]);
      for (const module of generated.program.modules) {
        const kindsByTarget = new Map<string, string[]>();
        for (const dependency of module.dependencies) {
          const kinds = kindsByTarget.get(dependency.target) ?? [];
          kinds.push(dependency.kind);
          kindsByTarget.set(dependency.target, kinds);
        }
        for (const kinds of kindsByTarget.values()) {
          // The validator's per-pair rule: at most one side-effect and one dynamic edge per pair.
          expect(
            kinds.filter((kind) => kind === "esm-side-effect-import").length,
          ).toBeLessThanOrEqual(1);
          expect(kinds.filter((kind) => kind === "esm-dynamic-import").length).toBeLessThanOrEqual(
            1,
          );
          if (
            kinds.length >= 2 &&
            kinds.includes("esm-dynamic-import") &&
            kinds.some((kind) => kind !== "esm-dynamic-import")
          ) {
            // The key order surface: a dynamic import of an already-statically-loaded module.
            sawStaticPlusDynamic = true;
          }
        }
      }
    }
    expect(randomTotal).toBeGreaterThan(0);
    // Multi-kind pairs are dense across a campaign, not incidental.
    expect(multiEdge / randomTotal).toBeGreaterThan(0.15);
    // The static-plus-dynamic surface (dynamic import of an already-loaded module) actually occurs.
    expect(sawStaticPlusDynamic).toBe(true);
  });

  test("cycle-closing value reads are hoisted calls (ESM) or guarded (CJS), never plain", () => {
    let callEdges = 0;
    let guardEdges = 0;
    let postCycleReads = 0;
    for (let seed = 0; seed < 2_000; seed += 1) {
      const generated = generateCase(seed, 8);
      const modulesById = new Map(generated.program.modules.map((module) => [module.id, module]));
      const onCycle = cycleMembers(generated.program);
      for (const module of generated.program.modules) {
        for (const dependency of module.dependencies) {
          if (dependency.kind === "esm-dynamic-import") {
            continue;
          }
          // A -> target closes a cycle when target synchronously reaches back to A.
          const closesCycle =
            dependency.target !== module.id &&
            synchronouslyReachable(dependency.target, modulesById).has(module.id);
          if (dependency.kind === "esm-value-import") {
            if (closesCycle) {
              // In-cycle ESM read: must be a hoisted-function call (no TDZ).
              expect(
                dependency.call,
                `seed ${seed}: plain value import closes a cycle at ${dependency.target}`,
              ).toBe(true);
              callEdges += 1;
            } else if (onCycle.has(dependency.target)) {
              postCycleReads += 1;
            }
          } else if (dependency.kind === "esm-namespace-import") {
            expect(
              closesCycle,
              `seed ${seed}: namespace import closes a cycle at ${dependency.target}`,
            ).toBe(false);
          } else if (dependency.kind === "cjs-require" && dependency.resultBinding !== undefined) {
            if (closesCycle) {
              // In-cycle CJS read: must be guarded (partial export folds to a sentinel, not NaN).
              expect(
                dependency.guard,
                `seed ${seed}: unguarded readable require closes a cycle at ${dependency.target}`,
              ).toBe(true);
              guardEdges += 1;
            } else if (onCycle.has(dependency.target)) {
              postCycleReads += 1;
            }
          }
        }
      }
    }
    // The new cycle value-flow shapes are all reached across the seed window.
    expect(callEdges).toBeGreaterThan(0);
    expect(guardEdges).toBeGreaterThan(0);
    expect(postCycleReads).toBeGreaterThan(0);
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
    expect(large.program.modules.length).toBeLessThanOrEqual(48);
    expect(large.program.modules.length).toBeGreaterThanOrEqual(small.program.modules.length);
    expect(() => generateCase(-1, 4)).toThrowError("seed must be an unsigned 32-bit integer");
    expect(() => generateCase(1, 0)).toThrowError("size must be an integer from 1 through 48");
    expect(() => generateCase(1, 49)).toThrowError("size must be an integer from 1 through 48");
  });

  test("a large case scales the module graph up to the raised ceiling", () => {
    // The scale axis: at size 48 the DAG really grows (up to MAX_RANDOM_MODULES = 48), stressing
    // intra-chunk statement placement that tiny 16-module graphs could not reach.
    let largest = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      const generated = generateCase(seed, 48);
      expect(generated.program.modules.length).toBeLessThanOrEqual(48);
      largest = Math.max(largest, generated.program.modules.length);
    }
    // Some size-48 case must host well more than the old 16-module cap.
    expect(largest).toBeGreaterThan(24);
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

describe("organic chunking axis (wave 6)", () => {
  test("rolls the chunking config deterministically from the seed", () => {
    // Same seed + size must produce byte-identical chunking config (part of overall determinism).
    for (let seed = 0; seed < 50; seed += 1) {
      const first = generateCase(seed, 16);
      const second = generateCase(seed, 16);
      expect(JSON.stringify(second.program.organicChunkGroups)).toBe(
        JSON.stringify(first.program.organicChunkGroups),
      );
      expect(JSON.stringify(second.program.manualChunkGroups)).toBe(
        JSON.stringify(first.program.manualChunkGroups),
      );
    }
  });

  test("emits exactly one chunking:* tag per case, mutually exclusive group fields", () => {
    for (let seed = 0; seed < 300; seed += 1) {
      const generated = generateCase(seed, 16);
      const chunkingTags = generated.coverageTags.filter((tag) => tag.startsWith("chunking:"));
      expect(chunkingTags).toHaveLength(1);
      // A program never carries both group fields (validated), and the tag matches the fields.
      const hasOrganic = (generated.program.organicChunkGroups?.length ?? 0) > 0;
      const hasManual = (generated.program.manualChunkGroups?.length ?? 0) > 0;
      expect(hasOrganic && hasManual).toBe(false);
      if (hasOrganic) {
        expect(chunkingTags).toEqual(["chunking:organic"]);
      } else if (hasManual) {
        expect(chunkingTags).toEqual(["chunking:explicit"]);
      } else {
        expect(chunkingTags).toEqual(["chunking:default"]);
      }
    }
  });

  test("organic chunking covers at least ~40% of random-mixed cases and stays valid", () => {
    let randomMixed = 0;
    let organic = 0;
    for (let seed = 0; seed < 600; seed += 1) {
      const generated = generateCase(seed, 24);
      if (generated.template !== "random-mixed") {
        continue;
      }
      randomMixed += 1;
      if (generated.coverageTags.includes("chunking:organic")) {
        organic += 1;
        // Every organic group has a name; the whole program validates.
        for (const group of generated.program.organicChunkGroups ?? []) {
          expect(group.name.length).toBeGreaterThan(0);
        }
        expect(validateProgramModel(generated.program)).toEqual([]);
      }
    }
    expect(randomMixed).toBeGreaterThan(0);
    expect(organic / randomMixed).toBeGreaterThanOrEqual(0.4);
  });
});

describe("size mix (wave 6)", () => {
  test("samples deterministically from the seed within the small/medium/large spread", () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const first = sampleCaseSize(new SeededRng(seed));
      const second = sampleCaseSize(new SeededRng(seed));
      expect(second).toBe(first);
      expect(first).toBeGreaterThanOrEqual(1);
      expect(first).toBeLessThanOrEqual(MAX_CASE_SIZE);
    }
  });

  test("covers small, medium, and large scales across seeds", () => {
    let small = 0;
    let medium = 0;
    let large = 0;
    for (let seed = 0; seed < 500; seed += 1) {
      const size = sampleCaseSize(new SeededRng(seed));
      if (size <= 12) {
        small += 1;
      } else if (size <= 24) {
        medium += 1;
      } else {
        large += 1;
      }
    }
    expect(small).toBeGreaterThan(0);
    expect(medium).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(0);
  });
});

describe("nested dynamic chains (wave 6)", () => {
  test("tags a hand-built dynamic-import-inside-a-dynamic-module shape", () => {
    // entry -> import("a"); a -> import("b"). b is reachable only via a's dynamic import, and a is
    // reachable only via the entry's dynamic import: a nested dynamic chain.
    const program: ProgramModel = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [{ kind: "esm-dynamic-import", target: "a", registration: "reg-a" }],
          events: [{ module: "entry", phase: "evaluate", value: 1 }],
        },
        {
          id: "a",
          format: "esm",
          dependencies: [{ kind: "esm-dynamic-import", target: "b", registration: "reg-b" }],
          events: [{ module: "a", phase: "evaluate", value: 2 }],
        },
        {
          id: "b",
          format: "esm",
          dependencies: [],
          events: [{ module: "b", phase: "evaluate", value: 3 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    };
    expect(validateProgramModel(program)).toEqual([]);
    expect(deriveCoverageTags(program)).toContain("mechanism:nested-dynamic");
  });

  test("does not tag a plain (eagerly-reached) dynamic import as nested", () => {
    // entry statically imports a; a dynamically imports b. a is eagerly evaluated, so a's dynamic
    // import is a normal (non-nested) dynamic import.
    const program: ProgramModel = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "a" }],
          events: [{ module: "entry", phase: "evaluate", value: 1 }],
        },
        {
          id: "a",
          format: "esm",
          dependencies: [{ kind: "esm-dynamic-import", target: "b", registration: "reg-b" }],
          events: [{ module: "a", phase: "evaluate", value: 2 }],
        },
        { id: "b", format: "esm", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    };
    expect(deriveCoverageTags(program)).not.toContain("mechanism:nested-dynamic");
  });

  test("the generator produces nested dynamic chains at scale", () => {
    let saw = false;
    for (let seed = 0; seed < 400 && !saw; seed += 1) {
      if (generateCase(seed, 32).coverageTags.includes("mechanism:nested-dynamic")) {
        saw = true;
      }
    }
    expect(saw).toBe(true);
  });
});
