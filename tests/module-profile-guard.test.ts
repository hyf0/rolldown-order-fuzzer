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

/// The files allowed to touch the raw flags, each for a reason `moduleProfile` cannot serve:
/// - `model.ts` defines the flags and `moduleProfile` itself;
/// - `generate.ts` AUTHORS modules from drafts (it SETS the flags; a draft is not a `ModuleModel`);
/// - `validate-model.ts` validates each raw flag's own constraints (mutual exclusion, `pureBase`);
/// - `shrink.ts` DELETES a flag to form a shrink candidate;
/// - `capture-analysis.ts` resolves capability over a narrow `{ callableOwnState?, objectExport? }` view.
/// Every other consumer — the renderer, the tag deriver's classification, the boundary plan — reads the
/// profile. A NEW file here means a raw read slipped past the projection.
const ALLOWLIST = new Set([
  "model.ts",
  "generate.ts",
  "validate-model.ts",
  "shrink.ts",
  "capture-analysis.ts",
]);

function filesWithRawFlagAccess(): string[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) =>
      readFileSync(join(SRC, name), "utf8")
        .split("\n")
        .some((line) => RAW_FLAG_ACCESS.test(line)),
    )
    .sort();
}

describe("ModuleProfile is the single interpreter of purity/export-shape (finding I)", () => {
  test("no file outside the allowlist reads a raw purity/export-shape flag", () => {
    const offenders = filesWithRawFlagAccess().filter((name) => !ALLOWLIST.has(name));
    expect(offenders).toEqual([]);
  });

  test("the renderer is a pure profile consumer (zero raw purity/export-shape reads)", () => {
    const rawLines = readFileSync(join(SRC, "render.ts"), "utf8")
      .split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter((entry) => RAW_FLAG_ACCESS.test(entry.line))
      .map((entry) => entry.number);
    expect(rawLines).toEqual([]);
  });
});
