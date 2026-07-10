import { isScheduleMarker } from "./protocol.ts";
import type { ExecutionEvent, ExecutionOutcome, NormalizedError } from "./protocol.ts";

export interface PassingVerdict {
  readonly kind: "pass";
  readonly signature: "pass";
}

export interface InvalidSourceVerdict {
  readonly kind: "invalid-source";
  readonly reason: "source-timeout";
  readonly signature: "invalid-source:source-timeout";
}

export interface InvalidHarnessVerdict {
  readonly kind: "invalid-harness";
  readonly reason: "source-harness-error" | "bundle-harness-error";
  readonly signature: string;
}

export type MismatchReason =
  | "bundle-only-crash"
  | "source-crash-suppressed"
  | "error-mismatch"
  | "timeout-mismatch"
  | "events-reordered"
  | "events-missing"
  | "events-extra"
  | "events-mismatch"
  // The reachability-isolation oracle's verdict (W14c, `seo:false`): the bundle executed a module
  // outside the reachability of the entries loaded so far — a cross-entry leak (the #9998 class).
  | "reachability-isolation";

export interface MismatchVerdict {
  readonly kind: "mismatch";
  readonly reason: MismatchReason;
  readonly signature: string;
}

export type Verdict =
  | PassingVerdict
  | InvalidSourceVerdict
  | InvalidHarnessVerdict
  | MismatchVerdict;

const PASS = { kind: "pass", signature: "pass" } as const satisfies PassingVerdict;

/// How the two event streams are compared. The DEFAULT (`compareEvents`) is the full-order oracle: the
/// bundle must reproduce the source's event sequence exactly (phase-marker aware). A `seo:false` case
/// swaps in the reachability-isolation oracle (`src/isolation-oracle.ts`), which checks a set-based
/// invariant instead — legal relaxed-order reshuffles do not red it, only cross-entry leaks do. This is
/// the ONE seam the order policy plugs into, so campaign / replay / shrink / identity all inherit it by
/// passing the SAME comparator derived from the persisted `BuildConfig`.
export type EventComparator = (
  expected: readonly ExecutionEvent[],
  actual: readonly ExecutionEvent[],
) => PassingVerdict | MismatchVerdict;

export function classifyVerdict(
  source: ExecutionOutcome,
  bundle: ExecutionOutcome,
  compareEventsFn: EventComparator = compareEvents,
): Verdict {
  if (source.status === "harness-error") {
    return invalidHarness("source-harness-error", "source", source.error);
  }
  if (source.status === "timeout") {
    return {
      kind: "invalid-source",
      reason: "source-timeout",
      signature: "invalid-source:source-timeout",
    };
  }

  if (bundle.status === "harness-error") {
    return invalidHarness("bundle-harness-error", "bundle", bundle.error);
  }

  if (source.status === "error") {
    if (bundle.status === "timeout") {
      return mismatch(
        "timeout-mismatch",
        `timeout-mismatch:source=error:${serializeError(source.error)}:bundle=timeout`,
      );
    }
    if (bundle.status === "ok") {
      return mismatch(
        "source-crash-suppressed",
        `source-crash-suppressed:${serializeError(source.error)}`,
      );
    }
    if (!errorsEqual(source.error, bundle.error)) {
      return mismatch(
        "error-mismatch",
        `error-mismatch:source=${serializeError(source.error)}:bundle=${serializeError(bundle.error)}`,
      );
    }
    const eventVerdict = compareEventsFn(source.events, bundle.events);
    if (eventVerdict.kind === "pass") {
      return eventVerdict;
    }
    return mismatch(
      eventVerdict.reason,
      `${eventVerdict.reason}:error=${serializeError(source.error)}:${eventVerdict.signature.slice(eventVerdict.reason.length + 1)}`,
    );
  }

  if (bundle.status === "timeout") {
    return mismatch("timeout-mismatch", "timeout-mismatch:source=ok:bundle=timeout");
  }
  if (bundle.status === "error") {
    return mismatch("bundle-only-crash", `bundle-only-crash:${serializeError(bundle.error)}`);
  }

  return compareEventsFn(source.events, bundle.events);
}

