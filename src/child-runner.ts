/// <reference types="node" />

import { createRequire } from "node:module";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ScheduleOperation } from "./model.ts";
import {
  collectExecutionEvent,
  EXECUTION_PROTOCOL_VERSION,
  makeScheduleMarker,
  MAX_EXECUTION_EVENTS,
  parseExecutionManifest,
  type ExecutionEvent,
  type ExecutionManifest,
  type ExecutionOutcome,
  type NormalizedError,
} from "./protocol.ts";

interface OrderRuntimeGlobal {
  __orderEvent?: (event: unknown) => void;
  __orderEvents?: ExecutionEvent[];
  __orderDynamicImports?: Record<string, () => Promise<unknown>>;
}

const harnessExecutionErrors = new WeakSet<object>();
// Fixture code deliberately mutates built-ins. Capture every mutable String intrinsic used after a
// fixture executes so error normalization cannot be poisoned by the program under test (notably the
// optimizer registry's String.prototype.replaceAll assignment).
const intrinsicReflectApply = Reflect.apply;
const intrinsicStringReplaceAll: (
  this: string,
  search: string | RegExp,
  replacement: string,
) => string = Reflect.get(String.prototype, "replaceAll") as typeof String.prototype.replaceAll;

function replaceAllIntrinsic(value: string, search: string, replacement: string): string {
  return intrinsicReflectApply(intrinsicStringReplaceAll, value, [search, replacement]);
}

export async function runExecutionManifest(manifestPath: string): Promise<ExecutionOutcome> {
  const events: ExecutionEvent[] = [];
  const dynamicImports: Record<string, () => Promise<unknown>> = Object.create(null);
  const orderGlobal = globalThis as typeof globalThis & OrderRuntimeGlobal;
  orderGlobal.__orderEvents = events;
  orderGlobal.__orderEvent = (event) => {
    if (events.length >= MAX_EXECUTION_EVENTS) {
      throw new Error(`Execution event limit exceeded: maximum ${MAX_EXECUTION_EVENTS}`);
    }
    events.push(collectExecutionEvent(event));
  };
  orderGlobal.__orderDynamicImports = dynamicImports;

  let manifest: ExecutionManifest;
  try {
    manifest = parseExecutionManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
    validateExecutionManifest(manifest);
  } catch (error) {
    return executionFailure("harness-error", events, error, manifestPath);
  }

  try {
    await executeSchedule(manifest, manifestPath, dynamicImports, (index, operation) => {
      // A runner-emitted phase marker after each settled operation. It bypasses the module-event cap
      // (schedules carry only a handful of operations) and, being emitted symmetrically by this same
      // runner for source and bundle, makes the stream phase-aware without any false-positive surface.
      events.push(makeScheduleMarker(index, operation));
    });
    return {
      version: EXECUTION_PROTOCOL_VERSION,
      status: "ok",
      events,
    };
  } catch (error) {
    return executionFailure(
      isHarnessExecutionError(error) ? "harness-error" : "error",
      events,
      error,
      manifestPath,
    );
  }
}

function validateExecutionManifest(manifest: ExecutionManifest): void {
  const entries = new Map<string, ExecutionManifest["entries"][number]>();
  for (const entry of manifest.entries) {
    if (entries.has(entry.name)) {
      throw new Error(`Duplicate schedule entry ${JSON.stringify(entry.name)}`);
    }
    entries.set(entry.name, entry);
  }

  for (const operation of manifest.operations) {
    if (operation.kind === "trigger-dynamic-import") {
      continue;
    }

    const entry = entries.get(operation.entry);
    if (entry === undefined) {
      throw new Error(`Missing schedule entry ${JSON.stringify(operation.entry)}`);
    }
    if (operation.kind === "import-entry" && entry.format !== "esm") {
      throw new Error(`Cannot import CJS entry ${JSON.stringify(entry.name)}`);
    }
    if (operation.kind === "require-entry" && entry.format !== "cjs") {
      throw new Error(`Cannot require ESM entry ${JSON.stringify(entry.name)}`);
    }
  }
}

