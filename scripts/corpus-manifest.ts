/// <reference types="node" />

/// Corpus byte-identity regression harness (the durable golden-digest oracle).
///
/// Renders a fixed, reproducible case set to a normalized manifest of source-file hashes plus the
/// effective Rolldown build options, so a refactor that is meant to preserve corpus semantics can be
/// PROVEN byte-identical: `check` regenerates the set and diffs it against a committed golden manifest.
/// Coverage tags and artifact identity are deliberately EXCLUDED — they legitimately change when a
/// predicate is corrected — so the manifest pins only what a build consumes: the emitted
/// `.mjs`/`.cjs`/`package.json`/`schedule.json` bytes, the `codeSplitting` option the child derives from
/// the model, and (since W14a — `golden: W14a structural axes`) the persisted BuildConfig scalar axes
/// (`buildAxes`: includeDependenciesRecursively / lazyBarrel / preserveEntrySignatures /
/// strictExecutionOrder), so a change to how a case builds is caught here too.
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
///   node scripts/corpus-manifest.ts write <path>          # write the manifest to <path>
///   node scripts/corpus-manifest.ts check <path>          # regenerate and diff against <path>
///   node scripts/corpus-manifest.ts explain-delta <path>  # diff against an OLD golden and PROVE the
///                                                         # delta CAUSALLY: each changed case's delta
///                                                         # must be accounted for by the allowed W14b
///                                                         # transformations only (package
///                                                         # path/specifier/package.json additions, a
///                                                         # new-operation file, an appended package
///                                                         # chunk group) — a render error, a buildAxes
///                                                         # drift, a non-package codeSplitting move, or
///                                                         # an unexplained root-file change fails it
///                                                         # (exit 1)
///   node scripts/corpus-manifest.ts                       # print the manifest to stdout

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
import {
  buildConfigOf,
  packageMembershipOf,
  packageMemberFileName,
  packagesOf,
  programChunking,
  type ModuleModel,
  type ProgramModel,
} from "../src/model.ts";
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
  /// The persisted BuildConfig scalar axes a case builds with (W14a). Chunking is `codeSplitting`;
  /// these are the rest — the rolled `includeDependenciesRecursively` / `lazyBarrel` plus the fixed
  /// `preserveEntrySignatures` / `strictExecutionOrder` — so the golden now guards the structural axes
  /// (they are effective build options, so a change to how a case builds is caught here).
  readonly buildAxes?: {
    readonly includeDependenciesRecursively: boolean;
    readonly lazyBarrel: boolean;
    readonly preserveEntrySignatures: unknown;
    readonly strictExecutionOrder: boolean;
  };
  /// The resolved packages (W14b) — present ONLY when the case carries any, so a package-free case's
  /// manifest entry is byte-identical to the pre-package golden AND the golden delta is
  /// self-explaining: every changed case either lists its packages here or gained a new operation.
  readonly packages?: readonly {
    readonly name: string;
    readonly sideEffects: boolean | readonly string[];
    readonly moduleIds: readonly string[];
  }[];
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

/// The generated program behind each manifest entry, kept aside so `explain-delta` can inspect the
/// MODEL (new operations) and not just the rendered bytes.
const programsByKey = new Map<string, ProgramModel>();

function caseKey(group: string, seed: number): string {
  return `${group}:${seed}`;
}

/// Whether a program carries a W14b-new operation surface: a source-less local re-export (the
/// camunda M4 op) or declared local exports beside a star (the vben index shape).
function carriesNewOperation(program: ProgramModel): boolean {
  return program.modules.some(
    (module) =>
      module.dependencies.some((dependency) => dependency.kind === "esm-local-reexport") ||
      (module.format === "esm" && (module.localExports?.length ?? 0) > 0),
  );
}

interface CodeSplittingGroup {
  readonly name?: string;
  readonly moduleIds?: readonly string[];
  readonly test?: string;
}

/// The chunk groups of an `effectiveCodeSplitting` descriptor (`{groups}` manual / `{organicGroups}`
/// organic / `true` automatic) as a flat list — empty for automatic.
function codeSplittingGroups(codeSplitting: unknown): readonly CodeSplittingGroup[] {
  if (typeof codeSplitting !== "object" || codeSplitting === null) {
    return [];
  }
  const record = codeSplitting as { groups?: unknown; organicGroups?: unknown };
  const groups = record.groups ?? record.organicGroups;
  return Array.isArray(groups) ? (groups as CodeSplittingGroup[]) : [];
}

