import { describe, expect, test } from "vite-plus/test";

import { analyzeProgram } from "../src/analyzed-program.ts";
import {
  buildFamilyBEagerBarrel,
  deriveCoverageTags,
  generateCase,
  generateFamilyBEagerBarrelCase,
  sampleCaseSize,
} from "../src/generate.ts";
import type { ModuleModel, ProgramModel } from "../src/model.ts";
import { metadataPureModuleIds, packagesOf } from "../src/model.ts";
import { renderProgram } from "../src/render.ts";
import { SeededRng } from "../src/rng.ts";
import { candidates } from "../src/shrink.ts";
import { validateProgramModel } from "../src/validate-model.ts";
import { fileContents } from "./fixtures.ts";

describe("the directed family-B eager-barrel builder", () => {
  test("is valid, tagged as the complete conjunction, and structurally the vben fixture", () => {
    const generated = generateFamilyBEagerBarrelCase(0);
    expect(validateProgramModel(generated.analyzed)).toEqual([]);
    expect(generated.coverageTags).toContain("mechanism:family-b-eager-barrel");
    expect(generated.coverageTags).toContain("variation:side-effects-array");
    expect(generated.coverageTags).toContain("variation:package");
    const rendered = renderProgram(generated.analyzed);
    const packageJson = JSON.parse(fileContents(rendered.files, "node_modules/fbpkg/package.json"));
    expect(packageJson).toEqual({
      name: "fbpkg",
      main: "./fb-bar.mjs",
      sideEffects: ["./fb-sib.mjs"],
    });
    // The barrel: the star hop to the facade PLUS its own declared, call-marked helper.
    const barrel = fileContents(rendered.files, "node_modules/fbpkg/fb-bar.mjs");
    expect(barrel).toContain('export * from "./fb-def.mjs";');
    expect(barrel).toContain("export function helper() { return 0; }");
    // The facade: init-assigned from a CALL of the sibling's function (non-inlinable).
    const facade = fileContents(rendered.files, "node_modules/fbpkg/fb-def.mjs");
    expect(facade).toContain('import { makePref as mk } from "./fb-sib.mjs";');
    expect(facade).toContain("0 + mk()");
    // The entry: effectful first import BEFORE the bare package import, hidden facade read.
    const entry = fileContents(rendered.files, "module-0000.mjs");
    expect(entry.indexOf('import "./module-0001.mjs";')).toBeGreaterThanOrEqual(0);
    expect(entry.indexOf('import "./module-0001.mjs";')).toBeLessThan(
      entry.indexOf('from "fbpkg"'),
    );
    expect(entry).toContain("__hiddenRead0");
  });

  test("removing a CAUSAL ingredient un-tags it; revealing the hidden read does NOT", () => {
    const base = buildFamilyBEagerBarrel(new SeededRng(1)).program;
    const retag = (mutate: (program: ProgramModel) => ProgramModel): readonly string[] =>
      deriveCoverageTags(analyzeProgram(mutate(structuredClone(base) as ProgramModel)));
    const mutateEntry = (
      program: ProgramModel,
      mutate: (module: ModuleModel) => ModuleModel,
    ): ProgramModel => ({
      ...program,
      modules: program.modules.map((module) => (module.id === "fb-ent" ? mutate(module) : module)),
    });

    // Control: the unmodified program is tagged.
    expect(deriveCoverageTags(analyzeProgram(base))).toContain("mechanism:family-b-eager-barrel");
    // sideEffects array -> true (no partial metadata).
    expect(
      retag((program) => ({
        ...program,
        packages: program.packages?.map((pkg) => ({ ...pkg, sideEffects: true as const })),
      })),
    ).not.toContain("mechanism:family-b-eager-barrel");
    // No chunk group splitting facade+sibling.
    expect(
      retag((program) => ({
        ...program,
        build: { ...program.build!, chunking: { kind: "automatic" } },
      })),
    ).not.toContain("mechanism:family-b-eager-barrel");
    // The effectful first import dropped.
    expect(
      retag((program) =>
        mutateEntry(
          program,
          (module) =>
            ({
              ...module,
              dependencies: module.dependencies.filter(
                (dependency) => dependency.kind !== "esm-side-effect-import",
              ),
            }) as ModuleModel,
        ),
      ),
    ).not.toContain("mechanism:family-b-eager-barrel");
    // The reviewer's DECOY: the `helper` import stays `call:true`, but the entry never INVOKES it in
    // an event (the `vb` call read is dropped) — a call-marked import that is never called runs no
    // forwarder, so the causal predicate must NOT tag it.
    expect(
      retag((program) =>
        mutateEntry(program, (module) => ({
          ...module,
          events: module.events.map((event) => ({
            ...event,
            reads: (event.reads ?? []).filter(
              (read) => !(read.binding === "vb" && read.call === true),
            ),
          })),
        })),
      ),
    ).not.toContain("mechanism:family-b-eager-barrel");
    // The barrel is no longer the package MAIN (`moduleIds[0]`): the eager-forwarder bug lives on the
    // main a bare `import "fbpkg"` resolves, so a demoted barrel is a different resolution surface.
    expect(
      retag((program) => ({
        ...program,
        packages: program.packages?.map((pkg) =>
          pkg.name === "fbpkg" ? { ...pkg, moduleIds: ["fb-def", "fb-bar", "fb-sib"] } : pkg,
        ),
      })),
    ).not.toContain("mechanism:family-b-eager-barrel");
    // The hidden read REVEALED to a plain visible read STAYS tagged — `hiddenReadFn` is not causal
    // (the snapshot fails a visible read too), so the shrunken repro's plain top-level read is still
    // the conjunction. This is the honest reconciliation of the tag with the shrunken model.
    expect(
      retag((program) =>
        mutateEntry(program, (module) => ({
          ...module,
          events: module.events.map((event) => {
            const revealed = { ...event };
            delete (revealed as { hiddenReadFn?: true }).hiddenReadFn;
            return revealed;
          }),
        })),
      ),
    ).toContain("mechanism:family-b-eager-barrel");
  });
});

