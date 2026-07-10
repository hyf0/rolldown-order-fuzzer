import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { GeneratedCase } from "./generate.ts";
import { deriveCoverageTags } from "./generate.ts";
import type { DependencyOperation, EventRecord, ProgramModel } from "./model.ts";
import { DEFAULT_CASE_SIZE, executeGeneratedCase, type CampaignOptions } from "./main.ts";
import { validateProgramModel } from "./validate-model.ts";

interface ShrinkOptions {
  readonly modelPath: string;
  readonly outPath: string;
  readonly rolldownPackage: string;
}

/// Greedy model shrinker. Keeps a candidate edit only when the program stays valid and the
/// verdict keeps the same failure kind (and error identity for crashes). Kind-level
/// preservation is for root-cause analysis; re-verify the mechanism before filing issues.
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
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
      if (signature !== undefined && sameFailure(baseline, signature)) {
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

/// Candidate edits, most aggressive first: drop a module (with every reference to it),
/// then drop a single dependency, an entry, a schedule operation, a manual group, an event.
function* candidates(program: ProgramModel): Generator<ProgramModel> {
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
    yield { ...program, ...(groups.length > 0 ? { manualChunkGroups: groups } : {}) };
  }
  for (const [moduleIndex, module] of program.modules.entries()) {
    if (module.events.length > 1) {
      yield editModule(program, moduleIndex, {
        ...module,
        events: module.events.slice(0, -1),
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
      yield editModule(program, moduleIndex, { ...module, dependencies } as typeof module);
    }
  }
  // Drop a redundant synchronous cycle edge — a chord, or one interlocking cycle's extra edge. An
  // edge A -> B is redundant when B can still synchronously reach A without it, so the remaining
  // cycle (and its failure mode) is preserved while the extra structure collapses. This directly
  // shrinks a chorded ring toward a bare ring and collapses two interlocking cycles toward one.
  const reachable = synchronousReachabilityForShrink(program);
  for (const [moduleIndex, module] of program.modules.entries()) {
    for (const [depIndex, dependency] of module.dependencies.entries()) {
      if (dependency.kind === "esm-dynamic-import") {
        continue;
      }
      const closesCycle = reachable.get(dependency.target)?.has(module.id) === true;
      if (!closesCycle) {
        continue;
      }
      // Redundant iff another synchronous out-edge of this module still reaches back to it.
      const stillCyclic = module.dependencies.some(
        (other, index) =>
          index !== depIndex &&
          other.kind !== "esm-dynamic-import" &&
          reachable.get(other.target)?.has(module.id) === true,
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
}

/// Synchronous (non-dynamic) reachability from each module, for detecting cycle edges when shrinking.
function synchronousReachabilityForShrink(program: ProgramModel): Map<string, Set<string>> {
  const modulesById = new Map(program.modules.map((module) => [module.id, module]));
  const reachability = new Map<string, Set<string>>();
  for (const module of program.modules) {
    const reached = new Set<string>();
    const pending = [module.id];
    while (pending.length > 0) {
      const moduleId = pending.pop();
      if (moduleId === undefined) {
        continue;
      }
      for (const dependency of modulesById.get(moduleId)?.dependencies ?? []) {
        if (dependency.kind === "esm-dynamic-import" || reached.has(dependency.target)) {
          continue;
        }
        reached.add(dependency.target);
        pending.push(dependency.target);
      }
    }
    reachability.set(module.id, reached);
  }
  return reachability;
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
    return { ...dependency, target, readMembers: [name] };
  }
  if (dependency.kind === "cjs-require") {
    return { ...dependency, target, readName: name };
  }
  return undefined;
}

function withoutReads(event: EventRecord): EventRecord {
  return { module: event.module, phase: event.phase, value: event.value };
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

/// Returns the failure signature, or undefined when the case passes.
async function run(program: ProgramModel, options: ShrinkOptions): Promise<string | undefined> {
  const generated: GeneratedCase = {
    seed: 0,
    size: DEFAULT_CASE_SIZE,
    template: "random-mixed",
    coverageTags: deriveCoverageTags(program),
    program,
  };
  const campaignOptions: CampaignOptions = {
    seed: 0,
    cases: 1,
    caseSize: DEFAULT_CASE_SIZE,
    onDemandWrapping: true,
    rolldownPackage: options.rolldownPackage,
    outDir: "failures",
    continueOnFail: false,
  };
  const result = await executeGeneratedCase(generated, campaignOptions);
  return result.verdict.kind === "pass" ? undefined : result.verdict.signature;
}

function sameFailure(baseline: string, candidate: string): boolean {
  const kind = (signature: string) => signature.split(":", 1)[0] ?? signature;
  if (kind(baseline) !== kind(candidate)) {
    return false;
  }
  if (kind(baseline) === "bundle-only-crash") {
    // Preserve error identity with module names normalized.
    const normalize = (signature: string) =>
      signature
        .replaceAll(/module_\d+/g, "module_x")
        .split(":")
        .slice(0, 2)
        .join(":");
    return normalize(baseline) === normalize(candidate);
  }
  return true;
}

function parseArgs(argv: readonly string[]): ShrinkOptions {
  let modelPath: string | undefined;
  let outPath = "shrunk-model.json";
  let rolldownPackage = process.env.ROLLDOWN_PACKAGE ?? "rolldown";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--model") {
      modelPath = argv[++index];
    } else if (argument === "--out") {
      outPath = argv[++index] ?? outPath;
    } else if (argument === "--rolldown-package") {
      rolldownPackage = argv[++index] ?? rolldownPackage;
    } else {
      throw new Error(`Unknown argument: ${String(argument)}`);
    }
  }
  if (modelPath === undefined) {
    throw new Error(
      "Usage: vp exec node src/shrink.ts --model <model.json> [--out <path>] [--rolldown-package <specifier>]",
    );
  }
  return { modelPath: resolve(modelPath), outPath: resolve(outPath), rolldownPackage };
}

await main();
