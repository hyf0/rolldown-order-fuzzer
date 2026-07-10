/// <reference types="node" />

/// W14c live-catch acceptance harness — rolldown #9998 (manual codeSplitting groups leak cross-entry
/// execution WITHOUT `strictExecutionOrder`).
///
/// A directed campaign of the `buildCrossEntryLeakCase` shape (`generate.ts`) — the fuzzer-model
/// translation of the issue's verified repro (two entries; `b` dynamically imports `shared`; `a`
/// statically imports it and runs its own top-level effect; an `entriesAware` codeSplitting group with
/// a large `entriesAwareMergeThreshold`, at `strictExecutionOrder:false`). Run against BOTH targets,
/// under the REACHABILITY-ISOLATION oracle the persisted `seo:false` axis selects:
///
///   - the leak is OPEN on BOTH npm rolldown@1.1.5 AND the final PR-10104 snapshot (the fix landed only
///     for the `seo:true` path, #9997), so BOTH cells go RED with the isolation-violation signature
///     `reachability-isolation:[le-a]` (loading entry `b` ran entry `a`'s top-level).
///
/// There is NO green target (the bug is open everywhere at `seo:false`), so the acceptance is: every
/// seed RED with the isolation signature on both targets, and the shape is tagged
/// `mechanism:cross-entry-leak`. The seo:true CONTROL (same shape, strictExecutionOrder flipped) is
/// GREEN — proving the leak is seo:false-only — and is verified inline. Registered as a BRACKET-PENDING
/// entry in `regression/index.json` per the red-set discipline (a bracket with no green target yet).
///
/// NOT part of `vp test` (it spawns a Rolldown build per case against out-of-tree builds). Run:
///
///   NPM_ROLLDOWN=<dist/index.mjs> SNAPSHOT_ROLLDOWN=<dist/index.mjs> \
///     vp exec node scripts/cross-entry-leak-catch.ts [cases]
///
/// Writes machine-readable evidence (`EVIDENCE_OUT`, default
/// `.agents/evidence/9998-cross-entry-leak.json`): per-seed verdicts, the signature histogram, the
/// seo:true control result, HEAD + dirty status, node version, and each target's dist sha256.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCrossEntryLeakCase, generateCrossEntryLeakCase } from "../src/generate.ts";
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
  process.env.EVIDENCE_OUT ?? resolve(REPO_ROOT, ".agents/evidence/9998-cross-entry-leak.json");
const CATCH_TAG = "mechanism:cross-entry-leak";
const ISOLATION_REASON = "reachability-isolation";

interface SeedVerdict {
  readonly seed: number;
  readonly kind: string;
  readonly reason: string;
  readonly signature: string;
  readonly tagged: boolean;
}

interface Tally {
  readonly redIsolation: number;
  readonly green: number;
  readonly other: string[];
  readonly perSeed: SeedVerdict[];
  readonly signatureHistogram: Record<string, number>;
}

async function runCell(rolldownPackage: string): Promise<Tally> {
  let redIsolation = 0;
  let green = 0;
  const other: string[] = [];
  const perSeed: SeedVerdict[] = [];
  const signatureHistogram: Record<string, number> = {};
  for (let seed = 0; seed < CASES; seed += 1) {
    const generated = generateCrossEntryLeakCase(seed);
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
    const reason = run.verdict.kind === "mismatch" ? run.verdict.reason : run.verdict.kind;
    const signature = run.verdict.kind === "pass" ? "pass" : run.verdict.signature;
    signatureHistogram[signature] = (signatureHistogram[signature] ?? 0) + 1;
    perSeed.push({ seed, kind: run.verdict.kind, reason, signature, tagged });
    if (run.verdict.kind === "pass") {
      green += 1;
      other.push(`seed ${seed}: GREEN (expected an isolation RED)`);
    } else if (run.verdict.kind === "mismatch" && run.verdict.reason === ISOLATION_REASON) {
      redIsolation += 1;
    } else {
      other.push(`seed ${seed}: ${run.verdict.kind}/${reason} ${signature.slice(0, 80)}`);
    }
  }
  return { redIsolation, green, other, perSeed, signatureHistogram };
}

