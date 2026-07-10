/// <reference types="node" />

/// W14c seo:false SANITY cell — proves the reachability-isolation oracle does NOT false-positive on
/// accepted relaxed-order behavior.
///
/// It generates `seo:false` cases over ordinary random shapes and keeps the SINGLE-ENTRY ones: a
/// single-entry program can have NO cross-entry leak (everything the bundle runs is reachable from the
/// one entry), so ANY `reachability-isolation` verdict on it would be a genuine oracle false positive.
/// Meanwhile the bundle STILL reshuffles eager-module order at `seo:false` — a divergence the FULL-order
/// oracle would red (`events-reordered`/`events-mismatch`) — so the sanity ALSO reports how many green
/// cases the full-order oracle WOULD have flagged: those are the accepted relaxed-order divergences the
/// isolation oracle correctly ignores. (A multi-entry seo:false program CAN genuinely leak cross-entry
/// even with automatic chunking — loading a downstream entry runs an upstream entry's top-level — which
/// is a TRUE positive, not a sanity failure; single-entry cases exclude that so the sanity is clean.)
///
/// NOT part of `vp test` (it spawns a Rolldown build per case). Run:
///
///   SANITY_SNAPSHOT=<dist/index.mjs> vp exec node scripts/seo-false-sanity.ts [cases] [seedBase]
///
/// Writes evidence to `.agents/evidence/seo-false-sanity.json`.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateCase, sampleCaseSize } from "../src/generate.ts";
import { executeProgram } from "../src/program-run.ts";
import { SeededRng } from "../src/rng.ts";
import { classifyVerdict } from "../src/verdict.ts";

const SNAPSHOT =
  process.env.SANITY_SNAPSHOT ??
  "/tmp/rolldown-strict-order-study/final-snapshot-42628c18b/rolldown/dist/index.mjs";
const CASES = Number(process.argv[2] ?? process.env.CASES ?? "300");
const SEED_BASE = Number(process.argv[3] ?? process.env.SEED_BASE ?? "500000");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_OUT =
  process.env.EVIDENCE_OUT ?? resolve(REPO_ROOT, ".agents/evidence/seo-false-sanity.json");
const ISOLATION_REASON = "reachability-isolation";

interface SeedVerdict {
  readonly seed: number;
  readonly kind: string;
  readonly reason: string;
}

async function main(): Promise<number> {
  if (!Number.isInteger(CASES) || CASES <= 0) {
    process.stderr.write(`FAIL: CASES must be a positive integer, received ${String(CASES)}\n`);
    return 2;
  }
  process.stderr.write(`seo:false sanity — ${CASES} single-entry cases, snapshot ${SNAPSHOT}\n`);

  let kept = 0;
  let scanned = 0;
  let isolationGreen = 0;
  let nonIsolationOther = 0;
  let relaxedOrderIgnored = 0;
  const isolationFalsePositives: SeedVerdict[] = [];
  const signatureHistogram: Record<string, number> = {};

  // Scan seeds, keeping SINGLE-ENTRY seo:false cases until CASES are collected.
  for (let seed = SEED_BASE; kept < CASES && scanned < CASES * 20; seed += 1) {
    scanned += 1;
    const size = sampleCaseSize(new SeededRng(seed));
    const generated = generateCase(seed, size, undefined, { strictExecutionOrder: false });
    if (generated.program.entries.length !== 1) {
      continue;
    }
    kept += 1;
    const run = await executeProgram(
      generated.program,
      { rolldownPackage: SNAPSHOT, onDemandWrapping: true },
      {},
      generated.analyzed,
    );
    const reason = run.verdict.kind === "mismatch" ? run.verdict.reason : run.verdict.kind;
    const signature = run.verdict.kind === "pass" ? "pass" : run.verdict.signature;
    signatureHistogram[signature] = (signatureHistogram[signature] ?? 0) + 1;

    if (run.verdict.kind === "mismatch" && run.verdict.reason === ISOLATION_REASON) {
      // A single-entry program cannot leak cross-entry — any isolation verdict is a false positive.
      isolationFalsePositives.push({ seed, kind: run.verdict.kind, reason });
    } else if (run.verdict.kind === "pass") {
      isolationGreen += 1;
      // Would the FULL-order oracle have red-flagged this green case? If so, the bundle reshuffled
      // eager-module order (accepted relaxed order the isolation oracle correctly ignored).
      if (
        run.bundleOutcome.status === "ok" &&
        classifyVerdict(run.sourceOutcome, run.bundleOutcome).kind !== "pass"
      ) {
        relaxedOrderIgnored += 1;
      }
    } else {
      // A bundle-only-crash / other non-isolation verdict is a different, legitimate divergence.
      nonIsolationOther += 1;
    }
  }

  process.stdout.write(
    `\nsingle-entry: kept=${kept} (scanned ${scanned})  isolation-green=${isolationGreen}  ` +
      `non-isolation-other=${nonIsolationOther}  isolation-false-positives=${isolationFalsePositives.length}\n`,
  );
  process.stdout.write(
    `relaxed-order divergences the isolation oracle IGNORED (full-order would red): ${relaxedOrderIgnored}\n`,
  );
  for (const fp of isolationFalsePositives) {
    process.stdout.write(`  ! FALSE POSITIVE seed ${fp.seed}: ${fp.reason}\n`);
  }

  // Acceptance: ZERO isolation-oracle false positives on single-entry shapes.
  const accepted = isolationFalsePositives.length === 0 && kept >= CASES;

  const evidence = {
    proof: "W14c seo:false sanity — the isolation oracle does not false-positive on relaxed order",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    casesRequested: CASES,
    kept,
    scanned,
    seedBase: SEED_BASE,
    snapshot: { path: SNAPSHOT, sha256: sha256OfFile(SNAPSHOT) },
    accepted,
    isolationGreen,
    nonIsolationOther,
    relaxedOrderIgnored,
    isolationFalsePositives,
    signatureHistogram,
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`\nwrote evidence to ${EVIDENCE_OUT}\n`);

  if (accepted) {
    process.stdout.write(
      `\nOK: ${kept} single-entry seo:false cases, ZERO isolation false positives, ` +
        `${relaxedOrderIgnored} relaxed-order divergences correctly ignored\n`,
    );
    return 0;
  }
  process.stderr.write(
    `\nFAIL: ${isolationFalsePositives.length} isolation false positive(s) on single-entry seo:false shapes (kept ${kept})\n`,
  );
  return 1;
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

process.exit(await main());
