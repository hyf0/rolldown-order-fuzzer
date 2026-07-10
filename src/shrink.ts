import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { failureSignatureOf } from "./case-evaluator.ts";
import type { DependencyOperation, EventRecord, ProgramModel } from "./model.ts";
import { ProgramFacts } from "./program-facts.ts";
import { validateProgramModel } from "./validate-model.ts";

interface ShrinkOptions {
  readonly modelPath: string;
  readonly outPath: string;
  readonly rolldownPackage: string;
  /// The wrap mode the shrink runs under. A family-A failure reproduces in BOTH modes, but a
  /// wrap-all-ONLY failure (family B is the opposite, on-demand-only) will NOT reproduce under the
  /// wrong mode, so the shrinker must replay it under the mode that fails. Defaults to on-demand;
  /// `--wrap-all` selects wrap-all, and when the model lives inside a failure artifact the failing
  /// mode is auto-read from the sibling `replay.json` unless an explicit flag overrides it.
  readonly onDemandWrapping: boolean;
  /// When true (`--broad`), keep a candidate on any SAME-KIND failure (the legacy behavior) instead of
  /// requiring the exact normalized signature. Off by default: a minimized case must preserve the
  /// concrete failure, not merely its class.
  readonly broad: boolean;
}

/// Greedy model shrinker. Keeps a candidate edit only when the program stays valid and the
/// verdict keeps the same failure kind (and error identity for crashes). Kind-level
/// preservation is for root-cause analysis; re-verify the mechanism before filing issues.
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  let onDemandWrapping = parsed.onDemandWrapping;
  if (!parsed.wrapModeExplicit) {
    const detected = await detectArtifactWrapMode(parsed.modelPath);
    if (detected !== undefined) {
      onDemandWrapping = detected;
      process.stderr.write(
        `Wrap mode from artifact replay.json: ${detected ? "on-demand" : "wrap-all"}\n`,
      );
    }
  }
  const options: ShrinkOptions = {
    modelPath: parsed.modelPath,
    outPath: parsed.outPath,
    rolldownPackage: parsed.rolldownPackage,
    onDemandWrapping,
    broad: parsed.broad,
  };
  process.stderr.write(
    `Shrinking under ${onDemandWrapping ? "on-demand" : "wrap-all"} wrapping.\n`,
  );
  const original = JSON.parse(await readFile(options.modelPath, "utf8")) as ProgramModel;
  const baseline = await run(original, options);
  if (baseline === undefined) {
    process.stderr.write("Baseline did not fail; nothing to shrink.\n");
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`Baseline signature: ${baseline}\n`);

  let current = original;
  let shrunk = true;
  while (shrunk) {
    shrunk = false;
    for (const candidate of candidates(current)) {
      if (validateProgramModel(candidate).length > 0) {
        continue;
      }
      const signature = await run(candidate, options);
      if (signature !== undefined && sameFailure(baseline, signature, options.broad)) {
        current = candidate;
        shrunk = true;
        process.stderr.write(
          `Kept shrink: ${current.modules.length} modules, ${countDeps(current)} deps\n`,
        );
        break;
      }
    }
  }

  await writeFile(options.outPath, `${JSON.stringify(current, null, 2)}\n`);
  const finalSignature = await run(current, options);
  process.stderr.write(`Final: ${current.modules.length} modules -> ${options.outPath}\n`);
  process.stderr.write(`Final signature: ${finalSignature}\n`);
}

/// The optional levers of an organic chunk group, each individually droppable when shrinking.
const ORGANIC_OPTIONAL_FIELDS = [
  "test",
  "minSize",
  "maxSize",
  "minShareCount",
  "priority",
  "includeDependenciesRecursively",
] as const;