function compareEvents(
  expected: readonly ExecutionEvent[],
  actual: readonly ExecutionEvent[],
): PassingVerdict | MismatchVerdict {
  if (eventsEqual(expected, actual)) {
    return PASS;
  }

  let reason: Extract<MismatchReason, `events-${string}`>;
  if (isStrictSubsequence(actual, expected)) {
    reason = "events-missing";
  } else if (isStrictSubsequence(expected, actual)) {
    reason = "events-extra";
  } else if (sameEventMultiset(expected, actual)) {
    reason = "events-reordered";
  } else {
    reason = "events-mismatch";
  }

  const diff = diffEvents(expected, actual, reason);
  return mismatch(reason, eventMismatchSignature(reason, diff.source, diff.bundle));
}

interface EventDiff {
  readonly source: readonly ExecutionEvent[];
  readonly bundle: readonly ExecutionEvent[];
}

function diffEvents(
  source: readonly ExecutionEvent[],
  bundle: readonly ExecutionEvent[],
  reason: Extract<MismatchReason, `events-${string}`>,
): EventDiff {
  const prefixLength = commonPrefixLength(source, bundle);
  const suffixLength = commonSuffixLength(source, bundle, prefixLength);
  const sourceChanged = source.slice(prefixLength, source.length - suffixLength);
  const bundleChanged = bundle.slice(prefixLength, bundle.length - suffixLength);

  if (reason === "events-reordered") {
    return diffReorderedEvents(sourceChanged, bundleChanged);
  }

  return diffEventsWithLcs(sourceChanged, bundleChanged);
}

function diffReorderedEvents(
  source: readonly ExecutionEvent[],
  bundle: readonly ExecutionEvent[],
): EventDiff {
  const unmatchedSource: ExecutionEvent[] = [];
  const unmatchedBundle: ExecutionEvent[] = [];
  const length = Math.max(source.length, bundle.length);

  for (let index = 0; index < length; index += 1) {
    const sourceEvent = source[index];
    const bundleEvent = bundle[index];
    if (eventEqual(sourceEvent, bundleEvent)) {
      continue;
    }
    if (sourceEvent !== undefined) {
      unmatchedSource.push(sourceEvent);
    }
    if (bundleEvent !== undefined) {
      unmatchedBundle.push(bundleEvent);
    }
  }

  return { source: unmatchedSource, bundle: unmatchedBundle };
}

function diffEventsWithLcs(
  source: readonly ExecutionEvent[],
  bundle: readonly ExecutionEvent[],
): EventDiff {
  // The child runner caps executions at 512 events, so this exact table is at most
  // 513^2 cells and its LCS lengths fit safely in Uint16Array.
  const columnCount = bundle.length + 1;
  const lengths = new Uint16Array((source.length + 1) * columnCount);
  const sourceKeys = source.map(serializeEvent);
  const bundleKeys = bundle.map(serializeEvent);

  for (let sourceIndex = source.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
    for (let bundleIndex = bundle.length - 1; bundleIndex >= 0; bundleIndex -= 1) {
      const tableIndex = sourceIndex * columnCount + bundleIndex;
      lengths[tableIndex] =
        sourceKeys[sourceIndex] === bundleKeys[bundleIndex]
          ? (lengths[(sourceIndex + 1) * columnCount + bundleIndex + 1] ?? 0) + 1
          : Math.max(
              lengths[(sourceIndex + 1) * columnCount + bundleIndex] ?? 0,
              lengths[sourceIndex * columnCount + bundleIndex + 1] ?? 0,
            );
    }
  }

  const unmatchedSource: ExecutionEvent[] = [];
  const unmatchedBundle: ExecutionEvent[] = [];
  let sourceIndex = 0;
  let bundleIndex = 0;

  while (sourceIndex < source.length && bundleIndex < bundle.length) {
    if (sourceKeys[sourceIndex] === bundleKeys[bundleIndex]) {
      sourceIndex += 1;
      bundleIndex += 1;
    } else if (
      (lengths[(sourceIndex + 1) * columnCount + bundleIndex] ?? 0) >=
      (lengths[sourceIndex * columnCount + bundleIndex + 1] ?? 0)
    ) {
      unmatchedSource.push(source[sourceIndex] as ExecutionEvent);
      sourceIndex += 1;
    } else {
      unmatchedBundle.push(bundle[bundleIndex] as ExecutionEvent);
      bundleIndex += 1;
    }
  }

  unmatchedSource.push(...source.slice(sourceIndex));
  unmatchedBundle.push(...bundle.slice(bundleIndex));
  return { source: unmatchedSource, bundle: unmatchedBundle };
}

