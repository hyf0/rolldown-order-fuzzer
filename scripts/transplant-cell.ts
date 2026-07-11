/// <reference types="node" />

/// Transplant unit 5 — the CORPUS CELL RUNNER (`npm run transplant:cell`).
///
/// Executes the committed transplant models (`transplant/models/*.json`, listed in
/// `transplant/index.json`) against a target rolldown through the same `executeProgram` seam the
/// campaign uses, in BOTH wrap modes:
///
///   1. every BASELINE + OVERLAY model against the GREEN target (default: the final PR-10104 snapshot)
///      -> expect PASS (a transplanted real-graph skeleton is a legal program on a correct bundler);
///   2. every OVERLAY model against the BUGGY target (rolldown 1.1.5, contains family A) -> expect RED
///      with the family-A signature (the witness fires — the transplant carries an observable bug).
///
/// A model is validated at the current schema before it runs (a stale committed model fails loudly).
/// Writes machine-readable evidence to `.agents/evidence/transplant-cell.json` and exits non-zero on any
/// deviation. NOT part of `vp test` (it builds against out-of-tree snapshots). Run:
///
///   npm run transplant:cell                     # all apps, both targets
///   npm run transplant:cell shadcn-admin        # one app
///   TRANSPLANT_GREEN_TARGET=<dist/index.mjs> npm run transplant:cell   # override the green target

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { analyzeProgram } from "../src/analyzed-program.ts";
import { normalizeLegacyReads, type ProgramModel } from "../src/model.ts";
import { executeProgram } from "../src/program-run.ts";
import { validateProgramModel } from "../src/validate-model.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRANSPLANT_DIR = resolve(REPO_ROOT, "transplant");
const MANIFEST_PATH = process.env.TRANSPLANT_MANIFEST ?? resolve(TRANSPLANT_DIR, "index.json");
const EVIDENCE_OUT =
  process.env.EVIDENCE_OUT ?? resolve(REPO_ROOT, ".agents/evidence/transplant-cell.json");

interface AppEntry {
  readonly app: string;
  readonly source: string;
  readonly originalModules: number;
  readonly keptModules: number;
  readonly baseline: string;
  readonly overlay: string;
  readonly witness: string;
}

interface Manifest {
  readonly schema: number;
  readonly title: string;
  readonly greenTarget: { readonly id: string; readonly path: string };
  readonly buggyTarget: { readonly id: string; readonly path: string };
  readonly expectedRedSignature: string;
  readonly apps: readonly AppEntry[];
}

interface RunResult {
  readonly kind: string;
  readonly signature: string;
}

function loadModel(relativePath: string): ProgramModel {
  const path = resolve(TRANSPLANT_DIR, relativePath);
  const program = normalizeLegacyReads(JSON.parse(readFileSync(path, "utf8")) as ProgramModel);
  const errors = validateProgramModel(analyzeProgram(program));
  if (errors.length > 0) {
    throw new Error(
      `${relativePath} is INVALID at the current schema (${errors.length}): ${errors.slice(0, 6).join("; ")}`,
    );
  }
  return program;
}

