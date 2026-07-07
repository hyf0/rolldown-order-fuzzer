/// <reference types="node" />

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionManifest,
  type NormalizedError,
} from "./protocol.ts";
import type { RenderedProgram } from "./render.ts";

const BUNDLE_PACKAGE_JSON = '{\n  "type": "module"\n}\n';

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
}

export interface RolldownBuildArtifacts {
  readonly temporaryDirectory: string;
  readonly sourceDirectory: string;
  readonly bundleDirectory: string;
  readonly sourceManifestPath: string;
  readonly bundleManifestPath: string;
  readonly manifest: ExecutionManifest;
  readonly outputFiles: readonly string[];
}

export interface SuccessfulRolldownAdapterResult<T> {
  readonly status: "ok";
  readonly value: T;
}

export interface FailedRolldownAdapterResult {
  readonly status: "harness-error" | "build-error";
  readonly stage: "materialize-source" | "load-package" | "build" | "write-manifest";
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
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "rolldown-order-fuzzer-"));
  const sourceDirectory = join(temporaryDirectory, "source");
  const bundleDirectory = join(temporaryDirectory, "bundle");
  const sourceManifestPath = join(sourceDirectory, rendered.schedulePath);
  const bundleManifestPath = join(bundleDirectory, rendered.schedulePath);
  const entryInputNames = createEntryInputNames(program);
  let canonicalSourceDirectory: string;
  let manifest: ExecutionManifest | undefined;

  const reportFailure = async (
    failureResult: FailedRolldownAdapterResult,
  ): Promise<FailedRolldownAdapterResult> => {
    await options.onFailureArtifacts?.(failureResult, {
      temporaryDirectory,
      sourceDirectory,
      bundleDirectory,
      sourceManifestPath,
      bundleManifestPath,
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
    );
    if (built.status !== "ok") {
      return await reportFailure(built);
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
      }),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
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
): Promise<BuiltRolldown | FailedRolldownAdapterResult> {
  let bundle: RolldownBuild | undefined;
  let output: RolldownOutput | undefined;
  let buildError: unknown;

  try {
    bundle = await rolldown({
      input: Object.fromEntries(
        program.entries.map((entry) => [
          requiredEntryInputName(entryInputNames, entry.name),
          resolve(sourceDirectory, requiredPath(rendered.entryPaths, entry.name, "entry")),
        ]),
      ),
      preserveEntrySignatures: ROLLDOWN_BUILD_OPTIONS.preserveEntrySignatures,
    });
    output = await bundle.write(
      createOutputOptions(program, rendered, sourceDirectory, bundleDirectory),
    );
  } catch (error) {
    buildError = error;
  }

  if (bundle !== undefined) {
    try {
      await bundle.close();
    } catch (error) {
      buildError ??= error;
    }
  }

  if (buildError !== undefined) {
    return failure("build-error", "build", packageSpecifier, buildError);
  }
  if (output === undefined) {
    return failure(
      "build-error",
      "build",
      packageSpecifier,
      new Error("Rolldown build completed without output"),
    );
  }

  return { status: "ok", output };
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