async function executeSchedule(
  manifest: ExecutionManifest,
  manifestPath: string,
  dynamicImports: Record<string, () => Promise<unknown>>,
  emitScheduleMarker: (index: number, operation: ScheduleOperation) => void,
): Promise<void> {
  const manifestDirectory = dirname(manifestPath);
  const entries = new Map(manifest.entries.map((entry) => [entry.name, entry]));
  const requireFromManifest = createRequire(pathToFileURL(manifestPath));

  for (const [index, operation] of manifest.operations.entries()) {
    if (operation.kind === "trigger-dynamic-import") {
      const trigger = dynamicImports[operation.registration];
      if (trigger === undefined) {
        throw new Error(
          `Missing dynamic import registration ${JSON.stringify(operation.registration)}`,
        );
      }
      await trigger();
      // Mark the boundary only once the dynamic trigger has fully settled.
      emitScheduleMarker(index, operation);
      continue;
    }

    const entry = entries.get(operation.entry);
    if (entry === undefined) {
      throw harnessExecutionError(`Missing schedule entry ${JSON.stringify(operation.entry)}`);
    }
    const entryPath = resolve(manifestDirectory, entry.path);

    if (operation.kind === "import-entry") {
      if (entry.format !== "esm") {
        throw harnessExecutionError(`Cannot import CJS entry ${JSON.stringify(entry.name)}`);
      }
      await import(pathToFileURL(entryPath).href);
    } else {
      if (entry.format !== "cjs") {
        throw harnessExecutionError(`Cannot require ESM entry ${JSON.stringify(entry.name)}`);
      }
      requireFromManifest(entryPath);
    }
    // Mark the boundary only once the entry has fully evaluated its synchronous subtree.
    emitScheduleMarker(index, operation);
  }
}

function harnessExecutionError(message: string): Error {
  const error = new Error(message);
  error.name = "HarnessExecutionError";
  harnessExecutionErrors.add(error);
  return error;
}

function isHarnessExecutionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && harnessExecutionErrors.has(error);
}

async function executionFailure(
  status: "error" | "harness-error",
  events: readonly ExecutionEvent[],
  error: unknown,
  manifestPath: string,
): Promise<ExecutionOutcome> {
  return {
    version: EXECUTION_PROTOCOL_VERSION,
    status,
    events,
    error: await normalizeError(error, dirname(manifestPath)),
  };
}

async function normalizeError(error: unknown, rootDirectory: string): Promise<NormalizedError> {
  const roots = new Set([rootDirectory]);
  try {
    roots.add(await realpath(rootDirectory));
  } catch {}

  const normalizedRoots = [...roots].sort((left, right) => right.length - left.length);
  const normalizeMessage = (message: string) => {
    let normalized = replaceAllIntrinsic(message, "\r\n", "\n");
    for (const root of normalizedRoots) {
      if (normalized === root || normalized === pathToFileURL(root).href) {
        return "<root>";
      }
      const rootUrl = pathToFileURL(root).href;
      normalized = replaceAllIntrinsic(
        normalized,
        rootUrl.endsWith("/") ? rootUrl : `${rootUrl}/`,
        "<root>/",
      );
      for (const rootPath of pathForms(root)) {
        if (normalized === rootPath) {
          return "<root>";
        }
        normalized = replaceAllIntrinsic(normalized, `${rootPath}/`, "<root>/");
        normalized = replaceAllIntrinsic(normalized, `${rootPath}\\`, "<root>/");
      }
    }
    return normalized;
  };

  if (isErrorInstance(error)) {
    return {
      name: readErrorName(error),
      message: normalizeMessage(readErrorMessage(error)),
    };
  }

  return {
    name: "NonError",
    message: normalizeMessage(describeThrownValue(error)),
  };
}

function pathForms(path: string): readonly string[] {
  return [
    ...new Set([path, replaceAllIntrinsic(path, "\\", "/"), replaceAllIntrinsic(path, "/", "\\")]),
  ];
}

function isErrorInstance(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function readErrorName(error: Error): string {
  let name: unknown;
  try {
    name = error.name;
  } catch {
    return "Error";
  }
  return typeof name === "string" && name.length > 0 ? name : "Error";
}

function readErrorMessage(error: Error): string {
  let message: unknown;
  try {
    message = error.message;
  } catch {
    return "<unreadable error message>";
  }
  return typeof message === "string" ? message : describeThrownValue(message);
}

function describeThrownValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "bigint") {
    return `${String(value)}n`;
  }

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

async function main(): Promise<void> {
  const manifestPath = process.argv[2];
  const resultPath = process.argv[3];
  if (manifestPath === undefined || resultPath === undefined) {
    process.stderr.write("Usage: child-runner.ts <manifest-path> <result-path>\n");
    process.exitCode = 2;
    return;
  }

  const outcome = await runExecutionManifest(resolve(manifestPath));
  await writeFile(resolve(resultPath), `${JSON.stringify(outcome)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
