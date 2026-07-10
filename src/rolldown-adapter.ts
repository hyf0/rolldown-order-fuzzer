/// <reference types="node" />

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
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
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ProgramModel, ScheduleOperation } from "./model.ts";
import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionManifest,
  type NormalizedError,
} from "./protocol.ts";
import type { RenderedProgram } from "./render.ts";
import {
  parseBuildChildResponse,
  BUILD_CHILD_PROTOCOL_VERSION,
  BUILD_PHASE_PACKAGE_LOADED,
  type BuildChildRequest,
  type BuildChildResponse,
  type BuildChildOutputFile,
} from "./rolldown-build-child.ts";

const BUNDLE_PACKAGE_JSON = '{\n  "type": "module"\n}\n';
const COMPACT_PACKAGE_MAX_FILES = 512;
const COMPACT_PACKAGE_MAX_BYTES = 32 * 1024 * 1024;
const IGNORED_PACKAGE_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".cache",
  "cache",
  "caches",
  ".vite",
  ".rolldown",
  "coverage",
]);
const FUZZER_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const BUILD_CHILD_PATH = fileURLToPath(new URL("./rolldown-build-child.ts", import.meta.url));
const DEFAULT_BUILD_CHILD_TIMEOUT_MS = 60_000;
const BUILD_CHILD_TERMINATION_GRACE_MS = 250;
const BUILD_CHILD_FINAL_CLOSE_GRACE_MS = 250;

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
  readonly onDemandWrapping?: boolean;
  readonly buildChildTimeoutMs?: number;
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
  readonly runtimeIdentity: ObservedRuntimeIdentity;
}

export interface RolldownBuildArtifacts {
  readonly temporaryDirectory: string;
  readonly sourceDirectory: string;
  readonly bundleDirectory: string;
  readonly sourceManifestPath: string;
  readonly bundleManifestPath: string;
  readonly manifest: ExecutionManifest;
  readonly outputFiles: readonly string[];
  readonly runtimeIdentity: ObservedRuntimeIdentity;
}

export interface ObservedRuntimeIdentity {
  readonly processVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly requestedPackageSpecifier: string;
  readonly resolvedEntryUrl: string | null;
  readonly resolvedEntryPath: string | null;
  readonly packageVersion: string | null;
  readonly resolvedEntrySha256: string | null;
  readonly packageRootPath: string | null;
  readonly packageJsonPath: string | null;
  readonly packageContentSha256: string | null;
  readonly packageContentFiles: readonly string[];
  readonly fuzzerLockfilePath: string | null;
  readonly fuzzerLockfileSha256: string | null;
  readonly optionalBindingPackages: readonly ObservedBindingPackageIdentity[];
  readonly napiRsNativeLibrary: ObservedNativeLibraryOverrideIdentity;
}

export interface ObservedNativeLibraryOverrideIdentity {
  readonly requested: string | null;
  readonly loaderPath: string | null;
  readonly loaderCandidates: readonly string[];
  readonly resolvedPath: string | null;
  readonly realPath: string | null;
  readonly sha256: string | null;
}

export interface ObservedBindingPackageIdentity {
  readonly name: string;
  readonly version: string | null;
  readonly packageRootPath: string;
  readonly packageJsonPath: string;
  readonly contentSha256: string | null;
  readonly contentFiles: readonly string[];
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
    | "write-manifest"
    | "consume-output";
  readonly packageSpecifier: string;
  readonly error: NormalizedError;
  /// A genuine Rolldown build panic (a Rust panic / napi fatal surfaced as a thrown error, or a
  /// process crash after the package loaded) rather than an ordinary build error. It always carries
  /// `status: "build-error"` — a failing verdict — so a panic never counts as a harness discard.
  readonly panic?: boolean;
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
  const onDemandWrapping = options.onDemandWrapping ?? true;
  const runtimeIdentity = await inspectRolldownRuntimeIdentity(packageSpecifier);
  const buildChildTimeoutMs = options.buildChildTimeoutMs ?? DEFAULT_BUILD_CHILD_TIMEOUT_MS;
  if (!Number.isFinite(buildChildTimeoutMs) || buildChildTimeoutMs <= 0) {
    throw new Error(`buildChildTimeoutMs must be positive, received ${buildChildTimeoutMs}`);
  }
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
      runtimeIdentity,
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

