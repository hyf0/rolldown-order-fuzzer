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
import { parseArgs, detectArtifactWrapMode } from "../src/shrink.ts";
import { validateProgramModel } from "../src/validate-model.ts";

// A complete family-A conjunction: an inferred-pure definer (m_def) STAR-re-exported through a barrel
// (m_bar) that two entries namespace-import, one reading the definer's value and one the sibling's.
function conjunctionProgram(): ProgramModel {
  return {
    modules: [
      {
        id: "m_def",
        format: "esm",
        inferredPure: true,
        pureBase: 77,
        events: [],
        dependencies: [],
      },
      {
        id: "m_sib",
        format: "esm",
        events: [{ module: "m_sib", phase: "evaluate", value: 11 }],
        dependencies: [],
      },
      {
        id: "m_bar",
        format: "esm",
        events: [],
        dependencies: [
          { kind: "esm-reexport-star", target: "m_def" },
          {
            kind: "esm-reexport-named",
            target: "m_sib",
            sourceName: "vm_sib",
            exportedName: "vm_sib",
          },
        ],
      },
      {
        id: "m_e1",
        format: "esm",
        events: [
          {
            module: "m_e1",
            phase: "evaluate",
            value: 100,
            reads: [{ binding: "ns1", member: "vm_def" }],
          },
        ],
        dependencies: [
          {
            kind: "esm-namespace-import",
            target: "m_bar",
            localName: "ns1",
            readMembers: ["vm_def"],
          },
        ],
      },
      {
        id: "m_e2",
        format: "esm",
        events: [
          {
            module: "m_e2",
            phase: "evaluate",
            value: 200,
            reads: [{ binding: "ns2", member: "vm_sib" }],
          },
        ],
        dependencies: [
          {
            kind: "esm-namespace-import",
            target: "m_bar",
            localName: "ns2",
            readMembers: ["vm_sib"],
          },
        ],
      },
    ],
    entries: [
      { name: "entry-m_e1", moduleId: "m_e1" },
      { name: "entry-m_e2", moduleId: "m_e2" },
    ],
    schedule: [
      { kind: "import-entry", entry: "entry-m_e1" },
      { kind: "import-entry", entry: "entry-m_e2" },
    ],
  } as ProgramModel;
}

describe("inferred-pure definer rendering", () => {
  test("emits only pure statements: a build function, a PURE-annotated call, no events", () => {
    const rendered = renderProgram(conjunctionProgram());
    const definer = fileContents(rendered.files, "module-0000.mjs");

    // A local build function + a /* @__PURE__ */-annotated call assigned to a const, then exported.
    expect(definer).toContain("function __pureBuild0() { return 77; }");
    expect(definer).toContain("const __pureValue0 = /* @__PURE__ */ __pureBuild0();");
    expect(definer).toContain("export { __pureValue0 as vm_def };");
    // Purity of the emitted statements: no event calls, no globalThis writes at the top level.
    expect(definer).not.toContain("__orderEvent");
    expect(definer).not.toContain("globalThis");
    // A plain `const x = <literal>` would be constant-folded and inlined, masking a dropped init.
    expect(definer).not.toContain("const __pureValue0 = 77;");
  });

  test("the barrel star-re-exports the definer and named-re-exports the sibling", () => {
    const rendered = renderProgram(conjunctionProgram());
    const barrel = fileContents(rendered.files, "module-0002.mjs");
    expect(barrel).toContain('export * from "./module-0000.mjs";');
    expect(barrel).toContain('export { vm_sib } from "./module-0001.mjs";');
  });

  test("the source graph runs cleanly (the oracle baseline): the definer's value flows", async () => {
    const rendered = renderProgram(conjunctionProgram());
    await withRenderedProgram(rendered.files, async (directory) => {
      const outcome = await executeManifest(join(directory, rendered.schedulePath));
      expect(outcome.status).toBe("ok");
      // m_e1 reads the pure definer's value (77) folded onto 100; m_e2 reads the sibling's (11 -> 11).
      const values = outcome.events
        .filter((event): event is Extract<typeof event, { module: string }> => "module" in event)
        .map((event) => [event.module, event.value]);
      expect(values).toContainEqual(["m_e1", 177]);
      expect(values).toContainEqual(["m_sib", 11]);
    });
  });
});

