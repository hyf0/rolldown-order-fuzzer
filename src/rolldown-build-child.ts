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

/// Written by the child to its phase-marker file once the Rolldown package has imported cleanly, so
/// the parent can tell a build-time crash (a genuine Rolldown panic) from a crash during package
/// loading (harness misconfiguration). See rolldown-adapter.ts.
export const BUILD_PHASE_PACKAGE_LOADED = "package-loaded" as const;

const PANIC_MESSAGE_PATTERN =
  /\bpanicked\b|\bpanic occurred\b|fatal runtime error|fatal error|\bSIGABRT\b|\bSIGSEGV\b|\bSIGILL\b|\bSIGBUS\b|\bSIGTRAP\b|process crashed|RolldownBuildPanic/i;

/// A genuine Rolldown build panic — a Rust panic surfaced as a thrown error, a napi fatal, or a
/// process crash — as opposed to an ordinary build error or a true harness misconfiguration. The
/// parent gives such failures a distinct, deduplicated `build-failure:panic` verdict.
export function looksLikePanic(error: NormalizedError): boolean {
  return error.name === "RolldownBuildPanic" || PANIC_MESSAGE_PATTERN.test(error.message);
}

export interface BuildChildHooks {
  /// Invoked after the Rolldown package imports and exposes a `rolldown` function, before the build
  /// starts. The child uses it to write a phase marker; the parent reads that marker to attribute a
  /// subsequent hard crash to the build rather than to package loading.
  readonly onPackageLoaded?: () => void | Promise<void>;
}

export interface BuildChildManualChunkGroup {
  readonly name: string;
  readonly modulePaths: readonly string[];
}

/// The serializable form of a `ProgramModel.OrganicChunkGroupConfig`, mapped to a rolldown
/// `CodeSplittingGroup` in `createOutputOptions`. `test` is a regex SOURCE (the child reconstructs
/// `new RegExp(test)` so it matches by regular expression, not substring); the numeric thresholds
/// pass straight through. Mutually exclusive with `manualChunkGroups` in one request.
export interface BuildChildOrganicChunkGroup {
  readonly name: string;
  readonly test?: string;
  readonly minSize?: number;
  readonly maxSize?: number;
  readonly minShareCount?: number;
  readonly priority?: number;
  readonly includeDependenciesRecursively?: boolean;
}

