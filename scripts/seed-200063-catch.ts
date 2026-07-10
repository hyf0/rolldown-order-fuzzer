/// <reference types="node" />

/// W14b seed-200063 triage harness — the `events-reordered` finding the catching-power sweep hit.
///
/// Seed 200063 (mixed) is a family-A conjunction (`mechanism:pure-definer-behind-barrel`) PACKAGED
/// behind `fa-pdef10` (partial `sideEffects: ["./psib10.mjs"]`). The catching-power reacceptance
/// recorded it as od-GREEN / wa-RED with an `events-reordered` signature — a wa-only ORDER deviation,
/// not the NaN-fold crash family A usually reds with. The reviewer flagged the prose "snapshot-specific
/// expression of the already-known family-A init-ordering arc" as UNVERIFIED: no retained model,
/// verdicts, event arrays, or ablation backed it.
///
/// This reproduces it with RETAINED artifacts and probes the root cause:
///   - both wrap modes (od / wa) against the FROZEN PR-10104 snapshot (contains the arc mid-state) AND
///     the FINAL snapshot (the shipped fixes) — capturing per-mode verdicts, the source vs bundle
///     module-init ORDER, and the emitted bundle file list;
///   - an ABLATION set that removes, one at a time, the family-A packaging ingredients (the partial
///     `sideEffects` array → `true`; the whole package dropped) and re-runs wa against the buggy
///     snapshot, so the evidence shows whether the wa reorder is TIED to the packaged-family-A
///     composition or survives its removal.
///
/// Not part of `vp test` (spawns a rolldown build per cell against an out-of-tree snapshot). Run:
///   vp exec node scripts/seed-200063-catch.ts
/// Writes `.agents/evidence/seed-200063-reorder.json`.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateCase, sampleCaseSize } from "../src/generate.ts";
import { analyzeProgram } from "../src/analyzed-program.ts";
import type { ProgramModel } from "../src/model.ts";
import { executeProgram } from "../src/program-run.ts";
import { isScheduleMarker, type ExecutionEvent, type ExecutionOutcome } from "../src/protocol.ts";
import { SeededRng } from "../src/rng.ts";

const SEED = 200_063;
const BUGGY_SNAPSHOT =
  process.env.BUGGY_ROLLDOWN ??
  "/tmp/rolldown-strict-order-study/pr10104-runtime-snapshot/rolldown/dist/index.mjs";
const FINAL_SNAPSHOT =
  process.env.FINAL_ROLLDOWN ??
  "/tmp/rolldown-strict-order-study/final-snapshot-42628c18b/rolldown/dist/index.mjs";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_OUT = resolve(REPO_ROOT, ".agents/evidence/seed-200063-reorder.json");

/// The ordered module-init sequence an outcome observed — non-marker events mapped to their module id,
/// in order. The reorder shows as a differing sequence between source and bundle.
function moduleInitOrder(outcome: ExecutionOutcome): string[] {
  return outcome.events
    .filter((event: ExecutionEvent): boolean => !isScheduleMarker(event))
    .map((event: ExecutionEvent) => (event as { module: string }).module);
}

interface CellResult {
  readonly verdictKind: string;
  readonly signature: string;
  readonly sourceOrder: string[];
  readonly bundleOrder: string[];
  readonly bundleFiles: string[];
}

async function runCell(
  program: ProgramModel,
  snapshot: string,
  onDemandWrapping: boolean,
): Promise<CellResult> {
  const analyzed = analyzeProgram(program);
  const run = await executeProgram(
    program,
    { rolldownPackage: snapshot, onDemandWrapping },
    {},
    analyzed,
  );
  const bundleOutcome = run.bundleOutcome.status === "not-run" ? undefined : run.bundleOutcome;
  return {
    verdictKind: run.verdict.kind,
    signature: run.verdict.kind === "pass" ? "pass" : run.verdict.signature,
    sourceOrder: moduleInitOrder(run.sourceOutcome),
    bundleOrder: bundleOutcome === undefined ? [] : moduleInitOrder(bundleOutcome),
    bundleFiles: run.bundleFiles.map((file) => file.path),
  };
}

