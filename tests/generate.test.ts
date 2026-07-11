import { describe, expect, test } from "vite-plus/test";

import {
  deriveCoverageTags,
  deriveRegistrationSequence,
  generateCase,
  generateCrossChunkInitCycleCase,
  generateDynamicWrapKindMergeCase,
  generateOptimizerCycleCase,
  generateStaticCrossEntryLeakCase,
  MAX_CASE_SIZE,
  MIXED_TEMPLATE_NAMES,
  sampleCaseSize,
  type MixedTemplateName,
} from "../src/generate.ts";
import { analyzeProgram } from "../src/analyzed-program.ts";
import type { ModuleModel, ProgramModel } from "../src/model.ts";
import { buildConfigOf, metadataPureModuleIds, packagesOf, programChunking } from "../src/model.ts";
import { ProgramFacts } from "../src/program-facts.ts";
import { renderProgram } from "../src/render.ts";
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
      expect(generated.coverageTags).toEqual(deriveCoverageTags(generated.analyzed));
      expect(validateProgramModel(generated.analyzed)).toEqual([]);
    }
  });

  test("generates only valid programs across many seeds and sizes", () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const generated = generateCase(seed, 1 + (seed % 16));
      expect(
        validateProgramModel(generated.analyzed),
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
        const localReexports = module.dependencies.filter(
          (dependency) => dependency.kind === "esm-local-reexport",
        );
        // A barrel is an ESM re-exporter carrying only re-export dependencies (source-form or the
        // camunda LOCAL form). A PURE barrel emits no events; the camunda composition (W14b) may
        // give a barrel that carries a local re-export its own side effect — that is the point.
        expect(module.format, `seed ${seed}: barrel ${module.id} not ESM`).toBe("esm");
        if (localReexports.length === 0) {
          expect(module.events, `seed ${seed}: barrel ${module.id} emits events`).toEqual([]);
        }
        expect(
          module.dependencies.length,
          `seed ${seed}: barrel ${module.id} carries non-re-export deps`,
        ).toBe(reexports.length + localReexports.length);
        // Every hop forwards to another ESM module (an all-ESM chain), never a CJS target.
        for (const dependency of [...reexports, ...localReexports]) {
          expect(
            modulesById.get(dependency.target)?.format,
            `seed ${seed}: barrel ${module.id} forwards non-ESM ${dependency.target}`,
          ).toBe("esm");
        }
      }
      expect(validateProgramModel(generated.analyzed)).toEqual([]);
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
      // The flagger's output is now single-member `sef-<id>` sideEffects:false packages (the same
      // shape the legacy seam derives), read through the one resolved packages view.
      const modulesByIdForFlags = new Map(
        generated.program.modules.map((module) => [module.id, module]),
      );
      const flaggedModules = packagesOf(generated.program)
        .filter((pkg) => pkg.name.startsWith("sef-") && pkg.sideEffects === false)
        .flatMap((pkg) => pkg.moduleIds)
        .flatMap((id) => {
          const module = modulesByIdForFlags.get(id);
          return module === undefined ? [] : [module];
        });
      if (metadataPureModuleIds(generated.program).size === 0) {
        expect(generated.coverageTags).not.toContain("variation:side-effect-free-metadata");
      } else {
        expect(generated.coverageTags).toContain("variation:side-effect-free-metadata");
      }
      if (flaggedModules.length === 0) {
        continue;
      }
      flaggedCases += 1;

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
      expect(validateProgramModel(generated.analyzed)).toEqual([]);
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
      expect(validateProgramModel(generated.analyzed), `seed ${seed}`).toEqual([]);
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

  // manual-chunk-separation now expresses its split on the persisted `build.chunking` (not a legacy
  // top-level `manualChunkGroups` array), so read the groups through the canonical chunking resolver.
  const chunking = programChunking(program);
  const groups = chunking.kind === "manual" ? chunking.groups : [];
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
        expect(validateProgramModel(generated.analyzed)).toEqual([]);
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
      expect(validateProgramModel(generated.analyzed)).toEqual([]);
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
    // Same seed + size must produce byte-identical chunking config (part of overall determinism). Read
    // it through the canonical resolver so both random-mixed (persisted `build.chunking`) and fixed
    // templates are compared the same way, not the legacy top-level arrays.
    for (let seed = 0; seed < 50; seed += 1) {
      const first = generateCase(seed, 16);
      const second = generateCase(seed, 16);
      expect(JSON.stringify(buildConfigOf(second.program).chunking)).toBe(
        JSON.stringify(buildConfigOf(first.program).chunking),
      );
    }
  });

  test("emits exactly one chunking:* tag per case, mutually exclusive group fields", () => {
    for (let seed = 0; seed < 300; seed += 1) {
      const generated = generateCase(seed, 16);
      const chunkingTags = generated.coverageTags.filter((tag) => tag.startsWith("chunking:"));
      expect(chunkingTags).toHaveLength(1);
      // The chunking tag matches the single resolved `build.chunking` mode (organic/manual/automatic).
      const chunking = programChunking(generated.program);
      if (chunking.kind === "organic") {
        expect(chunkingTags).toEqual(["chunking:organic"]);
      } else if (chunking.kind === "manual") {
        expect(chunkingTags).toEqual(["chunking:explicit"]);
      } else {
        expect(chunkingTags).toEqual(["chunking:default"]);
      }
    }
  });

  test("rolls the BuildConfig axes and tags both values of each (W14a)", () => {
    const idrValues = new Set<string>();
    const lazyValues = new Set<string>();
    for (let seed = 0; seed < 300; seed += 1) {
      const generated = generateCase(seed, 16);
      const build = buildConfigOf(generated.program);
      // Every case GENUINELY persists its BuildConfig on `program.build` (W14a.1 routed the fixed
      // templates through the configuration/freeze seam too — no case relies on the `buildConfigOf`
      // fallback), and the resolved (effective) config equals the persisted object, so the manifest/axes
      // record the effective build.
      expect(generated.program.build).toBeDefined();
      expect(build).toEqual(generated.program.build);
      // The fixed axes stay at their W14a values.
      expect(build.strictExecutionOrder).toBe(true);
      expect(build.preserveEntrySignatures).toBe("allow-extension");
      // Exactly one tag per rolled axis, matching the persisted value.
      expect(generated.coverageTags).toContain(
        `axis:include-dependencies-recursively:${String(build.includeDependenciesRecursively)}`,
      );
      expect(generated.coverageTags).toContain(`axis:lazy-barrel:${String(build.lazyBarrel)}`);
      idrValues.add(String(build.includeDependenciesRecursively));
      lazyValues.add(String(build.lazyBarrel));
    }
    // Both settings of each rolled axis appear across the seed range (a live axis, not a constant).
    expect(idrValues).toEqual(new Set(["true", "false"]));
    expect(lazyValues).toEqual(new Set(["true", "false"]));
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
        const chunking = programChunking(generated.program);
        for (const group of chunking.kind === "organic" ? chunking.groups : []) {
          expect(group.name.length).toBeGreaterThan(0);
        }
        expect(validateProgramModel(generated.analyzed)).toEqual([]);
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
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
    expect(deriveCoverageTags(analyzeProgram(program))).toContain("mechanism:nested-dynamic");
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
    expect(deriveCoverageTags(analyzeProgram(program))).not.toContain("mechanism:nested-dynamic");
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

describe("deriveCoverageTags predicate corrections (finding 8)", () => {
  test("a dynamic import of a CJS module is not tagged as a side-effect import", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [{ kind: "esm-dynamic-import", target: "cjs", registration: "r" }],
          events: [{ module: "entry", phase: "evaluate", value: 1 }],
        },
        {
          id: "cjs",
          format: "cjs",
          dependencies: [],
          events: [{ module: "cjs", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    const tags = deriveCoverageTags(analyzeProgram(program));
    expect(tags).toContain("mechanism:esm-imports-cjs");
    expect(tags).not.toContain("variation:side-effect-import");
  });

  test("a multi-edge pair is tagged only for DISTINCT kinds, not repeated same-kind edges", () => {
    const twoValueImports = {
      modules: [
        {
          id: "a",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "b", importedName: "x", localName: "bx" },
            { kind: "esm-value-import", target: "b", importedName: "y", localName: "by" },
          ],
          events: [{ module: "a", phase: "evaluate", value: 1, reads: [{ binding: "bx" }] }],
        },
        {
          id: "b",
          format: "esm",
          dependencies: [],
          events: [{ module: "b", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(deriveCoverageTags(analyzeProgram(twoValueImports))).not.toContain(
      "variation:multi-edge-pair",
    );

    const valuePlusDynamic = {
      ...twoValueImports,
      modules: [
        {
          id: "a",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "b", importedName: "x", localName: "bx" },
            { kind: "esm-dynamic-import", target: "b", registration: "r" },
          ],
          events: [{ module: "a", phase: "evaluate", value: 1, reads: [{ binding: "bx" }] }],
        },
        {
          id: "b",
          format: "esm",
          dependencies: [],
          events: [{ module: "b", phase: "evaluate", value: 2 }],
        },
      ],
    } satisfies ProgramModel;
    expect(deriveCoverageTags(analyzeProgram(valuePlusDynamic))).toContain(
      "variation:multi-edge-pair",
    );
  });

  test("a namespace import with no read members is not tagged namespace-read", () => {
    const program = {
      modules: [
        {
          id: "a",
          format: "esm",
          dependencies: [
            { kind: "esm-namespace-import", target: "b", localName: "ns", readMembers: [] },
          ],
          events: [{ module: "a", phase: "evaluate", value: 1 }],
        },
        {
          id: "b",
          format: "esm",
          dependencies: [],
          events: [{ module: "b", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(deriveCoverageTags(analyzeProgram(program))).not.toContain("variation:namespace-read");
  });

  test("a forward callable read does not falsely produce a cycle-hoisted-call tag", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-side-effect-import", target: "ring-a" },
            {
              kind: "esm-namespace-import",
              target: "def",
              localName: "ns",
              readMembers: [["vdef"]],
              callMembers: ["vdef"],
            },
          ],
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "ns", memberPath: ["vdef"], call: true }],
            },
          ],
        },
        {
          id: "ring-a",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "ring-b" }],
          events: [{ module: "ring-a", phase: "evaluate", value: 2 }],
        },
        {
          id: "ring-b",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "ring-a" }],
          events: [{ module: "ring-b", phase: "evaluate", value: 3 }],
        },
        {
          id: "def",
          format: "esm",
          dependencies: [],
          events: [{ module: "def", phase: "evaluate", value: 4 }],
          callableOwnState: true,
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
    const tags = deriveCoverageTags(analyzeProgram(program));
    expect(tags).toContain("mechanism:cycle");
    expect(tags).toContain("variation:callable-own-state");
    // The call read is on a FORWARD edge (entry -> def), not a cycle-closing one.
    expect(tags).not.toContain("variation:cycle-hoisted-call");
    expect(tags).not.toContain("mechanism:cycle-value-read");
  });

  test("an incomplete pure-definer conjunction (importers are not entries) is not tagged complete", () => {
    // A star-barrel over a pure definer, namespace-imported by two NON-entry modules with a split
    // read — everything except the forced entries. The completeness predicate must decline it.
    const program = {
      modules: [
        {
          id: "root",
          format: "esm",
          dependencies: [
            { kind: "esm-side-effect-import", target: "c1" },
            { kind: "esm-side-effect-import", target: "c2" },
          ],
          events: [{ module: "root", phase: "evaluate", value: 1 }],
        },
        {
          id: "c1",
          format: "esm",
          dependencies: [
            {
              kind: "esm-namespace-import",
              target: "barrel",
              localName: "n1",
              readMembers: [["vdef"]],
            },
          ],
          events: [
            {
              module: "c1",
              phase: "evaluate",
              value: 2,
              reads: [{ binding: "n1", memberPath: ["vdef"] }],
            },
          ],
        },
        {
          id: "c2",
          format: "esm",
          dependencies: [
            {
              kind: "esm-namespace-import",
              target: "barrel",
              localName: "n2",
              readMembers: [["vsib"]],
            },
          ],
          events: [
            {
              module: "c2",
              phase: "evaluate",
              value: 3,
              reads: [{ binding: "n2", memberPath: ["vsib"] }],
            },
          ],
        },
        {
          id: "barrel",
          format: "esm",
          dependencies: [
            { kind: "esm-reexport-star", target: "def" },
            { kind: "esm-reexport-named", target: "sib", sourceName: "vsib", exportedName: "vsib" },
          ],
          events: [],
        },
        {
          id: "def",
          format: "esm",
          dependencies: [],
          events: [],
          inferredPure: true,
          pureBase: 10,
        },
        {
          id: "sib",
          format: "esm",
          dependencies: [],
          events: [{ module: "sib", phase: "evaluate", value: 4 }],
        },
      ],
      entries: [{ name: "main", moduleId: "root" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
    // c1 and c2 read the split, but they are NOT entries, so the conjunction is incomplete.
    expect(deriveCoverageTags(analyzeProgram(program))).not.toContain(
      "mechanism:pure-definer-behind-barrel",
    );
  });

  // Finding B: cycle formats were aggregated PROGRAM-WIDE, so a case with a separate all-ESM SCC and a
  // separate all-CJS SCC saw a format union of size 2 and fired NEITHER per-format cycle tag. Per-SCC
  // format predicates fire BOTH.
  test("a program with a separate ESM cycle and a separate CJS cycle tags BOTH per-format cycles", () => {
    const program = {
      modules: [
        {
          id: "a1",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "a2" }],
          events: [{ module: "a1", phase: "evaluate", value: 1 }],
        },
        {
          id: "a2",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "a1" }],
          events: [{ module: "a2", phase: "evaluate", value: 2 }],
        },
        {
          id: "c1",
          format: "cjs",
          dependencies: [{ kind: "cjs-require", target: "c2" }],
          events: [{ module: "c1", phase: "evaluate", value: 3 }],
        },
        {
          id: "c2",
          format: "cjs",
          dependencies: [{ kind: "cjs-require", target: "c1" }],
          events: [{ module: "c2", phase: "evaluate", value: 4 }],
        },
      ],
      entries: [
        { name: "esm-entry", moduleId: "a1" },
        { name: "cjs-entry", moduleId: "c1" },
      ],
      schedule: [
        { kind: "import-entry", entry: "esm-entry" },
        { kind: "require-entry", entry: "cjs-entry" },
      ],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
    const tags = deriveCoverageTags(analyzeProgram(program));
    expect(tags).toContain("mechanism:esm-cycle");
    expect(tags).toContain("mechanism:cjs-cycle");
  });
});

