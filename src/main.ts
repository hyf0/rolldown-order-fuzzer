/// <reference types="node" />

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FORMAT_REGIMES,
  generateCase,
  MAX_CASE_SIZE,
  sampleCaseSize,
  type FormatRegime,
  type GeneratedCase,
} from "./generate.ts";
import { buildConfigOf, programChunking, type BuildConfig } from "./model.ts";
import {
  DEFAULT_CASE_SIZE,
  executeGeneratedCase,
  normalizeBuildFailureMessage,
  pathExists,
  type CampaignBundleOutcome,
  type CampaignCaseResult,
  type CampaignOptions,
  type CampaignVerdict,
  type CapturedFile,
} from "./program-run.ts";
import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionManifest,
  type ExecutionOutcome,
} from "./protocol.ts";
import { ROLLDOWN_BUILD_OPTIONS, type ObservedRuntimeIdentity } from "./rolldown-adapter.ts";
import { SeededRng } from "./rng.ts";

// The one-program execution + verdict layer lives in program-run.ts; re-exported here so existing
// importers (the CLI test) keep a stable surface while the definitions sit below this campaign/CLI layer.
export {
  classifyCampaignVerdict,
  DEFAULT_CASE_SIZE,
  executeGeneratedCase,
  type BundleNotRunOutcome,
  type CampaignCaseResult,
  type CampaignOptions,
} from "./program-run.ts";

const UINT32_RANGE = 0x1_0000_0000;

// 16: wave 7 — inferred-pure definers, function-hidden and computed-member reads in the model (the
// two real-app bug families A/B), and the shrinker's failing wrap-mode carried in the artifact.
// 15: wave 6 — organic (size/share-driven) chunk groups in the model, the raised size ceiling with a
// per-campaign size mix, and denser/nested dynamic imports.
// 14: wave 5 — schedule-phase marker events in execution outcomes, and multiple dependency kinds
// per (importer, target) pair in the model.
export const FAILURE_ARTIFACT_SCHEMA_VERSION = 17 as const;

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

const DEFAULT_OPTIONS: CampaignOptions = {
  seed: 1,
  cases: 1,
  caseSize: DEFAULT_CASE_SIZE,
  sizeMix: true,
  onDemandWrapping: true,
  rolldownPackage: process.env.ROLLDOWN_PACKAGE ?? "rolldown",
  outDir: "failures",
  continueOnFail: false,
};

const USAGE =
  "Usage: vp exec node src/main.ts [--seed N] [--cases N] [--case-size N] [--wrap-all] [--format-regime mixed|pure-esm|pure-cjs] [--rolldown-package SPECIFIER] [--out-dir DIRECTORY] [--continue-on-fail|--stop-on-fail]\n" +
  "When --case-size is omitted, each case draws a size from a small/medium/large spread (up to 48).";

export function parseCliArgs(argv: readonly string[]): CampaignOptions {
  let seed = DEFAULT_OPTIONS.seed;
  let cases = DEFAULT_OPTIONS.cases;
  let caseSize = DEFAULT_OPTIONS.caseSize;
  let sizeMix = DEFAULT_OPTIONS.sizeMix;
  let onDemandWrapping = DEFAULT_OPTIONS.onDemandWrapping;
  let formatRegime: FormatRegime | undefined;
  let rolldownPackage = DEFAULT_OPTIONS.rolldownPackage;
  let outDir = DEFAULT_OPTIONS.outDir;
  let continueOnFail = DEFAULT_OPTIONS.continueOnFail;
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
      case "--case-size":
        // An explicit size pins every case to it and turns the campaign size mix OFF.
        caseSize = parseCaseSize(readArgumentValue(argv, ++index, argument), argument);
        sizeMix = false;
        break;
      case "--wrap-all":
        onDemandWrapping = false;
        break;
      case "--format-regime": {
        const value = readNonEmptyValue(argv, ++index, argument);
        if (!(FORMAT_REGIMES as readonly string[]).includes(value)) {
          throw new Error(`--format-regime must be one of ${FORMAT_REGIMES.join(", ")}`);
        }
        formatRegime = value as FormatRegime;
        break;
      }
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
      default:
        throw new Error(`Unknown argument: ${String(argument)}`);
    }
  }

  if (sawContinue && sawStop) {
    throw new Error("Choose only one of --continue-on-fail and --stop-on-fail");
  }
  validateSeedRange(seed, cases);

  return {
    seed,
    cases,
    caseSize,
    sizeMix,
    onDemandWrapping,
    ...(formatRegime === undefined ? {} : { formatRegime }),
    rolldownPackage,
    outDir,
    continueOnFail,
  };
}

