/// <reference types="node" />

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CodeSplittingGroup,
  InputOptions,
  OutputOptions,
  RolldownBuild,
  RolldownOutput,
} from "rolldown";

import {
  canonicalizeStrictExecutionOrderModuleIds,
  parseStrictExecutionOrderPlanReady,
  parseStrictExecutionOrderLogs,
  type StrictExecutionOrderPlanReady,
} from "./order-trace.ts";
import type { NormalizedError } from "./protocol.ts";

export const TRACE_CHILD_PROTOCOL_VERSION = 1 as const;

export interface TraceChildManualChunkGroup {
  readonly name: string;
  readonly modulePaths: readonly string[];
}

export interface TraceChildRequest {
  readonly version: typeof TRACE_CHILD_PROTOCOL_VERSION;
  readonly packageSpecifier: string;
  readonly input: Readonly<Record<string, string>>;
  readonly preserveEntrySignatures: "allow-extension";
  readonly sourceDirectory: string;
  readonly bundleDirectory: string;
  readonly modulePaths: readonly (readonly [modelModuleId: string, relativePath: string])[];
  readonly manualChunkGroups: readonly TraceChildManualChunkGroup[];
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

export interface TraceChildOutputFile {
  readonly type: "chunk" | "asset";
  readonly fileName: string;
  readonly name?: string;
  readonly isEntry?: boolean;
  readonly facadeModuleId?: string | null;
}

export interface TraceChildSuccess {
  readonly version: typeof TRACE_CHILD_PROTOCOL_VERSION;
  readonly status: "ok";
  readonly outputFiles: readonly TraceChildOutputFile[];
  readonly orderTrace: StrictExecutionOrderPlanReady | null;
}

export interface TraceChildFailure {
  readonly version: typeof TRACE_CHILD_PROTOCOL_VERSION;
  readonly status: "failure";
  readonly failureStatus: "harness-error" | "build-error";
  readonly stage: "load-package" | "build" | "collect-order-trace";
  readonly error: NormalizedError;
  readonly orderTrace: StrictExecutionOrderPlanReady | null;
}

export type TraceChildResponse = TraceChildSuccess | TraceChildFailure;

type RolldownFunction = (inputOptions: InputOptions) => Promise<RolldownBuild>;

export function parseTraceChildRequest(value: unknown): TraceChildRequest {
  const request = requireRecord(value, "traced build request");
  if (request.version !== TRACE_CHILD_PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported traced build request version: ${String(request.version)}`);
  }
  const packageSpecifier = requireNonEmptyString(
    request.packageSpecifier,
    "traced build packageSpecifier",
  );
  const inputRecord = requireRecord(request.input, "traced build input");
  const input = Object.fromEntries(
    Object.entries(inputRecord).map(([name, path]) => [
      name,
      requireNonEmptyString(path, `traced build input ${JSON.stringify(name)}`),
    ]),
  );
  if (request.preserveEntrySignatures !== "allow-extension") {
    throw new TypeError("traced build preserveEntrySignatures must be allow-extension");
  }
  const sourceDirectory = requireAbsolutePath(
    request.sourceDirectory,
    "traced build sourceDirectory",
  );
  const bundleDirectory = requireAbsolutePath(
    request.bundleDirectory,
    "traced build bundleDirectory",
  );
  const modulePaths = requireArray(request.modulePaths, "traced build modulePaths").map(
    (value, index): readonly [string, string] => {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new TypeError(`traced build modulePaths[${index}] must be a two-item tuple`);
      }
      return [
        requireNonEmptyString(value[0], `traced build modulePaths[${index}][0]`),
        requireNonEmptyString(value[1], `traced build modulePaths[${index}][1]`),
      ];
    },
  );
  const manualChunkGroups = requireArray(
    request.manualChunkGroups,
    "traced build manualChunkGroups",
  ).map((value, index): TraceChildManualChunkGroup => {
    const group = requireRecord(value, `traced build manualChunkGroups[${index}]`);
    return {
      name: requireNonEmptyString(group.name, `traced build manualChunkGroups[${index}].name`),
      modulePaths: requireArray(
        group.modulePaths,
        `traced build manualChunkGroups[${index}].modulePaths`,
      ).map((path, pathIndex) =>
        requireAbsolutePath(
          path,
          `traced build manualChunkGroups[${index}].modulePaths[${pathIndex}]`,
        ),
      ),
    };
  });
  const output = requireRecord(request.output, "traced build output");
  if (
    output.format !== "esm" ||
    output.strictExecutionOrder !== true ||
    output.cleanDir !== false ||
    output.minify !== false
  ) {
    throw new TypeError("traced build output constants are invalid");
  }
  return {
    version: TRACE_CHILD_PROTOCOL_VERSION,
    packageSpecifier,
    input,
    preserveEntrySignatures: "allow-extension",
    sourceDirectory,
    bundleDirectory,
    modulePaths,
    manualChunkGroups,
    output: {
      format: "esm",
      strictExecutionOrder: true,
      entryFileNames: requireNonEmptyString(
        output.entryFileNames,
        "traced build output.entryFileNames",
      ),
      chunkFileNames: requireNonEmptyString(
        output.chunkFileNames,
        "traced build output.chunkFileNames",
      ),
      assetFileNames: requireNonEmptyString(
        output.assetFileNames,
        "traced build output.assetFileNames",
      ),
      cleanDir: false,
      minify: false,
    },
  };
}

export function parseTraceChildResponse(value: unknown): TraceChildResponse {
  const response = requireRecord(value, "traced build response");
  if (response.version !== TRACE_CHILD_PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported traced build response version: ${String(response.version)}`);
  }
  const orderTrace =
    response.orderTrace === null ? null : parseStrictExecutionOrderPlanReady(response.orderTrace);
  if (response.status === "ok") {
    return {
      version: TRACE_CHILD_PROTOCOL_VERSION,
      status: "ok",
      outputFiles: requireArray(response.outputFiles, "traced build outputFiles").map(
        parseOutputFile,
      ),
      orderTrace,
    };
  }
  if (response.status === "failure") {
    if (response.failureStatus !== "harness-error" && response.failureStatus !== "build-error") {
      throw new TypeError("traced build failureStatus is invalid");
    }
    if (
      response.stage !== "load-package" &&
      response.stage !== "build" &&
      response.stage !== "collect-order-trace"
    ) {
      throw new TypeError("traced build failure stage is invalid");
    }
    const error = requireRecord(response.error, "traced build failure error");
    return {
      version: TRACE_CHILD_PROTOCOL_VERSION,
      status: "failure",
      failureStatus: response.failureStatus,
      stage: response.stage,
      error: {
        name: requireNonEmptyString(error.name, "traced build failure error.name"),
        message: requireString(error.message, "traced build failure error.message"),
      },
      orderTrace,
    };
  }
  throw new TypeError(`Unsupported traced build response status: ${String(response.status)}`);
}