describe("dynamic-import registration sequence (finding 5)", () => {
  const dyn = (target: string, registration: string) =>
    ({ kind: "esm-dynamic-import", target, registration }) as const;
  const modulesWith = (edges: { owner: string; registration: string }[]): ModuleModel[] =>
    edges.map((edge) => ({
      id: edge.owner,
      format: "esm",
      dependencies: [dyn(`t-${edge.registration}`, edge.registration)],
      events: [],
    }));

  test("derives the registration order from the graph, ordered by creation ordinal", () => {
    // The side list records creation order; the graph is scanned in a DIFFERENT order. Sorting the
    // graph's dynamic edges by their creation ordinal must reproduce the side-list order exactly.
    const registrations = [
      { owner: "a", registration: "r0" },
      { owner: "b", registration: "r1" },
      { owner: "c", registration: "r2" },
    ];
    const shuffledGraph = modulesWith([
      { owner: "c", registration: "r2" },
      { owner: "a", registration: "r0" },
      { owner: "b", registration: "r1" },
    ]);
    expect(deriveRegistrationSequence(shuffledGraph, registrations)).toEqual(registrations);
  });

  test("asserts MEMBERSHIP: a graph edge with no recorded ordinal throws", () => {
    const graph = modulesWith([
      { owner: "a", registration: "r0" },
      { owner: "b", registration: "orphan" },
    ]);
    expect(() => deriveRegistrationSequence(graph, [{ owner: "a", registration: "r0" }])).toThrow(
      /no creation ordinal|graph\/side-list drift/,
    );
  });

  test("asserts MEMBERSHIP the other way: a recorded registration absent from the graph throws", () => {
    const graph = modulesWith([{ owner: "a", registration: "r0" }]);
    expect(() =>
      deriveRegistrationSequence(graph, [
        { owner: "a", registration: "r0" },
        { owner: "b", registration: "r1" },
      ]),
    ).toThrow(/registration\/graph mismatch/);
  });

  test("asserts UNIQUENESS: a duplicate registration ordinal throws", () => {
    const graph = modulesWith([{ owner: "a", registration: "r0" }]);
    expect(() =>
      deriveRegistrationSequence(graph, [
        { owner: "a", registration: "r0" },
        { owner: "a", registration: "r0" },
      ]),
    ).toThrow(/duplicate dynamic-import registration ordinal/);
  });
});

