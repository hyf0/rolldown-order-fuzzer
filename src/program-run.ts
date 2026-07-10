/// <reference types="node" />

/// The layer BELOW the campaign/CLI runner: run ONE program end-to-end (render, run the source under
/// Node, build it with Rolldown, run the bundle, classify the differential verdict) and the verdict
/// types that classification produces. The campaign runner (`main.ts`) and the shrinker's
/// `case-evaluator.ts` both call THIS — neither the evaluator nor the shrinker imports the campaign/CLI
/// layer any more, and the build-failure verdict lives here where the coming link/build-failure verdict
/// class will refine it, below the artifact-identity and CLI machinery that stays in `main.ts`.

import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { analyzeProgram, type AnalyzedProgram } from "./analyzed-program.ts";
import { executeManifest } from "./execute.ts";
import type { FormatRegime, GeneratedCase } from "./generate.ts";
import type { ProgramModel } from "./model.ts";
import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionManifest,
  type ExecutionOutcome,
} from "./protocol.ts";
import { renderProgram, type RenderedProgram } from "./render.ts";
import {
  inspectRolldownRuntimeIdentity,
  withRolldownBuild,
  type FailedRolldownAdapterResult,
  type ObservedRuntimeIdentity,
} from "./rolldown-adapter.ts";
import { classifyVerdict, type Verdict } from "./verdict.ts";