/// A chunk group introduced by the package enrichment (the family-B `{facade, sibling}` cluster): a
/// MANUAL group whose members are all package members, or an ORGANIC group whose regex targets a
/// `node_modules/` package path. Any other group is a rolled base group, not a package artifact.
function isPackageChunkGroup(group: CodeSplittingGroup, memberIds: ReadonlySet<string>): boolean {
  if (group.moduleIds !== undefined) {
    return group.moduleIds.length > 0 && group.moduleIds.every((id) => memberIds.has(id));
  }
  if (group.test !== undefined) {
    return group.test.includes("node_modules");
  }
  return false;
}

/// PROVE a codeSplitting change is caused ONLY by the package enrichment: every group the OLD case had
/// must survive (none dropped), and every group the NEW case ADDED must be a package chunk group. A
/// dropped base group or an added NON-package group is an unexplained chunking change (the reviewer's
/// concern — a codeSplitting move inside the package bucket that was never proven package-caused).
/// Returns an unexplained-reason string, or `undefined` when fully package-attributable.
function unexplainedCodeSplitting(
  before: unknown,
  after: unknown,
  memberIds: ReadonlySet<string>,
): string | undefined {
  const remainingNew = codeSplittingGroups(after).map((group) => canonicalJson(group));
  for (const oldGroup of codeSplittingGroups(before)) {
    const oldJson = canonicalJson(oldGroup);
    const index = remainingNew.indexOf(oldJson);
    if (index < 0) {
      return "codeSplitting changed: a base chunk group was dropped";
    }
    remainingNew.splice(index, 1);
  }
  const addedNonPackage = codeSplittingGroups(after).filter(
    (group) =>
      remainingNew.includes(canonicalJson(group)) && !isPackageChunkGroup(group, memberIds),
  );
  return addedNonPackage.length > 0
    ? "codeSplitting changed by a non-package chunk group"
    : undefined;
}