export async function runCampaign(
  options: CampaignOptions,
  overrides: Partial<CampaignDependencies> = {},
): Promise<CampaignSummary> {
  validateSeedRange(options.seed, options.cases);
  return await runCampaignCases(options, overrides);
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
    // With the size mix on, each case draws its size deterministically from the seed (a separate RNG
    // instance from the generator's, both seeded by `seed`, so the draw and generation stay
    // independent and reproducible). The drawn size is recorded on the case for exact replay.
    const caseSize = options.sizeMix ? sampleCaseSize(new SeededRng(seed)) : options.caseSize;
    const generated = dependencies.generate(seed, caseSize, options.formatRegime);
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
      // The persisted BuildConfig axes (W14a): a different config yields a distinct failure artifact.
      // These override the hardcoded `ROLLDOWN_BUILD_OPTIONS` values they were moved out of.
      readonly preserveEntrySignatures: BuildConfig["preserveEntrySignatures"];
      readonly strictExecutionOrder: boolean;
      readonly includeDependenciesRecursively: boolean;
      readonly lazyBarrel: boolean;
      readonly codeSplitting:
        | true
        | { readonly groups: NonNullable<GeneratedCase["program"]["manualChunkGroups"]> }
        | {
            readonly organicGroups: NonNullable<GeneratedCase["program"]["organicChunkGroups"]>;
          };
    };
    readonly sourceOutcome: ExecutionOutcome;
    readonly bundleOutcome: CampaignBundleOutcome;
    readonly verdict: CampaignVerdict;
    readonly verdictSignature: string;
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
  const buildConfig = buildConfigOf(result.generated.program);
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
      preserveEntrySignatures: buildConfig.preserveEntrySignatures,
      strictExecutionOrder: buildConfig.strictExecutionOrder,
      includeDependenciesRecursively: buildConfig.includeDependenciesRecursively,
      lazyBarrel: buildConfig.lazyBarrel,
      codeSplitting: effectiveCodeSplitting(result.generated.program),
    },
    sourceOutcome: result.sourceOutcome,
    bundleOutcome: normalizeBundleOutcomeForIdentity(result.bundleOutcome),
    verdict: result.verdict,
    verdictSignature: result.verdict.signature,
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

/// The effective `codeSplitting` descriptor a case builds with, recorded in the artifact identity so
/// a different chunking config (default / explicit / organic) yields a distinct artifact. Driven by
/// the single `programChunking` matcher, so an EMPTY manual/organic array records `true` (automatic) —
/// matching what the build child actually does — instead of the old `{ groups: [] }` that made the
/// recorded identity diverge from the build.
function effectiveCodeSplitting(
  program: GeneratedCase["program"],
): FailureArtifactIdentity["inputs"]["buildOptions"]["codeSplitting"] {
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
  readonly options: CampaignOptions;
  readonly runtimeIdentity: ObservedRuntimeIdentity;
} {
  const options = {
    seed: result.generated.seed,
    cases: 1,
    caseSize: result.generated.size,
    // Replay pins the exact recorded size, so the size mix is off (the command passes --case-size).
    sizeMix: false,
    onDemandWrapping: result.options.onDemandWrapping,
    ...(result.options.formatRegime === undefined
      ? {}
      : { formatRegime: result.options.formatRegime }),
    rolldownPackage: result.options.rolldownPackage,
    outDir: result.options.outDir,
    continueOnFail: false,
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
      "--case-size",
      String(options.caseSize),
      ...(options.onDemandWrapping ? [] : ["--wrap-all"]),
      ...("formatRegime" in options && options.formatRegime !== undefined
        ? ["--format-regime", options.formatRegime]
        : []),
      "--rolldown-package",
      options.rolldownPackage,
      "--out-dir",
      options.outDir,
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

function parseCaseSize(value: string, argument: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CASE_SIZE) {
    throw new Error(`${argument} must be an integer from 1 through ${MAX_CASE_SIZE}`);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