describe("cross-chunk init-cycle shape (W14-10, rolldown #9887)", () => {
  test("produces a valid, module-ACYCLIC model with the manufactured-chunk-cycle build config", () => {
    const generated = generateCrossChunkInitCycleCase(1);
    // The model is VALID — the manufactured chunk cycle is a build-side split, not a source-level cycle.
    expect(validateProgramModel(generated.analyzed)).toEqual([]);
    // The MODULE graph is ACYCLIC (dep imports its value from shared, not from the hub), so there is no
    // mixed-format module cycle — only the CHUNK graph is cyclic.
    const facts = ProgramFacts.from(generated.program.modules);
    expect(facts.cycles().cyclicMembers.size).toBe(0);
    // The build config: a manual split placing dep alone vs {hub, interop, shared}, with idr:false.
    const build = buildConfigOf(generated.program);
    expect(build.includeDependenciesRecursively).toBe(false);
    expect(build.strictExecutionOrder).toBe(true);
    expect(build.chunking.kind).toBe("manual");
    if (build.chunking.kind === "manual") {
      const groups = build.chunking.groups.map((g) => [...g.moduleIds].sort());
      expect(groups).toContainEqual(["cc-dep"]);
      expect(groups).toContainEqual(["cc-hub", "cc-interop", "cc-shared"]);
    }
  });

  test("carries the structural cross-chunk-init-cycle and cjs-requires-esm tags", () => {
    const generated = generateCrossChunkInitCycleCase(1);
    expect(generated.coverageTags).toContain("mechanism:barrel-cross-chunk-init-cycle");
    expect(generated.coverageTags).toContain("mechanism:cjs-requires-esm");
    expect(generated.coverageTags).toContain("chunking:explicit");
    expect(generated.coverageTags).toContain("axis:include-dependencies-recursively:false");
  });

  test("an ACYCLIC cross-group cjs→esm probe does NOT get the cross-chunk-init-cycle tag (W14a.1)", () => {
    // The over-claim W14a.1 tightened: the tag used to fire on ANY cross-group CJS-requires-ESM edge under
    // idr:false, even when the chunk graph is acyclic. This 2-module probe (`a` cjs requires `b` esm, in two
    // manual groups) has NO return path (`b` has no dependencies), so no chunk cycle is manufactured — the
    // tag must NOT fire, even though the CJS→ESM require crosses groups. It now requires a grouped quotient
    // cycle (the ESM target's chunk reaching back to the requiring chunk).
    const acyclicProbe = {
      modules: [
        {
          id: "a",
          format: "cjs",
          dependencies: [{ kind: "cjs-require", target: "b" }],
          events: [{ module: "a", phase: "evaluate", value: 1 }],
        },
        { id: "b", format: "esm", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "require-entry", entry: "main" }],
      build: {
        chunking: {
          kind: "manual",
          groups: [
            { name: "ga", moduleIds: ["a"] },
            { name: "gb", moduleIds: ["b"] },
          ],
        },
        includeDependenciesRecursively: false,
        preserveEntrySignatures: "allow-extension",
        lazyBarrel: false,
        strictExecutionOrder: true,
      },
    } satisfies ProgramModel;
    const analyzed = analyzeProgram(acyclicProbe);
    expect(validateProgramModel(analyzed)).toEqual([]);
    const tags = deriveCoverageTags(analyzed);
    // It IS a manual-chunk case with a cross-group CJS→ESM require...
    expect(tags).toContain("chunking:explicit");
    expect(tags).toContain("mechanism:cjs-requires-esm");
    // ...but there is no manufactured chunk cycle, so the #9887 tag stays off.
    expect(tags).not.toContain("mechanism:barrel-cross-chunk-init-cycle");
  });

  test("renders the #9887 shape: CJS interop requires ESM dep, hub named+star re-exports", () => {
    const generated = generateCrossChunkInitCycleCase(1);
    const rendered = renderProgram(generated.analyzed);
    const byId = generated.program.modules.map(
      (m) => rendered.files.find((f) => f.path === rendered.modulePaths.get(m.id))?.contents ?? "",
    );
    const [consumer, hub, interop, dep, shared] = byId;
    // interop is CJS and require()s the ESM dep and shared (the eager CJS init of ESM).
    expect(interop).toContain('require("');
    // hub NAMED-re-exports shared's extend and STAR-re-exports dep (disjoint, so unambiguous).
    expect(hub).toContain("export { extend } from");
    expect(hub).toContain("export * from");
    // dep imports extend from shared (forward, acyclic) and the consumer folds the values into an event.
    expect(dep).toContain("import { extend as e }");
    expect(consumer).toContain("globalThis.__orderEvent");
    expect(shared).toContain("as extend");
  });

  test("the generated shape is the minimal 5-module repro (matches the pre-pin shape)", () => {
    // The builder emits exactly the pre-pin repro's 5 modules (consumer, hub, interop, dep, shared). This
    // STRUCTURAL check only pins the module set; minimality was confirmed EMPIRICALLY out-of-band: the
    // 4-module variant with the consumer removed builds GREEN on the buggy rolldown@1.1.5 (with no witness
    // folding the mis-ordered values into an observed event, the cycle no longer manifests), so the
    // consumer is load-bearing and this is already the shrunken shape. See the #9887 evidence file.
    const generated = generateCrossChunkInitCycleCase(1);
    expect(generated.program.modules).toHaveLength(5);
    expect(generated.program.modules.map((m) => m.id).sort()).toEqual([
      "cc-consumer",
      "cc-dep",
      "cc-hub",
      "cc-interop",
      "cc-shared",
    ]);
  });
});

