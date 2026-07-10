import { describe, expect, test } from "vite-plus/test";

import type { ProgramModel } from "../src/model.ts";
import { candidates, parseArgs, sameFailure } from "../src/shrink.ts";
import { validateProgramModel } from "../src/validate-model.ts";

/// A shrink candidate that keeps the model valid and satisfies `predicate`, or undefined.
function findValidCandidate(
  program: ProgramModel,
  predicate: (candidate: ProgramModel) => boolean,
): ProgramModel | undefined {
  for (const candidate of candidates(program)) {
    if (validateProgramModel(candidate).length === 0 && predicate(candidate)) {
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
              readMembers: ["vd1", "vd2"],
              callMembers: ["vd1", "vd2"],
            },
          ],
          events: [
            {
              module: "consumer",
              phase: "evaluate",
              value: 1,
              reads: [
                { binding: "ns", member: "vd1", call: true },
                { binding: "ns", member: "vd2", call: true },
              ],
            },
          ],
        },
        { id: "def", format: "esm", dependencies: [], events: [], callableOwnState: true },
      ],
      entries: [{ name: "main", moduleId: "consumer" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(program)).toEqual([]);
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
              readMembers: ["outer"],
            },
          ],
          events: [
            {
              module: "consumer",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "ns", member: "outer" }],
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
    expect(validateProgramModel(program)).toEqual([]);
    // The rewired candidate must target `def` directly AND read the source member `inner` — the event
    // read member must follow the rename, or the candidate would be invalid and silently skipped.
    const rewired = findValidCandidate(program, (candidate) => {
      const dep = candidate.modules[0]?.dependencies[0];
      const read = candidate.modules[0]?.events[0]?.reads?.[0];
      return (
        dep?.kind === "esm-namespace-import" &&
        dep.target === "def" &&
        dep.readMembers[0] === "inner" &&
        read?.member === "inner"
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
      organicChunkGroups: [{ name: "g", minShareCount: 2, maxSize: 500, priority: 1 }],
    } satisfies ProgramModel;
    // A candidate drops one optional field (e.g. maxSize) while keeping the organic config.
    const trimmed = findValidCandidate(program, (candidate) => {
      const group = candidate.organicChunkGroups?.[0];
      return group !== undefined && group.maxSize === undefined && group.minShareCount === 2;
    });
    expect(trimmed).toBeDefined();
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
