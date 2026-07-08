import { describe, expect, test } from "vite-plus/test";

import type { ExecutionEvent, ExecutionOutcome, NormalizedError } from "../src/protocol.ts";
import { classifyVerdict } from "../src/verdict.ts";

describe("classifyVerdict", () => {
  test("passes matching successful outcomes", () => {
    const events = [event("a", 1), event("b", 2)];

    expect(classifyVerdict(ok(events), ok(events))).toEqual({
      kind: "pass",
      signature: "pass",
    });
  });

  test("classifies a source timeout as an invalid oracle before inspecting the bundle", () => {
    expect(classifyVerdict(timeout(), error({ name: "Error", message: "bundle failed" }))).toEqual({
      kind: "invalid-source",
      reason: "source-timeout",
      signature: "invalid-source:source-timeout",
    });
  });

  test("classifies a bundle-only error", () => {
    expect(classifyVerdict(ok([event("entry", 1)]), error(typeError("bundle failed")))).toEqual({
      kind: "mismatch",
      reason: "bundle-only-crash",
      signature: 'bundle-only-crash:["TypeError","bundle failed"]',
    });
  });

  test("classifies suppression of a source error", () => {
    expect(classifyVerdict(error(typeError("source failed")), ok([]))).toEqual({
      kind: "mismatch",
      reason: "source-crash-suppressed",
      signature: 'source-crash-suppressed:["TypeError","source failed"]',
    });
  });

  test("compares partial events before passing equal normalized errors", () => {
    expect(
      classifyVerdict(
        error(typeError("same failure"), [event("source", 1)]),
        error(typeError("same failure"), [event("bundle", 2)]),
      ),
    ).toEqual({
      kind: "mismatch",
      reason: "events-mismatch",
      signature:
        'events-mismatch:error=["TypeError","same failure"]:source=[["source","evaluate",1]]:bundle=[["bundle","evaluate",2]]',
    });

    const events = [event("shared", 1)];
    expect(
      classifyVerdict(
        error(typeError("same failure"), events),
        error(typeError("same failure"), events),
      ),
    ).toEqual({ kind: "pass", signature: "pass" });
  });

  test("classifies identical harness failures as an invalid harness instead of passing", () => {
    const failure = harnessError({
      name: "ChildProcessError",
      message: "runner failed",
    });

    expect(classifyVerdict(failure, structuredClone(failure))).toEqual({
      kind: "invalid-harness",
      reason: "source-harness-error",
      signature: 'invalid-harness:source=["ChildProcessError","runner failed"]',
    });
    expect(classifyVerdict(ok([]), failure)).toEqual({
      kind: "invalid-harness",
      reason: "bundle-harness-error",
      signature: 'invalid-harness:bundle=["ChildProcessError","runner failed"]',
    });
  });

  test("classifies normalized error mismatches", () => {
    expect(
      classifyVerdict(
        error(typeError("source failed")),
        error({ name: "ReferenceError", message: "bundle failed" }),
      ),
    ).toEqual({
      kind: "mismatch",
      reason: "error-mismatch",
      signature:
        'error-mismatch:source=["TypeError","source failed"]:bundle=["ReferenceError","bundle failed"]',
    });
  });

  test("classifies reordered events", () => {
    expect(
      classifyVerdict(ok([event("a", 1), event("b", 2)]), ok([event("b", 2), event("a", 1)])),
    ).toEqual({
      kind: "mismatch",
      reason: "events-reordered",
      signature:
        'events-reordered:source=[["a","evaluate",1],["b","evaluate",2]]:bundle=[["b","evaluate",2],["a","evaluate",1]]',
    });
  });

  test("classifies missing events", () => {
    expect(
      classifyVerdict(
        ok([event("a", 1), event("missing", 2), event("b", 3)]),
        ok([event("a", 1), event("b", 3)]),
      ),
    ).toEqual({
      kind: "mismatch",
      reason: "events-missing",
      signature: 'events-missing:source=[["missing","evaluate",2]]:bundle=[]',
    });
  });

  test("classifies extra events", () => {
    expect(
      classifyVerdict(
        ok([event("a", 1), event("b", 3)]),
        ok([event("a", 1), event("extra", 2), event("b", 3)]),
      ),
    ).toEqual({
      kind: "mismatch",
      reason: "events-extra",
      signature: 'events-extra:source=[]:bundle=[["extra","evaluate",2]]',
    });
  });

  test("classifies non-contiguous missing and extra events by subsequence", () => {
    expect(
      classifyVerdict(
        ok([event("a", 1), event("missing-1", 2), event("b", 3), event("missing-2", 4)]),
        ok([event("a", 1), event("b", 3)]),
      ),
    ).toEqual({
      kind: "mismatch",
      reason: "events-missing",
      signature:
        'events-missing:source=[["missing-1","evaluate",2],["missing-2","evaluate",4]]:bundle=[]',
    });
    expect(
      classifyVerdict(
        ok([event("a", 1), event("b", 3)]),
        ok([event("a", 1), event("extra-1", 2), event("b", 3), event("extra-2", 4)]),
      ),
    ).toEqual({
      kind: "mismatch",
      reason: "events-extra",
      signature:
        'events-extra:source=[]:bundle=[["extra-1","evaluate",2],["extra-2","evaluate",4]]',
    });
  });

  test("classifies bundle timeouts separately from crashes and event differences", () => {
    expect(classifyVerdict(ok([event("entry", 1)]), timeout())).toEqual({
      kind: "mismatch",
      reason: "timeout-mismatch",
      signature: "timeout-mismatch:source=ok:bundle=timeout",
    });
    expect(classifyVerdict(error(typeError("source failed")), timeout())).toEqual({
      kind: "mismatch",
      reason: "timeout-mismatch",
      signature: 'timeout-mismatch:source=error:["TypeError","source failed"]:bundle=timeout',
    });
  });

  test("returns stable signatures for structurally equal outcomes", () => {
    const source = ok([event("a", 1), event("b", 2)]);
    const bundle = ok([event("b", 2), event("a", 1)]);

    const first = classifyVerdict(source, bundle);
    const second = classifyVerdict(structuredClone(source), structuredClone(bundle));

    expect(first.signature).toBe(second.signature);
    expect(first.signature).toBe(
      'events-reordered:source=[["a","evaluate",1],["b","evaluate",2]]:bundle=[["b","evaluate",2],["a","evaluate",1]]',
    );
  });

  test("ignores identical event prefixes and suffixes in mismatch signatures", () => {
    const prefix = event("prefix", 0);
    const suffix = event("suffix", 9);
    const cases: readonly (readonly [ExecutionOutcome, ExecutionOutcome])[] = [
      [ok([event("a", 1), event("b", 2)]), ok([event("b", 2), event("a", 1)])],
      [ok([event("missing", 3)]), ok([])],
    ];

    for (const [source, bundle] of cases) {
      const base = classifyVerdict(source, bundle);
      const wrapped = classifyVerdict(
        ok([prefix, ...source.events, suffix]),
        ok([prefix, ...bundle.events, suffix]),
      );
      expect(wrapped.signature).toBe(base.signature);
    }
  });

  test("ignores identical interior context in non-contiguous event signatures", () => {
    const context = event("context", 0);
    const cases: readonly (readonly [
      ExecutionOutcome,
      ExecutionOutcome,
      ExecutionOutcome,
      ExecutionOutcome,
    ])[] = [
      [
        ok([event("missing-1", 1), event("missing-2", 2)]),
        ok([]),
        ok([event("missing-1", 1), context, event("missing-2", 2)]),
        ok([context]),
      ],
      [
        ok([]),
        ok([event("extra-1", 1), event("extra-2", 2)]),
        ok([context]),
        ok([event("extra-1", 1), context, event("extra-2", 2)]),
      ],
      [
        ok([event("a", 1), event("b", 2)]),
        ok([event("b", 2), event("a", 1)]),
        ok([event("a", 1), context, event("b", 2)]),
        ok([event("b", 2), context, event("a", 1)]),
      ],
    ];

    for (const [baseSource, baseBundle, contextSource, contextBundle] of cases) {
      expect(classifyVerdict(contextSource, contextBundle).signature).toBe(
        classifyVerdict(baseSource, baseBundle).signature,
      );
    }
  });

  test("computes an exact stable diff across the previous 129 by 127 fallback boundary", () => {
    const missingFirst = event("missing-first", 1);
    const missingLast = event("missing-last", 2);
    const context = Array.from({ length: 127 }, (_, index) => event(`context-${index}`, index));
    const base = classifyVerdict(ok([missingFirst, missingLast]), ok([]));
    const large = classifyVerdict(ok([missingFirst, ...context, missingLast]), ok(context));

    expect(large.signature).toBe(base.signature);
    expect(large.signature).toBe(
      'events-missing:source=[["missing-first","evaluate",1],["missing-last","evaluate",2]]:bundle=[]',
    );
  });

  test("keeps different changed event slices in different signatures", () => {
    const first = classifyVerdict(
      ok([event("a", 1), event("b", 2)]),
      ok([event("b", 2), event("a", 1)]),
    );
    const second = classifyVerdict(
      ok([event("a", 1), event("c", 3)]),
      ok([event("c", 3), event("a", 1)]),
    );

    expect(first.signature).not.toBe(second.signature);
  });

  test("returns distinct signatures for distinct reorder shapes", () => {
    const source = ok([event("a", 1), event("b", 2), event("c", 3)]);
    const swapFirst = classifyVerdict(source, ok([event("b", 2), event("a", 1), event("c", 3)]));
    const rotate = classifyVerdict(source, ok([event("b", 2), event("c", 3), event("a", 1)]));

    expect(swapFirst.signature).not.toBe(rotate.signature);
  });

  test("keeps every mismatch signature stable across structural clones", () => {
    const cases: readonly (readonly [ExecutionOutcome, ExecutionOutcome])[] = [
      [ok([event("a", 1)]), error(typeError("bundle failed"))],
      [error(typeError("source failed")), ok([])],
      [
        error(typeError("source failed")),
        error({ name: "ReferenceError", message: "bundle failed" }),
      ],
      [ok([event("a", 1), event("b", 2)]), ok([event("b", 2), event("a", 1)])],
      [ok([event("a", 1), event("b", 2)]), ok([event("a", 1)])],
      [ok([event("a", 1)]), ok([event("a", 1), event("b", 2)])],
      [ok([event("a", 1)]), timeout()],
    ];

    for (const [source, bundle] of cases) {
      expect(classifyVerdict(source, bundle).signature).toBe(
        classifyVerdict(structuredClone(source), structuredClone(bundle)).signature,
      );
    }
  });
});

function event(module: string, value: string | number): ExecutionEvent {
  return {
    version: 1,
    module,
    phase: "evaluate",
    value,
  };
}

function ok(events: readonly ExecutionEvent[]): ExecutionOutcome {
  return {
    version: 1,
    status: "ok",
    events,
  };
}

function error(
  normalizedError: NormalizedError,
  events: readonly ExecutionEvent[] = [],
): ExecutionOutcome {
  return {
    version: 1,
    status: "error",
    events,
    error: normalizedError,
  };
}

function harnessError(normalizedError: NormalizedError): ExecutionOutcome {
  return {
    version: 1,
    status: "harness-error",
    events: [],
    error: normalizedError,
  };
}

function timeout(): ExecutionOutcome {
  return {
    version: 1,
    status: "timeout",
    events: [],
  };
}

function typeError(message: string): NormalizedError {
  return {
    name: "TypeError",
    message,
  };
}
