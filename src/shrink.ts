import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeProgram } from "./analyzed-program.ts";
import { failureSignatureOf } from "./case-evaluator.ts";
import type {
  Chunking,
  DependencyOperation,
  EventRecord,
  ModuleModel,
  PackageModel,
  ProgramModel,
} from "./model.ts";
import {
  buildConfigOf,
  legacySideEffectFreePackage,
  normalizeLegacyReads,
  programChunking,
} from "./model.ts";
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
  const original = canonicalizeLegacyMetadata(
    normalizeLegacyReads(JSON.parse(await readFile(options.modelPath, "utf8")) as ProgramModel),
  );
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
      if (validateProgramModel(analyzeProgram(candidate)).length > 0) {
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

/// The optional entries-aware levers of an exact-manual group, each individually droppable when
/// shrinking. Module membership is already shrunk by `dropModule` and whole-group removal below.
const MANUAL_OPTIONAL_FIELDS = ["entriesAware", "entriesAwareMergeThreshold"] as const;

/// The optional levers of an organic chunk group, each individually droppable when shrinking.
const ORGANIC_OPTIONAL_FIELDS = [
  "test",
  "minSize",
  "maxSize",
  "minShareCount",
  "priority",
  "includeDependenciesRecursively",
  "entriesAware",
  "entriesAwareMergeThreshold",
] as const;

/// Canonicalize a LEGACY (schema ≤17) program's `sideEffectFree` flags onto the `packages`
/// representation ONCE at shrink entry (SAFE note: the shrinker had TWO metadata mutation
/// representations — a raw-flag unflag AND package edits — for equivalent metadata). After this, the
/// shrinker works in ONE representation: the package candidates below. Semantically identical through
/// `packagesOf` (each flag becomes the same single-member `sef-<id>` package the seam resolves), so the
/// rendered bytes and failure signature are unchanged; a program already carrying packages, or with no
/// flags, is returned untouched.
function canonicalizeLegacyMetadata(program: ProgramModel): ProgramModel {
  if (program.packages !== undefined) {
    return program;
  }
  const flaggedIds = program.modules
    .filter((module) => module.sideEffectFree === true)
    .map((module) => module.id);
  if (flaggedIds.length === 0) {
    return program;
  }
  const modules = program.modules.map((module): ModuleModel => {
    if (module.sideEffectFree !== true) {
      return module;
    }
    const next = { ...module };
    delete (next as { sideEffectFree?: true }).sideEffectFree;
    return next as ModuleModel;
  });
  return { ...program, modules, packages: flaggedIds.map(legacySideEffectFreePackage) };
}

/// Replace a program's packages, dropping the field entirely when none remain (the persisted shape
/// the generator emits — `packages: []` and absence resolve identically through `packagesOf`).
function withPackages(program: ProgramModel, packages: readonly PackageModel[]): ProgramModel {
  const next: ProgramModel = { ...program, packages };
  if (packages.length === 0) {
    delete (next as { packages?: unknown }).packages;
  }
  return next;
}

/// Re-canonicalize a program onto a `build.chunking` union, preserving the other BuildConfig axes and
/// clearing any legacy top-level chunk arrays so `build.chunking` is the single source of truth.
function withChunking(program: ProgramModel, chunking: Chunking): ProgramModel {
  const next: ProgramModel = { ...program, build: { ...buildConfigOf(program), chunking } };
  delete (next as { manualChunkGroups?: unknown }).manualChunkGroups;
  delete (next as { organicChunkGroups?: unknown }).organicChunkGroups;
  return next;
}

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
  // Chunking shrink over the resolved `build.chunking` union (or a legacy program's top-level arrays):
  // drop a manual group (falling back to automatic when the last is gone), drop the organic config
  // entirely, or shrink an organic group field-by-field toward the minimal lever the bug needs. Each
  // candidate re-canonicalizes onto `build.chunking`; the greedy pass keeps it only if the failure kind
  // is preserved, which also reveals whether the chunking is load-bearing.
  const chunking = programChunking(program);
  if (chunking.kind === "manual") {
    for (const [index, group] of chunking.groups.entries()) {
      const groups = chunking.groups.filter((_, i) => i !== index);
      yield withChunking(
        program,
        groups.length > 0 ? { kind: "manual", groups } : { kind: "automatic" },
      );
      for (const field of MANUAL_OPTIONAL_FIELDS) {
        if (group[field] === undefined) {
          continue;
        }
        const trimmed = { ...group };
        delete (trimmed as Record<string, unknown>)[field];
        yield withChunking(program, {
          kind: "manual",
          groups: chunking.groups.map((candidate, groupIndex) =>
            groupIndex === index ? trimmed : candidate,
          ),
        });
      }
    }
  }
  if (chunking.kind === "organic") {
    yield withChunking(program, { kind: "automatic" });
    for (const [groupIndex, group] of chunking.groups.entries()) {
      if (chunking.groups.length > 1) {
        yield withChunking(program, {
          kind: "organic",
          groups: chunking.groups.filter((_, index) => index !== groupIndex),
        });
      }
      for (const field of ORGANIC_OPTIONAL_FIELDS) {
        if (group[field] === undefined) {
          continue;
        }
        const trimmed = { ...group };
        delete (trimmed as Record<string, unknown>)[field];
        yield withChunking(program, {
          kind: "organic",
          groups: chunking.groups.map((candidate, index) =>
            index === groupIndex ? trimmed : candidate,
          ),
        });
      }
    }
  }
  // BuildConfig axis shrink (W14a): try each rolled axis at its rolldown default, revealing whether it
  // is load-bearing for the failure. `includeDependenciesRecursively:false` is an ingredient of the
  // #9887 cross-chunk-cycle catch; `lazyBarrel:true` is the barrel-pruning axis.
  const build = buildConfigOf(program);
  if (build.includeDependenciesRecursively !== true) {
    yield { ...program, build: { ...build, includeDependenciesRecursively: true } };
  }
  if (build.lazyBarrel !== false) {
    yield { ...program, build: { ...build, lazyBarrel: false } };
  }
  // W12: try the minify axis at its default (false), revealing whether minify is load-bearing. A
  // minify-ONLY red (a divergence that only reproduces under mangling) rejects this candidate, so minify
  // stays `true` in the shrunk artifact — the "shrink must reproduce with minify preserved" contract. A
  // red that does not need minify flips to false, simplifying the artifact. (The whole `build` already
  // rides along every candidate via `buildConfigOf`, so a preserved minify replays through the adapter.)
  if (build.minify !== false) {
    yield { ...program, build: { ...build, minify: false } };
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
        const removedKey = (removedMember ?? []).join("\0");
        const removedDeepest = removedMember?.[removedMember.length - 1];
        const dependencies = module.dependencies.map((candidate, index) =>
          index === depIndex
            ? {
                ...dependency,
                readMembers: dependency.readMembers.filter((_, i) => i !== memberIndex),
                // A callable member (`ns.….member()`) must also leave callMembers, else the removed
                // member lingers in callMembers (which must name deepest members of readMembers) and the
                // candidate fails validation and is silently skipped.
                ...(dependency.callMembers !== undefined && removedDeepest !== undefined
                  ? {
                      callMembers: dependency.callMembers.filter(
                        (member) => member !== removedDeepest,
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
            (read) =>
              !(
                read.binding === dependency.localName &&
                (read.memberPath ?? []).join("\0") === removedKey
              ),
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
  // A LOCAL re-export (`import { s as l } …; export { l as e };`) shrinks in TWO INDEPENDENT steps so a
  // rejection is a CLEAN causal proof (SAFE note: the old combined downgrade ALSO dropped the local
  // binding's event reads, so a rejection could not tell the live-import FORM being load-bearing — the
  // camunda mechanism — from the READ being load-bearing):
  //   1. If an event reads the local binding, drop those reads while KEEPING the local form — testing
  //      whether the read is load-bearing (nothing else changes).
  //   2. Otherwise downgrade to the source-form named re-export (`export { s as e } from …`) — a PURE
  //      form change (supply routing is identical; no binding remains to read), so its rejection proves
  //      the LIVE-import form is load-bearing. Because step 1 lands first, the greedy pass reaches this
  //      pure downgrade only once the reads are gone.
  for (const [moduleIndex, module] of program.modules.entries()) {
    for (const [depIndex, dependency] of module.dependencies.entries()) {
      if (dependency.kind !== "esm-local-reexport") {
        continue;
      }
      const readsBinding = module.events.some((event) =>
        (event.reads ?? []).some((read) => read.binding === dependency.localName),
      );
      if (readsBinding) {
        const events = module.events.map((event) =>
          dropReadsOfBinding(event, dependency.localName),
        );
        yield editModule(program, moduleIndex, { ...module, events } as typeof module);
        continue;
      }
      const dependencies = module.dependencies.map((candidate, index) =>
        index === depIndex
          ? ({
              kind: "esm-reexport-named",
              target: dependency.target,
              sourceName: dependency.sourceName,
              exportedName: dependency.exportedName,
            } as const)
          : candidate,
      );
      yield editModule(program, moduleIndex, { ...module, dependencies } as typeof module);
    }
  }
  // (The legacy `sideEffectFree`-flag unflag candidate is gone: `canonicalizeLegacyMetadata` normalizes
  // the flags onto `packages` at shrink entry, so the package candidates below are the ONE metadata path.)
  // Package/layout candidates (W14b), coarsest first. Each reveals a distinct load-bearing question:
  // dropping a whole package (members return to root paths, relative specifiers) asks whether the
  // node_modules boundary matters at all; `sideEffects -> true` keeps the layout but withdraws the
  // purity assertion (the family-B metadata ingredient); dropping ONE member or ONE array entry
  // narrows which member/pattern carries the bug. Candidates that break the metadata-purity contract
  // (e.g. an array entry removal exposing an event-carrying member as pure) fail validation and are
  // skipped by the greedy loop like any other invalid candidate.
  if (program.packages !== undefined) {
    for (const [packageIndex, pkg] of program.packages.entries()) {
      yield withPackages(
        program,
        program.packages.filter((_, index) => index !== packageIndex),
      );
      if (pkg.sideEffects !== true) {
        yield withPackages(
          program,
          program.packages.map((candidate, index) =>
            index === packageIndex ? { ...candidate, sideEffects: true } : candidate,
          ),
        );
      }
      for (const [memberIndex] of pkg.moduleIds.entries()) {
        if (pkg.moduleIds.length <= 1) {
          continue;
        }
        yield withPackages(
          program,
          program.packages.map((candidate, index) =>
            index === packageIndex
              ? {
                  ...candidate,
                  moduleIds: candidate.moduleIds.filter((_, i) => i !== memberIndex),
                }
              : candidate,
          ),
        );
      }
      if (typeof pkg.sideEffects !== "boolean") {
        for (const [entryIndex] of pkg.sideEffects.entries()) {
          const remaining = pkg.sideEffects.filter((_, i) => i !== entryIndex);
          yield withPackages(
            program,
            program.packages.map((candidate, index) =>
              index === packageIndex
                ? { ...candidate, sideEffects: remaining.length > 0 ? remaining : false }
                : candidate,
            ),
          );
        }
      }
    }
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
/// GENERALIZES over the ENRICHED canonical `RouteHop` (W14c): instead of a named/star-only switch, it
/// reads the barrel's ONE hop for the demanded name — which carries the module it forwards to
/// (`target`) and the name demanded there (`importedName`) — so a named, star, OR local re-export
/// barrel collapses through the same path (the manual switch is deleted; a nested namespace read is not
/// a single-hop rewire, so it is skipped).
function rewireReadPastBarrel(
  dependency: DependencyOperation,
  program: ProgramModel,
): DependencyOperation | undefined {
  let readName: string | undefined;
  if (dependency.kind === "esm-value-import") {
    readName = dependency.importedName;
  } else if (
    dependency.kind === "esm-namespace-import" &&
    dependency.readMembers.length === 1 &&
    dependency.readMembers[0]?.length === 1
  ) {
    readName = dependency.readMembers[0]?.[0];
  } else if (dependency.kind === "cjs-require" && dependency.readName !== undefined) {
    readName = dependency.readName;
  }
  if (readName === undefined) {
    return undefined;
  }

  const barrel = program.modules.find((module) => module.id === dependency.target);
  // Only collapse a PURE single-re-export barrel (exactly one dependency), so skipping it leaves the
  // barrel droppable by a later pass.
  if (barrel === undefined || barrel.dependencies.length !== 1) {
    return undefined;
  }
  const route = ProgramFacts.from(program.modules).resolveExportRoute(barrel.id, readName);
  if (route.status !== "supplied" || route.hops.length === 0) {
    return undefined;
  }
  const firstHop = route.hops[0];
  if (firstHop === undefined || firstHop.through !== barrel.id) {
    return undefined;
  }
  const target = firstHop.target;
  const name = firstHop.importedName;

  if (dependency.kind === "esm-value-import") {
    return { ...dependency, target, importedName: name };
  }
  if (dependency.kind === "esm-namespace-import") {
    // The read member is renamed (barrel exportedName -> definer importedName). A callMember (`ns.m()`)
    // names a read member's deepest name, so it must be renamed TOGETHER: leaving the old name in
    // callMembers breaks the callMembers ⊆ readMembers invariant and the candidate is silently skipped.
    const oldDeepest = dependency.readMembers[0]?.[0];
    const rewired = { ...dependency, target, readMembers: [[name]] };
    if (dependency.callMembers === undefined) {
      return rewired;
    }
    return {
      ...rewired,
      callMembers: dependency.callMembers.includes(oldDeepest ?? "") ? [name] : [],
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
    before.readMembers[0]?.length === 1 &&
    after.readMembers[0]?.length === 1 &&
    before.readMembers[0][0] !== after.readMembers[0][0]
  ) {
    return {
      binding: before.localName,
      from: before.readMembers[0][0] as string,
      to: after.readMembers[0][0] as string,
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
    // Only a single-level member read (`ns.from`) is renamed by a single-hop barrel rewire.
    if (
      read.binding === rename.binding &&
      read.memberPath?.length === 1 &&
      read.memberPath[0] === rename.from
    ) {
      changed = true;
      return { ...read, memberPath: [rename.to] };
    }
    return read;
  });
  return changed ? { ...event, reads } : event;
}

/// The local read binding a dependency introduces (dropped along with the dependency), or undefined
/// when it binds nothing readable (side-effect / dynamic import, plain require, source-form re-export).
function droppedReadBinding(dependency: DependencyOperation): string | undefined {
  if (
    dependency.kind === "esm-value-import" ||
    dependency.kind === "esm-namespace-import" ||
    dependency.kind === "esm-local-reexport"
  ) {
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
  // Drop the module from any manual chunk group; organic groups reference no module id (rolldown decides
  // composition) so they survive unchanged. The resulting chunking re-canonicalizes onto `build.chunking`,
  // preserving the other BuildConfig axes for a faithful replay.
  const chunking = programChunking(program);
  let nextChunking: Chunking = chunking;
  if (chunking.kind === "manual") {
    const groups = chunking.groups
      .map((group) => ({ ...group, moduleIds: group.moduleIds.filter((id) => id !== moduleId) }))
      .filter((group) => group.moduleIds.length > 0);
    nextChunking = groups.length > 0 ? { kind: "manual", groups } : { kind: "automatic" };
  }
  // Drop the module from any package membership too (an empty package disappears), so a module drop
  // is valid on its own instead of leaving a dangling member id.
  const packages = (program.packages ?? [])
    .map((pkg) => ({ ...pkg, moduleIds: pkg.moduleIds.filter((id) => id !== moduleId) }))
    .filter((pkg) => pkg.moduleIds.length > 0);
  const dropped: ProgramModel = {
    modules,
    entries,
    schedule: program.schedule.filter((op) =>
      op.kind === "trigger-dynamic-import"
        ? !droppedRegistrations.has(op.registration)
        : entryNames.has(op.entry),
    ),
    build: { ...buildConfigOf(program), chunking: nextChunking },
  };
  return program.packages === undefined ? dropped : withPackages(dropped, packages);
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
///
/// The canonical index is keyed by the CAPTURED NUMERIC MODULE IDENTITY (the shared `NNNN`), NOT the
/// whole token, so the three chunk-internal forms Rolldown derives from ONE `module-NNNN` basename
/// (`module_NNNN`, `init_module_NNNN`, `require_module_NNNN`) — which all name the SAME module — collapse
/// to the SAME index while keeping their prefix distinct. Keying by the whole token instead let a
/// two-module failure (`init_module_0001` + `module_0002`) compare equal to a one-module failure
/// (`init_module_0002` + `module_0002`), because each token became a fresh index by first appearance —
/// the cross-prefix soundness hole this fixes.
function normalizeSignature(signature: string): string {
  const withoutPaths = signature.replaceAll(/(?:\/[^\s"':]+)+\/(module-\d+\.[mc]js)/g, "$1");
  let counter = 0;
  const canonicalByNumber = new Map<string, string>();
  const indexFor = (digits: string): string => {
    let index = canonicalByNumber.get(digits);
    if (index === undefined) {
      index = `N${counter}`;
      counter += 1;
      canonicalByNumber.set(digits, index);
    }
    return index;
  };
  return (
    withoutPaths
      // Rolldown's chunk-internal identifiers, derived from the numeric basename.
      .replaceAll(
        /(init_module_|require_module_|module_)(\d+)/g,
        (_match, prefix: string, digits: string) => `${prefix}${indexFor(digits)}`,
      )
      // The rendered module FILENAME (`module-NNNN.mjs` / `.cjs`) itself, keyed by the SAME numeric
      // identity so a renumbering shrink that renames files still compares equal to its pre-shrink
      // signature — the `module-NNNN.mjs` false-negative this closes (a survivor renamed module-0002 to
      // module-0001 kept a literal number and no longer matched, so the shrink rejected a valid step).
      .replaceAll(
        /module-(\d+)(\.[mc]js)/g,
        (_match, digits: string, extension: string) => `module-${indexFor(digits)}${extension}`,
      )
  );
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
