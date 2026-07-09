/// <reference types="node" />

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CodeSplittingGroup,
  InputOptions,
  OutputOptions,
  RolldownBuild,
  RolldownOutput,
} from "rolldown";

import type { NormalizedError } from "./protocol.ts";

export const BUILD_CHILD_PROTOCOL_VERSION = 1 as const;

export interface BuildChildManualChunkGroup {
  readonly name: string;
  readonly modulePaths: readonly string[];
}

export interface BuildChildRequest {
  readonly version: typeof BUILD_CHILD_PROTOCOL_VERSION;
  readonly packageSpecifier: string;
  readonly input: Readonly<Record<string, string>>;
  readonly preserveEntrySignatures: "allow-extension";
  readonly onDemandWrapping: boolean;
  readonly bundleDirectory: string;
  readonly manualChunkGroups: readonly BuildChildManualChunkGroup[];
  readonly output: {
    readonly format: "esm";
    readonly strictExecutionOrder: true;
    readonly entryFileNames: string;
    readonly chunkFileNames: string;
    readonly assetFileNames: string;
    readonly cleanDir: false;
    readonly minify: false;
  };
}

export interface BuildChildOutputFile {
  readonly type: "chunk" | "asset";
  readonly fileName: string;
  readonly name?: string;
  readonly isEntry?: boolean;
  readonly facadeModuleId?: string | null;
}

export interface BuildChildSuccess {
  readonly version: typeof BUILD_CHILD_PROTOCOL_VERSION;
  readonly status: "ok";
  readonly outputFiles: readonly BuildChildOutputFile[];
}

export interface BuildChildFailure {
  readonly version: typeof BUILD_CHILD_PROTOCOL_VERSION;
  readonly status: "failure";
  readonly failureStatus: "harness-error" | "build-error";
  readonly stage: "load-package" | "build";
  readonly error: NormalizedError;
}

export type BuildChildResponse = BuildChildSuccess | BuildChildFailure;

type RolldownFunction = (inputOptions: InputOptions) => Promise<RolldownBuild>;

