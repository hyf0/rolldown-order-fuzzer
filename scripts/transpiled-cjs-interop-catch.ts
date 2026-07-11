/// <reference types="node" />

/// FW-A deliverable 3 — the transpiled-CJS interop campaign (cluster 3, the DCE-vs-order epicenter
/// #8675/#8975; gap-audit Wave 9 / mining P3).
///
/// A `__esModule`-marked CJS definer (`Object.defineProperty(exports,"__esModule",{value:true});
/// exports.default = …; exports.<named> = …`) consumed cross-chunk by ESM entries via a NAMED import (a
/// clean numeric fold) AND a DEFAULT import (`import { default as x }`). Run across BOTH output formats
/// and BOTH wrap modes, against the two targets.
///
/// LEGALITY GATE (established by handwritten probes, `.agents/docs/fw-a-output-format-axis.md`): rolldown
/// emits `__toESM(require_x(), 1)` (isNodeMode) for a real `.mjs` importer, which IGNORES `__esModule` for
/// the default binding and mirrors Node's own CJS interop EXACTLY. Every consumption × marker combination
/// (default / named / namespace × marker-present / -absent) was probed IDENTICAL between Node and the
/// final snapshot, so the LEGAL SUBSET IS ALL OF THEM — there is nothing to validator-exclude, and the
/// shape is a directly-comparable cell. This campaign asserts it stays GREEN (the interop path is exercised
/// and matches Node); an od-only, cjs-only, or version-boundary red would be a fresh interop catch.
///
/// NOT part of `vp test`. Run:
///   NPM_115=<dist> SNAPSHOT_ROLLDOWN=<dist> vp exec node scripts/transpiled-cjs-interop-catch.ts [cases]
/// Writes evidence to `.agents/evidence/transpiled-cjs-interop.json`.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildTranspiledCjsInterop } from "../src/generate.ts";
import { executeProgram } from "../src/program-run.ts";
import { buildConfigOf, type ProgramModel } from "../src/model.ts";
import { SeededRng } from "../src/rng.ts";

const NPM_115 =
  process.env.NPM_115 ??
  "/tmp/order-fuzzer-regression-targets/1.1.5/node_modules/rolldown/dist/index.mjs";
const SNAPSHOT =
  process.env.SNAPSHOT_ROLLDOWN ??
  "/tmp/rolldown-strict-order-study/final-snapshot-42628c18b/rolldown/dist/index.mjs";
const CASES = Number(process.argv[2] ?? process.env.CASES ?? "20");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_OUT =
  process.env.EVIDENCE_OUT ?? resolve(REPO_ROOT, ".agents/evidence/transpiled-cjs-interop.json");

const OUTPUT_FORMATS = ["esm", "cjs"] as const;

function withOutputFormat(program: ProgramModel, outputFormat: "esm" | "cjs"): ProgramModel {
  return { ...program, build: { ...buildConfigOf(program), outputFormat } };
}

interface Cell {
  readonly red: number;
  readonly green: number;
  readonly signatureHistogram: Record<string, number>;
}

async function runCell(
  outputFormat: "esm" | "cjs",
  rolldownPackage: string,
  onDemandWrapping: boolean,
): Promise<Cell> {
  let red = 0;
  let green = 0;
  const signatureHistogram: Record<string, number> = {};
  for (let seed = 0; seed < CASES; seed += 1) {
    const { program } = buildTranspiledCjsInterop(new SeededRng(seed));
    const run = await executeProgram(withOutputFormat(program, outputFormat), {
      rolldownPackage,
      onDemandWrapping,
    });
    const signature = run.verdict.kind === "pass" ? "pass" : run.verdict.signature;
    signatureHistogram[signature] = (signatureHistogram[signature] ?? 0) + 1;
    if (run.verdict.kind === "pass") {
      green += 1;
    } else {
      red += 1;
    }
  }
  return { red, green, signatureHistogram };
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
  process.stderr.write(`FW-A transpiled-CJS interop campaign — ${CASES} seeds/cell\n`);

  const cells: Record<string, Record<string, Cell>> = {};
  const catches: string[] = [];
  for (const outputFormat of OUTPUT_FORMATS) {
    for (const onDemandWrapping of [true, false]) {
      const cellKey = `${outputFormat}/${onDemandWrapping ? "od" : "wa"}`;
      cells[cellKey] = {
        "npm-1.1.5": await runCell(outputFormat, NPM_115, onDemandWrapping),
        snapshot: await runCell(outputFormat, SNAPSHOT, onDemandWrapping),
      };
    }
  }

  let allGreen = true;
  for (const [cellKey, targets] of Object.entries(cells)) {
    for (const [target, cell] of Object.entries(targets)) {
      process.stdout.write(
        `interop ${cellKey.padEnd(8)} ${target.padEnd(10)} red=${cell.red}/${CASES} green=${cell.green}\n`,
      );
      if (cell.red > 0) {
        allGreen = false;
        catches.push(
          `interop ${cellKey} on ${target}: ${cell.red}/${CASES} RED — ${JSON.stringify(
            cell.signatureHistogram,
          )} (a FRESH interop catch — the legal subset was probed green)`,
        );
      }
    }
  }

  if (catches.length > 0) {
    process.stdout.write(`\n*** FRESH INTEROP CATCHES ***\n`);
    for (const line of catches) {
      process.stdout.write(`  !! ${line}\n`);
    }
  } else {
    process.stdout.write(
      `\nlegality gate holds: the transpiled-CJS interop is GREEN across esm/cjs × od/wa × both targets — the legal subset is directly comparable and matches Node (isNodeMode __toESM)\n`,
    );
  }

  const evidence = {
    proof: "FW-A transpiled-CJS interop campaign (cluster 3 / gap-audit Wave 9)",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    cases: CASES,
    legalityGate:
      "every consumption x marker combination probed identical Node-vs-snapshot; legal subset = all; watched for a fresh interop red",
    allGreen,
    catches,
    targets: {
      "npm-1.1.5": { path: NPM_115, sha256: sha256OfFile(NPM_115) },
      snapshot: { path: SNAPSHOT, sha256: sha256OfFile(SNAPSHOT) },
    },
    cells,
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`\nwrote evidence to ${EVIDENCE_OUT}\n`);

  // GREEN coverage is the expected result (the legal subset matches Node); a fresh red is a catch to
  // escalate, not a campaign failure. Exit 0 on all-green, 1 only if the run itself could not complete.
  return 0;
}

process.exit(await main());