/// Candidate edits, most aggressive first: drop a module (with every reference to it),
/// then drop a single dependency, an entry, a schedule operation, a manual group, an event.
export function* candidates(program: ProgramModel): Generator<ProgramModel> {
  for (const module of program.modules) {
    yield dropModule(program, module.id);
  }
  for (const [moduleIndex, module] of program.modules.entries()) {
    for (let depIndex = 0; depIndex < module.dependencies.length; depIndex += 1) {
      yield editModule(program, moduleIndex, {
        ...module,
        dependencies: module.dependencies.filter((_, index) => index !== depIndex),
      } as typeof module);
    }
  }
  // Drop one kind from a MIXED pair — a (importer, target) joined by more than one dependency, the
  // wave-5 multi-edge shape (static + lazy, side-effect + value, require + dynamic). Collapsing the
  // pair toward a single kind also drops any event read bound to the removed edge, so the candidate
  // is valid on its own; the generic dependency-drop above would leave a dangling read and be skipped.
  for (const [moduleIndex, module] of program.modules.entries()) {
    const targetCounts = new Map<string, number>();
    for (const dependency of module.dependencies) {
      targetCounts.set(dependency.target, (targetCounts.get(dependency.target) ?? 0) + 1);
    }
    for (const [depIndex, dependency] of module.dependencies.entries()) {
      if ((targetCounts.get(dependency.target) ?? 0) < 2) {
        continue;
      }
      const droppedBinding = droppedReadBinding(dependency);
      const dependencies = module.dependencies.filter((_, index) => index !== depIndex);
      const events =
        droppedBinding === undefined
          ? module.events
          : module.events.map((event) => dropReadsOfBinding(event, droppedBinding));
      yield editModule(program, moduleIndex, { ...module, dependencies, events } as typeof module);
    }
  }
  for (const entry of program.entries) {
    if (program.entries.length > 1) {
      yield {
        ...program,
        entries: program.entries.filter((candidate) => candidate !== entry),
        schedule: program.schedule.filter(
          (op) => op.kind === "trigger-dynamic-import" || op.entry !== entry.name,
        ),
      };
    }
  }
  for (const [index] of program.schedule.entries()) {
    if (program.schedule.length > 1) {
      yield { ...program, schedule: program.schedule.filter((_, i) => i !== index) };
    }
  }
  for (const [index] of (program.manualChunkGroups ?? []).entries()) {
    const groups = (program.manualChunkGroups ?? []).filter((_, i) => i !== index);
    if (groups.length > 0) {
      yield { ...program, manualChunkGroups: groups };
    } else {
      // Dropping the SOLE group must DELETE the field, not spread the original program (which would
      // retain `manualChunkGroups` and yield a candidate identical to the current one). An identical
      // candidate keeps the same failure signature forever, so the greedy loop re-accepts it every pass
      // and never terminates. Deleting the field makes the candidate genuinely smaller and progress.
      const withoutGroups = { ...program };
      delete (withoutGroups as { manualChunkGroups?: unknown }).manualChunkGroups;
      yield withoutGroups;
    }
  }
  // Drop the organic chunk config entirely (falling back to default chunking). When the failure does
  // not depend on the organic composition this simplifies the case; the greedy pass keeps it only if
  // the failure kind is preserved, which also reveals whether the chunking is load-bearing.
  const organicGroups = program.organicChunkGroups ?? [];
  if (organicGroups.length > 0) {
    const withoutOrganic = { ...program };
    delete (withoutOrganic as { organicChunkGroups?: unknown }).organicChunkGroups;
    yield withoutOrganic;
  }
  // Drop a WHOLE organic group (when more than one) or a SINGLE optional field of a group, so an
  // organic config shrinks field-by-field toward the minimal lever the bug needs — not just
  // all-or-nothing. Each candidate is validated and kept only if the failure kind is preserved.
  for (const [groupIndex, group] of organicGroups.entries()) {
    if (organicGroups.length > 1) {
      yield {
        ...program,
        organicChunkGroups: organicGroups.filter((_, index) => index !== groupIndex),
      };
    }
    for (const field of ORGANIC_OPTIONAL_FIELDS) {
      if (group[field] === undefined) {
        continue;
      }
      const trimmed = { ...group };
      delete (trimmed as Record<string, unknown>)[field];
      yield {
        ...program,
        organicChunkGroups: organicGroups.map((candidate, index) =>
          index === groupIndex ? trimmed : candidate,
        ),
      };
    }
  }
  // Remove ANY single event (not just the last), including a module's SOLE event — an irrelevant event
  // on an otherwise load-bearing module could not be dropped before, so the case never minimized past it.
  for (const [moduleIndex, module] of program.modules.entries()) {
    for (const [eventIndex] of module.events.entries()) {
      yield editModule(program, moduleIndex, {
        ...module,
        events: module.events.filter((_, index) => index !== eventIndex),
      } as typeof module);
    }
  }
  // Drop a single value read from an event. This keeps the model valid on its own and lets a
  // later pass drop the now-unread dependency that produced the binding.
  for (const [moduleIndex, module] of program.modules.entries()) {
    for (const [eventIndex, event] of module.events.entries()) {
      const reads = event.reads;
      if (reads === undefined || reads.length === 0) {
        continue;
      }
      for (let readIndex = 0; readIndex < reads.length; readIndex += 1) {
        const remaining = reads.filter((_, index) => index !== readIndex);
        const replacement: EventRecord =
          remaining.length > 0 ? { ...event, reads: remaining } : withoutReads(event);
        const events = module.events.map((candidate, index) =>
          index === eventIndex ? replacement : candidate,
        );
        yield editModule(program, moduleIndex, { ...module, events } as typeof module);
      }
    }
  }
  // Drop a single read member from a namespace import, removing any event reads of it. This shrinks
  // the namespace's footprint and lets a later pass drop the now-unused import or its target.
  for (const [moduleIndex, module] of program.modules.entries()) {
    for (const [depIndex, dependency] of module.dependencies.entries()) {
      if (dependency.kind !== "esm-namespace-import" || dependency.readMembers.length === 0) {
        continue;
      }
      for (let memberIndex = 0; memberIndex < dependency.readMembers.length; memberIndex += 1) {
        const removedMember = dependency.readMembers[memberIndex];
        const dependencies = module.dependencies.map((candidate, index) =>
          index === depIndex
            ? {
                ...dependency,
                readMembers: dependency.readMembers.filter((_, i) => i !== memberIndex),
                // A callable member (`ns.member()`) must also leave callMembers, else the removed
                // member lingers in callMembers (which must be a subset of readMembers) and the
                // candidate fails validation and is silently skipped.
                ...(dependency.callMembers !== undefined
                  ? {
                      callMembers: dependency.callMembers.filter(
                        (member) => member !== removedMember,
                      ),
                    }
                  : {}),
              }
            : candidate,
        );
        const events = module.events.map((event) => {
          if (event.reads === undefined) {
            return event;
          }
          const reads = event.reads.filter(
            (read) => !(read.binding === dependency.localName && read.member === removedMember),
          );
          if (reads.length === event.reads.length) {
            return event;
          }
          return reads.length > 0 ? { ...event, reads } : withoutReads(event);
        });
        yield editModule(program, moduleIndex, {
          ...module,
          dependencies,
          events,
        } as typeof module);
      }
    }
  }
  // Drop a barrel hop: rewire a read that targets a pure single-re-export barrel directly to the
  // barrel's target (adjusting the imported name), so the intermediate barrel becomes droppable.
  for (const [moduleIndex, module] of program.modules.entries()) {
    for (const [depIndex, dependency] of module.dependencies.entries()) {
      const rewired = rewireReadPastBarrel(dependency, program);
      if (rewired === undefined) {
        continue;
      }
      const dependencies = module.dependencies.map((candidate, index) =>
        index === depIndex ? rewired : candidate,
      );
      // A namespace or require rewire changes the demanded member/read NAME (the local binding is
      // unchanged); the event reads of that binding must follow, else they reference a member no longer
      // demanded and the candidate fails validation and is silently skipped.
      const memberRename = barrelMemberRename(dependency, rewired);
      const events =
        memberRename === undefined
          ? module.events
          : module.events.map((event) => renameEventReadMember(event, memberRename));
      yield editModule(program, moduleIndex, { ...module, dependencies, events } as typeof module);
    }
  }
  // Drop a redundant synchronous cycle edge — a chord, or one interlocking cycle's extra edge. An
  // edge A -> B is redundant when B can still synchronously reach A without it, so the remaining
  // cycle (and its failure mode) is preserved while the extra structure collapses. This directly
  // shrinks a chorded ring toward a bare ring and collapses two interlocking cycles toward one.
  const facts = ProgramFacts.from(program.modules);
  for (const [moduleIndex, module] of program.modules.entries()) {
    for (const [depIndex, dependency] of module.dependencies.entries()) {
      if (dependency.kind === "esm-dynamic-import") {
        continue;
      }
      const closesCycle = facts.edgeClosesCycle(module.id, dependency.target);
      if (!closesCycle) {
        continue;
      }
      // Redundant iff another synchronous out-edge of this module still reaches back to it.
      const stillCyclic = module.dependencies.some(
        (other, index) =>
          index !== depIndex &&
          other.kind !== "esm-dynamic-import" &&
          facts.edgeClosesCycle(module.id, other.target),
      );
      if (!stillCyclic) {
        continue;
      }
      yield editModule(program, moduleIndex, {
        ...module,
        dependencies: module.dependencies.filter((_, index) => index !== depIndex),
      } as typeof module);
    }
  }
  // Unflag a side-effect-free module (drop its `sideEffects: false` metadata). When the failure does
  // not depend on the flag this simplifies the case; the greedy pass keeps it only if the failure
  // kind is preserved, which also tells whether the metadata is load-bearing for the bug.
  for (const [moduleIndex, module] of program.modules.entries()) {
    if (module.sideEffectFree !== true) {
      continue;
    }
    const unflagged = { ...module };
    delete (unflagged as { sideEffectFree?: true }).sideEffectFree;
    yield editModule(program, moduleIndex, unflagged);
  }
  // Drop the inferred-pure flag from a definer (family A). Without it the value renders as a plain
  // (inlinable) export, so if inference-based purity is load-bearing the failure vanishes and the
  // greedy pass keeps the flag — proving the bug depends on the definer being inferred pure.
  for (const [moduleIndex, module] of program.modules.entries()) {
    if (module.inferredPure !== true) {
      continue;
    }
    const plain = { ...module };
    delete (plain as { inferredPure?: true }).inferredPure;
    delete (plain as { pureBase?: number }).pureBase;
    yield editModule(program, moduleIndex, plain);
  }
  // Drop the callable-own-state flag from a definer (wave 8). Its exports then render as constants
  // (or, when a caller demands them callable on a direct edge, constant-returning functions), so if
  // the own-state read through the callable is load-bearing the failure vanishes and the flag is
  // kept. Behind a barrel this usually changes the verdict kind (a call of a const crashes both
  // sides) and is rejected — sound either way, since candidates must preserve the failure kind.
  for (const [moduleIndex, module] of program.modules.entries()) {
    if (module.callableOwnState !== true) {
      continue;
    }
    const plain = { ...module };
    delete (plain as { callableOwnState?: true }).callableOwnState;
    yield editModule(program, moduleIndex, plain);
  }
  // Drop an object-identity comparison from an event (wave 8), reverting it to a plain constant
  // event. The objectRef imports become unreferenced (still valid) so later passes can drop them.
  // If the identity witness is load-bearing the failure vanishes and the check is kept.
  for (const [moduleIndex, module] of program.modules.entries()) {
    for (const [eventIndex, event] of module.events.entries()) {
      if (event.identityCheck === undefined) {
        continue;
      }
      const plain = { ...event };
      delete (plain as { identityCheck?: unknown }).identityCheck;
      const events = module.events.map((candidate, index) =>
        index === eventIndex ? plain : candidate,
      );
      yield editModule(program, moduleIndex, { ...module, events } as typeof module);
    }
  }
  // Drop the object-export flag from a definer (wave 8). Its exports then render as folded numbers;
  // an identity check comparing two captures of the SAME number is still `true` on a correct build,
  // so the model stays sound, but the object-ness witness goes dead — if it was load-bearing the
  // failure vanishes and the flag is kept.
  for (const [moduleIndex, module] of program.modules.entries()) {
    if (module.objectExport !== true) {
      continue;
    }
    const plain = { ...module };
    delete (plain as { objectExport?: true }).objectExport;
    yield editModule(program, moduleIndex, plain);
  }
  // Drop a function-hidden read (family B) or a computed member access, revealing whether the
  // statically-invisible read shape is load-bearing (the read becomes a plain top-level read).
  for (const [moduleIndex, module] of program.modules.entries()) {
    for (const [eventIndex, event] of module.events.entries()) {
      if (event.hiddenReadFn === true) {
        const revealed = { ...event };
        delete (revealed as { hiddenReadFn?: true }).hiddenReadFn;
        const events = module.events.map((candidate, index) =>
          index === eventIndex ? revealed : candidate,
        );
        yield editModule(program, moduleIndex, { ...module, events } as typeof module);
      }
      for (let readIndex = 0; readIndex < (event.reads?.length ?? 0); readIndex += 1) {
        if (event.reads?.[readIndex]?.computed !== true) {
          continue;
        }
        const reads = event.reads.map((read, index) => {
          if (index !== readIndex) {
            return read;
          }
          const plainRead = { ...read };
          delete (plainRead as { computed?: true }).computed;
          return plainRead;
        });
        const events = module.events.map((candidate, index) =>
          index === eventIndex ? { ...event, reads } : candidate,
        );
        yield editModule(program, moduleIndex, { ...module, events } as typeof module);
      }
    }
  }
}

