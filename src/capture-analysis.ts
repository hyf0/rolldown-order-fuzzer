import type { DependencyOperation, ValueRead } from "./model.ts";
import { readableBindingsOf } from "./model.ts";

/// The canonical `call`/`guard` an event read of a binding MUST carry, keyed by `binding\0member`.
/// Derived from `readableBindingsOf` — the one shared read projection — so an event read is rejected
/// when its call/guard disagrees with the dependency that created the binding (folding a hoisted
/// function without calling it, or calling a plain numeric read). `computed` is a separate visibility
/// flag added later, so it is not part of this canonical shape.
///
/// The barrel-aware CAPABILITY resolution that once lived here (a `resolveExportOrigin` capability walk
/// classifying an export as value/callable/object at its defining module) is gone: the ONE
/// `ExportDemandPlan` now owns per-consumption shape↔form soundness (`validate-model.ts`
/// `validateExportDemand`), so the validator no longer re-derives capability through a parallel walk.
export function canonicalReadFlags(
  dependencies: readonly DependencyOperation[],
): Map<string, { readonly call: boolean; readonly guard: boolean }> {
  const flags = new Map<string, { readonly call: boolean; readonly guard: boolean }>();
  for (const read of readableBindingsOf(dependencies)) {
    flags.set(readKey(read), { call: read.call === true, guard: read.guard === true });
  }
  return flags;
}

export function readKey(read: Pick<ValueRead, "binding" | "member">): string {
  return `${read.binding}\0${read.member ?? ""}`;
}