describe("optimizer runtime-placement cycle shape (FW-B deliverable 1, rolldown #9993/RED-3)", () => {
  test("produces a valid, module-ACYCLIC model with the #9993 runtime-placement recipe", () => {
    const generated = generateOptimizerCycleCase(0, "runtime-placement");
    // Valid: the cross-chunk cycle is a build-side optimizer artifact, not a source-level module cycle.
    expect(validateProgramModel(generated.analyzed)).toEqual([]);
    // The MODULE graph is ACYCLIC — every CJS module only requires the ESM leaf forward; the leaf imports
    // nothing back. Only the optimizer manufactures the chunk cycle (a runtime-helper placement, not a
    // module cycle), so the source runs cleanly and the differential oracle stays valid.
    const facts = ProgramFacts.from(generated.program.modules);
    expect(facts.cycles().cyclicMembers.size).toBe(0);
    // The recipe: a manual group capturing the two CJS entries but NOT the required ESM leaf, at idr:false.
    const build = buildConfigOf(generated.program);
    expect(build.includeDependenciesRecursively).toBe(false);
    expect(build.strictExecutionOrder).toBe(true);
    expect(build.chunking.kind).toBe("manual");
    if (build.chunking.kind === "manual") {
      const grouped = new Set(build.chunking.groups.flatMap((g) => g.moduleIds));
      expect(grouped.has("oc-node3")).toBe(true);
      expect(grouped.has("oc-node4")).toBe(true);
      expect(grouped.has("oc-leaf")).toBe(false);
    }
  });

  test("carries the optimizer-runtime-placement-cycle recipe tag (both variants)", () => {
    for (const variant of ["runtime-placement", "facade-shared"] as const) {
      const generated = generateOptimizerCycleCase(0, variant);
      expect(generated.coverageTags).toContain("mechanism:optimizer-runtime-placement-cycle");
      expect(generated.coverageTags).toContain("mechanism:cjs-requires-esm");
      expect(generated.coverageTags).toContain("chunking:explicit");
      expect(generated.coverageTags).toContain("axis:include-dependencies-recursively:false");
    }
  });

  test("the recipe tag does NOT fire when the required ESM leaf is INSIDE the group (no cross-chunk edge)", () => {
    // The recipe needs the leaf OUTSIDE the group: at idr:false that keeps the leaf in its own chunk so the
    // runtime helper is placed cross-chunk. A group capturing the leaf too dissolves the placement, so the
    // tag must not fire (a coverage over-claim guard, mirroring the cross-chunk-init-cycle acyclic probe).
    const generated = generateOptimizerCycleCase(0, "runtime-placement");
    const grouped: ProgramModel = {
      ...generated.program,
      build: {
        ...buildConfigOf(generated.program),
        chunking: {
          kind: "manual",
          groups: [{ name: "oc-v", moduleIds: ["oc-node3", "oc-node4", "oc-leaf"] }],
        },
      },
    };
    expect(deriveCoverageTags(analyzeProgram(grouped))).not.toContain(
      "mechanism:optimizer-runtime-placement-cycle",
    );
  });
});

