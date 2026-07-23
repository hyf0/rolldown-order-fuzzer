/// <reference types="node" />

/// Small current-target audit for independently rooted REDs that the historical reacceptance reason
/// histogram cannot distinguish. It deliberately reuses one existing Family-A seed and the minimal
/// directed builders for the CJS cross-entry and entry-facade arms. A known RED or a future PASS is
/// accepted; a different RED fails, so a broad `bundle-only-crash` bucket cannot hide a new mechanism.
/// The manual-pure child-effect cases remain owned by `release-order-regressions.ts` and are not copied.
///
///   CURRENT_ROLLDOWN=/absolute/path/to/rolldown/dist/index.mjs \
///     vp exec node scripts/current-target-open-reds.ts

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeProgram, type AnalyzedProgram } from "../src/analyzed-program.ts";
import {
  buildCjsOutputEntryFacadeCycle,
  buildStaticCrossEntryLeak,
  deriveCoverageTags,
  generateCase,
  sampleCaseSize,
} from "../src/generate.ts";
import { buildConfigOf, type ProgramModel } from "../src/model.ts";
import { executeProgram, type CampaignVerdict } from "../src/program-run.ts";
import { SeededRng } from "../src/rng.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = requiredEnvironmentVariable("CURRENT_ROLLDOWN");
const EVIDENCE_OUT =
  process.env.EVIDENCE_OUT ?? resolve(REPO_ROOT, ".agents/evidence/current-target-open-reds.json");
const FAMILY_A_SEED = 200_004;

interface AuditCase {
  readonly id: string;
  readonly root: string;
  readonly program: ProgramModel;
  readonly analyzed: AnalyzedProgram;
  readonly mustPass?: boolean;
  readonly acceptsKnownRed: (verdict: CampaignVerdict) => boolean;
}

