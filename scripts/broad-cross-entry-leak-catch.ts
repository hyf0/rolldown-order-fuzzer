/// <reference types="node" />

/// FW-B deliverable 4 — the W14c follow-up: the BROADER cross-entry-leak at seo:false.
///
/// W14c recorded a residual "broader automatic-chunking cross-entry leak". This campaign's ablation
/// (`scratchpad/fw-b-probe/probe-d4b`) PINS the minimal trigger and CORRECTS it: the leak needs a
/// CO-LOCATING ORGANIC GROUP (entriesAware OR a PLAIN `test:".*"` group), NOT automatic chunking —
/// automatic chunking does NOT leak (verified GREEN on both targets; 0/28 random automatic multi-entry
/// seo:false cases leaked). The genuinely broader surface is PURELY STATIC: two mutually-unreachable
/// entries sharing a static module, each owning a private eager module, co-located by a plain organic
/// group; loading ONE entry runs the OTHER's private top-level (`reachability-isolation:[le2-b,le2-pb]`).
///
/// This is the SAME ROOT MECHANISM as #9998 (a co-locating organic group at seo:false runs a
/// disjoint-reachability entry's top-level), only a broader TRIGGER (static, no dynamic import; a plain
/// group suffices), so it FOLDS into the RED-9998 bracket-pending entry's notes — no new bracket. The bug
/// is OPEN on both npm rolldown@1.1.5 AND the snapshot (#9997 fixed only the strict path), so both cells
/// go RED and the seo:true control is GREEN (the leak is seo:false-only).
///
/// NOT part of `vp test`. Run:
///   NPM_ROLLDOWN=<dist> SNAPSHOT_ROLLDOWN=<dist> vp exec node scripts/broad-cross-entry-leak-catch.ts [cases]
/// Writes evidence to `.agents/evidence/broad-cross-entry-leak.json`.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildStaticCrossEntryLeak, generateStaticCrossEntryLeakCase } from "../src/generate.ts";
import { buildConfigOf } from "../src/model.ts";
import { SeededRng } from "../src/rng.ts";
import { executeProgram } from "../src/program-run.ts";

const NPM =
  process.env.NPM_ROLLDOWN ??
  "/tmp/order-fuzzer-regression-targets/1.1.5/node_modules/rolldown/dist/index.mjs";
const SNAPSHOT =
  process.env.SNAPSHOT_ROLLDOWN ??
  "/tmp/rolldown-strict-order-study/final-snapshot-42628c18b/rolldown/dist/index.mjs";
const CASES = Number(process.argv[2] ?? process.env.CASES ?? "20");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_OUT =
  process.env.EVIDENCE_OUT ?? resolve(REPO_ROOT, ".agents/evidence/broad-cross-entry-leak.json");
const CATCH_TAG = "mechanism:cross-entry-leak";
const ISOLATION_REASON = "reachability-isolation";

interface Tally {
  redIsolation: number;
  green: number;
  other: string[];
  signatureHistogram: Record<string, number>;
}