    const built = await buildWithChild(
      program,
      rendered,
      entryInputNames,
      canonicalSourceDirectory,
      bundleDirectory,
      temporaryDirectory,
      packageSpecifier,
      onDemandWrapping,
      buildChildTimeoutMs,
    );
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

    const artifacts = {
      temporaryDirectory,
      sourceDirectory,
      bundleDirectory,
      sourceManifestPath,
      bundleManifestPath,
      manifest,
      outputFiles: built.output.map((output) => output.fileName).sort(),
      runtimeIdentity,
    };
    try {
      return {
        status: "ok",
        value: await callback(artifacts),
      };
    } catch (error) {
      return await reportFailure(
        failure("harness-error", "consume-output", packageSpecifier, error),
      );
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function inspectRolldownRuntimeIdentity(
  packageSpecifier: string,
): Promise<ObservedRuntimeIdentity> {
  let resolvedEntryUrl: string | null = null;
  let resolvedEntryPath: string | null = null;
  let packageVersion: string | null = null;
  let resolvedEntrySha256: string | null = null;
  let packageRootPath: string | null = null;
  let packageJsonPath: string | null = null;
  let packageContentSha256: string | null = null;
  let packageContentFiles: readonly string[] = [];
  let optionalBindingPackages: readonly ObservedBindingPackageIdentity[] = [];

  try {
    resolvedEntryUrl = import.meta.resolve(packageSpecifier);
  } catch {}

  if (resolvedEntryUrl?.startsWith("file:") === true) {
    try {
      resolvedEntryPath = await realpath(fileURLToPath(resolvedEntryUrl));
      resolvedEntryUrl = pathToFileURL(resolvedEntryPath).href;
      const contents = await readFile(resolvedEntryPath);
      resolvedEntrySha256 = createHash("sha256").update(contents).digest("hex");
    } catch {}

    if (resolvedEntryPath !== null) {
      const packageInfo = await findNearestPackageInfo(dirname(resolvedEntryPath));
      if (packageInfo !== null) {
        packageRootPath = packageInfo.rootPath;
        packageJsonPath = packageInfo.packageJsonPath;
        packageVersion = packageInfo.version;
        const packageContent = await hashPackageContents(packageInfo.rootPath);
        packageContentSha256 = packageContent.sha256;
        packageContentFiles = packageContent.files;
        optionalBindingPackages = await inspectOptionalBindingPackages(packageInfo);
      }
    }
  }

  const lockfile = await inspectFuzzerLockfile();
  const napiRsNativeLibrary = await inspectNativeLibraryOverride(
    resolvedEntryPath,
    packageRootPath,
  );

  return {
    processVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    requestedPackageSpecifier: packageSpecifier,
    resolvedEntryUrl,
    resolvedEntryPath,
    packageVersion,
    resolvedEntrySha256,
    packageRootPath,
    packageJsonPath,
    packageContentSha256,
    packageContentFiles,
    fuzzerLockfilePath: lockfile.path,
    fuzzerLockfileSha256: lockfile.sha256,
    optionalBindingPackages,
    napiRsNativeLibrary,
  };
}

async function inspectNativeLibraryOverride(
  resolvedEntryPath: string | null,
  packageRootPath: string | null,
): Promise<ObservedNativeLibraryOverrideIdentity> {
  const requested = process.env.NAPI_RS_NATIVE_LIBRARY_PATH ?? null;
  const loaderCandidates =
    resolvedEntryPath === null || packageRootPath === null
      ? []
      : await findRuntimeBindingLoaderCandidates(resolvedEntryPath, packageRootPath);
  const loaderPath = loaderCandidates.length === 1 ? (loaderCandidates[0] ?? null) : null;
  if (requested !== null && isAbsolute(requested)) {
    try {
      const realPath = await realpath(requested);
      return {
        requested,
        loaderPath: null,
        loaderCandidates,
        resolvedPath: requested,
        realPath,
        sha256: createHash("sha256")
          .update(await readFile(realPath))
          .digest("hex"),
      };
    } catch {
      return {
        requested,
        loaderPath: null,
        loaderCandidates,
        resolvedPath: null,
        realPath: null,
        sha256: null,
      };
    }
  }
  if (requested === null || loaderPath === null) {
    return {
      requested,
      loaderPath,
      loaderCandidates,
      resolvedPath: null,
      realPath: null,
      sha256: null,
    };
  }

  try {
    const resolvedPath = createRequire(loaderPath).resolve(requested);
    const realPath = await realpath(resolvedPath);
    return {
      requested,
      loaderPath,
      loaderCandidates,
      resolvedPath,
      realPath,
      sha256: createHash("sha256")
        .update(await readFile(realPath))
        .digest("hex"),
    };
  } catch {
    return {
      requested,
      loaderPath,
      loaderCandidates,
      resolvedPath: null,
      realPath: null,
      sha256: null,
    };
  }
}

async function findRuntimeBindingLoaderCandidates(
  resolvedEntryPath: string,
  packageRootPath: string,
): Promise<readonly string[]> {
  const packageDist = join(packageRootPath, "dist");
  const entryRelativePath = relative(packageRootPath, resolvedEntryPath);
  const runtimeRoot =
    entryRelativePath === "dist" || entryRelativePath.startsWith(`dist${sep}`)
      ? packageDist
      : (await directoryExists(packageDist))
        ? packageDist
        : null;
  if (runtimeRoot === null) {
    return [];
  }

  const candidates: string[] = [];
  const pending = [runtimeRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      continue;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".js") || entry.name.endsWith(".mjs") || entry.name.endsWith(".cjs"))
      ) {
        try {
          if ((await readFile(path, "utf8")).includes("NAPI_RS_NATIVE_LIBRARY_PATH")) {
            candidates.push(await realpath(path));
          }
        } catch {}
      }
    }
  }
  return [...new Set(candidates)].sort();
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