interface AuditRow {
  readonly id: string;
  readonly root: string;
  readonly status: "known-red" | "pass" | "unexpected";
  readonly verdict: string;
  readonly reason: string;
  readonly signature: string;
  readonly coverageTags: readonly string[];
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must point at the exact Rolldown build under audit`);
  }
  return value;
}

function gitOutput(args: readonly string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function familyACases(): readonly AuditCase[] {
  const size = sampleCaseSize(new SeededRng(FAMILY_A_SEED));
  const generated = generateCase(FAMILY_A_SEED, size, "pure-esm");
  if (!generated.coverageTags.includes("mechanism:pure-definer-behind-barrel")) {
    throw new Error(`seed ${String(FAMILY_A_SEED)} no longer carries the Family-A conjunction`);
  }
  const flagOffProgram: ProgramModel = {
    ...generated.program,
    build: { ...buildConfigOf(generated.program), strictExecutionOrder: false },
  };
  return [
    {
      id: "family-a-existing-seed",
      root: "strict SEO: pure definer behind export-star barrel is not initialized",
      program: generated.program,
      analyzed: generated.analyzed,
      acceptsKnownRed: (verdict) =>
        verdict.kind === "mismatch" &&
        verdict.reason === "bundle-only-crash" &&
        verdict.signature ===
          'bundle-only-crash:["Error","Execution event value must be a primitive JSON value"]',
    },
    {
      id: "family-a-seo-false-control",
      root: "Family-A strict-order flag-off control",
      program: flagOffProgram,
      analyzed: analyzeProgram(flagOffProgram),
      mustPass: true,
      acceptsKnownRed: () => false,
    },
  ];
}

function directedCases(): readonly AuditCase[] {
  const cjsCrossEntry = buildStaticCrossEntryLeak(new SeededRng(0), "cjs-strict");
  const cjsFacade = buildCjsOutputEntryFacadeCycle("cjs-target");
  const esmFacade = buildCjsOutputEntryFacadeCycle("esm-target");
  return [
    {
      id: "cross-entry-cjs-output-strict",
      root: "#9998 cross-entry execution leak, CJS-output strict arm",
      ...cjsCrossEntry,
      acceptsKnownRed: (verdict) =>
        verdict.kind === "mismatch" &&
        verdict.reason === "events-reordered" &&
        verdict.signature ===
          'events-reordered:source=[["@schedule",0,"entry"],["le3-effect","evaluate",352913]]:bundle=[["le3-effect","evaluate",352913],["@schedule",0,"entry"]]',
    },
    {
      id: "cjs-output-facade-cycle-require",
      root: "CJS-output entry-facade cycle, require_module lowering",
      ...cjsFacade,
      acceptsKnownRed: (verdict) =>
        verdict.kind === "mismatch" &&
        verdict.reason === "bundle-only-crash" &&
        verdict.signature ===
          'bundle-only-crash:["TypeError","require___entry_0000.require_module_0001 is not a function"]',
    },
    {
      id: "cjs-output-facade-cycle-init",
      root: "CJS-output entry-facade cycle, init_module lowering",
      ...esmFacade,
      acceptsKnownRed: (verdict) =>
        verdict.kind === "mismatch" &&
        verdict.reason === "bundle-only-crash" &&
        verdict.signature ===
          'bundle-only-crash:["TypeError","require___entry_0000.init_module_0001 is not a function"]',
    },
  ];
}

async function main(): Promise<number> {
  const rows: AuditRow[] = [];
  let targetIdentity:
    | {
        readonly requestedPackageSpecifier: string;
        readonly resolvedEntryPath: string | null;
        readonly packageVersion: string | null;
        readonly resolvedEntrySha256: string | null;
      }
    | undefined;

  for (const auditCase of [...familyACases(), ...directedCases()]) {
    const run = await executeProgram(
      auditCase.program,
      { rolldownPackage: TARGET, onDemandWrapping: true },
      {},
      auditCase.analyzed,
    );
    targetIdentity ??= {
      requestedPackageSpecifier: run.runtimeIdentity.requestedPackageSpecifier,
      resolvedEntryPath: run.runtimeIdentity.resolvedEntryPath,
      packageVersion: run.runtimeIdentity.packageVersion,
      resolvedEntrySha256: run.runtimeIdentity.resolvedEntrySha256,
    };
    const verdict = run.verdict;
    const reason = verdict.kind === "mismatch" ? verdict.reason : verdict.kind;
    const signature = verdict.kind === "pass" ? "pass" : verdict.signature;
    const knownRed = auditCase.acceptsKnownRed(verdict);
    const status =
      verdict.kind === "pass"
        ? "pass"
        : knownRed && auditCase.mustPass !== true
          ? "known-red"
          : "unexpected";
    rows.push({
      id: auditCase.id,
      root: auditCase.root,
      status,
      verdict: verdict.kind,
      reason,
      signature,
      coverageTags: deriveCoverageTags(auditCase.analyzed),
    });
    process.stdout.write(
      `${status.padEnd(10)} ${auditCase.id.padEnd(38)} ${verdict.kind}/${reason}\n`,
    );
  }

  const unexpected = rows.filter((row) => row.status === "unexpected");
  const evidence = {
    proof: "current-target independent open-RED inventory",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    target: targetIdentity ?? { requestedPackageSpecifier: TARGET },
    familyASeed: FAMILY_A_SEED,
    accepted: unexpected.length === 0,
    knownRedRowCount: rows.filter((row) => row.status === "known-red").length,
    passCount: rows.filter((row) => row.status === "pass").length,
    unexpectedCount: unexpected.length,
    rows,
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`wrote evidence to ${EVIDENCE_OUT}\n`);

  if (unexpected.length === 0) {
    process.stdout.write(
      `OK: ${String(evidence.knownRedRowCount)} known RED row(s) remain; no directed case changed to an unknown failure\n`,
    );
    return 0;
  }
  for (const row of unexpected) {
    process.stderr.write(`UNEXPECTED ${row.id}: ${row.signature}\n`);
  }
  return 1;
}

process.exit(await main());
