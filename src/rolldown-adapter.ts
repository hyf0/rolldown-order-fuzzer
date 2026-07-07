/// <reference types="node" />

import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  CodeSplittingGroup,
  InputOptions,
  OutputChunk,
  OutputOptions,
  RolldownBuild,
  RolldownOutput,
} from "rolldown";

import type { ProgramModel, ScheduleOperation } from "./model.ts";
import {
  canonicalizeStrictExecutionOrderModuleIds,
  parseStrictExecutionOrderLogs,
  type StrictExecutionOrderPlanReady,
} from "./order-trace.ts";
import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionManifest,
  type NormalizedError,
} from "./protocol.ts";
import type { RenderedProgram } from "./render.ts";

const BUNDLE_PACKAGE_JSON = '{\n  "type": "module"\n}\n';
const DEVTOOLS_SESSION_ID_ALLOCATION_ATTEMPTS = 64;
let nextDevtoolsSession = 0;

export const ROLLDOWN_BUILD_OPTIONS = {
  preserveEntrySignatures: "allow-extension",
  format: "esm",
  strictExecutionOrder: true,
  entryFileNames: "entries/[name].js",
  chunkFileNames: "chunks/[name].js",
  assetFileNames: "assets/[name][extname]",
  cleanDir: false,
  minify: false,
} as const;

export interface RolldownAdapterOptions {
  readonly packageSpecifier?: string;
  readonly collectOrderTrace?: boolean;
  readonly onFailureArtifacts?: (
    failure: FailedRolldownAdapterResult,
    artifacts: RolldownFailureArtifacts,
  ) => void | Promise<void>;
}

export interface RolldownFailureArtifacts {
  readonly temporaryDirectory: string;
  readonly sourceDirectory: string;
  readonly bundleDirectory: string;
  readonly sourceManifestPath: string;
  readonly bundleManifestPath: string;
  readonly manifest?: ExecutionManifest;
  readonly orderTrace: StrictExecutionOrderPlanReady | null;
}

export interface RolldownBuildArtifacts {
  readonly temporaryDirectory: string;
  readonly sourceDirectory: string;
  readonly bundleDirectory: string;
  readonly sourceManifestPath: string;
  readonly bundleManifestPath: string;
  readonly manifest: ExecutionManifest;
  readonly outputFiles: readonly string[];
  readonly orderTrace: StrictExecutionOrderPlanReady | null;
}

export interface SuccessfulRolldownAdapterResult<T> {
  readonly status: "ok";
  readonly value: T;
}

export interface FailedRolldownAdapterResult {
  readonly status: "harness-error" | "build-error";
  readonly stage:
    | "materialize-source"
    | "load-package"
    | "build"
    | "collect-order-trace"
    | "write-manifest";
  readonly packageSpecifier: string;
  readonly error: NormalizedError;
}

export type RolldownAdapterResult<T> =
  | SuccessfulRolldownAdapterResult<T>
  | FailedRolldownAdapterResult;

