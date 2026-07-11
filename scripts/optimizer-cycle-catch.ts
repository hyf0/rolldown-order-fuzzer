/// <reference types="node" />

/// FW-B deliverable 1 — the optimizer runtime-placement / facade cycle campaign (cluster 1.1, the #1
/// regression magnet: "the chunk optimizer must not create an inter-chunk import cycle").
///
/// A directed campaign of the `buildOptimizerCycle` shape family (`generate.ts`), run against THREE
/// targets under the fuzzer's seo:true full-order oracle:
///
///   - npm rolldown@1.1.4 — the RED-3 red-below: the `runtime-placement` variant throws
///     `TypeError: __commonJSMin is not a function` (the CJS runtime helper placed into a chunk imported
///     back before it is defined). This proves a GENERATOR reproduces RED-3, superseding the mining
///     doc's "not expressible without new generator capabilities" verdict.
///   - npm rolldown@1.1.5 — the RED-3 green-at/above: fixed (#9993/#10101). GREEN expected.
///   - the final PR-10104 snapshot — GREEN expected.
///
/// Cluster 1.1 is STILL LEAKY per the fix-history mining (open cross-chunk eval-order defects remain), so
/// any RED on 1.1.5 OR the snapshot is a LIVE CATCH — reported prominently, not swallowed. Each cell also
/// inspects the built CHUNK GRAPH (`scripts/chunk-graph.ts`): the `runtime-placement` variant must
/// produce a verified optimizer MERGE + a QUOTIENT CYCLE on 1.1.4 (the recipe actually fired), and the
/// campaign records the merge/cycle density per target — "tag the recipe, verify the merge".
///
/// NOT part of `vp test` (it spawns rolldown builds against out-of-tree targets). Run:
///
///   NPM_114=<dist> NPM_115=<dist> SNAPSHOT_ROLLDOWN=<dist> vp exec node scripts/optimizer-cycle-catch.ts [cases]
///
/// Writes machine-readable evidence (`EVIDENCE_OUT`, default
/// `.agents/evidence/optimizer-cycle.json`): per-seed verdicts, the signature histogram, the verified
/// merge/cycle densities, live-catch flags, HEAD + dirty status, node version, and each target's sha256.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateOptimizerCycleCase, type OptimizerCycleVariant } from "../src/generate.ts";
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
  process.env.EVIDENCE_OUT ?? resolve(REPO_ROOT, ".agents/evidence/optimizer-cycle.json");
const CATCH_TAG = "mechanism:optimizer-runtime-placement-cycle";
const VARIANTS: readonly OptimizerCycleVariant[] = ["runtime-placement", "facade-shared"];

interface SeedVerdict {
  readonly seed: number;
  readonly kind: string;
  readonly signature: string;
  readonly tagged: boolean;
  readonly mergedChunkCount: number;
  readonly hasQuotientCycle: boolean;
}

interface Cell {
  readonly red: number;
  readonly green: number;
  readonly other: string[];
  readonly perSeed: SeedVerdict[];
  readonly signatureHistogram: Record<string, number>;
  readonly verifiedMerged: number;
  readonly verifiedCycle: number;
}