describe("function-hidden and computed-member read rendering", () => {
  test("a function-hidden read runs inside a local function called at init; the value still folds", async () => {
    const program: ProgramModel = {
      modules: [
        {
          id: "leaf",
          format: "esm",
          events: [{ module: "leaf", phase: "evaluate", value: 5 }],
          dependencies: [],
        },
        {
          id: "entry",
          format: "esm",
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 40,
              reads: [{ binding: "leafValue", member: undefined }],
              hiddenReadFn: true,
            },
          ],
          dependencies: [
            {
              kind: "esm-value-import",
              target: "leaf",
              importedName: "vleaf",
              localName: "leafValue",
            },
          ],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } as ProgramModel;

    const rendered = renderProgram(program);
    const entry = fileContents(rendered.files, "module-0001.mjs");
    // The read is lexically inside a function body; top-level code calls it in the payload.
    expect(entry).toContain("function __hiddenRead0() { return leafValue; }");
    expect(entry).toContain("value: 40 + __hiddenRead0()");

    await withRenderedProgram(rendered.files, async (directory) => {
      const outcome = await executeManifest(join(directory, rendered.schedulePath));
      expect(outcome.status).toBe("ok");
      // leaf exports its base (5); the folded value is 40 + 5 = 45, identical to a top-level read.
      const entryEvent = outcome.events.find(
        (event) => "module" in event && event.module === "entry",
      );
      expect(entryEvent).toMatchObject({ value: 45 });
    });
  });

  test("a computed member read renders binding[key] and folds to the same value", async () => {
    const program: ProgramModel = {
      modules: [
        {
          id: "leaf",
          format: "esm",
          events: [{ module: "leaf", phase: "evaluate", value: 9 }],
          dependencies: [],
        },
        {
          id: "entry",
          format: "esm",
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 30,
              reads: [{ binding: "ns", member: "vleaf", computed: true }],
            },
          ],
          dependencies: [
            {
              kind: "esm-namespace-import",
              target: "leaf",
              localName: "ns",
              readMembers: ["vleaf"],
            },
          ],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } as ProgramModel;

    const rendered = renderProgram(program);
    const entry = fileContents(rendered.files, "module-0001.mjs");
    // A computed access `ns[<runtime key>]`, not `ns.vleaf` — the member name is built at runtime.
    expect(entry).toContain('ns["vl" + "eaf"]');
    expect(entry).not.toContain("ns.vleaf");

    await withRenderedProgram(rendered.files, async (directory) => {
      const outcome = await executeManifest(join(directory, rendered.schedulePath));
      expect(outcome.status).toBe("ok");
      const entryEvent = outcome.events.find(
        (event) => "module" in event && event.module === "entry",
      );
      expect(entryEvent).toMatchObject({ value: 39 });
    });
  });
});

