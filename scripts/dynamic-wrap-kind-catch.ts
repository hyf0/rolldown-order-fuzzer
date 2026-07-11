/// <reference types="node" />

/// FW-B deliverable 2 — the dynamic-entry × wrap-kind × merge campaign (cluster 4, the historically
/// MISSING T1 cell: a dynamically-imported target the optimizer inlines/merges into a common or user
/// chunk under a CJS/ESM wrap-kind while ≥2 entries share it).
///
/// A directed campaign of the `buildDynamicWrapKindMerge` shape family (`generate.ts`) — three variants
/// (`shared-dynamic`, `static-dynamic-merge`, `identity-double-init`) across the dynamic target's
/// wrap-kind (cjs/esm) — run against npm rolldown@1.1.4, @1.1.5, and the final PR-10104 snapshot under
/// the seo:true full-order oracle. Cluster 4 is believed fixed for the known shapes on 1.1.x, so this is
/// COVERAGE of a cell the fuzzer never crossed: the acceptance is that every seed is GREEN AND the
/// dynamic entry actually MERGED (verified by chunk inspection — `dw-t` lands in a chunk of ≥2 modules),
/// with the recipe tag `mechanism:dynamic-entry-wrap-kind-merge` present. Cluster 4 interacts with the
/// still-leaky cluster 1, so any RED on any target is a LIVE CATCH — reported prominently.
///
/// NOT part of `vp test`. Run:
///   NPM_114=<dist> NPM_115=<dist> SNAPSHOT_ROLLDOWN=<dist> vp exec node scripts/dynamic-wrap-kind-catch.ts [cases]
/// Writes evidence to `.agents/evidence/dynamic-wrap-kind.json`.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateDynamicWrapKindMergeCase, type DynamicWrapKindVariant } from "../src/generate.ts";
import type { ModuleFormat } from "../src/model.ts";
import { executeProgram } from "../src/program-run.ts";
import { inspectChunkGraph } from "./chunk-graph.ts";

const NPM_114 =
  process.env.NPM_114 ??
  "/tmp/order-fuzzer-regression-targets/1.1.4/node_modules/rolldown/dist/index.mjs";
const NPM_115 =
  process.env.NPM_115 ??
  "/tmp/order-fuzzer-regression-targets/1.1.5/node_modules/rolldown/dist/index.mjs";
const SNAPSHOT =
  process.env.SNAPSHOT_ROLLDOWN ??
  "/tmp/rolldown-strict-order-study/final-snapshot-42628c18b/rolldown/dist/index.mjs";
const CASES = Number(process.argv[2] ?? process.env.CASES ?? "20");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_OUT =
  process.env.EVIDENCE_OUT ?? resolve(REPO_ROOT, ".agents/evidence/dynamic-wrap-kind.json");
const CATCH_TAG = "mechanism:dynamic-entry-wrap-kind-merge";

/// The variant/format cells (identity-double-init is ESM-only — objectExport is an ESM construct).
const CELLS: readonly { variant: DynamicWrapKindVariant; format: ModuleFormat }[] = [
  { variant: "shared-dynamic", format: "cjs" },
  { variant: "shared-dynamic", format: "esm" },
  { variant: "static-dynamic-merge", format: "cjs" },
  { variant: "static-dynamic-merge", format: "esm" },
  { variant: "identity-double-init", format: "esm" },
];
const TARGETS: readonly { label: string; pkg: string }[] = [
  { label: "npm-1.1.4", pkg: NPM_114 },
  { label: "npm-1.1.5", pkg: NPM_115 },
  { label: "snapshot", pkg: SNAPSHOT },
];

interface CellResult {
  readonly green: number;
  readonly red: number;
  readonly verifiedDynamicMerged: number;
  readonly tagged: number;
  readonly signatureHistogram: Record<string, number>;
  readonly perSeed: {
    seed: number;
    kind: string;
    signature: string;
    dynamicMerged: boolean;
  }[];
}