export interface BuildChildRequest {
  readonly version: typeof BUILD_CHILD_PROTOCOL_VERSION;
  readonly packageSpecifier: string;
  readonly input: Readonly<Record<string, string>>;
  readonly preserveEntrySignatures: false | "strict" | "allow-extension" | "exports-only";
  /// The GLOBAL `codeSplitting.includeDependenciesRecursively` fallback (W14a axis). Applied to the
  /// `codeSplitting` object when the request carries groups; irrelevant to automatic chunking.
  readonly includeDependenciesRecursively: boolean;
  /// `experimental.lazyBarrel` — rolldown's barrel-pruning optimization (W14a axis).
  readonly lazyBarrel: boolean;
  readonly onDemandWrapping: boolean;
  readonly bundleDirectory: string;
  readonly manualChunkGroups: readonly BuildChildManualChunkGroup[];
  readonly organicChunkGroups: readonly BuildChildOrganicChunkGroup[];
  readonly output: {
    readonly format: "esm";
    readonly strictExecutionOrder: boolean;
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
  /// Set when the build error is a genuine Rolldown panic (see `looksLikePanic`). The parent maps it
  /// to a distinct `build-failure:panic` verdict instead of a generic build failure.
  readonly panic?: boolean;
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
  if (
    request.preserveEntrySignatures !== false &&
    request.preserveEntrySignatures !== "strict" &&
    request.preserveEntrySignatures !== "allow-extension" &&
    request.preserveEntrySignatures !== "exports-only"
  ) {
    throw new TypeError("build preserveEntrySignatures is invalid");
  }
  const preserveEntrySignatures = request.preserveEntrySignatures;
  const includeDependenciesRecursively = requireBoolean(
    request.includeDependenciesRecursively,
    "build includeDependenciesRecursively",
  );
  const lazyBarrel = requireBoolean(request.lazyBarrel, "build lazyBarrel");
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
  const organicChunkGroups = requireArray(
    request.organicChunkGroups,
    "build organicChunkGroups",
  ).map((value, index): BuildChildOrganicChunkGroup => {
    const group = requireRecord(value, `build organicChunkGroups[${index}]`);
    return {
      name: requireNonEmptyString(group.name, `build organicChunkGroups[${index}].name`),
      ...(group.test === undefined
        ? {}
        : { test: requireNonEmptyString(group.test, `build organicChunkGroups[${index}].test`) }),
      ...optionalNonNegativeNumber(
        group.minSize,
        `build organicChunkGroups[${index}].minSize`,
        "minSize",
      ),
      ...optionalNonNegativeNumber(
        group.maxSize,
        `build organicChunkGroups[${index}].maxSize`,
        "maxSize",
      ),
      ...optionalNonNegativeNumber(
        group.minShareCount,
        `build organicChunkGroups[${index}].minShareCount`,
        "minShareCount",
      ),
      ...optionalNonNegativeNumber(
        group.priority,
        `build organicChunkGroups[${index}].priority`,
        "priority",
      ),
      ...(group.includeDependenciesRecursively === undefined
        ? {}
        : {
            includeDependenciesRecursively: requireBoolean(
              group.includeDependenciesRecursively,
              `build organicChunkGroups[${index}].includeDependenciesRecursively`,
            ),
          }),
    };
  });
  const output = requireRecord(request.output, "build output");
  if (output.format !== "esm" || output.cleanDir !== false || output.minify !== false) {
    throw new TypeError("build output constants are invalid");
  }
  const strictExecutionOrder = requireBoolean(
    output.strictExecutionOrder,
    "build output.strictExecutionOrder",
  );
  if (typeof request.onDemandWrapping !== "boolean") {
    throw new TypeError("build onDemandWrapping must be a boolean");
  }
  return {
    version: BUILD_CHILD_PROTOCOL_VERSION,
    packageSpecifier,
    input,
    preserveEntrySignatures,
    includeDependenciesRecursively,
    lazyBarrel,
    onDemandWrapping: request.onDemandWrapping,
    bundleDirectory,
    manualChunkGroups,
    organicChunkGroups,
    output: {
      format: "esm",
      strictExecutionOrder,
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
    if (response.panic !== undefined && typeof response.panic !== "boolean") {
      throw new TypeError("build failure panic must be a boolean");
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
      ...(response.panic === true ? { panic: true } : {}),
    };
  }
  throw new TypeError(`Unsupported build response status: ${String(response.status)}`);
}

export async function runBuildChildFromUnknown(
  value: unknown,
  hooks: BuildChildHooks = {},
): Promise<BuildChildResponse> {
  try {
    return await runBuildChild(parseBuildChildRequest(value), hooks);
  } catch (error) {
    return childFailure("harness-error", "build", error);
  }
}

export async function runBuildChild(
  request: BuildChildRequest,
  hooks: BuildChildHooks = {},
): Promise<BuildChildResponse> {
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

  // The package imported cleanly. Signal the parent so a subsequent hard crash (a Rust panic or napi
  // fatal that aborts the process) is attributed to the build, not to package loading.
  await hooks.onPackageLoaded?.();

  let bundle: RolldownBuild | undefined;
  let output: RolldownOutput | undefined;
  let buildError: unknown;
  try {
    const inputOptions: InputOptions = {
      input: request.input,
      preserveEntrySignatures: request.preserveEntrySignatures,
      experimental: {
        onDemandWrapping: request.onDemandWrapping,
        lazyBarrel: request.lazyBarrel,
      },
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

/// Build rolldown output options, mapping the request's chunking config onto `codeSplitting`.
/// Organic groups (size/share thresholds — rolldown decides composition) take precedence when
/// present; otherwise manual groups (exact module lists) map to an exact-match `test`; otherwise the
/// automatic default (`codeSplitting: true`). The three are the distinct chunking-config modes and
/// never coexist in one request (validated model-side).
export function createOutputOptions(request: BuildChildRequest): OutputOptions {
  const groups = organicCodeSplitting(request) ?? manualCodeSplitting(request);
  // The GLOBAL `codeSplitting.includeDependenciesRecursively` fallback applies to any group that does
  // not set it per-group; it is meaningless for automatic chunking (`true`), which carries no groups.
  // (Current generated groups set it per-group, so the global is inert for them; it becomes load-bearing
  // for the #9887 cross-chunk-cycle shape, whose groups omit the per-group setting.)
  const codeSplitting =
    groups === true
      ? true
      : { ...groups, includeDependenciesRecursively: request.includeDependenciesRecursively };
  return {
    dir: request.bundleDirectory,
    ...request.output,
    codeSplitting,
  };
}

function organicCodeSplitting(request: BuildChildRequest): { groups: CodeSplittingGroup[] } | null {
  if (request.organicChunkGroups.length === 0) {
    return null;
  }
  const groups = request.organicChunkGroups.map(
    (group): CodeSplittingGroup => ({
      name: group.name,
      // `test` is a regex SOURCE: reconstruct a RegExp so rolldown matches by regular expression
      // (a plain string would be a substring match).
      ...(group.test === undefined ? {} : { test: new RegExp(group.test) }),
      ...(group.minSize === undefined ? {} : { minSize: group.minSize }),
      ...(group.maxSize === undefined ? {} : { maxSize: group.maxSize }),
      ...(group.minShareCount === undefined ? {} : { minShareCount: group.minShareCount }),
      ...(group.priority === undefined ? {} : { priority: group.priority }),
      ...(group.includeDependenciesRecursively === undefined
        ? {}
        : { includeDependenciesRecursively: group.includeDependenciesRecursively }),
    }),
  );
  return { groups };
}

function manualCodeSplitting(request: BuildChildRequest): true | { groups: CodeSplittingGroup[] } {
  const groups = request.manualChunkGroups.map((group): CodeSplittingGroup => {
    const paths = new Set(group.modulePaths.map((path) => resolve(path)));
    return {
      name: group.name,
      test: (moduleId) => paths.has(resolve(moduleId)),
      includeDependenciesRecursively: false,
    };
  });
  return groups.length === 0 ? true : { groups };
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
  const normalized = normalizeError(error);
  // A build-time error whose shape matches a Rust panic / napi fatal is a genuine Rolldown panic;
  // load-package and harness failures are never panics.
  const panic = failureStatus === "build-error" && looksLikePanic(normalized);
  return {
    version: BUILD_CHILD_PROTOCOL_VERSION,
    status: "failure",
    failureStatus,
    stage,
    error: normalized,
    ...(panic ? { panic: true } : {}),
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

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

/// An optional finite non-negative numeric threshold, returned as a spreadable partial so an absent
/// field stays absent (rolldown then applies its own default).
function optionalNonNegativeNumber(
  value: unknown,
  label: string,
  key: "minSize" | "maxSize" | "minShareCount" | "priority",
): Partial<Record<"minSize" | "maxSize" | "minShareCount" | "priority", number>> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return { [key]: value };
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
  const phasePath = process.argv[4];
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
      : await runBuildChildFromUnknown(
          value,
          phasePath === undefined
            ? {}
            : { onPackageLoaded: () => writeBuildPhaseMarker(phasePath) },
        );
  await mkdir(dirname(responsePath), { recursive: true });
  await writeFile(responsePath, `${JSON.stringify(response)}\n`);
}

async function writeBuildPhaseMarker(phasePath: string): Promise<void> {
  try {
    await writeFile(phasePath, `${JSON.stringify({ phase: BUILD_PHASE_PACKAGE_LOADED })}\n`);
  } catch {}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