/// If `dependency` reads a single name from a pure single-re-export barrel, return an equivalent
/// dependency that reads directly from the barrel's target (collapsing one hop); otherwise undefined.
/// A named re-export maps the read name to its source; a star re-export forwards the same name.
function rewireReadPastBarrel(
  dependency: DependencyOperation,
  program: ProgramModel,
): DependencyOperation | undefined {
  let readName: string | undefined;
  if (dependency.kind === "esm-value-import") {
    readName = dependency.importedName;
  } else if (dependency.kind === "esm-namespace-import" && dependency.readMembers.length === 1) {
    readName = dependency.readMembers[0];
  } else if (dependency.kind === "cjs-require" && dependency.readName !== undefined) {
    readName = dependency.readName;
  }
  if (readName === undefined) {
    return undefined;
  }

  const barrel = program.modules.find((module) => module.id === dependency.target);
  if (barrel === undefined || barrel.dependencies.length !== 1) {
    return undefined;
  }
  const reexport = barrel.dependencies[0];
  if (reexport === undefined) {
    return undefined;
  }
  let target: string;
  let name: string;
  if (reexport.kind === "esm-reexport-named" && reexport.exportedName === readName) {
    target = reexport.target;
    name = reexport.sourceName;
  } else if (reexport.kind === "esm-reexport-star") {
    target = reexport.target;
    name = readName;
  } else {
    return undefined;
  }

  if (dependency.kind === "esm-value-import") {
    return { ...dependency, target, importedName: name };
  }
  if (dependency.kind === "esm-namespace-import") {
    // The read member is renamed (barrel exportedName -> definer sourceName). A callMember (`ns.m()`)
    // names a read member, so it must be renamed TOGETHER: leaving the old name in callMembers breaks
    // the callMembers ⊆ readMembers invariant, so the candidate fails validation and is silently skipped.
    const oldMember = dependency.readMembers[0];
    const rewired = { ...dependency, target, readMembers: [name] };
    if (dependency.callMembers === undefined) {
      return rewired;
    }
    return {
      ...rewired,
      callMembers: dependency.callMembers.includes(oldMember ?? "") ? [name] : [],
    };
  }
  if (dependency.kind === "cjs-require") {
    return { ...dependency, target, readName: name };
  }
  return undefined;
}

