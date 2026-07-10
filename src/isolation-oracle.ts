import type { AnalyzedProgram } from "./analyzed-program.ts";
import { isScheduleMarker } from "./protocol.ts";
import type { ExecutionEvent } from "./protocol.ts";
import type { EventComparator, MismatchVerdict, PassingVerdict } from "./verdict.ts";

/// The RELAXED-ORDER oracle for `strictExecutionOrder: false` cases — the ONE order policy the
/// program-run/verdict layer applies whenever the persisted `BuildConfig` says `seo:false`
/// (identical in campaign, replay, shrink, identity, and tags, because it is derived from the
/// program's own `BuildConfig`, not a per-caller switch).
///
/// A `seo:false` bundle legally executes eager modules in a different ORDER than the source, so the
/// full-order event comparison would false-positive. This oracle instead checks a set-based,
/// order-free INVARIANT: after each schedule operation, every module that has EXECUTED in the bundle
/// must be REACHABLE (statically OR dynamically) from the entries loaded so far. A legal relaxed-order
/// reshuffle never violates it (every eager module IS reachable from its own entry); a CROSS-ENTRY
/// LEAK — the #9998 class, where loading one entry runs another entry's top-level code — does, because
/// the leaked module is reachable only from an entry not yet loaded. See
/// `.agents/docs/w14c-demand-and-flagoff.md`.

const PASS = { kind: "pass", signature: "pass" } as const satisfies PassingVerdict;

/// Build the isolation-oracle comparator for one analyzed program. Precomputes, per schedule step, the
/// cumulative set of modules reachable from the entries/dynamic targets loaded through that step, so
/// the per-event check is a set membership.
export function makeReachabilityIsolationOracle(analyzed: AnalyzedProgram): EventComparator {
  const cumulative = buildCumulativeReachable(analyzed);
  return (sourceEvents, bundleEvents) =>
    reachabilityIsolationVerdict(cumulative, sourceEvents, bundleEvents);
}

/// `cumulative[i]` = the modules reachable (static + dynamic) from every entry/dynamic-import target
/// loaded by schedule ops `0..i` inclusive. Monotonic (each step only adds), so a module executing at
/// step `i` is legal iff it is in `cumulative[i]`.
function buildCumulativeReachable(analyzed: AnalyzedProgram): readonly ReadonlySet<string>[] {
  const { program, facts } = analyzed;
  const entryModuleByName = new Map(program.entries.map((entry) => [entry.name, entry.moduleId]));
  const registrationTarget = new Map<string, string>();
  for (const module of program.modules) {
    for (const dependency of module.dependencies) {
      if (dependency.kind === "esm-dynamic-import") {
        registrationTarget.set(dependency.registration, dependency.target);
      }
    }
  }
  const cumulative: Set<string>[] = [];
  const accumulated = new Set<string>();
  for (const operation of program.schedule) {
    const moduleId =
      operation.kind === "trigger-dynamic-import"
        ? registrationTarget.get(operation.registration)
        : entryModuleByName.get(operation.entry);
    if (moduleId !== undefined) {
      for (const reached of facts.reachableAllFrom(moduleId)) {
        accumulated.add(reached);
      }
    }
    cumulative.push(new Set(accumulated));
  }
  return cumulative;
}

/// The set of module ids whose bundle events landed in a step where the module was NOT reachable from
/// the entries loaded so far. Schedule markers advance the step; a module event is checked against the
/// cumulative reachable set of its step (clamped to the last step for any trailing event).
function isolationViolations(
  cumulative: readonly ReadonlySet<string>[],
  events: readonly ExecutionEvent[],
): ReadonlySet<string> {
  const violated = new Set<string>();
  if (cumulative.length === 0) {
    return violated;
  }
  const lastIndex = cumulative.length - 1;
  let step = 0;
  for (const event of events) {
    if (isScheduleMarker(event)) {
      step += 1;
      continue;
    }
    const reachable = cumulative[Math.min(step, lastIndex)];
    if (reachable !== undefined && !reachable.has(event.module)) {
      violated.add(event.module);
    }
  }
  return violated;
}

/// The relaxed-order verdict: PASS unless the bundle executed a module outside the reachability of the
/// entries loaded so far AND the SOURCE did not (subtracting any source violation defends against a
/// reachability-model gap — Node only runs reachable modules, so a source violation means the model,
/// not the bundle, is wrong; it never manufactures a false catch). The signature is the sorted set of
/// leaked module ids, so shrink can preserve the exact violated-module fingerprint.
export function reachabilityIsolationVerdict(
  cumulative: readonly ReadonlySet<string>[],
  sourceEvents: readonly ExecutionEvent[],
  bundleEvents: readonly ExecutionEvent[],
): PassingVerdict | MismatchVerdict {
  const bundleViolations = isolationViolations(cumulative, bundleEvents);
  if (bundleViolations.size === 0) {
    return PASS;
  }
  const sourceViolations = isolationViolations(cumulative, sourceEvents);
  const leaks = [...bundleViolations].filter((id) => !sourceViolations.has(id)).sort();
  if (leaks.length === 0) {
    return PASS;
  }
  return {
    kind: "mismatch",
    reason: "reachability-isolation",
    signature: `reachability-isolation:[${leaks.join(",")}]`,
  };
}