/// The seo:true CONTROL: the SAME shape with `strictExecutionOrder` flipped to true runs under the
/// FULL-ORDER oracle and is GREEN — proving the leak is seo:false-only (#9997 fixed the strict path).
async function runSeoTrueControl(rolldownPackage: string): Promise<{
  readonly green: boolean;
  readonly kind: string;
  readonly signature: string;
}> {
  const { program } = buildCrossEntryLeakCase(new SeededRng(0));
  const seoTrue = {
    ...program,
    build: { ...buildConfigOf(program), strictExecutionOrder: true },
  };
  const run = await executeProgram(seoTrue, { rolldownPackage, onDemandWrapping: true });
  return {
    green: run.verdict.kind === "pass",
    kind: run.verdict.kind,
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
  process.stderr.write(`#9998 cross-entry-leak live catch — ${CASES} seeds\n`);
  process.stderr.write(`  npm (expect isolation RED): ${NPM}\n`);
  process.stderr.write(`  snapshot (expect isolation RED): ${SNAPSHOT}\n`);

  const npm = await runCell(NPM);
  const snapshot = await runCell(SNAPSHOT);
  const control = await runSeoTrueControl(SNAPSHOT);

  process.stdout.write(
    `\nnpm 1.1.5   isolation-red=${npm.redIsolation}/${CASES}  green=${npm.green}\n`,
  );
  process.stdout.write(
    `snapshot    isolation-red=${snapshot.redIsolation}/${CASES}  green=${snapshot.green}\n`,
  );
  process.stdout.write(
    `seo:true control (snapshot): ${control.green ? "GREEN" : `RED ${control.signature}`}\n`,
  );
  for (const line of [...npm.other, ...snapshot.other]) {
    process.stdout.write(`  ! ${line}\n`);
  }

  // Acceptance: EVERY seed RED with the isolation signature on BOTH targets (the bug is open
  // everywhere), no stray verdicts, and the seo:true control is GREEN (the leak is seo:false-only).
  const accepted =
    CASES > 0 &&
    npm.redIsolation === CASES &&
    npm.other.length === 0 &&
    snapshot.redIsolation === CASES &&
    snapshot.other.length === 0 &&
    control.green;

  const evidence = {
    proof: "rolldown#9998 cross-entry-leak live catch (seo:false isolation oracle)",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    cases: CASES,
    catchTag: CATCH_TAG,
    note: "Bug OPEN on both targets at seo:false (no green target) — a bracket-pending regression entry.",
    targets: {
      npm: { path: NPM, sha256: sha256OfFile(NPM) },
      snapshot: { path: SNAPSHOT, sha256: sha256OfFile(SNAPSHOT) },
    },
    seoTrueControl: control,
    accepted,
    cells: {
      npm: {
        redIsolation: npm.redIsolation,
        green: npm.green,
        signatureHistogram: npm.signatureHistogram,
        perSeed: npm.perSeed,
      },
      snapshot: {
        redIsolation: snapshot.redIsolation,
        green: snapshot.green,
        signatureHistogram: snapshot.signatureHistogram,
        perSeed: snapshot.perSeed,
      },
    },
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`\nwrote evidence to ${EVIDENCE_OUT}\n`);

  if (accepted) {
    process.stdout.write(
      `\nOK: #9998 caught — isolation RED (reachability-isolation:[le-a]) on npm 1.1.5 AND the snapshot, seo:true control GREEN\n`,
    );
    return 0;
  }
  process.stderr.write(`\nFAIL: the isolation-catch acceptance did not hold on every seed\n`);
  return 1;
}

process.exit(await main());
