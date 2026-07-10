import { describe, expect, test } from "vite-plus/test";

import { analyzeProgram } from "../src/analyzed-program.ts";
import type { ModuleModel, ProgramModel } from "../src/model.ts";
import {
  metadataPureModuleIds,
  packageMembershipOf,
  sideEffectsPatternMatches,
} from "../src/model.ts";
import { renderProgram } from "../src/render.ts";
import { validateProgramModel } from "../src/validate-model.ts";
import { fileContents } from "./fixtures.ts";

/// A two-package program exercising the whole layout surface: a bare main import, a subpath import,
/// a package-to-package bare import, a package-to-root relative import, and partial sideEffects
/// metadata (the array form) with an unmatched pure member.
function twoPackageProgram(): ProgramModel {
  return {
    modules: [
      {
        id: "entry",
        format: "esm",
        dependencies: [
          { kind: "esm-value-import", target: "abar", importedName: "va", localName: "e_va" },
          { kind: "esm-value-import", target: "ainner", importedName: "vi", localName: "e_vi" },
          { kind: "esm-value-import", target: "bmain", importedName: "vb", localName: "e_vb" },
        ],
        events: [
          {
            module: "entry",
            phase: "evaluate",
            value: 1,
            reads: [{ binding: "e_va" }, { binding: "e_vi" }, { binding: "e_vb" }],
          },
        ],
      },
      // Package "pkga": main barrel (unlisted -> metadata-pure), a listed side-effectful sibling, and
      // an inner subpath member.
      {
        id: "abar",
        format: "esm",
        dependencies: [
          { kind: "esm-reexport-named", target: "asib", sourceName: "va", exportedName: "va" },
        ],
        events: [],
      },
      {
        id: "asib",
        format: "esm",
        dependencies: [
          { kind: "esm-value-import", target: "bmain", importedName: "vb", localName: "a_vb" },
          { kind: "esm-value-import", target: "roothelper", importedName: "vr", localName: "a_vr" },
        ],
        events: [
          {
            module: "asib",
            phase: "evaluate",
            value: 10,
            reads: [{ binding: "a_vb" }, { binding: "a_vr" }],
          },
        ],
      },
      { id: "ainner", format: "esm", dependencies: [], events: [] },
      // Package "pkgb": a single-member sideEffects:true package.
      {
        id: "bmain",
        format: "esm",
        dependencies: [],
        events: [{ module: "bmain", phase: "evaluate", value: 100 }],
      },
      // A root module a package member reaches back out to.
      { id: "roothelper", format: "esm", dependencies: [], events: [] },
    ],
    entries: [{ name: "main", moduleId: "entry" }],
    schedule: [{ kind: "import-entry", entry: "main" }],
    packages: [
      { name: "pkga", sideEffects: ["./asib.mjs"], moduleIds: ["abar", "asib", "ainner"] },
      { name: "pkgb", sideEffects: true, moduleIds: ["bmain"] },
    ],
  };
}

describe("package/layout rendering", () => {
  test("members render under node_modules with id-named files and a generated package.json", () => {
    const rendered = renderProgram(analyzeProgram(twoPackageProgram()));
    const paths = rendered.files.map((file) => file.path);
    expect(paths).toContain("node_modules/pkga/abar.mjs");
    expect(paths).toContain("node_modules/pkga/asib.mjs");
    expect(paths).toContain("node_modules/pkga/ainner.mjs");
    expect(paths).toContain("node_modules/pkgb/bmain.mjs");
    // Root modules keep the historical index naming.
    expect(paths).toContain("module-0000.mjs");
    expect(paths).toContain("module-0005.mjs");
    const packageJson = JSON.parse(fileContents(rendered.files, "node_modules/pkga/package.json"));
    expect(packageJson).toEqual({
      name: "pkga",
      main: "./abar.mjs",
      sideEffects: ["./asib.mjs"],
    });
    expect(
      JSON.parse(fileContents(rendered.files, "node_modules/pkgb/package.json")).sideEffects,
    ).toBe(true);
  });

  test("cross-package imports use bare specifiers; internal and outward ones stay relative", () => {
    const rendered = renderProgram(analyzeProgram(twoPackageProgram()));
    const entry = fileContents(rendered.files, "module-0000.mjs");
    // Root -> package main: bare name. Root -> non-main member: subpath with the file name.
    expect(entry).toContain('import { va as e_va } from "pkga";');
    expect(entry).toContain('import { vi as e_vi } from "pkga/ainner.mjs";');
    expect(entry).toContain('import { vb as e_vb } from "pkgb";');
    // Package internal: sibling-relative. Package -> package: bare. Package -> root: climbs out.
    const barrel = fileContents(rendered.files, "node_modules/pkga/abar.mjs");
    expect(barrel).toContain('export { va } from "./asib.mjs";');
    const sibling = fileContents(rendered.files, "node_modules/pkga/asib.mjs");
    expect(sibling).toContain('import { vb as a_vb } from "pkgb";');
    expect(sibling).toContain('import { vr as a_vr } from "../../module-0005.mjs";');
  });

  test("a package-free program emits no package.json and keeps the historical layout", () => {
    const program = twoPackageProgram();
    const rendered = renderProgram(
      analyzeProgram({
        modules: [
          program.modules[4] as ModuleModel,
          {
            id: "reader",
            format: "esm",
            dependencies: [
              { kind: "esm-value-import", target: "bmain", importedName: "vb", localName: "r" },
            ],
            events: [{ module: "reader", phase: "evaluate", value: 2, reads: [{ binding: "r" }] }],
          },
        ],
        entries: [{ name: "main", moduleId: "reader" }],
        schedule: [{ kind: "import-entry", entry: "main" }],
      }),
    );
    expect(rendered.files.map((file) => file.path).sort()).toEqual([
      "module-0000.mjs",
      "module-0001.mjs",
      "schedule.json",
    ]);
  });
});