export async function runTraceChildFromUnknown(value: unknown): Promise<TraceChildResponse> {
  try {
    return await runTraceChild(parseTraceChildRequest(value));
  } catch (error) {
    return childFailure("harness-error", "build", error, null);
  }
}

export async function runTraceChild(request: TraceChildRequest): Promise<TraceChildResponse> {
  let loaded: unknown;
  try {
    loaded = await import(request.packageSpecifier);
  } catch (error) {
    return childFailure("harness-error", "load-package", error, null);
  }
  if (!isRecord(loaded) || typeof loaded.rolldown !== "function") {
    return childFailure(
      "harness-error",
      "load-package",
      new TypeError(
        `Rolldown package ${JSON.stringify(request.packageSpecifier)} has no rolldown export`,
      ),
      null,
    );
  }

  const requestedSessionId = `rolldown-order-fuzzer-${process.pid}`;
  let bundle: RolldownBuild | undefined;
  let output: RolldownOutput | undefined;
  let buildError: unknown;
  try {
    bundle = await (loaded.rolldown as RolldownFunction)({
      input: request.input,
      preserveEntrySignatures: request.preserveEntrySignatures,
      devtools: { sessionId: requestedSessionId },
    });
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

  let orderTrace: StrictExecutionOrderPlanReady | null;
  try {
    orderTrace = await collectOrderTrace(request, requestedSessionId);
  } catch (error) {
    return childFailure("harness-error", "collect-order-trace", error, null);
  }

  if (buildError !== undefined) {
    return childFailure("build-error", "build", buildError, orderTrace);
  }
  if (output === undefined) {
    return childFailure(
      "build-error",
      "build",
      new Error("Rolldown build completed without output"),
      orderTrace,
    );
  }
  return {
    version: TRACE_CHILD_PROTOCOL_VERSION,
    status: "ok",
    outputFiles: output.output.map(serializeOutputFile),
    orderTrace,
  };
}

function parseOutputFile(value: unknown, index: number): TraceChildOutputFile {
  const output = requireRecord(value, `traced build outputFiles[${index}]`);
  const fileName = requireNonEmptyString(
    output.fileName,
    `traced build outputFiles[${index}].fileName`,
  );
  if (output.type === "asset") {
    return { type: "asset", fileName };
  }
  if (output.type === "chunk") {
    if (typeof output.isEntry !== "boolean") {
      throw new TypeError(`traced build outputFiles[${index}].isEntry must be boolean`);
    }
    if (output.facadeModuleId !== null && typeof output.facadeModuleId !== "string") {
      throw new TypeError(
        `traced build outputFiles[${index}].facadeModuleId must be string or null`,
      );
    }
    return {
      type: "chunk",
      fileName,
      name: requireNonEmptyString(output.name, `traced build outputFiles[${index}].name`),
      isEntry: output.isEntry,
      facadeModuleId: output.facadeModuleId,
    };
  }
  throw new TypeError(`traced build outputFiles[${index}].type is invalid`);
}

function createOutputOptions(request: TraceChildRequest): OutputOptions {
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

async function collectOrderTrace(
  request: TraceChildRequest,
  requestedSessionId: string,
): Promise<StrictExecutionOrderPlanReady | null> {
  const devtoolsRoot = join(process.cwd(), "node_modules", ".rolldown");
  const sessionNames = await readSessionDirectoryNames(devtoolsRoot);
  const matching: string[] = [];
  for (const name of sessionNames) {
    const directory = join(devtoolsRoot, name);
    if (await sessionMetaBelongsToSource(directory, request.sourceDirectory)) {
      matching.push(directory);
    }
  }

  const requestedDirectory = join(devtoolsRoot, requestedSessionId);
  const selected = matching.includes(requestedDirectory)
    ? requestedDirectory
    : matching.length === 1
      ? matching[0]
      : undefined;
  if (selected === undefined) {
    return null;
  }

  const contents = await readFile(join(selected, "logs.json"), "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const parsed = parseStrictExecutionOrderLogs(contents);
  return parsed === null
    ? null
    : canonicalizeStrictExecutionOrderModuleIds(
        parsed,
        createModuleIdCanonicalizer(request.modulePaths, request.sourceDirectory),
      );
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

async function readSessionDirectoryNames(rootDirectory: string): Promise<readonly string[]> {
  try {
    return (await readdir(rootDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function createModuleIdCanonicalizer(
  modulePaths: TraceChildRequest["modulePaths"],
  sourceDirectory: string,
): (moduleId: string) => string {
  const modelModuleIds = new Map(
    modulePaths.map(([modelModuleId, relativePath]) => [
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

function pathIsInside(rootDirectory: string, candidate: string): boolean {
  const relativePath = relative(rootDirectory, resolve(candidate));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function serializeOutputFile(output: RolldownOutput["output"][number]): TraceChildOutputFile {
  if (output.type === "asset") {
    return { type: "asset", fileName: output.fileName };
  }
  return {
    type: "chunk",
    fileName: output.fileName,
    name: output.name,
    isEntry: output.isEntry,
    facadeModuleId: output.facadeModuleId,
  };
}

function childFailure(
  failureStatus: TraceChildFailure["failureStatus"],
  stage: TraceChildFailure["stage"],
  error: unknown,
  orderTrace: StrictExecutionOrderPlanReady | null,
): TraceChildFailure {
  return {
    version: TRACE_CHILD_PROTOCOL_VERSION,
    status: "failure",
    failureStatus,
    stage,
    error: normalizeError(error),
    orderTrace,
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
      ? childFailure("harness-error", "build", value, null)
      : await runTraceChildFromUnknown(value);
  await mkdir(dirname(responsePath), { recursive: true });
  await writeFile(responsePath, `${JSON.stringify(response)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