/// Strip the folded reads (and the now-meaningless function-hidden wrapper) from an event, PRESERVING
/// every other field. Spread-and-delete instead of reconstructing a fixed `{module, phase, value}`, so
/// a future event field is not silently dropped when the last read is removed.
function withoutReads(event: EventRecord): EventRecord {
  const stripped = { ...event };
  delete (stripped as { reads?: unknown }).reads;
  delete (stripped as { hiddenReadFn?: unknown }).hiddenReadFn;
  return stripped;
}

interface MemberRename {
  readonly binding: string;
  readonly from: string;
  readonly to: string;
}

/// The event-read member rename a barrel rewire implies: rewiring a namespace/require read past a
/// barrel changes the demanded member NAME (the barrel's `exportedName` becomes the definer's
/// `sourceName`) while the local binding is unchanged, so event reads of that binding must follow. A
/// value-import rewire changes only the imported name, not the local read (no member), so no rename.
function barrelMemberRename(
  before: DependencyOperation,
  after: DependencyOperation,
): MemberRename | undefined {
  if (
    before.kind === "esm-namespace-import" &&
    after.kind === "esm-namespace-import" &&
    before.readMembers.length === 1 &&
    after.readMembers.length === 1 &&
    before.readMembers[0] !== after.readMembers[0]
  ) {
    return {
      binding: before.localName,
      from: before.readMembers[0] as string,
      to: after.readMembers[0] as string,
    };
  }
  if (
    before.kind === "cjs-require" &&
    after.kind === "cjs-require" &&
    before.resultBinding !== undefined &&
    before.readName !== undefined &&
    after.readName !== undefined &&
    before.readName !== after.readName
  ) {
    return { binding: before.resultBinding, from: before.readName, to: after.readName };
  }
  return undefined;
}