describe("dynamic-entry × wrap-kind × merge shape (FW-B deliverable 2, cluster 4 / T1)", () => {
  test("every variant/format produces a valid model tagged with the co-location recipe", () => {
    const cells = [
      { variant: "shared-dynamic", format: "cjs" },
      { variant: "shared-dynamic", format: "esm" },
      { variant: "static-dynamic-merge", format: "cjs" },
      { variant: "static-dynamic-merge", format: "esm" },
      { variant: "identity-double-init", format: "esm" },
    ] as const;
    for (const { variant, format } of cells) {
      const generated = generateDynamicWrapKindMergeCase(0, variant, format);
      expect(validateProgramModel(generated.analyzed), `${variant}:${format}`).toEqual([]);
      expect(generated.coverageTags, `${variant}:${format}`).toContain(
        "mechanism:dynamic-entry-wrap-kind-merge",
      );
      // The dynamic-import target dw-t is co-located with other modules in a group (the merge recipe).
      expect(generated.coverageTags).toContain("mechanism:dynamic-import");
      // The dynamic target is dynamically imported (a real dynamic entry).
      const registrations = generated.program.modules.flatMap((m) =>
        m.dependencies.flatMap((d) => (d.kind === "esm-dynamic-import" ? [d.target] : [])),
      );
      expect(registrations).toContain("dw-t");
    }
  });

  test("the recipe tag does NOT fire under automatic chunking (no co-locating group)", () => {
    const generated = generateDynamicWrapKindMergeCase(0, "shared-dynamic", "cjs");
    const automatic: ProgramModel = {
      ...generated.program,
      build: { ...buildConfigOf(generated.program), chunking: { kind: "automatic" } },
    };
    expect(deriveCoverageTags(analyzeProgram(automatic))).not.toContain(
      "mechanism:dynamic-entry-wrap-kind-merge",
    );
  });
});

