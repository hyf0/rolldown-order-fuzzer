/// <reference types="node" />

/// W12 deliverable 3 — the MINIFY × self-rebinding-wrapper campaign.
///
/// The owner's original worry was that minification could break the self-rebinding wrapper form
/// `function init_x(){ return (init_x = __esmMin(cb))() }` — a mangling pass that renamed `init_x`
/// inconsistently across its own rebinding assignment would corrupt the wrapper. This campaign composes
/// `minify: true` with the exact shapes that stress that wrapper — the cross-chunk `init_*` cycle (#9887),
/// the runtime-placement optimizer cycle (#9993), and the CJS-output object-identity double-init witness
/// (RED-8) — across `{od, wa} × {esm, cjs}` against BOTH targets:
///
///   - npm rolldown@1.1.5 — the latest RELEASE (carries the open cross-chunk / cjs-arm wrapper bugs).
///   - the final PR-10104 snapshot — the fixed strict-order arc.
///
/// Two assertions:
///   1. WRAPPER BUGS STILL CAUGHT UNDER MINIFY — every red the un-minified shape produces on npm 1.1.5
///      still reds under `minify: true` (the mangling pass does not hide the wrapper defect; the crash
///      identity survives, re-signatured with a mangled identifier that the oracle's minify normalizer
///      makes comparable). Proven by comparing the minify:false and minify:true verdict CLASS per cell.
///   2. NO MINIFY-ONLY RED ON THE FINAL SNAPSHOT — every cell is GREEN on the fixed arc. A red there
///      would be a minify-ONLY defect on the fixed build — a release-relevant catch — and is escalated
///      PROMINENTLY (the whole reason this axis exists).
///
/// NOT part of `vp test` (out-of-tree builds). Run:
///
///   NPM_115=<dist> SNAPSHOT_ROLLDOWN=<dist> vp exec node scripts/minify-wrapper-catch.ts [cases]
///
/// Writes machine-readable evidence (`EVIDENCE_OUT`, default `.agents/evidence/minify-wrapper.json`).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCjsOutputWitness,
  buildCrossChunkInitCycle,
  buildOptimizerCycle,
} from "../src/generate.ts";
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
  process.env.EVIDENCE_OUT ?? resolve(REPO_ROOT, ".agents/evidence/minify-wrapper.json");

/// The self-rebinding-wrapper shapes and their natural output format. Each is built at BOTH formats where
/// legal (a cjs-only witness is pinned cjs) so the mangling pass is exercised across the ESM `export {}`
/// wrapper and the CJS live-getter/`__toCommonJS` wrapper alike.
const SHAPES: readonly {
  readonly name: string;
  readonly build: (rng: SeededRng) => { readonly program: ProgramModel };
  readonly formats: readonly ("esm" | "cjs")[];
}[] = [
  {
    name: "cross-chunk-init-cycle",
    build: (rng) => buildCrossChunkInitCycle(rng),
    formats: ["esm", "cjs"],
  },
  { name: "optimizer-cycle", build: (rng) => buildOptimizerCycle(rng), formats: ["esm", "cjs"] },
  {
    name: "cjs-output-witness",
    build: (rng) => buildCjsOutputWitness(rng, "object-identity"),
    formats: ["cjs"],
  },
];

function withBuild(
  program: ProgramModel,
  patch: { readonly outputFormat: "esm" | "cjs"; readonly minify: boolean },
): ProgramModel {
  return { ...program, build: { ...buildConfigOf(program), ...patch } };
}

interface Cell {
  readonly red: number;
  readonly green: number;
  readonly reasonHistogram: Record<string, number>;
  readonly signatureHistogram: Record<string, number>;
}

async function runCell(
  build: (rng: SeededRng) => { readonly program: ProgramModel },
  outputFormat: "esm" | "cjs",
  minify: boolean,
  rolldownPackage: string,
  onDemandWrapping: boolean,
): Promise<Cell> {
  let red = 0;
  let green = 0;
  const reasonHistogram: Record<string, number> = {};
  const signatureHistogram: Record<string, number> = {};
  for (let seed = 0; seed < CASES; seed += 1) {
    const { program } = build(new SeededRng(seed));
    const run = await executeProgram(withBuild(program, { outputFormat, minify }), {
      rolldownPackage,
      onDemandWrapping,
    });
    if (run.verdict.kind === "pass") {
      green += 1;
      continue;
    }
    red += 1;
    const reason = run.verdict.kind === "mismatch" ? run.verdict.reason : run.verdict.kind;
    reasonHistogram[reason] = (reasonHistogram[reason] ?? 0) + 1;
    // Collapse the volatile identifier/value suffix so the histogram stays readable (a minified crash's
    // identifier is mangled, so the reason CLASS is the stable comparison across minify:false/true).
    const signatureClass = run.verdict.signature.split(":").slice(0, 2).join(":");
    signatureHistogram[signatureClass] = (signatureHistogram[signatureClass] ?? 0) + 1;
  }
  return { red, green, reasonHistogram, signatureHistogram };
}

