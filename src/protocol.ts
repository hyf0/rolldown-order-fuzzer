import type { EventRecord, EventValue, ModuleFormat, ScheduleOperation } from "./model.ts";

export const EXECUTION_PROTOCOL_VERSION = 1 as const;
export const MAX_EXECUTION_EVENTS = 512 as const;

// Fixture modules deliberately monkey-patch constant-evaluated globals. Capture every mutable
// validator used after fixture execution so constructor and numeric witnesses cannot poison event
// collection.
const intrinsicArrayIsArray = Array.isArray;
const intrinsicNumberIsFinite = Number.isFinite;

/// The kind category a schedule marker records. Both entry-evaluation operations (`import-entry` and
/// `require-entry`) collapse to `entry`, and a dynamic trigger is `dynamic`. The collapse is what
/// keeps markers symmetric across source and bundle: a CJS source entry runs with `require` while its
/// all-ESM bundle entry runs with `import` (the adapter rewrites `require-entry` to `import-entry`),
/// yet both are the SAME logical schedule step, so they must emit the SAME marker.
export type ScheduleMarkerKind = "entry" | "dynamic";

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

/// A module event emitted by generated code through `globalThis.__orderEvent`: the
/// `[module, phase, value]` record the oracle has always compared.
export interface ModuleExecutionEvent extends EventRecord {
  readonly version: typeof EXECUTION_PROTOCOL_VERSION;
}

/// A RUNNER-emitted boundary appended to the event stream after each schedule operation SETTLES
/// (an entry import/require returned, a dynamic trigger awaited). It closes an oracle hole: the flat
/// event sequence alone cannot tell `[step1: A][step2: B]` from `[step1: A,B][step2: -]` — both are
/// `A,B` flat and judged EQUAL — yet the second ran module B a whole schedule step early (the
/// premature-execution family this fuzzer hunts). Interleaving a marker at every step boundary makes
/// the stream PHASE-AWARE: a module event that ran in the wrong step now lands on the wrong side of a
/// marker, so the comparison catches it. Markers are emitted by the shared child runner for BOTH
/// source and bundle, and the bundle's operation list is the source's with only `require-entry`
/// rewritten to `import-entry` (normalized away by `kind`), so markers are identical by construction
/// — they add ZERO false-positive surface. See `.agents/docs/schedule-phase-markers.md`.
export interface ScheduleMarkerEvent {
  readonly version: typeof EXECUTION_PROTOCOL_VERSION;
  readonly marker: "schedule";
  /// The zero-based index of the settled operation in the schedule.
  readonly schedule: number;
  readonly kind: ScheduleMarkerKind;
}

export type ExecutionEvent = ModuleExecutionEvent | ScheduleMarkerEvent;

export function isScheduleMarker(event: ExecutionEvent): event is ScheduleMarkerEvent {
  return "marker" in event && event.marker === "schedule";
}

export function scheduleMarkerKind(operation: ScheduleOperation): ScheduleMarkerKind {
  return operation.kind === "trigger-dynamic-import" ? "dynamic" : "entry";
}

export function makeScheduleMarker(
  index: number,
  operation: ScheduleOperation,
): ScheduleMarkerEvent {
  return {
    version: EXECUTION_PROTOCOL_VERSION,
    marker: "schedule",
    schedule: index,
    kind: scheduleMarkerKind(operation),
  };
}

export interface NormalizedError {
  readonly name: string;
  readonly message: string;
}

interface ExecutionOutcomeBase {
  readonly version: typeof EXECUTION_PROTOCOL_VERSION;
  readonly events: readonly ExecutionEvent[];
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

  if (status === "ok") {
    return { version: EXECUTION_PROTOCOL_VERSION, status, events };
  }
  if (status === "timeout") {
    return { version: EXECUTION_PROTOCOL_VERSION, status, events };
  }
  if (status === "error" || status === "harness-error") {
    return {
      version: EXECUTION_PROTOCOL_VERSION,
      status,
      events,
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
  if (event.marker !== undefined) {
    return parseScheduleMarker(event);
  }
  return {
    version: EXECUTION_PROTOCOL_VERSION,
    module: requireString(event.module, "execution event module"),
    phase: requireString(event.phase, "execution event phase"),
    value: requireEventValue(event.value),
  };
}

function parseScheduleMarker(event: Record<string, unknown>): ScheduleMarkerEvent {
  if (event.marker !== "schedule") {
    throw new Error(`Unsupported execution event marker ${JSON.stringify(event.marker)}`);
  }
  if (
    typeof event.schedule !== "number" ||
    !Number.isInteger(event.schedule) ||
    event.schedule < 0
  ) {
    throw new Error("Schedule marker index must be a non-negative integer");
  }
  if (event.kind !== "entry" && event.kind !== "dynamic") {
    throw new Error(`Unsupported schedule marker kind ${JSON.stringify(event.kind)}`);
  }
  return {
    version: EXECUTION_PROTOCOL_VERSION,
    marker: "schedule",
    schedule: event.schedule,
    kind: event.kind,
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
    (typeof value === "number" && intrinsicNumberIsFinite(value))
  ) {
    return value;
  }
  throw new Error("Execution event value must be a primitive JSON value");
}

function requireVersion(value: unknown, description: string): void {
  if (value !== EXECUTION_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported ${description} version ${JSON.stringify(value)}; expected ${EXECUTION_PROTOCOL_VERSION}`,
    );
  }
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || intrinsicArrayIsArray(value)) {
    throw new Error(`Expected ${description} to be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, description: string): readonly unknown[] {
  if (!intrinsicArrayIsArray(value)) {
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
