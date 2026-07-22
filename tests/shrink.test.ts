import { describe, expect, test } from "vite-plus/test";

import { analyzeProgram } from "../src/analyzed-program.ts";
import type { ProgramModel } from "../src/model.ts";
import { buildConfigOf, DEFAULT_BUILD_CONFIG, programChunking } from "../src/model.ts";
import { candidates, parseArgs, sameFailure } from "../src/shrink.ts";
import { validateProgramModel } from "../src/validate-model.ts";

/// A shrink candidate that keeps the model valid and satisfies `predicate`, or undefined.
function findValidCandidate(
  program: ProgramModel,
  predicate: (candidate: ProgramModel) => boolean,
): ProgramModel | undefined {
  for (const candidate of candidates(program)) {
    if (validateProgramModel(analyzeProgram(candidate)).length === 0 && predicate(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

describe("shrink FailureEquivalence (finding 4)", () => {
  test("exact mode requires the full normalized signature, broad mode only the kind", () => {
    const reorderA = "events-reordered:source=[[m0,evaluate,1]]:bundle=[[m1,evaluate,2]]";
    const reorderB = "events-reordered:source=[[m3,evaluate,9]]:bundle=[[m4,evaluate,8]]";
    // Different concrete reorders share only the KIND: exact rejects, broad accepts.
    expect(sameFailure(reorderA, reorderB)).toBe(false);
    expect(sameFailure(reorderA, reorderB, true)).toBe(true);
    // The identical signature matches in both modes.
    expect(sameFailure(reorderA, reorderA)).toBe(true);
  });

  test("exact mode normalizes Rolldown chunk-internal names so a crash survives module renumbering", () => {
    const crashA = 'bundle-only-crash:["TypeError","init_module_3 is not a function"]';
    const crashB = 'bundle-only-crash:["TypeError","init_module_7 is not a function"]';
    // Same crash, different Rolldown init index: exact still matches after normalization.
    expect(sameFailure(crashA, crashB)).toBe(true);
    // A different crash message is NOT the same failure, even in broad mode (crash identity kept).
    const other =
      'bundle-only-crash:["Error","Execution event value must be a primitive JSON value"]';
    expect(sameFailure(crashA, other)).toBe(false);
    expect(sameFailure(crashA, other, true)).toBe(false);
  });

  test("a different verdict kind is never the same failure", () => {
    expect(sameFailure("events-reordered:x", "bundle-only-crash:y")).toBe(false);
    expect(sameFailure("events-reordered:x", "bundle-only-crash:y", true)).toBe(false);
  });
});

describe("shrink --broad flag (finding 4)", () => {
  test("parseArgs recognizes --broad (default off)", () => {
    expect(parseArgs(["--model", "m.json"]).broad).toBe(false);
    expect(parseArgs(["--model", "m.json", "--broad"]).broad).toBe(true);
  });
});

describe("shrink candidate engine (findings 4 and 9)", () => {
  test("dropping a namespace member also removes it from callMembers (valid candidate)", () => {
    const program = {
      modules: [
        {
          id: "consumer",
          format: "esm",
          dependencies: [
            {
              kind: "esm-namespace-import",
              target: "def",
              localName: "ns",
              readMembers: [["vd1"], ["vd2"]],
              callMembers: ["vd1", "vd2"],
            },
          ],
          events: [
            {
              module: "consumer",
              phase: "evaluate",
              value: 1,
              reads: [
                { binding: "ns", memberPath: ["vd1"], call: true },
                { binding: "ns", memberPath: ["vd2"], call: true },
              ],
            },
          ],
        },
        { id: "def", format: "esm", dependencies: [], events: [], callableOwnState: true },
      ],
      entries: [{ name: "main", moduleId: "consumer" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
    // A candidate that drops one member must leave a VALID model (callMembers followed readMembers).
    const shrunk = findValidCandidate(program, (candidate) => {
      const dep = candidate.modules[0]?.dependencies[0];
      return dep?.kind === "esm-namespace-import" && dep.readMembers.length === 1;
    });
    expect(shrunk).toBeDefined();
  });

  test("rewiring a namespace read past a barrel updates the event member (valid candidate)", () => {
    const program = {
      modules: [
        {
          id: "consumer",
          format: "esm",
          dependencies: [
            {
              kind: "esm-namespace-import",
              target: "barrel",
              localName: "ns",
              readMembers: [["outer"]],
            },
          ],
          events: [
            {
              module: "consumer",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "ns", memberPath: ["outer"] }],
            },
          ],
        },
        {
          id: "barrel",
          format: "esm",
          dependencies: [
            {
              kind: "esm-reexport-named",
              target: "def",
              sourceName: "inner",
              exportedName: "outer",
            },
          ],
          events: [],
        },
        {
          id: "def",
          format: "esm",
          dependencies: [],
          events: [{ module: "def", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "consumer" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
    // The rewired candidate must target `def` directly AND read the source member `inner` — the event
    // read member must follow the rename, or the candidate would be invalid and silently skipped.
    const rewired = findValidCandidate(program, (candidate) => {
      const dep = candidate.modules[0]?.dependencies[0];
      const read = candidate.modules[0]?.events[0]?.reads?.[0];
      return (
        dep?.kind === "esm-namespace-import" &&
        dep.target === "def" &&
        dep.readMembers[0]?.[0] === "inner" &&
        read?.memberPath?.[0] === "inner"
      );
    });
    expect(rewired).toBeDefined();
  });

  test("removes a module's SOLE event", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "leaf" }],
          events: [{ module: "entry", phase: "evaluate", value: 1 }],
        },
        {
          id: "leaf",
          format: "esm",
          dependencies: [],
          events: [{ module: "leaf", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    const dropped = findValidCandidate(
      program,
      (candidate) => candidate.modules[1]?.events.length === 0,
    );
    expect(dropped).toBeDefined();
  });

  test("shrinks each treeshake axis back to its default independently", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [],
          events: [{ module: "entry", phase: "evaluate", value: 1 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
      build: {
        ...DEFAULT_BUILD_CONFIG,
        treeshake: {
          propertyReadSideEffects: false,
          propertyWriteSideEffects: false,
          manualPureFunctions: ["make"],
        },
      },
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);

    const readDefaulted = findValidCandidate(program, (candidate) => {
      const treeshake = buildConfigOf(candidate).treeshake;
      return (
        treeshake.propertyReadSideEffects === "always" &&
        treeshake.propertyWriteSideEffects === false &&
        treeshake.manualPureFunctions.length === 1
      );
    });
    expect(readDefaulted).toBeDefined();

    const writeDefaulted = findValidCandidate(program, (candidate) => {
      const treeshake = buildConfigOf(candidate).treeshake;
      return (
        treeshake.propertyReadSideEffects === false &&
        treeshake.propertyWriteSideEffects === "always" &&
        treeshake.manualPureFunctions.length === 1
      );
    });
    expect(writeDefaulted).toBeDefined();

    const manualPureDefaulted = findValidCandidate(program, (candidate) => {
      const treeshake = buildConfigOf(candidate).treeshake;
      return (
        treeshake.propertyReadSideEffects === false &&
        treeshake.propertyWriteSideEffects === false &&
        treeshake.manualPureFunctions.length === 0
      );
    });
    expect(manualPureDefaulted).toBeDefined();
  });

  test("shrinks an organic chunk config field by field", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [],
          events: [{ module: "entry", phase: "evaluate", value: 1 }],
        },
        {
          id: "leaf",
          format: "esm",
          dependencies: [],
          events: [{ module: "leaf", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
      organicChunkGroups: [
        {
          name: "g",
          minShareCount: 2,
          maxSize: 500,
          priority: 1,
          entriesAware: true,
          entriesAwareMergeThreshold: 10_000,
        },
      ],
    } satisfies ProgramModel;
    // A candidate drops one optional field (e.g. maxSize) while keeping the organic config. The shrinker
    // re-canonicalizes chunking onto `build.chunking`, so read it through `programChunking`.
    const trimmed = findValidCandidate(program, (candidate) => {
      const chunking = programChunking(candidate);
      const group = chunking.kind === "organic" ? chunking.groups[0] : undefined;
      return group !== undefined && group.maxSize === undefined && group.minShareCount === 2;
    });
    expect(trimmed).toBeDefined();
    const withoutEntriesAware = findValidCandidate(program, (candidate) => {
      const chunking = programChunking(candidate);
      const group = chunking.kind === "organic" ? chunking.groups[0] : undefined;
      return group !== undefined && group.entriesAware === undefined;
    });
    expect(withoutEntriesAware).toBeDefined();
    const withoutMergeThreshold = findValidCandidate(program, (candidate) => {
      const chunking = programChunking(candidate);
      const group = chunking.kind === "organic" ? chunking.groups[0] : undefined;
      return group !== undefined && group.entriesAwareMergeThreshold === undefined;
    });
    expect(withoutMergeThreshold).toBeDefined();
  });

  test("shrinks entriesAware fields from an exact manual group independently", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "leaf" }],
          events: [{ module: "entry", phase: "evaluate", value: 1 }],
        },
        {
          id: "leaf",
          format: "esm",
          dependencies: [],
          events: [{ module: "leaf", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
      manualChunkGroups: [
        {
          name: "g",
          moduleIds: ["leaf"],
          entriesAware: true,
          entriesAwareMergeThreshold: 100 * 1024,
        },
      ],
    } satisfies ProgramModel;
    const withoutEntriesAware = findValidCandidate(program, (candidate) => {
      const chunking = programChunking(candidate);
      const group = chunking.kind === "manual" ? chunking.groups[0] : undefined;
      return group?.entriesAware === undefined && group?.entriesAwareMergeThreshold === 100 * 1024;
    });
    expect(withoutEntriesAware).toBeDefined();
    const withoutMergeThreshold = findValidCandidate(program, (candidate) => {
      const chunking = programChunking(candidate);
      const group = chunking.kind === "manual" ? chunking.groups[0] : undefined;
      return group?.entriesAware === true && group.entriesAwareMergeThreshold === undefined;
    });
    expect(withoutMergeThreshold).toBeDefined();
  });

  test("dropping the last read of an event with hiddenReadFn also drops hiddenReadFn", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "leaf", importedName: "v", localName: "lv" },
          ],
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "lv" }],
              hiddenReadFn: true,
            },
          ],
        },
        {
          id: "leaf",
          format: "esm",
          dependencies: [],
          events: [{ module: "leaf", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    // A read-drop candidate must produce a VALID event with neither reads nor a dangling hiddenReadFn.
    const stripped = findValidCandidate(program, (candidate) => {
      const event = candidate.modules[0]?.events[0];
      return event?.reads === undefined && event?.hiddenReadFn === undefined;
    });
    expect(stripped).toBeDefined();
  });
});

describe("shrink exact-equivalence normalizer (finding D)", () => {
  test("distinct NON-NUMERIC chunk symbols (init_alpha vs init_beta) are NOT the same failure", () => {
    const crashAlpha = 'bundle-only-crash:["TypeError","init_alpha is not a function"]';
    const crashBeta = 'bundle-only-crash:["TypeError","init_beta is not a function"]';
    // These name DIFFERENT root causes; the old normalizer rewrote every init_* to one token and
    // wrongly compared them equal, letting a shrink swap the failing module while claiming exact.
    expect(sameFailure(crashAlpha, crashBeta)).toBe(false);
    expect(sameFailure(crashAlpha, crashAlpha)).toBe(true);
  });

  test("numeric-generated init_module_N still normalizes across renumbering", () => {
    // The generated module basenames are module-NNNN, so init_module_NNNN is a numeric-generated form:
    // a shrink drops modules and renumbers the survivors, so these still compare equal.
    const before = 'bundle-only-crash:["TypeError","init_module_0006 is not a function"]';
    const after = 'bundle-only-crash:["TypeError","init_module_0004 is not a function"]';
    expect(sameFailure(before, after)).toBe(true);
  });

  test("rendered module FILENAMES (module-NNNN.mjs) normalize across renumbering (W14a.1)", () => {
    // A shrink drops modules and RENUMBERS survivors, renaming their rendered files. A signature that
    // names the filename (`module-NNNN.mjs`) alongside a chunk-internal `init_module_NNNN` must compare
    // equal after a consistent renumbering — the false negative that made a renumbering shrink reject a
    // valid step because the literal filename number no longer matched.
    const before =
      'bundle-only-crash:["TypeError","module-0002.mjs: init_module_0002 is not a function"]';
    const after =
      'bundle-only-crash:["TypeError","module-0001.mjs: init_module_0001 is not a function"]';
    expect(sameFailure(before, after)).toBe(true);
    // But a filename and an init that name DIFFERENT modules (0001 vs 0002) must NOT collapse — the
    // filename is keyed by the SAME numeric identity as the chunk-internal forms, so the two roles stay
    // distinct.
    const twoModules =
      'bundle-only-crash:["TypeError","module-0001.mjs: init_module_0002 is not a function"]';
    expect(sameFailure(before, twoModules)).toBe(false);
  });

  test("a structurally different two-module failure does not collapse to a one-module one", () => {
    const twoModules =
      "events-reordered:source=[[init_module_0001,a,1]]:bundle=[[init_module_0002,b,2]]";
    const oneModule =
      "events-reordered:source=[[init_module_0001,a,1]]:bundle=[[init_module_0001,b,2]]";
    // First-appearance mapping: the two-module signature maps to N0/N1, the one-module to N0/N0.
    expect(sameFailure(twoModules, oneModule)).toBe(false);
  });

  test("a CROSS-PREFIX two-module failure does not collapse to a one-module one (finding 4)", () => {
    // The reviewer's exact repro: `init_module_0001` + `module_0002` name TWO modules (0001 and 0002);
    // `init_module_0002` + `module_0002` name ONE module (0002) twice. The old normalizer keyed by the
    // whole token, so both mapped to init_module_N0 + module_N1 and compared EQUAL. Keying by the shared
    // numeric identity (preserving init_/require_/plain prefix) keeps them distinct: N0/N1 vs N0/N0.
    const twoModules = "events-reordered:init_module_0001:module_0002";
    const oneModule = "events-reordered:init_module_0002:module_0002";
    expect(sameFailure(twoModules, oneModule)).toBe(false);
    // Each still compares equal to itself, and renumbering the SAME shared identity stays equal.
    expect(sameFailure(twoModules, twoModules)).toBe(true);
    expect(
      sameFailure(
        "events-reordered:init_module_0001:module_0001",
        "events-reordered:init_module_0007:module_0007",
      ),
    ).toBe(true);
  });
});

describe("shrink candidate fixes (finding E)", () => {
  test("rewiring a namespace CALL read past a barrel renames callMembers with readMembers", () => {
    const program = {
      modules: [
        {
          id: "consumer",
          format: "esm",
          dependencies: [
            {
              kind: "esm-namespace-import",
              target: "barrel",
              localName: "ns",
              readMembers: [["outer"]],
              callMembers: ["outer"],
            },
          ],
          events: [
            {
              module: "consumer",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "ns", memberPath: ["outer"], call: true }],
            },
          ],
        },
        {
          id: "barrel",
          format: "esm",
          dependencies: [
            {
              kind: "esm-reexport-named",
              target: "def",
              sourceName: "inner",
              exportedName: "outer",
            },
          ],
          events: [],
        },
        { id: "def", format: "esm", dependencies: [], events: [], callableOwnState: true },
      ],
      entries: [{ name: "main", moduleId: "consumer" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
    // The rewired candidate must target def directly, read "inner", AND carry "inner" in callMembers —
    // else callMembers still names "outer" (no longer a read member) and the candidate is invalid.
    const rewired = findValidCandidate(program, (candidate) => {
      const dep = candidate.modules[0]?.dependencies[0];
      return (
        dep?.kind === "esm-namespace-import" &&
        dep.target === "def" &&
        dep.readMembers[0]?.[0] === "inner" &&
        dep.callMembers?.[0] === "inner"
      );
    });
    expect(rewired).toBeDefined();
  });

  test("dropping the sole manual group deletes the field so the greedy loop terminates", () => {
    const program = {
      modules: [
        { id: "a", format: "esm", dependencies: [], events: [] },
        { id: "b", format: "esm", dependencies: [], events: [] },
      ],
      entries: [
        { name: "ea", moduleId: "a" },
        { name: "eb", moduleId: "b" },
      ],
      schedule: [
        { kind: "import-entry", entry: "ea" },
        { kind: "import-entry", entry: "eb" },
      ],
      manualChunkGroups: [{ name: "g", moduleIds: ["a", "b"] }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);

    // Mirror the shrinker's greedy loop (accept ANY candidate that stays "failing"): here the only
    // structure-preserving edit is dropping the group. With the old bug the group-drop candidate was
    // identical to the current program (the field was retained), so it was re-accepted forever.
    const accept = (candidate: ProgramModel): boolean =>
      candidate.modules.length === 2 &&
      candidate.entries.length === 2 &&
      candidate.schedule.length === 2;
    let current = program as ProgramModel;
    let terminated = false;
    for (let step = 0; step < 200; step += 1) {
      let progressed = false;
      for (const candidate of candidates(current)) {
        if (validateProgramModel(analyzeProgram(candidate)).length === 0 && accept(candidate)) {
          current = candidate;
          progressed = true;
          break;
        }
      }
      if (!progressed) {
        terminated = true;
        break;
      }
    }
    expect(terminated).toBe(true);
    expect(current.manualChunkGroups).toBeUndefined();
  });
});
