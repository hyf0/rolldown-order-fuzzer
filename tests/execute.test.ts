/// <reference types="node" />

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { analyzeProgram } from "../src/analyzed-program.ts";
import { executeManifest } from "../src/execute.ts";
import type { ProgramModel } from "../src/model.ts";
import type { ExecutionEvent, ExecutionManifest, ExecutionOutcome } from "../src/protocol.ts";
import { renderProgram, type RenderedProgram } from "../src/render.ts";
import { validateProgramModel } from "../src/validate-model.ts";
import { classifyVerdict } from "../src/verdict.ts";

const EXECUTION_TEST_TIMEOUT_MS = 10_000;

// The runner appends a phase marker after each settled schedule operation. Both entry-evaluation
// kinds collapse to "entry"; a dynamic trigger is "dynamic".
function entryMarker(schedule: number): ExecutionEvent {
  return { version: 1, marker: "schedule", schedule, kind: "entry" };
}
function dynamicMarker(schedule: number): ExecutionEvent {
  return { version: 1, marker: "schedule", schedule, kind: "dynamic" };
}

describe("executeManifest", () => {
  test("runs an ESM source schedule in a fresh Node child process", async () => {
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

    await withRenderedProgram(renderProgram(analyzeProgram(program)), async (manifestPath) => {
      await expect(
        executeManifest(manifestPath, { timeoutMs: EXECUTION_TEST_TIMEOUT_MS }),
      ).resolves.toEqual({
        version: 1,
        status: "ok",
        events: [
          {
            version: 1,
            module: "dependency",
            phase: "evaluate",
            value: 1,
          },
          {
            version: 1,
            module: "entry",
            phase: "evaluate",
            value: "ready",
          },
          entryMarker(0),
        ],
      });
    });
  });

  test("triggers registered dynamic imports in explicit schedule order", async () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-dynamic-import",
              target: "lazy",
              registration: "load-lazy",
            },
          ],
          events: [{ module: "entry", phase: "evaluate", value: "entry" }],
        },
        {
          id: "lazy",
          format: "esm",
          dependencies: [],
          events: [{ module: "lazy", phase: "evaluate", value: "lazy" }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [
        { kind: "import-entry", entry: "main" },
        { kind: "trigger-dynamic-import", registration: "load-lazy" },
      ],
    } satisfies ProgramModel;

    await withRenderedProgram(renderProgram(analyzeProgram(program)), async (manifestPath) => {
      const outcome = await executeManifest(manifestPath, {
        timeoutMs: EXECUTION_TEST_TIMEOUT_MS,
      });

      expect(outcome).toMatchObject({
        version: 1,
        status: "ok",
        events: [
          { version: 1, module: "entry", phase: "evaluate", value: "entry" },
          entryMarker(0),
          { version: 1, module: "lazy", phase: "evaluate", value: "lazy" },
          dynamicMarker(1),
        ],
      });
    });
  });

  test("requires a CommonJS entry", async () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "cjs",
          dependencies: [],
          events: [{ module: "entry", phase: "evaluate", value: "cjs" }],
        },
      ],
      entries: [{ name: "worker", moduleId: "entry" }],
      schedule: [{ kind: "require-entry", entry: "worker" }],
    } satisfies ProgramModel;

    await withRenderedProgram(renderProgram(analyzeProgram(program)), async (manifestPath) => {
      await expect(
        executeManifest(manifestPath, { timeoutMs: EXECUTION_TEST_TIMEOUT_MS }),
      ).resolves.toMatchObject({
        status: "ok",
        events: [{ version: 1, module: "entry", phase: "evaluate", value: "cjs" }, entryMarker(0)],
      });
    });
  });

  test("does not reuse globals or module caches between runs", async () => {
    const manifest = {
      version: 1,
      entries: [{ name: "main", path: "entry.mjs", format: "esm" }],
      operations: [{ kind: "import-entry", entry: "main" }],
    } satisfies ExecutionManifest;
    const entry = [
      "globalThis.__isolationCounter = (globalThis.__isolationCounter ?? 0) + 1;",
      'globalThis.__orderEvent({ module: "entry", phase: "evaluate", value: globalThis.__isolationCounter });',
      "",
    ].join("\n");

    await withProgramFiles({ "entry.mjs": entry }, manifest, async (manifestPath) => {
      const first = await executeManifest(manifestPath, {
        timeoutMs: EXECUTION_TEST_TIMEOUT_MS,
      });
      const second = await executeManifest(manifestPath, {
        timeoutMs: EXECUTION_TEST_TIMEOUT_MS,
      });

      expect(first).toEqual(second);
      expect(first).toMatchObject({
        status: "ok",
        events: [{ version: 1, module: "entry", phase: "evaluate", value: 1 }, entryMarker(0)],
      });
    });
  });

  test("normalizes child errors without temporary directory paths", async () => {
    const manifest = {
      version: 1,
      entries: [{ name: "main", path: "entry.mjs", format: "esm" }],
      operations: [{ kind: "import-entry", entry: "main" }],
    } satisfies ExecutionManifest;

    await withProgramFiles(
      { "entry.mjs": "throw new TypeError(import.meta.url);\n" },
      manifest,
      async (manifestPath) => {
        await expect(
          executeManifest(manifestPath, { timeoutMs: EXECUTION_TEST_TIMEOUT_MS }),
        ).resolves.toEqual({
          version: 1,
          status: "error",
          events: [],
          error: {
            name: "TypeError",
            message: "<root>/entry.mjs",
          },
        });
      },
    );

    const exactRoot = await executeModule(
      [
        'import { dirname } from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "throw new Error(dirname(fileURLToPath(import.meta.url)));",
        "",
      ].join("\n"),
    );
    expect(exactRoot).toMatchObject({
      status: "error",
      error: {
        name: "Error",
        message: "<root>",
      },
    });
  });

  test("normalizes backslash temporary-root paths in child errors", async () => {
    const outcome = await executeModule(
      [
        'import { dirname } from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "const root = dirname(fileURLToPath(import.meta.url));",
        'throw new Error(`${root.replaceAll("/", "\\\\")}\\\\entry.mjs`);',
        "",
      ].join("\n"),
    );

    expect(outcome).toMatchObject({
      status: "error",
      error: {
        name: "Error",
        message: "<root>/entry.mjs",
      },
    });
  });

  test("keeps error messages distinct after fixture code replaces String.prototype.replaceAll", async () => {
    const source = await executeModule(
      'String.prototype.replaceAll = () => "<poisoned>"; throw new TypeError("source-distinct-message");\n',
    );
    const bundle = await executeModule(
      'String.prototype.replaceAll = () => "<poisoned>"; throw new TypeError("bundle-distinct-message");\n',
    );

    expect(source).toMatchObject({
      status: "error",
      error: { name: "TypeError", message: "source-distinct-message" },
    });
    expect(bundle).toMatchObject({
      status: "error",
      error: { name: "TypeError", message: "bundle-distinct-message" },
    });
    expect(classifyVerdict(source, bundle)).toMatchObject({
      kind: "mismatch",
      reason: "error-mismatch",
    });
  });

  test("collects events after fixture code replaces global constructors", async () => {
    const outcome = await executeModule(
      'globalThis.String = () => "poisoned"; globalThis.Number = () => 0; globalThis.Boolean = () => false; globalThis.Array = () => []; globalThis.Object = () => ({}); globalThis.__orderEvent({ module: "entry", phase: "evaluate", value: 7 });\n',
    );
    expect(outcome).toMatchObject({
      status: "ok",
      events: [{ version: 1, module: "entry", phase: "evaluate", value: 7 }, entryMarker(0)],
    });
  });

  test("rejects unsupported manifest protocol versions in the child", async () => {
    await withFiles(
      [
        { path: "entry.mjs", contents: "" },
        {
          path: "schedule.json",
          contents: `${JSON.stringify({
            version: 2,
            entries: [{ name: "main", path: "entry.mjs", format: "esm" }],
            operations: [{ kind: "import-entry", entry: "main" }],
          })}\n`,
        },
      ],
      "schedule.json",
      async (manifestPath) => {
        const first = await executeManifest(manifestPath, {
          timeoutMs: EXECUTION_TEST_TIMEOUT_MS,
        });
        const second = await executeManifest(manifestPath, {
          timeoutMs: EXECUTION_TEST_TIMEOUT_MS,
        });

        expect(first).toEqual({
          version: 1,
          status: "harness-error",
          events: [],
          error: {
            name: "Error",
            message: "Unsupported execution manifest version 2; expected 1",
          },
        });
        expect(second).toEqual(first);
        expect(classifyVerdict(first, second)).toMatchObject({
          kind: "invalid-harness",
          reason: "source-harness-error",
        });
      },
    );
  });

  test("classifies invalid and mismatched manifests as harness failures", async () => {
    const cases: readonly {
      readonly files: Readonly<Record<string, string>>;
      readonly manifestPath: string;
    }[] = [
      {
        files: {},
        manifestPath: "missing-schedule.json",
      },
      {
        files: { "schedule.json": "{not json\n" },
        manifestPath: "schedule.json",
      },
      {
        files: {
          "schedule.json": `${JSON.stringify({
            version: 1,
            entries: [],
            operations: [{ kind: "import-entry", entry: "missing" }],
          })}\n`,
        },
        manifestPath: "schedule.json",
      },
      {
        files: {
          "entry.cjs": "",
          "schedule.json": `${JSON.stringify({
            version: 1,
            entries: [{ name: "main", path: "entry.cjs", format: "cjs" }],
            operations: [{ kind: "import-entry", entry: "main" }],
          })}\n`,
        },
        manifestPath: "schedule.json",
      },
      {
        files: {
          "entry.mjs": "",
          "schedule.json": `${JSON.stringify({
            version: 1,
            entries: [{ name: "main", path: "entry.mjs", format: "esm" }],
            operations: [{ kind: "require-entry", entry: "main" }],
          })}\n`,
        },
        manifestPath: "schedule.json",
      },
    ];

    for (const { files, manifestPath } of cases) {
      await withFiles(
        Object.entries(files).map(([path, contents]) => ({ path, contents })),
        manifestPath,
        async (path) => {
          const first = await executeManifest(path, {
            timeoutMs: EXECUTION_TEST_TIMEOUT_MS,
          });
          const second = await executeManifest(path, {
            timeoutMs: EXECUTION_TEST_TIMEOUT_MS,
          });

          expect(first.status).toBe("harness-error");
          expect(second).toEqual(first);
          expect(classifyVerdict(first, second)).toMatchObject({
            kind: "invalid-harness",
            reason: "source-harness-error",
          });
        },
      );
    }
  });

  test("treats a missing dynamic registration as a semantic bundle failure", async () => {
    const source = await executeDynamicSchedule(
      'globalThis.__orderDynamicImports["load"] = async () => {};\n',
      "load",
    );
    const bundle = await executeDynamicSchedule("", "load");

    expect(source).toMatchObject({
      status: "ok",
    });
    expect(bundle).toEqual({
      version: 1,
      status: "error",
      // The entry import settled and marked its boundary before the missing trigger threw.
      events: [entryMarker(0)],
      error: {
        name: "Error",
        message: 'Missing dynamic import registration "load"',
      },
    });
    expect(classifyVerdict(source, bundle)).toEqual({
      kind: "mismatch",
      reason: "bundle-only-crash",
      signature: 'bundle-only-crash:["Error","Missing dynamic import registration \\"load\\""]',
    });
    expect(classifyVerdict(bundle, source)).toMatchObject({
      kind: "mismatch",
      reason: "source-crash-suppressed",
    });
  });

  test("caps generated structured events at 512 with a stable semantic error", async () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [],
          events: Array.from({ length: 513 }, (_, index) => ({
            module: "entry",
            phase: "evaluate",
            value: index,
          })),
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    await withRenderedProgram(renderProgram(analyzeProgram(program)), async (manifestPath) => {
      const first = await executeManifest(manifestPath, {
        timeoutMs: EXECUTION_TEST_TIMEOUT_MS,
      });
      const second = await executeManifest(manifestPath, {
        timeoutMs: EXECUTION_TEST_TIMEOUT_MS,
      });

      expect(first).toMatchObject({
        status: "error",
        error: {
          name: "Error",
          message: "Execution event limit exceeded: maximum 512",
        },
      });
      expect(first.events).toHaveLength(512);
      expect(second).toEqual(first);
    });
  });

  test("normalizes non-Error thrown values without crashing the runner", async () => {
    await expect(executeModule("throw 1n;\n")).resolves.toEqual({
      version: 1,
      status: "error",
      events: [],
      error: {
        name: "NonError",
        message: "1n",
      },
    });
    await expect(
      executeModule("const value = {}; value.self = value; throw value;\n"),
    ).resolves.toEqual({
      version: 1,
      status: "error",
      events: [],
      error: {
        name: "NonError",
        message: "[object Object]",
      },
    });
  });

  test("normalizes hostile thrown objects without crashing the runner", async () => {
    const hostileError = await executeModule(
      [
        'const error = new Error("ignored");',
        'Object.defineProperty(error, "name", { value: 1n });',
        'Object.defineProperty(error, "message", { get() { throw 7; } });',
        "throw error;",
        "",
      ].join("\n"),
    );
    expect(hostileError).toEqual({
      version: 1,
      status: "error",
      events: [],
      error: {
        name: "Error",
        message: "<unreadable error message>",
      },
    });

    const hostileProxy = await executeModule(
      [
        "throw new Proxy({}, {",
        "  getPrototypeOf() { throw new Error('prototype trap'); },",
        "});",
        "",
      ].join("\n"),
    );
    expect(hostileProxy).toEqual({
      version: 1,
      status: "error",
      events: [],
      error: {
        name: "NonError",
        message: "{}",
      },
    });
  });

  test("reads stateful Error name and message getters once each", async () => {
    const outcome = await executeDynamicThrow(
      [
        'const error = new Error("ignored");',
        "let nameReads = 0;",
        "let messageReads = 0;",
        'Object.defineProperty(error, "name", { get() {',
        "  nameReads += 1;",
        '  if (nameReads > 1) throw new Error("name read twice");',
        '  return "StatefulError";',
        "} });",
        'Object.defineProperty(error, "message", { get() {',
        "  messageReads += 1;",
        '  if (messageReads > 1) throw new Error("message read twice");',
        '  return "stateful message";',
        "} });",
        'globalThis.__orderDynamicImports["throw-hostile"] = () => Promise.reject(error);',
        "",
      ].join("\n"),
    );

    expect(outcome).toEqual({
      version: 1,
      status: "error",
      // The entry import settled and marked its boundary before the dynamic trigger rejected.
      events: [entryMarker(0)],
      error: {
        name: "StatefulError",
        message: "stateful message",
      },
    });
  });

  test("catches throwing Error name and message getters", async () => {
    const outcome = await executeDynamicThrow(
      [
        'const error = new Error("ignored");',
        'Object.defineProperty(error, "name", { get() { throw new Error("name getter"); } });',
        'Object.defineProperty(error, "message", { get() { throw new Error("message getter"); } });',
        'globalThis.__orderDynamicImports["throw-hostile"] = () => Promise.reject(error);',
        "",
      ].join("\n"),
    );

    expect(outcome).toEqual({
      version: 1,
      status: "error",
      // The entry import settled and marked its boundary before the dynamic trigger rejected.
      events: [entryMarker(0)],
      error: {
        name: "Error",
        message: "<unreadable error message>",
      },
    });
  });

  test("classifies a nonzero child exit as an error", async () => {
    const manifest = {
      version: 1,
      entries: [{ name: "main", path: "entry.mjs", format: "esm" }],
      operations: [{ kind: "import-entry", entry: "main" }],
    } satisfies ExecutionManifest;

    await withProgramFiles(
      {
        "entry.mjs": [
          'process.stdout.write("ignored stdout");',
          'process.stderr.write("ignored stderr");',
          "process.exitCode = 7;",
          "",
        ].join("\n"),
      },
      manifest,
      async (manifestPath) => {
        await expect(
          executeManifest(manifestPath, { timeoutMs: EXECUTION_TEST_TIMEOUT_MS }),
        ).resolves.toMatchObject({
          version: 1,
          status: "harness-error",
          error: {
            name: "ChildProcessError",
            message: "Child runner ended with exit code 7",
          },
        });
      },
    );
  });

  test("returns a stable error when the child exits without a result file", async () => {
    const first = await executeModule("process.exit(0);\n");
    const second = await executeModule("process.exit(0);\n");

    expect(first).toEqual(second);
    expect(first).toEqual({
      version: 1,
      status: "harness-error",
      events: [],
      error: {
        name: "ChildProcessError",
        message: "Child runner ended with exit code 0 without a valid result",
      },
    });
  });

  test("returns a bounded timeout for a rendered generated program", async () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [],
          events: [{ module: "entry", phase: "evaluate", value: "generated" }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    await withRenderedProgram(renderProgram(analyzeProgram(program)), async (manifestPath) => {
      const startedAt = Date.now();
      const outcome = await executeManifest(manifestPath, { timeoutMs: 1 });

      expect(outcome).toEqual({
        version: 1,
        status: "timeout",
        events: [],
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    });
  });

  test("classifies real source and bundle process outcomes", async () => {
    const source = await executeModule(
      emitEvents([
        ["a", 1],
        ["b", 2],
      ]),
    );
    const reordered = await executeModule(
      emitEvents([
        ["b", 2],
        ["a", 1],
      ]),
    );
    const missing = await executeModule(emitEvents([["a", 1]]));
    const extra = await executeModule(
      emitEvents([
        ["a", 1],
        ["extra", 3],
        ["b", 2],
      ]),
    );
    const bundleError = await executeModule('throw new TypeError("bundle failed");\n');
    const sourceError = await executeModule('throw new TypeError("source failed");\n');
    const cleanBundle = await executeModule("");

    expect(classifyVerdict(source, bundleError)).toMatchObject({
      reason: "bundle-only-crash",
    });
    expect(classifyVerdict(sourceError, cleanBundle)).toMatchObject({
      reason: "source-crash-suppressed",
    });
    expect(classifyVerdict(source, reordered)).toMatchObject({
      reason: "events-reordered",
    });
    expect(classifyVerdict(source, missing)).toMatchObject({
      reason: "events-missing",
    });
    expect(classifyVerdict(source, extra)).toMatchObject({
      reason: "events-extra",
    });
    expect(classifyVerdict(sourceError, bundleError)).toMatchObject({
      reason: "error-mismatch",
    });
  });
});

