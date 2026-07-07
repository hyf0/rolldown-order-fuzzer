/// <reference types="node" />

import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { executeManifest } from "../src/execute.ts";
import type { ProgramModel } from "../src/model.ts";
import {
  withRolldownBuild,
  type RolldownAdapterResult,
  type RolldownBuildArtifacts,
} from "../src/rolldown-adapter.ts";
import { renderProgram } from "../src/render.ts";
import { classifyVerdict } from "../src/verdict.ts";

describe("withRolldownBuild", () => {
  test("builds a rendered ESM program and passes the source-versus-bundle verdict", async () => {
    const program = {
      modules: [
        {
          id: "dependency",
          format: "esm",
          dependencies: [],
          events: [{ module: "dependency", phase: "evaluate", value: 1 }],
        },
        {
          id: "entry",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "dependency" }],
          events: [{ module: "entry", phase: "evaluate", value: "ready" }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    let temporaryDirectory = "";

    const result = await withRolldownBuild(program, renderProgram(program), async (artifacts) => {
      temporaryDirectory = artifacts.temporaryDirectory;
      await expect(access(artifacts.sourceDirectory)).resolves.toBeUndefined();
      await expect(access(artifacts.bundleDirectory)).resolves.toBeUndefined();

      const [sourceOutcome, bundleOutcome] = await Promise.all([
        executeManifest(artifacts.sourceManifestPath),
        executeManifest(artifacts.bundleManifestPath),
      ]);

      return {
        verdict: classifyVerdict(sourceOutcome, bundleOutcome),
        manifest: artifacts.manifest,
        outputFiles: artifacts.outputFiles,
      };
    });

    expect(successValue(result)).toEqual({
      verdict: { kind: "pass", signature: "pass" },
      manifest: {
        version: 1,
        entries: [{ name: "main", path: "entries/__entry_0000.js", format: "esm" }],
        operations: [{ kind: "import-entry", entry: "main" }],
      },
      outputFiles: ["entries/__entry_0000.js"],
    });
    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("writes an explicit ESM package boundary in the bundle directory", async () => {
    const program = singleEntryProgram();

    const result = await withRolldownBuild(program, renderProgram(program), async (artifacts) =>
      readFile(join(artifacts.bundleDirectory, "package.json"), "utf8"),
    );

    expect(successValue(result)).toBe('{\n  "type": "module"\n}\n');
  });

  test("preserves execution semantics when an ESM entry imports CommonJS", async () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "commonjs",
              importedName: "answer",
              localName: "answer",
            },
          ],
          events: [{ module: "entry", phase: "evaluate", value: "esm" }],
        },
        {
          id: "commonjs",
          format: "cjs",
          dependencies: [],
          events: [{ module: "commonjs", phase: "evaluate", value: "cjs" }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    const result = await withRolldownBuild(program, renderProgram(program), async (artifacts) => {
      const sourceOutcome = await executeManifest(artifacts.sourceManifestPath);
      const bundleOutcome = await executeManifest(artifacts.bundleManifestPath);
      return classifyVerdict(sourceOutcome, bundleOutcome);
    });

    expect(successValue(result)).toEqual({ kind: "pass", signature: "pass" });
  });

  test("translates a CJS source entry schedule for the emitted ESM entry", async () => {
    const program = {
      modules: [
        {
          id: "worker",
          format: "cjs",
          dependencies: [],
          events: [{ module: "worker", phase: "evaluate", value: "cjs-entry" }],
        },
      ],
      entries: [{ name: "worker", moduleId: "worker" }],
      schedule: [{ kind: "require-entry", entry: "worker" }],
    } satisfies ProgramModel;

    const result = await withRolldownBuild(program, renderProgram(program), async (artifacts) => {
      const [sourceOutcome, bundleOutcome] = await Promise.all([
        executeManifest(artifacts.sourceManifestPath),
        executeManifest(artifacts.bundleManifestPath),
      ]);
      return {
        verdict: classifyVerdict(sourceOutcome, bundleOutcome),
        manifest: artifacts.manifest,
      };
    });

    expect(successValue(result)).toEqual({
      verdict: { kind: "pass", signature: "pass" },
      manifest: {
        version: 1,
        entries: [{ name: "worker", path: "entries/__entry_0000.js", format: "esm" }],
        operations: [{ kind: "import-entry", entry: "worker" }],
      },
    });
  });

  test("uses the rendered schedule after the source model is mutated", async () => {
    const operation = { kind: "import-entry" as const, entry: "main" };
    const program = {
      modules: [
        {
          id: "main-entry",
          format: "esm",
          dependencies: [],
          events: [{ module: "main-entry", phase: "evaluate", value: "main" }],
        },
        {
          id: "alternate-entry",
          format: "esm",
          dependencies: [],
          events: [{ module: "alternate-entry", phase: "evaluate", value: "alternate" }],
        },
      ],
      entries: [
        { name: "main", moduleId: "main-entry" },
        { name: "alternate", moduleId: "alternate-entry" },
      ],
      schedule: [operation],
    } satisfies ProgramModel;
    const rendered = renderProgram(program);
    operation.entry = "alternate";

    const result = await withRolldownBuild(program, rendered, async (artifacts) => {
      const [sourceOutcome, bundleOutcome] = await Promise.all([
        executeManifest(artifacts.sourceManifestPath),
        executeManifest(artifacts.bundleManifestPath),
      ]);
      return {
        verdict: classifyVerdict(sourceOutcome, bundleOutcome),
        operations: artifacts.manifest.operations,
      };
    });

    expect(successValue(result)).toEqual({
      verdict: { kind: "pass", signature: "pass" },
      operations: [{ kind: "import-entry", entry: "main" }],
    });
  });

  test("emits and executes generated manual chunk groups", async () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "shared" }],
          events: [{ module: "entry", phase: "evaluate", value: "entry" }],
        },
        {
          id: "shared",
          format: "esm",
          dependencies: [],
          events: [{ module: "shared", phase: "evaluate", value: "shared" }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
      manualChunkGroups: [{ name: "forced-shared", moduleIds: ["shared"] }],
    } satisfies ProgramModel;

    const result = await withRolldownBuild(program, renderProgram(program), async (artifacts) => {
      const [sourceOutcome, bundleOutcome] = await Promise.all([
        executeManifest(artifacts.sourceManifestPath),
        executeManifest(artifacts.bundleManifestPath),
      ]);
      return {
        verdict: classifyVerdict(sourceOutcome, bundleOutcome),
        outputFiles: artifacts.outputFiles,
      };
    });

    expect(successValue(result)).toEqual({
      verdict: { kind: "pass", signature: "pass" },
      outputFiles: [
        "chunks/forced-shared.js",
        "chunks/rolldown-runtime.js",
        "entries/__entry_0000.js",
      ],
    });
  });

  test("reports an invalid configurable package specifier as a harness error", async () => {
    const program = singleEntryProgram();
    const originalPackageSpecifier = process.env.ROLLDOWN_PACKAGE;
    process.env.ROLLDOWN_PACKAGE = "rolldown-order-fuzzer-package-that-does-not-exist";

    try {
      const result = await withRolldownBuild(
        program,
        renderProgram(program),
        async (): Promise<never> => {
          throw new Error("build callback must not run");
        },
      );

      expect(result).toMatchObject({
        status: "harness-error",
        stage: "load-package",
        packageSpecifier: "rolldown-order-fuzzer-package-that-does-not-exist",
        error: {
          name: "Error",
        },
      });
      if (result.status !== "ok") {
        expect(result.error.message).toContain("rolldown-order-fuzzer-package-that-does-not-exist");
      }
    } finally {
      if (originalPackageSpecifier === undefined) {
        delete process.env.ROLLDOWN_PACKAGE;
      } else {
        process.env.ROLLDOWN_PACKAGE = originalPackageSpecifier;
      }
    }
  });

  test("classifies invalid Rolldown output after closing and cleaning up", async () => {
    const program = singleEntryProgram();
    const state = globalThis as typeof globalThis & {
      __rolldownAdapterCloseCount?: number;
      __rolldownAdapterInputPath?: string;
    };
    delete state.__rolldownAdapterCloseCount;
    delete state.__rolldownAdapterInputPath;

    await withTemporaryModule(
      [
        "export async function rolldown(options) {",
        "  globalThis.__rolldownAdapterInputPath = Object.values(options.input)[0];",
        "  return {",
        "    async write() {",
        "      return {",
        "        output: [{",
        '          type: "chunk",',
        '          fileName: "chunks/orphan.js",',
        '          name: "orphan",',
        "          isEntry: false,",
        "          facadeModuleId: null,",
        "        }],",
        "      };",
        "    },",
        "    async close() {",
        "      globalThis.__rolldownAdapterCloseCount =",
        "        (globalThis.__rolldownAdapterCloseCount ?? 0) + 1;",
        "    },",
        "  };",
        "}",
        "",
      ].join("\n"),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          program,
          renderProgram(program),
          async (): Promise<never> => {
            throw new Error("build callback must not run");
          },
          { packageSpecifier },
        );

        expect(result).toMatchObject({
          status: "build-error",
          stage: "build",
          error: {
            name: "Error",
            message: 'Rolldown did not emit entry "main"',
          },
        });
      },
    );

    expect(state.__rolldownAdapterCloseCount).toBe(1);
    const inputPath = state.__rolldownAdapterInputPath;
    expect(inputPath).toBeTypeOf("string");
    if (inputPath !== undefined) {
      await expect(access(dirname(dirname(inputPath)))).rejects.toMatchObject({ code: "ENOENT" });
    }
    delete state.__rolldownAdapterCloseCount;
    delete state.__rolldownAdapterInputPath;
  });

  test("maps entries and emitted files deterministically for package and file URL specifiers", async () => {
    const program = {
      modules: [
        {
          id: "alpha-entry",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "shared" }],
          events: [{ module: "alpha-entry", phase: "evaluate", value: "alpha" }],
        },
        {
          id: "beta-entry",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "shared" }],
          events: [{ module: "beta-entry", phase: "evaluate", value: "beta" }],
        },
        {
          id: "shared",
          format: "esm",
          dependencies: [],
          events: [{ module: "shared", phase: "evaluate", value: "shared" }],
        },
      ],
      entries: [
        { name: "alpha", moduleId: "alpha-entry" },
        { name: "beta", moduleId: "beta-entry" },
      ],
      schedule: [
        { kind: "import-entry", entry: "beta" },
        { kind: "import-entry", entry: "alpha" },
      ],
    } satisfies ProgramModel;
    const rendered = renderProgram(program);

    const first = await withRolldownBuild(program, rendered, collectOutputIdentity);
    const second = await withRolldownBuild(program, rendered, collectOutputIdentity, {
      packageSpecifier: import.meta.resolve("rolldown"),
    });

    expect(successValue(first)).toEqual(successValue(second));
    expect(successValue(first)).toEqual({
      manifest: {
        version: 1,
        entries: [
          { name: "alpha", path: "entries/__entry_0000.js", format: "esm" },
          { name: "beta", path: "entries/__entry_0001.js", format: "esm" },
        ],
        operations: [
          { kind: "import-entry", entry: "beta" },
          { kind: "import-entry", entry: "alpha" },
        ],
      },
      outputFiles: ["chunks/module-0002.js", "entries/__entry_0000.js", "entries/__entry_0001.js"],
    });
  });

  test("maps sanitized colliding entry names by facade path deterministically", async () => {
    const program = {
      modules: [
        {
          id: "question-entry",
          format: "esm",
          dependencies: [],
          events: [{ module: "question-entry", phase: "evaluate", value: "question" }],
        },
        {
          id: "underscore-entry",
          format: "esm",
          dependencies: [],
          events: [{ module: "underscore-entry", phase: "evaluate", value: "underscore" }],
        },
      ],
      entries: [
        { name: "a?", moduleId: "question-entry" },
        { name: "a_", moduleId: "underscore-entry" },
      ],
      schedule: [
        { kind: "import-entry", entry: "a?" },
        { kind: "import-entry", entry: "a_" },
      ],
    } satisfies ProgramModel;
    const rendered = renderProgram(program);
    const build = () =>
      withRolldownBuild(program, rendered, async (artifacts) => {
        const [sourceOutcome, bundleOutcome] = await Promise.all([
          executeManifest(artifacts.sourceManifestPath),
          executeManifest(artifacts.bundleManifestPath),
        ]);
        return {
          verdict: classifyVerdict(sourceOutcome, bundleOutcome),
          entries: artifacts.manifest.entries,
        };
      });

    const first = successValue(await build());
    const second = successValue(await build());

    expect(first).toEqual(second);
    expect(first.verdict).toEqual({ kind: "pass", signature: "pass" });
    expect(first.entries.map((entry) => entry.name)).toEqual(["a?", "a_"]);
    expect(first.entries.map((entry) => entry.path)).toEqual([
      "entries/__entry_0000.js",
      "entries/__entry_0001.js",
    ]);
  });

  test("maps same-source sanitized collisions with a partial schedule", async () => {
    const program = {
      modules: [
        {
          id: "shared-entry",
          format: "esm",
          dependencies: [],
          events: [{ module: "shared-entry", phase: "evaluate", value: "shared" }],
        },
      ],
      entries: [
        { name: "a?", moduleId: "shared-entry" },
        { name: "a_", moduleId: "shared-entry" },
      ],
      schedule: [{ kind: "import-entry", entry: "a_" }],
    } satisfies ProgramModel;
    const rendered = renderProgram(program);
    const build = () =>
      withRolldownBuild(program, rendered, async (artifacts) => {
        const [sourceOutcome, bundleOutcome] = await Promise.all([
          executeManifest(artifacts.sourceManifestPath),
          executeManifest(artifacts.bundleManifestPath),
        ]);
        return {
          verdict: classifyVerdict(sourceOutcome, bundleOutcome),
          entries: artifacts.manifest.entries,
          operations: artifacts.manifest.operations,
          outputFiles: artifacts.outputFiles,
        };
      });

    const first = successValue(await build());
    const second = successValue(await build());
    const entryPaths = first.entries.map((entry) => entry.path);

    expect(first).toEqual(second);
    expect(first.verdict).toEqual({ kind: "pass", signature: "pass" });
    expect(first.entries).toEqual([
      { name: "a?", path: "entries/__entry_0000.js", format: "esm" },
      { name: "a_", path: "entries/__entry_0001.js", format: "esm" },
    ]);
    expect(first.operations).toEqual([{ kind: "import-entry", entry: "a_" }]);
    expect(entryPaths.every((path) => first.outputFiles.includes(path))).toBe(true);
  });

  test("assigns distinct entry chunks to names sharing one source module", async () => {
    const program = {
      modules: [
        {
          id: "shared-entry",
          format: "esm",
          dependencies: [],
          events: [{ module: "shared-entry", phase: "evaluate", value: "shared" }],
        },
      ],
      entries: [
        { name: "alpha", moduleId: "shared-entry" },
        { name: "beta", moduleId: "shared-entry" },
      ],
      schedule: [
        { kind: "import-entry", entry: "alpha" },
        { kind: "import-entry", entry: "beta" },
      ],
    } satisfies ProgramModel;
    const rendered = renderProgram(program);
    const build = () =>
      withRolldownBuild(program, rendered, async (artifacts) => {
        const [sourceOutcome, bundleOutcome] = await Promise.all([
          executeManifest(artifacts.sourceManifestPath),
          executeManifest(artifacts.bundleManifestPath),
        ]);
        return {
          verdict: classifyVerdict(sourceOutcome, bundleOutcome),
          entries: artifacts.manifest.entries,
          operations: artifacts.manifest.operations,
          outputFiles: artifacts.outputFiles,
        };
      });

    const first = successValue(await build());
    const second = successValue(await build());
    const entryPaths = first.entries.map((entry) => entry.path);

    expect(first).toEqual(second);
    expect(first.verdict).toEqual({ kind: "pass", signature: "pass" });
    expect(first.entries.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
    expect(entryPaths).toEqual(["entries/__entry_0000.js", "entries/__entry_0001.js"]);
    expect(first.operations).toEqual([
      { kind: "import-entry", entry: "alpha" },
      { kind: "import-entry", entry: "beta" },
    ]);
    expect(entryPaths.every((path) => first.outputFiles.includes(path))).toBe(true);
  });
});

function singleEntryProgram(): ProgramModel {
  return {
    modules: [
      {
        id: "entry",
        format: "esm",
        dependencies: [],
        events: [{ module: "entry", phase: "evaluate", value: "entry" }],
      },
    ],
    entries: [{ name: "main", moduleId: "entry" }],
    schedule: [{ kind: "import-entry", entry: "main" }],
  };
}

function collectOutputIdentity(artifacts: RolldownBuildArtifacts): {
  readonly manifest: RolldownBuildArtifacts["manifest"];
  readonly outputFiles: RolldownBuildArtifacts["outputFiles"];
} {
  return {
    manifest: artifacts.manifest,
    outputFiles: artifacts.outputFiles,
  };
}

function successValue<T>(result: RolldownAdapterResult<T>): T {
  expect(result.status).toBe("ok");
  if (result.status !== "ok") {
    throw new Error(
      `${result.status} during ${result.stage}: ${result.error.name}: ${result.error.message}`,
    );
  }
  return result.value;
}

async function withTemporaryModule(
  contents: string,
  run: (packageSpecifier: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "rolldown-adapter-package-"));
  const modulePath = join(directory, "index.mjs");
  try {
    await writeFile(modulePath, contents);
    await run(pathToFileURL(modulePath).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