/// The reasons a changed case is NOT fully explained by the allowed W14b transformations (package
/// path/specifier/package.json additions, identified new-operation files, an appended package chunk
/// group). An empty list means the change is causally accounted for. Deliberately does NOT trust
/// `packages.length > 0` alone: it PROVES the structural axes did not drift (`buildAxes`), the chunking
/// change is a package chunk group, and every in-place root-file change is a package specifier update
/// or a new-operation file — so a codeSplitting/schedule/render drift the old feature-presence check
/// would have waved through fails here.
function unexplainedChangeReasons(
  before: CaseManifest,
  after: CaseManifest,
  program: ProgramModel | undefined,
): string[] {
  const reasons: string[] = [];
  // (1) The package enrichment is END-STAGE (drawn after the BuildConfig axes are rolled), so it can
  // never move includeDependenciesRecursively / lazyBarrel / preserveEntrySignatures /
  // strictExecutionOrder. A buildAxes move is a real drift, not a package effect.
  if (canonicalJson(before.buildAxes) !== canonicalJson(after.buildAxes)) {
    reasons.push("buildAxes drifted (the end-stage enrichment cannot move a pre-enrichment axis)");
  }
  const membership = program === undefined ? undefined : packageMembershipOf(program);
  const memberIds = new Set(membership?.keys() ?? []);
  // (2) A codeSplitting change must be ONLY appended package chunk groups.
  if (canonicalJson(before.codeSplitting) !== canonicalJson(after.codeSplitting)) {
    const codeSplitReason = unexplainedCodeSplitting(
      before.codeSplitting,
      after.codeSplitting,
      memberIds,
    );
    if (codeSplitReason !== undefined) {
      reasons.push(codeSplitReason);
    }
  }
  // (3) The case must actually carry a W14b feature (packages or a new operation) — otherwise a moved
  // package-free, new-op-free case is an unexplained regression.
  const carriesPackages = (after.packages?.length ?? 0) > 0;
  const newOp = program !== undefined && carriesNewOperation(program);
  if (!carriesPackages && !newOp) {
    reasons.push("changed without packages or a new operation");
    return reasons;
  }
  if (program === undefined) {
    reasons.push("no program available to attribute the file changes");
    return reasons;
  }
  // (4) Every root file that changed IN PLACE (`module-NNNN.ext`) must have changed because its import
  // specifier now targets a package member, or because it carries a new operation — a root file whose
  // bytes moved for neither reason is unexplained. Package files (`node_modules/`) are package layout.
  // Added / removed files (a member moving into node_modules, a cluster's new root module) are covered
  // by (2)/(3) plus the package view.
  const pathToModule = new Map<string, ModuleModel>();
  program.modules.forEach((module, index) => {
    const member = membership?.get(module.id);
    const path =
      member === undefined
        ? `module-${String(index).padStart(4, "0")}.${module.format === "esm" ? "mjs" : "cjs"}`
        : `node_modules/${member.package.name}/${packageMemberFileName(module)}`;
    pathToModule.set(path, module);
  });
  const importsPackageMember = (module: ModuleModel): boolean =>
    module.dependencies.some((dependency) => memberIds.has(dependency.target));
  const carriesModuleNewOp = (module: ModuleModel): boolean =>
    module.dependencies.some((dependency) => dependency.kind === "esm-local-reexport") ||
    (module.format === "esm" && (module.localExports?.length ?? 0) > 0);
  const afterFiles = new Map(after.files.map((file) => [file.path, file.sha256]));
  for (const beforeFile of before.files) {
    const afterHash = afterFiles.get(beforeFile.path);
    if (afterHash === undefined || afterHash === beforeFile.sha256) {
      continue;
    }
    if (beforeFile.path.startsWith("node_modules/")) {
      continue;
    }
    // (5) schedule.json: the old golden holds only a HASH, so byte-level "the old schedule is a prefix
    // of the new one" cannot be re-proven here. What IS checkable causally: the only allowed causes of
    // a schedule change are an APPENDED enrichment entry (the family-B / retained-reference cluster's
    // `import-entry`, whose entry module imports a package member or carries a new operation) or an
    // entry module whose rendered path moved into node_modules (it became a package member). A
    // schedule.json change in a case with NO such entry has no allowed cause and is unexplained.
    if (beforeFile.path === "schedule.json") {
      const hasEnrichmentEntry = program.entries.some((entry) => {
        const entryModule = program.modules.find((module) => module.id === entry.moduleId);
        return (
          entryModule !== undefined &&
          (importsPackageMember(entryModule) ||
            carriesModuleNewOp(entryModule) ||
            memberIds.has(entryModule.id))
        );
      });
      if (!hasEnrichmentEntry) {
        reasons.push(
          "schedule.json changed but no entry module imports a package member, carries a new operation, or is a package member",
        );
      }
      continue;
    }
    const module = pathToModule.get(beforeFile.path);
    if (module === undefined) {
      reasons.push(`changed file ${beforeFile.path} maps to no current module`);
    } else if (!importsPackageMember(module) && !carriesModuleNewOp(module)) {
      reasons.push(
        `root file ${beforeFile.path} changed but imports no package member and carries no new operation`,
      );
    }
  }
  return reasons;
}