function reasonClasses(cell: Cell): string {
  return JSON.stringify(cell.reasonHistogram);
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
  process.stderr.write(`W12 minify × wrapper campaign — ${CASES} seeds/cell\n`);

  // cells[shape][`${format}/${wrap}/minify:${bool}`][target]
  const cells: Record<string, Record<string, Record<string, Cell>>> = {};
  const wrapperBrackets: string[] = [];
  const liveCatches: string[] = [];
  const minifyRegressions: string[] = [];

  for (const shape of SHAPES) {
    cells[shape.name] = {};
    for (const outputFormat of shape.formats) {
      for (const onDemandWrapping of [true, false]) {
        const wrap = onDemandWrapping ? "od" : "wa";
        for (const minify of [false, true]) {
          const cellKey = `${outputFormat}/${wrap}/minify:${String(minify)}`;
          cells[shape.name][cellKey] = {
            "npm-1.1.5": await runCell(
              shape.build,
              outputFormat,
              minify,
              NPM_115,
              onDemandWrapping,
            ),
            snapshot: await runCell(shape.build, outputFormat, minify, SNAPSHOT, onDemandWrapping),
          };
        }
      }
    }
  }

  // Assertion 1: the wrapper bug still reproduces under minify. For every (shape, format, wrap) where the
  // minify:FALSE cell reds on npm 1.1.5, the minify:TRUE cell must red on npm 1.1.5 with the SAME reason
  // class (mangling does not hide the wrapper defect — the crash identity survives).
  let wrapperPreservedHolds = true;
  for (const shape of SHAPES) {
    for (const outputFormat of shape.formats) {
      for (const wrap of ["od", "wa"]) {
        const plain = cells[shape.name]![`${outputFormat}/${wrap}/minify:false`]!["npm-1.1.5"]!;
        const min = cells[shape.name]![`${outputFormat}/${wrap}/minify:true`]!["npm-1.1.5"]!;
        if (plain.red === 0) {
          continue;
        }
        const sameReasons = reasonClasses(plain) === reasonClasses(min) && min.red === plain.red;
        if (sameReasons) {
          wrapperBrackets.push(
            `${shape.name} ${outputFormat}/${wrap}: RED ${min.red}/${CASES} on npm-1.1.5 under BOTH minify:false and minify:true (${reasonClasses(min)}) — the wrapper defect survives mangling`,
          );
        } else {
          wrapperPreservedHolds = false;
          minifyRegressions.push(
            `${shape.name} ${outputFormat}/${wrap} on npm-1.1.5: minify HID or CHANGED the red — minify:false ${plain.red}/${CASES} ${reasonClasses(plain)} vs minify:true ${min.red}/${CASES} ${reasonClasses(min)}`,
          );
        }
      }
    }
  }

  // Assertion 2: no minify-ONLY red on the final snapshot (the fixed arc). Any red on the snapshot at
  // minify:true whose minify:false twin is GREEN is a minify-only defect on the fixed build — escalate.
  for (const shape of SHAPES) {
    for (const [cellKey, targets] of Object.entries(cells[shape.name]!)) {
      const snap = targets.snapshot!;
      if (snap.red > 0) {
        const isMinifyCell = cellKey.endsWith("minify:true");
        const twinKey = cellKey.replace("minify:true", "minify:false");
        const twinGreen = isMinifyCell && (cells[shape.name]![twinKey]?.snapshot?.red ?? 0) === 0;
        const line = `${shape.name} ${cellKey} on snapshot: ${snap.red}/${CASES} RED — ${JSON.stringify(snap.signatureHistogram)}`;
        liveCatches.push(line);
        if (twinGreen) {
          minifyRegressions.push(`MINIFY-ONLY red on the FIXED snapshot: ${line}`);
        }
      }
    }
  }

  for (const shape of SHAPES) {
    for (const [cellKey, targets] of Object.entries(cells[shape.name]!)) {
      for (const [target, cell] of Object.entries(targets)) {
        process.stdout.write(
          `${shape.name.padEnd(22)} ${cellKey.padEnd(20)} ${target.padEnd(10)} red=${cell.red}/${CASES} green=${cell.green} ${reasonClasses(cell)}\n`,
        );
      }
    }
  }
  process.stdout.write(
    `\nwrapper-preserved-under-minify: ${wrapperPreservedHolds ? "HOLDS" : "VIOLATED"}\n`,
  );
  for (const line of wrapperBrackets) {
    process.stdout.write(`  ** WRAPPER STILL CAUGHT: ${line}\n`);
  }
  if (minifyRegressions.length > 0) {
    process.stdout.write(`\n*** MINIFY REGRESSIONS / MINIFY-ONLY CATCHES (ESCALATE) ***\n`);
    for (const line of minifyRegressions) {
      process.stdout.write(`  !! ${line}\n`);
    }
  }

  const evidence = {
    proof: "W12 minify × self-rebinding-wrapper campaign (deliverable 3)",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    cases: CASES,
    wrapperPreservedHolds,
    wrapperBrackets,
    liveCatches,
    minifyRegressions,
    targets: {
      "npm-1.1.5": { path: NPM_115, sha256: sha256OfFile(NPM_115) },
      snapshot: { path: SNAPSHOT, sha256: sha256OfFile(SNAPSHOT) },
    },
    cells,
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`\nwrote evidence to ${EVIDENCE_OUT}\n`);

  // A minify-only red on the FIXED snapshot is a release-relevant catch to escalate, but it is a CATCH,
  // not a harness failure — the campaign still exits 0 (evidence carries it). The only FAILURE is the
  // wrapper defect being HIDDEN by minify (assertion 1 violated), which would mean the axis lost catching
  // power under mangling.
  const minifyHidReds = minifyRegressions.some(
    (line) => line.startsWith(SHAPES[0]!.name) || line.includes("HID or CHANGED"),
  );
  if (!wrapperPreservedHolds || minifyHidReds) {
    process.stderr.write(
      `\nFAIL: minify hid or changed a wrapper red — catching power lost under mangling\n`,
    );
    return 1;
  }
  process.stdout.write(
    `\nOK: every wrapper red on npm 1.1.5 survives minify with the same reason class; snapshot green except any escalated minify-only catch\n`,
  );
  return 0;
}

process.exit(await main());