function isStrictSubsequence(
  subsequence: readonly ExecutionEvent[],
  superset: readonly ExecutionEvent[],
): boolean {
  if (subsequence.length >= superset.length) {
    return false;
  }

  let subsequenceIndex = 0;
  for (const event of superset) {
    if (eventEqual(event, subsequence[subsequenceIndex])) {
      subsequenceIndex += 1;
    }
  }
  return subsequenceIndex === subsequence.length;
}

function eventMismatchSignature(
  reason: Extract<MismatchReason, `events-${string}`>,
  sourceChanged: readonly ExecutionEvent[],
  bundleChanged: readonly ExecutionEvent[],
): string {
  return `${reason}:source=${serializeEvents(sourceChanged)}:bundle=${serializeEvents(bundleChanged)}`;
}

function invalidHarness(
  reason: InvalidHarnessVerdict["reason"],
  side: "source" | "bundle",
  error: NormalizedError,
): InvalidHarnessVerdict {
  return {
    kind: "invalid-harness",
    reason,
    signature: `invalid-harness:${side}=${serializeError(error)}`,
  };
}

function mismatch(reason: MismatchReason, signature: string): MismatchVerdict {
  return {
    kind: "mismatch",
    reason,
    signature,
  };
}

function commonPrefixLength(
  expected: readonly ExecutionEvent[],
  actual: readonly ExecutionEvent[],
): number {
  const limit = Math.min(expected.length, actual.length);
  let index = 0;
  while (index < limit && eventEqual(expected[index], actual[index])) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(
  expected: readonly ExecutionEvent[],
  actual: readonly ExecutionEvent[],
  prefixLength: number,
): number {
  const limit = Math.min(expected.length, actual.length) - prefixLength;
  let length = 0;
  while (
    length < limit &&
    eventEqual(expected[expected.length - length - 1], actual[actual.length - length - 1])
  ) {
    length += 1;
  }
  return length;
}

function eventsEqual(
  expected: readonly ExecutionEvent[],
  actual: readonly ExecutionEvent[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every((event, index) => eventEqual(event, actual[index]))
  );
}

function eventEqual(left: ExecutionEvent | undefined, right: ExecutionEvent | undefined): boolean {
  return (
    left !== undefined && right !== undefined && serializeEvent(left) === serializeEvent(right)
  );
}

function sameEventMultiset(
  expected: readonly ExecutionEvent[],
  actual: readonly ExecutionEvent[],
): boolean {
  if (expected.length !== actual.length) {
    return false;
  }

  const counts = new Map<string, number>();
  for (const event of expected) {
    const key = serializeEvent(event);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const event of actual) {
    const key = serializeEvent(event);
    const count = counts.get(key);
    if (count === undefined) {
      return false;
    }
    if (count === 1) {
      counts.delete(key);
    } else {
      counts.set(key, count - 1);
    }
  }
  return counts.size === 0;
}

function errorsEqual(left: NormalizedError, right: NormalizedError): boolean {
  return left.name === right.name && left.message === right.message;
}

function serializeEvents(events: readonly ExecutionEvent[]): string {
  return `[${events.map(serializeEvent).join(",")}]`;
}

function serializeEvent(event: ExecutionEvent | undefined): string {
  if (event === undefined) {
    return "null";
  }
  // A schedule marker serializes to a readable, distinct tuple so a module event that ran in the
  // wrong schedule step lands on the wrong side of a marker and the comparison (and signature) sees
  // it. The `@` prefix keeps it visually apart from module ids in a failure signature.
  if (isScheduleMarker(event)) {
    return JSON.stringify(["@schedule", event.schedule, event.kind]);
  }
  return JSON.stringify([event.module, event.phase, event.value]);
}

function serializeError(error: NormalizedError): string {
  return JSON.stringify([error.name, error.message]);
}