describe("family-A conjunction coverage tag", () => {
  test("fires only when ALL ingredients are present", () => {
    const complete = conjunctionProgram();
    expect(deriveCoverageTags(complete)).toContain("mechanism:pure-definer-behind-barrel");
    expect(deriveCoverageTags(complete)).toContain("variation:inferred-pure-definer");
  });

  test("a NAMED (not star) re-export of the definer does NOT fire the tag (the bug needs the star)", () => {
    const program = conjunctionProgram();
    const barrel = program.modules[2];
    const named = {
      ...program,
      modules: program.modules.map((module) =>
        module === barrel
          ? {
              ...module,
              dependencies: [
                {
                  kind: "esm-reexport-named",
                  target: "m_def",
                  sourceName: "vm_def",
                  exportedName: "vm_def",
                },
                {
                  kind: "esm-reexport-named",
                  target: "m_sib",
                  sourceName: "vm_sib",
                  exportedName: "vm_sib",
                },
              ],
            }
          : module,
      ),
    } as ProgramModel;
    expect(validateProgramModel(named)).toEqual([]);
    expect(deriveCoverageTags(named)).not.toContain("mechanism:pure-definer-behind-barrel");
  });

  test("a single barrel importer does NOT fire the tag (needs >= 2 importers)", () => {
    const program = conjunctionProgram();
    const oneImporter = {
      ...program,
      modules: program.modules.filter((module) => module.id !== "m_e2"),
      entries: program.entries.filter((entry) => entry.moduleId !== "m_e2"),
      schedule: program.schedule.filter(
        (op) => op.kind === "trigger-dynamic-import" || op.entry !== "entry-m_e2",
      ),
    } as ProgramModel;
    expect(validateProgramModel(oneImporter)).toEqual([]);
    expect(deriveCoverageTags(oneImporter)).not.toContain("mechanism:pure-definer-behind-barrel");
  });

  test("no inferred-pure definer means no tag", () => {
    const program = conjunctionProgram();
    const notPure = {
      ...program,
      modules: program.modules.map((module) =>
        module.id === "m_def"
          ? {
              id: "m_def",
              format: "esm",
              events: [{ module: "m_def", phase: "evaluate", value: 1 }],
              dependencies: [],
            }
          : module,
      ),
    } as ProgramModel;
    expect(deriveCoverageTags(notPure)).not.toContain("mechanism:pure-definer-behind-barrel");
  });
});

describe("family-A/B generation", () => {
  test("generated inferred-pure definers are pure and always read (no dead coverage)", () => {
    let checkedDefiners = 0;
    let checkedConjunctions = 0;
    for (let seed = 20_000; seed < 21_000; seed += 1) {
      const size = sampleCaseSize(new SeededRng(seed));
      const { program } = generateCase(seed, size);
      expect(validateProgramModel(program)).toEqual([]);
      const pureDefiners = program.modules.filter((module) => module.inferredPure === true);
      for (const definer of pureDefiners) {
        checkedDefiners += 1;
        // Purity of emitted statements: no events, only value-only ESM deps, ESM, a numeric base.
        expect(definer.events).toEqual([]);
        expect(definer.format).toBe("esm");
        expect(typeof definer.pureBase).toBe("number");
        expect(definer.sideEffectFree).toBeUndefined();
        // Always read by someone (else legally droppable -> dead coverage): its export name is
        // demanded through the barrel by a namespace read.
        const exportName = `v${definer.id}`;
        const read = program.modules.some((module) =>
          module.dependencies.some(
            (dependency) =>
              dependency.kind === "esm-namespace-import" &&
              dependency.readMembers.includes(exportName),
          ),
        );
        expect(read).toBe(true);
      }
      if (deriveCoverageTags(program).includes("mechanism:pure-definer-behind-barrel")) {
        checkedConjunctions += 1;
      }
    }
    // The conjunction is biased to be frequent, so the sweep must actually exercise both.
    expect(checkedDefiners).toBeGreaterThan(0);
    expect(checkedConjunctions).toBeGreaterThan(0);
  });

  test("function-hidden reads appear on entries and never break validation", () => {
    let sawHiddenOnEntry = false;
    for (let seed = 30_000; seed < 30_400; seed += 1) {
      const { program } = generateCase(seed, 12, "mixed");
      expect(validateProgramModel(program)).toEqual([]);
      const entryIds = new Set(program.entries.map((entry) => entry.moduleId));
      for (const module of program.modules) {
        if (entryIds.has(module.id) && module.events.some((event) => event.hiddenReadFn === true)) {
          sawHiddenOnEntry = true;
        }
      }
    }
    expect(sawHiddenOnEntry).toBe(true);
  });

  test("same seed reproduces byte-for-byte with the new shapes", () => {
    const first = generateCase(6004, 8, "mixed");
    const second = generateCase(6004, 8, "mixed");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // Seed 6004 carries a complete conjunction (used in the acceptance campaign).
    expect(first.coverageTags).toContain("mechanism:pure-definer-behind-barrel");
  });
});