function renameEventReadMember(event: EventRecord, rename: MemberRename): EventRecord {
  if (event.reads === undefined) {
    return event;
  }
  let changed = false;
  const reads = event.reads.map((read) => {
    if (read.binding === rename.binding && read.member === rename.from) {
      changed = true;
      return { ...read, member: rename.to };
    }
    return read;
  });
  return changed ? { ...event, reads } : event;
}

/// The local read binding a dependency introduces (dropped along with the dependency), or undefined
/// when it binds nothing readable (side-effect / dynamic import, plain require, re-export).
function droppedReadBinding(dependency: DependencyOperation): string | undefined {
  if (dependency.kind === "esm-value-import" || dependency.kind === "esm-namespace-import") {
    return dependency.localName;
  }
  if (dependency.kind === "cjs-require" && dependency.resultBinding !== undefined) {
    return dependency.resultBinding;
  }
  return undefined;
}

function dropReadsOfBinding(event: EventRecord, binding: string): EventRecord {
  if (event.reads === undefined) {
    return event;
  }
  const reads = event.reads.filter((read) => read.binding !== binding);
  if (reads.length === event.reads.length) {
    return event;
  }
  return reads.length > 0 ? { ...event, reads } : withoutReads(event);
}

function dropModule(program: ProgramModel, moduleId: string): ProgramModel {
  const droppedRegistrations = new Set(
    program.modules
      .filter((module) => module.id === moduleId)
      .flatMap((module) =>
        module.dependencies.flatMap((dependency) =>
          dependency.kind === "esm-dynamic-import" ? [dependency.registration] : [],
        ),
      ),
  );
  for (const module of program.modules) {
    for (const dependency of module.dependencies) {
      if (dependency.kind === "esm-dynamic-import" && dependency.target === moduleId) {
        droppedRegistrations.add(dependency.registration);
      }
    }
  }
  const modules = program.modules
    .filter((module) => module.id !== moduleId)
    .map(
      (module) =>
        ({
          ...module,
          dependencies: module.dependencies.filter((dep) => dep.target !== moduleId),
        }) as typeof module,
    );
  const entries = program.entries.filter((entry) => entry.moduleId !== moduleId);
  const entryNames = new Set(entries.map((entry) => entry.name));
  const groups = (program.manualChunkGroups ?? [])
    .map((group) => ({
      ...group,
      moduleIds: group.moduleIds.filter((id) => id !== moduleId),
    }))
    .filter((group) => group.moduleIds.length > 0);
  return {
    modules,
    entries,
    schedule: program.schedule.filter((op) =>
      op.kind === "trigger-dynamic-import"
        ? !droppedRegistrations.has(op.registration)
        : entryNames.has(op.entry),
    ),
    ...(groups.length > 0 ? { manualChunkGroups: groups } : {}),
    // Organic chunk groups reference no module id (rolldown decides composition), so they survive a
    // module drop unchanged and must be preserved for byte-identical replay.
    ...(program.organicChunkGroups !== undefined
      ? { organicChunkGroups: program.organicChunkGroups }
      : {}),
  };
}

