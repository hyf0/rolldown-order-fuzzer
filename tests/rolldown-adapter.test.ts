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

import { analyzeProgram } from "../src/analyzed-program.ts";
import { executeManifest } from "../src/execute.ts";
import { generateCase } from "../src/generate.ts";
import type { EventValue, ProgramModel } from "../src/model.ts";
import {
  isScheduleMarker,
  type ExecutionEvent,
  type ModuleExecutionEvent,
} from "../src/protocol.ts";
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
import { validateProgramModel } from "../src/validate-model.ts";
import {
  createOutputOptions,
  looksLikePanic,
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

    const result = await withRolldownBuild(
      program,
      renderProgram(analyzeProgram(program)),
      async (artifacts) => {
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
      },
    );

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

    const result = await withRolldownBuild(
      program,
      renderProgram(analyzeProgram(program)),
      async (artifacts) => readFile(join(artifacts.bundleDirectory, "package.json"), "utf8"),
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

    const result = await withRolldownBuild(
      program,
      renderProgram(analyzeProgram(program)),
      async (artifacts) => {
        const sourceOutcome = await executeManifest(artifacts.sourceManifestPath);
        const bundleOutcome = await executeManifest(artifacts.bundleManifestPath);
        return classifyVerdict(sourceOutcome, bundleOutcome);
      },
    );

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

    const result = await withRolldownBuild(
      program,
      renderProgram(analyzeProgram(program)),
      async (artifacts) => {
        const [sourceOutcome, bundleOutcome] = await Promise.all([
          executeManifest(artifacts.sourceManifestPath),
          executeManifest(artifacts.bundleManifestPath),
        ]);
        return {
          verdict: classifyVerdict(sourceOutcome, bundleOutcome),
          manifest: artifacts.manifest,
        };
      },
    );

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
    const rendered = renderProgram(analyzeProgram(program));
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

    const result = await withRolldownBuild(
      program,
      renderProgram(analyzeProgram(program)),
      async (artifacts) => {
        const [sourceOutcome, bundleOutcome] = await Promise.all([
          executeManifest(artifacts.sourceManifestPath),
          executeManifest(artifacts.bundleManifestPath),
        ]);
        return {
          verdict: classifyVerdict(sourceOutcome, bundleOutcome),
          outputFiles: artifacts.outputFiles,
        };
      },
    );

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
      const generated = findManualChunkCase();
      const rendered = renderProgram(generated.analyzed);
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

  test("forwards the wrapping mode to the Rolldown input options", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-adapter-mode-"));
    const packagePath = join(directory, "rolldown.mjs");
    const capturePath = join(directory, "captured.json");
    await writeFile(
      packagePath,
      [
        "import fs from 'node:fs';",
        "export async function rolldown(inputOptions) {",
        `  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(inputOptions.experimental));`,
        "  throw new Error('capture-only');",
        "}",
        "",
      ].join("\n"),
    );
    const program = singleEntryProgram();

    try {
      for (const onDemandWrapping of [false, true]) {
        await withRolldownBuild(
          program,
          renderProgram(analyzeProgram(program)),
          async (): Promise<never> => {
            throw new Error("build callback must not run");
          },
          { packageSpecifier: pathToFileURL(packagePath).href, onDemandWrapping },
        );
        // experimental now also carries `lazyBarrel` from the BuildConfig (default false for this
        // legacy-shaped program with no persisted `build`).
        expect(JSON.parse(await readFile(capturePath, "utf8"))).toEqual({
          onDemandWrapping,
          lazyBarrel: false,
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("threads the persisted BuildConfig axes into rolldown input and output options (W14a)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-adapter-build-config-"));
    const packagePath = join(directory, "rolldown.mjs");
    const capturePath = join(directory, "captured.json");
    // A mock rolldown that captures the input experimental options AND the write() output options.
    await writeFile(
      packagePath,
      [
        "import fs from 'node:fs';",
        "export async function rolldown(inputOptions) {",
        "  return {",
        "    async write(outputOptions) {",
        `      fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({`,
        "        experimental: inputOptions.experimental,",
        "        preserveEntrySignatures: inputOptions.preserveEntrySignatures,",
        "        codeSplitting: outputOptions.codeSplitting,",
        "        strictExecutionOrder: outputOptions.strictExecutionOrder,",
        "      }));",
        "      throw new Error('capture-only');",
        "    },",
        "    async close() {},",
        "  };",
        "}",
        "",
      ].join("\n"),
    );
    // A program whose persisted BuildConfig carries a manual chunk group (so codeSplitting has groups
    // the global includeDependenciesRecursively applies to), idr:false, and lazyBarrel:true.
    const base = singleEntryProgram();
    const program: ProgramModel = {
      ...base,
      modules: [...base.modules, { id: "leaf", format: "esm", dependencies: [], events: [] }],
      build: {
        chunking: { kind: "manual", groups: [{ name: "g", moduleIds: ["leaf"] }] },
        includeDependenciesRecursively: false,
        preserveEntrySignatures: "allow-extension",
        lazyBarrel: true,
        strictExecutionOrder: true,
      },
    };
    try {
      await withRolldownBuild(
        program,
        renderProgram(analyzeProgram(program)),
        async (): Promise<never> => {
          throw new Error("build callback must not run");
        },
        { packageSpecifier: pathToFileURL(packagePath).href, onDemandWrapping: true },
      );
      const captured = JSON.parse(await readFile(capturePath, "utf8"));
      expect(captured.experimental).toEqual({ onDemandWrapping: true, lazyBarrel: true });
      expect(captured.preserveEntrySignatures).toBe("allow-extension");
      expect(captured.strictExecutionOrder).toBe(true);
      // The global includeDependenciesRecursively:false rides on the codeSplitting object.
      expect(captured.codeSplitting.includeDependenciesRecursively).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("builds and round-trips a #9961-shaped side-effect-free value module", async () => {
    // source (side-effectful) -> flagged (value only, no events) -> entry (folds the flagged value
    // into an event). Under strictExecutionOrder + sideEffects:false the bundler may drop the
    // flagged initializer; if it wrongly does so the folded number diverges or the binding is
    // undefined. On a correct build source and bundle match.
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "flagged",
              importedName: "w",
              localName: "flaggedW",
            },
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
    } satisfies ProgramModel;
    const rendered = renderProgram(analyzeProgram(program));

    const result = await withRolldownBuild(program, rendered, async (artifacts) => {
      const [sourceOutcome, bundleOutcome, packageJson] = await Promise.all([
        executeManifest(artifacts.sourceManifestPath),
        executeManifest(artifacts.bundleManifestPath),
        readFile(join(artifacts.sourceDirectory, "node_modules/sef-flagged/package.json"), "utf8"),
      ]);
      return {
        verdict: classifyVerdict(sourceOutcome, bundleOutcome),
        sourceEvents: moduleEventPairs(sourceOutcome.events),
        packageJson,
      };
    });

    expect(successValue(result)).toEqual({
      verdict: { kind: "pass", signature: "pass" },
      sourceEvents: [
        ["source", 7],
        ["entry", 8],
      ],
      packageJson:
        '{\n  "name": "sef-flagged",\n  "main": "./flagged.mjs",\n  "sideEffects": false\n}\n',
    });
  });

  test("builds and round-trips a package whose MAIN member is CommonJS", async () => {
    // A bare `import { answer } from "cjspkg"` must resolve node_modules/cjspkg → package.json
    // main `./cmain.cjs` → the CJS main's named export (ESM↔CJS interop over a package boundary). The
    // W14b doc claimed a CJS-main package was smoke-verified; this pins it differential-green.
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "cmain", importedName: "answer", localName: "a" },
          ],
          events: [{ module: "entry", phase: "evaluate", value: 1, reads: [{ binding: "a" }] }],
        },
        {
          id: "cmain",
          format: "cjs",
          dependencies: [],
          events: [{ module: "cmain", phase: "evaluate", value: 42 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
      packages: [{ name: "cjspkg", sideEffects: true, moduleIds: ["cmain"] }],
    } satisfies ProgramModel;
    const rendered = renderProgram(analyzeProgram(program));
    // The importer really uses the BARE package specifier (the CJS-main resolution surface).
    const entrySource =
      rendered.files.find((file) => file.path === "module-0000.mjs")?.contents ?? "";
    expect(entrySource).toContain('from "cjspkg"');

    const result = await withRolldownBuild(program, rendered, async (artifacts) => {
      const [sourceOutcome, bundleOutcome, packageJson] = await Promise.all([
        executeManifest(artifacts.sourceManifestPath),
        executeManifest(artifacts.bundleManifestPath),
        readFile(join(artifacts.sourceDirectory, "node_modules/cjspkg/package.json"), "utf8"),
      ]);
      return {
        verdict: classifyVerdict(sourceOutcome, bundleOutcome),
        sourceEvents: moduleEventPairs(sourceOutcome.events),
        packageJson,
      };
    });

    expect(successValue(result)).toEqual({
      verdict: { kind: "pass", signature: "pass" },
      sourceEvents: [
        ["cmain", 42],
        ["entry", 43],
      ],
      packageJson: '{\n  "name": "cjspkg",\n  "main": "./cmain.cjs",\n  "sideEffects": true\n}\n',
    });
  });

  test("builds and round-trips a #8675-shaped namespace import member read", async () => {
    // `import * as ns` + a folded `ns.k`. If rolldown wrongly removes the used export or mis-rewrites
    // the namespace member access (#8675 / #4780 / #8710), the folded number diverges or the binding
    // is undefined and the bundle crashes; on a correct build source and bundle match.
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-namespace-import",
              target: "target",
              localName: "ns0",
              readMembers: [["k"]],
            },
          ],
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "ns0", memberPath: ["k"] }],
            },
          ],
        },
        {
          id: "target",
          format: "esm",
          dependencies: [],
          events: [{ module: "target", phase: "evaluate", value: 40 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    const result = await withRolldownBuild(
      program,
      renderProgram(analyzeProgram(program)),
      async (artifacts) => {
        const [sourceOutcome, bundleOutcome] = await Promise.all([
          executeManifest(artifacts.sourceManifestPath),
          executeManifest(artifacts.bundleManifestPath),
        ]);
        return {
          verdict: classifyVerdict(sourceOutcome, bundleOutcome),
          events: moduleEventPairs(sourceOutcome.events),
        };
      },
    );

    expect(successValue(result)).toEqual({
      verdict: { kind: "pass", signature: "pass" },
      events: [
        ["target", 40],
        ["entry", 41],
      ],
    });
  });

  test("builds a static+dynamic multi-edge target grouped with its entry (facade-sensitive shape)", async () => {
    // The target is imported statically (value) AND dynamically by the same entry, and shares a
    // manual chunk group with that entry — the shape that stresses the entry-facade machinery (the
    // dynamic import must reference the target in the entry chunk without re-running it or firing
    // foreign triggers). The SOURCE run is the oracle; the differential against a FIXED rolldown is
    // the campaign's job. This test locks expressibility, rendering, the adapter's facade mapping,
    // and source soundness — all version-independent — so it does not assert the execution verdict
    // kind (rolldown 1.1.4 mis-orders this shape; the marker-aware oracle is what catches that).
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "target", importedName: "v", localName: "tv" },
            { kind: "esm-dynamic-import", target: "target", registration: "load-target" },
          ],
          events: [{ module: "entry", phase: "evaluate", value: 1, reads: [{ binding: "tv" }] }],
        },
        {
          id: "target",
          format: "esm",
          dependencies: [],
          events: [{ module: "target", phase: "evaluate", value: 5 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [
        { kind: "import-entry", entry: "main" },
        { kind: "trigger-dynamic-import", registration: "load-target" },
      ],
      manualChunkGroups: [{ name: "core", moduleIds: ["entry", "target"] }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);

    const rendered = renderProgram(analyzeProgram(program));
    const entryFile =
      rendered.files.find((file) => file.path === "module-0000.mjs")?.contents ?? "";
    // One specifier, a static value import AND a dynamic registration.
    expect(entryFile).toContain('import { v as tv } from "./module-0001.mjs";');
    expect(entryFile).toContain(
      'globalThis.__orderDynamicImports["load-target"] = () => import("./module-0001.mjs");',
    );

    const result = await withRolldownBuild(program, rendered, async (artifacts) => {
      const [sourceOutcome, bundleOutcome] = await Promise.all([
        executeManifest(artifacts.sourceManifestPath),
        executeManifest(artifacts.bundleManifestPath),
      ]);
      return {
        entryCount: artifacts.manifest.entries.length,
        sourceEvents: sourceOutcome.events,
        verdictKind: classifyVerdict(sourceOutcome, bundleOutcome).kind,
      };
    });

    const value = successValue(result);
    // The facade machinery mapped the single model entry to one output chunk.
    expect(value.entryCount).toBe(1);
    // Source oracle: the target evaluates EXACTLY once (the dynamic trigger finds it already loaded),
    // bounded by the runner-emitted phase markers after each settled step.
    expect(value.sourceEvents).toEqual([
      { version: 1, module: "target", phase: "evaluate", value: 5 },
      { version: 1, module: "entry", phase: "evaluate", value: 6 },
      { version: 1, marker: "schedule", schedule: 0, kind: "entry" },
      { version: 1, marker: "schedule", schedule: 1, kind: "dynamic" },
    ]);
    // A verdict was produced (build + facade mapping succeeded); the kind is rolldown-version specific.
    expect(["pass", "mismatch"]).toContain(value.verdictKind);
  });

  test("builds and round-trips an ESM namespace import of a CJS target's named member", async () => {
    // Deferred from the generator: Node's `import * of CJS` namespace carries a `module.exports` key
    // rolldown's interop omits, so enumerating the namespace legitimately differs. A single numeric
    // member read still round-trips and stays model-expressible (see the namespace-and-barrel doc).
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-namespace-import", target: "cjs", localName: "ns0", readMembers: [["k"]] },
          ],
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "ns0", memberPath: ["k"] }],
            },
          ],
        },
        {
          id: "cjs",
          format: "cjs",
          dependencies: [],
          events: [{ module: "cjs", phase: "evaluate", value: 40 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    const result = await withRolldownBuild(
      program,
      renderProgram(analyzeProgram(program)),
      async (artifacts) => {
        const [sourceOutcome, bundleOutcome] = await Promise.all([
          executeManifest(artifacts.sourceManifestPath),
          executeManifest(artifacts.bundleManifestPath),
        ]);
        return classifyVerdict(sourceOutcome, bundleOutcome);
      },
    );

    expect(successValue(result)).toEqual({ kind: "pass", signature: "pass" });
  });

  test("builds and round-trips an ESM re-export (barrel) chain", async () => {
    // reader imports `vdef` from a two-hop barrel (`export *` then `export { vdef } from`) that
    // forwards a definer's value. Only the definer synthesizes it, so a dropped barrel init would be
    // observable downstream; on a correct build source and bundle match.
    const program = {
      modules: [
        {
          id: "reader",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "barrel-a", importedName: "vdef", localName: "r" },
          ],
          events: [{ module: "reader", phase: "evaluate", value: 1, reads: [{ binding: "r" }] }],
        },
        {
          id: "barrel-a",
          format: "esm",
          dependencies: [{ kind: "esm-reexport-star", target: "barrel-b" }],
          events: [],
        },
        {
          id: "barrel-b",
          format: "esm",
          dependencies: [
            { kind: "esm-reexport-named", target: "def", sourceName: "vdef", exportedName: "vdef" },
          ],
          events: [],
        },
        {
          id: "def",
          format: "esm",
          dependencies: [],
          events: [{ module: "def", phase: "evaluate", value: 7 }],
        },
      ],
      entries: [{ name: "main", moduleId: "reader" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    const result = await withRolldownBuild(
      program,
      renderProgram(analyzeProgram(program)),
      async (artifacts) => {
        const [sourceOutcome, bundleOutcome] = await Promise.all([
          executeManifest(artifacts.sourceManifestPath),
          executeManifest(artifacts.bundleManifestPath),
        ]);
        return {
          verdict: classifyVerdict(sourceOutcome, bundleOutcome),
          events: moduleEventPairs(sourceOutcome.events),
        };
      },
    );

    expect(successValue(result)).toEqual({
      verdict: { kind: "pass", signature: "pass" },
      events: [
        ["def", 7],
        ["reader", 8],
      ],
    });
  });

  test("builds and round-trips a multi-package layout (bare mains, a subpath, partial sideEffects)", async () => {
    // Two fixture-local node_modules packages: the entry imports pkga's main barrel BARE plus a
    // SUBPATH member, the barrel forwards a listed (side-effectful) sibling that itself imports pkgb
    // BARE and reaches back out to a root module — the whole W14b resolution surface in one build.
    // pkga's sideEffects ARRAY lists only the sibling, so the barrel and inner member are
    // metadata-pure (value-only), keeping the differential oracle sound however the bundler DCEs them.
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "abar", importedName: "va", localName: "e_va" },
            { kind: "esm-value-import", target: "ainner", importedName: "vi", localName: "e_vi" },
          ],
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "e_va" }, { binding: "e_vi" }],
            },
          ],
        },
        {
          id: "abar",
          format: "esm",
          dependencies: [
            { kind: "esm-reexport-named", target: "asib", sourceName: "va", exportedName: "va" },
          ],
          events: [],
        },
        {
          id: "asib",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "bmain", importedName: "vb", localName: "a_vb" },
            {
              kind: "esm-value-import",
              target: "roothelper",
              importedName: "vr",
              localName: "a_vr",
            },
          ],
          events: [
            {
              module: "asib",
              phase: "evaluate",
              value: 10,
              reads: [{ binding: "a_vb" }, { binding: "a_vr" }],
            },
          ],
        },
        { id: "ainner", format: "esm", dependencies: [], events: [] },
        {
          id: "bmain",
          format: "esm",
          dependencies: [],
          events: [{ module: "bmain", phase: "evaluate", value: 100 }],
        },
        { id: "roothelper", format: "esm", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
      packages: [
        { name: "pkga", sideEffects: ["./asib.mjs"], moduleIds: ["abar", "asib", "ainner"] },
        { name: "pkgb", sideEffects: true, moduleIds: ["bmain"] },
      ],
    } satisfies ProgramModel;

    const result = await withRolldownBuild(
      program,
      renderProgram(analyzeProgram(program)),
      async (artifacts) => {
        const [sourceOutcome, bundleOutcome] = await Promise.all([
          executeManifest(artifacts.sourceManifestPath),
          executeManifest(artifacts.bundleManifestPath),
        ]);
        return {
          verdict: classifyVerdict(sourceOutcome, bundleOutcome),
          events: moduleEventPairs(sourceOutcome.events),
        };
      },
    );

    expect(successValue(result)).toEqual({
      verdict: { kind: "pass", signature: "pass" },
      events: [
        ["bmain", 100],
        ["asib", 110],
        ["entry", 111],
      ],
    });
  });

  test("builds and round-trips a camunda-shaped local re-export with an own side effect (M4)", async () => {
    // The barrel IMPORTS the definer's binding, emits its OWN event, and re-exports the binding
    // through a source-less `export { … };` clause — the package-barrel-with-own-effect shape from
    // the camunda breakage. On a correct build the value flows and the barrel's event stays ordered.
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "barrel", importedName: "vx", localName: "e_vx" },
          ],
          events: [{ module: "entry", phase: "evaluate", value: 5, reads: [{ binding: "e_vx" }] }],
        },
        {
          id: "barrel",
          format: "esm",
          dependencies: [
            {
              kind: "esm-local-reexport",
              target: "def",
              sourceName: "vdef",
              localName: "b_vdef",
              exportedName: "vx",
            },
          ],
          events: [
            { module: "barrel", phase: "evaluate", value: 20, reads: [{ binding: "b_vdef" }] },
          ],
        },
        {
          id: "def",
          format: "esm",
          dependencies: [],
          events: [{ module: "def", phase: "evaluate", value: 7 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    const result = await withRolldownBuild(
      program,
      renderProgram(analyzeProgram(program)),
      async (artifacts) => {
        const [sourceOutcome, bundleOutcome] = await Promise.all([
          executeManifest(artifacts.sourceManifestPath),
          executeManifest(artifacts.bundleManifestPath),
        ]);
        return {
          verdict: classifyVerdict(sourceOutcome, bundleOutcome),
          events: moduleEventPairs(sourceOutcome.events),
        };
      },
    );

    expect(successValue(result)).toEqual({
      verdict: { kind: "pass", signature: "pass" },
      events: [
        ["def", 7],
        ["barrel", 27],
        ["entry", 12],
      ],
    });
  });

  test("builds and round-trips a #8777-shaped side-effect-free barrel re-export chain", async () => {
    // A `sideEffects:false` barrel re-exporting a value-only definer whose value the entry folds. If
    // rolldown drops the re-exported init under strictExecutionOrder (#8777: the re-exported variable
    // stays undefined) the fold becomes non-finite and the bundle crashes; on a correct build source
    // and bundle match. The definer emits no events, so the flag can never drop an observed side
    // effect — the flagged barrel stays within the no-events / value-only contract.
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "barrel", importedName: "vdef", localName: "v" },
          ],
          events: [{ module: "entry", phase: "evaluate", value: 1, reads: [{ binding: "v" }] }],
        },
        {
          id: "barrel",
          format: "esm",
          sideEffectFree: true,
          dependencies: [
            { kind: "esm-reexport-named", target: "def", sourceName: "vdef", exportedName: "vdef" },
          ],
          events: [],
        },
        { id: "def", format: "esm", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    const result = await withRolldownBuild(
      program,
      renderProgram(analyzeProgram(program)),
      async (artifacts) => {
        const [sourceOutcome, bundleOutcome, packageJson] = await Promise.all([
          executeManifest(artifacts.sourceManifestPath),
          executeManifest(artifacts.bundleManifestPath),
          readFile(join(artifacts.sourceDirectory, "node_modules/sef-barrel/package.json"), "utf8"),
        ]);
        return {
          verdict: classifyVerdict(sourceOutcome, bundleOutcome),
          events: moduleEventPairs(sourceOutcome.events),
          packageJson,
        };
      },
    );

    expect(successValue(result)).toEqual({
      verdict: { kind: "pass", signature: "pass" },
      events: [["entry", 1]],
      packageJson:
        '{\n  "name": "sef-barrel",\n  "main": "./barrel.mjs",\n  "sideEffects": false\n}\n',
    });
  });

  test("builds and round-trips a #9887-shaped ESM init cycle split across manual chunks", async () => {
    // An ESM 3-cycle m0 -> m1 -> m2 -> m0 split across two manual chunk groups. Each member folds a
    // CALL of the next member's hoisted `function` export while that member is mid-evaluation up the
    // cycle stack — the wrapper is called before its declaration-form module body has finished. A
    // mis-ordered cross-chunk init (the `init_X is not a function` family, rolldown #9887/#9946)
    // would throw or fold a wrong number; on a correct build source and bundle match.
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "m0" }],
          events: [{ module: "entry", phase: "evaluate", value: 1 }],
        },
        {
          id: "m0",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "m1",
              importedName: "w1",
              localName: "m0_w1",
              call: true,
            },
          ],
          events: [
            {
              module: "m0",
              phase: "evaluate",
              value: 10,
              reads: [{ binding: "m0_w1", call: true }],
            },
          ],
        },
        {
          id: "m1",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "m2",
              importedName: "w2",
              localName: "m1_w2",
              call: true,
            },
          ],
          events: [
            {
              module: "m1",
              phase: "evaluate",
              value: 20,
              reads: [{ binding: "m1_w2", call: true }],
            },
          ],
        },
        {
          id: "m2",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "m0",
              importedName: "w0",
              localName: "m2_w0",
              call: true,
            },
          ],
          events: [
            {
              module: "m2",
              phase: "evaluate",
              value: 30,
              reads: [{ binding: "m2_w0", call: true }],
            },
          ],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
      manualChunkGroups: [
        { name: "g0", moduleIds: ["m0"] },
        { name: "g1", moduleIds: ["m1", "m2"] },
      ],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
    const rendered = renderProgram(analyzeProgram(program));
    // The cycle-edge reads render as hoisted function calls and callable exports, not `const`.
    expect(
      rendered.files.some((file) => file.contents.includes("export function w1() { return 20; }")),
    ).toBe(true);
    expect(rendered.files.some((file) => file.contents.includes("10 + m0_w1()"))).toBe(true);

    const result = await withRolldownBuild(program, rendered, async (artifacts) => {
      const [sourceOutcome, bundleOutcome] = await Promise.all([
        executeManifest(artifacts.sourceManifestPath),
        executeManifest(artifacts.bundleManifestPath),
      ]);
      return {
        verdict: classifyVerdict(sourceOutcome, bundleOutcome),
        events: moduleEventPairs(sourceOutcome.events),
      };
    });

    expect(successValue(result)).toEqual({
      verdict: { kind: "pass", signature: "pass" },
      events: [
        ["m2", 40],
        ["m1", 50],
        ["m0", 30],
        ["entry", 1],
      ],
    });
  });

  test("builds and round-trips a #3529-shaped CJS partial-export cycle split across manual chunks", async () => {
    // A CJS cycle a <-> b split across two manual chunk groups, consumed by an ESM entry. Each member
    // requires the other back mid-evaluation and reads an export NOT YET ASSIGNED — a legal partial
    // export that is `undefined`. A plain fold would be NaN (a both-sides crash the oracle must not
    // rely on); the GUARD folds it to the sentinel -1 instead, so the partial read is observable. The
    // entry post-cycle-reads both members' value exports. A mis-timed CJS init (rolldown #3529 family)
    // would change a folded number; on a correct build source and bundle match.
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "a", importedName: "va", localName: "e_va" },
            { kind: "esm-value-import", target: "b", importedName: "vb", localName: "e_vb" },
          ],
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "e_va" }, { binding: "e_vb" }],
            },
          ],
        },
        {
          id: "a",
          format: "cjs",
          dependencies: [
            { kind: "cjs-require", target: "b", resultBinding: "a_b", readName: "vb", guard: true },
          ],
          events: [
            {
              module: "a",
              phase: "evaluate",
              value: 100,
              reads: [{ binding: "a_b", memberPath: ["vb"], guard: true }],
            },
          ],
        },
        {
          id: "b",
          format: "cjs",
          dependencies: [
            { kind: "cjs-require", target: "a", resultBinding: "b_a", readName: "va", guard: true },
          ],
          events: [
            {
              module: "b",
              phase: "evaluate",
              value: 200,
              reads: [{ binding: "b_a", memberPath: ["va"], guard: true }],
            },
          ],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
      manualChunkGroups: [
        { name: "ga", moduleIds: ["a"] },
        { name: "gb", moduleIds: ["b"] },
      ],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
    const rendered = renderProgram(analyzeProgram(program));
    // The cycle-edge read renders with the finite guard so a partial export folds to a sentinel.
    expect(
      rendered.files.some((file) =>
        file.contents.includes("Number.isFinite(a_b.vb) ? a_b.vb : -1"),
      ),
    ).toBe(true);

    const result = await withRolldownBuild(program, rendered, async (artifacts) => {
      const [sourceOutcome, bundleOutcome] = await Promise.all([
        executeManifest(artifacts.sourceManifestPath),
        executeManifest(artifacts.bundleManifestPath),
      ]);
      return {
        verdict: classifyVerdict(sourceOutcome, bundleOutcome),
        events: moduleEventPairs(sourceOutcome.events),
      };
    });

    // b reads a.va while a is still evaluating (partial -> -1); a reads b.vb once b has finished.
    expect(successValue(result)).toEqual({
      verdict: { kind: "pass", signature: "pass" },
      events: [
        ["b", 199],
        ["a", 299],
        ["entry", 499],
      ],
    });
  });

  test("recognizes panic-shaped build errors and rejects ordinary ones", () => {
    expect(looksLikePanic({ name: "Error", message: "panicked at 'oops', crates/x.rs:1:1" })).toBe(
      true,
    );
    expect(looksLikePanic({ name: "RolldownBuildPanic", message: "anything at all" })).toBe(true);
    expect(
      looksLikePanic({
        name: "Error",
        message: "Rolldown build process crashed with signal SIGSEGV",
      }),
    ).toBe(true);
    expect(looksLikePanic({ name: "Error", message: "fatal runtime error: stack overflow" })).toBe(
      true,
    );
    expect(looksLikePanic({ name: "Error", message: "Could not resolve './missing'" })).toBe(false);
    expect(looksLikePanic({ name: "RollupError", message: "Unexpected token (1:5)" })).toBe(false);
  });

  test("classifies a Rust-panic-shaped build error as a build-failure panic", async () => {
    await withTemporaryModule(
      [
        "export async function rolldown() {",
        "  throw new Error(\"panicked at 'entered unreachable code', crates/rolldown/src/x.rs:1:1\");",
        "}",
        "",
      ].join("\n"),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          singleEntryProgram(),
          renderProgram(analyzeProgram(singleEntryProgram())),
          async (): Promise<never> => {
            throw new Error("panic build callback must not run");
          },
          { packageSpecifier },
        );

        expect(result).toMatchObject({ status: "build-error", stage: "build", panic: true });
      },
    );
  });

  test("reclassifies a build-time process crash as a build-failure panic, not a harness error", async () => {
    await withTemporaryModule(
      ["export async function rolldown() {", "  process.exit(134);", "}", ""].join("\n"),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          singleEntryProgram(),
          renderProgram(analyzeProgram(singleEntryProgram())),
          async (): Promise<never> => {
            throw new Error("crash build callback must not run");
          },
          { packageSpecifier },
        );

        expect(result).toMatchObject({
          status: "build-error",
          stage: "build",
          panic: true,
          error: { name: "RolldownBuildPanic" },
        });
        if (result.status !== "ok") {
          expect(result.error.message).toContain("crashed with exit code 134");
        }
      },
    );
  });

  test("keeps a crash before the package loads as a harness error", async () => {
    await withTemporaryModule(
      ["process.exit(3);", "export async function rolldown() {}", ""].join("\n"),
      async (packageSpecifier) => {
        const result = await withRolldownBuild(
          singleEntryProgram(),
          renderProgram(analyzeProgram(singleEntryProgram())),
          async (): Promise<never> => {
            throw new Error("startup crash callback must not run");
          },
          { packageSpecifier },
        );

        expect(result).toMatchObject({ status: "harness-error", stage: "build" });
        expect(result.status === "ok" ? undefined : result.panic).toBeUndefined();
      },
    );
  });

  test("reports an invalid configurable package specifier as a harness error", async () => {
    const program = singleEntryProgram();
    const originalPackageSpecifier = process.env.ROLLDOWN_PACKAGE;
    process.env.ROLLDOWN_PACKAGE = "rolldown-order-fuzzer-package-that-does-not-exist";

    try {
      const result = await withRolldownBuild(
        program,
        renderProgram(analyzeProgram(program)),
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
      renderProgram(analyzeProgram(program)),
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
          renderProgram(analyzeProgram(program)),
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
          renderProgram(analyzeProgram(program)),
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
    const rendered = renderProgram(analyzeProgram(program));

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
    const rendered = renderProgram(analyzeProgram(program));
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
    const rendered = renderProgram(analyzeProgram(program));
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
    const rendered = renderProgram(analyzeProgram(program));
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
      // The build child accepts any BOOLEAN strictExecutionOrder (a non-boolean is invalid); the
      // seo:true policy is a MODEL-validator rule (`validateBuildConfig`), not a request-parse rule.
      { ...valid, output: { ...valid.output, strictExecutionOrder: "yes" } },
      { ...valid, preserveEntrySignatures: "bogus" },
      { ...valid, includeDependenciesRecursively: "yes" },
      { ...valid, lazyBarrel: 1 },
    ];
    for (const value of invalid) {
      expect(() => parseBuildChildRequest(value)).toThrow(TypeError);
    }
    // strictExecutionOrder:false is a VALID build-child request (rolldown accepts it); it is the model
    // validator that forbids seo:false in W14a.
    expect(() =>
      parseBuildChildRequest({
        ...valid,
        output: { ...valid.output, strictExecutionOrder: false },
      }),
    ).not.toThrow();

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
          renderProgram(analyzeProgram(program)),
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
          renderProgram(analyzeProgram(program)),
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
        renderProgram(analyzeProgram(singleEntryProgram())),
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

describe("organic chunk groups (wave 6)", () => {
  test("maps organic groups onto rolldown codeSplitting.groups with a reconstructed regex test", () => {
    const request: BuildChildRequest = {
      ...validBuildChildRequest(),
      manualChunkGroups: [],
      organicChunkGroups: [
        {
          name: "organic-vendor",
          test: "\\.mjs$",
          minShareCount: 2,
          minSize: 128,
          maxSize: 800,
          priority: 1,
          includeDependenciesRecursively: false,
        },
      ],
    };
    // The request round-trips through validation with the organic groups intact.
    expect(parseBuildChildRequest(request)).toEqual(request);

    const codeSplitting = createOutputOptions(request).codeSplitting;
    expect(codeSplitting).not.toBe(true);
    if (typeof codeSplitting !== "object" || codeSplitting === null) {
      throw new Error("expected organic codeSplitting object");
    }
    const group = codeSplitting.groups?.[0];
    expect(group?.name).toBe("organic-vendor");
    // `test` is reconstructed as a real RegExp (not a substring string).
    expect(group?.test).toBeInstanceOf(RegExp);
    expect(String(group?.test)).toBe("/\\.mjs$/");
    expect(group?.minShareCount).toBe(2);
    expect(group?.minSize).toBe(128);
    expect(group?.maxSize).toBe(800);
    expect(group?.priority).toBe(1);
    expect(group?.includeDependenciesRecursively).toBe(false);
  });

  test("rejects an invalid organic group in the build request", () => {
    const base = validBuildChildRequest();
    expect(() => parseBuildChildRequest({ ...base, organicChunkGroups: [{ name: "" }] })).toThrow(
      TypeError,
    );
    expect(() =>
      parseBuildChildRequest({ ...base, organicChunkGroups: [{ name: "g", minSize: -1 }] }),
    ).toThrow(TypeError);
    expect(() => parseBuildChildRequest({ ...base, organicChunkGroups: "nope" })).toThrow(
      TypeError,
    );
  });

  test("an organic build merges shared modules into one organic chunk (config takes effect)", async () => {
    // Two entries both statically import a side-effectful shared leaf (uninlinable). A minShareCount
    // >= 2 organic group must capture the shared leaf into one `chunks/organic-*.js` chunk — proving
    // the size/share-driven config reached rolldown and changed the composition.
    const program = {
      modules: [
        {
          id: "entry-a",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "shared", importedName: "v", localName: "av" },
          ],
          events: [{ module: "entry-a", phase: "evaluate", value: 1, reads: [{ binding: "av" }] }],
        },
        {
          id: "entry-b",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "shared", importedName: "v", localName: "bv" },
          ],
          events: [{ module: "entry-b", phase: "evaluate", value: 2, reads: [{ binding: "bv" }] }],
        },
        {
          id: "shared",
          format: "esm",
          dependencies: [],
          events: [{ module: "shared", phase: "evaluate", value: 5 }],
        },
      ],
      entries: [
        { name: "a", moduleId: "entry-a" },
        { name: "b", moduleId: "entry-b" },
      ],
      schedule: [
        { kind: "import-entry", entry: "a" },
        { kind: "import-entry", entry: "b" },
      ],
      organicChunkGroups: [
        { name: "organic-shared", minShareCount: 2, includeDependenciesRecursively: false },
      ],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);

    const rendered = renderProgram(analyzeProgram(program));
    const result = await withRolldownBuild(program, rendered, async (artifacts) => {
      const [sourceOutcome, bundleOutcome] = await Promise.all([
        executeManifest(artifacts.sourceManifestPath),
        executeManifest(artifacts.bundleManifestPath),
      ]);
      return {
        entryCount: artifacts.manifest.entries.length,
        outputFiles: artifacts.outputFiles,
        verdictKind: classifyVerdict(sourceOutcome, bundleOutcome).kind,
      };
    });

    const value = successValue(result);
    // Both model entries mapped to output chunks despite the shared merge.
    expect(value.entryCount).toBe(2);
    // A distinct organic-named shared chunk appears — the config took effect.
    expect(value.outputFiles.some((file) => file.includes("organic-shared"))).toBe(true);
    // A verdict was produced (build + facade mapping succeeded); kind is rolldown-version specific.
    expect(["pass", "mismatch"]).toContain(value.verdictKind);
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

/// The `[module, value]` pairs of an outcome's MODULE events, dropping the runner-emitted schedule
/// markers so these value-shape assertions stay focused on module output. Marker behavior has its own
/// dedicated tests.
function moduleEventPairs(events: readonly ExecutionEvent[]): [string, EventValue][] {
  return events
    .filter((event): event is ModuleExecutionEvent => !isScheduleMarker(event))
    .map((event) => [event.module, event.value]);
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
    includeDependenciesRecursively: true,
    lazyBarrel: false,
    onDemandWrapping: true,
    bundleDirectory: "/tmp/bundle",
    manualChunkGroups: [{ name: "shared", modulePaths: ["/tmp/source/shared.mjs"] }],
    organicChunkGroups: [],
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

function findManualChunkCase(): ReturnType<typeof generateCase> {
  for (let seed = 0; seed < 1_000; seed += 1) {
    const candidate = generateCase(seed, 4);
    if (candidate.template === "manual-chunk-separation") {
      return candidate;
    }
  }
  throw new Error("No manual-chunk-separation case found within 1000 seeds");
}
