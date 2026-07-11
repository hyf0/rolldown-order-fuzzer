/// <reference types="node" />

/// FW-A deliverable 5 — the cjs-OUTPUT campaign (gap-audit Wave 11 / mining P7/T4).
///
/// The output-format axis (FW-A) is the largest structurally-invisible fix surface: under the historical
/// ESM-output pin the ENTIRE `render_chunk_exports` CommonJS arm — live getters, `__toCommonJS`, the
/// self-rebinding-wrapper defense, the wrapped-init emission for a CJS entry chunk — was unreachable. This
/// campaign runs the wave-8 object-identity double-init witness (and a function-hidden-read variant) with
/// `outputFormat: "cjs"`, matched against the SAME shape at `outputFormat: "esm"`, across the two targets,
/// under BOTH wrap modes — so a red is classified od/wa × esm/cjs and attributed to the CJS arm.
///
///   - npm rolldown@1.1.5 — the latest RELEASE.
///   - the final PR-10104 snapshot — the fixed strict-order arc.
///
/// FINDING (empirically stable): the `object-identity` witness is GREEN at esm output on both targets, and
/// GREEN at cjs output on the snapshot, but RED at cjs output on npm 1.1.5 —
/// `bundle-only-crash:["ReferenceError","init_module_NNNN is not defined"]`: a wrapped ENTRY's `init_*`
/// call is emitted into the CJS entry chunk without its definition. This is a CJS-OUTPUT-ARM bug OPEN on
/// the latest release and fixed only on the unreleased PR-10104 branch (the same red-on-1.1.5 /
/// green-on-snapshot bracket shape as RED-0). It is invisible under the ESM-output pin — exactly the class
/// FW-A exists to reach. Reported as a bracket + escalated as a LIVE CATCH on the latest release.
///
/// NOT part of `vp test` (it spawns rolldown builds against out-of-tree targets). Run:
///
///   NPM_115=<dist> SNAPSHOT_ROLLDOWN=<dist> vp exec node scripts/cjs-output-catch.ts [cases]
///
/// Writes machine-readable evidence (`EVIDENCE_OUT`, default `.agents/evidence/cjs-output.json`).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCjsOutputWitness, type CjsOutputWitnessVariant } from "../src/generate.ts";
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
  process.env.EVIDENCE_OUT ?? resolve(REPO_ROOT, ".agents/evidence/cjs-output.json");

const VARIANTS: readonly CjsOutputWitnessVariant[] = ["object-identity", "function-hidden"];
const OUTPUT_FORMATS = ["esm", "cjs"] as const;

/// Re-target a witness program at a specific output format (the generator bakes in `cjs`; the esm control
/// clones the same shape with `outputFormat: "esm"` so a red is attributable to the format, not the shape).
function withOutputFormat(program: ProgramModel, outputFormat: "esm" | "cjs"): ProgramModel {
  return { ...program, build: { ...buildConfigOf(program), outputFormat } };
}

interface Cell {
  readonly red: number;
  readonly green: number;
  readonly signatureHistogram: Record<string, number>;
}

