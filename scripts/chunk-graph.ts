/// <reference types="node" />

/// Chunk-graph inspection for the FW-B directed campaigns (deliverables 1 and 2). Rolldown's build child
/// returns output chunks, but the differential-oracle path only needs their file names + entry facades,
/// so it does not thread the per-chunk MODULE lists / inter-chunk imports the merge/cycle verification
/// wants. This harness builds a rendered program DIRECTLY with a target rolldown and reads the raw
/// `OutputChunk` graph (`moduleIds` + `imports`) — the same objects the child serializes — so a campaign
/// can VERIFY that a generated shape actually produced an optimizer MERGE (a chunk holding ≥2 source
/// modules) and a QUOTIENT CYCLE (chunk A imports B and B imports A). The build options are
/// RECONSTRUCTED to match the build child (`src/rolldown-build-child.ts`): the code-splitting config as
/// `createOutputOptions` shapes it (manual groups become an exact-path `test` function; organic groups a
/// `RegExp` test + thresholds; the global `includeDependenciesRecursively` fallback), and the input
/// `experimental` options (`onDemandWrapping` mirroring the run's wrap mode, `lazyBarrel`,
/// `chunkOptimization` when a group is `entriesAware`) plus the persisted `treeshake` assumptions. It is
/// a faithful reconstruction, not the child
/// process itself — if the child ever gains a new build-affecting option, mirror it here too, or the
/// inspected graph drifts from the graph that reds.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { buildConfigOf, programChunking } from "../src/model.ts";
import type { ProgramModel } from "../src/model.ts";
import { renderProgram } from "../src/render.ts";
import type { AnalyzedProgram } from "../src/analyzed-program.ts";

export interface ChunkNode {
  readonly fileName: string;
  readonly isEntry: boolean;
  readonly facadeModuleId: string | null;
  /// The model module ids this chunk contains (mapped back from rolldown's absolute module paths).
  readonly moduleIds: readonly string[];
  /// The file names of the chunks this chunk statically imports.
  readonly imports: readonly string[];
}

export interface ChunkGraph {
  readonly chunks: readonly ChunkNode[];
  /// Chunks holding ≥2 model modules — an optimizer MERGE happened (rolldown folded modules that would
  /// otherwise be separate chunks into one). The count is the merge density signal.
  readonly mergedChunkCount: number;
  /// A cycle in the emitted chunk import graph (chunk A imports B, …, imports A) — the QUOTIENT CYCLE the
  /// optimizer is not supposed to create. Its presence on a fixed release is a live catch.
  readonly hasQuotientCycle: boolean;
  readonly cycleMembers: readonly string[];
}

/// Reconstruct rolldown's `codeSplitting` for a program, matching `createOutputOptions` (build child).
function codeSplittingFor(
  program: ProgramModel,
  modulePaths: ReadonlyMap<string, string>,
  baseDir: string,
): { codeSplitting: unknown; chunkOptimization: boolean } {
  const build = buildConfigOf(program);
  const chunking = programChunking(program);
  const abs = (moduleId: string): string => resolve(join(baseDir, modulePaths.get(moduleId) ?? ""));
  if (chunking.kind === "disabled") {
    return { codeSplitting: false, chunkOptimization: false };
  }
  if (chunking.kind === "manual") {
    const groups = chunking.groups.map((group) => {
      const paths = new Set(group.moduleIds.map((id) => abs(id)));
      return {
        name: group.name,
        test: (moduleId: string) => paths.has(resolve(moduleId)),
        ...(group.entriesAware === undefined ? {} : { entriesAware: group.entriesAware }),
        ...(group.entriesAwareMergeThreshold === undefined
          ? {}
          : { entriesAwareMergeThreshold: group.entriesAwareMergeThreshold }),
      };
    });
    return {
      codeSplitting: {
        groups,
        includeDependenciesRecursively: build.includeDependenciesRecursively,
      },
      chunkOptimization: chunking.groups.some((group) => group.entriesAware === true),
    };
  }
  if (chunking.kind === "organic") {
    const groups = chunking.groups.map((group) => ({
      name: group.name,
      ...(group.test === undefined ? {} : { test: new RegExp(group.test) }),
      ...(group.minSize === undefined ? {} : { minSize: group.minSize }),
      ...(group.maxSize === undefined ? {} : { maxSize: group.maxSize }),
      ...(group.minShareCount === undefined ? {} : { minShareCount: group.minShareCount }),
      ...(group.priority === undefined ? {} : { priority: group.priority }),
      ...(group.includeDependenciesRecursively === undefined
        ? {}
        : { includeDependenciesRecursively: group.includeDependenciesRecursively }),
      ...(group.entriesAware === undefined ? {} : { entriesAware: group.entriesAware }),
      ...(group.entriesAwareMergeThreshold === undefined
        ? {}
        : { entriesAwareMergeThreshold: group.entriesAwareMergeThreshold }),
    }));
    return {
      codeSplitting: {
        groups,
        includeDependenciesRecursively: build.includeDependenciesRecursively,
      },
      chunkOptimization: chunking.groups.some((group) => group.entriesAware === true),
    };
  }
  return { codeSplitting: true, chunkOptimization: false };
}

