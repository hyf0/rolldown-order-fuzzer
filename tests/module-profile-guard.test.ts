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

/// The mirrored export-form switch the renderer used to carry alongside `renderedFormOf` — the forced
/// parallel dispatch that could drift from the analyzer's classification.
const EXPORT_SHAPE_ACCESS = /\bexportShape\b/;

describe("the analyzer's renderedFormOf is the renderer's SINGLE export-form dispatch (finding: mirrored form switch)", () => {
  test("render.ts never branches on the profile's exportShape — the mirrored switch stays deleted", () => {
    // The blocker was a moduleProfile export-form switch INSIDE the renderer
    // (`profile.exportShape.kind === "fresh-object" | "callable-own-state"`, plus a `purity.kind ===
    // "inferred"` arm), classifying export shape a SECOND time in parallel with `renderedFormOf`.
    // Export-shape classification now lives ONLY in the analyzer; the renderer maps the analyzer's
    // `renderedFormOf` form directly to an emission template. A raw `exportShape` read reappearing
    // anywhere in render.ts (code or comment) means the mirrored switch is back — fail loudly.
    const source = readFileSync(join(SRC, "render.ts"), "utf8");
    expect(EXPORT_SHAPE_ACCESS.test(source)).toBe(false);
  });

  test("the renderer's ONE export-form input is the analyzer's renderedFormOf classifier", () => {
    expect(readFileSync(join(SRC, "render.ts"), "utf8")).toContain("renderedFormOf");
  });
});

/// A property READ of a module's `localExports` (`module.localExports`, `barrel.localExports`) — the
/// declared-local surface that SHADOWS `export *`. It must be interpreted for routing by the ONE rule
/// `starShadowedNames` (program-facts.ts), consumed by both the demand projection and the supply walks.
function localExportsReads(source: string): number {
  return (source.match(/\.localExports\b/g) ?? []).length;
}

describe("local/star shadowing is ONE centralized rule (W14b.1 blocker 4)", () => {
  test("the demand projection routes shadowing through the shared rule, not a localExports branch", () => {
    // `analyzed-program.ts` (the demand fixpoint + `localExportsFor`) reads the shadowed-name set ONLY
    // via the imported `starShadowedNames` / `providedExportNames` — never `localExports` directly. A
    // reappearing raw read means a SECOND shadowing rule that could drift from the supply walk.
    const source = readFileSync(join(SRC, "analyzed-program.ts"), "utf8");
    expect(localExportsReads(source)).toBe(0);
    expect(source).toContain("starShadowedNames");
  });

  test("the supply routing reads localExports ONLY inside the single starShadowedNames rule", () => {
    // `program-facts.ts` touches `localExports` exactly ONCE — inside `starShadowedNames`. The resolve
    // walks (`#collectDefiners`, `#resolveExportOrigin`) consult `starShadowedNames(module)`, not their
    // own `localExports` branch. A count above one means a mirrored shadowing rule reappeared (e.g. a
    // W14c `export * as ns` surface wired into the walk instead of into the one rule).
    const source = readFileSync(join(SRC, "program-facts.ts"), "utf8");
    expect(localExportsReads(source)).toBe(1);
    expect(source).toContain("export function starShadowedNames");
  });
});