interface PackageInfo {
  readonly rootPath: string;
  readonly packageJsonPath: string;
  readonly version: string | null;
  readonly optionalBindingNames: readonly string[];
}

async function findNearestPackageInfo(startDirectory: string): Promise<PackageInfo | null> {
  let directory = startDirectory;
  while (true) {
    try {
      const packageJsonPath = join(directory, "package.json");
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        readonly optionalDependencies?: unknown;
        readonly version?: unknown;
      };
      return {
        rootPath: await realpath(directory),
        packageJsonPath: await realpath(packageJsonPath),
        version: typeof packageJson.version === "string" ? packageJson.version : null,
        optionalBindingNames: readOptionalBindingNames(packageJson.optionalDependencies),
      };
    } catch {}

    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

function readOptionalBindingNames(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value)
    .filter((name) => name.startsWith("@rolldown/binding-"))
    .sort();
}

async function inspectOptionalBindingPackages(
  packageInfo: PackageInfo,
): Promise<readonly ObservedBindingPackageIdentity[]> {
  const requireFromPackage = createRequire(packageInfo.packageJsonPath);
  const identities: ObservedBindingPackageIdentity[] = [];
  for (const name of packageInfo.optionalBindingNames) {
    try {
      const packageJsonPath = await realpath(requireFromPackage.resolve(`${name}/package.json`));
      const packageRootPath = await realpath(dirname(packageJsonPath));
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        readonly version?: unknown;
      };
      const contents = await hashPackageContents(packageRootPath);
      identities.push({
        name,
        version: typeof packageJson.version === "string" ? packageJson.version : null,
        packageRootPath,
        packageJsonPath,
        contentSha256: contents.sha256,
        contentFiles: contents.files,
      });
    } catch {}
  }
  return identities.sort((left, right) => left.name.localeCompare(right.name));
}

interface PackageFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly symlinkRealPath: string | null;
}

async function hashPackageContents(
  packageRoot: string,
): Promise<{ readonly sha256: string | null; readonly files: readonly string[] }> {
  try {
    const allFiles = await collectPackageFiles(packageRoot);
    const totalSize = allFiles.reduce((sum, file) => sum + file.size, 0);
    const selected =
      allFiles.length <= COMPACT_PACKAGE_MAX_FILES && totalSize <= COMPACT_PACKAGE_MAX_BYTES
        ? allFiles
        : allFiles.filter(isRuntimeRelevantPackageFile);
    const sorted = [...selected].sort((left, right) => left.path.localeCompare(right.path));
    const hash = createHash("sha256");
    for (const file of sorted) {
      hash.update(file.path).update(Uint8Array.of(0));
      if (file.symlinkRealPath !== null) {
        hash.update(file.symlinkRealPath).update(Uint8Array.of(0));
      }
      hash.update(await readFile(file.absolutePath)).update(Uint8Array.of(0));
    }
    return {
      sha256: hash.digest("hex"),
      files: sorted.map((file) => file.path),
    };
  } catch {
    return { sha256: null, files: [] };
  }
}

