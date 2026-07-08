import type { EventValue, ModuleFormat, ScheduleOperation } from "./model.ts";

export const EXECUTION_PROTOCOL_VERSION = 1 as const;
export const MAX_EXECUTION_EVENTS = 512 as const;

export interface ExecutionManifestEntry {
  readonly name: string;
  readonly path: string;
  readonly format: ModuleFormat;
}

export interface ExecutionManifest {
  readonly version: typeof EXECUTION_PROTOCOL_VERSION;
  readonly entries: readonly ExecutionManifestEntry[];
  readonly operations: readonly ScheduleOperation[];
}

export interface ExecutionEvent {
  readonly version: typeof EXECUTION_PROTOCOL_VERSION;
  readonly module: string;
  readonly phase: string;
  readonly value: EventValue;
}

export interface NormalizedError {
  readonly name: string;
  readonly message: string;
}

interface ExecutionOutcomeBase {
  readonly version: typeof EXECUTION_PROTOCOL_VERSION;
  readonly events: readonly ExecutionEvent[];
  readonly operationBoundaries?: readonly number[];
}

export interface SuccessfulExecutionOutcome extends ExecutionOutcomeBase {
  readonly status: "ok";
}

export interface ErrorExecutionOutcome extends ExecutionOutcomeBase {
  readonly status: "error";
  readonly error: NormalizedError;
}

export interface HarnessErrorExecutionOutcome extends ExecutionOutcomeBase {
  readonly status: "harness-error";
  readonly error: NormalizedError;
}

export interface TimeoutExecutionOutcome extends ExecutionOutcomeBase {
  readonly status: "timeout";
}

export type ExecutionOutcome =
  | SuccessfulExecutionOutcome
  | ErrorExecutionOutcome
  | HarnessErrorExecutionOutcome
  | TimeoutExecutionOutcome;

export function parseExecutionManifest(value: unknown): ExecutionManifest {
  const manifest = requireRecord(value, "execution manifest");
  requireVersion(manifest.version, "execution manifest");
  const entries = requireArray(manifest.entries, "execution manifest entries").map(
    parseManifestEntry,
  );
  const operations = requireArray(manifest.operations, "execution manifest operations").map(
    parseScheduleOperation,
  );

  return {
    version: EXECUTION_PROTOCOL_VERSION,
    entries,
    operations,
  };
}

export function parseExecutionOutcome(value: unknown): ExecutionOutcome {
  const outcome = requireRecord(value, "execution outcome");
  requireVersion(outcome.version, "execution outcome");
  const status = requireString(outcome.status, "execution outcome status");
  const events = requireArray(outcome.events, "execution outcome events").map(parseExecutionEvent);
  const operationBoundaries =
    outcome.operationBoundaries === undefined
      ? undefined
      : requireArray(outcome.operationBoundaries, "execution outcome operationBoundaries").map(
          (boundary) => requireNonNegativeInteger(boundary, "execution operation boundary"),
        );
  const boundaryData = operationBoundaries === undefined ? {} : { operationBoundaries };

  if (status === "ok") {
    return { version: EXECUTION_PROTOCOL_VERSION, status, events, ...boundaryData };
  }
  if (status === "timeout") {
    return { version: EXECUTION_PROTOCOL_VERSION, status, events, ...boundaryData };
  }
  if (status === "error" || status === "harness-error") {
    return {
      version: EXECUTION_PROTOCOL_VERSION,
      status,
      events,
      ...boundaryData,
      error: parseNormalizedError(outcome.error),
    };
  }

  throw new Error(`Unsupported execution outcome status ${JSON.stringify(status)}`);
}

export function collectExecutionEvent(value: unknown): ExecutionEvent {
  const event = requireRecord(value, "execution event");
  return {
    version: EXECUTION_PROTOCOL_VERSION,
    module: requireString(event.module, "execution event module"),
    phase: requireString(event.phase, "execution event phase"),
    value: requireEventValue(event.value),
  };
}

function parseManifestEntry(value: unknown): ExecutionManifestEntry {
  const entry = requireRecord(value, "execution manifest entry");
  const format = requireString(entry.format, "execution manifest entry format");
  if (format !== "esm" && format !== "cjs") {
    throw new Error(`Unsupported execution manifest entry format ${JSON.stringify(format)}`);
  }

  return {
    name: requireString(entry.name, "execution manifest entry name"),
    path: requireString(entry.path, "execution manifest entry path"),
    format,
  };
}

function parseScheduleOperation(value: unknown): ScheduleOperation {
  const operation = requireRecord(value, "schedule operation");
  const kind = requireString(operation.kind, "schedule operation kind");

  if (kind === "import-entry" || kind === "require-entry") {
    return {
      kind,
      entry: requireString(operation.entry, "schedule operation entry"),
    };
  }
  if (kind === "trigger-dynamic-import") {
    return {
      kind,
      registration: requireString(operation.registration, "schedule operation registration"),
    };
  }

  throw new Error(`Unsupported schedule operation kind ${JSON.stringify(kind)}`);
}

function parseExecutionEvent(value: unknown): ExecutionEvent {
  const event = requireRecord(value, "execution event");
  requireVersion(event.version, "execution event");
  return {
    version: EXECUTION_PROTOCOL_VERSION,
    module: requireString(event.module, "execution event module"),
    phase: requireString(event.phase, "execution event phase"),
    value: requireEventValue(event.value),
  };
}

function parseNormalizedError(value: unknown): NormalizedError {
  const error = requireRecord(value, "normalized error");
  return {
    name: requireString(error.name, "normalized error name"),
    message: requireString(error.message, "normalized error message"),
  };
}

function requireEventValue(value: unknown): EventValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error("Execution event value must be a primitive JSON value");
}

function requireNonNegativeInteger(value: unknown, description: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${description} must be a non-negative safe integer`);
  }
  return value as number;
}

function requireVersion(value: unknown, description: string): void {
  if (value !== EXECUTION_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported ${description} version ${JSON.stringify(value)}; expected ${EXECUTION_PROTOCOL_VERSION}`,
    );
  }
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${description} to be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, description: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${description} to be an array`);
  }
  return value;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${description} to be a string`);
  }
  return value;
}