/// The family-A packaging ablations — each removes ONE ingredient of the packaged conjunction so the
/// wa reorder can be tied to (or cleared of) the packaging.
function ablations(
  program: ProgramModel,
): { readonly name: string; readonly program: ProgramModel }[] {
  const out: { name: string; program: ProgramModel }[] = [];
  if (program.packages !== undefined) {
    out.push({
      name: "sideEffects->true (withdraw the partial-array metadata)",
      program: {
        ...program,
        packages: program.packages.map((pkg) => ({ ...pkg, sideEffects: true as const })),
      },
    });
    const withoutPackage: ProgramModel = { ...program };
    delete (withoutPackage as { packages?: unknown }).packages;
    out.push({ name: "drop the fa- package (members return to root)", program: withoutPackage });
  }
  return out;
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
  const size = sampleCaseSize(new SeededRng(SEED));
  const generated = generateCase(SEED, size, "mixed");
  process.stderr.write(`seed ${SEED}: ${generated.program.modules.length} modules\n`);
  process.stderr.write(`  BUGGY: ${BUGGY_SNAPSHOT}\n  FINAL: ${FINAL_SNAPSHOT}\n`);

  const buggy = {
    od: await runCell(generated.program, BUGGY_SNAPSHOT, true),
    wa: await runCell(generated.program, BUGGY_SNAPSHOT, false),
  };
  const final = {
    od: await runCell(generated.program, FINAL_SNAPSHOT, true),
    wa: await runCell(generated.program, FINAL_SNAPSHOT, false),
  };

  const ablationResults = [];
  for (const ablation of ablations(generated.program)) {
    ablationResults.push({
      name: ablation.name,
      buggyWa: await runCell(ablation.program, BUGGY_SNAPSHOT, false),
    });
  }

  const reorderTiedToPackaging =
    buggy.wa.verdictKind !== "pass" &&
    ablationResults.length > 0 &&
    ablationResults.every((result) => result.buggyWa.signature !== buggy.wa.signature);

  const evidence = {
    proof:
      "seed 200063 events-reordered triage — retained artifacts, both snapshots, packaging ablation",
    seed: SEED,
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    coverageTags: generated.coverageTags,
    model: generated.program,
    snapshots: {
      buggy: { path: BUGGY_SNAPSHOT, sha256: sha256OfFile(BUGGY_SNAPSHOT) },
      final: { path: FINAL_SNAPSHOT, sha256: sha256OfFile(FINAL_SNAPSHOT) },
    },
    cells: { buggy, final },
    ablations: ablationResults,
    reorderTiedToPackaging,
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);

  process.stdout.write(
    `\nbuggy:  od=${buggy.od.verdictKind}/${buggy.od.signature.slice(0, 40)}  wa=${buggy.wa.verdictKind}/${buggy.wa.signature.slice(0, 40)}\n`,
  );
  process.stdout.write(
    `final:  od=${final.od.verdictKind}/${final.od.signature.slice(0, 40)}  wa=${final.wa.verdictKind}/${final.wa.signature.slice(0, 40)}\n`,
  );
  process.stdout.write(`buggy wa source order: ${buggy.wa.sourceOrder.join(" ")}\n`);
  process.stdout.write(`buggy wa bundle order: ${buggy.wa.bundleOrder.join(" ")}\n`);
  for (const result of ablationResults) {
    process.stdout.write(
      `ablation [${result.name}] buggy wa: ${result.buggyWa.verdictKind}/${result.buggyWa.signature.slice(0, 50)}\n`,
    );
  }
  process.stdout.write(
    `\nreorder tied to packaging (ablations clear the signature): ${reorderTiedToPackaging}\n`,
  );
  process.stderr.write(`wrote evidence to ${EVIDENCE_OUT}\n`);
  return 0;
}

process.exit(await main());
