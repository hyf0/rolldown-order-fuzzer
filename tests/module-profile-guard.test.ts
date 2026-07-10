/// <reference types="node" />

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/// A raw READ of one of the five correlated purity/export-shape flags as a property access. Every
/// behavioral consumer should instead go through `moduleProfile`, so this projection stays the single
/// interpreter of the flags and a new capability/purity form needs one switch, not a scattered set.
const RAW_FLAG_ACCESS = /\.(sideEffectFree|inferredPure|callableOwnState|objectExport|pureBase)\b/;

/// The files allowed to touch the raw flags ANYWHERE, each for a reason `moduleProfile` cannot serve:
/// - `model.ts` defines the flags and `moduleProfile` itself;
/// - `validate-model.ts` validates each raw flag's own constraints (mutual exclusion, `pureBase`);
/// - `shrink.ts` DELETES a flag to form a shrink candidate.
/// `generate.ts` is NOT here: it may read the raw flags ONLY inside its AUTHORING section (the draft→module
/// map that sets them), gated below. `capture-analysis.ts` was removed (finding 7): its export-capability
/// walk is gone, so it no longer interprets `callableOwnState`/`objectExport`. Every OTHER consumer — the
/// renderer, the tag deriver's classification, the boundary plan — reads the profile. A new file here, or a
/// raw read in generate.ts outside the authoring section, means a raw read slipped past the projection.
const FULLY_ALLOWED = new Set(["model.ts", "validate-model.ts", "shrink.ts"]);

/// generate.ts reads raw flags only inside this marked region (the one place that AUTHORS a module's
/// flags from a draft, which is not a `ModuleModel`).
const AUTHORING_GATED = "generate.ts";
const AUTHORING_START = "profile-guard:authoring-start";
const AUTHORING_END = "profile-guard:authoring-end";

function rawFlagLineNumbers(source: string): number[] {
  return source
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => RAW_FLAG_ACCESS.test(entry.line))
    .map((entry) => entry.number);
}

/// Raw-flag reads in generate.ts that fall OUTSIDE the authoring section (the markers themselves excluded).
function rawFlagLinesOutsideAuthoring(source: string): number[] {
  const offenders: number[] = [];
  let inAuthoring = false;
  source.split("\n").forEach((line, index) => {
    if (line.includes(AUTHORING_START)) {
      inAuthoring = true;
      return;
    }
    if (line.includes(AUTHORING_END)) {
      inAuthoring = false;
      return;
    }
    if (!inAuthoring && RAW_FLAG_ACCESS.test(line)) {
      offenders.push(index + 1);
    }
  });
  return offenders;
}

describe("ModuleProfile is the single interpreter of purity/export-shape (findings I, 7)", () => {
  test("no file outside the narrowed allowlist reads a raw purity/export-shape flag", () => {
    const offenders = readdirSync(SRC)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => name !== AUTHORING_GATED && !FULLY_ALLOWED.has(name))
      .filter((name) => rawFlagLineNumbers(readFileSync(join(SRC, name), "utf8")).length > 0)
      .sort();
    expect(offenders).toEqual([]);
  });

  test("generate.ts reads raw flags ONLY inside its authoring section", () => {
    const source = readFileSync(join(SRC, AUTHORING_GATED), "utf8");
    // Sanity: the markers exist and the section really does carry the authoring reads.
    expect(source).toContain(AUTHORING_START);
    expect(source).toContain(AUTHORING_END);
    expect(rawFlagLineNumbers(source).length).toBeGreaterThan(0);
    // The guard: nothing outside the authoring section reads a raw flag.
    expect(rawFlagLinesOutsideAuthoring(source)).toEqual([]);
  });

  test("capture-analysis.ts is no longer allowed to read raw flags — and does not (finding 7)", () => {
    expect(FULLY_ALLOWED.has("capture-analysis.ts")).toBe(false);
    expect(rawFlagLineNumbers(readFileSync(join(SRC, "capture-analysis.ts"), "utf8"))).toEqual([]);
  });

  test("the renderer is a pure profile consumer (zero raw purity/export-shape reads)", () => {
    expect(rawFlagLineNumbers(readFileSync(join(SRC, "render.ts"), "utf8"))).toEqual([]);
  });
});
