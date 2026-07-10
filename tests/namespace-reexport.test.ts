import { describe, expect, test } from "vite-plus/test";

import { analyzeProgram } from "../src/analyzed-program.ts";
import type { ProgramModel } from "../src/model.ts";
import { renderProgram } from "../src/render.ts";
import { validateProgramModel } from "../src/validate-model.ts";
import { fileContents } from "./fixtures.ts";

/// The `export * as ns from` namespace re-export (M7): a barrel re-exports an inner definer's whole
/// namespace under one name, and an entry reads a NESTED member through it (`outer.ns.member`).
function nsReexportProgram(overrides?: {
  readonly barrelExport?: string;
  readonly readPath?: readonly string[];
}): ProgramModel {
  return {
    modules: [
      {
        id: "inner",
        format: "esm",
        dependencies: [],
        events: [],
        inferredPure: true,
        pureBase: 42,
      },
      {
        id: "bar",
        format: "esm",
        dependencies: [
          {
            kind: "esm-reexport-namespace",
            target: "inner",
            exportedName: overrides?.barrelExport ?? "ns",
          },
        ],
        events: [],
      },
      {
        id: "ent",
        format: "esm",
        dependencies: [
          {
            kind: "esm-namespace-import",
            target: "bar",
            localName: "outer",
            readMembers: [overrides?.readPath ?? ["ns", "vinner"]],
          },
        ],
        events: [
          {
            module: "ent",
            phase: "evaluate",
            value: 1,
            reads: [{ binding: "outer", memberPath: overrides?.readPath ?? ["ns", "vinner"] }],
          },
        ],
      },
    ],
    entries: [{ name: "main", moduleId: "ent" }],
    schedule: [{ kind: "import-entry", entry: "main" }],
  };
}

describe("export * as ns from (namespace re-export, M7)", () => {
  test("renders the barrel as `export * as ns from` and validates green", () => {
    const analyzed = analyzeProgram(nsReexportProgram());
    expect(validateProgramModel(analyzed)).toEqual([]);
    const barrel = fileContents(renderProgram(analyzed).files, "module-0001.mjs");
    expect(barrel).toContain('export * as ns from "./module-0000.mjs";');
  });

  test("a nested read routes the deeper member demand to the inner definer's origin", () => {
    const analyzed = analyzeProgram(nsReexportProgram());
    // The DEEPEST member (`vinner`) is demanded on `inner` (the namespace's origin), not on the barrel.
    const consumption = analyzed.plan.consumptions.find(
      (record) => record.consumerModuleId === "ent" && record.demandedName === "vinner",
    );
    expect(consumption?.target).toBe("inner");
    expect(consumption?.supply.status).toBe("supplied");
    // `inner` synthesizes the demanded name; the barrel's namespace name `ns` is demanded ON the barrel.
    expect(analyzed.plan.requestedNames.get("inner")).toEqual(["vinner"]);
    expect(analyzed.plan.requestedNames.get("bar")).toEqual(["ns"]);
  });

  test("the nested read renders `outer.ns.vinner` and folds the inner value", () => {
    const entry = fileContents(
      renderProgram(analyzeProgram(nsReexportProgram())).files,
      "module-0002.mjs",
    );
    expect(entry).toContain("outer.ns.vinner");
  });

  test("rejects a malformed nested read whose intermediate is not a namespace re-export", () => {
    // The barrel re-exports its namespace as `ns`, but the read routes through `X` — no `export * as X`.
    const errors = validateProgramModel(
      analyzeProgram(nsReexportProgram({ readPath: ["X", "vinner"] })),
    );
    expect(
      errors.some(
        (error) =>
          error.includes("readMembers[0][0]") && error.includes("is not a namespace re-export"),
      ),
    ).toBe(true);
  });

  test("the namespace re-export shadows a star for its own name (routing agrees)", () => {
    // A co-located `export * from other` on the barrel; demand for `ns` must NOT forward through it.
    const program = nsReexportProgram();
    const withStar: ProgramModel = {
      ...program,
      modules: [
        program.modules[0]!,
        {
          id: "bar",
          format: "esm",
          dependencies: [
            { kind: "esm-reexport-namespace", target: "inner", exportedName: "ns" },
            { kind: "esm-reexport-star", target: "other" },
          ],
          events: [],
        },
        program.modules[2]!,
        {
          id: "other",
          format: "esm",
          dependencies: [],
          events: [],
          inferredPure: true,
          pureBase: 9,
        },
      ],
    };
    const analyzed = analyzeProgram(withStar);
    expect(validateProgramModel(analyzed)).toEqual([]);
    // `ns` is a local definer on the barrel (the namespace re-export), NOT forwarded through the star.
    expect(analyzed.plan.requestedNames.get("other") ?? []).not.toContain("ns");
  });
});