describe("W14b random-mixed enrichment", () => {
  test("family-B conjunction density is double-digit; witnesses and packages are dense and valid", () => {
    let familyB = 0;
    let retained = 0;
    let packaged = 0;
    let localReexport = 0;
    let dualDefault = 0;
    const cases = 1500;
    for (let seed = 0; seed < cases; seed += 1) {
      const size = sampleCaseSize(new SeededRng(seed));
      const generated = generateCase(seed, size, "mixed");
      expect(validateProgramModel(generated.analyzed), `seed ${seed}`).toEqual([]);
      const tags = generated.coverageTags;
      if (tags.includes("mechanism:family-b-eager-barrel")) {
        familyB += 1;
      }
      if (tags.includes("mechanism:package-retained-reference")) {
        retained += 1;
      }
      if (tags.includes("variation:package")) {
        packaged += 1;
      }
      if (tags.includes("variation:reexport-local")) {
        localReexport += 1;
      }
      if (tags.includes("variation:named-and-default-alias")) {
        dualDefault += 1;
      }
    }
    // The wave's acceptance: the COMPLETE family-B conjunction at double-digit density.
    expect(familyB / cases).toBeGreaterThanOrEqual(0.1);
    expect(retained / cases).toBeGreaterThan(0.04);
    expect(packaged / cases).toBeGreaterThan(0.3);
    expect(localReexport / cases).toBeGreaterThan(0.02);
    expect(dualDefault / cases).toBeGreaterThan(0.02);
  });

  test("enrichment keeps every package well-formed and every metadata-pure member contractual", () => {
    for (let seed = 3_000; seed < 3_400; seed += 1) {
      const size = sampleCaseSize(new SeededRng(seed));
      const generated = generateCase(seed, size, "mixed");
      const modulesById = new Map(generated.program.modules.map((m) => [m.id, m]));
      const memberIds = new Set<string>();
      for (const pkg of packagesOf(generated.program)) {
        expect(pkg.moduleIds.length, `seed ${seed} package ${pkg.name}`).toBeGreaterThan(0);
        for (const id of pkg.moduleIds) {
          expect(modulesById.has(id), `seed ${seed}: ${pkg.name} member ${id}`).toBe(true);
          expect(memberIds.has(id), `seed ${seed}: ${id} in two packages`).toBe(false);
          memberIds.add(id);
        }
      }
      for (const pureId of metadataPureModuleIds(generated.program)) {
        const module = modulesById.get(pureId);
        expect(module?.events, `seed ${seed}: pure member ${pureId} has events`).toEqual([]);
      }
    }
  });

  test("pure-cjs regime never receives the ESM-only enrichment clusters", () => {
    for (let seed = 0; seed < 300; seed += 1) {
      const size = sampleCaseSize(new SeededRng(seed));
      const generated = generateCase(seed, size, "pure-cjs");
      expect(generated.coverageTags).not.toContain("mechanism:family-b-eager-barrel");
      expect(generated.coverageTags).not.toContain("mechanism:package-retained-reference");
      expect(generated.program.modules.every((module) => module.format === "cjs")).toBe(true);
    }
  });
});

describe("shrink candidates for packages", () => {
  test("offers package drop, sideEffects->true, member drop, and array-entry drop", () => {
    const program = buildFamilyBEagerBarrel(new SeededRng(2)).program;
    const all = [...candidates(program)];
    const dropped = all.filter((candidate) => candidate.packages === undefined);
    expect(dropped.length).toBeGreaterThan(0);
    const weakened = all.filter((candidate) =>
      (candidate.packages ?? []).some((pkg) => pkg.sideEffects === true),
    );
    expect(weakened.length).toBeGreaterThan(0);
    const memberDropped = all.filter((candidate) =>
      (candidate.packages ?? []).some((pkg) => pkg.name === "fbpkg" && pkg.moduleIds.length === 2),
    );
    expect(memberDropped.length).toBeGreaterThan(0);
    // The one array entry collapses to sideEffects:false when removed (never an empty array).
    const entryDropped = all.filter((candidate) =>
      (candidate.packages ?? []).some((pkg) => pkg.sideEffects === false),
    );
    expect(entryDropped.length).toBeGreaterThan(0);
    // Dropping a MODULE also removes it from its package, so the candidate stands alone.
    const moduleDrops = all.filter(
      (candidate) =>
        !candidate.modules.some((module) => module.id === "fb-sib") &&
        (candidate.packages ?? []).every((pkg) => !pkg.moduleIds.includes("fb-sib")),
    );
    expect(moduleDrops.length).toBeGreaterThan(0);
  });
});
