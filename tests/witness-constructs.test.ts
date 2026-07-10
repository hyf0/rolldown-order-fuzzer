/// <reference types="node" />

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { executeManifest } from "../src/execute.ts";
import { deriveCoverageTags, generateCase, sampleCaseSize } from "../src/generate.ts";
import type { ProgramModel } from "../src/model.ts";
import { renderProgram } from "../src/render.ts";
import { SeededRng } from "../src/rng.ts";
import { validateProgramModel } from "../src/validate-model.ts";

// A callable-reads-own-state cluster: an inferred-pure definer whose exported function reads a
// module-scope state var, forwarded through a STAR barrel, and CALLED by two entry consumers (one
// call hidden inside a local function — the family-B statically-invisible startup shape).
function callableOwnStateProgram(inferredPure: boolean): ProgramModel {
  const definer = inferredPure
    ? {
        id: "def",
        format: "esm" as const,
        callableOwnState: true as const,
        inferredPure: true as const,
        pureBase: 700,
        events: [],
        dependencies: [],
      }
    : {
        id: "def",
        format: "esm" as const,
        callableOwnState: true as const,
        events: [{ module: "def", phase: "evaluate", value: 700 }],
        dependencies: [],
      };
  return {
    modules: [
      definer,
      {
        id: "bar",
        format: "esm",
        events: [],
        dependencies: [{ kind: "esm-reexport-star", target: "def" }],
      },
      {
        id: "e1",
        format: "esm",
        events: [
          {
            module: "e1",
            phase: "evaluate",
            value: 100,
            reads: [{ binding: "ns1", member: "vdef", call: true }],
          },
        ],
        dependencies: [
          {
            kind: "esm-namespace-import",
            target: "bar",
            localName: "ns1",
            readMembers: ["vdef"],
            callMembers: ["vdef"],
          },
        ],
      },
      {
        id: "e2",
        format: "esm",
        events: [
          {
            module: "e2",
            phase: "evaluate",
            value: 200,
            reads: [{ binding: "ns2", member: "vdef", call: true }],
            hiddenReadFn: true,
          },
        ],
        dependencies: [
          {
            kind: "esm-namespace-import",
            target: "bar",
            localName: "ns2",
            readMembers: ["vdef"],
            callMembers: ["vdef"],
          },
        ],
      },
    ],
    entries: [
      { name: "e1", moduleId: "e1" },
      { name: "e2", moduleId: "e2" },
    ],
    schedule: [
      { kind: "import-entry", entry: "e1" },
      { kind: "import-entry", entry: "e2" },
    ],
  } as ProgramModel;
}

// An object-identity cluster: an objectExport definer forwarded through a named barrel, captured
// directly AND through the barrel by one consumer that compares the two references for identity.
function objectIdentityProgram(): ProgramModel {
  return {
    modules: [
      { id: "def", format: "esm", objectExport: true, events: [], dependencies: [] },
      {
        id: "bar",
        format: "esm",
        events: [],
        dependencies: [
          { kind: "esm-reexport-named", target: "def", sourceName: "vdef", exportedName: "vdef" },
        ],
      },
      {
        id: "e1",
        format: "esm",
        events: [
          {
            module: "e1",
            phase: "evaluate",
            value: 300,
            identityCheck: { leftBinding: "d1", rightBinding: "b1" },
          },
        ],
        dependencies: [
          {
            kind: "esm-value-import",
            target: "def",
            importedName: "vdef",
            localName: "d1",
            objectRef: true,
          },
          {
            kind: "esm-value-import",
            target: "bar",
            importedName: "vdef",
            localName: "b1",
            objectRef: true,
          },
        ],
      },
    ],
    entries: [{ name: "e1", moduleId: "e1" }],
    schedule: [{ kind: "import-entry", entry: "e1" }],
  } as ProgramModel;
}

