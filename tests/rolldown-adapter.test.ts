/// <reference types="node" />

import { EventEmitter } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { executeManifest } from "../src/execute.ts";
import { generateCase } from "../src/generate.ts";
import type { ProgramModel } from "../src/model.ts";
import {
  inspectRolldownRuntimeIdentity,
  buildChildExecArgv,
  waitForBuildChildProcess,
  withRolldownBuild,
  type RolldownAdapterResult,
  type RolldownBuildArtifacts,
  type BuildChildProcessLike,
} from "../src/rolldown-adapter.ts";
import { renderProgram } from "../src/render.ts";
import {
  parseBuildChildRequest,
  parseBuildChildResponse,
  runBuildChildFromUnknown,
  BUILD_CHILD_PROTOCOL_VERSION,
  type BuildChildRequest,
} from "../src/rolldown-build-child.ts";
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

      const result = await withRolldownBuild(generated.program, rendered, async (artifacts) => {
        const [sourceOutcome, bundleOutcome, materializedSourceFiles] = await Promise.all([
          executeManifest(artifacts.sourceManifestPath),
          executeManifest(artifacts.bundleManifestPath),
          readdir(artifacts.sourceDirectory),
        ]);
        return {
          verdict: classifyVerdict(sourceOutcome, bundleOutcome),
          materializedSourceFiles: materializedSourceFiles.sort(),
        };
      });

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

  test("classifies output consumer failures before cleaning build artifacts", async () => {
    const program = singleEntryProgram();
    let temporaryDirectory = "";
    let observedEntry = "";

    const result = await withRolldownBuild(
      program,
      renderProgram(program),
      async (artifacts): Promise<never> => {
        throw new Error(`missing emitted file: ${artifacts.outputFiles[0]}`);
      },
      {
        onFailureArtifacts: async (_failure, artifacts) => {
          temporaryDirectory = artifacts.temporaryDirectory;
          observedEntry = await readFile(
            join(artifacts.bundleDirectory, "entries/__entry_0000.js"),
            "utf8",
          );
        },
      },
    );

    expect(result).toMatchObject({
      status: "harness-error",
      stage: "consume-output",
      error: {
        name: "Error",
        message: "missing emitted file: entries/__entry_0000.js",
      },
    });
    expect(observedEntry.length).toBeGreaterThan(0);
    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("classifies invalid Rolldown output after closing and cleaning up", async () => {
    const program = singleEntryProgram();
    let closeMarker: { readonly inputPath: string } | undefined;
    let temporaryDirectory = "";

    await withTemporaryModule(
      [
        'import { writeFile } from "node:fs/promises";',
        'import { join } from "node:path";',
        "",
        "let outputDirectory;",
        "export async function rolldown(options) {",
        "  return {",
        "    async write(outputOptions) {",
        "      outputDirectory = outputOptions.dir;",
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
        "      await writeFile(",
        '        join(outputDirectory, "close-marker.json"),',
        "        JSON.stringify({ inputPath: Object.values(options.input)[0] }),",
        "      );",
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
          {
            packageSpecifier,
            onFailureArtifacts: async (_failure, artifacts) => {
              temporaryDirectory = artifacts.temporaryDirectory;
              closeMarker = JSON.parse(
                await readFile(join(artifacts.bundleDirectory, "close-marker.json"), "utf8"),
              ) as { readonly inputPath: string };
            },
          },
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

    expect(closeMarker?.inputPath.replaceAll("\\", "/")).toContain("/source/");
    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
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

  test("validates build child requests before loading Rolldown", async () => {
    const valid = validBuildChildRequest();
    expect(parseBuildChildRequest(valid)).toEqual(valid);

    const invalid = [
      null,
      {},
      { ...valid, version: 2 },
      { ...valid, packageSpecifier: "" },
      { ...valid, input: [] },
      { ...valid, input: { main: 1 } },
      { ...valid, input: { main: "relative/source.mjs" } },
      { ...valid, bundleDirectory: "relative/bundle" },
      {
        ...valid,
        manualChunkGroups: [{ name: "shared", modulePaths: ["relative/module.mjs"] }],
      },
      { ...valid, output: { ...valid.output, format: "cjs" } },
      { ...valid, output: { ...valid.output, strictExecutionOrder: false } },
    ];
    for (const value of invalid) {
      expect(() => parseBuildChildRequest(value)).toThrow(TypeError);
    }

    await expect(runBuildChildFromUnknown({ ...valid, version: 2 })).resolves.toMatchObject({
      status: "failure",
      failureStatus: "harness-error",
      stage: "build",
      error: { name: "TypeError" },
    });
  });

  test("validates build child responses before parent manifest mapping", () => {
    const valid = {
      version: BUILD_CHILD_PROTOCOL_VERSION,
      status: "ok",
      outputFiles: [
        { type: "asset", fileName: "assets/nested/asset.txt" },
        {
          type: "chunk",
          fileName: "entries/nested/entry.js",
          name: "entry",
          isEntry: true,
          facadeModuleId: null,
        },
      ],
    } as const;
    expect(parseBuildChildResponse(valid, "/tmp/bundle")).toEqual(valid);

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
      { ...valid, outputFiles: [{ type: "asset", fileName: "/tmp/escape.txt" }] },
      { ...valid, outputFiles: [{ type: "asset", fileName: "C:\\temp\\escape.txt" }] },
      { ...valid, outputFiles: [{ type: "asset", fileName: "\\\\server\\escape.txt" }] },
      { ...valid, outputFiles: [{ type: "asset", fileName: "../escape.txt" }] },
      { ...valid, outputFiles: [{ type: "asset", fileName: "assets/../escape.txt" }] },
      { ...valid, outputFiles: [{ type: "asset", fileName: "./escape.txt" }] },
      { ...valid, outputFiles: [{ type: "asset", fileName: "assets\\..\\escape.txt" }] },
      { ...valid, outputFiles: [{ type: "asset", fileName: "assets/escape\u0000.txt" }] },
      {
        version: BUILD_CHILD_PROTOCOL_VERSION,
        status: "failure",
        failureStatus: "harness-error",
        stage: "build",
        error: { name: 1, message: "bad" },
      },
      {
        version: BUILD_CHILD_PROTOCOL_VERSION,
        status: "failure",
        failureStatus: "unknown",
        stage: "build",
        error: { name: "Error", message: "bad" },
      },
    ];
    for (const value of invalid) {
      expect(() => parseBuildChildResponse(value, "/tmp/bundle")).toThrow(TypeError);
    }
  });

  test("rejects escaped child output before the callback can execute it", async () => {
    const program = singleEntryProgram();
    let callbackRan = false;

    await withTemporaryModule(
      [
        "export async function rolldown(options) {",
        "  return {",
        "    async write() {",
        "      return {",
        "        output: [",
        "          {",
        '            type: "chunk",',
        '            fileName: "chunks/context.js",',
        '            name: "context",',
        "            isEntry: false,",
        "            facadeModuleId: null,",
        "          },",
        "          {",
        '            type: "chunk",',
        '            fileName: "../source/module-0000.mjs",',
        '            name: "__entry_0000",',
        "            isEntry: true,",
        "            facadeModuleId: Object.values(options.input)[0],",
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
          async (): Promise<never> => {
            callbackRan = true;
            throw new Error("escaped output callback must not run");
          },
          { packageSpecifier },
        );

        expect(result).toMatchObject({
          status: "harness-error",
          stage: "build",
          error: {
            name: "TypeError",
          },
        });
      },
    );

    expect(callbackRan).toBe(false);
  });

  test("forwards safe TypeScript execArgv without inspector conflicts", () => {
    expect(
      buildChildExecArgv([
        "--conditions=build-child",
        "--import",
        "/tmp/register.mjs",
        "--inspect=127.0.0.1:9229",
        "--inspect-brk",
        "--eval",
        "process.exit()",
      ]),
    ).toEqual(["--conditions=build-child", "--import", "/tmp/register.mjs"]);
  });

  test("hashes an absolute native override despite ambiguous binding loaders", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "rolldown-absolute-override-"));
    const targetRoot = await mkdtemp(join(tmpdir(), "rolldown-absolute-target-"));
    const entryPath = join(packageRoot, "dist/index.mjs");
    const firstLoader = join(packageRoot, "dist/shared/binding-first.mjs");
    const secondLoader = join(packageRoot, "dist/shared/binding-second.mjs");
    const overrideLink = join(packageRoot, "dist/shared/override.node");
    const overrideTarget = join(targetRoot, "override.node");
    const previousOverride = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;

    try {
      await mkdir(dirname(firstLoader), { recursive: true });
      await Promise.all([
        writeFile(
          join(packageRoot, "package.json"),
          `${JSON.stringify({ type: "module", version: "1.0.0" })}\n`,
        ),
        writeFile(entryPath, "export const rolldown = true;\n"),
        writeFile(firstLoader, "export const first = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;\n"),
        writeFile(secondLoader, "export const second = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;\n"),
        writeFile(overrideTarget, Buffer.from([0, 1, 2, 3])),
      ]);
      await symlink(overrideTarget, overrideLink);
      process.env.NAPI_RS_NATIVE_LIBRARY_PATH = overrideLink;

      const first = await inspectRolldownRuntimeIdentity(pathToFileURL(entryPath).href);
      await writeFile(overrideTarget, Buffer.from([3, 2, 1, 0]));
      const changed = await inspectRolldownRuntimeIdentity(pathToFileURL(entryPath).href);
      const candidates = [await realpath(firstLoader), await realpath(secondLoader)].sort();

      expect(first.napiRsNativeLibrary).toEqual({
        requested: overrideLink,
        loaderPath: null,
        loaderCandidates: candidates,
        resolvedPath: overrideLink,
        realPath: await realpath(overrideLink),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown as string,
      });
      expect(changed.napiRsNativeLibrary.sha256).not.toBe(first.napiRsNativeLibrary.sha256);
      expect(changed).not.toEqual(first);
    } finally {
      if (previousOverride === undefined) {
        delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
      } else {
        process.env.NAPI_RS_NATIVE_LIBRARY_PATH = previousOverride;
      }
      await Promise.all([
        rm(packageRoot, { recursive: true, force: true }),
        rm(targetRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("times out and cleans a stalled build child", async () => {
    const program = singleEntryProgram();
    let callbackRan = false;
    let temporaryDirectory = "";

    await withTemporaryModule(
      [
        "await new Promise((resolve) => setTimeout(resolve, 200));",
        "export async function rolldown(options) {",
        "  return {",
        "    async write() {",
        "      return {",
        "        output: [{",
        '          type: "chunk",',
        '          fileName: "entries/__entry_0000.js",',
        '          name: "__entry_0000",',
        "          isEntry: true,",
        "          facadeModuleId: Object.values(options.input)[0],",
        "        }],",
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
          async (): Promise<never> => {
            callbackRan = true;
            throw new Error("timed out child callback must not run");
          },
          {
            packageSpecifier,
            buildChildTimeoutMs: 25,
            onFailureArtifacts: (_failure, artifacts) => {
              temporaryDirectory = artifacts.temporaryDirectory;
            },
          },
        );

        expect(result).toMatchObject({
          status: "harness-error",
          stage: "build",
          error: {
            name: "Error",
            message: "Build child timed out after 25ms",
          },
        });
      },
    );

    expect(callbackRan).toBe(false);
    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("terminates helper subprocesses when a build times out", async () => {
    await withTemporaryModule(fakeHangingHelperRolldownModule(), async (packageSpecifier) => {
      const result = await withRolldownBuild(
        singleEntryProgram(),
        renderProgram(singleEntryProgram()),
        async (): Promise<never> => {
          throw new Error("timed out helper callback must not run");
        },
        {
          packageSpecifier,
          buildChildTimeoutMs: 1_000,
        },
      );
      expect(result).toMatchObject({
        status: "harness-error",
        stage: "build",
        error: {
          message: "Build child timed out after 1000ms",
        },
      });

      const pidPath = join(dirname(fileURLToPath(packageSpecifier)), "helper-pids.json");
      const pids = JSON.parse(await readFile(pidPath, "utf8")) as {
        readonly childPid: number;
        readonly helperPid: number;
      };
      try {
        expect(await waitForProcessExit(pids.childPid, 2_000)).toBe(true);
        expect(await waitForProcessExit(pids.helperPid, 2_000)).toBe(true);
      } finally {
        killProcessIfAlive(pids.helperPid);
        await waitForProcessExit(pids.helperPid, 2_000);
      }
    });
  }, 15_000);

  test("settles a timeout when the child never emits close", async () => {
    const emitter = new EventEmitter();
    const terminationPhases: boolean[] = [];
    const child = {
      pid: 123_456,
      once: emitter.once.bind(emitter),
      off: emitter.off.bind(emitter),
      kill: () => true,
    };
    const startedAt = Date.now();

    const result = await waitForBuildChildProcess(child as unknown as BuildChildProcessLike, 10, {
      terminationGraceMs: 10,
      finalCloseGraceMs: 10,
      terminate: (_child, force) => {
        terminationPhases.push(force);
      },
    });

    expect(result).toEqual({ status: "timeout", timeoutMs: 10 });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(terminationPhases).toEqual([false, true]);
    expect(emitter.listenerCount("error")).toBe(0);
    expect(emitter.listenerCount("close")).toBe(0);
    emitter.emit("close", 0, null);
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

function fakeHangingHelperRolldownModule(): string {
  return [
    'import { spawn } from "node:child_process";',
    'import { writeFile } from "node:fs/promises";',
    'import { fileURLToPath } from "node:url";',
    "",
    "const helper = spawn(",
    "  process.execPath,",
    '  ["-e", "setInterval(() => {}, 1000)"],',
    '  { stdio: "ignore" },',
    ");",
    "await writeFile(",
    '  fileURLToPath(new URL("./helper-pids.json", import.meta.url)),',
    "  JSON.stringify({ childPid: process.pid, helperPid: helper.pid }),",
    ");",
    "await new Promise(() => {});",
    "",
  ].join("\n");
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processIsAlive(pid);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function killProcessIfAlive(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

function validBuildChildRequest(): BuildChildRequest {
  return {
    version: BUILD_CHILD_PROTOCOL_VERSION,
    packageSpecifier: "rolldown",
    input: { main: "/tmp/source/entry.mjs" },
    preserveEntrySignatures: "allow-extension",
    bundleDirectory: "/tmp/bundle",
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
