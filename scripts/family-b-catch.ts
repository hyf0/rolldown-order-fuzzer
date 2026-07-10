/// <reference types="node" />

/// W14b family-B acceptance harness — the vben eager-barrel shape (`initPreferences is not a
/// function`; fixed upstream by "resolve strict-order init through tree-shaken eager forwarder hops").
///
/// A directed campaign of the `buildFamilyBEagerBarrel` shape (`generate.ts`), run against the FROZEN
/// PR-10104 snapshot — which CONTAINS bug B — in BOTH wrap modes on the SAME seeds:
///
///   - on-demand (od): expect RED — the eager metadata-pure barrel's tree-shaken star hop drops the
///     facade's init, the entry's hiddenReadFn folds `undefined`, and the event channel rejects the
///     NaN (`bundle-only-crash`);
///   - wrap-all (wa): expect GREEN — every module is wrapped, init+value import unconditionally.
///
/// That SAME-SEED od-RED / wa-GREEN split IS the family-B fingerprint (family A reds BOTH modes), and
/// the wa cell is the internal control — no second rolldown build is needed. A lazyBarrel:true pair
/// of cells reruns the same seeds under rolldown's lazy barrel path (deliverable 3c): the split held
/// there too when probed; the evidence records whatever the run finds.
///
/// Like the #9887 harness this is NOT part of `vp test` (it spawns a rolldown build per case against
/// an out-of-tree snapshot). Run on demand:
///
///   FIXED_ROLLDOWN=<dist/index.mjs> vp exec node scripts/family-b-catch.ts [cases]
///
/// Writes a machine-readable evidence file (`EVIDENCE_OUT`, default
/// `.agents/evidence/family-b-eager-barrel.json`): per-seed verdicts in BOTH modes for both lazyBarrel
/// values, the signature histogram per cell, HEAD + dirty status, node version, and the target dist
/// sha256 — so the red/green proof is reproducible from a committed record.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateFamilyBEagerBarrelCase } from "../src/generate.ts";
import { executeProgram } from "../src/program-run.ts";

const SNAPSHOT =
  process.env.FIXED_ROLLDOWN ??
  "/tmp/rolldown-strict-order-study/pr10104-runtime-snapshot/rolldown/dist/index.mjs";
const CASES = Number(process.argv[2] ?? process.env.CASES ?? "20");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_OUT =
  process.env.EVIDENCE_OUT ?? resolve(REPO_ROOT, ".agents/evidence/family-b-eager-barrel.json");
const CATCH_TAG = "mechanism:family-b-eager-barrel";
/// The family-B red on this shape is the NaN fold of the dropped facade init — the same
/// primitive-JSON rejection string family A produces; the od/wa SPLIT (not the string) is the
/// family-B fingerprint, so the harness asserts the split per seed.
const NAN_FAMILY = /Execution event value must be a primitive JSON value/;

interface SeedVerdict {
  readonly seed: number;
  readonly kind: string;
  readonly signature: string;
  readonly tagged: boolean;
}

interface Cell {
  readonly red: number;
  readonly redNanFamily: number;
  readonly green: number;
  readonly other: string[];
  readonly perSeed: SeedVerdict[];
  readonly signatureHistogram: Record<string, number>;
}

