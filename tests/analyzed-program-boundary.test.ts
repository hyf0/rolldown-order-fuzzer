/// <reference types="node" />

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import {
  analyzeProgram,
  demandAnalysisRunCount,
  resetDemandAnalysisRunCount,
} from "../src/analyzed-program.ts";
import { deriveCoverageTags, FORMAT_REGIMES, generateCase } from "../src/generate.ts";
import type { ProgramModel } from "../src/model.ts";
import { executeProgram } from "../src/program-run.ts";
import { renderProgram } from "../src/render.ts";
import { validateProgramModel } from "../src/validate-model.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/// The `.ts` files under `src/` whose NON-comment lines reference `pattern`, excluding `allowed`. Comment
/// lines (`//`, `///`, `*`, `/* … */`) are skipped so a record naming a killed entry point in prose does
/// not trip the guard — only a real import or call counts.
function filesReferencing(pattern: RegExp, allowed: ReadonlySet<string>): string[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith(".ts") && !allowed.has(name))
    .filter((name) =>
      readFileSync(join(SRC, name), "utf8")
        .split("\n")
        .some((line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
            return false;
          }
          return pattern.test(line);
        }),
    )
    .sort();
}

describe("the case path runs demand analysis EXACTLY ONCE (finding 1)", () => {
  test("generate → render → validate all consume the ONE carried AnalyzedProgram", () => {
    for (const regime of FORMAT_REGIMES) {
      resetDemandAnalysisRunCount();
      const generated = generateCase(7, 14, regime);
      // Generation (finalizeProgram) built the ONE AnalyzedProgram and derived the coverage tags from it.
      expect(demandAnalysisRunCount(), `${regime}: after generateCase`).toBe(1);
      // Rendering consumes the SAME carried instance (validation + form dispatch) — no re-analysis.
      renderProgram(generated.analyzed);
      expect(demandAnalysisRunCount(), `${regime}: after renderProgram`).toBe(1);
      // Validating with the carried instance likewise adds nothing.
      validateProgramModel(generated.analyzed);
      expect(demandAnalysisRunCount(), `${regime}: after validateProgramModel`).toBe(1);
    }
  });

  test("both random-mixed and fixed-template cases analyze exactly once", () => {
    for (let seed = 0; seed < 24; seed += 1) {
      resetDemandAnalysisRunCount();
      const generated = generateCase(seed, 10);
      expect(demandAnalysisRunCount(), `seed ${seed} (${generated.template})`).toBe(1);
      renderProgram(generated.analyzed);
      expect(demandAnalysisRunCount(), `seed ${seed} after render`).toBe(1);
    }
  });

  test("the carried analysis and finalized program are frozen (mutation throws)", () => {
    const generated = generateCase(7, 14, "mixed");
    expect(Object.isFrozen(generated.program)).toBe(true);
    expect(Object.isFrozen(generated.program.modules)).toBe(true);
    expect(Object.isFrozen(generated.program.modules[0])).toBe(true);
    expect(Object.isFrozen(generated.analyzed)).toBe(true);
    expect(Object.isFrozen(generated.analyzed.plan)).toBe(true);
    expect(() => {
      (generated.program.modules as unknown as { push: (x: unknown) => void }).push({});
    }).toThrow();
  });

  test("a FIXED-template case's program is deep-frozen too (mutation throws)", () => {
    // finalizeProgram deep-freezes the random-mixed program; a fixed-template program is a plain literal,
    // so generateCase deep-freezes it on the SAME path before analyzing. Find the first seed that yields a
    // fixed template (an un-forced generateCase picks one ~half the time), then assert it is frozen.
    let generated = generateCase(0, 10);
    for (let seed = 1; generated.template === "random-mixed" && seed < 100; seed += 1) {
      generated = generateCase(seed, 10);
    }
    expect(generated.template, "expected a fixed-template case in seeds 0..99").not.toBe(
      "random-mixed",
    );
    expect(Object.isFrozen(generated.program)).toBe(true);
    expect(Object.isFrozen(generated.program.modules)).toBe(true);
    expect(Object.isFrozen(generated.program.modules[0])).toBe(true);
    // The GeneratedCase carries the SAME frozen program its analysis was built over.
    expect(generated.analyzed.program).toBe(generated.program);
    expect(() => {
      (generated.program.modules as unknown as { push: (x: unknown) => void }).push({});
    }).toThrow();
  });
});