function editModule(
  program: ProgramModel,
  moduleIndex: number,
  replacement: ProgramModel["modules"][number],
): ProgramModel {
  return {
    ...program,
    modules: program.modules.map((module, index) => (index === moduleIndex ? replacement : module)),
  };
}

function countDeps(program: ProgramModel): number {
  return program.modules.reduce((sum, module) => sum + module.dependencies.length, 0);
}

/// Returns the failure signature, or undefined when the case passes. Delegates to the CaseEvaluator
/// seam, so the shrinker no longer fabricates a campaign case merely to replay one loaded model.
async function run(program: ProgramModel, options: ShrinkOptions): Promise<string | undefined> {
  return failureSignatureOf(program, {
    rolldownPackage: options.rolldownPackage,
    onDemandWrapping: options.onDemandWrapping,
  });
}

/// The failure-preservation contract for a shrink step. Per `.agents/docs/redesign-principles.md`, a
/// minimized case must preserve the CONCRETE failure signature, not merely a broad verdict class — so
/// the DEFAULT is EXACT: the candidate's NORMALIZED signature must equal the baseline's, where
/// normalization only rewrites the parts that legitimately move as the model shrinks (Rolldown's
/// numeric `module_N` / `init_*` / `require_*` chunk-internal names and absolute temp/root paths) while
/// keeping the whole failure structure — the error identity of a crash, the changed-event slice of a
/// reorder. A reorder can no longer minimize into an unrelated reorder or another changed-event slice.
///
/// `broad: true` (the shrinker's `--broad` flag) restores the looser same-KIND matching for aggressive
/// exploration, keeping only the crash error-identity — useful to find a smaller case at the cost of
/// possibly changing the concrete failure, which the operator then re-verifies before filing.
export function sameFailure(baseline: string, candidate: string, broad = false): boolean {
  if (signatureKind(baseline) !== signatureKind(candidate)) {
    return false;
  }
  if (broad) {
    // Same kind; for a crash keep the normalized error identity, else accept any same-kind failure.
    return signatureKind(baseline) === "bundle-only-crash"
      ? normalizeCrashIdentity(baseline) === normalizeCrashIdentity(candidate)
      : true;
  }
  return normalizeSignature(baseline) === normalizeSignature(candidate);
}

