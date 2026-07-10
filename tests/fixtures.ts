import type { ProgramModel } from "../src/model.ts";

/// The contents of a rendered file by path, or a clear error — shared by the render, real-app, and
/// witness tests instead of each re-declaring it.
export function fileContents(
  files: readonly { readonly path: string; readonly contents: string }[],
  path: string,
): string {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`Missing rendered file ${JSON.stringify(path)}`);
  }
  return file.contents;
}

/// The transitive `sideEffects: false` shape (rolldown #9961): a side-effectful source, a flagged
/// value-only module that folds the source's value with no events of its own, and a downstream reader
/// that folds the flagged module's value into a KEPT event. Because the observed value reaches a kept
/// event, the bundler cannot legally drop the flagged module (and its upstream) without changing the
/// number — so any divergence is a real bug. Shared by the model, render, and adapter tests.
export function sideEffectFreeTransitiveProgram(): ProgramModel {
  return {
    modules: [
      {
        id: "entry",
        format: "esm",
        dependencies: [
          { kind: "esm-value-import", target: "flagged", importedName: "w", localName: "flaggedW" },
        ],
        events: [
          { module: "entry", phase: "evaluate", value: 1, reads: [{ binding: "flaggedW" }] },
        ],
      },
      {
        id: "flagged",
        format: "esm",
        sideEffectFree: true,
        dependencies: [
          { kind: "esm-value-import", target: "source", importedName: "v", localName: "sourceV" },
        ],
        events: [],
      },
      {
        id: "source",
        format: "esm",
        dependencies: [],
        events: [{ module: "source", phase: "evaluate", value: 7 }],
      },
    ],
    entries: [{ name: "main", moduleId: "entry" }],
    schedule: [{ kind: "import-entry", entry: "main" }],
  };
}
