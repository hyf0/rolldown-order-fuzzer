import { describe, expect, test } from "vite-plus/test";

import type { ExecutionEvent, ExecutionOutcome, NormalizedError } from "../src/protocol.ts";
import {
  classifyVerdict,
  makeMinifyErrorComparator,
  normalizeMinifiedErrorMessage,
} from "../src/verdict.ts";

describe("normalizeMinifiedErrorMessage (W12 minify error normalizer)", () => {
  test("collapses the leading identifier of each known runtime-error template to <id>", () => {
    expect(normalizeMinifiedErrorMessage("t is not a function")).toBe("<id> is not a function");
    expect(normalizeMinifiedErrorMessage("init_module_0003 is not a function")).toBe(
      "<id> is not a function",
    );
    expect(normalizeMinifiedErrorMessage("Foo is not a constructor")).toBe(
      "<id> is not a constructor",
    );
    expect(normalizeMinifiedErrorMessage("n is not defined")).toBe("<id> is not defined");
    expect(normalizeMinifiedErrorMessage("x is not iterable")).toBe("<id> is not iterable");
    expect(normalizeMinifiedErrorMessage("Cannot access 'q' before initialization")).toBe(
      "Cannot access '<id>' before initialization",
    );
  });

  test("leaves a message with NO renamable identifier untouched (keeps its discriminator)", () => {
    // A NaN-fold reject and a property-read crash carry no mangled identifier — the property name is a
    // stable discriminator minify never touches, so the normalizer must not collapse it.
    expect(
      normalizeMinifiedErrorMessage("Execution event value must be a primitive JSON value"),
    ).toBe("Execution event value must be a primitive JSON value");
    expect(
      normalizeMinifiedErrorMessage("Cannot read properties of undefined (reading 'muiName')"),
    ).toBe("Cannot read properties of undefined (reading 'muiName')");
  });
});

describe("classifyVerdict", () => {
  test("passes matching successful outcomes", () => {
    const events = [event("a", 1), event("b", 2)];

    expect(classifyVerdict(ok(events), ok(events))).toEqual({
      kind: "pass",
      signature: "pass",
    });
  });

  test("catches a premature execution that a flat event stream judged equal (schedule markers)", () => {
    // The oracle hole: source runs A in schedule step 0 and B in step 1; a premature bundle runs
    // BOTH in step 0. Stripped to module events alone, both are [A, B] — judged EQUAL — yet module B
    // ran a whole schedule step early. The runner-emitted schedule markers make each step boundary
    // observable, so B landing on the wrong side of the step-0 marker is now caught.
    const source = ok([event("a", 1), marker(0, "entry"), event("b", 2), marker(1, "dynamic")]);
    const bundle = ok([event("a", 1), event("b", 2), marker(0, "entry"), marker(1, "dynamic")]);

    // Stripping the markers leaves identical module streams, so the flat oracle would still PASS.
    const stripMarkers = (outcome: ExecutionOutcome): ExecutionOutcome =>
      ok(outcome.events.filter((candidate) => !("marker" in candidate)));
    expect(classifyVerdict(stripMarkers(source), stripMarkers(bundle))).toEqual({
      kind: "pass",
      signature: "pass",
    });

    // With the markers present, the phase difference surfaces as a reordering in a readable signature.
    const verdict = classifyVerdict(source, bundle);
    expect(verdict.kind).toBe("mismatch");
    expect(verdict).toMatchObject({ reason: "events-reordered" });
    expect(verdict.signature).toContain('["@schedule",0,"entry"]');
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

  test("W12: the minify error comparator normalizes a renamed identifier so a legal rename passes", () => {
    // Both sides crash with the SAME template and identical preceding events; only the identifier differs
    // (the un-minified source's `x` vs the minified bundle's `t`). Under the EXACT comparator (minify:false)
    // this is a false-positive `error-mismatch`; under the minify comparator it is the correct PASS.
    const source = error(typeError("x is not a function"), [event("m0", 1)]);
    const bundle = error(typeError("t is not a function"), [event("m0", 1)]);
    expect(classifyVerdict(source, bundle).kind).toBe("mismatch");
    expect(classifyVerdict(source, bundle, undefined, makeMinifyErrorComparator())).toEqual({
      kind: "pass",
      signature: "pass",
    });
  });

  test("W12: the minify comparator still catches a genuinely different error (name / template)", () => {
    const source = error(typeError("x is not a function"), [event("m0", 1)]);
    // Different NAME — a real divergence minify never causes — must still red.
    expect(
      classifyVerdict(
        source,
        error({ name: "ReferenceError", message: "t is not defined" }, [event("m0", 1)]),
        undefined,
        makeMinifyErrorComparator(),
      ),
    ).toMatchObject({ kind: "mismatch", reason: "error-mismatch" });
    // Same name, DIFFERENT template — also still red.
    expect(
      classifyVerdict(
        source,
        error(typeError("t is not a constructor"), [event("m0", 1)]),
        undefined,
        makeMinifyErrorComparator(),
      ),
    ).toMatchObject({ kind: "mismatch", reason: "error-mismatch" });
  });

  test("W12: the minify comparator does not weaken the events comparison after equal errors", () => {
    // Errors match modulo rename, but the events diverge — the event mismatch must still surface.
    const source = error(typeError("x is not a function"), [event("m0", 1), event("m1", 2)]);
    const bundle = error(typeError("t is not a function"), [event("m0", 1), event("m1", 9)]);
    expect(classifyVerdict(source, bundle, undefined, makeMinifyErrorComparator())).toMatchObject({
      kind: "mismatch",
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

function marker(schedule: number, kind: "entry" | "dynamic"): ExecutionEvent {
  return {
    version: 1,
    marker: "schedule",
    schedule,
    kind,
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
