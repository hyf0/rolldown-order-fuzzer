/// <reference types="node" />

import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
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

const DEVTOOLS_SESSION_ID_ALLOCATION_ATTEMPTS = 64;

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

  test("collects the strict execution order action after close and cleans its session", async () => {
    const program = singleEntryProgram();
    const state = globalThis as typeof globalThis & {
      __rolldownAdapterSessionDirectories?: string[];
      __rolldownAdapterSessionIds?: string[];
    };
    delete state.__rolldownAdapterSessionDirectories;
    delete state.__rolldownAdapterSessionIds;
    let sessionDirectory = "";

    await withTemporaryModule(
      fakeRolldownModule([orderTraceAction()]),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          program,
          renderProgram(program),
          async (artifacts) => {
            sessionDirectory = state.__rolldownAdapterSessionDirectories?.[0] ?? "";
            await expect(access(sessionDirectory)).resolves.toBeUndefined();
            return artifacts.orderTrace;
          },
          { packageSpecifier },
        );

        expect(successValue(result)).toEqual(orderTraceAction());
        expect(state.__rolldownAdapterSessionIds).toHaveLength(1);
      },
    );

    await expect(access(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    delete state.__rolldownAdapterSessionDirectories;
    delete state.__rolldownAdapterSessionIds;
  });

  test("canonicalizes trace metadata and module IDs across temporary build roots", async () => {
    const program = singleEntryProgram();
    const rendered = renderProgram(program);

    await withTemporaryModule(fakeCanonicalTraceRolldownModule(), async (packageSpecifier) => {
      const build = () =>
        withRolldownBuild(program, rendered, async (artifacts) => artifacts.orderTrace, {
          packageSpecifier,
        });
      const first = successValue(await build());
      const second = successValue(await build());
      const expected = {
        action: "StrictExecutionOrderPlanReady",
        version: 1,
        roots: [
          {
            root_module_id: "entry",
            expected_order: ["<source>/runtime.cjs", "entry", "rolldown:runtime"],
            predicted_pre_wrap_order: ["entry", "<source>/runtime.cjs"],
            at_risk_modules: ["entry"],
          },
        ],
        plan_modules: [{ module_id: "entry", reasons: ["direct-violation"] }],
        included_modules: [
          {
            module_id: "entry",
            original_wrap_kind: "none",
            final_wrap_kind: "esm",
            final_chunk_id: 1,
            entry_chunk_id: 1,
            wrapper_included: true,
            tla_tainted: false,
          },
        ],
        rendered_chunks: [
          {
            chunk_id: 1,
            module_ids: ["entry", "<source>/runtime.cjs", "rolldown:runtime"],
            static_chunk_imports: [],
            dynamic_chunk_imports: [],
          },
        ],
        init_obligations: [
          {
            kind: "direct-import",
            importer_id: "entry",
            importee_id: "<source>/runtime.cjs",
            awaited: false,
            importer_tla_tainted: false,
            importee_tla_tainted: false,
          },
        ],
      };

      expect(first).toEqual(expected);
      expect(second).toEqual(expected);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });
  });

  test("returns a null trace when the devtools log has no matching action", async () => {
    const program = singleEntryProgram();

    await withTemporaryModule(
      fakeRolldownModule([{ action: "BuildEnd", build_id: "build-1" }]),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          program,
          renderProgram(program),
          async (artifacts) => artifacts.orderTrace,
          { packageSpecifier },
        );

        expect(successValue(result)).toBeNull();
      },
    );
  });

  test("reports malformed matching actions as harness errors and cleans the session", async () => {
    const program = singleEntryProgram();
    const state = globalThis as typeof globalThis & {
      __rolldownAdapterSessionDirectories?: string[];
    };
    delete state.__rolldownAdapterSessionDirectories;

    await withTemporaryModule(
      fakeRolldownModule([{ ...orderTraceAction(), version: 2 }]),
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
          status: "harness-error",
          stage: "collect-order-trace",
          error: {
            name: "TypeError",
            message: "Unsupported StrictExecutionOrderPlanReady version: 2",
          },
        });
      },
    );

    const sessionDirectory = state.__rolldownAdapterSessionDirectories?.[0] ?? "";
    await expect(access(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    delete state.__rolldownAdapterSessionDirectories;
  });

  test("assigns unique devtools sessions to concurrent builds", async () => {
    const program = singleEntryProgram();
    const rendered = renderProgram(program);
    const state = globalThis as typeof globalThis & {
      __rolldownAdapterSessionDirectories?: string[];
      __rolldownAdapterSessionIds?: string[];
    };
    delete state.__rolldownAdapterSessionDirectories;
    delete state.__rolldownAdapterSessionIds;

    await withTemporaryModule(fakeRolldownModule([]), async (packageSpecifier) => {
      const results = await Promise.all([
        withRolldownBuild(program, rendered, async (artifacts) => artifacts.orderTrace, {
          packageSpecifier,
        }),
        withRolldownBuild(program, rendered, async (artifacts) => artifacts.orderTrace, {
          packageSpecifier,
        }),
      ]);

      expect(results.map(successValue)).toEqual([null, null]);
      expect(state.__rolldownAdapterSessionIds).toHaveLength(2);
      expect(new Set(state.__rolldownAdapterSessionIds).size).toBe(2);
      const counters = (state.__rolldownAdapterSessionIds ?? [])
        .map(sessionIdCounter)
        .sort((left, right) => left - right);
      expect(counters).toHaveLength(2);
      expect(counters[1]).toBe((counters[0] ?? -1) + 1);
    });

    const sessionDirectories = state.__rolldownAdapterSessionDirectories ?? [];
    expect(sessionDirectories).toHaveLength(2);
    await Promise.all(
      sessionDirectories.map((directory) =>
        expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" }),
      ),
    );
    delete state.__rolldownAdapterSessionDirectories;
    delete state.__rolldownAdapterSessionIds;
  });

  test("skips a pre-existing first candidate before calling an honoring producer", async () => {
    const program = singleEntryProgram();
    const rendered = renderProgram(program);
    const state = globalThis as typeof globalThis & {
      __rolldownAdapterSessionIds?: string[];
    };

    await withPredictedNextSessionId(async (requestedSessionId) => {
      const sentinelDirectory = join(
        process.cwd(),
        "node_modules",
        ".rolldown",
        requestedSessionId,
      );
      await mkdir(sentinelDirectory, { recursive: true });
      await writeFile(
        join(sentinelDirectory, "meta.json"),
        `${JSON.stringify({
          action: "SessionMeta",
          inputs: [{ name: "sentinel", filename: "/unrelated/sentinel.js" }],
        })}\n`,
      );
      await writeFile(
        join(sentinelDirectory, "logs.json"),
        `${JSON.stringify({ action: "BuildEnd", sentinel: true })}\n`,
      );

      try {
        await withTemporaryModule(
          fakeRolldownModule([orderTraceAction()]),
          async (packageSpecifier) => {
            const result = await withRolldownBuild(
              program,
              rendered,
              async (artifacts) => artifacts.orderTrace,
              { packageSpecifier },
            );

            expect(successValue(result)).toEqual(orderTraceAction());
          },
        );

        const actualSessionId = state.__rolldownAdapterSessionIds?.at(-1);
        expect(actualSessionId).toBeTypeOf("string");
        expect(actualSessionId).not.toBe(requestedSessionId);
        expect(sessionIdCounter(actualSessionId ?? "")).toBe(
          sessionIdCounter(requestedSessionId) + 1,
        );
        await expect(access(sentinelDirectory)).resolves.toBeUndefined();
        await expect(readFile(join(sentinelDirectory, "logs.json"), "utf8")).resolves.toContain(
          '"sentinel":true',
        );
      } finally {
        await rm(sentinelDirectory, { recursive: true, force: true });
      }
    });
  });

  test("reports a harness error when every bounded session candidate exists", async () => {
    const program = singleEntryProgram();

    await withPredictedNextSessionId(async (firstSessionId) => {
      const devtoolsRoot = join(process.cwd(), "node_modules", ".rolldown");
      const sessionIds = Array.from(
        { length: DEVTOOLS_SESSION_ID_ALLOCATION_ATTEMPTS },
        (_, index) =>
          sessionIdWithCounter(firstSessionId, sessionIdCounter(firstSessionId) + index),
      );
      const sentinelDirectories = sessionIds.map((sessionId) => join(devtoolsRoot, sessionId));
      await Promise.all(
        sentinelDirectories.map(async (directory) => {
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, "sentinel.txt"), "keep\n");
        }),
      );

      try {
        await withTemporaryModule(fakeNoSessionRolldownModule(), async (packageSpecifier) => {
          const result = await withRolldownBuild(
            program,
            renderProgram(program),
            async (): Promise<never> => {
              throw new Error("build callback must not run");
            },
            { packageSpecifier },
          );

          expect(result).toMatchObject({
            status: "harness-error",
            stage: "collect-order-trace",
            error: {
              name: "Error",
              message: "Unable to allocate a unique Rolldown devtools session ID after 64 attempts",
            },
          });
        });

        await Promise.all(
          sentinelDirectories.map((directory) =>
            expect(readFile(join(directory, "sentinel.txt"), "utf8")).resolves.toBe("keep\n"),
          ),
        );
      } finally {
        await Promise.all(
          sentinelDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
        );
      }
    });
  });

  test("skips a candidate created while loading the honoring producer", async () => {
    const program = singleEntryProgram();
    const state = globalThis as typeof globalThis & {
      __rolldownAdapterSessionIds?: string[];
    };

    await withPredictedNextSessionId(async (requestedSessionId) => {
      const sentinelDirectory = join(
        process.cwd(),
        "node_modules",
        ".rolldown",
        requestedSessionId,
      );

      try {
        await withTemporaryModule(
          fakeImportCollisionRolldownModule(requestedSessionId),
          async (packageSpecifier) => {
            const result = await withRolldownBuild(
              program,
              renderProgram(program),
              async (artifacts) => artifacts.orderTrace,
              { packageSpecifier },
            );

            expect(successValue(result)).toEqual(orderTraceAction());
          },
        );

        const actualSessionId = state.__rolldownAdapterSessionIds?.at(-1);
        expect(actualSessionId).toBeTypeOf("string");
        expect(actualSessionId).not.toBe(requestedSessionId);
        expect(sessionIdCounter(actualSessionId ?? "")).toBe(
          sessionIdCounter(requestedSessionId) + 1,
        );
        await expect(readFile(join(sentinelDirectory, "sentinel.txt"), "utf8")).resolves.toBe(
          "keep\n",
        );
      } finally {
        await rm(sentinelDirectory, { recursive: true, force: true });
      }
    });
  });

  test("does not delete a pre-existing requested sentinel when package loading fails", async () => {
    const program = singleEntryProgram();

    await withPredictedNextSessionId(async (requestedSessionId) => {
      const sentinelDirectory = join(
        process.cwd(),
        "node_modules",
        ".rolldown",
        requestedSessionId,
      );
      await mkdir(sentinelDirectory, { recursive: true });
      await writeFile(join(sentinelDirectory, "sentinel.txt"), "keep\n");

      try {
        const result = await withRolldownBuild(
          program,
          renderProgram(program),
          async (): Promise<never> => {
            throw new Error("build callback must not run");
          },
          { packageSpecifier: "rolldown-order-fuzzer-package-that-does-not-exist" },
        );

        expect(result).toMatchObject({
          status: "harness-error",
          stage: "load-package",
        });
        await expect(readFile(join(sentinelDirectory, "sentinel.txt"), "utf8")).resolves.toBe(
          "keep\n",
        );
      } finally {
        await rm(sentinelDirectory, { recursive: true, force: true });
      }
    });
  });

  test("preserves a requested sentinel while cleaning a separately owned legacy session", async () => {
    const program = singleEntryProgram();
    const state = globalThis as typeof globalThis & {
      __rolldownAdapterLegacySessionDirectories?: string[];
    };
    delete state.__rolldownAdapterLegacySessionDirectories;

    await withPredictedNextSessionId(async (requestedSessionId) => {
      const sentinelDirectory = join(
        process.cwd(),
        "node_modules",
        ".rolldown",
        requestedSessionId,
      );
      await mkdir(sentinelDirectory, { recursive: true });
      await writeFile(join(sentinelDirectory, "sentinel.txt"), "keep\n");

      try {
        await withTemporaryModule(
          fakeLegacyRolldownModule(`${JSON.stringify(orderTraceAction())}\n`),
          async (packageSpecifier) => {
            const result = await withRolldownBuild(
              program,
              renderProgram(program),
              async (artifacts) => artifacts.orderTrace,
              { packageSpecifier },
            );

            expect(successValue(result)).toEqual(orderTraceAction());
          },
        );

        await expect(readFile(join(sentinelDirectory, "sentinel.txt"), "utf8")).resolves.toBe(
          "keep\n",
        );
        const legacyDirectory = state.__rolldownAdapterLegacySessionDirectories?.[0] ?? "";
        await expect(access(legacyDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(sentinelDirectory, { recursive: true, force: true });
      }
    });

    delete state.__rolldownAdapterLegacySessionDirectories;
  });

  test("discovers and cleans a legacy session while leaving unrelated sessions untouched", async () => {
    const program = singleEntryProgram();
    const state = globalThis as typeof globalThis & {
      __rolldownAdapterLegacySessionDirectories?: string[];
      __rolldownAdapterUnrelatedSessionDirectories?: string[];
    };
    delete state.__rolldownAdapterLegacySessionDirectories;
    delete state.__rolldownAdapterUnrelatedSessionDirectories;

    await withTemporaryModule(
      fakeLegacyRolldownModule(`${JSON.stringify(orderTraceAction())}\n`, 1, true),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          program,
          renderProgram(program),
          async (artifacts) => artifacts.orderTrace,
          { packageSpecifier },
        );

        expect(successValue(result)).toEqual(orderTraceAction());
      },
    );

    const matched = state.__rolldownAdapterLegacySessionDirectories?.[0] ?? "";
    const unrelated = state.__rolldownAdapterUnrelatedSessionDirectories?.[0] ?? "";
    await expect(access(matched)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(unrelated)).resolves.toBeUndefined();
    await rm(unrelated, { recursive: true, force: true });
    delete state.__rolldownAdapterLegacySessionDirectories;
    delete state.__rolldownAdapterUnrelatedSessionDirectories;
  });

  test("cleans a matched legacy session when it contains no strict-order action", async () => {
    const program = singleEntryProgram();
    const state = globalThis as typeof globalThis & {
      __rolldownAdapterLegacySessionDirectories?: string[];
    };
    delete state.__rolldownAdapterLegacySessionDirectories;

    await withTemporaryModule(
      fakeLegacyRolldownModule(`${JSON.stringify({ action: "BuildEnd" })}\n`),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          program,
          renderProgram(program),
          async (artifacts) => artifacts.orderTrace,
          { packageSpecifier },
        );

        expect(successValue(result)).toBeNull();
      },
    );

    const matched = state.__rolldownAdapterLegacySessionDirectories?.[0] ?? "";
    await expect(access(matched)).rejects.toMatchObject({ code: "ENOENT" });
    delete state.__rolldownAdapterLegacySessionDirectories;
  });

  test("leaves ambiguous matching legacy sessions untouched and returns a null trace", async () => {
    const program = singleEntryProgram();
    const state = globalThis as typeof globalThis & {
      __rolldownAdapterLegacySessionDirectories?: string[];
    };
    delete state.__rolldownAdapterLegacySessionDirectories;

    await withTemporaryModule(
      fakeLegacyRolldownModule(`${JSON.stringify(orderTraceAction())}\n`, 2),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          program,
          renderProgram(program),
          async (artifacts) => artifacts.orderTrace,
          { packageSpecifier },
        );

        expect(successValue(result)).toBeNull();
      },
    );

    const matched = state.__rolldownAdapterLegacySessionDirectories ?? [];
    expect(matched).toHaveLength(2);
    await Promise.all(
      matched.map((directory) => expect(access(directory)).resolves.toBeUndefined()),
    );
    await Promise.all(matched.map((directory) => rm(directory, { recursive: true, force: true })));
    delete state.__rolldownAdapterLegacySessionDirectories;
  });

  test("reports malformed logs from a matched legacy session and still cleans it", async () => {
    const program = singleEntryProgram();
    const state = globalThis as typeof globalThis & {
      __rolldownAdapterLegacySessionDirectories?: string[];
    };
    delete state.__rolldownAdapterLegacySessionDirectories;

    await withTemporaryModule(
      fakeLegacyRolldownModule("{not-json}\n"),
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
          status: "harness-error",
          stage: "collect-order-trace",
          error: {
            name: "TypeError",
          },
        });
      },
    );

    const matched = state.__rolldownAdapterLegacySessionDirectories?.[0] ?? "";
    await expect(access(matched)).rejects.toMatchObject({ code: "ENOENT" });
    delete state.__rolldownAdapterLegacySessionDirectories;
  });

  test("cleans the installed package session when it uses a legacy generated ID", async () => {
    const program = singleEntryProgram();
    const devtoolsRoot = join(process.cwd(), "node_modules", ".rolldown");
    const before = new Set(await sessionDirectoryNames(devtoolsRoot));
    let canonicalSourceDirectory = "";

    const result = await withRolldownBuild(program, renderProgram(program), async (artifacts) => {
      canonicalSourceDirectory = await realpath(artifacts.sourceDirectory);
      return artifacts.orderTrace;
    });

    expect(successValue(result)).toBeNull();
    const added = (await sessionDirectoryNames(devtoolsRoot)).filter((name) => !before.has(name));
    const leakedMatchingSessions: string[] = [];
    for (const name of added) {
      const directory = join(devtoolsRoot, name);
      const meta = await readFile(join(directory, "meta.json"), "utf8").catch(() => "");
      if (meta.includes(canonicalSourceDirectory)) {
        leakedMatchingSessions.push(directory);
      }
    }
    expect(leakedMatchingSessions).toEqual([]);
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

function fakeRolldownModule(logs: readonly unknown[]): string {
  const logContents = logs.map((log) => JSON.stringify(log)).join("\n");
  return [
    'import { mkdir, writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    "",
    "export async function rolldown(options) {",
    "  const sessionId = options.devtools?.sessionId;",
    '  if (typeof sessionId !== "string" || sessionId.length === 0) {',
    '    throw new Error("missing devtools session id");',
    "  }",
    '  const sessionDirectory = join(process.cwd(), "node_modules/.rolldown", sessionId);',
    "  globalThis.__rolldownAdapterSessionIds ??= [];",
    "  globalThis.__rolldownAdapterSessionIds.push(sessionId);",
    "  globalThis.__rolldownAdapterSessionDirectories ??= [];",
    "  globalThis.__rolldownAdapterSessionDirectories.push(sessionDirectory);",
    "  return {",
    "    async write() {",
    "      const facadeModuleId = Object.values(options.input)[0];",
    "      return {",
    "        output: [{",
    '          type: "chunk",',
    '          fileName: "entries/__entry_0000.js",',
    '          name: "__entry_0000",',
    "          isEntry: true,",
    "          facadeModuleId,",
    "        }],",
    "      };",
    "    },",
    "    async close() {",
    "      await mkdir(sessionDirectory, { recursive: true });",
    "      const facadeModuleId = Object.values(options.input)[0];",
    "      await writeFile(",
    '        join(sessionDirectory, "meta.json"),',
    "        `${JSON.stringify({ action: 'SessionMeta', inputs: [{ name: 'main', filename: facadeModuleId }] })}\\n`,",
    "      );",
    `      await writeFile(join(sessionDirectory, "logs.json"), ${JSON.stringify(
      logContents.length === 0 ? "" : `${logContents}\n`,
    )});`,
    "    },",
    "  };",
    "}",
    "",
  ].join("\n");
}

function fakeNoSessionRolldownModule(): string {
  return [
    "",
    "export async function rolldown(options) {",
    "  return {",
    "    async write() {",
    "      const facadeModuleId = Object.values(options.input)[0];",
    "      return {",
    "        output: [{",
    '          type: "chunk",',
    '          fileName: "entries/__entry_0000.js",',
    '          name: "__entry_0000",',
    "          isEntry: true,",
    "          facadeModuleId,",
    "        }],",
    "      };",
    "    },",
    "    async close() {},",
    "  };",
    "}",
    "",
  ].join("\n");
}

function fakeImportCollisionRolldownModule(collidingSessionId: string): string {
  return [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { mkdir, writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    "",
    `const collisionDirectory = join(process.cwd(), "node_modules/.rolldown", ${JSON.stringify(
      collidingSessionId,
    )});`,
    "mkdirSync(collisionDirectory, { recursive: true });",
    'writeFileSync(join(collisionDirectory, "sentinel.txt"), "keep\\n");',
    "",
    "export async function rolldown(options) {",
    "  const sessionId = options.devtools?.sessionId;",
    '  if (typeof sessionId !== "string" || sessionId.length === 0) {',
    '    throw new Error("missing devtools session id");',
    "  }",
    '  const sessionDirectory = join(process.cwd(), "node_modules/.rolldown", sessionId);',
    "  globalThis.__rolldownAdapterSessionIds ??= [];",
    "  globalThis.__rolldownAdapterSessionIds.push(sessionId);",
    "  return {",
    "    async write() {",
    "      const facadeModuleId = Object.values(options.input)[0];",
    "      return {",
    "        output: [{",
    '          type: "chunk",',
    '          fileName: "entries/__entry_0000.js",',
    '          name: "__entry_0000",',
    "          isEntry: true,",
    "          facadeModuleId,",
    "        }],",
    "      };",
    "    },",
    "    async close() {",
    "      const facadeModuleId = Object.values(options.input)[0];",
    "      await mkdir(sessionDirectory, { recursive: true });",
    "      await writeFile(",
    '        join(sessionDirectory, "meta.json"),',
    "        `${JSON.stringify({ action: 'SessionMeta', inputs: [{ name: 'main', filename: facadeModuleId }] })}\\n`,",
    "      );",
    `      await writeFile(join(sessionDirectory, "logs.json"), ${JSON.stringify(
      `${JSON.stringify(orderTraceAction())}\n`,
    )});`,
    "    },",
    "  };",
    "}",
    "",
  ].join("\n");
}

function fakeCanonicalTraceRolldownModule(): string {
  return [
    'import { mkdir, writeFile } from "node:fs/promises";',
    'import { dirname, join } from "node:path";',
    "",
    "export async function rolldown(options) {",
    "  const sessionId = options.devtools?.sessionId;",
    '  if (typeof sessionId !== "string" || sessionId.length === 0) {',
    '    throw new Error("missing devtools session id");',
    "  }",
    "  const moduleId = Object.values(options.input)[0];",
    "  const sourceRoot = dirname(moduleId);",
    '  const runtimeId = join(sourceRoot, "runtime.cjs");',
    '  const virtualId = "rolldown:runtime";',
    '  const sessionDirectory = join(process.cwd(), "node_modules/.rolldown", sessionId);',
    "  return {",
    "    async write() {",
    "      return {",
    "        output: [{",
    '          type: "chunk",',
    '          fileName: "entries/__entry_0000.js",',
    '          name: "__entry_0000",',
    "          isEntry: true,",
    "          facadeModuleId: moduleId,",
    "        }],",
    "      };",
    "    },",
    "    async close() {",
    "      const action = {",
    '        action: "StrictExecutionOrderPlanReady",',
    "        version: 1,",
    "        timestamp: Date.now(),",
    "        session_id: sessionId,",
    "        build_id: `build-${sessionId}`,",
    "        roots: [{",
    "          root_module_id: moduleId,",
    "          expected_order: [runtimeId, moduleId, virtualId],",
    "          predicted_pre_wrap_order: [moduleId, runtimeId],",
    "          at_risk_modules: [moduleId],",
    '          transport_detail: "discard",',
    "        }],",
    "        plan_modules: [{ module_id: moduleId, reasons: ['direct-violation'] }],",
    "        included_modules: [{",
    "          module_id: moduleId,",
    "          original_wrap_kind: 'none',",
    "          final_wrap_kind: 'esm',",
    "          final_chunk_id: 1,",
    "          entry_chunk_id: 1,",
    "          wrapper_included: true,",
    "          tla_tainted: false,",
    "        }],",
    "        rendered_chunks: [{",
    "          chunk_id: 1,",
    "          module_ids: [moduleId, runtimeId, virtualId],",
    "          static_chunk_imports: [],",
    "          dynamic_chunk_imports: [],",
    "        }],",
    "        init_obligations: [{",
    "          kind: 'direct-import',",
    "          importer_id: moduleId,",
    "          importee_id: runtimeId,",
    "          awaited: false,",
    "          importer_tla_tainted: false,",
    "          importee_tla_tainted: false,",
    "        }],",
    "      };",
    "      await mkdir(sessionDirectory, { recursive: true });",
    "      await writeFile(",
    '        join(sessionDirectory, "meta.json"),',
    "        `${JSON.stringify({ action: 'SessionMeta', inputs: [{ name: 'main', filename: moduleId }] })}\\n`,",
    "      );",
    '      await writeFile(join(sessionDirectory, "logs.json"), `${JSON.stringify(action)}\\n`);',
    "    },",
    "  };",
    "}",
    "",
  ].join("\n");
}

function fakeLegacyRolldownModule(
  logContents: string,
  matchingSessionCount = 1,
  createUnrelatedSession = false,
): string {
  return [
    'import { mkdir, writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    "",
    "export async function rolldown(options) {",
    "  const requestedSessionId = options.devtools?.sessionId;",
    '  if (typeof requestedSessionId !== "string" || requestedSessionId.length === 0) {',
    '    throw new Error("missing devtools session id");',
    "  }",
    "  const facadeModuleId = Object.values(options.input)[0];",
    "  const devtoolsRoot = join(process.cwd(), 'node_modules/.rolldown');",
    "  const matchingDirectories = Array.from(",
    `    { length: ${matchingSessionCount} },`,
    "    (_, index) => join(devtoolsRoot, `legacy-${requestedSessionId}-${index}`),",
    "  );",
    "  const unrelatedDirectory = join(devtoolsRoot, `unrelated-${requestedSessionId}`);",
    "  globalThis.__rolldownAdapterLegacySessionDirectories ??= [];",
    "  globalThis.__rolldownAdapterLegacySessionDirectories.push(...matchingDirectories);",
    ...(createUnrelatedSession
      ? [
          "  globalThis.__rolldownAdapterUnrelatedSessionDirectories ??= [];",
          "  globalThis.__rolldownAdapterUnrelatedSessionDirectories.push(unrelatedDirectory);",
        ]
      : []),
    "  return {",
    "    async write() {",
    "      return {",
    "        output: [{",
    '          type: "chunk",',
    '          fileName: "entries/__entry_0000.js",',
    '          name: "__entry_0000",',
    "          isEntry: true,",
    "          facadeModuleId,",
    "        }],",
    "      };",
    "    },",
    "    async close() {",
    "      for (const directory of matchingDirectories) {",
    "        await mkdir(directory, { recursive: true });",
    "        await writeFile(",
    "          join(directory, 'meta.json'),",
    "          `${JSON.stringify({ action: 'SessionMeta', inputs: [{ name: 'main', filename: facadeModuleId }] })}\\n`,",
    "        );",
    `        await writeFile(join(directory, "logs.json"), ${JSON.stringify(logContents)});`,
    "      }",
    ...(createUnrelatedSession
      ? [
          "      await mkdir(unrelatedDirectory, { recursive: true });",
          "      await writeFile(",
          "        join(unrelatedDirectory, 'meta.json'),",
          "        `${JSON.stringify({ action: 'SessionMeta', inputs: [{ name: 'other', filename: '/unrelated/source.js' }] })}\\n`,",
          "      );",
          `      await writeFile(join(unrelatedDirectory, "logs.json"), ${JSON.stringify(
            `${JSON.stringify(orderTraceAction())}\n`,
          )});`,
        ]
      : []),
    "    },",
    "  };",
    "}",
    "",
  ].join("\n");
}

async function sessionDirectoryNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function withPredictedNextSessionId(
  run: (sessionId: string) => Promise<void>,
): Promise<void> {
  const state = globalThis as typeof globalThis & {
    __rolldownAdapterSessionIds?: string[];
  };
  delete state.__rolldownAdapterSessionIds;

  try {
    await withTemporaryModule(fakeRolldownModule([]), async (packageSpecifier) => {
      const result = await withRolldownBuild(
        singleEntryProgram(),
        renderProgram(singleEntryProgram()),
        async (artifacts) => artifacts.orderTrace,
        { packageSpecifier },
      );
      expect(successValue(result)).toBeNull();
    });
    const previousSessionId = (
      globalThis as typeof globalThis & {
        __rolldownAdapterSessionIds?: string[];
      }
    ).__rolldownAdapterSessionIds?.at(-1);
    expect(previousSessionId).toBeTypeOf("string");
    if (previousSessionId === undefined) {
      throw new Error("missing predicted session id");
    }
    const separator = previousSessionId.lastIndexOf("-");
    const counter = Number.parseInt(previousSessionId.slice(separator + 1), 36);
    const nextSessionId = sessionIdWithCounter(previousSessionId, counter + 1);
    await run(nextSessionId);
  } finally {
    delete state.__rolldownAdapterSessionIds;
  }
}

function sessionIdCounter(sessionId: string): number {
  return Number.parseInt(sessionId.slice(sessionId.lastIndexOf("-") + 1), 36);
}

function sessionIdWithCounter(sessionId: string, counter: number): string {
  return `${sessionId.slice(0, sessionId.lastIndexOf("-") + 1)}${counter.toString(36)}`;
}

function orderTraceAction() {
  return {
    action: "StrictExecutionOrderPlanReady",
    version: 1,
    roots: [
      {
        root_module_id: "/project/entry.js",
        expected_order: ["/project/entry.js"],
        predicted_pre_wrap_order: ["/project/entry.js"],
        at_risk_modules: [],
      },
    ],
    plan_modules: [
      {
        module_id: "/project/entry.js",
        reasons: ["direct-violation"],
      },
    ],
    included_modules: [
      {
        module_id: "/project/entry.js",
        original_wrap_kind: "none",
        final_wrap_kind: "esm",
        final_chunk_id: 1,
        entry_chunk_id: 1,
        wrapper_included: true,
        tla_tainted: false,
      },
    ],
    rendered_chunks: [
      {
        chunk_id: 1,
        module_ids: ["/project/entry.js"],
        static_chunk_imports: [],
        dynamic_chunk_imports: [],
      },
    ],
    init_obligations: [],
  };
}
