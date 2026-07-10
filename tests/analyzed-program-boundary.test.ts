/// <reference types="node" />

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { demandAnalysisRunCount, resetDemandAnalysisRunCount } from "../src/analyzed-program.ts";
import { FORMAT_REGIMES, generateCase } from "../src/generate.ts";
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
      renderProgram(generated.program, generated.analyzed);
      expect(demandAnalysisRunCount(), `${regime}: after renderProgram`).toBe(1);
      // Validating with the carried instance likewise adds nothing.
      validateProgramModel(generated.program, generated.analyzed);
      expect(demandAnalysisRunCount(), `${regime}: after validateProgramModel`).toBe(1);
    }
  });

  test("both random-mixed and fixed-template cases analyze exactly once", () => {
    for (let seed = 0; seed < 24; seed += 1) {
      resetDemandAnalysisRunCount();
      const generated = generateCase(seed, 10);
      expect(demandAnalysisRunCount(), `seed ${seed} (${generated.template})`).toBe(1);
      renderProgram(generated.program, generated.analyzed);
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