async function runCell(
  variant: CjsOutputWitnessVariant,
  outputFormat: "esm" | "cjs",
  rolldownPackage: string,
  onDemandWrapping: boolean,
): Promise<Cell> {
  let red = 0;
  let green = 0;
  const signatureHistogram: Record<string, number> = {};
  for (let seed = 0; seed < CASES; seed += 1) {
    const { program } = buildCjsOutputWitness(new SeededRng(seed), variant);
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
  process.stderr.write(`FW-A cjs-output campaign — ${CASES} seeds/cell\n`);

  // cells[variant][`${format}/${wrap}`][target]
  const cells: Record<string, Record<string, Record<string, Cell>>> = {};
  const liveCatches: string[] = [];
  const brackets: string[] = [];
  for (const variant of VARIANTS) {
    cells[variant] = {};
    for (const outputFormat of OUTPUT_FORMATS) {
      for (const onDemandWrapping of [true, false]) {
        const wrap = onDemandWrapping ? "od" : "wa";
        const cellKey = `${outputFormat}/${wrap}`;
        cells[variant][cellKey] = {
          "npm-1.1.5": await runCell(variant, outputFormat, NPM_115, onDemandWrapping),
          snapshot: await runCell(variant, outputFormat, SNAPSHOT, onDemandWrapping),
        };
      }
    }
  }

  // The FW-A cjs-output-arm bracket: object-identity RED at cjs output on 1.1.5, GREEN on the snapshot,
  // and GREEN at esm output on BOTH — the red is attributable to the CJS output arm and to a version
  // boundary (open on the release, fixed on the arc). Checked under od (the default); wa is reported too.
  const oi = cells["object-identity"]!;
  const cjsOd = oi["cjs/od"]!;
  const esmOd = oi["esm/od"]!;
  const armBracketHolds =
    cjsOd["npm-1.1.5"]!.red === CASES &&
    cjsOd.snapshot!.green === CASES &&
    esmOd["npm-1.1.5"]!.green === CASES &&
    esmOd.snapshot!.green === CASES;
  if (armBracketHolds) {
    brackets.push(
      `object-identity cjs-output arm: RED ${CASES}/${CASES} on npm-1.1.5 (${JSON.stringify(
        cjsOd["npm-1.1.5"]!.signatureHistogram,
      )}), GREEN on snapshot; esm-output GREEN on both — a CJS-arm bug OPEN on the latest release`,
    );
  }

  // A red on the SNAPSHOT (the fixed arc) for ANY cell is a live catch on the fixed build — escalated.
  for (const variant of VARIANTS) {
    for (const [cellKey, targets] of Object.entries(cells[variant]!)) {
      if (targets.snapshot!.red > 0) {
        liveCatches.push(
          `${variant} ${cellKey} on snapshot: ${targets.snapshot!.red}/${CASES} RED — ${JSON.stringify(
            targets.snapshot!.signatureHistogram,
          )}`,
        );
      }
    }
  }

  for (const variant of VARIANTS) {
    for (const [cellKey, targets] of Object.entries(cells[variant]!)) {
      for (const [target, cell] of Object.entries(targets)) {
        process.stdout.write(
          `${variant.padEnd(16)} ${cellKey.padEnd(8)} ${target.padEnd(10)} red=${cell.red}/${CASES} green=${cell.green}\n`,
        );
      }
    }
  }
  process.stdout.write(
    `\nCJS-output-arm bracket (object-identity, od): ${armBracketHolds ? "HOLDS" : "not observed"}\n`,
  );
  for (const line of brackets) {
    process.stdout.write(`  ** BRACKET: ${line}\n`);
  }
  if (liveCatches.length > 0) {
    process.stdout.write(`\n*** LIVE CATCHES on the snapshot (the fixed arc) ***\n`);
    for (const line of liveCatches) {
      process.stdout.write(`  !! ${line}\n`);
    }
  }

  const evidence = {
    proof: "FW-A cjs-output campaign (gap-audit Wave 11 / mining P7/T4)",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    cases: CASES,
    armBracketHolds,
    brackets,
    liveCatches,
    targets: {
      "npm-1.1.5": { path: NPM_115, sha256: sha256OfFile(NPM_115) },
      snapshot: { path: SNAPSHOT, sha256: sha256OfFile(SNAPSHOT) },
    },
    cells,
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`\nwrote evidence to ${EVIDENCE_OUT}\n`);

  if (armBracketHolds) {
    process.stdout.write(
      `\nOK: the object-identity double-init witness reaches the CJS output arm — RED on npm 1.1.5, GREEN on the snapshot, esm-output GREEN on both\n`,
    );
    return 0;
  }
  process.stderr.write(`\nFAIL: the cjs-output-arm bracket did not reproduce as expected\n`);
  return 1;
}

process.exit(await main());