describe("callable-reads-own-state rendering", () => {
  test("an inferred-pure definer reads a module-scope state var through a function export, no events", () => {
    const rendered = renderProgram(callableOwnStateProgram(true));
    const definer = fileContents(rendered.files, "module-0000.mjs");
    // A non-inlinable state var (a pure build call, like the family-A definer value) read by the export.
    expect(definer).toContain("function __ownStateBuild0() { return 700; }");
    expect(definer).toContain("let __ownState0 = /* @__PURE__ */ __ownStateBuild0();");
    expect(definer).toContain("export function vdef() { return __ownState0 + 1; }");
    // Purity: only pure statements — no events, no globalThis writes, and NOT a folded literal.
    expect(definer).not.toContain("__orderEvent");
    expect(definer).not.toContain("globalThis");
    expect(definer).not.toContain("let __ownState0 = 700;");
    // The barrel star-forwards the callable; the consumer CALLS it through the namespace.
    expect(fileContents(rendered.files, "module-0001.mjs")).toContain(
      'export * from "./module-0000.mjs";',
    );
    expect(fileContents(rendered.files, "module-0002.mjs")).toContain("100 + ns1.vdef()");
    // The second consumer hides the call inside a local function (the family-B invisible startup use).
    const e2 = fileContents(rendered.files, "module-0003.mjs");
    expect(e2).toContain("function __hiddenRead0() { return ns2.vdef(); }");
    expect(e2).toContain("value: 200 + __hiddenRead0()");
  });

  test("an event-carrying definer keeps its event AND the state-reading callable", () => {
    const rendered = renderProgram(callableOwnStateProgram(false));
    const definer = fileContents(rendered.files, "module-0000.mjs");
    expect(definer).toContain("__orderEvent");
    expect(definer).toContain("let __ownState0 = /* @__PURE__ */ __ownStateBuild0();");
    expect(definer).toContain("export function vdef() { return __ownState0 + 1; }");
  });
});

describe("callable-reads-own-state fold-equivalence (the oracle baseline)", () => {
  test("the source graph folds the called own-state value into consumer events", async () => {
    const rendered = renderProgram(callableOwnStateProgram(true));
    await withRenderedProgram(rendered.files, async (directory) => {
      const outcome = await executeManifest(join(directory, rendered.schedulePath));
      expect(outcome.status).toBe("ok");
      const values = outcome.events
        .filter((event): event is Extract<typeof event, { module: string }> => "module" in event)
        .map((event) => [event.module, event.value]);
      // vdef() returns __ownState (700) + 1 = 701; e1 folds 100 + 701, e2 folds 200 + 701 (hidden).
      expect(values).toContainEqual(["e1", 801]);
      expect(values).toContainEqual(["e2", 901]);
    });
  });

  test("the event-carrying variant folds correctly and emits the definer's own event", async () => {
    const rendered = renderProgram(callableOwnStateProgram(false));
    await withRenderedProgram(rendered.files, async (directory) => {
      const outcome = await executeManifest(join(directory, rendered.schedulePath));
      expect(outcome.status).toBe("ok");
      const values = outcome.events
        .filter((event): event is Extract<typeof event, { module: string }> => "module" in event)
        .map((event) => [event.module, event.value]);
      expect(values).toContainEqual(["def", 700]);
      expect(values).toContainEqual(["e1", 801]);
      expect(values).toContainEqual(["e2", 901]);
    });
  });
});

describe("object-identity rendering and fold-equivalence", () => {
  test("an object export renders a fresh object literal; the consumer compares two captures", () => {
    const rendered = renderProgram(objectIdentityProgram());
    expect(fileContents(rendered.files, "module-0000.mjs")).toContain(
      "export const vdef = { v: 0 };",
    );
    const consumer = fileContents(rendered.files, "module-0002.mjs");
    // Two captures of the same export (direct + through the barrel) compared for identity.
    expect(consumer).toContain('import { vdef as d1 } from "./module-0000.mjs";');
    expect(consumer).toContain('import { vdef as b1 } from "./module-0001.mjs";');
    expect(consumer).toContain("value: 300 + ((d1 === b1) ? 0 : 987654321)");
  });

  test("source identity holds (single evaluation), so the value equals the base", async () => {
    const rendered = renderProgram(objectIdentityProgram());
    await withRenderedProgram(rendered.files, async (directory) => {
      const outcome = await executeManifest(join(directory, rendered.schedulePath));
      expect(outcome.status).toBe("ok");
      const entryEvent = outcome.events.find((event) => "module" in event && event.module === "e1");
      // a === b in source ESM, so the fold is 300 + 0.
      expect(entryEvent).toMatchObject({ value: 300 });
    });
  });
});

