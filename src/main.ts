/// <reference types="node" />

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { executeManifest } from "./execute.ts";
import { generateCase, type GeneratedCase } from "./generate.ts";
import {
  reconstructStrictExecutionOrderEventGraph,
  type StrictExecutionOrderEventGraph,
  type StrictExecutionOrderPlanReady,
} from "./order-trace.ts";
import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionManifest,
  type ExecutionOutcome,
} from "./protocol.ts";
import { renderProgram, type RenderedProgram } from "./render.ts";
import {
  inspectRolldownRuntimeIdentity,
  ROLLDOWN_BUILD_OPTIONS,
  withRolldownBuild,
  type FailedRolldownAdapterResult,
  type ObservedRuntimeIdentity,
} from "./rolldown-adapter.ts";
import { classifyVerdict, type Verdict } from "./verdict.ts";

const UINT32_RANGE = 0x1_0000_0000;
const ROLLDOWN_TEMPORARY_ROOT_PATTERN =
  /(?:file:\/\/\/|(?:[A-Za-z]:)?[\\/])(?:[^\s"'`]*[\\/])?rolldown-order-fuzzer-[A-Za-z0-9]{6}/g;
const FUZZER_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
let campaignEnvironmentLock = Promise.resolve();

export const DEFAULT_CASE_SIZE = 4;
export const FAILURE_ARTIFACT_SCHEMA_VERSION = 5 as const;

export interface CampaignOptions {
  readonly seed: number;
  readonly cases: number;
  readonly rolldownPackage: string;
  readonly outDir: string;
  readonly continueOnFail: boolean;
  readonly collectOrderTrace: boolean;
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
  readonly reason: FailedRolldownAdapterResult["stage"];
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
  readonly orderTrace: StrictExecutionOrderPlanReady | null;
  readonly runtimeIdentity?: ObservedRuntimeIdentity;
}

export type BundleBuildResult =
  | { readonly status: "ok"; readonly value: BundleExecutionArtifacts }
  | {
      readonly status: "failed";
      readonly failure: FailedRolldownAdapterResult;
      readonly bundleManifest: ExecutionManifest | null;
      readonly bundleFiles: readonly CapturedFile[];
      readonly orderTrace: StrictExecutionOrderPlanReady | null;
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
  readonly orderTrace: StrictExecutionOrderPlanReady | null;
  readonly runtimeIdentity: ObservedRuntimeIdentity;
  readonly verdict: CampaignVerdict;
}

export interface CampaignSummary {
  readonly casesRun: number;
  readonly passed: number;
  readonly failed: number;
  readonly exitCode: 0 | 1 | 2;
}

export interface CampaignDependencies {
  readonly generate: typeof generateCase;
  readonly executeCase: (
    generated: GeneratedCase,
    options: CampaignOptions,
  ) => Promise<CampaignCaseResult>;
  readonly writeFailure: (
    result: CampaignCaseResult,
    outDir: string,
    caseIndex: number,
  ) => Promise<string>;
  readonly writeLine: (line: string) => void;
}

export interface ExecuteGeneratedCaseDependencies {
  readonly executeSource: (rendered: RenderedProgram) => Promise<ExecutionOutcome>;
  readonly inspectRuntimeIdentity: typeof inspectRolldownRuntimeIdentity;
  readonly buildBundle: (
    generated: GeneratedCase,
    rendered: RenderedProgram,
    options: CampaignOptions,
  ) => Promise<BundleBuildResult>;
}

const DEFAULT_OPTIONS: CampaignOptions = {
  seed: 1,
  cases: 1,
  rolldownPackage: process.env.ROLLDOWN_PACKAGE ?? "rolldown",
  outDir: "failures",
  continueOnFail: false,
  collectOrderTrace: true,
};

const USAGE =
  "Usage: vp exec node src/main.ts [--seed N] [--cases N] [--rolldown-package SPECIFIER] [--out-dir DIRECTORY] [--continue-on-fail|--stop-on-fail] [--no-order-trace]";

export function parseCliArgs(argv: readonly string[]): CampaignOptions {
  let seed = DEFAULT_OPTIONS.seed;
  let cases = DEFAULT_OPTIONS.cases;
  let rolldownPackage = DEFAULT_OPTIONS.rolldownPackage;
  let outDir = DEFAULT_OPTIONS.outDir;
  let continueOnFail = DEFAULT_OPTIONS.continueOnFail;
  let collectOrderTrace = DEFAULT_OPTIONS.collectOrderTrace;
  let sawContinue = false;
  let sawStop = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--seed":
        seed = parseUint32(readArgumentValue(argv, ++index, argument), argument);
        break;
      case "--cases":
        cases = parsePositiveInteger(readArgumentValue(argv, ++index, argument), argument);
        break;
      case "--rolldown-package":
        rolldownPackage = readNonEmptyValue(argv, ++index, argument);
        break;
      case "--out-dir":
        outDir = readNonEmptyValue(argv, ++index, argument);
        break;
      case "--continue-on-fail":
        sawContinue = true;
        continueOnFail = true;
        break;
      case "--stop-on-fail":
        sawStop = true;
        continueOnFail = false;
        break;
      case "--no-order-trace":
        collectOrderTrace = false;
        break;
      default:
        throw new Error(`Unknown argument: ${String(argument)}`);
    }
  }

  if (sawContinue && sawStop) {
    throw new Error("Choose only one of --continue-on-fail and --stop-on-fail");
  }
  validateSeedRange(seed, cases);

  return { seed, cases, rolldownPackage, outDir, continueOnFail, collectOrderTrace };
}