async function runCell(onDemandWrapping: boolean, lazyBarrel: boolean): Promise<Cell> {
  let red = 0;
  let redNanFamily = 0;
  let green = 0;
  const other: string[] = [];
  const perSeed: SeedVerdict[] = [];
  const signatureHistogram: Record<string, number> = {};
  for (let seed = 0; seed < CASES; seed += 1) {
    const generated = generateFamilyBEagerBarrelCase(seed, { lazyBarrel });
    const tagged = generated.coverageTags.includes(CATCH_TAG);
    if (!tagged) {
      other.push(`seed ${seed}: NOT TAGGED ${CATCH_TAG}`);
    }
    const run = await executeProgram(
      generated.program,
      { rolldownPackage: SNAPSHOT, onDemandWrapping },
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
      if (NAN_FAMILY.test(run.verdict.signature)) {
        redNanFamily += 1;
      } else {
        other.push(`seed ${seed}: red but not NaN-family: ${run.verdict.signature}`);
      }
    } else {
      other.push(`seed ${seed}: ${run.verdict.kind} ${run.verdict.signature.slice(0, 80)}`);
    }
  }
  return { red, redNanFamily, green, other, perSeed, signatureHistogram };
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
  process.stderr.write(`family-B eager-barrel catch — ${CASES} seeds, both modes\n`);
  process.stderr.write(`  TARGET (contains bug B): ${SNAPSHOT}\n`);

  const od = await runCell(true, false);
  const wa = await runCell(false, false);
  const odLazy = await runCell(true, true);
  const waLazy = await runCell(false, true);

  process.stdout.write(
    `\nlazyBarrel=false  od red=${od.red}/${CASES} (NaN-family ${od.redNanFamily}) green=${od.green}` +
      `  |  wa green=${wa.green}/${CASES} red=${wa.red}\n`,
  );
  process.stdout.write(
    `lazyBarrel=true   od red=${odLazy.red}/${CASES} (NaN-family ${odLazy.redNanFamily}) green=${odLazy.green}` +
      `  |  wa green=${waLazy.green}/${CASES} red=${waLazy.red}\n`,
  );
  for (const line of [...od.other, ...wa.other, ...odLazy.other, ...waLazy.other]) {
    process.stdout.write(`  ! ${line}\n`);
  }

  // Acceptance: on EVERY seed the same-seed cells SPLIT — od RED with the NaN-family signature and
  // wa GREEN — under the fixture's lazyBarrel:false; no stray (`other`) verdict anywhere. The
  // lazyBarrel:true cells are REPORTED (3c: both axis values exercised) and fold into acceptance the
  // same way — a divergence there would be a finding, not a silent pass.
  const accepted =
    CASES > 0 &&
    od.redNanFamily === CASES &&
    od.green === 0 &&
    od.other.length === 0 &&
    wa.green === CASES &&
    wa.red === 0 &&
    wa.other.length === 0 &&
    odLazy.redNanFamily === CASES &&
    odLazy.other.length === 0 &&
    waLazy.green === CASES &&
    waLazy.other.length === 0;

  const evidence = {
    proof:
      "family-B eager-barrel (vben initPreferences shape): same-seed od-RED / wa-GREEN split on the frozen snapshot",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    cases: CASES,
    catchTag: CATCH_TAG,
    target: { path: SNAPSHOT, sha256: sha256OfFile(SNAPSHOT) },
    accepted,
    cells: {
      "od-lazyBarrel-false": {
        red: od.red,
        redNanFamily: od.redNanFamily,
        green: od.green,
        signatureHistogram: od.signatureHistogram,
        perSeed: od.perSeed,
      },
      "wa-lazyBarrel-false": {
        red: wa.red,
        redNanFamily: wa.redNanFamily,
        green: wa.green,
        signatureHistogram: wa.signatureHistogram,
        perSeed: wa.perSeed,
      },
      "od-lazyBarrel-true": {
        red: odLazy.red,
        redNanFamily: odLazy.redNanFamily,
        green: odLazy.green,
        signatureHistogram: odLazy.signatureHistogram,
        perSeed: odLazy.perSeed,
      },
      "wa-lazyBarrel-true": {
        red: waLazy.red,
        redNanFamily: waLazy.redNanFamily,
        green: waLazy.green,
        signatureHistogram: waLazy.signatureHistogram,
        perSeed: waLazy.perSeed,
      },
    },
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`\nwrote evidence to ${EVIDENCE_OUT}\n`);

  if (accepted) {
    process.stdout.write(
      `\nOK: family-B confirmed — same-seed od-RED / wa-GREEN split on every seed (both lazyBarrel values)\n`,
    );
    return 0;
  }
  process.stderr.write(`\nFAIL: the od-red/wa-green split did not hold on every seed\n`);
  return 1;
}

process.exit(await main());