/// The codex probe pair: a consumer that namespace-CALLS `def.vx`, over a definer that is EITHER an ESM
/// callable-own-state definer (renders `vx` as a function — a callable consumption validates) or an
/// otherwise-identical CJS numeric definer (renders `exports.vx = 5` — calling it is a TypeError). The
/// two programs differ ONLY in the `def` module, so an analysis of one applied to the other is the exact
/// mismatch finding-"consumers accept mismatched pairs" was about.
function callProbeProgram(definerFormat: "esm" | "cjs"): ProgramModel {
  return {
    modules: [
      {
        id: "consumer",
        format: "esm",
        dependencies: [
          {
            kind: "esm-namespace-import",
            target: "def",
            localName: "ns",
            readMembers: [["vx"]],
            callMembers: ["vx"],
          },
        ],
        events: [
          {
            module: "consumer",
            phase: "evaluate",
            value: 1,
            reads: [{ binding: "ns", memberPath: ["vx"], call: true }],
          },
        ],
      },
      definerFormat === "esm"
        ? {
            id: "def",
            format: "esm",
            dependencies: [],
            events: [{ module: "def", phase: "evaluate", value: 5 }],
            callableOwnState: true,
          }
        : {
            id: "def",
            format: "cjs",
            dependencies: [],
            events: [{ module: "def", phase: "evaluate", value: 5 }],
          },
    ],
    entries: [{ name: "main", moduleId: "consumer" }],
    schedule: [{ kind: "import-entry", entry: "main" }],
  };
}

describe("the (program, analyzed) mismatch is unrepresentable — consumers take the AnalyzedProgram only", () => {
  // Before the fix, the two-argument consumers accepted a mismatched pair: the ESM analysis (which
  // classifies `vx` callable) supplied ALONGSIDE the CJS numeric-definer program made validation return
  // [] and rendering emit `ns.vx()` against `exports.vx = 5` — a guaranteed TypeError. The consumers now
  // read the program FROM the analysis, so the pair cannot be formed at the call site.

  test("validate / render / tags reject a bare ProgramModel at compile time (the two-arg surface is gone)", () => {
    // Never executed — a COMPILE-TIME assertion. Each consumer takes ONLY an AnalyzedProgram, so a bare
    // ProgramModel (which could disagree with a separately-built analysis) is no longer a legal argument.
    // Deleting an `@ts-expect-error` here — e.g. by restoring a `(program, analyzed)` overload — fails the
    // build, so this is the regression that keeps the mismatch surface closed.
    const _typeOnly = (program: ProgramModel): void => {
      // @ts-expect-error a consumer takes ONLY an AnalyzedProgram
      validateProgramModel(program);
      // @ts-expect-error a consumer takes ONLY an AnalyzedProgram
      renderProgram(program);
      // @ts-expect-error a consumer takes ONLY an AnalyzedProgram
      deriveCoverageTags(program);
    };
    expect(typeof _typeOnly).toBe("function");
  });

  test("the honest single-arg path REJECTS the CJS numeric definer's namespace call", () => {
    // The mismatched ESM analysis looks valid on its own — that is why the old pair slipped through.
    expect(validateProgramModel(analyzeProgram(callProbeProgram("esm")))).toEqual([]);
    // The program's OWN analysis (the only pairing now possible) rejects the degenerate call at validation.
    expect(validateProgramModel(analyzeProgram(callProbeProgram("cjs")))).toContain(
      'export "vx" on "def": called consumed by module "consumer" (demand "vx" on "def") but the definer renders a value — a call must reach a callable-own-state definer or a directly call-marked export',
    );
  });

  test("the transition seam (executeProgram) THROWS on a mismatched carried analysis", async () => {
    // executeProgram is the one signature that still carries BOTH program and an OPTIONAL analysis (so the
    // case path reuses its one analysis). Its hard identity assert makes the probe's mismatch loud instead
    // of rendering a callable `ns.vx()` against the CJS value.
    const esmAnalyzed = analyzeProgram(callProbeProgram("esm"));
    const cjsProgram = callProbeProgram("cjs");
    await expect(
      executeProgram(
        cjsProgram,
        { rolldownPackage: "unused", onDemandWrapping: false },
        {},
        esmAnalyzed,
      ),
    ).rejects.toThrow("different program");
  });
});

describe("no parallel projection outside the boundary (finding 2)", () => {
  test("collectRequestedExports is private to analyzed-program.ts (the renderer reads the plan)", () => {
    expect(
      filesReferencing(/\bcollectRequestedExports\b/, new Set(["analyzed-program.ts"])),
    ).toEqual([]);
  });

  test("resolveExportOrigin is used only inside program-facts.ts (the validator's capability walk is gone)", () => {
    expect(filesReferencing(/\bresolveExportOrigin\b/, new Set(["program-facts.ts"]))).toEqual([]);
  });

  test("the deleted capability walk (resolveExportCapability / describeCaptures) is referenced nowhere", () => {
    expect(filesReferencing(/\b(?:resolveExportCapability|describeCaptures)\b/, new Set())).toEqual(
      [],
    );
  });
});