describe("broader static cross-entry-leak (FW-B deliverable 4, W14c follow-up)", () => {
  test("is a valid seo:false model tagged cross-entry-leak, PURELY STATIC (no dynamic import)", () => {
    const generated = generateStaticCrossEntryLeakCase(0);
    expect(validateProgramModel(generated.analyzed)).toEqual([]);
    // The same root as #9998: seo:false + a co-locating organic group over mutually-unreachable entries.
    expect(generated.coverageTags).toContain("mechanism:cross-entry-leak");
    expect(generated.coverageTags).toContain("axis:strict-execution-order:false");
    // Broader trigger: NO dynamic import (purely static), and a PLAIN organic group.
    const hasDynamic = generated.program.modules.some((m) =>
      m.dependencies.some((d) => d.kind === "esm-dynamic-import"),
    );
    expect(hasDynamic).toBe(false);
    const chunking = programChunking(generated.program);
    expect(chunking.kind).toBe("organic");
    if (chunking.kind === "organic") {
      // A plain group — no entriesAware.
      expect(chunking.groups.every((g) => g.entriesAware !== true)).toBe(true);
    }
  });

  test("its two entries are mutually unreachable (the isolation precondition)", () => {
    const generated = generateStaticCrossEntryLeakCase(0);
    const facts = ProgramFacts.from(generated.program.modules);
    expect(facts.reachableAllFrom("le2-a").has("le2-b")).toBe(false);
    expect(facts.reachableAllFrom("le2-b").has("le2-a")).toBe(false);
  });
});