describe("sideEffects metadata resolution", () => {
  test("pattern matching: with/without ./ prefix and * wildcards, over member file names", () => {
    expect(sideEffectsPatternMatches("./asib.mjs", "asib.mjs")).toBe(true);
    expect(sideEffectsPatternMatches("asib.mjs", "asib.mjs")).toBe(true);
    expect(sideEffectsPatternMatches("./asib.*", "asib.mjs")).toBe(true);
    expect(sideEffectsPatternMatches("*.mjs", "asib.mjs")).toBe(true);
    expect(sideEffectsPatternMatches("./nope.mjs", "asib.mjs")).toBe(false);
    // A `*` never invents literal-dot matches elsewhere: the remainder is literal.
    expect(sideEffectsPatternMatches("a*.cjs", "asib.mjs")).toBe(false);
  });

  test("false marks every member pure; an array marks exactly the unmatched members", () => {
    const program = twoPackageProgram();
    expect([...metadataPureModuleIds(program)].sort()).toEqual(["abar", "ainner"]);
    const allPure: ProgramModel = {
      ...program,
      modules: program.modules.map(
        (module): ModuleModel =>
          module.id === "asib"
            ? ({ ...module, dependencies: [], events: [] } as ModuleModel)
            : module,
      ),
      packages: [
        { name: "pkga", sideEffects: false, moduleIds: ["abar", "asib", "ainner"] },
        { name: "pkgb", sideEffects: true, moduleIds: ["bmain"] },
      ],
    };
    expect([...metadataPureModuleIds(allPure)].sort()).toEqual(["abar", "ainner", "asib"]);
    expect(metadataPureModuleIds({ ...program, packages: undefined }).size).toBe(0);
  });

  test("membership: first member is main, one package per module", () => {
    const membership = packageMembershipOf(twoPackageProgram());
    expect(membership.get("abar")?.isMain).toBe(true);
    expect(membership.get("asib")?.isMain).toBe(false);
    expect(membership.get("entry")).toBeUndefined();
  });
});

