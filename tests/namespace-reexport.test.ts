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

/// FW-B deliverable 3 — the exotic top-level import-read forms the rebuilt #10180 detector must classify.
/// Built on the M7 namespace re-export fixture above (a nested `outer.ns.vinner` read).
function exoticReadProgram(read: {
  readonly computedHopIndex?: number;
  readonly alias?: true;
  readonly computed?: true;
}): ProgramModel {
  const program = nsReexportProgram();
  return {
    ...program,
    modules: [
      program.modules[0]!,
      program.modules[1]!,
      {
        ...program.modules[2]!,
        events: [
          {
            module: "ent",
            phase: "evaluate",
            value: 1,
            reads: [{ binding: "outer", memberPath: ["ns", "vinner"], ...read }],
          },
        ],
      },
    ],
  };
}

describe("exotic import-read forms (FW-B deliverable 3, #10180 frontier)", () => {
  test("a computed INTERMEDIATE hop renders `outer[<key>].vinner` (a[imp].y) and validates green", () => {
    const analyzed = analyzeProgram(exoticReadProgram({ computedHopIndex: 0 }));
    expect(validateProgramModel(analyzed)).toEqual([]);
    const entry = fileContents(renderProgram(analyzed).files, "module-0002.mjs");
    // The `ns` hop is computed (a split-literal runtime key), the `.vinner` tail stays static.
    expect(entry).toContain('outer["n" + "s"].vinner');
    expect(entry).not.toContain("outer.ns.vinner");
  });

  test("an ALIASED namespace read renders `const outer_alias = outer;` then `outer_alias.ns.vinner`", () => {
    const analyzed = analyzeProgram(exoticReadProgram({ alias: true }));
    expect(validateProgramModel(analyzed)).toEqual([]);
    const entry = fileContents(renderProgram(analyzed).files, "module-0002.mjs");
    expect(entry).toContain("const outer_alias = outer;");
    expect(entry).toContain("outer_alias.ns.vinner");
  });

  test("computedHopIndex must be an INTERMEDIATE hop (a deepest index is rejected)", () => {
    // Index 1 is the deepest hop of `[ns, vinner]` — no static tail follows, so it is not intermediate.
    const errors = validateProgramModel(analyzeProgram(exoticReadProgram({ computedHopIndex: 1 })));
    expect(errors.some((e) => e.includes("computedHopIndex") && e.includes("intermediate"))).toBe(
      true,
    );
  });

  test("computed (deepest) and computedHopIndex (intermediate) are mutually exclusive", () => {
    const errors = validateProgramModel(
      analyzeProgram(exoticReadProgram({ computed: true, computedHopIndex: 0 })),
    );
    expect(errors.some((e) => e.includes("cannot set both"))).toBe(true);
  });

  test("alias and computedHopIndex are rejected on a non-namespace (value import) binding", () => {
    const program: ProgramModel = {
      modules: [
        { id: "def", format: "esm", dependencies: [], events: [], inferredPure: true, pureBase: 7 },
        {
          id: "ent",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "def", importedName: "vdef", localName: "d" },
          ],
          events: [
            { module: "ent", phase: "evaluate", value: 1, reads: [{ binding: "d", alias: true }] },
          ],
        },
      ],
      entries: [{ name: "main", moduleId: "ent" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    };
    const errors = validateProgramModel(analyzeProgram(program));
    expect(errors.some((e) => e.includes(".alias") && e.includes("namespace import binding"))).toBe(
      true,
    );
  });
});
