/// <reference types="node" />

/// Corpus byte-identity regression harness (the durable golden-digest oracle).
///
/// Renders a fixed, reproducible case set to a normalized manifest of source-file hashes plus the
/// effective Rolldown build options, so a refactor that is meant to preserve corpus semantics can be
/// PROVEN byte-identical: `check` regenerates the set and diffs it against a committed golden manifest.
/// Coverage tags and artifact identity are deliberately EXCLUDED — they legitimately change when a
/// predicate is corrected — so the manifest pins only what a build consumes: the emitted
/// `.mjs`/`.cjs`/`package.json`/`schedule.json` bytes and the `codeSplitting` option the child derives
/// from the model.
///
/// Three sections, so the golden covers the whole generator surface (not only forced-regime
/// random-mixed):
///
/// 1. `regime:*` — 100 forced-regime cases each (mixed / pure-esm / pure-cjs), size-mix active. Forcing
///    a regime pins the random-mixed generator; this is the historical 300-case anchor.
/// 2. `template:*` — a fixed block per FIXED template (esm-imports-cjs, shared-cjs-carriers,
///    cjs-requires-esm, overlapping-entries, manual-chunk-separation) plus un-forced random-mixed,
///    collected by scanning un-forced seeds and bucketing by the generated template. The fixed
///    templates carry their own inherent formats, so a forced regime never reaches them — this section
///    is the only coverage of those shapes.
/// 3. `boundary:*` — empty-chunking-array boundary cases: a generated automatic-chunking base with an
///    explicit `manualChunkGroups: []` / `organicChunkGroups: []` added. The build runs automatic for
///    both, so the recorded `codeSplitting` must be `true` — the regression guard for the
///    empty-array-identity bug (an empty array once recorded as `{ groups: [] }` while the build ran
///    automatic). Derived through the SAME `programChunking` matcher the build and artifact identity use,
///    so this reader can never drift from them again.
///
/// Usage:
///   node scripts/corpus-manifest.ts write <path>   # write the manifest to <path>
///   node scripts/corpus-manifest.ts check <path>   # regenerate and diff against <path>
///   node scripts/corpus-manifest.ts                # print the manifest to stdout

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import {
  FIXED_TEMPLATE_NAMES,
  FORMAT_REGIMES,
  generateCase,
  sampleCaseSize,
  type FormatRegime,
  type MixedTemplateName,
} from "../src/generate.ts";
import { analyzeProgram } from "../src/analyzed-program.ts";
import { programChunking, type ProgramModel } from "../src/model.ts";
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

/// The un-forced template scan base and per-template quota. Scanning un-forced seeds from this base and
/// bucketing by generated template deterministically covers every fixed template and un-forced
/// random-mixed. The scan cap bounds the work when a shape is rare.
const TEMPLATE_SCAN_BASE = 5_000_000;
const CASES_PER_TEMPLATE = 25;
const TEMPLATE_SCAN_LIMIT = 20_000;

/// Base seeds whose generated program is stripped to automatic chunking, then given an explicit empty
/// chunk array — the empty-array boundary the manifest must pin to `true` (automatic).
const BOUNDARY_SEED_BASE = 7_000_000;
const BOUNDARY_CASES = 4;

interface CaseManifest {
  readonly group: string;
  readonly seed: number;
  readonly size: number;
  readonly template: MixedTemplateName;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly codeSplitting: unknown;
  readonly error?: string;
}