describe("package validation", () => {
  function withPackages(packages: ProgramModel["packages"]): ProgramModel {
    return { ...twoPackageProgram(), packages };
  }

  test("the canonical two-package program is valid", () => {
    expect(validateProgramModel(analyzeProgram(twoPackageProgram()))).toEqual([]);
  });

  test("rejects invalid names, duplicate names, unknown members, and double membership", () => {
    const errors = validateProgramModel(
      analyzeProgram(
        withPackages([
          { name: "Bad_Name", sideEffects: true, moduleIds: ["abar"] },
          { name: "pkgb", sideEffects: true, moduleIds: ["nope"] },
          { name: "pkgb", sideEffects: true, moduleIds: ["abar"] },
        ]),
      ),
    );
    expect(errors.some((error) => error.includes("invalid package name"))).toBe(true);
    expect(errors.some((error) => error.includes("duplicate package name"))).toBe(true);
    expect(errors.some((error) => error.includes("unknown module id"))).toBe(true);
    expect(errors.some((error) => error.includes("more than one package"))).toBe(true);
  });

  test("rejects an empty package and a malformed sideEffects pattern", () => {
    const errors = validateProgramModel(
      analyzeProgram(
        withPackages([
          { name: "pkga", sideEffects: ["dir/inner.mjs"], moduleIds: ["abar", "asib", "ainner"] },
          { name: "pkgb", sideEffects: true, moduleIds: [] },
        ]),
      ),
    );
    expect(errors.some((error) => error.includes("invalid pattern"))).toBe(true);
    expect(errors.some((error) => error.includes("at least one member"))).toBe(true);
  });

  test("rejects a program carrying BOTH packages and a legacy sideEffectFree flag", () => {
    const program = twoPackageProgram();
    const modules = program.modules.map(
      (module): ModuleModel =>
        module.id === "roothelper" ? ({ ...module, sideEffectFree: true } as ModuleModel) : module,
    );
    const errors = validateProgramModel(analyzeProgram({ ...program, modules }));
    expect(errors.some((error) => error.includes("legacy representation"))).toBe(true);
  });

  test("the metadata-purity contract binds exactly the array-UNMATCHED members", () => {
    // The unmatched barrel gaining an event is rejected; the MATCHED sibling's events are fine.
    const program = twoPackageProgram();
    const modules = program.modules.map(
      (module): ModuleModel =>
        module.id === "abar"
          ? ({
              ...module,
              events: [{ module: "abar", phase: "evaluate", value: 3 }],
            } as ModuleModel)
          : module,
    );
    const errors = validateProgramModel(analyzeProgram({ ...program, modules }));
    expect(
      errors.some(
        (error) =>
          error.includes("metadata-pure package member") && error.includes("must not emit events"),
      ),
    ).toBe(true);
  });

  test("a metadata-pure member may be inferredPure but not callableOwnState", () => {
    const base = twoPackageProgram();
    const inferred: ProgramModel = {
      ...base,
      modules: base.modules.map(
        (module): ModuleModel =>
          module.id === "ainner"
            ? ({ ...module, inferredPure: true, pureBase: 5 } as ModuleModel)
            : module,
      ),
    };
    expect(validateProgramModel(analyzeProgram(inferred))).toEqual([]);
    const callable: ProgramModel = {
      ...base,
      modules: base.modules.map(
        (module): ModuleModel =>
          module.id === "ainner" ? ({ ...module, callableOwnState: true } as ModuleModel) : module,
      ),
    };
    expect(
      validateProgramModel(analyzeProgram(callable)).some((error) =>
        error.includes("cannot be callableOwnState"),
      ),
    ).toBe(true);
  });
});

describe("declared local exports beside a star (the vben index.js shape)", () => {
  function starWithLocalProgram(): ProgramModel {
    return {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "bar", importedName: "vfac", localName: "e_vf" },
            {
              kind: "esm-value-import",
              target: "bar",
              importedName: "vbar",
              localName: "e_vb",
              call: true,
            },
          ],
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "e_vf" }, { binding: "e_vb", call: true }],
            },
          ],
        },
        {
          id: "bar",
          format: "esm",
          localExports: ["vbar"],
          dependencies: [{ kind: "esm-reexport-star", target: "fac" }],
          events: [],
        },
        {
          id: "fac",
          format: "esm",
          dependencies: [],
          events: [{ module: "fac", phase: "evaluate", value: 7 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    };
  }

  test("a declared name synthesizes locally beside the star and shadows it for routing", () => {
    const analyzed = analyzeProgram(starWithLocalProgram());
    expect(validateProgramModel(analyzed)).toEqual([]);
    const vbar = analyzed.plan.consumptions.find((record) => record.demandedName === "vbar");
    expect(vbar?.supply.status).toBe("supplied");
    if (vbar?.supply.status === "supplied") {
      expect(vbar.supply.origin).toEqual({ moduleId: "bar", exportName: "vbar" });
      expect(vbar.supply.hops).toEqual([]);
    }
    // The star-forwarded name still routes through to the facade.
    const vfac = analyzed.plan.consumptions.find((record) => record.demandedName === "vfac");
    expect(vfac?.supply.status).toBe("supplied");
    if (vfac?.supply.status === "supplied") {
      expect(vfac.supply.origin.moduleId).toBe("fac");
    }
    // The facade is NOT asked to synthesize the shadowed name.
    expect(analyzed.plan.requestedNames.get("fac")).toEqual(["vfac"]);
    const rendered = renderProgram(analyzed);
    const barrel = fileContents(rendered.files, "module-0001.mjs");
    expect(barrel).toContain('export * from "./module-0002.mjs";');
    // The call-marked declared export renders as the barrel's OWN hoisted function — the included
    // own statement the family-B conjunction needs.
    expect(barrel).toContain("export function vbar() { return 0; }");
  });

  test("declared names must be ESM, identifiers, unique, and re-export-collision-free", () => {
    const base = starWithLocalProgram();
    const collide: ProgramModel = {
      ...base,
      modules: base.modules.map(
        (module): ModuleModel =>
          module.id === "bar"
            ? ({
                ...module,
                localExports: ["vbar", "vbar"],
                dependencies: [
                  ...module.dependencies,
                  {
                    kind: "esm-reexport-named",
                    target: "fac",
                    sourceName: "vfac",
                    exportedName: "vbar",
                  },
                ],
              } as ModuleModel)
            : module,
      ),
    };
    const errors = validateProgramModel(analyzeProgram(collide));
    expect(errors.some((error) => error.includes("duplicate declared local export"))).toBe(true);
    expect(errors.some((error) => error.includes("collides with a re-export"))).toBe(true);
  });
});
