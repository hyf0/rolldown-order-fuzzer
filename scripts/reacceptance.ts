/// <reference types="node" />

/// W14c 6-cell seo:true REACCEPTANCE against the frozen BUGGY snapshot.
///
/// After a deliberately behavior-affecting wave, this proves the change introduced NO NEW divergence
/// class: it re-runs the 6-cell campaign (3 regimes {mixed, pure-esm, pure-cjs} × {on-demand, wrap-all},
/// 300 seeds each = 1800 builds) against the frozen buggy Rolldown snapshot at the fuzzer's default
/// seo:true regime, and asserts every RED verdict falls in the ENUMERATED known signature-REASON
/// classes (`bundle-only-crash` — the family-A/B/wave-8 NaN-fold + init crashes; `events-reordered` —
/// the W14b packaged-family-A order-deviation variant). A red with any OTHER reason (a new class) fails.
///
/// NOT part of `vp test` (1800 out-of-tree builds). Run:
///
///   REACCEPTANCE_SNAPSHOT=<dist/index.mjs> vp exec node scripts/reacceptance.ts [casesPerCell]
///
/// Writes evidence to `.agents/evidence/w14c-reacceptance.json`.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateCase, sampleCaseSize, type FormatRegime } from "../src/generate.ts";
import { executeProgram } from "../src/program-run.ts";
import { SeededRng } from "../src/rng.ts";

const SNAPSHOT =
  process.env.REACCEPTANCE_SNAPSHOT ??
  "/tmp/rolldown-strict-order-study/pr10104-runtime-snapshot/rolldown/dist/index.mjs";
const CASES = Number(process.argv[2] ?? process.env.CASES ?? "300");
const SEED_BASE = 200_000;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_OUT =
  process.env.EVIDENCE_OUT ?? resolve(REPO_ROOT, ".agents/evidence/w14c-reacceptance.json");

/// The ENUMERATED known red-reason classes. `bundle-only-crash` covers the family-A/B/wave-8 NaN-fold
/// and init crashes; `events-reordered` covers the W14b packaged-family-A order-deviation variant. Any
/// OTHER reason is a NEW divergence class and fails reacceptance.
const KNOWN_REASONS = new Set(["bundle-only-crash", "events-reordered"]);

interface CellResult {
  readonly name: string;
  readonly regime: FormatRegime;
  readonly onDemandWrapping: boolean;
  readonly cases: number;
  readonly red: number;
  readonly signatureHistogram: Record<string, number>;
  readonly reasonHistogram: Record<string, number>;
  readonly unknownReasons: string[];
}

async function runCell(
  name: string,
  regime: FormatRegime,
  onDemandWrapping: boolean,
): Promise<CellResult> {
  let red = 0;
  const signatureHistogram: Record<string, number> = {};
  const reasonHistogram: Record<string, number> = {};
  const unknownReasons: string[] = [];
  for (let index = 0; index < CASES; index += 1) {
    const seed = SEED_BASE + index;
    const size = sampleCaseSize(new SeededRng(seed));
    const generated = generateCase(seed, size, regime);
    const run = await executeProgram(
      generated.program,
      { rolldownPackage: SNAPSHOT, onDemandWrapping },
      {},
      generated.analyzed,
    );
    if (run.verdict.kind === "pass") {
      continue;
    }
    red += 1;
    const reason = run.verdict.kind === "mismatch" ? run.verdict.reason : run.verdict.kind;
    reasonHistogram[reason] = (reasonHistogram[reason] ?? 0) + 1;
    // Collapse the volatile module-id/value suffix so the histogram stays readable.
    const signatureClass = run.verdict.signature.split(":").slice(0, 2).join(":");
    signatureHistogram[signatureClass] = (signatureHistogram[signatureClass] ?? 0) + 1;
    if (!KNOWN_REASONS.has(reason)) {
      unknownReasons.push(`seed ${seed}: ${reason} ${run.verdict.signature.slice(0, 90)}`);
    }
  }
  return {
    name,
    regime,
    onDemandWrapping,
    cases: CASES,
    red,
    signatureHistogram,
    reasonHistogram,
    unknownReasons,
  };
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
  process.stderr.write(`W14c 6-cell reacceptance — ${CASES}/cell, snapshot ${SNAPSHOT}\n`);
  const cells: CellResult[] = [];
  const plan: readonly [string, FormatRegime, boolean][] = [
    ["mixed-od", "mixed", true],
    ["mixed-wa", "mixed", false],
    ["pure-esm-od", "pure-esm", true],
    ["pure-esm-wa", "pure-esm", false],
    ["pure-cjs-od", "pure-cjs", true],
    ["pure-cjs-wa", "pure-cjs", false],
  ];
  for (const [name, regime, onDemandWrapping] of plan) {
    const cell = await runCell(name, regime, onDemandWrapping);
    cells.push(cell);
    process.stdout.write(
      `${name.padEnd(12)} red=${cell.red}/${cell.cases} (${((100 * cell.red) / cell.cases).toFixed(1)}%)  ` +
        `reasons=${JSON.stringify(cell.reasonHistogram)}\n`,
    );
    for (const line of cell.unknownReasons) {
      process.stdout.write(`  ! NEW CLASS ${line}\n`);
    }
  }

  const unknown = cells.flatMap((cell) => cell.unknownReasons);
  const accepted = unknown.length === 0;

  const evidence = {
    proof: "W14c 6-cell seo:true reacceptance vs the frozen buggy snapshot",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    casesPerCell: CASES,
    snapshot: { path: SNAPSHOT, sha256: sha256OfFile(SNAPSHOT) },
    knownReasons: [...KNOWN_REASONS],
    accepted,
    cells,
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`\nwrote evidence to ${EVIDENCE_OUT}\n`);

  if (accepted) {
    process.stdout.write(`\nOK: all reds fall in the enumerated known signature classes\n`);
    return 0;
  }
  process.stderr.write(`\nFAIL: ${unknown.length} red(s) in a NEW divergence class\n`);
  return 1;
}

process.exit(await main());