describe("model validation of the wave-7 shapes", () => {
  test("an inferred-pure module rejects events, non-ESM, missing pureBase, and double flags", () => {
    const invalid = {
      modules: [
        // events on a pure module, and no pureBase.
        {
          id: "a",
          format: "esm",
          inferredPure: true,
          events: [{ module: "a", phase: "evaluate", value: 1 }],
          dependencies: [],
        },
        // both flags at once.
        {
          id: "b",
          format: "esm",
          inferredPure: true,
          sideEffectFree: true,
          pureBase: 3,
          events: [],
          dependencies: [],
        },
        // CJS pure definer.
        { id: "c", format: "cjs", inferredPure: true, pureBase: 3, events: [], dependencies: [] },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } as unknown as ProgramModel;
    const errors = validateProgramModel(invalid);
    expect(errors).toContain(
      "modules[0]: an inferred-pure module must not emit events; an event is a top-level side effect",
    );
    expect(errors).toContain(
      "modules[0].pureBase: an inferred-pure module requires a finite numeric pureBase",
    );
    expect(errors).toContain("modules[1]: a module cannot be both inferredPure and sideEffectFree");
    expect(errors).toContain("modules[2]: an inferred-pure module must be ESM, received cjs");
  });

  test("hiddenReadFn requires reads; computed is namespace-only", () => {
    const invalid = {
      modules: [
        {
          id: "leaf",
          format: "esm",
          events: [{ module: "leaf", phase: "evaluate", value: 1 }],
          dependencies: [],
        },
        {
          id: "reader",
          format: "esm",
          events: [
            // hiddenReadFn with no reads.
            { module: "reader", phase: "evaluate", value: 2, hiddenReadFn: true },
            // computed on a plain value-import binding (not a namespace).
            {
              module: "reader",
              phase: "evaluate",
              value: 3,
              reads: [{ binding: "v", member: undefined, computed: true }],
            },
          ],
          dependencies: [
            { kind: "esm-value-import", target: "leaf", importedName: "vleaf", localName: "v" },
          ],
        },
      ],
      entries: [{ name: "main", moduleId: "reader" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } as unknown as ProgramModel;
    const errors = validateProgramModel(invalid);
    expect(errors).toContain("modules[1].events[0]: hiddenReadFn requires a non-empty reads array");
    expect(
      errors.some((error) =>
        error.includes("a computed member read is only valid on a namespace import"),
      ),
    ).toBe(true);
  });
});

describe("shrinker --wrap-all plumbing", () => {
  test("--wrap-all selects wrap-all explicitly; default is on-demand", () => {
    expect(parseArgs(["--model", "m.json"])).toMatchObject({
      onDemandWrapping: true,
      wrapModeExplicit: false,
    });
    expect(parseArgs(["--model", "m.json", "--wrap-all"])).toMatchObject({
      onDemandWrapping: false,
      wrapModeExplicit: true,
    });
    expect(parseArgs(["--model", "m.json", "--on-demand"])).toMatchObject({
      onDemandWrapping: true,
      wrapModeExplicit: true,
    });
  });

  test("the failing wrap mode is auto-read from a sibling replay.json", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-shrink-wrap-"));
    try {
      await writeFile(join(directory, "model.json"), "{}");
      await writeFile(
        join(directory, "replay.json"),
        JSON.stringify({ options: { onDemandWrapping: false } }),
      );
      expect(await detectArtifactWrapMode(join(directory, "model.json"))).toBe(false);
      await writeFile(
        join(directory, "replay.json"),
        JSON.stringify({ options: { onDemandWrapping: true } }),
      );
      expect(await detectArtifactWrapMode(join(directory, "model.json"))).toBe(true);
      // No replay.json -> undefined (keep the default).
      expect(
        await detectArtifactWrapMode(join(directory, "missing", "model.json")),
      ).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
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
  const directory = await mkdtemp(join(tmpdir(), "order-bug-families-"));
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