async function runModel(
  program: ProgramModel,
  distPath: string,
  onDemandWrapping: boolean,
): Promise<RunResult> {
  const run = await executeProgram(program, { rolldownPackage: distPath, onDemandWrapping });
  return {
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

interface AppEvidence {
  readonly app: string;
  readonly originalModules: number;
  readonly keptModules: number;
  readonly baselineGreen: Record<string, RunResult>;
  readonly overlayGreen: Record<string, RunResult>;
  readonly overlayBuggy: Record<string, RunResult>;
  readonly witnessFires: boolean;
  readonly baselineHolds: boolean;
  readonly accepted: boolean;
}

async function main(): Promise<number> {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
  const greenPath = process.env.TRANSPLANT_GREEN_TARGET ?? manifest.greenTarget.path;
  const buggyPath = process.env.TRANSPLANT_BUGGY_TARGET ?? manifest.buggyTarget.path;
  const onlyApp = process.argv[2];
  const apps =
    onlyApp === undefined ? manifest.apps : manifest.apps.filter((a) => a.app === onlyApp);
  if (apps.length === 0) {
    process.stderr.write(
      onlyApp === undefined
        ? "FAIL: manifest has no apps\n"
        : `FAIL: no app ${JSON.stringify(onlyApp)}\n`,
    );
    return 2;
  }
  if (!existsSync(greenPath)) {
    process.stderr.write(`FAIL: green target missing: ${greenPath}\n`);
    return 2;
  }
  const buggyAvailable = existsSync(buggyPath);
  if (!buggyAvailable) {
    process.stderr.write(
      `WARN: buggy target missing (${buggyPath}); skipping the witness-fires check\n`,
    );
  }

  process.stderr.write(`transplant cell — ${apps.length} app(s)\n`);
  process.stderr.write(`  green target: ${greenPath}\n`);
  process.stderr.write(`  buggy target: ${buggyAvailable ? buggyPath : "(unavailable)"}\n`);

  const expectedRed = manifest.expectedRedSignature;
  const results: AppEvidence[] = [];
  for (const app of apps) {
    const baseline = loadModel(app.baseline);
    const overlay = loadModel(app.overlay);

    const baselineGreen: Record<string, RunResult> = {};
    const overlayGreen: Record<string, RunResult> = {};
    const overlayBuggy: Record<string, RunResult> = {};
    for (const od of [true, false]) {
      const mode = od ? "od" : "wa";
      baselineGreen[mode] = await runModel(baseline, greenPath, od);
      overlayGreen[mode] = await runModel(overlay, greenPath, od);
      if (buggyAvailable) overlayBuggy[mode] = await runModel(overlay, buggyPath, od);
    }

    const baselineHolds = Object.values(baselineGreen).every((r) => r.kind === "pass");
    const overlayGreenHolds = Object.values(overlayGreen).every((r) => r.kind === "pass");
    // The witness FIRES when the overlay reds the buggy target with the family-A signature in at least
    // one mode (family A reds both; organic-chunking interactions can leave one mode green).
    const witnessFires = buggyAvailable
      ? Object.values(overlayBuggy).some((r) => r.kind !== "pass" && r.signature === expectedRed)
      : true;
    const accepted = baselineHolds && overlayGreenHolds && witnessFires;

    results.push({
      app: app.app,
      originalModules: app.originalModules,
      keptModules: app.keptModules,
      baselineGreen,
      overlayGreen,
      overlayBuggy,
      witnessFires,
      baselineHolds: baselineHolds && overlayGreenHolds,
      accepted,
    });

    const fireStr = buggyAvailable
      ? ` witness=${witnessFires ? "FIRES" : "SILENT"} (buggy od=${overlayBuggy.od?.kind} wa=${overlayBuggy.wa?.kind})`
      : "";
    process.stdout.write(
      `${accepted ? "OK  " : "FAIL"} ${app.app}: baseline green od/wa=${baselineGreen.od?.kind}/${baselineGreen.wa?.kind}` +
        ` overlay green od/wa=${overlayGreen.od?.kind}/${overlayGreen.wa?.kind}${fireStr}\n`,
    );
  }

  const accepted = results.every((r) => r.accepted);
  const evidence = {
    proof: "real-graph skeleton transplant corpus cell — baselines green, family-A witnesses fire",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    greenTarget: { path: greenPath, sha256: sha256OfFile(greenPath) },
    buggyTarget: buggyAvailable ? { path: buggyPath, sha256: sha256OfFile(buggyPath) } : null,
    expectedRedSignature: expectedRed,
    accepted,
    apps: results,
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`\nwrote evidence to ${EVIDENCE_OUT}\n`);

  if (accepted) {
    process.stdout.write(`\nOK: all ${results.length} transplant app(s) accepted\n`);
    return 0;
  }
  process.stderr.write(`\nFAIL: ${results.filter((r) => !r.accepted).length} app(s) deviated\n`);
  return 1;
}

const invokedPath = process.argv[1];
const isEntrypoint =
  invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href;
if (isEntrypoint) {
  process.exit(await main());
}