export async function withRolldownBuild<T>(
  program: ProgramModel,
  rendered: RenderedProgram,
  callback: (artifacts: RolldownBuildArtifacts) => T | Promise<T>,
  options: RolldownAdapterOptions = {},
): Promise<RolldownAdapterResult<T>> {
  const packageSpecifier = options.packageSpecifier ?? process.env.ROLLDOWN_PACKAGE ?? "rolldown";
  const collectOrderTrace = options.collectOrderTrace ?? true;
  const devtoolsRootDirectory = join(process.cwd(), "node_modules", ".rolldown");
  const devtoolsSessionDirectoriesToClean = new Set<string>();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "rolldown-order-fuzzer-"));
  const sourceDirectory = join(temporaryDirectory, "source");
  const bundleDirectory = join(temporaryDirectory, "bundle");
  const sourceManifestPath = join(sourceDirectory, rendered.schedulePath);
  const bundleManifestPath = join(bundleDirectory, rendered.schedulePath);
  const entryInputNames = createEntryInputNames(program);
  let canonicalSourceDirectory: string;
  let manifest: ExecutionManifest | undefined;
  let orderTrace: StrictExecutionOrderPlanReady | null = null;

  const reportFailure = async (
    failureResult: FailedRolldownAdapterResult,
  ): Promise<FailedRolldownAdapterResult> => {
    await options.onFailureArtifacts?.(failureResult, {
      temporaryDirectory,
      sourceDirectory,
      bundleDirectory,
      sourceManifestPath,
      bundleManifestPath,
      orderTrace,
      ...(manifest === undefined ? {} : { manifest }),
    });
    return failureResult;
  };

  try {
    try {
      await materializeRenderedProgram(rendered, sourceDirectory);
      await mkdir(bundleDirectory, { recursive: true });
      await writeFile(join(bundleDirectory, "package.json"), BUNDLE_PACKAGE_JSON);
      canonicalSourceDirectory = await realpath(sourceDirectory);
    } catch (error) {
      return await reportFailure(
        failure("harness-error", "materialize-source", packageSpecifier, error),
      );
    }

    const loaded = await loadRolldown(packageSpecifier);
    if (loaded.status !== "ok") {
      return await reportFailure(loaded);
    }

    const built = await buildWithRolldown(
      loaded.rolldown,
      program,
      rendered,
      entryInputNames,
      canonicalSourceDirectory,
      bundleDirectory,
      packageSpecifier,
      collectOrderTrace,
      devtoolsRootDirectory,
      devtoolsSessionDirectoriesToClean,
    );
    orderTrace = built.orderTrace;
    if (built.status === "failed") {
      return await reportFailure(built.failure);
    }

    try {
      manifest = createBundleManifest(
        program,
        rendered,
        entryInputNames,
        canonicalSourceDirectory,
        built.output,
      );
    } catch (error) {
      return await reportFailure(failure("build-error", "build", packageSpecifier, error));
    }
    try {
      await mkdir(dirname(bundleManifestPath), { recursive: true });
      await writeFile(bundleManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (error) {
      return await reportFailure(
        failure("harness-error", "write-manifest", packageSpecifier, error),
      );
    }

    return {
      status: "ok",
      value: await callback({
        temporaryDirectory,
        sourceDirectory,
        bundleDirectory,
        sourceManifestPath,
        bundleManifestPath,
        manifest,
        outputFiles: built.output.output.map((output) => output.fileName).sort(),
        orderTrace,
      }),
    };
  } finally {
    await Promise.all([
      rm(temporaryDirectory, { recursive: true, force: true }),
      ...[...devtoolsSessionDirectoriesToClean].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    ]);
  }
}

type RolldownFunction = (inputOptions: InputOptions) => Promise<RolldownBuild>;

interface LoadedRolldown {
  readonly status: "ok";
  readonly rolldown: RolldownFunction;
}

interface BuiltRolldown {
  readonly status: "ok";
  readonly output: RolldownOutput;
  readonly orderTrace: StrictExecutionOrderPlanReady | null;
}

interface FailedRolldownBuild {
  readonly status: "failed";
  readonly failure: FailedRolldownAdapterResult;
  readonly orderTrace: StrictExecutionOrderPlanReady | null;
}

async function materializeRenderedProgram(
  rendered: RenderedProgram,
  sourceDirectory: string,
): Promise<void> {
  await mkdir(sourceDirectory, { recursive: true });
  for (const file of rendered.files) {
    const filePath = join(sourceDirectory, file.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.contents);
  }
}

async function loadRolldown(
  packageSpecifier: string,
): Promise<LoadedRolldown | FailedRolldownAdapterResult> {
  let loaded: unknown;
  try {
    loaded = await import(packageSpecifier);
  } catch (error) {
    return failure("harness-error", "load-package", packageSpecifier, error);
  }

  if (!isRecord(loaded) || typeof loaded.rolldown !== "function") {
    return failure(
      "harness-error",
      "load-package",
      packageSpecifier,
      new TypeError(`Rolldown package ${JSON.stringify(packageSpecifier)} has no rolldown export`),
    );
  }

  return {
    status: "ok",
    rolldown: loaded.rolldown as RolldownFunction,
  };
}

async function buildWithRolldown(
  rolldown: RolldownFunction,
  program: ProgramModel,
  rendered: RenderedProgram,
  entryInputNames: ReadonlyMap<string, string>,
  sourceDirectory: string,
  bundleDirectory: string,
  packageSpecifier: string,
  collectOrderTrace: boolean,
  devtoolsRootDirectory: string,
  devtoolsSessionDirectoriesToClean: Set<string>,
): Promise<BuiltRolldown | FailedRolldownBuild> {
  let bundle: RolldownBuild | undefined;
  let output: RolldownOutput | undefined;
  let buildError: unknown;
  let traceSetupError: unknown;
  let rolldownInvoked = false;
  let orderTrace: StrictExecutionOrderPlanReady | null = null;
  let devtoolsSessionId: string | null = null;
  let preexistingDevtoolsSessions = new Set<string>();
  const inputOptions: InputOptions = {
    input: Object.fromEntries(
      program.entries.map((entry) => [
        requiredEntryInputName(entryInputNames, entry.name),
        resolve(sourceDirectory, requiredPath(rendered.entryPaths, entry.name, "entry")),
      ]),
    ),
    preserveEntrySignatures: ROLLDOWN_BUILD_OPTIONS.preserveEntrySignatures,
  };

  try {
    if (collectOrderTrace) {
      bundle = await rolldownWithAllocatedDevtoolsSession(
        rolldown,
        inputOptions,
        devtoolsRootDirectory,
        (sessionId, snapshot) => {
          devtoolsSessionId = sessionId;
          preexistingDevtoolsSessions = snapshot;
          rolldownInvoked = true;
        },
      );
    } else {
      rolldownInvoked = true;
      bundle = await rolldown(inputOptions);
    }
    output = await bundle.write(
      createOutputOptions(program, rendered, sourceDirectory, bundleDirectory),
    );
  } catch (error) {
    if (collectOrderTrace && !rolldownInvoked) {
      traceSetupError = error;
    } else {
      buildError = error;
    }
  }

  if (bundle !== undefined) {
    try {
      await bundle.close();
    } catch (error) {
      buildError ??= error;
    }
  }

  if (devtoolsSessionId !== null) {
    try {
      const resolvedSessionDirectory = await resolveDevtoolsSessionDirectory(
        devtoolsRootDirectory,
        preexistingDevtoolsSessions,
        sourceDirectory,
      );
      if (resolvedSessionDirectory !== null) {
        devtoolsSessionDirectoriesToClean.add(resolvedSessionDirectory);
        const parsedOrderTrace = await readOrderTrace(resolvedSessionDirectory);
        orderTrace =
          parsedOrderTrace === null
            ? null
            : canonicalizeStrictExecutionOrderModuleIds(
                parsedOrderTrace,
                createTraceModuleIdCanonicalizer(rendered, sourceDirectory),
              );
      }
    } catch (error) {
      return {
        status: "failed",
        failure: failure("harness-error", "collect-order-trace", packageSpecifier, error),
        orderTrace: null,
      };
    }
  }

  if (traceSetupError !== undefined) {
    return {
      status: "failed",
      failure: failure("harness-error", "collect-order-trace", packageSpecifier, traceSetupError),
      orderTrace: null,
    };
  }
  if (buildError !== undefined) {
    return {
      status: "failed",
      failure: failure("build-error", "build", packageSpecifier, buildError),
      orderTrace,
    };
  }
  if (output === undefined) {
    return {
      status: "failed",
      failure: failure(
        "build-error",
        "build",
        packageSpecifier,
        new Error("Rolldown build completed without output"),
      ),
      orderTrace,
    };
  }

  return { status: "ok", output, orderTrace };
}

async function resolveDevtoolsSessionDirectory(
  devtoolsRootDirectory: string,
  preexistingSessions: ReadonlySet<string>,
  sourceDirectory: string,
): Promise<string | null> {
  const newSessionNames = (await readSessionDirectoryNames(devtoolsRootDirectory)).filter(
    (name) => !preexistingSessions.has(name),
  );
  const matches: string[] = [];
  for (const name of newSessionNames) {
    const directory = join(devtoolsRootDirectory, name);
    if (await sessionMetaBelongsToSource(directory, sourceDirectory)) {
      matches.push(directory);
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

async function sessionMetaBelongsToSource(
  sessionDirectory: string,
  sourceDirectory: string,
): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(join(sessionDirectory, "meta.json"), "utf8");
  } catch {
    return false;
  }

  for (const line of contents.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(value) || value.action !== "SessionMeta" || !Array.isArray(value.inputs)) {
      continue;
    }
    if (
      value.inputs.length > 0 &&
      value.inputs.every(
        (input) =>
          isRecord(input) &&
          typeof input.filename === "string" &&
          pathIsInside(sourceDirectory, input.filename),
      )
    ) {
      return true;
    }
  }
  return false;
}

async function readSessionDirectoryNames(rootDirectory: string): Promise<string[]> {
  try {
    return (await readdir(rootDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function pathIsInside(rootDirectory: string, candidate: string): boolean {
  const relativePath = relative(rootDirectory, resolve(candidate));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function createTraceModuleIdCanonicalizer(
  rendered: RenderedProgram,
  sourceDirectory: string,
): (moduleId: string) => string {
  const modelModuleIds = new Map(
    [...rendered.modulePaths].map(([modelModuleId, relativePath]) => [
      resolve(sourceDirectory, relativePath),
      modelModuleId,
    ]),
  );
  return (moduleId) => {
    if (!isAbsolute(moduleId)) {
      return moduleId;
    }
    const absoluteModuleId = resolve(moduleId);
    const modelModuleId = modelModuleIds.get(absoluteModuleId);
    if (modelModuleId !== undefined) {
      return modelModuleId;
    }
    if (pathIsInside(sourceDirectory, absoluteModuleId)) {
      return `<source>/${relative(sourceDirectory, absoluteModuleId).split(sep).join("/")}`;
    }
    return moduleId;
  };
}

async function readOrderTrace(
  devtoolsSessionDirectory: string,
): Promise<StrictExecutionOrderPlanReady | null> {
  try {
    const contents = await readFile(join(devtoolsSessionDirectory, "logs.json"), "utf8");
    return parseStrictExecutionOrderLogs(contents);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function rolldownWithAllocatedDevtoolsSession(
  rolldown: RolldownFunction,
  inputOptions: InputOptions,
  devtoolsRootDirectory: string,
  onAllocated: (sessionId: string, preexistingSessions: Set<string>) => void,
): Promise<RolldownBuild> {
  for (let attempt = 0; attempt < DEVTOOLS_SESSION_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
    const sessionId = `rolldown-order-fuzzer-${process.pid}-${(nextDevtoolsSession++).toString(36)}`;
    const sessionDirectory = join(devtoolsRootDirectory, sessionId);
    if (await pathExists(sessionDirectory)) {
      continue;
    }
    const preexistingSessions = new Set(await readSessionDirectoryNames(devtoolsRootDirectory));
    if (!preexistingSessions.has(sessionId) && !(await pathExists(sessionDirectory))) {
      onAllocated(sessionId, preexistingSessions);
      return await rolldown({
        ...inputOptions,
        devtools: { sessionId },
      });
    }
  }
  throw new Error(
    `Unable to allocate a unique Rolldown devtools session ID after ${DEVTOOLS_SESSION_ID_ALLOCATION_ATTEMPTS} attempts`,
  );
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

function createOutputOptions(
  program: ProgramModel,
  rendered: RenderedProgram,
  sourceDirectory: string,
  bundleDirectory: string,
): OutputOptions {
  const groups = (program.manualChunkGroups ?? []).map((group): CodeSplittingGroup => {
    const paths = new Set(
      group.moduleIds.map((moduleId) =>
        resolve(sourceDirectory, requiredPath(rendered.modulePaths, moduleId, "module")),
      ),
    );
    return {
      name: group.name,
      test: (moduleId) => paths.has(resolve(moduleId)),
      includeDependenciesRecursively: false,
    };
  });

  return {
    dir: bundleDirectory,
    format: ROLLDOWN_BUILD_OPTIONS.format,
    strictExecutionOrder: ROLLDOWN_BUILD_OPTIONS.strictExecutionOrder,
    entryFileNames: ROLLDOWN_BUILD_OPTIONS.entryFileNames,
    chunkFileNames: ROLLDOWN_BUILD_OPTIONS.chunkFileNames,
    assetFileNames: ROLLDOWN_BUILD_OPTIONS.assetFileNames,
    codeSplitting: groups.length === 0 ? true : { groups },
    cleanDir: ROLLDOWN_BUILD_OPTIONS.cleanDir,
    minify: ROLLDOWN_BUILD_OPTIONS.minify,
  };
}

function createBundleManifest(
  program: ProgramModel,
  rendered: RenderedProgram,
  entryInputNames: ReadonlyMap<string, string>,
  sourceDirectory: string,
  output: RolldownOutput,
): ExecutionManifest {
  const entryChunks = output.output.filter(
    (candidate): candidate is OutputChunk => candidate.type === "chunk" && candidate.isEntry,
  );
  const unusedChunks = new Set(entryChunks);
  const entries = program.entries.map((entry) => {
    const internalName = requiredEntryInputName(entryInputNames, entry.name);
    const sourcePath = resolve(
      sourceDirectory,
      requiredPath(rendered.entryPaths, entry.name, "entry"),
    );
    const emitted = takeEntryChunk(entry.name, internalName, sourcePath, unusedChunks);
    if (emitted === undefined) {
      throw new Error(`Rolldown did not emit entry ${JSON.stringify(entry.name)}`);
    }

    return {
      name: entry.name,
      path: emitted.fileName,
      format: "esm" as const,
    };
  });

  return {
    version: EXECUTION_PROTOCOL_VERSION,
    entries,
    operations: rendered.schedule.operations.map(bundleScheduleOperation),
  };
}

function bundleScheduleOperation(operation: ScheduleOperation): ScheduleOperation {
  if (operation.kind === "require-entry") {
    return {
      kind: "import-entry",
      entry: operation.entry,
    };
  }
  return { ...operation };
}

function createEntryInputNames(program: ProgramModel): ReadonlyMap<string, string> {
  return new Map(
    program.entries.map((entry, index) => [
      entry.name,
      `__entry_${String(index).padStart(4, "0")}`,
    ]),
  );
}

function takeEntryChunk(
  modelEntryName: string,
  internalName: string,
  sourcePath: string,
  unusedChunks: Set<OutputChunk>,
): OutputChunk | undefined {
  const nameMatches = [...unusedChunks].filter((chunk) => chunk.name === internalName);
  if (nameMatches.length > 1) {
    throw new Error(
      `Rolldown emitted multiple chunks for internal entry ${JSON.stringify(internalName)}`,
    );
  }

  const nameMatch = nameMatches[0];
  if (nameMatch !== undefined) {
    validateEntryFacade(modelEntryName, internalName, sourcePath, nameMatch);
    unusedChunks.delete(nameMatch);
    return nameMatch;
  }

  const facadeMatches = [...unusedChunks].filter(
    (chunk) => chunk.facadeModuleId !== null && resolve(chunk.facadeModuleId) === sourcePath,
  );
  if (facadeMatches.length > 1) {
    throw new Error(
      `Rolldown omitted internal entry name ${JSON.stringify(internalName)} and emitted multiple facade matches for model entry ${JSON.stringify(modelEntryName)}`,
    );
  }

  const facadeMatch = facadeMatches[0];
  if (facadeMatch !== undefined) {
    unusedChunks.delete(facadeMatch);
  }
  return facadeMatch;
}

function validateEntryFacade(
  modelEntryName: string,
  internalName: string,
  sourcePath: string,
  chunk: OutputChunk,
): void {
  if (chunk.facadeModuleId !== null && resolve(chunk.facadeModuleId) !== sourcePath) {
    throw new Error(
      `Rolldown internal entry ${JSON.stringify(internalName)} for model entry ${JSON.stringify(modelEntryName)} has unexpected facade ${JSON.stringify(chunk.facadeModuleId)}`,
    );
  }
}

function requiredEntryInputName(
  entryInputNames: ReadonlyMap<string, string>,
  modelEntryName: string,
): string {
  const inputName = entryInputNames.get(modelEntryName);
  if (inputName === undefined) {
    throw new Error(
      `Missing Rolldown input name for model entry ${JSON.stringify(modelEntryName)}`,
    );
  }
  return inputName;
}

function requiredPath(
  paths: ReadonlyMap<string, string>,
  id: string,
  pathKind: "entry" | "module",
): string {
  const path = paths.get(id);
  if (path === undefined) {
    throw new Error(`Missing rendered ${pathKind} path for ${JSON.stringify(id)}`);
  }
  return path;
}

function failure(
  status: FailedRolldownAdapterResult["status"],
  stage: FailedRolldownAdapterResult["stage"],
  packageSpecifier: string,
  error: unknown,
): FailedRolldownAdapterResult {
  return {
    status,
    stage,
    packageSpecifier,
    error: normalizeError(error),
  };
}

function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    return {
      name: error.name.length > 0 ? error.name : "Error",
      message: error.message,
    };
  }

  return {
    name: "NonError",
    message: describeValue(error),
  };
}

function describeValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {}

  try {
    return String(value);
  } catch {
    return "<unprintable thrown value>";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