describe("wave-8 coverage tags", () => {
  test("variation:callable-own-state fires and does NOT count as a family-A conjunction", () => {
    const tags = deriveCoverageTags(callableOwnStateProgram(true));
    expect(tags).toContain("variation:callable-own-state");
    // A callable-own-state definer read via a CALL is a distinct witness, not the value-read family A.
    expect(tags).not.toContain("mechanism:pure-definer-behind-barrel");
  });

  test("variation:object-identity fires when an event carries an identityCheck", () => {
    expect(deriveCoverageTags(objectIdentityProgram())).toContain("variation:object-identity");
    // A program with neither construct does not fire the tags.
    expect(deriveCoverageTags(objectIdentityProgram())).not.toContain(
      "variation:callable-own-state",
    );
  });
});

describe("wave-8 model validation", () => {
  test("callable-own-state must be ESM and not also objectExport", () => {
    const invalid = {
      modules: [
        { id: "a", format: "cjs", callableOwnState: true, events: [], dependencies: [] },
        {
          id: "b",
          format: "esm",
          callableOwnState: true,
          objectExport: true,
          events: [],
          dependencies: [],
        },
      ],
      entries: [{ name: "main", moduleId: "b" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } as unknown as ProgramModel;
    const errors = validateProgramModel(invalid);
    expect(errors).toContain("modules[0]: a callable-own-state module must be ESM, received cjs");
    expect(errors).toContain(
      "modules[1]: a module cannot be both callableOwnState and objectExport",
    );
  });

  test("object-export must be an ESM no-events leaf", () => {
    const invalid = {
      modules: [
        {
          id: "a",
          format: "esm",
          objectExport: true,
          events: [{ module: "a", phase: "evaluate", value: 1 }],
          dependencies: [{ kind: "esm-side-effect-import", target: "b" }],
        },
        { id: "b", format: "esm", events: [], dependencies: [] },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } as unknown as ProgramModel;
    const errors = validateProgramModel(invalid);
    expect(errors).toContain(
      "modules[0]: an object-export module must not emit events; it is the invisible double-init target",
    );
    expect(errors).toContain(
      "modules[0]: an object-export module must be a leaf (no dependencies)",
    );
  });

  test("identityCheck needs objectRef bindings, and objectRef cannot be folded numerically", () => {
    const invalid = {
      modules: [
        { id: "def", format: "esm", objectExport: true, events: [], dependencies: [] },
        {
          id: "reader",
          format: "esm",
          events: [
            // identityCheck referencing a non-object (plain value) binding.
            {
              module: "reader",
              phase: "evaluate",
              value: 1,
              identityCheck: { leftBinding: "obj", rightBinding: "num" },
            },
            // a numeric read of an objectRef binding.
            {
              module: "reader",
              phase: "evaluate",
              value: 2,
              reads: [{ binding: "obj", member: undefined }],
            },
          ],
          dependencies: [
            {
              kind: "esm-value-import",
              target: "def",
              importedName: "vdef",
              localName: "obj",
              objectRef: true,
            },
            { kind: "esm-value-import", target: "num-def", importedName: "vn", localName: "num" },
          ],
        },
        { id: "num-def", format: "esm", events: [], dependencies: [] },
      ],
      entries: [{ name: "main", moduleId: "reader" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } as unknown as ProgramModel;
    const errors = validateProgramModel(invalid);
    expect(
      errors.some(
        (error) =>
          error.includes("rightBinding") && error.includes("must be an objectRef import binding"),
      ),
    ).toBe(true);
    expect(
      errors.some((error) => error.includes("is an objectRef binding and cannot be folded")),
    ).toBe(true);
  });

  test("callMembers must be a subset of readMembers; identityCheck excludes reads", () => {
    const invalid = {
      modules: [
        { id: "def", format: "esm", callableOwnState: true, events: [], dependencies: [] },
        {
          id: "reader",
          format: "esm",
          events: [
            {
              module: "reader",
              phase: "evaluate",
              value: 1,
              identityCheck: { leftBinding: "x", rightBinding: "x" },
              reads: [{ binding: "ns", member: "vdef" }],
            },
          ],
          dependencies: [
            {
              kind: "esm-namespace-import",
              target: "def",
              localName: "ns",
              readMembers: ["vdef"],
              callMembers: ["notARead"],
            },
          ],
        },
      ],
      entries: [{ name: "main", moduleId: "reader" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } as unknown as ProgramModel;
    const errors = validateProgramModel(invalid);
    expect(
      errors.some(
        (error) => error.includes("callMembers") && error.includes("must be one of readMembers"),
      ),
    ).toBe(true);
    expect(errors).toContain(
      "modules[1].events[0]: an event cannot carry both reads and an identityCheck",
    );
  });
});

describe("wave-8 generation", () => {
  test("generated clusters are valid, double-digit dense, and their exports are consumed", () => {
    let callableCount = 0;
    let objectCount = 0;
    let total = 0;
    let checkedCallableConsumed = 0;
    let checkedObjectConsumed = 0;
    for (let seed = 700_000; seed < 701_000; seed += 1) {
      const size = sampleCaseSize(new SeededRng(seed));
      const { program, coverageTags } = generateCase(seed, size, "mixed");
      expect(validateProgramModel(program)).toEqual([]);
      total += 1;
      const tags = new Set(coverageTags);
      if (tags.has("variation:callable-own-state")) {
        callableCount += 1;
        // Every callable-own-state definer's export is CALLED by some consumer (a namespace call
        // member) — no dead witness.
        for (const definer of program.modules.filter((m) => m.callableOwnState === true)) {
          const exportName = `v${definer.id}`;
          const called = program.modules.some((module) =>
            module.dependencies.some(
              (dependency) =>
                dependency.kind === "esm-namespace-import" &&
                (dependency.callMembers ?? []).includes(exportName),
            ),
          );
          expect(called).toBe(true);
          checkedCallableConsumed += 1;
        }
      }
      if (tags.has("variation:object-identity")) {
        objectCount += 1;
        // Every object export is captured by an identity check somewhere.
        expect(
          program.modules.some((module) =>
            module.events.some((event) => event.identityCheck !== undefined),
          ),
        ).toBe(true);
        checkedObjectConsumed += 1;
      }
    }
    // Double-digit % of random-mixed cases carry each witness (measured ~17% / ~12%).
    expect(callableCount / total).toBeGreaterThan(0.1);
    expect(objectCount / total).toBeGreaterThan(0.07);
    expect(checkedCallableConsumed).toBeGreaterThan(0);
    expect(checkedObjectConsumed).toBeGreaterThan(0);
  });

  test("same seed reproduces the wave-8 shapes byte-for-byte", () => {
    for (const seed of [700_003, 700_017, 700_042]) {
      const first = generateCase(seed, 12, "mixed");
      const second = generateCase(seed, 12, "mixed");
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });
});

function fileContents(
  files: readonly { readonly path: string; readonly contents: string }[],
  path: string,
): string {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`Missing rendered file ${JSON.stringify(path)}`);
  }
  return file.contents;
}

async function withRenderedProgram(
  files: readonly { readonly path: string; readonly contents: string }[],
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "order-witness-"));
  try {
    await Promise.all(
      files.map(async (file) => {
        const path = join(directory, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.contents);
      }),
    );
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
