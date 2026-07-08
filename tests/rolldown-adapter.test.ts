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
import { generateCase } from "../src/generate.ts";
import type { ProgramModel } from "../src/model.ts";
import {
  traceChildExecArgv,
  withRolldownBuild,
  type RolldownAdapterResult,
  type RolldownBuildArtifacts,
} from "../src/rolldown-adapter.ts";
import { renderProgram } from "../src/render.ts";
import {
  parseTraceChildRequest,
  parseTraceChildResponse,
  runTraceChildFromUnknown,
  TRACE_CHILD_PROTOCOL_VERSION,
  type TraceChildRequest,
} from "../src/rolldown-trace-child.ts";
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

  test(
    "keeps the generated manual-chunk graph free of harness runtime modules",
    { timeout: 30_000 },
    async () => {
      const generated = generateCase(5, 4);
      expect(generated.template).toBe("manual-chunk-separation");
      const rendered = renderProgram(generated.program);
      const expectedSourceFiles = [...rendered.modulePaths.values(), rendered.schedulePath].sort();

      expect(rendered.files.map((file) => file.path).sort()).toEqual(expectedSourceFiles);
      expect(rendered.files).toHaveLength(generated.program.modules.length + 1);
      expect(rendered.files.some((file) => file.path === "runtime.cjs")).toBe(false);

      const result = await withRolldownBuild(
        generated.program,
        rendered,
        async (artifacts) => {
          const [sourceOutcome, bundleOutcome, materializedSourceFiles] = await Promise.all([
            executeManifest(artifacts.sourceManifestPath),
            executeManifest(artifacts.bundleManifestPath),
            readdir(artifacts.sourceDirectory),
          ]);
          return {
            verdict: classifyVerdict(sourceOutcome, bundleOutcome),
            materializedSourceFiles: materializedSourceFiles.sort(),
          };
        },
        { collectOrderTrace: false },
      );

      expect(successValue(result)).toEqual({
        verdict: { kind: "pass", signature: "pass" },
        materializedSourceFiles: expectedSourceFiles,
      });
    },
  );

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
          { packageSpecifier, collectOrderTrace: false },
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

  test("never selects a non-entry chunk as an emitted entry", async () => {
    const program = singleEntryProgram();

    await withTemporaryModule(
      [
        "export async function rolldown(options) {",
        "  return {",
        "    async write() {",
        "      const facadeModuleId = Object.values(options.input)[0];",
        "      return {",
        "        output: [",
        "          {",
        '            type: "chunk",',
        '            fileName: "chunks/wrong.js",',
        '            name: "__entry_0000",',
        "            isEntry: false,",
        "            facadeModuleId,",
        "          },",
        "          {",
        '            type: "chunk",',
        '            fileName: "entries/right.js",',
        '            name: "different-name",',
        "            isEntry: true,",
        "            facadeModuleId,",
        "          },",
        "        ],",
        "      };",
        "    },",
        "    async close() {},",
        "  };",
        "}",
        "",
      ].join("\n"),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          program,
          renderProgram(program),
          async (artifacts) => artifacts.manifest.entries,
          { packageSpecifier },
        );

        expect(successValue(result)).toEqual([
          { name: "main", path: "entries/right.js", format: "esm" },
        ]);
      },
    );
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
    let temporaryDirectory = "";

    await withTemporaryModule(
      fakeRolldownModule([orderTraceAction()]),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          program,
          renderProgram(program),
          async (artifacts) => {
            temporaryDirectory = artifacts.temporaryDirectory;
            const sessions = await sessionDirectoryNames(
              join(temporaryDirectory, "node_modules", ".rolldown"),
            );
            expect(sessions).toHaveLength(1);
            return artifacts.orderTrace;
          },
          { packageSpecifier },
        );

        expect(successValue(result)).toEqual(orderTraceAction());
      },
    );

    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("isolates a producer that appends to a fixed pre-existing session", async () => {
    const program = singleEntryProgram();
    const repositoryCwd = process.cwd();
    const sentinelDirectory = join(repositoryCwd, "node_modules", ".rolldown", "unknown-session");
    const sentinelExisted = await access(sentinelDirectory)
      .then(() => true)
      .catch(() => false);
    const sentinelMeta = await readFile(join(sentinelDirectory, "meta.json"), "utf8").catch(
      () => '{"sentinel":"meta"}\n',
    );
    const sentinelLogs = await readFile(join(sentinelDirectory, "logs.json"), "utf8").catch(
      () => '{"sentinel":"logs"}\n',
    );
    let temporaryDirectory = "";

    if (!sentinelExisted) {
      await mkdir(sentinelDirectory, { recursive: true });
      await Promise.all([
        writeFile(join(sentinelDirectory, "meta.json"), sentinelMeta),
        writeFile(join(sentinelDirectory, "logs.json"), sentinelLogs),
      ]);
    }

    try {
      await withTemporaryModule(fakeFixedSessionRolldownModule(), async (packageSpecifier) => {
        const result = await withRolldownBuild(
          program,
          renderProgram(program),
          async (artifacts) => {
            temporaryDirectory = artifacts.temporaryDirectory;
            return artifacts.orderTrace;
          },
          { packageSpecifier },
        );

        expect(successValue(result)).toMatchObject({
          action: "StrictExecutionOrderPlanReady",
          version: 1,
          roots: [{ root_module_id: "entry" }],
          plan_modules: [{ module_id: "entry" }],
        });
      });

      expect(process.cwd()).toBe(repositoryCwd);
      await expect(readFile(join(sentinelDirectory, "meta.json"), "utf8")).resolves.toBe(
        sentinelMeta,
      );
      await expect(readFile(join(sentinelDirectory, "logs.json"), "utf8")).resolves.toBe(
        sentinelLogs,
      );
      await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (sentinelExisted) {
        await Promise.all([
          writeFile(join(sentinelDirectory, "meta.json"), sentinelMeta),
          writeFile(join(sentinelDirectory, "logs.json"), sentinelLogs),
        ]);
      } else {
        await rm(sentinelDirectory, { recursive: true, force: true });
      }
    }
  });

  test("validates traced child requests before loading Rolldown", async () => {
    const valid = validTraceChildRequest();
    expect(parseTraceChildRequest(valid)).toEqual(valid);

    const invalid = [
      null,
      {},
      { ...valid, version: 2 },
      { ...valid, packageSpecifier: "" },
      { ...valid, input: [] },
      { ...valid, input: { main: 1 } },
      { ...valid, sourceDirectory: "relative/source" },
      { ...valid, bundleDirectory: "relative/bundle" },
      { ...valid, modulePaths: [["entry"]] },
      {
        ...valid,
        manualChunkGroups: [{ name: "shared", modulePaths: ["relative/module.mjs"] }],
      },
      { ...valid, output: { ...valid.output, format: "cjs" } },
      { ...valid, output: { ...valid.output, strictExecutionOrder: false } },
    ];
    for (const value of invalid) {
      expect(() => parseTraceChildRequest(value)).toThrow(TypeError);
    }

    await expect(runTraceChildFromUnknown({ ...valid, version: 2 })).resolves.toMatchObject({
      status: "failure",
      failureStatus: "harness-error",
      stage: "build",
      error: { name: "TypeError" },
    });
  });

  test("validates traced child responses before parent manifest mapping", () => {
    const valid = {
      version: TRACE_CHILD_PROTOCOL_VERSION,
      status: "ok",
      outputFiles: [
        { type: "asset", fileName: "asset.txt" },
        {
          type: "chunk",
          fileName: "entry.js",
          name: "entry",
          isEntry: true,
          facadeModuleId: null,
        },
      ],
      orderTrace: null,
    } as const;
    expect(parseTraceChildResponse(valid)).toEqual(valid);

    const invalid = [
      null,
      {},
      { ...valid, status: "unknown" },
      { ...valid, outputFiles: null },
      {
        ...valid,
        outputFiles: [
          {
            type: "chunk",
            fileName: "entry.js",
            name: "entry",
            isEntry: "yes",
            facadeModuleId: null,
          },
        ],
      },
      {
        ...valid,
        outputFiles: [
          {
            type: "chunk",
            fileName: "entry.js",
            name: "entry",
            isEntry: true,
            facadeModuleId: 1,
          },
        ],
      },
      { ...valid, orderTrace: {} },
      {
        version: TRACE_CHILD_PROTOCOL_VERSION,
        status: "failure",
        failureStatus: "harness-error",
        stage: "build",
        error: { name: 1, message: "bad" },
        orderTrace: null,
      },
      {
        version: TRACE_CHILD_PROTOCOL_VERSION,
        status: "failure",
        failureStatus: "unknown",
        stage: "build",
        error: { name: "Error", message: "bad" },
        orderTrace: null,
      },
    ];
    for (const value of invalid) {
      expect(() => parseTraceChildResponse(value)).toThrow(TypeError);
    }
  });

  test("forwards safe TypeScript execArgv without inspector conflicts", () => {
    expect(
      traceChildExecArgv([
        "--conditions=trace-child",
        "--import",
        "/tmp/register.mjs",
        "--inspect=127.0.0.1:9229",
        "--inspect-brk",
        "--eval",
        "process.exit()",
      ]),
    ).toEqual(["--conditions=trace-child", "--import", "/tmp/register.mjs"]);
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
            expected_order: ["<source>/unmapped.js", "entry", "rolldown:runtime"],
            predicted_pre_wrap_order: ["entry", "<source>/unmapped.js"],
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
            module_ids: ["entry", "<source>/unmapped.js", "rolldown:runtime"],
            static_chunk_imports: [],
            dynamic_chunk_imports: [],
          },
        ],
        init_obligations: [
          {
            kind: "direct-import",
            importer_id: "entry",
            importee_id: "<source>/unmapped.js",
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
    let temporaryDirectory = "";

    await withTemporaryModule(
      fakeRolldownModule([{ ...orderTraceAction(), version: 2 }]),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          program,
          renderProgram(program),
          async (): Promise<never> => {
            throw new Error("build callback must not run");
          },
          {
            packageSpecifier,
            onFailureArtifacts: (_failure, artifacts) => {
              temporaryDirectory = artifacts.temporaryDirectory;
            },
          },
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

    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("assigns unique devtools sessions to concurrent builds", async () => {
    const program = singleEntryProgram();
    const rendered = renderProgram(program);

    await withTemporaryModule(fakeRolldownModule([]), async (packageSpecifier) => {
      const results = await Promise.all([
        withRolldownBuild(
          program,
          rendered,
          async (artifacts) => ({
            temporaryDirectory: artifacts.temporaryDirectory,
            sessions: await sessionDirectoryNames(
              join(artifacts.temporaryDirectory, "node_modules", ".rolldown"),
            ),
            trace: artifacts.orderTrace,
          }),
          { packageSpecifier },
        ),
        withRolldownBuild(
          program,
          rendered,
          async (artifacts) => ({
            temporaryDirectory: artifacts.temporaryDirectory,
            sessions: await sessionDirectoryNames(
              join(artifacts.temporaryDirectory, "node_modules", ".rolldown"),
            ),
            trace: artifacts.orderTrace,
          }),
          { packageSpecifier },
        ),
      ]);

      const values = results.map(successValue);
      expect(values.map((value) => value.trace)).toEqual([null, null]);
      expect(values.every((value) => value.sessions.length === 1)).toBe(true);
      expect(new Set(values.flatMap((value) => value.sessions)).size).toBe(2);
      await Promise.all(
        values.map((value) =>
          expect(access(value.temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" }),
        ),
      );
    });
  });

  test("discovers and cleans a legacy session while leaving unrelated sessions untouched", async () => {
    const program = singleEntryProgram();
    let temporaryDirectory = "";

    await withTemporaryModule(
      fakeLegacyRolldownModule(`${JSON.stringify(orderTraceAction())}\n`, 1, true),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          program,
          renderProgram(program),
          async (artifacts) => {
            temporaryDirectory = artifacts.temporaryDirectory;
            expect(
              await sessionDirectoryNames(join(temporaryDirectory, "node_modules", ".rolldown")),
            ).toHaveLength(2);
            return artifacts.orderTrace;
          },
          { packageSpecifier },
        );

        expect(successValue(result)).toEqual(orderTraceAction());
      },
    );

    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("cleans a matched legacy session when it contains no strict-order action", async () => {
    const program = singleEntryProgram();
    let temporaryDirectory = "";

    await withTemporaryModule(
      fakeLegacyRolldownModule(`${JSON.stringify({ action: "BuildEnd" })}\n`),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          program,
          renderProgram(program),
          async (artifacts) => {
            temporaryDirectory = artifacts.temporaryDirectory;
            return artifacts.orderTrace;
          },
          { packageSpecifier },
        );

        expect(successValue(result)).toBeNull();
      },
    );

    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("leaves ambiguous matching legacy sessions untouched and returns a null trace", async () => {
    const program = singleEntryProgram();
    let temporaryDirectory = "";

    await withTemporaryModule(
      fakeLegacyRolldownModule(`${JSON.stringify(orderTraceAction())}\n`, 2),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          program,
          renderProgram(program),
          async (artifacts) => {
            temporaryDirectory = artifacts.temporaryDirectory;
            expect(
              await sessionDirectoryNames(join(temporaryDirectory, "node_modules", ".rolldown")),
            ).toHaveLength(2);
            return artifacts.orderTrace;
          },
          { packageSpecifier },
        );

        expect(successValue(result)).toBeNull();
      },
    );

    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports malformed logs from a matched legacy session and still cleans it", async () => {
    const program = singleEntryProgram();
    let temporaryDirectory = "";

    await withTemporaryModule(
      fakeLegacyRolldownModule("{not-json}\n"),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          program,
          renderProgram(program),
          async (): Promise<never> => {
            throw new Error("build callback must not run");
          },
          {
            packageSpecifier,
            onFailureArtifacts: (_failure, artifacts) => {
              temporaryDirectory = artifacts.temporaryDirectory;
            },
          },
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

    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
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

function fakeFixedSessionRolldownModule(): string {
  return [
    'import { appendFile, mkdir } from "node:fs/promises";',
    'import { join } from "node:path";',
    "",
    'const sessionDirectory = join(process.cwd(), "node_modules/.rolldown/unknown-session");',
    "await mkdir(sessionDirectory, { recursive: true });",
    "await appendFile(",
    '  join(sessionDirectory, "meta.json"),',
    "  `${JSON.stringify({ action: 'ProducerReady', cwd: process.cwd() })}\\n`,",
    ");",
    "await appendFile(",
    '  join(sessionDirectory, "logs.json"),',
    "  `${JSON.stringify({ action: 'BuildStart', cwd: process.cwd() })}\\n`,",
    ");",
    "",
    "export async function rolldown(options) {",
    "  const moduleId = Object.values(options.input)[0];",
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
    "        roots: [{",
    "          root_module_id: moduleId,",
    "          expected_order: [moduleId],",
    "          predicted_pre_wrap_order: [moduleId],",
    "          at_risk_modules: [moduleId],",
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
    "          module_ids: [moduleId],",
    "          static_chunk_imports: [],",
    "          dynamic_chunk_imports: [],",
    "        }],",
    "        init_obligations: [],",
    "      };",
    "      await appendFile(",
    '        join(sessionDirectory, "meta.json"),',
    "        `${JSON.stringify({ action: 'SessionMeta', inputs: [{ name: 'main', filename: moduleId }] })}\\n`,",
    "      );",
    "      await appendFile(join(sessionDirectory, 'logs.json'), `${JSON.stringify(action)}\\n`);",
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
    '  const unmappedId = join(sourceRoot, "unmapped.js");',
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
    "          expected_order: [unmappedId, moduleId, virtualId],",
    "          predicted_pre_wrap_order: [moduleId, unmappedId],",
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
    "          module_ids: [moduleId, unmappedId, virtualId],",
    "          static_chunk_imports: [],",
    "          dynamic_chunk_imports: [],",
    "        }],",
    "        init_obligations: [{",
    "          kind: 'direct-import',",
    "          importer_id: moduleId,",
    "          importee_id: unmappedId,",
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

function validTraceChildRequest(): TraceChildRequest {
  return {
    version: TRACE_CHILD_PROTOCOL_VERSION,
    packageSpecifier: "rolldown",
    input: { main: "/tmp/source/entry.mjs" },
    preserveEntrySignatures: "allow-extension",
    sourceDirectory: "/tmp/source",
    bundleDirectory: "/tmp/bundle",
    modulePaths: [["entry", "entry.mjs"]],
    manualChunkGroups: [{ name: "shared", modulePaths: ["/tmp/source/shared.mjs"] }],
    output: {
      format: "esm",
      strictExecutionOrder: true,
      entryFileNames: "entries/[name].js",
      chunkFileNames: "chunks/[name].js",
      assetFileNames: "assets/[name][extname]",
      cleanDir: false,
      minify: false,
    },
  };
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
