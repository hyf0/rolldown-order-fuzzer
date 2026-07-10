/// <reference types="node" />

/// Corpus byte-identity regression harness.
///
/// Renders a fixed 300-case set (100 per format regime, size-mix active) to a normalized manifest of
/// source-file hashes plus the effective Rolldown build options, so a refactor that is meant to
/// preserve corpus semantics can be PROVEN byte-identical: capture a baseline manifest before the
/// change, regenerate after, and diff. Coverage tags and artifact identity are deliberately EXCLUDED
/// — they legitimately change when a predicate is corrected — so the manifest pins only what a build
/// consumes: the emitted `.mjs`/`.cjs`/`package.json`/`schedule.json` bytes and the `codeSplitting`
/// option the child derives from the model.
///
/// Usage:
///   node scripts/corpus-manifest.ts write <path>   # write the manifest to <path>
///   node scripts/corpus-manifest.ts check <path>   # regenerate and diff against <path>
///   node scripts/corpus-manifest.ts                # print the manifest to stdout

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import {
  FORMAT_REGIMES,
  generateCase,
  sampleCaseSize,
  type FormatRegime,
} from "../src/generate.ts";
import type { ProgramModel } from "../src/model.ts";
import { renderProgram } from "../src/render.ts";
import { SeededRng } from "../src/rng.ts";

/// One fixed seed block per regime; kept distinct so the three regimes never collide and the set is
/// reproducible across revisions. 100 seeds each = 300 cases.
const REGIME_SEED_BASE: Readonly<Record<FormatRegime, number>> = {
  mixed: 1_000_000,
  "pure-esm": 2_000_000,
  "pure-cjs": 3_000_000,
};
const CASES_PER_REGIME = 100;

interface CaseManifest {
  readonly seed: number;
  readonly size: number;
  readonly regime: FormatRegime;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly codeSplitting: unknown;
  readonly error?: string;
}

/// The effective `codeSplitting` descriptor a program builds with — the one per-case build option
/// that varies. Mirrors `effectiveCodeSplitting`/`createOutputOptions` precedence: organic groups
/// win, then manual groups, then automatic (`true`). Read from the model so the manifest captures the
/// build option a change must preserve. (If a future consolidation migrates the persisted chunk
/// representation, update this reader; the manifest OUTPUT must stay byte-identical.)
function effectiveCodeSplitting(program: ProgramModel): unknown {
  if (program.organicChunkGroups !== undefined && program.organicChunkGroups.length > 0) {
    return { organicGroups: program.organicChunkGroups };
  }
  if (program.manualChunkGroups !== undefined) {
    return { groups: program.manualChunkGroups };
  }
  return true;
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function buildCaseManifest(seed: number, regime: FormatRegime): CaseManifest {
  const size = sampleCaseSize(new SeededRng(seed));
  try {
    const generated = generateCase(seed, size, regime);
    const rendered = renderProgram(generated.program);
    const files = [...rendered.files]
      .map((file) => ({ path: file.path, sha256: sha256(file.contents) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      seed,
      size,
      regime,
      files,
      codeSplitting: effectiveCodeSplitting(generated.program),
    };
  } catch (error) {
    return {
      seed,
      size,
      regime,
      files: [],
      codeSplitting: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildManifest(): readonly CaseManifest[] {
  const cases: CaseManifest[] = [];
  for (const regime of FORMAT_REGIMES) {
    const base = REGIME_SEED_BASE[regime];
    for (let index = 0; index < CASES_PER_REGIME; index += 1) {
      cases.push(buildCaseManifest(base + index, regime));
    }
  }
  return cases;
}

/// Deterministic (sorted-key) JSON so two manifests diff cleanly regardless of object key order.
function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalize(record[key])]),
  );
}

function main(argv: readonly string[]): number {
  const [command, path] = argv;
  const manifest = buildManifest();
  const rendered = canonicalJson(manifest);

  const errors = manifest.filter((entry) => entry.error !== undefined);
  if (errors.length > 0) {
    process.stderr.write(`WARNING: ${errors.length} case(s) failed to render:\n`);
    for (const entry of errors) {
      process.stderr.write(`  seed ${entry.seed} (${entry.regime}): ${entry.error ?? ""}\n`);
    }
  }

  if (command === "write") {
    if (path === undefined) {
      process.stderr.write("usage: corpus-manifest.ts write <path>\n");
      return 2;
    }
    writeFileSync(path, rendered);
    process.stderr.write(`wrote ${manifest.length} cases to ${path}\n`);
    return errors.length > 0 ? 1 : 0;
  }

  if (command === "check") {
    if (path === undefined) {
      process.stderr.write("usage: corpus-manifest.ts check <path>\n");
      return 2;
    }
    const baseline = readFileSync(path, "utf8");
    if (baseline === rendered) {
      process.stderr.write(`OK: ${manifest.length} cases byte-identical to ${path}\n`);
      return 0;
    }
    // Point at the exact cases that drifted.
    const baselineCases = JSON.parse(baseline) as CaseManifest[];
    const currentByKey = new Map(manifest.map((entry) => [`${entry.regime}:${entry.seed}`, entry]));
    let mismatches = 0;
    for (const before of baselineCases) {
      const after = currentByKey.get(`${before.regime}:${before.seed}`);
      if (after === undefined) {
        continue;
      }
      if (canonicalJson(before) !== canonicalJson(after)) {
        mismatches += 1;
        if (mismatches <= 20) {
          process.stderr.write(`MISMATCH: seed ${before.seed} (${before.regime})\n`);
          diffCase(before, after);
        }
      }
    }
    process.stderr.write(`FAIL: ${mismatches} case(s) drifted from ${path}\n`);
    return 1;
  }

  process.stdout.write(rendered);
  return errors.length > 0 ? 1 : 0;
}

function diffCase(before: CaseManifest, after: CaseManifest): void {
  if (canonicalJson(before.codeSplitting) !== canonicalJson(after.codeSplitting)) {
    process.stderr.write("    codeSplitting differs\n");
  }
  const beforeFiles = new Map(before.files.map((file) => [file.path, file.sha256]));
  const afterFiles = new Map(after.files.map((file) => [file.path, file.sha256]));
  for (const [filePath, hash] of beforeFiles) {
    const other = afterFiles.get(filePath);
    if (other === undefined) {
      process.stderr.write(`    removed file ${filePath}\n`);
    } else if (other !== hash) {
      process.stderr.write(`    changed file ${filePath}\n`);
    }
  }
  for (const filePath of afterFiles.keys()) {
    if (!beforeFiles.has(filePath)) {
      process.stderr.write(`    added file ${filePath}\n`);
    }
  }
}

process.exit(main(process.argv.slice(2)));