async function collectPackageFiles(packageRoot: string): Promise<readonly PackageFile[]> {
  const files: PackageFile[] = [];
  const pending: { readonly directory: string; readonly relativePath: string }[] = [
    { directory: packageRoot, relativePath: "" },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    const entries = await readdir(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      const path =
        current.relativePath.length === 0 ? entry.name : `${current.relativePath}/${entry.name}`;
      const absolutePath = join(current.directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (path.endsWith(".node")) {
          try {
            const symlinkRealPath = await realpath(absolutePath);
            const metadata = await lstat(symlinkRealPath);
            if (metadata.isFile()) {
              files.push({
                path,
                absolutePath: symlinkRealPath,
                size: metadata.size,
                symlinkRealPath,
              });
            }
          } catch {}
        }
      } else if (entry.isDirectory()) {
        if (!IGNORED_PACKAGE_DIRECTORIES.has(entry.name)) {
          pending.push({ directory: absolutePath, relativePath: path });
        }
      } else if (entry.isFile()) {
        const metadata = await lstat(absolutePath);
        files.push({
          path,
          absolutePath,
          size: metadata.size,
          symlinkRealPath: null,
        });
      }
    }
  }
  return files;
}

function isRuntimeRelevantPackageFile(file: PackageFile): boolean {
  return (
    file.path === "package.json" ||
    file.path === "bin" ||
    file.path.startsWith("bin/") ||
    file.path.startsWith("dist/") ||
    file.path.endsWith(".node")
  );
}

async function inspectFuzzerLockfile(): Promise<{
  readonly path: string | null;
  readonly sha256: string | null;
}> {
  for (const name of ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]) {
    try {
      const path = await realpath(join(FUZZER_ROOT, name));
      return {
        path,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      };
    } catch {}
  }
  return { path: null, sha256: null };
}

interface BuiltRolldown {
  readonly status: "ok";
  readonly output: readonly BuildChildOutputFile[];
}