export function parseBuildChildRequest(value: unknown): BuildChildRequest {
  const request = requireRecord(value, "build request");
  if (request.version !== BUILD_CHILD_PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported build request version: ${String(request.version)}`);
  }
  const packageSpecifier = requireNonEmptyString(
    request.packageSpecifier,
    "build packageSpecifier",
  );
  const inputRecord = requireRecord(request.input, "build input");
  const input = Object.fromEntries(
    Object.entries(inputRecord).map(([name, path]) => [
      name,
      requireAbsolutePath(path, `build input ${JSON.stringify(name)}`),
    ]),
  );
  if (request.preserveEntrySignatures !== "allow-extension") {
    throw new TypeError("build preserveEntrySignatures must be allow-extension");
  }
  const bundleDirectory = requireAbsolutePath(request.bundleDirectory, "build bundleDirectory");
  const manualChunkGroups = requireArray(request.manualChunkGroups, "build manualChunkGroups").map(
    (value, index): BuildChildManualChunkGroup => {
      const group = requireRecord(value, `build manualChunkGroups[${index}]`);
      return {
        name: requireNonEmptyString(group.name, `build manualChunkGroups[${index}].name`),
        modulePaths: requireArray(
          group.modulePaths,
          `build manualChunkGroups[${index}].modulePaths`,
        ).map((path, pathIndex) =>
          requireAbsolutePath(path, `build manualChunkGroups[${index}].modulePaths[${pathIndex}]`),
        ),
      };
    },
  );
  const output = requireRecord(request.output, "build output");
  if (
    output.format !== "esm" ||
    output.strictExecutionOrder !== true ||
    output.cleanDir !== false ||
    output.minify !== false
  ) {
    throw new TypeError("build output constants are invalid");
  }
  if (typeof request.onDemandWrapping !== "boolean") {
    throw new TypeError("build onDemandWrapping must be a boolean");
  }
  return {
    version: BUILD_CHILD_PROTOCOL_VERSION,
    packageSpecifier,
    input,
    preserveEntrySignatures: "allow-extension",
    onDemandWrapping: request.onDemandWrapping,
    bundleDirectory,
    manualChunkGroups,
    output: {
      format: "esm",
      strictExecutionOrder: true,
      entryFileNames: requireNonEmptyString(output.entryFileNames, "build output.entryFileNames"),
      chunkFileNames: requireNonEmptyString(output.chunkFileNames, "build output.chunkFileNames"),
      assetFileNames: requireNonEmptyString(output.assetFileNames, "build output.assetFileNames"),
      cleanDir: false,
      minify: false,
    },
  };
}

export function parseBuildChildResponse(
  value: unknown,
  bundleDirectory: string,
): BuildChildResponse {
  const response = requireRecord(value, "build response");
  if (response.version !== BUILD_CHILD_PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported build response version: ${String(response.version)}`);
  }
  if (response.status === "ok") {
    return {
      version: BUILD_CHILD_PROTOCOL_VERSION,
      status: "ok",
      outputFiles: requireArray(response.outputFiles, "build outputFiles").map((output, index) =>
        parseOutputFile(output, index, bundleDirectory),
      ),
    };
  }
  if (response.status === "failure") {
    if (response.failureStatus !== "harness-error" && response.failureStatus !== "build-error") {
      throw new TypeError("build failureStatus is invalid");
    }
    if (response.stage !== "load-package" && response.stage !== "build") {
      throw new TypeError("build failure stage is invalid");
    }
    const error = requireRecord(response.error, "build failure error");
    return {
      version: BUILD_CHILD_PROTOCOL_VERSION,
      status: "failure",
      failureStatus: response.failureStatus,
      stage: response.stage,
      error: {
        name: requireNonEmptyString(error.name, "build failure error.name"),
        message: requireString(error.message, "build failure error.message"),
      },
    };
  }
  throw new TypeError(`Unsupported build response status: ${String(response.status)}`);
}

export async function runBuildChildFromUnknown(value: unknown): Promise<BuildChildResponse> {
  try {
    return await runBuildChild(parseBuildChildRequest(value));
  } catch (error) {
    return childFailure("harness-error", "build", error);
  }
}

export async function runBuildChild(request: BuildChildRequest): Promise<BuildChildResponse> {
  let loaded: unknown;
  try {
    loaded = await import(request.packageSpecifier);
  } catch (error) {
    return childFailure("harness-error", "load-package", error);
  }
  if (!isRecord(loaded) || typeof loaded.rolldown !== "function") {
    return childFailure(
      "harness-error",
      "load-package",
      new TypeError(
        `Rolldown package ${JSON.stringify(request.packageSpecifier)} has no rolldown export`,
      ),
    );
  }

  let bundle: RolldownBuild | undefined;
  let output: RolldownOutput | undefined;
  let buildError: unknown;
  try {
    const inputOptions: InputOptions = {
      input: request.input,
      preserveEntrySignatures: request.preserveEntrySignatures,
      experimental: { onDemandWrapping: request.onDemandWrapping },
    };
    bundle = await (loaded.rolldown as RolldownFunction)(inputOptions);
    output = await bundle.write(createOutputOptions(request));
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
    return childFailure("build-error", "build", buildError);
  }
  if (output === undefined) {
    return childFailure(
      "build-error",
      "build",
      new Error("Rolldown build completed without output"),
    );
  }
  return {
    version: BUILD_CHILD_PROTOCOL_VERSION,
    status: "ok",
    outputFiles: output.output.map((file) => serializeOutputFile(file, request.bundleDirectory)),
  };
}