function signatureKind(signature: string): string {
  return signature.split(":", 1)[0] ?? signature;
}

/// Rewrite ONLY the tokens that legitimately move as the model shrinks: Rolldown's chunk-internal
/// identifiers derived from the GENERATED numeric module basenames (`module-NNNN` renders as
/// `module_NNNN` / `init_module_NNNN` / `require_module_NNNN`) and absolute temp/root paths. A shrink
/// step drops modules and RENUMBERS the survivors, so each such token is mapped to a stable
/// per-signature index by first appearance — a renumbered failure compares equal, while a structurally
/// DIFFERENT one (a different module failing, in a different position) does not. Crucially, only the
/// NUMERIC-generated forms are normalized: a non-numeric chunk symbol (`init_alpha` vs `init_beta`) is
/// left literal, so a shrink can never swap one named root cause for another and still claim an exact
/// match — the over-normalization that made every `init_*` compare equal.
function normalizeSignature(signature: string): string {
  const withoutPaths = signature.replaceAll(/(?:\/[^\s"':]+)+\/(module-\d+\.[mc]js)/g, "$1");
  let counter = 0;
  const canonicalByToken = new Map<string, string>();
  return withoutPaths.replaceAll(/(?:init_module_|require_module_|module_)\d+/g, (token) => {
    const existing = canonicalByToken.get(token);
    if (existing !== undefined) {
      return existing;
    }
    const canonical = `${token.replace(/\d+$/, "")}N${counter}`;
    counter += 1;
    canonicalByToken.set(token, canonical);
    return canonical;
  });
}

function normalizeCrashIdentity(signature: string): string {
  return normalizeSignature(signature).split(":").slice(0, 2).join(":");
}

export function parseArgs(argv: readonly string[]): {
  readonly modelPath: string;
  readonly outPath: string;
  readonly rolldownPackage: string;
  readonly onDemandWrapping: boolean;
  readonly wrapModeExplicit: boolean;
  readonly broad: boolean;
} {
  let modelPath: string | undefined;
  let outPath = "shrunk-model.json";
  let rolldownPackage = process.env.ROLLDOWN_PACKAGE ?? "rolldown";
  let onDemandWrapping = true;
  let wrapModeExplicit = false;
  let broad = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--model") {
      modelPath = argv[++index];
    } else if (argument === "--out") {
      outPath = argv[++index] ?? outPath;
    } else if (argument === "--rolldown-package") {
      rolldownPackage = argv[++index] ?? rolldownPackage;
    } else if (argument === "--wrap-all") {
      onDemandWrapping = false;
      wrapModeExplicit = true;
    } else if (argument === "--on-demand") {
      onDemandWrapping = true;
      wrapModeExplicit = true;
    } else if (argument === "--broad") {
      broad = true;
    } else {
      throw new Error(`Unknown argument: ${String(argument)}`);
    }
  }
  if (modelPath === undefined) {
    throw new Error(
      "Usage: vp exec node src/shrink.ts --model <model.json> [--out <path>] [--rolldown-package <specifier>] [--wrap-all|--on-demand] [--broad]",
    );
  }
  return {
    modelPath: resolve(modelPath),
    outPath: resolve(outPath),
    rolldownPackage,
    onDemandWrapping,
    wrapModeExplicit,
    broad,
  };
}

/// When the model sits inside a failure artifact and no wrap flag was given, read the failing wrap
/// mode from the sibling `replay.json` so a wrap-all-only failure replays under the mode that fails
/// without the operator having to remember it. Best-effort: any read/parse issue keeps the default.
export async function detectArtifactWrapMode(modelPath: string): Promise<boolean | undefined> {
  try {
    const replayText = await readFile(join(dirname(modelPath), "replay.json"), "utf8");
    const replay = JSON.parse(replayText) as { options?: { onDemandWrapping?: unknown } };
    const value = replay.options?.onDemandWrapping;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

// Only run the shrinker when this module is executed directly, so tests can import `parseArgs` and
// `detectArtifactWrapMode` without kicking off a shrink pass.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
