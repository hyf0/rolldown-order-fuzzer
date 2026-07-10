/// <reference types="node" />

/// W14-10 live-catch acceptance harness — rolldown #9887 (barrel/CJS cross-chunk `init_*` cycle).
///
/// A directed campaign of the `buildCrossChunkInitCycle` shape (`generate.ts`), run BIDIRECTIONALLY at
/// the fuzzer's strict-execution-order regime:
///
///   - vs a BUGGY build (npm rolldown@1.1.5, or npm@1.1.2) it goes RED with the `init_* is not a function`
///     family signature (`bundle-only-crash`), and
///   - vs the FIXED PR-10104 snapshot the SAME seeds are GREEN (the snapshot fixed the seo:true path).
///
/// That natural red/green pair IS the acceptance: the fuzzer catches an OPEN bug on the latest released
/// rolldown while staying green on the fixed build. Like `catching-power`, this is NOT part of `vp test`
/// (it spawns a Rolldown build per case against out-of-tree builds). Run on demand:
///
///   BUGGY_ROLLDOWN=<dist/index.mjs> FIXED_ROLLDOWN=<dist/index.mjs> \
///     vp exec node scripts/cross-chunk-init-cycle-catch.ts [cases]
///
/// Defaults: BUGGY = npm rolldown@1.1.5 (the pre-pinned tarball install), FIXED = the PR-10104 snapshot.
/// The shape is deterministic (the seed only varies the cosmetic fold value), so every seed reproduces the
/// same verdict pair; multiple seeds simply confirm robustness. See `.agents/docs/w14a-structural-foundation.md`
/// and the pre-pin matrix at /tmp/w14-red-targets/MATRIX.md.
///
/// On every run it writes a MACHINE-READABLE evidence file (`EVIDENCE_OUT`, default
/// `.agents/evidence/9887-cross-chunk-init-cycle.json`): per-seed verdicts, the signature histogram, the
/// HEAD hash + dirty status, the node version, and the sha256 of each target's `dist` bundle — so the
/// red/green proof is reproducible from a committed record, not just console output.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateCrossChunkInitCycleCase } from "../src/generate.ts";
import { executeProgram } from "../src/program-run.ts";

const BUGGY =
  process.env.BUGGY_ROLLDOWN ??
  "/tmp/w14-red-targets/pkgs/npm-latest/node_modules/rolldown/dist/index.mjs";
const FIXED =
  process.env.FIXED_ROLLDOWN ??
  "/tmp/rolldown-strict-order-study/pr10104-runtime-snapshot/rolldown/dist/index.mjs";
const CASES = Number(process.argv[2] ?? process.env.CASES ?? "20");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_OUT =
  process.env.EVIDENCE_OUT ??
  resolve(REPO_ROOT, ".agents/evidence/9887-cross-chunk-init-cycle.json");
const CATCH_TAG = "mechanism:barrel-cross-chunk-init-cycle";
/// The `init_* is not a function` family: Rolldown renames the dep module (`init_module_NNNN`), so match
/// the stable core of the runtime `TypeError` rather than the exact module id.
const INIT_FAMILY = /init_\w+ is not a function/;

interface SeedVerdict {
  readonly seed: number;
  readonly kind: string;
  readonly signature: string;
  readonly tagged: boolean;
}

interface Tally {
  readonly red: number;
  readonly redInitFamily: number;
  readonly green: number;
  readonly other: string[];
  readonly perSeed: SeedVerdict[];
  readonly signatureHistogram: Record<string, number>;
}

async function runCell(rolldownPackage: string): Promise<Tally> {
  let red = 0;
  let redInitFamily = 0;
  let green = 0;
  const other: string[] = [];
  const perSeed: SeedVerdict[] = [];
  const signatureHistogram: Record<string, number> = {};
  for (let seed = 0; seed < CASES; seed += 1) {
    const generated = generateCrossChunkInitCycleCase(seed);
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
    perSeed.push({ seed, kind: run.verdict.kind, signature, tagged });
    if (run.verdict.kind === "pass") {
      green += 1;
    } else if (run.verdict.kind === "mismatch" && run.verdict.reason === "bundle-only-crash") {
      red += 1;
      if (INIT_FAMILY.test(run.verdict.signature)) {
        redInitFamily += 1;
      } else {
        other.push(`seed ${seed}: red but not init-family: ${run.verdict.signature}`);
      }
    } else {
      other.push(`seed ${seed}: ${run.verdict.kind} ${run.verdict.signature.slice(0, 80)}`);
    }
  }
  return { red, redInitFamily, green, other, perSeed, signatureHistogram };
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
  process.stderr.write(`#9887 cross-chunk init-cycle live catch — ${CASES} seeds\n`);
  process.stderr.write(`  BUGGY (expect RED): ${BUGGY}\n`);
  process.stderr.write(`  FIXED (expect GREEN): ${FIXED}\n`);

  const buggy = await runCell(BUGGY);
  const fixed = await runCell(FIXED);

  process.stdout.write(
    `\nBUGGY  red=${buggy.red}/${CASES} (init-family ${buggy.redInitFamily})  green=${buggy.green}\n`,
  );
  process.stdout.write(`FIXED  green=${fixed.green}/${CASES}  red=${fixed.red}\n`);
  for (const line of [...buggy.other, ...fixed.other]) {
    process.stdout.write(`  ! ${line}\n`);
  }

  // Acceptance: CASES is positive, EVERY seed is RED-with-init-family on the buggy build and GREEN on the
  // fixed build, and NO seed produced an unexpected (`other`) signature in either cell — a stray verdict
  // (an untagged case, a non-init-family red, a harness error) fails the proof rather than being ignored.
  const accepted =
    CASES > 0 &&
    buggy.redInitFamily === CASES &&
    buggy.green === 0 &&
    buggy.other.length === 0 &&
    fixed.green === CASES &&
    fixed.red === 0 &&
    fixed.other.length === 0;

  const evidence = {
    proof: "rolldown#9887 cross-chunk init-cycle live catch",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    cases: CASES,
    catchTag: CATCH_TAG,
    targets: {
      buggy: { path: BUGGY, sha256: sha256OfFile(BUGGY) },
      fixed: { path: FIXED, sha256: sha256OfFile(FIXED) },
    },
    accepted,
    cells: {
      buggy: {
        red: buggy.red,
        redInitFamily: buggy.redInitFamily,
        green: buggy.green,
        signatureHistogram: buggy.signatureHistogram,
        perSeed: buggy.perSeed,
      },
      fixed: {
        red: fixed.red,
        redInitFamily: fixed.redInitFamily,
        green: fixed.green,
        signatureHistogram: fixed.signatureHistogram,
        perSeed: fixed.perSeed,
      },
    },
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`\nwrote evidence to ${EVIDENCE_OUT}\n`);

  if (accepted) {
    process.stdout.write(
      `\nOK: live catch confirmed — RED (init_* is not a function) on the buggy build, GREEN on the fixed build\n`,
    );
    return 0;
  }
  process.stderr.write(`\nFAIL: the red/green acceptance pair did not hold on every seed\n`);
  return 1;
}

process.exit(await main());