interface FailedRolldownBuild {
  readonly status: "failed";
  readonly failure: FailedRolldownAdapterResult;
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

async function buildWithChild(
  program: ProgramModel,
  rendered: RenderedProgram,
  entryInputNames: ReadonlyMap<string, string>,
  sourceDirectory: string,
  bundleDirectory: string,
  temporaryDirectory: string,
  packageSpecifier: string,
  onDemandWrapping: boolean,
  timeoutMs: number,
): Promise<BuiltRolldown | FailedRolldownBuild> {
  const requestPath = join(temporaryDirectory, "build-request.json");
  const responsePath = join(temporaryDirectory, "build-response.json");
  const phasePath = join(temporaryDirectory, "build-phase.json");
  const request: BuildChildRequest = {
    version: BUILD_CHILD_PROTOCOL_VERSION,
    packageSpecifier,
    input: Object.fromEntries(
      program.entries.map((entry) => [
        requiredEntryInputName(entryInputNames, entry.name),
        resolve(sourceDirectory, requiredPath(rendered.entryPaths, entry.name, "entry")),
      ]),
    ),
    preserveEntrySignatures: ROLLDOWN_BUILD_OPTIONS.preserveEntrySignatures,
    onDemandWrapping,
    bundleDirectory,
    manualChunkGroups: (program.manualChunkGroups ?? []).map((group) => ({
      name: group.name,
      modulePaths: group.moduleIds.map((moduleId) =>
        resolve(sourceDirectory, requiredPath(rendered.modulePaths, moduleId, "module")),
      ),
    })),
    // Organic (size/share-driven) groups pass through as serializable descriptors; the child maps
    // them onto rolldown's `codeSplitting.groups` and reconstructs each regex `test` from its source.
    organicChunkGroups: (program.organicChunkGroups ?? []).map((group) => ({
      name: group.name,
      ...(group.test === undefined ? {} : { test: group.test }),
      ...(group.minSize === undefined ? {} : { minSize: group.minSize }),
      ...(group.maxSize === undefined ? {} : { maxSize: group.maxSize }),
      ...(group.minShareCount === undefined ? {} : { minShareCount: group.minShareCount }),
      ...(group.priority === undefined ? {} : { priority: group.priority }),
      ...(group.includeDependenciesRecursively === undefined
        ? {}
        : { includeDependenciesRecursively: group.includeDependenciesRecursively }),
    })),
    output: {
      format: ROLLDOWN_BUILD_OPTIONS.format,
      strictExecutionOrder: ROLLDOWN_BUILD_OPTIONS.strictExecutionOrder,
      entryFileNames: ROLLDOWN_BUILD_OPTIONS.entryFileNames,
      chunkFileNames: ROLLDOWN_BUILD_OPTIONS.chunkFileNames,
      assetFileNames: ROLLDOWN_BUILD_OPTIONS.assetFileNames,
      cleanDir: ROLLDOWN_BUILD_OPTIONS.cleanDir,
      minify: ROLLDOWN_BUILD_OPTIONS.minify,
    },
  };
  await writeFile(requestPath, `${JSON.stringify(request)}\n`);

  const childResult = await runBuildChildProcess(
    temporaryDirectory,
    requestPath,
    responsePath,
    phasePath,
    timeoutMs,
  );
  if (childResult.status === "spawn-error") {
    return {
      status: "failed",
      failure: failure("harness-error", "build", packageSpecifier, childResult.error),
    };
  }
  if (childResult.status === "timeout") {
    return {
      status: "failed",
      failure: failure(
        "harness-error",
        "build",
        packageSpecifier,
        new Error(`Build child timed out after ${childResult.timeoutMs}ms`),
      ),
    };
  }
  if (childResult.code !== 0 || childResult.signal !== null) {
    const descriptor =
      childResult.signal === null
        ? `exit code ${String(childResult.code)}`
        : `signal ${childResult.signal}`;
    // A crash after the package loaded is a genuine Rolldown build panic (a Rust panic or napi fatal
    // that aborts the process); a crash before it is harness misconfiguration. The phase marker,
    // written by the child once the package imports, disambiguates the two.
    if (await buildPackageLoaded(phasePath)) {
      return {
        status: "failed",
        failure: {
          status: "build-error",
          stage: "build",
          packageSpecifier,
          error: {
            name: "RolldownBuildPanic",
            message: `Rolldown build process crashed with ${descriptor}`,
          },
          panic: true,
        },
      };
    }
    return {
      status: "failed",
      failure: failure(
        "harness-error",
        "build",
        packageSpecifier,
        new Error(`Build child crashed during startup with ${descriptor}`),
      ),
    };
  }

  let response: BuildChildResponse;
  try {
    response = parseBuildChildResponse(
      JSON.parse(await readFile(responsePath, "utf8")) as unknown,
      bundleDirectory,
    );
  } catch (error) {
    return {
      status: "failed",
      failure: failure("harness-error", "build", packageSpecifier, error),
    };
  }
  if (response.version !== BUILD_CHILD_PROTOCOL_VERSION) {
    return {
      status: "failed",
      failure: failure(
        "harness-error",
        "build",
        packageSpecifier,
        new Error(`Unsupported build child version ${String(response.version)}`),
      ),
    };
  }
  if (response.status === "failure") {
    return {
      status: "failed",
      failure: {
        status: response.failureStatus,
        stage: response.stage,
        packageSpecifier,
        error: response.error,
        ...(response.panic === true ? { panic: true } : {}),
      },
    };
  }
  return {
    status: "ok",
    output: response.outputFiles,
  };
}

/// Whether the build child recorded that the Rolldown package imported cleanly. A crash after this
/// marker is written is attributed to the build (a panic); a crash before it is a startup/harness
/// problem. A missing or unreadable marker is treated as "not loaded".
async function buildPackageLoaded(phasePath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(phasePath, "utf8")) as { readonly phase?: unknown };
    return parsed.phase === BUILD_PHASE_PACKAGE_LOADED;
  } catch {
    return false;
  }
}