const ROLLDOWN_TEMPORARY_ROOT_PATTERN =
  /(?:file:\/\/\/|(?:[A-Za-z]:)?[\\/])(?:[^\s"'`]*[\\/])?rolldown-order-fuzzer-[A-Za-z0-9]{6}/g;
const FUZZER_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");

export const DEFAULT_CASE_SIZE = 4;

export interface CampaignOptions {
  readonly seed: number;
  readonly cases: number;
  readonly caseSize: number;
  /// When true (the default, i.e. `--case-size` was NOT given), each case draws its size from the
  /// weighted small/medium/large spread (`sampleCaseSize`), so one campaign covers every scale;
  /// `caseSize` is then only the fallback. When false, every case uses the fixed `caseSize`.
  readonly sizeMix: boolean;
  readonly onDemandWrapping: boolean;
  /// Forces every case onto the random generator with a fixed format regime; absent means the
  /// generator's own weighted mix of regimes and fixed templates.
  readonly formatRegime?: FormatRegime;
  readonly rolldownPackage: string;
  readonly outDir: string;
  readonly continueOnFail: boolean;
}

export interface SourceInvalidBundleOutcome {
  readonly status: "not-run";
  readonly reason: "source-invalid";
}

export interface AdapterFailureBundleOutcome {
  readonly status: "not-run";
  readonly reason: "adapter-failure";
  readonly adapterFailure: FailedRolldownAdapterResult;
}

export type BundleNotRunOutcome = SourceInvalidBundleOutcome | AdapterFailureBundleOutcome;

export type CampaignBundleOutcome = ExecutionOutcome | BundleNotRunOutcome;

export interface BuildFailureVerdict {
  readonly kind: "build-failure";
  /// The build-failure family. `panic` is a Rolldown crash; `link` is a link-time resolution failure
  /// (a `MISSING_EXPORT` — an export a retained consumer references that the linker cannot resolve, the
  /// #10044 family), carrying the missing (export, module) identity so a link-time regression is a
  /// first-class, deduplicated catch distinct from a runtime `bundle-only-crash`; the rest are the raw
  /// adapter stage. A GENERATED model never produces a `link` failure — the plan's supply-status
  /// validation rejects any unsupplied/ambiguous demand BEFORE build — so a `build-failure:link` is
  /// always a genuine Rolldown linker bug on a model the fuzzer proved is fully supplied.
  readonly reason: FailedRolldownAdapterResult["stage"] | "panic" | "link";
  readonly signature: string;
}

export type CampaignVerdict = Verdict | BuildFailureVerdict;

export interface CapturedFile {
  readonly path: string;
  readonly contents: Uint8Array;
}

export interface BundleExecutionArtifacts {
  readonly bundleOutcome: ExecutionOutcome;
  readonly bundleManifest: ExecutionManifest;
  readonly bundleFiles: readonly CapturedFile[];
  readonly runtimeIdentity?: ObservedRuntimeIdentity;
}

export type BundleBuildResult =
  | { readonly status: "ok"; readonly value: BundleExecutionArtifacts }
  | {
      readonly status: "failed";
      readonly failure: FailedRolldownAdapterResult;
      readonly bundleManifest: ExecutionManifest | null;
      readonly bundleFiles: readonly CapturedFile[];
      readonly runtimeIdentity?: ObservedRuntimeIdentity;
    };

export interface CampaignCaseResult {
  readonly generated: GeneratedCase;
  readonly options: CampaignOptions;
  readonly rendered: RenderedProgram;
  readonly sourceOutcome: ExecutionOutcome;
  readonly bundleOutcome: CampaignBundleOutcome;
  readonly bundleManifest: ExecutionManifest | null;
  readonly bundleFiles: readonly CapturedFile[];
  readonly runtimeIdentity: ObservedRuntimeIdentity;
  readonly verdict: CampaignVerdict;
}

/// The minimal build inputs one program run needs — which Rolldown to build with and the wrap mode.
/// Everything else `CampaignOptions` threads (seed, template, coverage, case count, output directory,
/// cosmetic size) is irrelevant to running a single loaded model, so `executeProgram` takes only this.
export interface MinimalExecutionOptions {
  readonly rolldownPackage: string;
  readonly onDemandWrapping: boolean;
}

export interface ProgramExecutionDependencies {
  readonly executeSource: (rendered: RenderedProgram) => Promise<ExecutionOutcome>;
  readonly inspectRuntimeIdentity: typeof inspectRolldownRuntimeIdentity;
  readonly buildBundle: (
    program: ProgramModel,
    rendered: RenderedProgram,
    options: MinimalExecutionOptions,
  ) => Promise<BundleBuildResult>;
}

/// Everything running ONE program produces, WITHOUT the campaign's generated-case / CLI-options
/// bookkeeping — the seam both the campaign (`executeGeneratedCase`) and the shrinker's case-evaluator
/// wrap, so neither fabricates a `GeneratedCase` and a full `CampaignOptions` merely to run a model.
export interface ProgramExecutionResult {
  readonly rendered: RenderedProgram;
  readonly sourceOutcome: ExecutionOutcome;
  readonly bundleOutcome: CampaignBundleOutcome;
  readonly bundleManifest: ExecutionManifest | null;
  readonly bundleFiles: readonly CapturedFile[];
  readonly runtimeIdentity: ObservedRuntimeIdentity;
  readonly verdict: CampaignVerdict;
}

/// Run ONE program end-to-end: render (reusing a carried `AnalyzedProgram` when the caller has one, so
/// demand analysis is NOT re-run on the case path), execute the source under Node, build it with
/// Rolldown, run the bundle, and classify the differential verdict. The campaign wraps this to attach the
/// `GeneratedCase`/`CampaignOptions`; the shrinker's evaluator wraps it to read the verdict.
export async function executeProgram(
  program: ProgramModel,
  options: MinimalExecutionOptions,
  overrides: Partial<ProgramExecutionDependencies> = {},
  analyzed?: AnalyzedProgram,
): Promise<ProgramExecutionResult> {
  const dependencies: ProgramExecutionDependencies = {
    executeSource: executeRenderedSource,
    inspectRuntimeIdentity: inspectRolldownRuntimeIdentity,
    buildBundle: buildAndExecuteBundle,
    ...overrides,
  };
  // This is a transition seam that still receives `program` and an OPTIONAL carried `analyzed` (so the
  // case path reuses its one analysis). The consumers below take only an AnalyzedProgram, so normalize
  // here — and assert the carried analysis is OF this program, making the finding-1 mismatch loud rather
  // than a silently wrong render. A missing analysis is built from the program (identity holds trivially).
  const analysis = analyzed ?? analyzeProgram(program);
  if (analysis.program !== program) {
    throw new Error(
      "executeProgram: the supplied analysis is for a different program than the one being run",
    );
  }
  const rendered = renderProgram(analysis);
  const sourceOutcome = await dependencies.executeSource(rendered);
  if (sourceOutcome.status === "timeout" || sourceOutcome.status === "harness-error") {
    const runtimeIdentity = await dependencies.inspectRuntimeIdentity(options.rolldownPackage);
    const bundleOutcome = {
      status: "not-run",
      reason: "source-invalid",
    } as const satisfies SourceInvalidBundleOutcome;
    return {
      rendered,
      sourceOutcome,
      bundleOutcome,
      bundleManifest: null,
      bundleFiles: [],
      runtimeIdentity,
      verdict: classifyCampaignVerdict(sourceOutcome, bundleOutcome),
    };
  }

  const built = await dependencies.buildBundle(program, rendered, options);

  if (built.status === "failed") {
    const runtimeIdentity =
      built.runtimeIdentity ?? (await dependencies.inspectRuntimeIdentity(options.rolldownPackage));
    const bundleOutcome = {
      status: "not-run",
      reason: "adapter-failure",
      adapterFailure: built.failure,
    } as const satisfies AdapterFailureBundleOutcome;
    return {
      rendered,
      sourceOutcome,
      bundleOutcome,
      bundleManifest: built.bundleManifest,
      bundleFiles: built.bundleFiles,
      runtimeIdentity,
      verdict: classifyCampaignVerdict(sourceOutcome, bundleOutcome),
    };
  }

  const runtimeIdentity =
    built.value.runtimeIdentity ??
    (await dependencies.inspectRuntimeIdentity(options.rolldownPackage));
  return {
    rendered,
    sourceOutcome,
    bundleOutcome: built.value.bundleOutcome,
    bundleManifest: built.value.bundleManifest,
    bundleFiles: built.value.bundleFiles,
    runtimeIdentity,
    verdict: classifyCampaignVerdict(sourceOutcome, built.value.bundleOutcome),
  };
}

/// The campaign wrapper: run `generated`'s program (reusing its carried `AnalyzedProgram`, so the case
/// path analyzes once) and attach the generated case and CLI options to form a `CampaignCaseResult`.
export async function executeGeneratedCase(
  generated: GeneratedCase,
  options: CampaignOptions,
  overrides: Partial<ProgramExecutionDependencies> = {},
): Promise<CampaignCaseResult> {
  const run = await executeProgram(
    generated.program,
    { rolldownPackage: options.rolldownPackage, onDemandWrapping: options.onDemandWrapping },
    overrides,
    generated.analyzed,
  );
  return { generated, options, ...run };
}

export function classifyCampaignVerdict(
  sourceOutcome: ExecutionOutcome,
  bundleOutcome: CampaignBundleOutcome,
): CampaignVerdict {
  if (sourceOutcome.status === "harness-error" || sourceOutcome.status === "timeout") {
    return classifyVerdict(sourceOutcome, {
      version: EXECUTION_PROTOCOL_VERSION,
      status: "timeout",
      events: [],
    });
  }
  if (bundleOutcome.status !== "not-run") {
    return classifyVerdict(sourceOutcome, bundleOutcome);
  }
  if (bundleOutcome.reason === "adapter-failure") {
    return buildFailureVerdict(bundleOutcome.adapterFailure);
  }
  throw new Error("A valid source outcome cannot have a source-invalid bundle outcome");
}

/// A rendered file's absolute path, GUARDED to stay within the materialization root. A well-formed
/// program never produces an escaping path (the validator rejects non-filename-safe package member
/// ids), but a materializer is a defense-in-depth boundary: a handwritten/legacy model or a shrink
/// candidate that skips validation must not write outside its temp dir (W14b.1 blocker 1 — a flagged
/// `../../../x` id would otherwise `join` to `/tmp/x.mjs`).
function containedPath(rootDirectory: string, filePath: string): string {
  const rootResolved = resolve(rootDirectory);
  const joined = resolve(rootDirectory, filePath);
  if (joined !== rootResolved && !joined.startsWith(rootResolved + sep)) {
    throw new Error(
      `rendered file path ${JSON.stringify(filePath)} escapes the materialization root ${JSON.stringify(rootDirectory)}`,
    );
  }
  return joined;
}

async function executeRenderedSource(rendered: RenderedProgram): Promise<ExecutionOutcome> {
  const sourceDirectory = await mkdtemp(join(tmpdir(), "rolldown-order-source-"));
  try {
    for (const file of rendered.files) {
      const path = containedPath(sourceDirectory, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.contents);
    }
    return await executeManifest(join(sourceDirectory, rendered.schedulePath));
  } finally {
    await rm(sourceDirectory, { recursive: true, force: true });
  }
}

async function buildAndExecuteBundle(
  program: ProgramModel,
  rendered: RenderedProgram,
  options: MinimalExecutionOptions,
): Promise<BundleBuildResult> {
  let failureArtifacts: Pick<CampaignCaseResult, "bundleManifest" | "bundleFiles"> & {
    readonly runtimeIdentity?: ObservedRuntimeIdentity;
  } = {
    bundleManifest: null,
    bundleFiles: [],
  };
  const built = await withRolldownBuild(
    program,
    rendered,
    async (artifacts) => ({
      bundleOutcome: await executeManifest(artifacts.bundleManifestPath),
      bundleManifest: artifacts.manifest,
      bundleFiles: await Promise.all(
        artifacts.outputFiles.map(async (fileName) => ({
          path: fileName,
          contents: await readFile(join(artifacts.bundleDirectory, fileName)),
        })),
      ),
      runtimeIdentity: artifacts.runtimeIdentity,
    }),
    {
      packageSpecifier: options.rolldownPackage,
      onDemandWrapping: options.onDemandWrapping,
      onFailureArtifacts: async (_failure, artifacts) => {
        failureArtifacts = {
          bundleManifest: artifacts.manifest ?? null,
          bundleFiles: await captureBundleFiles(
            artifacts.bundleDirectory,
            new Set(["package.json", rendered.schedulePath]),
          ),
          runtimeIdentity: artifacts.runtimeIdentity,
        };
      },
    },
  );
  if (built.status === "ok") {
    return built;
  }
  return {
    status: "failed",
    failure: built,
    ...failureArtifacts,
  };
}

async function captureBundleFiles(
  directory: string,
  excludedPaths: ReadonlySet<string>,
): Promise<readonly CapturedFile[]> {
  if (!(await pathExists(directory))) {
    return [];
  }

  const files: CapturedFile[] = [];
  const pending: { readonly directory: string; readonly relativePath: string }[] = [
    { directory, relativePath: "" },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    const entries = await readdir(current.directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath =
        current.relativePath.length === 0 ? entry.name : `${current.relativePath}/${entry.name}`;
      const path = join(current.directory, entry.name);
      if (entry.isDirectory()) {
        pending.push({ directory: path, relativePath });
      } else if (entry.isFile() && !excludedPaths.has(relativePath)) {
        files.push({ path: relativePath, contents: await readFile(path) });
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function buildFailureVerdict(failure: FailedRolldownAdapterResult): BuildFailureVerdict {
  if (failure.panic === true) {
    // A genuine Rolldown build panic: a distinct failing verdict (never a harness discard) with a
    // normalized message identity, deduplicated across runs, producing artifacts like any failure.
    return {
      kind: "build-failure",
      reason: "panic",
      signature: `build-failure:panic:${JSON.stringify([
        failure.error.name,
        normalizeBuildFailureMessage(failure.error.message),
      ])}`,
    };
  }
  // A link-time resolution failure (MISSING_EXPORT) is a FIRST-CLASS catch distinct from a runtime
  // crash: the linker cannot resolve an export a retained consumer references (#10044 family). Its
  // identity is the missing (export, module) pair, not the volatile full message, so a link-time
  // regression deduplicates to one signature. Only fires on a genuine linker bug — the plan's
  // supply-status validation rejects any unsupplied model before it ever reaches the build.
  //
  // GATED to a genuine BUILD-stage build error. A HARNESS failure (a package that fails to LOAD with a
  // message that merely contains `MISSING_EXPORT`, stage `load-package`) is an environment problem, never
  // a Rolldown linker bug — classifying it as `link` would poison the artifacts/shrink/dedup with a false
  // catch. Only `status: "build-error"` at `stage: "build"` reaches the linker at all.
  if (failure.status === "build-error" && failure.stage === "build") {
    const link = detectLinkFailure(failure.error.name, failure.error.message);
    if (link !== undefined) {
      return {
        kind: "build-failure",
        reason: "link",
        signature:
          link.kind === "identified"
            ? `build-failure:link:${JSON.stringify([link.exportName, link.module])}`
            : "build-failure:link:unknown",
      };
    }
  }
  return {
    kind: "build-failure",
    reason: failure.stage,
    signature: `build-failure:${failure.status}:${failure.stage}:${JSON.stringify([
      failure.error.name,
      normalizeBuildFailureMessage(failure.error.message),
    ])}`,
  };
}

/// A Rolldown link-time MISSING_EXPORT failure: `[MISSING_EXPORT] "<name>" is not exported by
/// "<module>"`. Returns an `identified` variant carrying the missing (export name, normalized module)
/// pair when the quoted phrase parses, an `unknown` variant when only the `MISSING_EXPORT` code is
/// present (a link failure whose identity cannot be parsed), or `undefined` when the error is not a link
/// failure. The two variants stay DISTINCT rather than collapsing an unparseable failure into a fake
/// `("<unknown>", <whole message>)` pair: an unknown-identity link failure carries a stable
/// identity-free `build-failure:link:unknown` signature instead of the volatile full message.
export type LinkFailureIdentity =
  | { readonly kind: "identified"; readonly exportName: string; readonly module: string }
  | { readonly kind: "unknown" };

const MISSING_EXPORT_PATTERN = /"([^"]+)"\s+is not exported by\s+"([^"]+)"/;
export function detectLinkFailure(name: string, message: string): LinkFailureIdentity | undefined {
  const match = MISSING_EXPORT_PATTERN.exec(message);
  if (match !== null && match[1] !== undefined && match[2] !== undefined) {
    return {
      kind: "identified",
      exportName: match[1],
      module: normalizeBuildFailureMessage(match[2]),
    };
  }
  // A message that only carries the code, no quoted phrase — still a link failure, but without a
  // parseable identity. An explicit `unknown` variant, NOT a fabricated (export, module) pair.
  if (name.includes("MISSING_EXPORT") || message.includes("MISSING_EXPORT")) {
    return { kind: "unknown" };
  }
  return undefined;
}

/// Rewrite the volatile absolute paths in a Rolldown build-failure message to stable placeholders, so a
/// build failure deduplicates across runs regardless of the temp/root directory it ran in. Shared by
/// the build-failure verdict here and the artifact identity in `main.ts`.
export function normalizeBuildFailureMessage(message: string): string {
  let normalized = message.replaceAll(ROLLDOWN_TEMPORARY_ROOT_PATTERN, "<rolldown-root>");
  normalized = normalized.replaceAll(`${pathToFileURL(FUZZER_ROOT).href}/`, "<fuzzer-root>/");
  for (const root of new Set([
    FUZZER_ROOT,
    FUZZER_ROOT.replaceAll("\\", "/"),
    FUZZER_ROOT.replaceAll("/", "\\"),
  ])) {
    normalized = normalized
      .replaceAll(`${root}/`, "<fuzzer-root>/")
      .replaceAll(`${root}\\`, "<fuzzer-root>/");
  }
  return normalized;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
