/// <reference types="node" />

/// Catching-power baseline (finding 9).
///
/// The tag-density scan measures STRUCTURAL coverage — how often the family-A conjunction is generated —
/// which is NOT catching power (a conjunction that never diverges catches nothing). This harness measures
/// the real thing: a FIXED seed set built against the FROZEN buggy Rolldown snapshot, counting how often
/// the differential oracle actually goes RED, and asserting the family-A red-rate stays in a committed
/// band. It is deterministic (fixed seeds, one pinned snapshot) but NOT part of `vp test` — it needs the
/// snapshot binary and spawns a Rolldown build per case. Run on demand:
///
///   npm run catching-power                 # assert the band, print the table
///   CATCHING_POWER_SNAPSHOT=<path> npm run catching-power
///
/// The snapshot (rolldown 1.1.5, pr10104-runtime-snapshot) carries the family-A bug: a star-re-exported
/// inferred-pure definer whose init the bundler drops, so a consumer folds `undefined` and the event
/// channel rejects the NaN. See `.agents/docs/real-app-bug-families.md` and the w7/w8 findings.

import { generateCase, sampleCaseSize } from "../src/generate.ts";
import { executeProgram } from "../src/program-run.ts";
import { SeededRng } from "../src/rng.ts";

const SNAPSHOT =
  process.env.CATCHING_POWER_SNAPSHOT ??
  "/tmp/rolldown-strict-order-study/pr10104-runtime-snapshot/rolldown/dist/index.mjs";

/// The family-A-rich seed range the w7/w8 campaigns used (case-0004-seed-200004 was the hand-verified
/// family-A representative), so the fixed set stays where the conjunction actually diverges.
const SEED_BASE = 200_000;
/// Fixed at 300 for the committed baseline; overridable ONLY for a quick smoke run (does not affect the
/// committed band, which is measured at 300).
const CASES_PER_CELL = Number(process.env.CATCHING_POWER_CASES ?? "300");
const FAMILY_A_TAG = "mechanism:pure-definer-behind-barrel";

/// The committed catching-power band: the mixed-regime RED RATE (percent of runs the differential oracle
/// catches against the buggy snapshot). Family A dominates, with the wave-8 witnesses and (since W14b)
/// the od-only family-B eager-barrel conjunction supplying the rest. A move outside this band is a real
/// regression (a witness weakened) or an improvement to re-accept, unlike tag density which counts
/// structure a passing conjunction would inflate.
/// Measured 2026-07-10 (W14a.1): mixed-od 69/300 = 23.0%, mixed-wa 73/300 = 24.3%, combined 23.7%
/// (family-A-red 118, 89.4% of family-A-tagged).
/// Re-measured 2026-07-11 (W14b): mixed-od 73/300 = 24.3%, mixed-wa 63/300 = 21.0%, combined 22.7% —
/// IN BAND with the composition shifted, as the wave intends: family-B adds od-ONLY reds (the od/wa
/// asymmetry is its fingerprint), while the deliberate family-A packaging/camunda variants trade some
/// family-A redness for coverage (family-A-red 100, 75.8% of family-A-tagged; tag density unchanged).
const BAND = { low: 21, high: 27 } as const;

interface CellResult {
  readonly name: string;
  readonly cases: number;
  readonly red: number;
  readonly familyARed: number;
  readonly familyATagged: number;
}

async function runCell(name: string, onDemandWrapping: boolean): Promise<CellResult> {
  let red = 0;
  let familyARed = 0;
  let familyATagged = 0;
  for (let index = 0; index < CASES_PER_CELL; index += 1) {
    const seed = SEED_BASE + index;
    const size = sampleCaseSize(new SeededRng(seed));
    const generated = generateCase(seed, size, "mixed");
    const isFamilyA = generated.coverageTags.includes(FAMILY_A_TAG);
    if (isFamilyA) {
      familyATagged += 1;
    }
    const run = await executeProgram(
      generated.program,
      { rolldownPackage: SNAPSHOT, onDemandWrapping },
      {},
      generated.analyzed,
    );
    if (run.verdict.kind !== "pass") {
      red += 1;
      if (isFamilyA) {
        familyARed += 1;
      }
    }
  }
  return { name, cases: CASES_PER_CELL, red, familyARed, familyATagged };
}

function percent(hits: number, total: number): string {
  return total === 0 ? "n/a" : `${((hits / total) * 100).toFixed(1)}%`;
}

async function main(): Promise<number> {
  process.stderr.write(`Catching-power baseline against ${SNAPSHOT}\n`);
  const cells = [await runCell("mixed-od", true), await runCell("mixed-wa", false)];
  const totalRuns = cells.reduce((sum, cell) => sum + cell.cases, 0);
  const totalRed = cells.reduce((sum, cell) => sum + cell.red, 0);
  const totalFamilyARed = cells.reduce((sum, cell) => sum + cell.familyARed, 0);
  const totalFamilyATagged = cells.reduce((sum, cell) => sum + cell.familyATagged, 0);

  process.stdout.write("cell        cases   red   red-rate  familyA-red  familyA-tagged\n");
  for (const cell of cells) {
    process.stdout.write(
      `${cell.name.padEnd(10)} ${String(cell.cases).padStart(5)} ${String(cell.red).padStart(5)}  ${percent(cell.red, cell.cases).padStart(7)}  ${String(cell.familyARed).padStart(11)}  ${String(cell.familyATagged).padStart(13)}\n`,
    );
  }
  const redRate = (totalRed / totalRuns) * 100;
  process.stdout.write(
    `\ntotal runs=${totalRuns} red=${totalRed} (${percent(totalRed, totalRuns)})\n`,
  );
  process.stdout.write(
    `family-A: ${totalFamilyARed} of the ${totalRed} reds (${percent(totalFamilyARed, totalRed)}); ${percent(totalFamilyARed, totalFamilyATagged)} of ${totalFamilyATagged} family-A-tagged runs go red\n`,
  );
  process.stdout.write(
    `\nred-rate (family-A-dominated catching power) = ${redRate.toFixed(1)}%  (committed band ${BAND.low}-${BAND.high}%)\n`,
  );

  if (redRate < BAND.low || redRate > BAND.high) {
    process.stderr.write(
      `FAIL: red-rate ${redRate.toFixed(1)}% is outside the committed band ${BAND.low}-${BAND.high}%\n`,
    );
    return 1;
  }
  process.stdout.write("OK: within band\n");
  return 0;
}

process.exit(await main());
