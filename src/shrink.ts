import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { GeneratedCase } from "./generate.ts";
import { deriveCoverageTags } from "./generate.ts";
import type { EventRecord, ProgramModel } from "./model.ts";
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
}

function withoutReads(event: EventRecord): EventRecord {
  return { module: event.module, phase: event.phase, value: event.value };
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