/// The effective `codeSplitting` descriptor a program builds with — the one per-case build option that
/// varies. Reads the model through the SINGLE `programChunking` matcher (organic wins over manual; an
/// EMPTY manual/organic array is automatic), matching `main.ts`'s `effectiveCodeSplitting` and the build
/// child, so the manifest captures exactly the build option a change must preserve and the empty-array
/// identity bug cannot be independently recreated here.
function effectiveCodeSplitting(program: ProgramModel): unknown {
  const chunking = programChunking(program);
  switch (chunking.kind) {
    case "organic":
      return { organicGroups: chunking.groups };
    case "manual":
      return { groups: chunking.groups };
    default:
      return true;
  }
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function renderCase(
  group: string,
  seed: number,
  size: number,
  template: MixedTemplateName,
  program: ProgramModel,
): CaseManifest {
  try {
    const rendered = renderProgram(analyzeProgram(program));
    const files = [...rendered.files]
      .map((file) => ({ path: file.path, sha256: sha256(file.contents) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { group, seed, size, template, files, codeSplitting: effectiveCodeSplitting(program) };
  } catch (error) {
    return {
      group,
      seed,
      size,
      template,
      files: [],
      codeSplitting: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function forcedRegimeCase(seed: number, regime: FormatRegime): CaseManifest {
  const size = sampleCaseSize(new SeededRng(seed));
  const generated = generateCase(seed, size, regime);
  return renderCase(`regime:${regime}`, seed, size, generated.template, generated.program);
}

/// Scan un-forced seeds, bucketing by generated template, until every fixed template and un-forced
/// random-mixed has `CASES_PER_TEMPLATE` cases (or the scan cap is hit).
function templateCases(): readonly CaseManifest[] {
  const wanted: readonly MixedTemplateName[] = [...FIXED_TEMPLATE_NAMES, "random-mixed"];
  const buckets = new Map<MixedTemplateName, CaseManifest[]>(wanted.map((name) => [name, []]));
  for (let offset = 0; offset < TEMPLATE_SCAN_LIMIT; offset += 1) {
    if ([...buckets.values()].every((bucket) => bucket.length >= CASES_PER_TEMPLATE)) {
      break;
    }
    const seed = TEMPLATE_SCAN_BASE + offset;
    const size = sampleCaseSize(new SeededRng(seed));
    const generated = generateCase(seed, size);
    const bucket = buckets.get(generated.template);
    if (bucket === undefined || bucket.length >= CASES_PER_TEMPLATE) {
      continue;
    }
    bucket.push(
      renderCase(
        `template:${generated.template}`,
        seed,
        size,
        generated.template,
        generated.program,
      ),
    );
  }
  return wanted.flatMap((name) => buckets.get(name) ?? []);
}

/// Strip every chunking config from a program, yielding an automatic-chunking base.
function withAutomaticChunking(program: ProgramModel): ProgramModel {
  const base = { ...program };
  delete (base as { manualChunkGroups?: unknown }).manualChunkGroups;
  delete (base as { organicChunkGroups?: unknown }).organicChunkGroups;
  return base;
}

/// Empty-array boundary cases: an automatic base plus an explicit empty `manualChunkGroups` /
/// `organicChunkGroups`. Both build automatic, so `effectiveCodeSplitting` must record `true` — the
/// durable guard that no reader records `{ groups: [] }` for an empty array again.
function boundaryCases(): readonly CaseManifest[] {
  const cases: CaseManifest[] = [];
  for (let index = 0; index < BOUNDARY_CASES; index += 1) {
    const seed = BOUNDARY_SEED_BASE + index;
    const size = sampleCaseSize(new SeededRng(seed));
    const base = withAutomaticChunking(generateCase(seed, size, "mixed").program);
    cases.push(
      renderCase("boundary:empty-manual", seed, size, "random-mixed", {
        ...base,
        manualChunkGroups: [],
      }),
      renderCase("boundary:empty-organic", seed, size, "random-mixed", {
        ...base,
        organicChunkGroups: [],
      }),
    );
  }
  return cases;
}

function buildManifest(): readonly CaseManifest[] {
  const cases: CaseManifest[] = [];
  for (const regime of FORMAT_REGIMES) {
    const base = REGIME_SEED_BASE[regime];
    for (let index = 0; index < CASES_PER_REGIME; index += 1) {
      cases.push(forcedRegimeCase(base + index, regime));
    }
  }
  cases.push(...templateCases());
  cases.push(...boundaryCases());
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
      process.stderr.write(`  ${entry.group} seed ${entry.seed}: ${entry.error ?? ""}\n`);
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
    // Compare CANONICALIZED content, not raw text, so the golden's on-disk formatting (the repo
    // formatter may re-indent it) never affects the byte-identity verdict — only the manifest DATA does.
    const baselineCases = JSON.parse(readFileSync(path, "utf8")) as CaseManifest[];
    if (canonicalJson(baselineCases) === rendered) {
      process.stderr.write(`OK: ${manifest.length} cases byte-identical to ${path}\n`);
      return 0;
    }
    const currentByKey = new Map(manifest.map((entry) => [`${entry.group}:${entry.seed}`, entry]));
    let mismatches = 0;
    for (const before of baselineCases) {
      const after = currentByKey.get(`${before.group}:${before.seed}`);
      if (after === undefined) {
        mismatches += 1;
        if (mismatches <= 20) {
          process.stderr.write(`MISSING: ${before.group} seed ${before.seed}\n`);
        }
        continue;
      }
      if (canonicalJson(before) !== canonicalJson(after)) {
        mismatches += 1;
        if (mismatches <= 20) {
          process.stderr.write(`MISMATCH: ${before.group} seed ${before.seed}\n`);
          diffCase(before, after);
        }
      }
    }
    const baselineKeys = new Set(baselineCases.map((entry) => `${entry.group}:${entry.seed}`));
    for (const after of manifest) {
      if (!baselineKeys.has(`${after.group}:${after.seed}`)) {
        mismatches += 1;
        if (mismatches <= 20) {
          process.stderr.write(`ADDED: ${after.group} seed ${after.seed}\n`);
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