// Handwritten models in the shape of the value-flow bugs the value oracle targets. Each expresses
// the issue purely through observed value flow — no sideEffects metadata, no namespace, no
// re-export syntax — and must validate, render, and round-trip source execution. A correct source
// run is the oracle the campaign then compares Rolldown against.
describe("value-carrying issue shapes", () => {
  test("#9961-like: a referenced cross-module value drop is observable without metadata", async () => {
    // consumer references initializer's exported value; dropping the initializer would make the
    // observed number diverge or crash, exactly as the dropped `checkGlobals` binding did.
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "consumer" }],
          events: [],
        },
        {
          id: "consumer",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "initializer",
              importedName: "checkGlobals",
              localName: "checkGlobals",
            },
          ],
          events: [
            {
              module: "consumer",
              phase: "evaluate",
              value: 0,
              reads: [{ binding: "checkGlobals" }],
            },
          ],
        },
        {
          id: "initializer",
          format: "esm",
          dependencies: [],
          events: [{ module: "initializer", phase: "evaluate", value: 500 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    await expectRoundTrip(program, [
      { version: 1, module: "initializer", phase: "evaluate", value: 500 },
      { version: 1, module: "consumer", phase: "evaluate", value: 500 },
    ]);
  });

  test("#8675-like: namespace-less named imports read specific used exports", async () => {
    // entry names `used` and `other` directly (no `import *`) and reads each; wrongly removing one
    // named export makes its read undefined, the failure #8675 reproduced.
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "lib",
              importedName: "used",
              localName: "usedValue",
            },
            {
              kind: "esm-value-import",
              target: "lib",
              importedName: "other",
              localName: "otherValue",
            },
          ],
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 0,
              reads: [{ binding: "usedValue" }, { binding: "otherValue" }],
            },
          ],
        },
        {
          id: "lib",
          format: "esm",
          dependencies: [],
          events: [{ module: "lib", phase: "evaluate", value: 42 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    await expectRoundTrip(program, [
      { version: 1, module: "lib", phase: "evaluate", value: 42 },
      { version: 1, module: "entry", phase: "evaluate", value: 84 },
    ]);
  });

  test("#8777-like: a re-exported value depends on the source initializer running", async () => {
    // barrel re-exposes a value computed from source's `Foo`; if source's initializer is not called
    // the re-exported value is undefined, the `variable undefined` symptom of #8777.
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "barrel",
              importedName: "Foo",
              localName: "barrelFoo",
            },
          ],
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 0,
              reads: [{ binding: "barrelFoo" }],
            },
          ],
        },
        {
          id: "barrel",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "source",
              importedName: "Foo",
              localName: "fooValue",
            },
          ],
          events: [{ module: "barrel", phase: "evaluate", value: 0 }],
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

    await expectRoundTrip(program, [
      { version: 1, module: "source", phase: "evaluate", value: 7 },
      { version: 1, module: "barrel", phase: "evaluate", value: 0 },
      { version: 1, module: "entry", phase: "evaluate", value: 7 },
    ]);
  });
});

