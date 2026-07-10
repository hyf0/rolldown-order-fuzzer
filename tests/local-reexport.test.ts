import { describe, expect, test } from "vite-plus/test";

import { analyzeProgram } from "../src/analyzed-program.ts";
import { deriveCoverageTags } from "../src/generate.ts";
import type { ModuleModel, ProgramModel } from "../src/model.ts";
import { readableBindingsOf } from "../src/model.ts";
import { candidates } from "../src/shrink.ts";
import { renderProgram } from "../src/render.ts";
import { validateProgramModel } from "../src/validate-model.ts";
import { fileContents } from "./fixtures.ts";

/// The camunda package-barrel shape (M4): a module that IMPORTS a binding, runs its OWN side effect,
/// and re-exports the binding through a source-less `export { X };` clause — a LIVE import plus a
/// local export, distinct from the source-form `export { X } from "..."` a pure barrel uses.
function camundaProgram(overrides?: {
  readonly barrelEvents?: ProgramModel["modules"][number]["events"];
  readonly barrelReads?: boolean;
}): ProgramModel {
  return {
    modules: [
      {
        id: "entry",
        format: "esm",
        dependencies: [
          { kind: "esm-value-import", target: "barrel", importedName: "vx", localName: "e_vx" },
        ],
        events: [{ module: "entry", phase: "evaluate", value: 5, reads: [{ binding: "e_vx" }] }],
      },
      {
        id: "barrel",
        format: "esm",
        dependencies: [
          {
            kind: "esm-local-reexport",
            target: "def",
            sourceName: "vdef",
            localName: "b_vdef",
            exportedName: "vx",
          },
        ],
        events:
          overrides?.barrelEvents ??
          (overrides?.barrelReads === true
            ? [{ module: "barrel", phase: "evaluate", value: 20, reads: [{ binding: "b_vdef" }] }]
            : [{ module: "barrel", phase: "evaluate", value: 20 }]),
      },
      {
        id: "def",
        format: "esm",
        dependencies: [],
        events: [{ module: "def", phase: "evaluate", value: 7 }],
      },
    ],
    entries: [{ name: "main", moduleId: "entry" }],
    schedule: [{ kind: "import-entry", entry: "main" }],
  };
}