export async function runCampaign(
  options: CampaignOptions,
  overrides: Partial<CampaignDependencies> = {},
): Promise<CampaignSummary> {
  validateSeedRange(options.seed, options.cases);
  return await withCampaignEnvironmentLock(async () => {
    const previousTraceValue = process.env.ROLLDOWN_STRICT_ORDER_TRACE;
    if (options.collectOrderTrace) {
      process.env.ROLLDOWN_STRICT_ORDER_TRACE = "1";
    } else {
      delete process.env.ROLLDOWN_STRICT_ORDER_TRACE;
    }
    try {
      return await runCampaignCases(options, overrides);
    } finally {
      if (previousTraceValue === undefined) {
        delete process.env.ROLLDOWN_STRICT_ORDER_TRACE;
      } else {
        process.env.ROLLDOWN_STRICT_ORDER_TRACE = previousTraceValue;
      }
    }
  });
}

async function withCampaignEnvironmentLock<T>(callback: () => Promise<T>): Promise<T> {
  const previous = campaignEnvironmentLock;
  let release!: () => void;
  campaignEnvironmentLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

async function runCampaignCases(
  options: CampaignOptions,
  overrides: Partial<CampaignDependencies>,
): Promise<CampaignSummary> {
  const dependencies: CampaignDependencies = {
    generate: generateCase,
    executeCase: executeGeneratedCase,
    writeFailure: writeFailureArtifacts,
    writeLine: (line) => {
      process.stdout.write(`${line}\n`);
    },
    ...overrides,
  };
  let passed = 0;
  let failed = 0;
  let casesRun = 0;
  let sawHarnessFailure = false;

  for (let caseIndex = 0; caseIndex < options.cases; caseIndex += 1) {
    const seed = (options.seed + caseIndex) % UINT32_RANGE;
    const generated = dependencies.generate(seed, DEFAULT_CASE_SIZE);
    const result = await dependencies.executeCase(generated, options);
    const didPass = result.verdict.kind === "pass";
    let artifactDirectory: string | undefined;

    casesRun += 1;
    if (didPass) {
      passed += 1;
    } else {
      failed += 1;
      sawHarnessFailure ||= isHarnessFailure(result);
      artifactDirectory = await dependencies.writeFailure(result, options.outDir, caseIndex);
    }

    dependencies.writeLine(formatCaseResult(caseIndex, result, artifactDirectory));
    if (!didPass && !options.continueOnFail) {
      break;
    }
  }

  dependencies.writeLine(`summary cases=${casesRun} pass=${passed} fail=${failed}`);
  return {
    casesRun,
    passed,
    failed,
    exitCode: failed === 0 ? 0 : sawHarnessFailure ? 2 : 1,
  };
}

export async function executeGeneratedCase(
  generated: GeneratedCase,
  options: CampaignOptions,
  overrides: Partial<ExecuteGeneratedCaseDependencies> = {},
): Promise<CampaignCaseResult> {
  const dependencies: ExecuteGeneratedCaseDependencies = {
    executeSource: executeRenderedSource,
    inspectRuntimeIdentity: inspectRolldownRuntimeIdentity,
    buildBundle: buildAndExecuteBundle,
    ...overrides,
  };
  const rendered = renderProgram(generated.program);
  const sourceOutcome = await dependencies.executeSource(rendered);
  if (sourceOutcome.status === "timeout" || sourceOutcome.status === "harness-error") {
    const runtimeIdentity = await dependencies.inspectRuntimeIdentity(options.rolldownPackage);
    const bundleOutcome = {
      status: "not-run",
      reason: "source-invalid",
    } as const satisfies SourceInvalidBundleOutcome;
    return {
      generated,
      options,
      rendered,
      sourceOutcome,
      bundleOutcome,
      bundleManifest: null,
      bundleFiles: [],
      orderTrace: null,
      runtimeIdentity,
      verdict: classifyCampaignVerdict(sourceOutcome, bundleOutcome),
    };
  }

  const built = await dependencies.buildBundle(generated, rendered, options);

  if (built.status === "failed") {
    const runtimeIdentity =
      built.runtimeIdentity ?? (await dependencies.inspectRuntimeIdentity(options.rolldownPackage));
    const bundleOutcome = {
      status: "not-run",
      reason: "adapter-failure",
      adapterFailure: built.failure,
    } as const satisfies AdapterFailureBundleOutcome;
    return {
      generated,
      options,
      rendered,
      sourceOutcome,
      bundleOutcome,
      bundleManifest: built.bundleManifest,
      bundleFiles: built.bundleFiles,
      orderTrace: built.orderTrace,
      runtimeIdentity,
      verdict: classifyCampaignVerdict(sourceOutcome, bundleOutcome),
    };
  }

  const runtimeIdentity =
    built.value.runtimeIdentity ??
    (await dependencies.inspectRuntimeIdentity(options.rolldownPackage));
  return {
    generated,
    options,
    rendered,
    sourceOutcome,
    bundleOutcome: built.value.bundleOutcome,
    bundleManifest: built.value.bundleManifest,
    bundleFiles: built.value.bundleFiles,
    orderTrace: built.value.orderTrace,
    runtimeIdentity,
    verdict: classifyCampaignVerdict(sourceOutcome, built.value.bundleOutcome),
  };
}

export function classifyCampaignVerdict(
  sourceOutcome: ExecutionOutcome,
  bundleOutcome: CampaignBundleOutcome,
): CampaignVerdict {
  if (sourceOutcome.status === "harness-error" || sourceOutcome.status === "timeout") {
    return classifyVerdict(sourceOutcome, {
      version: 1,
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

export async function writeFailureArtifacts(
  result: CampaignCaseResult,
  outDir: string,
  caseIndex: number,
): Promise<string> {
  const identity = createFailureArtifactIdentity(result, caseIndex);
  const artifactName = failureArtifactName(result, caseIndex, identity.hash);
  const artifactDirectory = join(outDir, artifactName);
  await mkdir(outDir, { recursive: true });
  if (await pathExists(artifactDirectory)) {
    await requireCompleteExistingArtifact(artifactDirectory, result, identity);
    return artifactDirectory;
  }

  const stagingDirectory = await mkdtemp(join(outDir, `.${artifactName}.tmp-`));
  await writeArtifactDirectory(result, stagingDirectory, caseIndex, identity);

  if (await pathExists(artifactDirectory)) {
    await rm(stagingDirectory, { recursive: true, force: true });
    await requireCompleteExistingArtifact(artifactDirectory, result, identity);
    return artifactDirectory;
  }

  try {
    await rename(stagingDirectory, artifactDirectory);
  } catch (error) {
    if (!(await pathExists(artifactDirectory))) {
      throw error;
    }
    await rm(stagingDirectory, { recursive: true, force: true });
    await requireCompleteExistingArtifact(artifactDirectory, result, identity);
  }

  return artifactDirectory;
}

async function requireCompleteExistingArtifact(
  artifactDirectory: string,
  result: CampaignCaseResult,
  identity: FailureArtifactIdentity,
): Promise<void> {
  const invalid = new Error(
    `Existing failure artifact is incomplete or has a different identity: ${artifactDirectory}`,
  );
  try {
    const rootMetadata = await lstat(artifactDirectory);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw invalid;
    }
  } catch {
    throw invalid;
  }
  const expectedFiles = createArtifactFiles(result, caseIndexFromIdentity(identity), identity);
  const expectedFilePaths = expectedFiles.map((file) => file.path).sort();
  const expectedDirectoryPaths = [
    ...new Set(
      expectedFilePaths.flatMap((path) => {
        const directories: string[] = [];
        let directory = dirname(path);
        while (directory !== ".") {
          directories.push(directory);
          directory = dirname(directory);
        }
        return directories;
      }),
    ),
  ].sort();
  const actualTree = await inspectArtifactTree(artifactDirectory).catch(() => null);
  if (
    actualTree === null ||
    actualTree.hasInvalidEntry ||
    actualTree.files.join("\0") !== expectedFilePaths.join("\0") ||
    actualTree.directories.join("\0") !== expectedDirectoryPaths.join("\0")
  ) {
    throw invalid;
  }

  for (const file of expectedFiles) {
    try {
      if (!(await lstat(join(artifactDirectory, file.path))).isFile()) {
        throw invalid;
      }
      const persisted = await readFile(join(artifactDirectory, file.path));
      if (!persisted.equals(Buffer.from(file.contents))) {
        throw invalid;
      }
    } catch {
      throw invalid;
    }
  }
}

async function inspectArtifactTree(root: string): Promise<{
  readonly files: string[];
  readonly directories: string[];
  readonly hasInvalidEntry: boolean;
}> {
  const files: string[] = [];
  const directories: string[] = [];
  const pending = [{ directory: root, relativePath: "" }];
  let hasInvalidEntry = false;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    const entries = await readdir(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath =
        current.relativePath.length === 0 ? entry.name : `${current.relativePath}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        hasInvalidEntry = true;
      } else if (entry.isDirectory()) {
        directories.push(relativePath);
        pending.push({
          directory: join(current.directory, entry.name),
          relativePath,
        });
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        hasInvalidEntry = true;
      }
    }
  }
  files.sort();
  directories.sort();
  return { files, directories, hasInvalidEntry };
}

function caseIndexFromIdentity(identity: FailureArtifactIdentity): number {
  return identity.inputs.case.index;
}

export function failureArtifactPath(
  result: CampaignCaseResult,
  outDir: string,
  caseIndex: number,
): string {
  const identity = createFailureArtifactIdentity(result, caseIndex);
  return join(outDir, failureArtifactName(result, caseIndex, identity.hash));
}

interface FailureArtifactIdentity {
  readonly hash: string;
  readonly inputs: {
    readonly schemaVersion: typeof FAILURE_ARTIFACT_SCHEMA_VERSION;
    readonly protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
    readonly case: {
      readonly index: number;
      readonly seed: number;
      readonly size: number;
      readonly template: GeneratedCase["template"];
      readonly coverageTags: readonly string[];
      readonly model: GeneratedCase["program"];
    };
    readonly rolldownPackage: string;
    readonly configuredCliOptions: CampaignOptions;
    readonly replayOptions: ReturnType<typeof createReplayMetadata>["options"];
    readonly runtimeIdentity: ObservedRuntimeIdentity;
    readonly buildOptions: typeof ROLLDOWN_BUILD_OPTIONS & {
      readonly codeSplitting:
        | true
        | { readonly groups: NonNullable<GeneratedCase["program"]["manualChunkGroups"]> };
    };
    readonly sourceOutcome: ExecutionOutcome;
    readonly bundleOutcome: CampaignBundleOutcome;
    readonly verdict: CampaignVerdict;
    readonly verdictSignature: string;
    readonly canonicalOrderTrace: StrictExecutionOrderPlanReady | null;
    readonly finalEventGraph: StrictExecutionOrderEventGraph | null;
    readonly renderedSourceFiles: readonly {
      readonly path: string;
      readonly sha256: string;
    }[];
    readonly sourceManifest: {
      readonly path: string;
      readonly sha256: string;
      readonly value: ExecutionManifest;
    };
    readonly bundleManifest: {
      readonly path: string;
      readonly sha256: string;
      readonly value: ExecutionManifest | null;
    };
    readonly bundleFiles: readonly {
      readonly path: string;
      readonly sha256: string;
    }[];
  };
}

function createFailureArtifactIdentity(
  result: CampaignCaseResult,
  caseIndex: number,
): FailureArtifactIdentity {
  const replay = createReplayMetadata(result);
  const inputs: FailureArtifactIdentity["inputs"] = {
    schemaVersion: FAILURE_ARTIFACT_SCHEMA_VERSION,
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    case: {
      index: caseIndex,
      seed: result.generated.seed,
      size: result.generated.size,
      template: result.generated.template,
      coverageTags: result.generated.coverageTags,
      model: result.generated.program,
    },
    rolldownPackage: result.options.rolldownPackage,
    configuredCliOptions: { ...result.options },
    replayOptions: replay.options,
    runtimeIdentity: result.runtimeIdentity,
    buildOptions: {
      ...ROLLDOWN_BUILD_OPTIONS,
      codeSplitting:
        result.generated.program.manualChunkGroups === undefined
          ? true
          : { groups: result.generated.program.manualChunkGroups },
    },
    sourceOutcome: result.sourceOutcome,
    bundleOutcome: normalizeBundleOutcomeForIdentity(result.bundleOutcome),
    verdict: result.verdict,
    verdictSignature: result.verdict.signature,
    canonicalOrderTrace: result.orderTrace,
    finalEventGraph:
      result.orderTrace === null
        ? null
        : reconstructStrictExecutionOrderEventGraph(result.orderTrace),
    renderedSourceFiles: result.rendered.files
      .map((file) => ({
        path: file.path,
        sha256: hashPathAndContents(file.path, Buffer.from(file.contents, "utf8")),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    sourceManifest: hashManifest(result.rendered.schedulePath, result.rendered.schedule),
    bundleManifest: hashManifest(result.rendered.schedulePath, result.bundleManifest),
    bundleFiles: result.bundleFiles
      .map((file) => ({
        path: file.path,
        sha256: hashPathAndContents(file.path, file.contents),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  return {
    hash: createHash("sha256").update(canonicalJsonStringify(inputs)).digest("hex"),
    inputs,
  };
}

function hashPathAndContents(path: string, contents: Uint8Array): string {
  return createHash("sha256").update(path).update(Uint8Array.of(0)).update(contents).digest("hex");
}

function hashManifest<T extends ExecutionManifest | null>(
  path: string,
  value: T,
): { readonly path: string; readonly sha256: string; readonly value: T } {
  return {
    path,
    sha256: hashPathAndContents(path, Buffer.from(canonicalJsonStringify(value), "utf8")),
    value,
  };
}

function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalizeJsonValue(record[key])]),
  );
}

function failureArtifactName(result: CampaignCaseResult, caseIndex: number, hash: string): string {
  return `case-${String(caseIndex).padStart(4, "0")}-seed-${result.generated.seed}-${hash}`;
}

async function writeArtifactDirectory(
  result: CampaignCaseResult,
  artifactDirectory: string,
  caseIndex: number,
  identity: FailureArtifactIdentity,
): Promise<void> {
  await Promise.all(
    createArtifactFiles(result, caseIndex, identity).map(async (file) => {
      const path = join(artifactDirectory, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.contents);
    }),
  );
}

function createArtifactFiles(
  result: CampaignCaseResult,
  caseIndex: number,
  identity: FailureArtifactIdentity,
): CapturedFile[] {
  const jsonFile = (path: string, value: unknown): CapturedFile => ({
    path,
    contents: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
  });
  return [
    jsonFile("model.json", result.generated.program),
    jsonFile("case.json", {
      artifactSchemaVersion: FAILURE_ARTIFACT_SCHEMA_VERSION,
      executionProtocolVersion: EXECUTION_PROTOCOL_VERSION,
      artifactIdentity: identity.hash,
      caseIndex,
      seed: result.generated.seed,
      size: result.generated.size,
      template: result.generated.template,
      coverageTags: result.generated.coverageTags,
      rolldownPackage: result.options.rolldownPackage,
      runtimeIdentity: result.runtimeIdentity,
      renderedSourceFiles: identity.inputs.renderedSourceFiles,
      sourceManifest: {
        path: identity.inputs.sourceManifest.path,
        sha256: identity.inputs.sourceManifest.sha256,
      },
      bundleManifest: {
        path: identity.inputs.bundleManifest.path,
        sha256: identity.inputs.bundleManifest.sha256,
        isNull: identity.inputs.bundleManifest.value === null,
      },
    }),
    jsonFile("identity.json", identity),
    jsonFile("replay.json", createReplayMetadata(result)),
    jsonFile("source-manifest.json", result.rendered.schedule),
    jsonFile("bundle-manifest.json", result.bundleManifest),
    jsonFile("source-outcome.json", result.sourceOutcome),
    jsonFile("bundle-outcome.json", identity.inputs.bundleOutcome),
    jsonFile("order-trace.json", result.orderTrace),
    jsonFile("order-event-graph.json", identity.inputs.finalEventGraph),
    jsonFile("verdict.json", result.verdict),
    { path: "signature.txt", contents: Buffer.from(`${result.verdict.signature}\n`, "utf8") },
    ...result.rendered.files.map((file) => ({
      path: `source/${file.path}`,
      contents: Buffer.from(file.contents, "utf8"),
    })),
    ...result.bundleFiles.map((file) => ({
      path: `bundle/${file.path}`,
      contents: file.contents,
    })),
  ];
}

async function pathExists(path: string): Promise<boolean> {
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

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: CampaignOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n${USAGE}\n`);
    return 2;
  }

  try {
    const summary = await runCampaign(options);
    return summary.exitCode;
  } catch (error) {
    process.stderr.write(`Campaign failed: ${errorMessage(error)}\n`);
    return 2;
  }
}

async function executeRenderedSource(rendered: RenderedProgram): Promise<ExecutionOutcome> {
  const sourceDirectory = await mkdtemp(join(tmpdir(), "rolldown-order-source-"));
  try {
    for (const file of rendered.files) {
      const path = join(sourceDirectory, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.contents);
    }
    return await executeManifest(join(sourceDirectory, rendered.schedulePath));
  } finally {
    await rm(sourceDirectory, { recursive: true, force: true });
  }
}

async function buildAndExecuteBundle(
  generated: GeneratedCase,
  rendered: RenderedProgram,
  options: CampaignOptions,
): Promise<BundleBuildResult> {
  let failureArtifacts: Pick<
    CampaignCaseResult,
    "bundleManifest" | "bundleFiles" | "orderTrace"
  > & { readonly runtimeIdentity?: ObservedRuntimeIdentity } = {
    bundleManifest: null,
    bundleFiles: [],
    orderTrace: null,
  };
  const built = await withRolldownBuild(
    generated.program,
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
      orderTrace: artifacts.orderTrace,
      runtimeIdentity: artifacts.runtimeIdentity,
    }),
    {
      packageSpecifier: options.rolldownPackage,
      collectOrderTrace: options.collectOrderTrace,
      onFailureArtifacts: async (_failure, artifacts) => {
        failureArtifacts = {
          bundleManifest: artifacts.manifest ?? null,
          bundleFiles: await captureBundleFiles(
            artifacts.bundleDirectory,
            new Set(["package.json", rendered.schedulePath]),
          ),
          orderTrace: artifacts.orderTrace,
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
  return {
    kind: "build-failure",
    reason: failure.stage,
    signature: `build-failure:${failure.status}:${failure.stage}:${JSON.stringify([
      failure.error.name,
      normalizeBuildFailureMessage(failure.error.message),
    ])}`,
  };
}

function normalizeBundleOutcomeForIdentity(outcome: CampaignBundleOutcome): CampaignBundleOutcome {
  if (outcome.status !== "not-run" || outcome.reason !== "adapter-failure") {
    return outcome;
  }
  return {
    ...outcome,
    adapterFailure: {
      ...outcome.adapterFailure,
      error: {
        ...outcome.adapterFailure.error,
        message: normalizeBuildFailureMessage(outcome.adapterFailure.error.message),
      },
    },
  };
}

function normalizeBuildFailureMessage(message: string): string {
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

function isHarnessFailure(result: CampaignCaseResult): boolean {
  return (
    result.verdict.kind === "invalid-harness" ||
    (result.bundleOutcome.status === "not-run" &&
      result.bundleOutcome.reason === "adapter-failure" &&
      result.bundleOutcome.adapterFailure.status === "harness-error")
  );
}

function createReplayMetadata(result: CampaignCaseResult): {
  readonly command: readonly string[];
  readonly options: CampaignOptions & { readonly size: number };
  readonly runtimeIdentity: ObservedRuntimeIdentity;
} {
  const options = {
    seed: result.generated.seed,
    size: result.generated.size,
    cases: 1,
    rolldownPackage: result.options.rolldownPackage,
    outDir: result.options.outDir,
    continueOnFail: false,
    collectOrderTrace: result.options.collectOrderTrace,
  };
  return {
    command: [
      "vp",
      "exec",
      "node",
      "src/main.ts",
      "--seed",
      String(options.seed),
      "--cases",
      "1",
      "--rolldown-package",
      options.rolldownPackage,
      "--out-dir",
      options.outDir,
      ...(options.collectOrderTrace ? [] : ["--no-order-trace"]),
      "--stop-on-fail",
    ],
    options,
    runtimeIdentity: result.runtimeIdentity,
  };
}

function formatCaseResult(
  caseIndex: number,
  result: CampaignCaseResult,
  artifactDirectory: string | undefined,
): string {
  const status = result.verdict.kind === "pass" ? "PASS" : "FAIL";
  const fields = [
    status,
    `case=${caseIndex}`,
    `seed=${result.generated.seed}`,
    `template=${result.generated.template}`,
    `tags=${result.generated.coverageTags.join(",")}`,
    `signature=${result.verdict.signature}`,
  ];
  if (result.orderTrace !== null) {
    fields.push(`wraps=${result.orderTrace.plan_modules.length}`);
  }
  if (artifactDirectory !== undefined) {
    fields.push(`artifact=${artifactDirectory}`);
  }
  return fields.join(" ");
}

function readArgumentValue(argv: readonly string[], index: number, argument: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${argument}`);
  }
  return value;
}

function readNonEmptyValue(argv: readonly string[], index: number, argument: string): string {
  const value = readArgumentValue(argv, index, argument);
  if (value.length === 0) {
    throw new Error(`${argument} must not be empty`);
  }
  return value;
}

function parseUint32(value: string, argument: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${argument} must be an unsigned 32-bit integer`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= UINT32_RANGE) {
    throw new Error(`${argument} must be an unsigned 32-bit integer`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, argument: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${argument} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${argument} must be a positive integer`);
  }
  return parsed;
}

function validateSeedRange(seed: number, cases: number): void {
  if (!Number.isSafeInteger(seed + cases - 1)) {
    throw new Error("--seed and --cases must define a safe integer range");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
