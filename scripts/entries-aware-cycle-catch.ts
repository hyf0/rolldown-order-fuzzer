/// <reference types="node" />

/// Live acceptance for the entries-aware manual-code-splitting cycle reported in rolldown#10259.
///
/// The deterministic generated source is a three-entry DAG. A selective `entriesAware` group merges
/// the three entry-private app modules while leaving one app's private leaf in its entry chunk, so the
/// emitted common chunk and personal entry chunk statically import each other. The harness requires:
///
/// - the emitted chunk graph has that cycle in every cell;
/// - a released/broken Rolldown throws `init_* is not a function`; and
/// - the declaration-form strict wrapper implementation passes with both on-demand wrapping and the
///   strict wrap-all control.
///
/// Run on demand (not part of `vp test`):
///
///   BUGGY_ROLLDOWN=rolldown FIXED_ROLLDOWN=<dist/index.mjs> \
///     vp exec node scripts/entries-aware-cycle-catch.ts

import { pathToFileURL } from "node:url";

import { generateEntriesAwareChunkCycleCase } from "../src/generate.ts";
import { executeProgram } from "../src/program-run.ts";
import { inspectChunkGraph } from "./chunk-graph.ts";

const BUGGY = packageSpecifier(process.env.BUGGY_ROLLDOWN ?? "rolldown");
const FIXED = packageSpecifier(requiredEnvironmentVariable("FIXED_ROLLDOWN"));
const INIT_FAMILY = /init_\w+ is not a function/;

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must point at the Rolldown build under test`);
  }
  return value;
}

function packageSpecifier(value: string): string {
  return value.startsWith("/") ? pathToFileURL(value).href : value;
}

interface Cell {
  readonly target: "buggy" | "fixed";
  readonly onDemandWrapping: boolean;
  readonly cycle: boolean;
  readonly cycleMembers: readonly string[];
  readonly verdict: string;
  readonly signature: string;
  readonly accepted: boolean;
}

async function runCell(
  target: "buggy" | "fixed",
  rolldownPackage: string,
  onDemandWrapping: boolean,
): Promise<Cell> {
  const generated = generateEntriesAwareChunkCycleCase(0);
  const graph = await inspectChunkGraph(generated.analyzed, rolldownPackage, onDemandWrapping);
  const run = await executeProgram(
    generated.program,
    { rolldownPackage, onDemandWrapping },
    {},
    generated.analyzed,
  );
  const signature = run.verdict.kind === "pass" ? "pass" : run.verdict.signature;
  const hasExpectedVerdict =
    target === "fixed"
      ? run.verdict.kind === "pass"
      : run.verdict.kind === "mismatch" &&
        run.verdict.reason === "bundle-only-crash" &&
        INIT_FAMILY.test(run.verdict.signature);
  return {
    target,
    onDemandWrapping,
    cycle: graph.hasQuotientCycle,
    cycleMembers: graph.cycleMembers,
    verdict: run.verdict.kind,
    signature,
    accepted: graph.hasQuotientCycle && hasExpectedVerdict,
  };
}

async function main(): Promise<number> {
  const cells: Cell[] = [];
  for (const [target, packagePath] of [
    ["buggy", BUGGY],
    ["fixed", FIXED],
  ] as const) {
    for (const onDemandWrapping of [true, false]) {
      cells.push(await runCell(target, packagePath, onDemandWrapping));
    }
  }

  for (const cell of cells) {
    const mode = cell.onDemandWrapping ? "on-demand" : "wrap-all";
    process.stdout.write(
      `${cell.target.padEnd(5)} ${mode.padEnd(9)} cycle=${String(cell.cycle).padEnd(5)} ` +
        `verdict=${cell.verdict} signature=${cell.signature}\n`,
    );
    process.stdout.write(`      cycle members: ${cell.cycleMembers.join(" <-> ")}\n`);
  }

  if (cells.every((cell) => cell.accepted)) {
    process.stdout.write(
      "OK: the same emitted chunk cycle is RED on the released wrapper form and GREEN on the declaration-form implementation in both strict modes\n",
    );
    return 0;
  }
  process.stderr.write("FAIL: the entries-aware cycle red/green acceptance matrix did not hold\n");
  return 1;
}

process.exit(await main());