describe("local re-export (camunda shape, M4)", () => {
  test("renders the live import in its dependency slot and the source-less export clause", () => {
    const rendered = renderProgram(analyzeProgram(camundaProgram()));
    const barrel = fileContents(rendered.files, "module-0001.mjs");
    expect(barrel).toContain('import { vdef as b_vdef } from "./module-0002.mjs";');
    expect(barrel).toContain("export { b_vdef as vx };");
    // The source-form `export { … } from` must NOT appear — the two-statement local form is the point.
    expect(barrel).not.toContain("export { vdef as vx } from");
    // The barrel's own side effect (the camunda ingredient) renders alongside the re-export.
    expect(barrel).toContain('"module":"barrel"');
  });

  test("renders `export { x };` without an alias when local and exported names match", () => {
    const program = camundaProgram();
    const barrel = program.modules[1];
    const modules = program.modules.map(
      (module): ModuleModel =>
        module === barrel
          ? ({
              ...module,
              dependencies: [
                {
                  kind: "esm-local-reexport" as const,
                  target: "def",
                  sourceName: "vdef",
                  localName: "vx",
                  exportedName: "vx",
                },
              ],
            } as ModuleModel)
          : module,
    );
    const rendered = renderProgram(analyzeProgram({ ...program, modules }));
    expect(fileContents(rendered.files, "module-0001.mjs")).toContain("export { vx };");
  });

  test("routes demand through the local re-export to the definer (supply via a `local` hop)", () => {
    const analyzed = analyzeProgram(camundaProgram());
    const consumption = analyzed.plan.consumptions.find(
      (record) => record.consumerModuleId === "entry" && record.demandedName === "vx",
    );
    expect(consumption?.supply.status).toBe("supplied");
    if (consumption?.supply.status === "supplied") {
      expect(consumption.supply.origin).toEqual({ moduleId: "def", exportName: "vdef" });
      expect(consumption.supply.hops).toEqual([{ via: "local", through: "barrel" }]);
    }
    // The definer synthesizes vdef; the barrel synthesizes nothing (the local re-export provides vx).
    expect(analyzed.plan.requestedNames.get("def")).toEqual(["vdef"]);
  });

  test("the import half is a LIVE numeric demand — an unsupplied source name is rejected", () => {
    const program = camundaProgram();
    const modules = program.modules.map(
      (module): ModuleModel =>
        module.id === "barrel"
          ? ({
              ...module,
              dependencies: [
                {
                  kind: "esm-local-reexport" as const,
                  target: "starBarrel",
                  sourceName: "default",
                  localName: "b_d",
                  exportedName: "vx",
                },
              ],
            } as ModuleModel)
          : module,
    );
    const withStar: ProgramModel = {
      ...program,
      modules: [
        ...modules,
        {
          id: "starBarrel",
          format: "esm",
          dependencies: [{ kind: "esm-reexport-star", target: "def" }],
          events: [],
        },
      ],
    };
    const errors = validateProgramModel(analyzeProgram(withStar));
    expect(errors.some((error) => error.includes("unsupplied"))).toBe(true);
  });

  test("the local binding is readable — an event may fold it, and its capability is direct", () => {
    expect(
      readableBindingsOf([
        {
          kind: "esm-local-reexport",
          target: "def",
          sourceName: "vdef",
          localName: "b_vdef",
          exportedName: "vx",
        },
      ]),
    ).toEqual([{ binding: "b_vdef" }]);
    expect(validateProgramModel(analyzeProgram(camundaProgram({ barrelReads: true })))).toEqual([]);
  });

  test("a duplicate exported name across named and local re-exports is rejected", () => {
    const program = camundaProgram();
    const modules = program.modules.map(
      (module): ModuleModel =>
        module.id === "barrel"
          ? ({
              ...module,
              dependencies: [
                ...module.dependencies,
                {
                  kind: "esm-reexport-named" as const,
                  target: "def",
                  sourceName: "vdef",
                  exportedName: "vx",
                },
              ],
            } as ModuleModel)
          : module,
    );
    const errors = validateProgramModel(analyzeProgram({ ...program, modules }));
    expect(errors.some((error) => error.includes("duplicate named re-export"))).toBe(true);
  });

  test("a local re-export that closes a cycle is rejected (TDZ)", () => {
    const program: ProgramModel = {
      modules: [
        {
          id: "a",
          format: "esm",
          dependencies: [
            {
              kind: "esm-local-reexport",
              target: "b",
              sourceName: "vb",
              localName: "a_vb",
              exportedName: "vb2",
            },
          ],
          events: [{ module: "a", phase: "evaluate", value: 1 }],
        },
        {
          id: "b",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "a" }],
          events: [{ module: "b", phase: "evaluate", value: 2 }],
        },
        {
          id: "reader",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "a", importedName: "vb2", localName: "r" },
          ],
          events: [{ module: "reader", phase: "evaluate", value: 3, reads: [{ binding: "r" }] }],
        },
      ],
      entries: [{ name: "main", moduleId: "reader" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    };
    const errors = validateProgramModel(analyzeProgram(program));
    expect(errors.some((error) => error.includes("local re-export cannot close a cycle"))).toBe(
      true,
    );
  });

  test("a CJS module cannot carry a local re-export", () => {
    const program = camundaProgram();
    const modules = program.modules.map((module) =>
      module.id === "barrel" ? ({ ...module, format: "cjs" } as never) : module,
    );
    const errors = validateProgramModel(analyzeProgram({ ...program, modules }));
    expect(errors.some((error) => error.includes("CJS modules cannot use"))).toBe(true);
  });

  test("tags: reexport-local plus the with-own-effect mechanism when the module carries events", () => {
    const withEffect = deriveCoverageTags(analyzeProgram(camundaProgram()));
    expect(withEffect).toContain("variation:reexport-local");
    expect(withEffect).toContain("mechanism:local-reexport-with-own-effect");
    const pure = deriveCoverageTags(analyzeProgram(camundaProgram({ barrelEvents: [] })));
    expect(pure).toContain("variation:reexport-local");
    expect(pure).not.toContain("mechanism:local-reexport-with-own-effect");
  });

  test("shrink offers the named-form downgrade and it validates on its own", () => {
    const program = camundaProgram({ barrelReads: true });
    const downgrades = [...candidates(program)].filter((candidate) =>
      candidate.modules.some((module) =>
        module.dependencies.some(
          (dependency) =>
            dependency.kind === "esm-reexport-named" &&
            dependency.exportedName === "vx" &&
            module.id === "barrel",
        ),
      ),
    );
    expect(downgrades.length).toBe(1);
    const downgraded = downgrades[0];
    expect(downgraded).toBeDefined();
    if (downgraded !== undefined) {
      // The event read of the dropped local binding is dropped with it, so the candidate is valid.
      expect(validateProgramModel(analyzeProgram(downgraded))).toEqual([]);
      const barrel = downgraded.modules.find((module) => module.id === "barrel");
      expect(barrel?.events.every((event) => (event.reads ?? []).length === 0)).toBe(true);
    }
  });
});