async function expectRoundTrip(
  program: ProgramModel,
  events: ExecutionOutcome["events"],
): Promise<void> {
  expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
  await withRenderedProgram(renderProgram(analyzeProgram(program)), async (manifestPath) => {
    // Every shape here runs a single `import-entry`, so the runner appends one entry marker.
    await expect(
      executeManifest(manifestPath, { timeoutMs: EXECUTION_TEST_TIMEOUT_MS }),
    ).resolves.toEqual({ version: 1, status: "ok", events: [...events, entryMarker(0)] });
  });
}

async function withRenderedProgram(
  rendered: RenderedProgram,
  run: (manifestPath: string) => Promise<void>,
): Promise<void> {
  await withFiles(rendered.files, rendered.schedulePath, run);
}

async function withProgramFiles(
  files: Readonly<Record<string, string>>,
  manifest: ExecutionManifest,
  run: (manifestPath: string) => Promise<void>,
): Promise<void> {
  const manifestPath = "schedule.json";
  await withFiles(
    [
      ...Object.entries(files).map(([path, contents]) => ({ path, contents })),
      { path: manifestPath, contents: `${JSON.stringify(manifest, null, 2)}\n` },
    ],
    manifestPath,
    run,
  );
}

async function withFiles(
  files: readonly { readonly path: string; readonly contents: string }[],
  manifestPath: string,
  run: (manifestPath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "order-execute-test-"));

  try {
    await Promise.all(
      files.map(async (file) => {
        const path = join(directory, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.contents);
      }),
    );
    await run(join(directory, manifestPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function executeModule(
  source: string,
  timeoutMs = EXECUTION_TEST_TIMEOUT_MS,
): Promise<ExecutionOutcome> {
  const manifest = {
    version: 1,
    entries: [{ name: "main", path: "entry.mjs", format: "esm" }],
    operations: [{ kind: "import-entry", entry: "main" }],
  } satisfies ExecutionManifest;
  let outcome: ExecutionOutcome | undefined;

  await withProgramFiles({ "entry.mjs": source }, manifest, async (manifestPath) => {
    outcome = await executeManifest(manifestPath, { timeoutMs });
  });

  if (outcome === undefined) {
    throw new Error("Execution did not produce an outcome");
  }
  return outcome;
}

async function executeDynamicThrow(source: string): Promise<ExecutionOutcome> {
  const manifest = {
    version: 1,
    entries: [{ name: "main", path: "entry.mjs", format: "esm" }],
    operations: [
      { kind: "import-entry", entry: "main" },
      { kind: "trigger-dynamic-import", registration: "throw-hostile" },
    ],
  } satisfies ExecutionManifest;
  let outcome: ExecutionOutcome | undefined;

  await withProgramFiles({ "entry.mjs": source }, manifest, async (manifestPath) => {
    outcome = await executeManifest(manifestPath, {
      timeoutMs: EXECUTION_TEST_TIMEOUT_MS,
    });
  });

  if (outcome === undefined) {
    throw new Error("Execution did not produce an outcome");
  }
  return outcome;
}

async function executeDynamicSchedule(
  source: string,
  registration: string,
): Promise<ExecutionOutcome> {
  const manifest = {
    version: 1,
    entries: [{ name: "main", path: "entry.mjs", format: "esm" }],
    operations: [
      { kind: "import-entry", entry: "main" },
      { kind: "trigger-dynamic-import", registration },
    ],
  } satisfies ExecutionManifest;
  let outcome: ExecutionOutcome | undefined;

  await withProgramFiles({ "entry.mjs": source }, manifest, async (manifestPath) => {
    outcome = await executeManifest(manifestPath, {
      timeoutMs: EXECUTION_TEST_TIMEOUT_MS,
    });
  });

  if (outcome === undefined) {
    throw new Error("Execution did not produce an outcome");
  }
  return outcome;
}

function emitEvents(events: readonly (readonly [module: string, value: number])[]): string {
  return `${events
    .map(
      ([module, value]) =>
        `globalThis.__orderEvent(${JSON.stringify({ module, phase: "evaluate", value })});`,
    )
    .join("\n")}\n`;
}