export type BuildChildProcessResult =
  | { readonly status: "spawn-error"; readonly error: Error }
  | { readonly status: "timeout"; readonly timeoutMs: number }
  | {
      readonly status: "closed";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

export type BuildChildProcessLike = Pick<ChildProcess, "pid" | "once" | "off" | "kill">;

export interface BuildChildWaitOptions {
  readonly terminationGraceMs?: number;
  readonly finalCloseGraceMs?: number;
  readonly terminate?: (child: BuildChildProcessLike, force: boolean) => void;
}

async function runBuildChildProcess(
  cwd: string,
  requestPath: string,
  responsePath: string,
  phasePath: string,
  timeoutMs: number,
): Promise<BuildChildProcessResult> {
  const child = spawn(
    process.execPath,
    [
      ...buildChildExecArgv(process.execArgv),
      BUILD_CHILD_PATH,
      requestPath,
      responsePath,
      phasePath,
    ],
    {
      cwd,
      detached: process.platform !== "win32",
      stdio: "ignore",
      windowsHide: true,
    },
  );
  return waitForBuildChildProcess(child, timeoutMs);
}

export async function waitForBuildChildProcess(
  child: BuildChildProcessLike,
  timeoutMs: number,
  options: BuildChildWaitOptions = {},
): Promise<BuildChildProcessResult> {
  const terminationGraceMs = options.terminationGraceMs ?? BUILD_CHILD_TERMINATION_GRACE_MS;
  const finalCloseGraceMs = options.finalCloseGraceMs ?? BUILD_CHILD_FINAL_CLOSE_GRACE_MS;
  const terminate = options.terminate ?? terminateChildProcessTree;

  return new Promise((resolveResult) => {
    let settled = false;
    let timedOut = false;
    let childClosed = false;
    let forceTerminationSent = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finalCloseTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      if (finalCloseTimer !== undefined) {
        clearTimeout(finalCloseTimer);
      }
      child.off("error", onError);
      child.off("close", onClose);
    };
    const settle = (result: BuildChildProcessResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolveResult(result);
    };
    const onError = (error: Error) => {
      if (!timedOut) {
        settle({ status: "spawn-error", error });
      }
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      childClosed = true;
      if (!timedOut) {
        settle({ status: "closed", code, signal });
      } else if (forceTerminationSent) {
        settle({ status: "timeout", timeoutMs });
      }
    };
    timeoutTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      terminate(child, false);
      killTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        forceTerminationSent = true;
        terminate(child, true);
        if (childClosed) {
          settle({ status: "timeout", timeoutMs });
        } else {
          finalCloseTimer = setTimeout(() => {
            settle({ status: "timeout", timeoutMs });
          }, finalCloseGraceMs);
        }
      }, terminationGraceMs);
    }, timeoutMs);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function terminateChildProcessTree(child: BuildChildProcessLike, force: boolean): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    });
    killer.once("close", (code) => {
      if (code !== 0) {
        child.kill(force ? "SIGKILL" : "SIGTERM");
      }
    });
    killer.unref();
    return;
  }

  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

export function buildChildExecArgv(execArgv: readonly string[]): readonly string[] {
  const result: string[] = [];
  const flagsWithValues = new Set([
    "--conditions",
    "--import",
    "--require",
    "-r",
    "--loader",
    "--experimental-loader",
  ]);
  const standalone = new Set([
    "--enable-source-maps",
    "--no-warnings",
    "--trace-warnings",
    "--experimental-strip-types",
    "--no-experimental-strip-types",
    "--experimental-transform-types",
  ]);
  const allowedPrefixes = [
    "--conditions=",
    "--import=",
    "--require=",
    "--loader=",
    "--experimental-loader=",
    "--disable-warning=",
  ];
  const discardedValueFlags = new Set(["--eval", "-e", "--print", "-p", "--inspect-port"]);

  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = execArgv[index];
    if (argument === undefined) {
      continue;
    }
    if (discardedValueFlags.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("--inspect") || argument.startsWith("--debug")) {
      continue;
    }
    if (flagsWithValues.has(argument)) {
      const value = execArgv[index + 1];
      if (value !== undefined) {
        result.push(argument, value);
        index += 1;
      }
      continue;
    }
    if (standalone.has(argument) || allowedPrefixes.some((prefix) => argument.startsWith(prefix))) {
      result.push(argument);
    }
  }
  return result;
}

type OutputChunkMetadata = BuildChildOutputFile & {
  readonly type: "chunk";
  readonly name: string;
  readonly isEntry: true;
  readonly facadeModuleId: string | null;
};

function isOutputChunkMetadata(output: BuildChildOutputFile): output is OutputChunkMetadata {
  return (
    output.type === "chunk" &&
    typeof output.name === "string" &&
    output.isEntry === true &&
    (typeof output.facadeModuleId === "string" || output.facadeModuleId === null)
  );
}

function createBundleManifest(
  program: ProgramModel,
  rendered: RenderedProgram,
  entryInputNames: ReadonlyMap<string, string>,
  sourceDirectory: string,
  output: readonly BuildChildOutputFile[],
): ExecutionManifest {
  const entryChunks = output.filter(isOutputChunkMetadata);
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
  unusedChunks: Set<OutputChunkMetadata>,
): OutputChunkMetadata | undefined {
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
  chunk: OutputChunkMetadata,
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