async function runCell(
  variant: OptimizerCycleVariant,
  rolldownPackage: string,
  inspect: boolean,
): Promise<Cell> {
  let red = 0;
  let green = 0;
  let verifiedMerged = 0;
  let verifiedCycle = 0;
  const other: string[] = [];
  const perSeed: SeedVerdict[] = [];
  const signatureHistogram: Record<string, number> = {};
  for (let seed = 0; seed < CASES; seed += 1) {
    const generated = generateOptimizerCycleCase(seed, variant);
    const tagged = generated.coverageTags.includes(CATCH_TAG);
    if (!tagged) {
      other.push(`seed ${seed}: NOT TAGGED ${CATCH_TAG}`);
    }
    const run = await executeProgram(
      generated.program,
      { rolldownPackage, onDemandWrapping: true },
      {},
      generated.analyzed,
    );
    const signature = run.verdict.kind === "pass" ? "pass" : run.verdict.signature;
    signatureHistogram[signature] = (signatureHistogram[signature] ?? 0) + 1;
    let mergedChunkCount = 0;
    let hasQuotientCycle = false;
    if (inspect) {
      const graph = await inspectChunkGraph(generated.analyzed, rolldownPackage);
      mergedChunkCount = graph.mergedChunkCount;
      hasQuotientCycle = graph.hasQuotientCycle;
      if (mergedChunkCount > 0) {
        verifiedMerged += 1;
      }
      if (hasQuotientCycle) {
        verifiedCycle += 1;
      }
    }
    perSeed.push({
      seed,
      kind: run.verdict.kind,
      signature,
      tagged,
      mergedChunkCount,
      hasQuotientCycle,
    });
    if (run.verdict.kind === "pass") {
      green += 1;
    } else {
      red += 1;
    }
  }
  return { red, green, other, perSeed, signatureHistogram, verifiedMerged, verifiedCycle };
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
  process.stderr.write(`optimizer runtime-placement cycle campaign — ${CASES} seeds/variant\n`);

  const cells: Record<string, Record<string, Cell>> = {};
  const liveCatches: string[] = [];
  for (const variant of VARIANTS) {
    cells[variant] = {
      "npm-1.1.4": await runCell(variant, NPM_114, true),
      "npm-1.1.5": await runCell(variant, NPM_115, true),
      snapshot: await runCell(variant, SNAPSHOT, true),
    };
  }

  // The runtime-placement variant is the RED-3 bracket proof: RED on 1.1.4, GREEN on 1.1.5 + snapshot.
  const rp = cells["runtime-placement"]!;
  const rpBracketHolds =
    rp["npm-1.1.4"]!.red === CASES &&
    rp["npm-1.1.4"]!.signatureHistogram[
      'bundle-only-crash:["TypeError","__commonJSMin is not a function"]'
    ] === CASES &&
    rp["npm-1.1.5"]!.green === CASES &&
    rp.snapshot!.green === CASES;
  // A verified merge + quotient cycle must actually have fired on 1.1.4 (the recipe reached the optimizer).
  const rpVerified =
    rp["npm-1.1.4"]!.verifiedMerged === CASES && rp["npm-1.1.4"]!.verifiedCycle === CASES;

  // Any RED on a FIXED release (1.1.5 or snapshot), for either variant, is a LIVE CATCH.
  for (const variant of VARIANTS) {
    for (const target of ["npm-1.1.5", "snapshot"] as const) {
      const cell = cells[variant]![target]!;
      if (cell.red > 0) {
        liveCatches.push(
          `${variant} on ${target}: ${cell.red}/${CASES} RED — ${JSON.stringify(cell.signatureHistogram)}`,
        );
      }
    }
  }

  for (const variant of VARIANTS) {
    for (const target of ["npm-1.1.4", "npm-1.1.5", "snapshot"] as const) {
      const cell = cells[variant]![target]!;
      process.stdout.write(
        `${variant.padEnd(18)} ${target.padEnd(10)} red=${cell.red}/${CASES} green=${cell.green} ` +
          `merged=${cell.verifiedMerged} cycle=${cell.verifiedCycle}\n`,
      );
    }
  }
  process.stdout.write(
    `\nRED-3 bracket (runtime-placement): ${rpBracketHolds ? "HOLDS" : "VIOLATED"} ` +
      `(1.1.4 red __commonJSMin, 1.1.5+snapshot green); merge+cycle verified on 1.1.4: ${rpVerified}\n`,
  );
  if (liveCatches.length > 0) {
    process.stdout.write(`\n*** LIVE CATCHES (red on a fixed release) ***\n`);
    for (const line of liveCatches) {
      process.stdout.write(`  !! ${line}\n`);
    }
  }

  const accepted = rpBracketHolds && rpVerified;
  const evidence = {
    proof: "FW-B optimizer runtime-placement / facade cycle campaign (cluster 1.1)",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    cases: CASES,
    catchTag: CATCH_TAG,
    redThreeBracketHolds: rpBracketHolds,
    redThreeVerifiedMergeCycle: rpVerified,
    liveCatches,
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
      `\nOK: RED-3 reproduced by the GENERATOR — red on 1.1.4 (__commonJSMin), green on 1.1.5 + snapshot, merge+cycle verified\n`,
    );
    return 0;
  }
  process.stderr.write(
    `\nFAIL: the RED-3 generator bracket or merge/cycle verification did not hold\n`,
  );
  return 1;
}

process.exit(await main());