function parseOutputFile(
  value: unknown,
  index: number,
  bundleDirectory: string,
): BuildChildOutputFile {
  const output = requireRecord(value, `build outputFiles[${index}]`);
  const fileName = validateOutputFileName(
    requireNonEmptyString(output.fileName, `build outputFiles[${index}].fileName`),
    bundleDirectory,
    `build outputFiles[${index}].fileName`,
  );
  if (output.type === "asset") {
    return { type: "asset", fileName };
  }
  if (output.type === "chunk") {
    if (typeof output.isEntry !== "boolean") {
      throw new TypeError(`build outputFiles[${index}].isEntry must be boolean`);
    }
    if (output.facadeModuleId !== null && typeof output.facadeModuleId !== "string") {
      throw new TypeError(`build outputFiles[${index}].facadeModuleId must be string or null`);
    }
    return {
      type: "chunk",
      fileName,
      name: requireNonEmptyString(output.name, `build outputFiles[${index}].name`),
      isEntry: output.isEntry,
      facadeModuleId: output.facadeModuleId,
    };
  }
  throw new TypeError(`build outputFiles[${index}].type is invalid`);
}

function createOutputOptions(request: BuildChildRequest): OutputOptions {
  const groups = request.manualChunkGroups.map((group): CodeSplittingGroup => {
    const paths = new Set(group.modulePaths.map((path) => resolve(path)));
    return {
      name: group.name,
      test: (moduleId) => paths.has(resolve(moduleId)),
      includeDependenciesRecursively: false,
    };
  });
  return {
    dir: request.bundleDirectory,
    ...request.output,
    codeSplitting: groups.length === 0 ? true : { groups },
  };
}

function pathIsInside(rootDirectory: string, candidate: string): boolean {
  const relativePath = relative(rootDirectory, resolve(candidate));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function serializeOutputFile(
  output: RolldownOutput["output"][number],
  bundleDirectory: string,
): BuildChildOutputFile {
  const fileName = validateOutputFileName(
    output.fileName,
    bundleDirectory,
    "Rolldown output fileName",
  );
  if (output.type === "asset") {
    return { type: "asset", fileName };
  }
  return {
    type: "chunk",
    fileName,
    name: output.name,
    isEntry: output.isEntry,
    facadeModuleId: output.facadeModuleId,
  };
}

function validateOutputFileName(fileName: string, bundleDirectory: string, label: string): string {
  if (
    fileName.includes("\0") ||
    fileName.includes("\\") ||
    posix.isAbsolute(fileName) ||
    win32.isAbsolute(fileName) ||
    /^[A-Za-z]:/.test(fileName)
  ) {
    throw new TypeError(`${label} must be a canonical relative output path`);
  }
  const segments = fileName.split("/");
  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    posix.normalize(fileName) !== fileName
  ) {
    throw new TypeError(`${label} must be a canonical relative output path`);
  }
  const resolvedPath = resolve(bundleDirectory, fileName);
  if (!pathIsInside(bundleDirectory, resolvedPath) || resolvedPath === resolve(bundleDirectory)) {
    throw new TypeError(`${label} escapes the bundle directory`);
  }
  return fileName;
}

function childFailure(
  failureStatus: BuildChildFailure["failureStatus"],
  stage: BuildChildFailure["stage"],
  error: unknown,
): BuildChildFailure {
  return {
    version: BUILD_CHILD_PROTOCOL_VERSION,
    status: "failure",
    failureStatus,
    stage,
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const string = requireString(value, label);
  if (string.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  return string;
}

function requireAbsolutePath(value: unknown, label: string): string {
  const path = requireNonEmptyString(value, label);
  if (!isAbsolute(path)) {
    throw new TypeError(`${label} must be absolute`);
  }
  return path;
}

async function main(): Promise<void> {
  const requestPath = process.argv[2];
  const responsePath = process.argv[3];
  if (requestPath === undefined || responsePath === undefined) {
    process.exitCode = 2;
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(requestPath, "utf8")) as unknown;
  } catch (error) {
    value = error;
  }
  const response =
    value instanceof Error
      ? childFailure("harness-error", "build", value)
      : await runBuildChildFromUnknown(value);
  await mkdir(dirname(responsePath), { recursive: true });
  await writeFile(responsePath, `${JSON.stringify(response)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