function renderCase(
  group: string,
  seed: number,
  size: number,
  template: MixedTemplateName,
  program: ProgramModel,
): CaseManifest {
  programsByKey.set(caseKey(group, seed), program);
  try {
    const rendered = renderProgram(analyzeProgram(program));
    const files = [...rendered.files]
      .map((file) => ({ path: file.path, sha256: sha256(file.contents) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const build = buildConfigOf(program);
    const packages = packagesOf(program);
    return {
      group,
      seed,
      size,
      template,
      files,
      codeSplitting: effectiveCodeSplitting(program),
      buildAxes: {
        includeDependenciesRecursively: build.includeDependenciesRecursively,
        lazyBarrel: build.lazyBarrel,
        preserveEntrySignatures: build.preserveEntrySignatures,
        strictExecutionOrder: build.strictExecutionOrder,
      },
      ...(packages.length > 0
        ? {
            packages: packages.map((pkg) => ({
              name: pkg.name,
              sideEffects: pkg.sideEffects,
              moduleIds: pkg.moduleIds,
            })),
          }
        : {}),
    };
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

/// Reset a program's chunking to automatic, yielding an automatic-chunking base whose other BuildConfig
/// axes are preserved. Also clears any legacy top-level arrays so `build.chunking` is authoritative.
function withAutomaticChunking(program: ProgramModel): ProgramModel {
  const base: ProgramModel = {
    ...program,
    build: { ...buildConfigOf(program), chunking: { kind: "automatic" } },
  };
  delete (base as { manualChunkGroups?: unknown }).manualChunkGroups;
  delete (base as { organicChunkGroups?: unknown }).organicChunkGroups;
  return base;
}

/// Empty-groups boundary cases: an automatic base whose `build.chunking` is an empty manual / organic
/// union. Both build automatic, so `effectiveCodeSplitting` (through `programChunking`) must record
/// `true` — the durable guard that no reader records `{ groups: [] }` for an empty groups union again.
function boundaryCases(): readonly CaseManifest[] {
  const cases: CaseManifest[] = [];
  for (let index = 0; index < BOUNDARY_CASES; index += 1) {
    const seed = BOUNDARY_SEED_BASE + index;
    const size = sampleCaseSize(new SeededRng(seed));
    const base = withAutomaticChunking(generateCase(seed, size, "mixed").program);
    const baseBuild = buildConfigOf(base);
    cases.push(
      renderCase("boundary:empty-manual", seed, size, "random-mixed", {
        ...base,
        build: { ...baseBuild, chunking: { kind: "manual", groups: [] } },
      }),
      renderCase("boundary:empty-organic", seed, size, "random-mixed", {
        ...base,
        build: { ...baseBuild, chunking: { kind: "organic", groups: [] } },
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

  if (command === "explain-delta") {
    if (path === undefined) {
      process.stderr.write("usage: corpus-manifest.ts explain-delta <old-golden-path>\n");
      return 2;
    }
    // PROVE the labeled golden delta CAUSALLY: regenerate against an OLD golden and require every
    // changed case's delta to be accounted for by the ALLOWED W14b transformations (package
    // path/specifier/package.json additions, identified new-operation files, an appended package
    // chunk group) — not merely to CARRY packages. A buildAxes drift, a non-package codeSplitting
    // move, a root file that changed for no package/new-op reason, or a render failure fails the
    // proof; so does any removed/added case. See `unexplainedChangeReasons`.
    if (errors.length > 0) {
      process.stderr.write(
        `explain-delta: FAIL — ${errors.length} case(s) failed to render; a delta with render errors is not proven\n`,
      );
      return 1;
    }
    const baselineCases = JSON.parse(readFileSync(path, "utf8")) as CaseManifest[];
    const baselineByKey = new Map(
      baselineCases.map((entry) => [caseKey(entry.group, entry.seed), entry]),
    );
    const currentByKey = new Map(
      manifest.map((entry) => [caseKey(entry.group, entry.seed), entry]),
    );
    let unchanged = 0;
    let changedWithPackages = 0;
    let changedNewOpOnly = 0;
    const unexplained: string[] = [];
    for (const [key, before] of baselineByKey) {
      const after = currentByKey.get(key);
      if (after === undefined) {
        unexplained.push(`${key}: REMOVED`);
        continue;
      }
      if (canonicalJson(before) === canonicalJson(after)) {
        unchanged += 1;
        continue;
      }
      const program = programsByKey.get(key);
      const reasons = unexplainedChangeReasons(before, after, program);
      if (reasons.length > 0) {
        unexplained.push(`${key}: ${reasons.join("; ")}`);
        continue;
      }
      if ((after.packages?.length ?? 0) > 0) {
        changedWithPackages += 1;
      } else {
        changedNewOpOnly += 1;
      }
    }
    for (const key of currentByKey.keys()) {
      if (!baselineByKey.has(key)) {
        unexplained.push(`${key}: ADDED`);
      }
    }
    // "package-free" = the cases carrying NO packages: the byte-identical ones plus the new-op-only
    // changes. (The old wording called the byte-identical count "the package-free corpus", which
    // under-counts by the new-op-only cases.)
    const packageFree = unchanged + changedNewOpOnly;
    process.stdout.write(
      `explain-delta: ${baselineByKey.size} baseline cases — ${unchanged} byte-identical, ` +
        `${changedWithPackages} changed with packages, ${changedNewOpOnly} changed by a new operation only, ` +
        `${unexplained.length} unexplained ` +
        `(${packageFree} package-free = ${unchanged} unchanged + ${changedNewOpOnly} new-op)\n`,
    );
    for (const line of unexplained.slice(0, 40)) {
      process.stderr.write(`UNEXPLAINED: ${line}\n`);
    }
    return unexplained.length === 0 ? 0 : 1;
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