/// Detect a cycle in the chunk import graph (by file name). Returns the sorted members of the first cycle
/// found, or an empty list.
function findChunkCycle(chunks: readonly ChunkNode[]): readonly string[] {
  const edges = new Map(chunks.map((chunk) => [chunk.fileName, chunk.imports]));
  const state = new Map<string, number>(); // 0=unseen, 1=on-stack, 2=done
  let cycle: string[] = [];
  const stack: string[] = [];
  const visit = (node: string): boolean => {
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (!edges.has(next)) {
        continue;
      }
      const s = state.get(next) ?? 0;
      if (s === 1) {
        const start = stack.indexOf(next);
        cycle = stack.slice(start >= 0 ? start : 0);
        return true;
      }
      if (s === 0 && visit(next)) {
        return true;
      }
    }
    stack.pop();
    state.set(node, 2);
    return false;
  };
  for (const chunk of chunks) {
    if ((state.get(chunk.fileName) ?? 0) === 0 && visit(chunk.fileName)) {
      return [...cycle].sort();
    }
  }
  return [];
}

/// Build a rendered program with `rolldownPackage` and return its chunk graph. The program is written to
/// an isolated temp dir, built with the reconstructed code-splitting config, and the raw `OutputChunk`
/// graph is read back; the temp dir is removed before returning. `onDemandWrapping` mirrors the wrap
/// mode of the campaign run being verified (default `true`, the campaigns' mode) so the inspected graph
/// is built with the SAME input experimental options as the production build child — probed identical
/// merge/cycle verdicts for the FW-B shapes either way, but a future shape whose chunking depends on
/// wrapping must not silently inspect a different build.
export async function inspectChunkGraph(
  analyzed: AnalyzedProgram,
  rolldownPackage: string,
  onDemandWrapping = true,
): Promise<ChunkGraph> {
  const { program } = analyzed;
  const rendered = renderProgram(analyzed);
  // realpath so the dir matches rolldown's resolved module ids: on macOS mkdtemp returns a `/var/...`
  // path while rolldown resolves the canonical `/private/var/...`, and the mismatch would make the
  // manual-group `test` (exact-path match) and the moduleId→id remap both miss.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-b-chunk-")));
  try {
    for (const file of rendered.files) {
      const target = join(dir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.contents);
    }
    const input: Record<string, string> = {};
    for (const [name, relPath] of rendered.entryPaths) {
      input[name] = resolve(join(dir, relPath));
    }
    const pathToId = new Map(
      [...rendered.modulePaths].map(([id, relPath]) => [resolve(join(dir, relPath)), id]),
    );
    const { codeSplitting, chunkOptimization } = codeSplittingFor(
      program,
      rendered.modulePaths,
      dir,
    );
    const { rolldown } = (await import(rolldownPackage)) as {
      rolldown: (options: unknown) => Promise<{
        generate: (options: unknown) => Promise<{ output: readonly unknown[] }>;
        close?: () => Promise<void>;
      }>;
    };
    const build = buildConfigOf(program);
    const bundle = await rolldown({
      input,
      preserveEntrySignatures: build.preserveEntrySignatures,
      treeshake: build.treeshake,
      // The INPUT `experimental` options, mirroring the build child (`rolldown-build-child.ts`):
      // `onDemandWrapping` (the wrap mode of the run being verified), `lazyBarrel`, and
      // `chunkOptimization` when an entriesAware group asks for it.
      experimental: {
        onDemandWrapping,
        lazyBarrel: build.lazyBarrel,
        ...(chunkOptimization ? { chunkOptimization: true } : {}),
      },
    });
    const generated = await bundle.generate({
      format: build.outputFormat,
      dir: join(dir, "dist"),
      strictExecutionOrder: build.strictExecutionOrder,
      codeSplitting,
      minify: build.minify,
      generatedCode: { profilerNames: build.profilerNames },
    });
    await bundle.close?.();
    const chunks: ChunkNode[] = [];
    for (const raw of generated.output) {
      const chunk = raw as {
        type: string;
        fileName: string;
        isEntry?: boolean;
        facadeModuleId?: string | null;
        moduleIds?: readonly string[];
        imports?: readonly string[];
      };
      if (chunk.type !== "chunk") {
        continue;
      }
      chunks.push({
        fileName: chunk.fileName,
        isEntry: chunk.isEntry ?? false,
        facadeModuleId: chunk.facadeModuleId ?? null,
        moduleIds: (chunk.moduleIds ?? []).flatMap((path) => {
          const id = pathToId.get(resolve(path));
          return id === undefined ? [] : [id];
        }),
        imports: chunk.imports ?? [],
      });
    }
    const cycleMembers = findChunkCycle(chunks);
    return {
      chunks,
      mergedChunkCount: chunks.filter((chunk) => chunk.moduleIds.length >= 2).length,
      hasQuotientCycle: cycleMembers.length > 0,
      cycleMembers,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
