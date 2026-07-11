/// <reference types="node" />

/// FW-B deliverable 3 — the wrapping-completeness frontier campaign (cluster 5, the #10180 churn).
///
/// Rolldown is actively re-architecting the order-sensitivity classifier: #10168 split the metadata and
/// #10180 rebuilt `TopLevelImportReadDetector`, whose own rationale is that "the order-sensitivity signal
/// must be complete: it may never miss a top-level read of an imported binding" and that the
/// per-expression-form analyzer "is exactly how gaps slip in". This campaign runs the exotic
/// statically-visible-but-tricky read forms that detector must classify — a NESTED read through
/// `export * as ns`, a COMPUTED INTERMEDIATE hop (`a[imp].y`), and an ALIASED namespace (`const x = ns;
/// x.foo`) — from `buildExoticImportReads` (`generate.ts`), each folding a non-inlinable inferred-pure
/// value (a detector miss that dropped the init would fold undefined -> NaN).
///
/// Run in BOTH wrap modes on the SAME seeds vs npm rolldown@1.1.5 AND the final PR-10104 snapshot (the
/// PR's OWN rebuilt classifier):
///   - on-demand (od): the classifier is LIVE — the module is wrapped iff the detector marks it
///     order-sensitive. This is the cell the #10180 detector governs.
///   - wrap-all (wa): every module is wrapped unconditionally — the internal control.
/// Every cell is expected GREEN today (the rebuilt classifier handles these forms), so this is COVERAGE
/// that the generator reaches the churning detector paths; an OD-ONLY RED (green in wa, on either target)
/// is a wrapping-COMPLETENESS catch — reported prominently (the family-B fingerprint discipline: the
/// same-seed wa cell is the control).
///
/// NOT part of `vp test`. Run:
///   NPM_ROLLDOWN=<dist> SNAPSHOT_ROLLDOWN=<dist> vp exec node scripts/exotic-reads-catch.ts [cases]
/// Writes evidence to `.agents/evidence/exotic-reads.json`.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateExoticImportReadsCase } from "../src/generate.ts";
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
  process.env.EVIDENCE_OUT ?? resolve(REPO_ROOT, ".agents/evidence/exotic-reads.json");
const EXOTIC_TAGS = [
  "variation:reexport-namespace",
  "variation:computed-intermediate-read",
  "variation:aliased-namespace-read",
];

interface Cell {
  green: number;
  red: number;
  signatureHistogram: Record<string, number>;
  perSeed: { seed: number; kind: string; signature: string }[];
}

async function runCell(rolldownPackage: string, onDemandWrapping: boolean): Promise<Cell> {
  let green = 0;
  let red = 0;
  const signatureHistogram: Record<string, number> = {};
  const perSeed: Cell["perSeed"] = [];
  for (let seed = 0; seed < CASES; seed += 1) {
    const generated = generateExoticImportReadsCase(seed);
    const run = await executeProgram(
      generated.program,
      { rolldownPackage, onDemandWrapping },
      {},
      generated.analyzed,
    );
    const signature = run.verdict.kind === "pass" ? "pass" : run.verdict.signature;
    signatureHistogram[signature] = (signatureHistogram[signature] ?? 0) + 1;
    perSeed.push({ seed, kind: run.verdict.kind, signature });
    if (run.verdict.kind === "pass") {
      green += 1;
    } else {
      red += 1;
    }
  }
  return { green, red, signatureHistogram, perSeed };
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
  // Assert the directed shape carries every exotic tag (the generator reaches all three forms).
  const tags = generateExoticImportReadsCase(0).coverageTags;
  const missingTags = EXOTIC_TAGS.filter((tag) => !tags.includes(tag));
  process.stderr.write(`wrapping-completeness frontier campaign — ${CASES} seeds, od+wa\n`);

  const cells = {
    "npm-od": await runCell(NPM, true),
    "npm-wa": await runCell(NPM, false),
    "snapshot-od": await runCell(SNAPSHOT, true),
    "snapshot-wa": await runCell(SNAPSHOT, false),
  };
  for (const [name, cell] of Object.entries(cells)) {
    process.stdout.write(`${name.padEnd(14)} green=${cell.green}/${CASES} red=${cell.red}\n`);
  }

  // A wrapping-COMPLETENESS catch: od RED where the same-seed wa is GREEN, on either target.
  const completenessCatches: string[] = [];
  for (const target of ["npm", "snapshot"] as const) {
    const od = cells[`${target}-od`];
    const wa = cells[`${target}-wa`];
    if (od.red > 0 && wa.red === 0) {
      completenessCatches.push(
        `${target}: od-only RED (${od.red}/${CASES}) — ${JSON.stringify(od.signatureHistogram)}`,
      );
    }
  }
  if (completenessCatches.length > 0) {
    process.stdout.write(`\n*** WRAPPING-COMPLETENESS CATCHES (od-only red) ***\n`);
    for (const line of completenessCatches) {
      process.stdout.write(`  !! ${line}\n`);
    }
  }

  // Acceptance (coverage): every cell GREEN on both targets, all exotic tags present. A completeness
  // catch is a distinct (prominent) outcome, not a silent pass.
  const allGreen = Object.values(cells).every((cell) => cell.green === CASES);
  const accepted = allGreen && missingTags.length === 0;

  const evidence = {
    proof:
      "FW-B wrapping-completeness frontier (#10180): exotic top-level import-read forms (computed intermediate, aliased namespace, nested reexport-namespace)",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    cases: CASES,
    exoticTags: EXOTIC_TAGS,
    missingTags,
    completenessCatches,
    note: "GREEN in every cell = the rebuilt classifier handles these forms (coverage that the generator reaches the churn); an od-only red would be a completeness catch.",
    targets: {
      npm: { path: NPM, sha256: sha256OfFile(NPM) },
      snapshot: { path: SNAPSHOT, sha256: sha256OfFile(SNAPSHOT) },
    },
    accepted,
    cells,
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`\nwrote evidence to ${EVIDENCE_OUT}\n`);

  if (completenessCatches.length > 0) {
    process.stderr.write(`\nCOMPLETENESS CATCH — an exotic read form escaped od wrapping\n`);
    return 3;
  }
  if (accepted) {
    process.stdout.write(
      `\nOK: exotic read forms crossed — GREEN in od+wa on npm 1.1.5 AND the snapshot; all three forms tagged\n`,
    );
    return 0;
  }
  process.stderr.write(
    `\nFAIL: a cell was not green or an exotic tag was missing (${missingTags.join(", ")})\n`,
  );
  return 1;
}

process.exit(await main());