async function runCell(
  variant: DynamicWrapKindVariant,
  format: ModuleFormat,
  pkg: string,
): Promise<CellResult> {
  let green = 0;
  let red = 0;
  let verifiedDynamicMerged = 0;
  let tagged = 0;
  const signatureHistogram: Record<string, number> = {};
  const perSeed: CellResult["perSeed"] = [];
  for (let seed = 0; seed < CASES; seed += 1) {
    const generated = generateDynamicWrapKindMergeCase(seed, variant, format);
    if (generated.coverageTags.includes(CATCH_TAG)) {
      tagged += 1;
    }
    const run = await executeProgram(
      generated.program,
      { rolldownPackage: pkg, onDemandWrapping: true },
      {},
      generated.analyzed,
    );
    const signature = run.verdict.kind === "pass" ? "pass" : run.verdict.signature;
    signatureHistogram[signature] = (signatureHistogram[signature] ?? 0) + 1;
    const graph = await inspectChunkGraph(generated.analyzed, pkg);
    const dynamicMerged = graph.chunks.some(
      (chunk) => chunk.moduleIds.includes("dw-t") && chunk.moduleIds.length >= 2,
    );
    if (dynamicMerged) {
      verifiedDynamicMerged += 1;
    }
    if (run.verdict.kind === "pass") {
      green += 1;
    } else {
      red += 1;
    }
    perSeed.push({ seed, kind: run.verdict.kind, signature, dynamicMerged });
  }
  return { green, red, verifiedDynamicMerged, tagged, signatureHistogram, perSeed };
}

function sha256OfFile(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function gitOutput(args: readonly string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function main(): Promise<number> {
  if (!Number.isInteger(CASES) || CASES <= 0) {
    process.stderr.write(`FAIL: CASES must be a positive integer, received ${String(CASES)}\n`);
    return 2;
  }
  process.stderr.write(`dynamic-entry × wrap-kind × merge campaign — ${CASES} seeds/cell\n`);

  const cells: Record<string, Record<string, CellResult>> = {};
  const liveCatches: string[] = [];
  for (const { variant, format } of CELLS) {
    const key = `${variant}:${format}`;
    cells[key] = {};
    for (const { label, pkg } of TARGETS) {
      const result = await runCell(variant, format, pkg);
      cells[key]![label] = result;
      process.stdout.write(
        `${key.padEnd(28)} ${label.padEnd(10)} green=${result.green}/${CASES} red=${result.red} ` +
          `dynMerged=${result.verifiedDynamicMerged} tagged=${result.tagged}\n`,
      );
      if (result.red > 0) {
        liveCatches.push(
          `${key} on ${label}: ${result.red}/${CASES} RED — ${JSON.stringify(result.signatureHistogram)}`,
        );
      }
    }
  }

  if (liveCatches.length > 0) {
    process.stdout.write(`\n*** LIVE CATCHES (red in a cluster-4 cell) ***\n`);
    for (const line of liveCatches) {
      process.stdout.write(`  !! ${line}\n`);
    }
  }

  // Acceptance: every cell GREEN on every target, the dynamic entry verified-merged on every seed, and
  // the recipe tag present on every seed.
  let accepted = true;
  for (const key of Object.keys(cells)) {
    for (const { label } of TARGETS) {
      const cell = cells[key]![label]!;
      if (cell.green !== CASES || cell.verifiedDynamicMerged !== CASES || cell.tagged !== CASES) {
        accepted = false;
      }
    }
  }

  const evidence = {
    proof: "FW-B dynamic-entry × wrap-kind × merge campaign (cluster 4 / T1 cell)",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    cases: CASES,
    catchTag: CATCH_TAG,
    liveCatches,
    note: "Cluster 4 is believed fixed on 1.1.x — GREEN + verified-merged is COVERAGE of a never-crossed cell; a red would be a live catch.",
    targets: {
      "npm-1.1.4": { path: NPM_114, sha256: sha256OfFile(NPM_114) },
      "npm-1.1.5": { path: NPM_115, sha256: sha256OfFile(NPM_115) },
      snapshot: { path: SNAPSHOT, sha256: sha256OfFile(SNAPSHOT) },
    },
    accepted,
    cells,
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`\nwrote evidence to ${EVIDENCE_OUT}\n`);

  if (accepted) {
    process.stdout.write(
      `\nOK: dynamic×wrap-kind cell crossed — every cell green + dynamic entry verified-merged (both wrap-kinds)\n`,
    );
    return 0;
  }
  process.stderr.write(
    `\n${liveCatches.length > 0 ? "LIVE CATCH — a cluster-4 cell went red" : "FAIL: a cell was not green / not verified-merged / not tagged"}\n`,
  );
  return liveCatches.length > 0 ? 3 : 1;
}

process.exit(await main());
