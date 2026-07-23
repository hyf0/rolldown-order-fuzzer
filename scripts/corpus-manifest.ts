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
///                                                         # transformations plus the final
///                                                         # entries-aware factor (package
///                                                         # path/specifier/package.json additions, a
///                                                         # new-operation file, an appended package
///                                                         # chunk group, or the reserved exact-manual
///                                                         # replacement) — a render error, a buildAxes
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
  /// A durable fingerprint for a deterministic release-gap replacement. The first migration from an
  /// ordinary random case is explainable, but once the fingerprint exists any later model, render, or
  /// build-manifest drift must fail `explain-delta` instead of being waved through as "directed".
  readonly directedReleaseGap?: {
    readonly kind: "global-read" | "authored-name";
    readonly modelSha256: string;
    /// One-shot migration marker: old global-read fingerprints used monkey-patched built-ins. Once a
    /// corpus member carries this marker, later model drift is rejected again.
    readonly witness?: "fixture-function-v1";
    /// One-shot registry migration marker: adding the computed object-key form changed the closed
    /// global-read form count, so deterministic form selection moved for two fixed corpus seeds. Once
    /// recorded, any later model drift is rejected again.
    readonly surface?: "object-computed-key-v1";
  };
  /// The persisted BuildConfig scalar axes a case builds with (W14a). Chunking is `codeSplitting`;
  /// these are the rest — the rolled `includeDependenciesRecursively` / `lazyBarrel` plus the fixed
  /// `preserveEntrySignatures` / `strictExecutionOrder` — so the golden now guards the structural axes
  /// (they are effective build options, so a change to how a case builds is caught here).
  readonly buildAxes?: {
    readonly includeDependenciesRecursively: boolean;
    readonly lazyBarrel: boolean;
    readonly preserveEntrySignatures: unknown;
    readonly strictExecutionOrder: boolean;
    /// FW-A output-format axis. Recorded ONLY when `cjs` (omitted for the `esm` default), so an esm
    /// case's buildAxes is byte-identical to the pre-FW-A golden and the delta is self-explaining: a
    /// changed case either gained `outputFormat: "cjs"` (the format axis) or a package / new operation.
    readonly outputFormat?: "cjs";
    /// W12 minify axis. Recorded ONLY when `true` (omitted for the `false` default), so an un-minified
    /// case's buildAxes is byte-identical to the pre-W12 golden and the delta is self-explaining: a
    /// changed case either gained `minify: true` (the minify axis) or a format / package / new operation.
    readonly minify?: true;
    /// Readable generated helper names. Omitted for the default false value.
    readonly profilerNames?: true;
    /// Non-default treeshake analysis settings. Default (`"always"` / `"always"` / `[]`) is omitted
    /// so existing ordinary cases remain byte-identical in the golden.
    readonly treeshake?: {
      readonly propertyReadSideEffects?: false;
      readonly propertyWriteSideEffects?: false;
      readonly manualPureFunctions?: readonly string[];
    };
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
    case "disabled":
      return false;
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

/// Whether a program carries a source-model operation introduced after the current golden baseline:
/// - W14b: a source-less local re-export (the camunda M4 op) or declared local exports beside a star
///   (the vben index shape);
/// - W14c: an `export * as ns from` namespace re-export (M7), or a NESTED namespace member read
///   (`readMembers` path of depth ≥ 2 — the canonical member-path surface). The dead-barrel-hop
///   injector is covered by the `localExports` clause (its mixed barrel declares a local export).
function carriesNewOperation(program: ProgramModel): boolean {
  return program.modules.some(
    (module) =>
      module.dependencies.some(
        (dependency) =>
          dependency.kind === "esm-local-reexport" ||
          dependency.kind === "esm-reexport-namespace" ||
          (dependency.kind === "esm-namespace-import" &&
            dependency.readMembers.some((path) => path.length >= 2)),
      ) ||
      (module.format === "esm" && (module.localExports?.length ?? 0) > 0) ||
      (module.format === "esm" &&
        ((module.authoredExportBindings?.length ?? 0) > 0 ||
          module.fixtureFunctionAssignment !== undefined ||
          (module.builtinAssignments?.length ?? 0) > 0 ||
          (module.instanceofAssignments?.length ?? 0) > 0 ||
          (module.optimizerExpressionAssignments?.length ?? 0) > 0 ||
          module.globalReadExport !== undefined)) ||
      module.dependencies.some(
        (dependency) =>
          dependency.kind === "esm-value-import" && dependency.readMemberPath !== undefined,
      ) ||
      // FW-B deliverable 3: an exotic read FORM (a computed intermediate hop `a[imp].y`, or an aliased
      // namespace read `const x = ns; x.foo`) is a new-operation surface too.
      module.events.some((event) =>
        (event.reads ?? []).some(
          (read) => read.computedHopIndex !== undefined || read.alias === true,
        ),
      ),
  );
}

/// The deterministic release-gap lanes replace old random cases wholesale, so their source,
/// schedule, and chunking all legitimately change together. Recognize only the exact typed three- or
/// four-module builders; this keeps `explain-delta` strict for every ordinary case while allowing the
/// deliberate replacement to be attributed to the #10322/#10336 coverage surface. The fourth
/// module is the independent counter reader used by effect-preservation cases. A model fingerprint
/// makes that wholesale exemption one-shot: later drift of an established directed case fails.
function directedReleaseGapIdentity(
  program: ProgramModel,
): CaseManifest["directedReleaseGap"] | undefined {
  const ids = program.modules.map((module) => module.id).sort();
  const oneEntrySchedule = program.entries.length === 1 && program.schedule.length === 1;
  if (!oneEntrySchedule) {
    return undefined;
  }
  if (
    canonicalJson(ids) === canonicalJson(["gr-observer", "gr-patch", "gr-reader"]) ||
    canonicalJson(ids) === canonicalJson(["gr-call-count", "gr-observer", "gr-patch", "gr-reader"])
  ) {
    const reader = program.modules.find((module) => module.id === "gr-reader");
    const patch = program.modules.find((module) => module.id === "gr-patch");
    const isGlobalReadProgram =
      reader?.format === "esm" &&
      reader.globalReadExport !== undefined &&
      patch?.format === "esm" &&
      (patch.fixtureFunctionAssignment === undefined ? 0 : 1) +
        (patch.builtinAssignments?.length ?? 0) +
        (patch.instanceofAssignments?.length ?? 0) +
        (patch.optimizerExpressionAssignments?.length ?? 0) ===
        1;
    return isGlobalReadProgram
      ? {
          kind: "global-read",
          modelSha256: sha256(canonicalJson(program)),
          surface: "object-computed-key-v1",
          ...(patch.fixtureFunctionAssignment === undefined
            ? {}
            : { witness: "fixture-function-v1" as const }),
        }
      : undefined;
  }
  if (
    ids.length === 3 &&
    ids.includes("nc-entry") &&
    ids.includes("nc-user-binding") &&
    (ids.includes("nc-late-esm") || ids.includes("nc-late-cjs"))
  ) {
    const bindingModule = program.modules.find((module) => module.id === "nc-user-binding");
    const isAuthoredNameProgram =
      bindingModule?.format === "esm" &&
      bindingModule.globalReadExport?.form === "direct" &&
      bindingModule.authoredExportBindings?.length === 1 &&
      programChunking(program).kind === "disabled";
    return isAuthoredNameProgram
      ? { kind: "authored-name", modelSha256: sha256(canonicalJson(program)) }
      : undefined;
  }
  return undefined;
}

function isDirectedReleaseGapProgram(program: ProgramModel): boolean {
  return directedReleaseGapIdentity(program) !== undefined;
}

function isReservedReleaseGapLane(seed: number): boolean {
  const lane = Math.abs(seed) % 32;
  return lane === 0 || lane === 1 || lane === 6;
}

function isExplainedTemplateMembershipShift(
  group: string,
  removed: readonly CaseManifest[],
  added: readonly CaseManifest[],
): boolean {
  if (!group.startsWith("template:") || removed.length === 0 || removed.length !== added.length) {
    return false;
  }
  if (group === "template:random-mixed") {
    const addsDirectedCases = added.every((entry) => {
      const program = programsByKey.get(caseKey(entry.group, entry.seed));
      const identity = program === undefined ? undefined : directedReleaseGapIdentity(program);
      return (
        identity !== undefined &&
        canonicalJson(entry.directedReleaseGap) === canonicalJson(identity)
      );
    });
    return addsDirectedCases;
  }
  const addsDirectedCases =
    removed.every((entry) => isReservedReleaseGapLane(entry.seed)) &&
    added.every((entry) => {
      const program = programsByKey.get(caseKey(entry.group, entry.seed));
      return program !== undefined && !isDirectedReleaseGapProgram(program);
    });
  return addsDirectedCases;
}

interface CodeSplittingGroup {
  readonly name?: string;
  readonly moduleIds?: readonly string[];
  readonly test?: string;
  readonly entriesAware?: boolean;
  readonly entriesAwareMergeThreshold?: number;
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

/// The entries-aware END-STAGE factor's exact manual-code-splitting group. It is the only ordinary
/// random group with this reserved name and option pair; its stable model ids let the golden attribute
/// this config-only delta without trusting a mutable coverage tag.
function isEntriesAwareChunkCycleGroup(group: CodeSplittingGroup): boolean {
  return (
    group.name === "entries-aware-apps" &&
    group.entriesAware === true &&
    group.entriesAwareMergeThreshold === 100 * 1024 &&
    group.test === undefined &&
    group.moduleIds?.length === 2
  );
}

function isEntriesAwareChunkCycleConfig(codeSplitting: unknown): boolean {
  const groups = codeSplittingGroups(codeSplitting);
  return groups.length === 1 && groups[0] !== undefined && isEntriesAwareChunkCycleGroup(groups[0]);
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
  const addedUnexplained = codeSplittingGroups(after).filter(
    (group) =>
      remainingNew.includes(canonicalJson(group)) && !isPackageChunkGroup(group, memberIds),
  );
  return addedUnexplained.length > 0
    ? "codeSplitting changed by an unrecognized chunk group"
    : undefined;
}

/// The reasons a changed case is NOT fully explained by the allowed W14b transformations (package
/// path/specifier/package.json additions, identified new-operation files, an appended package chunk
/// group, or the reserved final exact-manual factor). An empty list means the change is causally
/// accounted for. Deliberately does NOT trust
/// `packages.length > 0` alone: it PROVES the structural axes did not drift (`buildAxes`), the chunking
/// change is a package chunk group, and every in-place root-file change is a package specifier update
/// or a new-operation file — so a codeSplitting/schedule/render drift the old feature-presence check
/// would have waved through fails here.
/// A case's buildAxes with the LAST-DRAWN rolled axes (`outputFormat`, `minify`, `profilerNames`) stripped,
/// so the drift check compares only the four pre-axis fields. An `outputFormat` / `minify` difference is
/// an allowed roll drawn after the enrichment, not a pre-enrichment drift.
function buildAxesWithoutRolledAxes(caseManifest: CaseManifest): unknown {
  if (caseManifest.buildAxes === undefined) {
    return undefined;
  }
  const {
    outputFormat: _outputFormat,
    minify: _minify,
    profilerNames: _profilerNames,
    ...rest
  } = caseManifest.buildAxes;
  return rest;
}

function unexplainedChangeReasons(
  before: CaseManifest,
  after: CaseManifest,
  program: ProgramModel | undefined,
): string[] {
  const reasons: string[] = [];
  const directedIdentity = program === undefined ? undefined : directedReleaseGapIdentity(program);
  if (directedIdentity !== undefined) {
    if (canonicalJson(after.directedReleaseGap) !== canonicalJson(directedIdentity)) {
      return ["directed release-gap fingerprint does not match the generated model"];
    }
    if (before.directedReleaseGap === undefined) {
      // This is the one allowed wholesale replacement: an old ordinary corpus member becomes the exact
      // typed directed case whose full model is fingerprinted above.
      return reasons;
    }
    if (
      before.directedReleaseGap.kind === "global-read" &&
      before.directedReleaseGap.witness === undefined &&
      directedIdentity.kind === "global-read" &&
      directedIdentity.witness === "fixture-function-v1"
    ) {
      // One intentional semantic migration: analyzer cases stop monkey-patching standard built-ins.
      return reasons;
    }
    if (
      before.directedReleaseGap.kind === "global-read" &&
      before.directedReleaseGap.surface === undefined &&
      directedIdentity.kind === "global-read" &&
      directedIdentity.surface === "object-computed-key-v1" &&
      before.directedReleaseGap.witness === directedIdentity.witness
    ) {
      // One intentional closed-registry migration: adding one global-read form changes the seeded
      // selection range. The marker makes this exemption one-shot; the regenerated fingerprint locks
      // the selected model again.
      return reasons;
    }
    return [
      canonicalJson(before.directedReleaseGap) === canonicalJson(after.directedReleaseGap)
        ? "directed release-gap case drifted after its model fingerprint was established"
        : "directed release-gap model fingerprint changed",
    ];
  }
  if (before.directedReleaseGap !== undefined || after.directedReleaseGap !== undefined) {
    reasons.push("directed release-gap marker exists on an unrecognized program shape");
  }
  const entriesAwareFactorChanged =
    isEntriesAwareChunkCycleConfig(after.codeSplitting) &&
    !isEntriesAwareChunkCycleConfig(before.codeSplitting);
  // (1) The package enrichment is END-STAGE (drawn after the BuildConfig axes are rolled), so it can
  // never move includeDependenciesRecursively / lazyBarrel / preserveEntrySignatures /
  // strictExecutionOrder. A buildAxes move is a real drift, not a package effect. EXCEPT the two
  // LAST-DRAWN axes: the FW-A output-format axis and the W12 minify axis. An esm case has no
  // `outputFormat` key, a cjs case gains `outputFormat: "cjs"`; an un-minified case has no `minify` key,
  // a minified case gains `minify: true` — both allowed axis rolls. So compare the buildAxes with BOTH
  // STRIPPED; only a difference in the OTHER four axes is a real drift.
  const beforeAxes = buildAxesWithoutRolledAxes(before);
  const afterAxes = buildAxesWithoutRolledAxes(after);
  const comparableBeforeAxes =
    entriesAwareFactorChanged && typeof beforeAxes === "object" && beforeAxes !== null
      ? Object.fromEntries(
          Object.entries(beforeAxes as Record<string, unknown>).filter(
            ([key]) => key !== "includeDependenciesRecursively",
          ),
        )
      : beforeAxes;
  const comparableAfterAxes =
    entriesAwareFactorChanged && typeof afterAxes === "object" && afterAxes !== null
      ? Object.fromEntries(
          Object.entries(afterAxes as Record<string, unknown>).filter(
            ([key]) => key !== "includeDependenciesRecursively",
          ),
        )
      : afterAxes;
  if (canonicalJson(comparableBeforeAxes) !== canonicalJson(comparableAfterAxes)) {
    reasons.push("buildAxes drifted outside the explicitly allowed end-stage changes");
  }
  if (entriesAwareFactorChanged && after.buildAxes?.includeDependenciesRecursively !== false) {
    reasons.push(
      "the entriesAware chunk-cycle factor must force includeDependenciesRecursively:false",
    );
  }
  const outputFormatChanged = before.buildAxes?.outputFormat !== after.buildAxes?.outputFormat;
  const minifyChanged = before.buildAxes?.minify !== after.buildAxes?.minify;
  const profilerNamesChanged = before.buildAxes?.profilerNames !== after.buildAxes?.profilerNames;
  const rolledAxisChanged = outputFormatChanged || minifyChanged || profilerNamesChanged;
  const membership = program === undefined ? undefined : packageMembershipOf(program);
  const memberIds = new Set(membership?.keys() ?? []);
  // (2) A codeSplitting change must be only appended package chunk groups, unless the recognized final
  // entries-aware factor replaces the whole config with its one exact group.
  if (canonicalJson(before.codeSplitting) !== canonicalJson(after.codeSplitting)) {
    const codeSplitReason = entriesAwareFactorChanged
      ? undefined
      : unexplainedCodeSplitting(before.codeSplitting, after.codeSplitting, memberIds);
    if (codeSplitReason !== undefined) {
      reasons.push(codeSplitReason);
    }
  }
  // (3) The case must actually carry a W14b feature (packages or a new operation) OR have changed by a
  // last-drawn axis roll (output-format or minify) alone — otherwise a moved package-free, new-op-free,
  // axis-unchanged case is an unexplained regression. An axis-only change (a cjs and/or minify roll, no
  // source-byte / package effect) is fully accounted for: both axes are bundle-side, so the source render
  // is unchanged and only the buildAxes gained `outputFormat: "cjs"` and/or `minify: true`.
  const carriesPackages = (after.packages?.length ?? 0) > 0;
  const newOp = program !== undefined && carriesNewOperation(program);
  if (!carriesPackages && !newOp && !rolledAxisChanged && !entriesAwareFactorChanged) {
    reasons.push(
      "changed without packages, a new operation, an output-format/minify roll, or the entriesAware chunking factor",
    );
    return reasons;
  }
  if (!carriesPackages && !newOp) {
    // A bundle-only change: no packages and no new source operation, only the output-format/minify axes
    // and/or the entriesAware chunking factor moved. Source bytes must therefore be byte-identical — a
    // rendered-file change with no package or new-operation cause is still unexplained.
    for (const beforeFile of before.files) {
      const afterHash = new Map(after.files.map((file) => [file.path, file.sha256])).get(
        beforeFile.path,
      );
      if (afterHash !== undefined && afterHash !== beforeFile.sha256) {
        reasons.push(
          `bundle-only change altered source file ${beforeFile.path} (output-format/minify/entriesAware chunking must not touch rendered source)`,
        );
      }
    }
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
  // A module carrying a W14b/W14c new operation surface: a source-less local re-export, an
  // `export * as ns from` namespace re-export, a NESTED namespace member read, or declared localExports.
  const carriesModuleNewOp = (module: ModuleModel): boolean =>
    module.dependencies.some(
      (dependency) =>
        dependency.kind === "esm-local-reexport" ||
        dependency.kind === "esm-reexport-namespace" ||
        (dependency.kind === "esm-namespace-import" &&
          dependency.readMembers.some((path) => path.length >= 2)),
    ) ||
    (module.format === "esm" && (module.localExports?.length ?? 0) > 0) ||
    (module.format === "esm" &&
      ((module.authoredExportBindings?.length ?? 0) > 0 ||
        module.fixtureFunctionAssignment !== undefined ||
        (module.builtinAssignments?.length ?? 0) > 0 ||
        (module.instanceofAssignments?.length ?? 0) > 0 ||
        (module.optimizerExpressionAssignments?.length ?? 0) > 0 ||
        module.globalReadExport !== undefined)) ||
    module.dependencies.some(
      (dependency) =>
        dependency.kind === "esm-value-import" && dependency.readMemberPath !== undefined,
    ) ||
    // FW-B deliverable 3: a module whose event reads carry an exotic FORM (computed intermediate hop /
    // aliased namespace) carries a new-operation surface.
    module.events.some((event) =>
      (event.reads ?? []).some(
        (read) => read.computedHopIndex !== undefined || read.alias === true,
      ),
    );
  const modulesByIdLocal = new Map(program.modules.map((module) => [module.id, module]));
  // An entry whose module IMPORTS a module carrying a new op (the W14c ns-reexport barrel / dead-hop
  // mixed barrel) is an enrichment entry too — the injector added it alongside that new-op module.
  const importsNewOpModule = (module: ModuleModel): boolean =>
    module.dependencies.some((dependency) => {
      const target = modulesByIdLocal.get(dependency.target);
      return target !== undefined && carriesModuleNewOp(target);
    });
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
            importsNewOpModule(entryModule) ||
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
    const directedReleaseGap = directedReleaseGapIdentity(program);
    return {
      group,
      seed,
      size,
      template,
      files,
      codeSplitting: effectiveCodeSplitting(program),
      ...(directedReleaseGap === undefined ? {} : { directedReleaseGap }),
      buildAxes: {
        includeDependenciesRecursively: build.includeDependenciesRecursively,
        lazyBarrel: build.lazyBarrel,
        preserveEntrySignatures: build.preserveEntrySignatures,
        strictExecutionOrder: build.strictExecutionOrder,
        // FW-A: only a cjs case records outputFormat, so esm cases stay byte-identical to the old golden.
        ...(build.outputFormat === "cjs" ? { outputFormat: "cjs" as const } : {}),
        // W12: only a minified case records minify, so un-minified cases stay byte-identical.
        ...(build.minify ? { minify: true as const } : {}),
        ...(build.profilerNames ? { profilerNames: true as const } : {}),
        ...(build.treeshake.propertyReadSideEffects === false ||
        build.treeshake.propertyWriteSideEffects === false ||
        build.treeshake.manualPureFunctions.length > 0
          ? {
              treeshake: {
                ...(build.treeshake.propertyReadSideEffects === false
                  ? { propertyReadSideEffects: false as const }
                  : {}),
                ...(build.treeshake.propertyWriteSideEffects === false
                  ? { propertyWriteSideEffects: false as const }
                  : {}),
                ...(build.treeshake.manualPureFunctions.length > 0
                  ? { manualPureFunctions: build.treeshake.manualPureFunctions }
                  : {}),
              },
            }
          : {}),
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
    // changed case's delta to be accounted for by the allowed source enrichments, last-drawn scalar
    // axes, or the entries-aware exact-manual factor — not merely to CARRY a feature. A buildAxes
    // drift, an unrecognized codeSplitting move, a root file that changed for no source reason, or a
    // render failure fails the proof; so does any removed/added case. See `unexplainedChangeReasons`.
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
    let changedAxisOnly = 0;
    let changedEntriesAwareOnly = 0;
    let changedTemplateMembership = 0;
    const unexplained: string[] = [];
    const removedEntries: CaseManifest[] = [];
    const addedEntries: CaseManifest[] = [];
    for (const [key, before] of baselineByKey) {
      const after = currentByKey.get(key);
      if (after === undefined) {
        removedEntries.push(before);
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
      // A case whose ONLY change is a last-drawn axis roll (FW-A output-format and/or W12 minify — no
      // packages, no new operation, so its source files are byte-identical) is a distinct explained
      // category.
      const rolledAxisChanged =
        before.buildAxes?.outputFormat !== after.buildAxes?.outputFormat ||
        before.buildAxes?.minify !== after.buildAxes?.minify ||
        before.buildAxes?.profilerNames !== after.buildAxes?.profilerNames;
      const entriesAwareFactorChanged =
        isEntriesAwareChunkCycleConfig(after.codeSplitting) &&
        !isEntriesAwareChunkCycleConfig(before.codeSplitting);
      if (entriesAwareFactorChanged) {
        changedEntriesAwareOnly += 1;
      } else if ((after.packages?.length ?? 0) > 0) {
        changedWithPackages += 1;
      } else if (rolledAxisChanged && !(program !== undefined && carriesNewOperation(program))) {
        changedAxisOnly += 1;
      } else {
        changedNewOpOnly += 1;
      }
    }
    for (const [key, after] of currentByKey) {
      if (!baselineByKey.has(key)) {
        addedEntries.push(after);
      }
    }
    const membershipGroups = new Set([
      ...removedEntries.map((entry) => entry.group),
      ...addedEntries.map((entry) => entry.group),
    ]);
    for (const group of membershipGroups) {
      const removed = removedEntries.filter((entry) => entry.group === group);
      const added = addedEntries.filter((entry) => entry.group === group);
      if (isExplainedTemplateMembershipShift(group, removed, added)) {
        changedTemplateMembership += removed.length;
        continue;
      }
      for (const entry of removed) {
        unexplained.push(`${caseKey(entry.group, entry.seed)}: REMOVED`);
      }
      for (const entry of added) {
        unexplained.push(`${caseKey(entry.group, entry.seed)}: ADDED`);
      }
    }
    // "package-free" = the cases carrying NO packages: the byte-identical ones plus the new-op-only
    // changes. (The old wording called the byte-identical count "the package-free corpus", which
    // under-counts by the new-op-only cases.)
    const packageFree = manifest.filter((entry) => (entry.packages?.length ?? 0) === 0).length;
    process.stdout.write(
      `explain-delta: ${baselineByKey.size} baseline cases — ${unchanged} byte-identical, ` +
        `${changedWithPackages} changed with packages, ${changedNewOpOnly} changed by a new operation only, ` +
        `${changedAxisOnly} changed by an output-format/minify/profilerNames axis roll only, ` +
        `${changedEntriesAwareOnly} changed by the entriesAware chunking factor only, ` +
        `${changedTemplateMembership} template members changed by the release-gap lane policy, ` +
        `${unexplained.length} unexplained ` +
        `(${packageFree} package-free cases)\n`,
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
