/// <reference types="node" />

/// Transplant pipeline ORCHESTRATOR (regeneration entry point). Takes an extracted graph JSON and
/// writes the committed transplant models for one app: a pure-order BASELINE (organic chunking shaped
/// like the app's real chunks, green on a correct bundler in both wrap modes) and a family-A OVERLAY
/// variant (automatic chunking, the split-read star-barrel conjunction that reds a buggy bundler in
/// both modes and returns to green when fixed). Every model is validated at the current schema before
/// it is written, and carries NO real names, paths, or code — only anonymized `m<index>` ids.
///
///   node scripts/transplant/build-models.ts <graph.json> <out-dir> [--app <name>]
///
/// See `.agents/docs/transplant-cell.md` for the extract -> reduce -> emit -> overlay flow and how to
/// add an app.

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { analyzeProgram } from "../../src/analyzed-program.ts";
import { normalizeLegacyReads, type ProgramModel } from "../../src/model.ts";
import { validateProgramModel } from "../../src/validate-model.ts";
import { loadGraph } from "./graph.ts";
import { DEFAULT_EMIT_CONFIG, emitModel } from "./emit.ts";
import { overlayFamilyA } from "./overlay.ts";
import { reduceGraph, type ReduceConfig, DEFAULT_REDUCE_CONFIG } from "./reduce.ts";

export interface BuiltModel {
  readonly name: string;
  readonly kind: "baseline" | "overlay-family-a";
  readonly program: ProgramModel;
  readonly moduleCount: number;
}

/// Build the baseline + family-A overlay models for one reduced graph. The baseline uses organic
/// chunking (real chunk-composition realism); the overlay uses automatic chunking, under which the
/// family-A conjunction reds BOTH wrap modes (organic chunking legitimately lets on-demand init the
/// definer correctly — the documented family-A / organic interaction, so the overlay picks the axis
/// that exposes the bug).
export function buildModels(
  graphPath: string,
  reduceConfig: ReduceConfig = DEFAULT_REDUCE_CONFIG,
): {
  readonly app: string;
  readonly models: readonly BuiltModel[];
  readonly stats: ReturnType<typeof reduceGraph>["meta"];
} {
  const graph = loadGraph(graphPath);
  const reduced = reduceGraph(graph, reduceConfig);
  const app = graph.meta.app || basename(graphPath).replace(/\.json$/, "");

  const baseline = normalizeLegacyReads(emitModel(reduced, DEFAULT_EMIT_CONFIG));
  const overlay = normalizeLegacyReads(
    overlayFamilyA(emitModel(reduced, { ...DEFAULT_EMIT_CONFIG, organicChunking: false }), reduced)
      .program,
  );

  for (const [label, program] of [
    ["baseline", baseline],
    ["overlay", overlay],
  ] as const) {
    const errors = validateProgramModel(analyzeProgram(program));
    if (errors.length > 0) {
      throw new Error(
        `${app} ${label} model is INVALID (${errors.length}): ${errors.slice(0, 6).join("; ")}`,
      );
    }
  }

  return {
    app,
    models: [
      { name: app, kind: "baseline", program: baseline, moduleCount: baseline.modules.length },
      {
        name: `${app}.overlay`,
        kind: "overlay-family-a",
        program: overlay,
        moduleCount: overlay.modules.length,
      },
    ],
    stats: reduced.meta,
  };
}

function main(): number {
  const [graphPath, outDir] = process.argv.slice(2);
  if (!graphPath || !outDir) {
    process.stderr.write("usage: build-models.ts <graph.json> <out-dir>\n");
    return 2;
  }
  const { app, models, stats } = buildModels(graphPath);
  mkdirSync(outDir, { recursive: true });
  for (const model of models) {
    const path = join(outDir, `${model.name}.json`);
    writeFileSync(path, `${JSON.stringify(model.program, null, 2)}\n`);
    process.stdout.write(`  wrote ${model.kind} (${model.moduleCount} modules) -> ${path}\n`);
  }
  process.stdout.write(
    `${app}: ${stats.originalModuleCount} -> ${stats.keptCount} kept ` +
      `(${stats.droppedByLeafCollapse} leaf-collapsed, ${stats.mixedFormatEdgesBroken} mixed-format edges broken)\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