async function runCell(rolldownPackage: string): Promise<Tally> {
  let redIsolation = 0;
  let green = 0;
  const other: string[] = [];
  const signatureHistogram: Record<string, number> = {};
  for (let seed = 0; seed < CASES; seed += 1) {
    const generated = generateStaticCrossEntryLeakCase(seed);
    if (!generated.coverageTags.includes(CATCH_TAG)) {
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
    if (run.verdict.kind === "pass") {
      green += 1;
      other.push(`seed ${seed}: GREEN (expected an isolation RED)`);
    } else if (run.verdict.kind === "mismatch" && run.verdict.reason === ISOLATION_REASON) {
      redIsolation += 1;
    } else {
      other.push(`seed ${seed}: ${run.verdict.kind} ${signature.slice(0, 70)}`);
    }
  }
  return { redIsolation, green, other, signatureHistogram };
}

async function runSeoTrueControl(
  rolldownPackage: string,
): Promise<{ green: boolean; signature: string }> {
  const { program } = buildStaticCrossEntryLeak(new SeededRng(0));
  const seoTrue = { ...program, build: { ...buildConfigOf(program), strictExecutionOrder: true } };
  const run = await executeProgram(seoTrue, { rolldownPackage, onDemandWrapping: true });
  return {
    green: run.verdict.kind === "pass",
    signature: run.verdict.kind === "pass" ? "pass" : run.verdict.signature,
  };
}

/// The AUTOMATIC-chunking control: the SAME shape at seo:false but with the co-locating organic group
/// REMOVED (automatic chunking). If it stays GREEN the group is load-bearing and the "automatic chunking
/// does not leak" disproof is MEASURED from this script (not a hardcoded literal). Runs on the snapshot.
async function runAutomaticControl(
  rolldownPackage: string,
): Promise<{ green: boolean; signature: string }> {
  const { program } = buildStaticCrossEntryLeak(new SeededRng(0));
  const automatic = {
    ...program,
    build: { ...buildConfigOf(program), chunking: { kind: "automatic" as const } },
  };
  const run = await executeProgram(automatic, { rolldownPackage, onDemandWrapping: true });
  return {
    green: run.verdict.kind === "pass",
    signature: run.verdict.kind === "pass" ? "pass" : run.verdict.signature,
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
  if (!Number.isInteger(CASES) || CASES <= 0) {
    process.stderr.write(`FAIL: CASES must be a positive integer, received ${String(CASES)}\n`);
    return 2;
  }
  process.stderr.write(`broader static cross-entry-leak (W14c follow-up) — ${CASES} seeds\n`);

  const npm = await runCell(NPM);
  const snapshot = await runCell(SNAPSHOT);
  const control = await runSeoTrueControl(SNAPSHOT);
  // The load-bearing controls: seo:true (the leak is seo:false-only) AND automatic chunking on BOTH
  // targets (the group — not seo:false alone — is what leaks; the "automatic does not leak" disproof is
  // MEASURED here, not asserted).
  const automaticNpm = await runAutomaticControl(NPM);
  const automaticSnapshot = await runAutomaticControl(SNAPSHOT);

  process.stdout.write(
    `npm 1.1.5   isolation-red=${npm.redIsolation}/${CASES}  green=${npm.green}\n`,
  );
  process.stdout.write(
    `snapshot    isolation-red=${snapshot.redIsolation}/${CASES}  green=${snapshot.green}\n`,
  );
  process.stdout.write(
    `seo:true control: ${control.green ? "GREEN" : `RED ${control.signature}`}\n`,
  );
  process.stdout.write(
    `automatic-chunking control (seo:false): npm=${automaticNpm.green ? "GREEN" : `RED ${automaticNpm.signature}`} snapshot=${automaticSnapshot.green ? "GREEN" : `RED ${automaticSnapshot.signature}`}\n`,
  );
  for (const line of [...npm.other, ...snapshot.other]) {
    process.stdout.write(`  ! ${line}\n`);
  }

  // The disproof is MEASURED: automatic chunking stays GREEN on both targets (a red here would mean
  // automatic chunking leaks after all — the disproof would be wrong, and acceptance fails).
  const automaticStaysGreen = automaticNpm.green && automaticSnapshot.green;
  const accepted =
    CASES >= 20 &&
    npm.redIsolation === CASES &&
    npm.other.length === 0 &&
    snapshot.redIsolation === CASES &&
    snapshot.other.length === 0 &&
    control.green &&
    automaticStaysGreen;

  const evidence = {
    proof:
      "FW-B W14c follow-up: broader STATIC cross-entry-leak at seo:false — same root as #9998, AUTOMATIC chunking disproven",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    cases: CASES,
    catchTag: CATCH_TAG,
    ablation: {
      minimalTrigger:
        "two mutually-unreachable entries sharing a static module + private eager modules, co-located by a PLAIN organic group (test:'.*'), seo:false; load ONE entry -> the OTHER's private top-level runs",
      automaticChunkingLeaks: !automaticStaysGreen,
      automaticChunkingNote:
        "AUTOMATIC chunking does NOT leak — MEASURED by the automatic-chunking control below (the SAME shape at seo:false with the group removed stays GREEN on both targets); the W14c 'automatic chunking' characterization is disproven, a co-locating organic group is load-bearing. (An out-of-band random scan also found 0/28 automatic multi-entry seo:false leaks.)",
      sameRootAsRed9998: true,
      broaderThanRed9998:
        "no dynamic import required (purely static) and a plain organic group suffices (not only entriesAware)",
      foldedIntoRed9998: true,
    },
    seoTrueControl: control,
    automaticChunkingControl: { npm: automaticNpm, snapshot: automaticSnapshot },
    targets: {
      npm: { path: NPM, sha256: sha256OfFile(NPM) },
      snapshot: { path: SNAPSHOT, sha256: sha256OfFile(SNAPSHOT) },
    },
    accepted,
    cells: {
      npm: {
        redIsolation: npm.redIsolation,
        green: npm.green,
        signatureHistogram: npm.signatureHistogram,
      },
      snapshot: {
        redIsolation: snapshot.redIsolation,
        green: snapshot.green,
        signatureHistogram: snapshot.signatureHistogram,
      },
    },
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`\nwrote evidence to ${EVIDENCE_OUT}\n`);

  if (accepted) {
    process.stdout.write(
      `\nOK: broader static cross-entry-leak — isolation RED ${CASES}/${CASES} on BOTH targets, seo:true control GREEN (folds into RED-9998; automatic chunking disproven)\n`,
    );
    return 0;
  }
  process.stderr.write(`\nFAIL: the broader-leak acceptance did not hold\n`);
  return 1;
}

process.exit(await main());
