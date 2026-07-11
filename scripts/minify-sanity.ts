/// <reference types="node" />

/// W12 deliverable 4 — the MINIFY-SANITY cell.
///
/// Ordinary (random-mixed) shapes built with `minify: true` against the FINAL PR-10104 snapshot (the
/// fixed strict-order arc) must be GREEN — a red there would be either a NORMALIZER false-positive (the
/// oracle mistook a legal identifier rename for a divergence — a gap in the minify error normalizer) or a
/// genuine minify-only catch on the fixed build. To distinguish the two PRECISELY, every case is run at
/// BOTH `minify: false` and `minify: true`: a minify:true red whose minify:false twin is GREEN is a
/// MINIFY-INTRODUCED red (a normalizer gap or a real minify-only defect) and fails the cell; a red present
/// at BOTH settings is a pre-existing (non-minify) divergence on the arc, unrelated to this axis.
///
/// This is the direct proof that the error normalizer does not weaken (over-loosen would be caught by the
/// wrapper campaign; over-tighten — a false positive — is caught HERE).
///
/// NOT part of `vp test` (out-of-tree builds). Run:
///
///   MINIFY_SANITY_SNAPSHOT=<dist> vp exec node scripts/minify-sanity.ts [cases]
///
/// Writes evidence to `.agents/evidence/minify-sanity.json`.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateCase, sampleCaseSize } from "../src/generate.ts";
import { executeProgram } from "../src/program-run.ts";
import { buildConfigOf, type ProgramModel } from "../src/model.ts";
import { SeededRng } from "../src/rng.ts";

const SNAPSHOT =
  process.env.MINIFY_SANITY_SNAPSHOT ??
  "/tmp/rolldown-strict-order-study/final-snapshot-42628c18b/rolldown/dist/index.mjs";
const CASES = Number(process.argv[2] ?? process.env.CASES ?? "300");
const SEED_BASE = 300_000;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_OUT =
  process.env.EVIDENCE_OUT ?? resolve(REPO_ROOT, ".agents/evidence/minify-sanity.json");

function withMinify(program: ProgramModel, minify: boolean): ProgramModel {
  return { ...program, build: { ...buildConfigOf(program), minify } };
}

interface Introduced {
  readonly seed: number;
  readonly outputFormat: string;
  readonly onDemandWrapping: boolean;
  readonly minifiedSignature: string;
}

async function main(): Promise<number> {
  process.stderr.write(`W12 minify-sanity — ${CASES} cases, snapshot ${SNAPSHOT}\n`);
  let minifiedGreen = 0;
  let minifiedRed = 0;
  let preexistingRed = 0; // red at BOTH minify:false and minify:true (not this axis's concern)
  const introduced: Introduced[] = [];
  const signatureHistogram: Record<string, number> = {};

  for (let index = 0; index < CASES; index += 1) {
    const seed = SEED_BASE + index;
    const size = sampleCaseSize(new SeededRng(seed));
    const generated = generateCase(seed, size, "mixed");
    // Cover both wrap modes deterministically by seed parity, so the cell spans od and wa.
    const onDemandWrapping = index % 2 === 0;
    const outputFormat = buildConfigOf(generated.program).outputFormat;

    const minRun = await executeProgram(withMinify(generated.program, true), {
      rolldownPackage: SNAPSHOT,
      onDemandWrapping,
    });
    if (minRun.verdict.kind === "pass") {
      minifiedGreen += 1;
      continue;
    }
    minifiedRed += 1;
    const signatureClass = minRun.verdict.signature.split(":").slice(0, 2).join(":");
    signatureHistogram[signatureClass] = (signatureHistogram[signatureClass] ?? 0) + 1;

    // A minify:true red — is it introduced BY minify (twin green) or pre-existing (twin also red)?
    const plainRun = await executeProgram(withMinify(generated.program, false), {
      rolldownPackage: SNAPSHOT,
      onDemandWrapping,
    });
    if (plainRun.verdict.kind === "pass") {
      introduced.push({
        seed,
        outputFormat,
        onDemandWrapping,
        minifiedSignature: minRun.verdict.signature.slice(0, 120),
      });
    } else {
      preexistingRed += 1;
    }
  }

  const accepted = introduced.length === 0;
  process.stdout.write(
    `minified: ${minifiedGreen} green, ${minifiedRed} red (${preexistingRed} also red un-minified, ${introduced.length} MINIFY-INTRODUCED)\n`,
  );
  process.stdout.write(`minified red signature classes: ${JSON.stringify(signatureHistogram)}\n`);
  for (const item of introduced) {
    process.stdout.write(
      `  !! MINIFY-INTRODUCED red seed ${item.seed} [${item.outputFormat}/${item.onDemandWrapping ? "od" : "wa"}]: ${item.minifiedSignature}\n`,
    );
  }

  const evidence = {
    proof: "W12 minify-sanity — ordinary shapes minify:true vs the fixed final snapshot",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    cases: CASES,
    snapshot: { path: SNAPSHOT, sha256: sha256OfFile(SNAPSHOT) },
    minifiedGreen,
    minifiedRed,
    preexistingRed,
    introducedCount: introduced.length,
    introduced,
    signatureHistogram,
    accepted,
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`\nwrote evidence to ${EVIDENCE_OUT}\n`);

  if (accepted) {
    process.stdout.write(
      `\nOK: minify introduced NO new red on the fixed snapshot — the error normalizer has no false-positive gap\n`,
    );
    return 0;
  }
  process.stderr.write(
    `\nFAIL: ${introduced.length} minify-INTRODUCED red(s) on the fixed snapshot — a normalizer gap or a minify-only catch to triage\n`,
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
