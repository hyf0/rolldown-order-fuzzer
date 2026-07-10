/// <reference types="node" />

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, test } from "vite-plus/test";

import { analyzeProgram } from "../src/analyzed-program.ts";
import { executeManifest } from "../src/execute.ts";
import type { ProgramModel } from "../src/model.ts";
import type { ExecutionEvent } from "../src/protocol.ts";
import { renderProgram } from "../src/render.ts";
import { validateProgramModel } from "../src/validate-model.ts";
import { fileContents } from "./fixtures.ts";

const execFileAsync = promisify(execFile);

// The runner appends a phase marker after each settled schedule operation (both entry kinds collapse
// to "entry"; a dynamic trigger is "dynamic").
function entryMarker(schedule: number): ExecutionEvent {
  return { version: 1, marker: "schedule", schedule, kind: "entry" };
}
function dynamicMarker(schedule: number): ExecutionEvent {
  return { version: 1, marker: "schedule", schedule, kind: "dynamic" };
}

describe("renderProgram", () => {
  test("renders only ProgramModel modules and the schedule manifest", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "dependency" }],
          events: [],
        },
        {
          id: "dependency",
          format: "cjs",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
      manualChunkGroups: [
        { name: "entry-group", moduleIds: ["entry"] },
        { name: "dependency-group", moduleIds: ["dependency"] },
      ],
    } satisfies ProgramModel;

    const rendered = renderProgram(analyzeProgram(program));

    expect(rendered.files.map((file) => file.path).sort()).toEqual(
      [...rendered.modulePaths.values(), rendered.schedulePath].sort(),
    );
    expect(rendered.files).toHaveLength(program.modules.length + 1);
    expect(rendered.files.some((file) => file.path === "runtime.cjs")).toBe(false);
  });

  test("renders ESM static and value imports with derived exports and a schedule manifest", () => {
    const program = {
      modules: [
        {
          id: "entry/raw",
          format: "esm",
          dependencies: [
            { kind: "esm-side-effect-import", target: "side effect" },
            {
              kind: "esm-value-import",
              target: "value:target",
              importedName: "answer",
              localName: "importedAnswer",
            },
          ],
          events: [{ module: "entry/raw", phase: "evaluate", value: 1 }],
        },
        {
          id: "side effect",
          format: "esm",
          dependencies: [],
          events: [{ module: "side effect", phase: "evaluate", value: true }],
        },
        {
          id: "value:target",
          format: "esm",
          dependencies: [],
          events: [{ module: "value:target", phase: "evaluate", value: "ready" }],
        },
      ],
      entries: [{ name: "main/raw", moduleId: "entry/raw" }],
      schedule: [{ kind: "import-entry", entry: "main/raw" }],
    } satisfies ProgramModel;

    const rendered = renderProgram(analyzeProgram(program));

    expect(rendered.files.map((file) => file.path)).toEqual([
      "module-0000.mjs",
      "module-0001.mjs",
      "module-0002.mjs",
      "schedule.json",
    ]);
    expect(Object.fromEntries(rendered.modulePaths)).toEqual({
      "entry/raw": "module-0000.mjs",
      "side effect": "module-0001.mjs",
      "value:target": "module-0002.mjs",
    });
    expect(Object.fromEntries(rendered.entryPaths)).toEqual({
      "main/raw": "module-0000.mjs",
    });
    expect(fileContents(rendered.files, "module-0000.mjs")).toBe(
      [
        'import "./module-0001.mjs";',
        'import { answer as importedAnswer } from "./module-0002.mjs";',
        "",
        'globalThis.__orderEvent({"module":"entry/raw","phase":"evaluate","value":1});',
        "",
      ].join("\n"),
    );
    expect(fileContents(rendered.files, "module-0002.mjs")).toBe(
      [
        'globalThis.__orderEvent({"module":"value:target","phase":"evaluate","value":"ready"});',
        "",
        "const __orderExport0 = 0;",
        "export { __orderExport0 as answer };",
        "",
      ].join("\n"),
    );
    expect(rendered.schedule).toEqual({
      version: 1,
      entries: [{ name: "main/raw", path: "module-0000.mjs", format: "esm" }],
      operations: [{ kind: "import-entry", entry: "main/raw" }],
    });
    expect(JSON.parse(fileContents(rendered.files, rendered.schedulePath))).toEqual(
      rendered.schedule,
    );
  });

  test("renders top-level CJS require and one shared CJS carrier path", async () => {
    const program = {
      modules: [
        {
          id: "cjs-entry",
          format: "cjs",
          dependencies: [{ kind: "cjs-require", target: "esm-target" }],
          events: [{ module: "cjs-entry", phase: "evaluate", value: null }],
        },
        {
          id: "carrier-a",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "shared-cjs",
              importedName: "shared",
              localName: "sharedFromA",
            },
          ],
          events: [],
        },
        {
          id: "carrier-b",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "shared-cjs",
              importedName: "shared",
              localName: "sharedFromB",
            },
          ],
          events: [],
        },
        {
          id: "shared-cjs",
          format: "cjs",
          dependencies: [],
          events: [{ module: "shared-cjs", phase: "evaluate", value: "once" }],
        },
        {
          id: "esm-target",
          format: "esm",
          dependencies: [],
          events: [{ module: "esm-target", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [
        { name: "worker", moduleId: "cjs-entry" },
        { name: "a", moduleId: "carrier-a" },
        { name: "b", moduleId: "carrier-b" },
      ],
      schedule: [
        { kind: "require-entry", entry: "worker" },
        { kind: "import-entry", entry: "a" },
        { kind: "import-entry", entry: "b" },
      ],
    } satisfies ProgramModel;

    const rendered = renderProgram(analyzeProgram(program));

    expect(fileContents(rendered.files, "module-0000.cjs")).toBe(
      [
        'require("./module-0004.mjs");',
        "",
        'globalThis.__orderEvent({"module":"cjs-entry","phase":"evaluate","value":null});',
        "",
      ].join("\n"),
    );
    expect(fileContents(rendered.files, "module-0001.mjs")).toContain(
      'import { shared as sharedFromA } from "./module-0003.cjs";',
    );
    expect(fileContents(rendered.files, "module-0002.mjs")).toContain(
      'import { shared as sharedFromB } from "./module-0003.cjs";',
    );
    expect(fileContents(rendered.files, "module-0003.cjs")).toBe(
      [
        'globalThis.__orderEvent({"module":"shared-cjs","phase":"evaluate","value":"once"});',
        "",
        "exports.shared = 0;",
        "",
      ].join("\n"),
    );

    await withRenderedProgram(rendered.files, async (directory) => {
      await expect(executeManifest(join(directory, rendered.schedulePath))).resolves.toEqual({
        version: 1,
        status: "ok",
        events: [
          { version: 1, module: "esm-target", phase: "evaluate", value: 2 },
          { version: 1, module: "cjs-entry", phase: "evaluate", value: null },
          entryMarker(0),
          { version: 1, module: "shared-cjs", phase: "evaluate", value: "once" },
          entryMarker(1),
          entryMarker(2),
        ],
      });
    });
  });

  test("renders dynamic registration through the shared registry and an optional TLA marker", async () => {
    const program = {
      modules: [
        {
          id: "async-entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-dynamic-import",
              target: "lazy",
              registration: "load-lazy",
            },
          ],
          events: [{ module: "async-entry", phase: "evaluate", value: "after-await" }],
          hasTopLevelAwait: true,
        },
        {
          id: "lazy",
          format: "esm",
          dependencies: [],
          events: [{ module: "lazy", phase: "evaluate", value: 3 }],
        },
      ],
      entries: [{ name: "main", moduleId: "async-entry" }],
      schedule: [
        { kind: "import-entry", entry: "main" },
        { kind: "trigger-dynamic-import", registration: "load-lazy" },
      ],
    } satisfies ProgramModel;

    const rendered = renderProgram(analyzeProgram(program));

    expect(fileContents(rendered.files, "module-0000.mjs")).toBe(
      [
        "await 0;",
        "",
        'globalThis.__orderDynamicImports["load-lazy"] = () => import("./module-0001.mjs");',
        "",
        'globalThis.__orderEvent({"module":"async-entry","phase":"evaluate","value":"after-await"});',
        "",
      ].join("\n"),
    );

    await withRenderedProgram(rendered.files, async (directory) => {
      await expect(executeManifest(join(directory, rendered.schedulePath))).resolves.toEqual({
        version: 1,
        status: "ok",
        events: [
          {
            version: 1,
            module: "async-entry",
            phase: "evaluate",
            value: "after-await",
          },
          entryMarker(0),
          { version: 1, module: "lazy", phase: "evaluate", value: 3 },
          dynamicMarker(1),
        ],
      });
    });
  });

  test("renders CJS dynamic-import registrations alongside requires", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "cjs",
          dependencies: [
            { kind: "cjs-require", target: "dep" },
            { kind: "esm-dynamic-import", target: "lazy", registration: "dyn-entry-lazy" },
          ],
          events: [{ module: "entry", phase: "evaluate", value: 1 }],
        },
        { id: "dep", format: "cjs", dependencies: [], events: [] },
        { id: "lazy", format: "esm", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [
        { kind: "require-entry", entry: "main" },
        { kind: "trigger-dynamic-import", registration: "dyn-entry-lazy" },
      ],
    } satisfies ProgramModel;

    const rendered = renderProgram(analyzeProgram(program));
    const entryFile = rendered.files.find(
      (file) => file.path === rendered.modulePaths.get("entry"),
    );
    expect(entryFile).toBeDefined();
    expect(entryFile?.contents).toContain('require("./');
    expect(entryFile?.contents).toContain(
      'globalThis.__orderDynamicImports["dyn-entry-lazy"] = () => import("./',
    );
    expect(entryFile?.contents).not.toContain('require("./' + rendered.modulePaths.get("lazy"));
  });

  test("rejects invalid programs before rendering", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "missing" }],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(() => renderProgram(analyzeProgram(program))).toThrowError(
      [
        "Cannot render invalid program:",
        '- modules[0].dependencies[0].target: unknown module id "missing"',
      ].join("\n"),
    );
  });

  test("avoids collisions between generated exports and imported local bindings", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "target",
              importedName: "default",
              localName: "targetDefault",
            },
          ],
          events: [],
        },
        {
          id: "target",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "leaf",
              importedName: "source",
              localName: "__orderExport0",
            },
          ],
          events: [],
        },
        {
          id: "leaf",
          format: "esm",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    const rendered = renderProgram(analyzeProgram(program));

    expect(fileContents(rendered.files, "module-0001.mjs")).toBe(
      [
        'import { source as __orderExport0 } from "./module-0002.mjs";',
        "",
        "const __orderExport1 = 0 + __orderExport0;",
        "export { __orderExport1 as default };",
        "",
      ].join("\n"),
    );
  });

  test("renders a primitive CJS __proto__ export with Object.defineProperty", async () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "target",
              importedName: "__proto__",
              localName: "value",
            },
          ],
          events: [],
        },
        {
          id: "target",
          format: "cjs",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    const rendered = renderProgram(analyzeProgram(program));

    expect(fileContents(rendered.files, "module-0001.cjs")).toBe(
      ['Object.defineProperty(exports, "__proto__", { value: 0, enumerable: true });', ""].join(
        "\n",
      ),
    );
    await withRenderedProgram(rendered.files, async (directory) => {
      await import(pathToFileURL(join(directory, "module-0000.mjs")).href);
      const namespace = await import(pathToFileURL(join(directory, "module-0001.cjs")).href);
      expect(namespace.__proto__).toBe(0);
    });
  });

  test("renders a primitive default-only CJS export with module.exports", async () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "target",
              importedName: "default",
              localName: "value",
            },
          ],
          events: [],
        },
        {
          id: "target",
          format: "cjs",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    const rendered = renderProgram(analyzeProgram(program));

    expect(fileContents(rendered.files, "module-0001.cjs")).toBe(
      ["module.exports = 0;", ""].join("\n"),
    );
    await withRenderedProgram(rendered.files, async (directory) => {
      await import(pathToFileURL(join(directory, "module-0000.mjs")).href);
      const namespace = await import(pathToFileURL(join(directory, "module-0001.cjs")).href);
      expect(namespace.default).toBe(0);
    });
  });

  test("renders combined default and named CJS requests on one exports object", async () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "target",
              importedName: "default",
              localName: "targetDefault",
            },
            {
              kind: "esm-value-import",
              target: "target",
              importedName: "answer",
              localName: "answer",
            },
            {
              kind: "esm-value-import",
              target: "target",
              importedName: "__proto__",
              localName: "proto",
            },
          ],
          events: [],
        },
        {
          id: "target",
          format: "cjs",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    const rendered = renderProgram(analyzeProgram(program));

    expect(fileContents(rendered.files, "module-0001.cjs")).toBe(
      [
        "module.exports = {};",
        "module.exports.answer = 0;",
        'Object.defineProperty(module.exports, "__proto__", { value: 0, enumerable: true });',
        "",
      ].join("\n"),
    );
    await withRenderedProgram(rendered.files, async (directory) => {
      const probePath = join(directory, "probe.mjs");
      await writeFile(
        probePath,
        [
          'import "./module-0000.mjs";',
          'import targetDefault, { answer, __proto__ as proto } from "./module-0001.cjs";',
          "console.log(JSON.stringify({",
          "  answer,",
          "  proto,",
          "  defaultAnswer: targetDefault.answer,",
          "  defaultProto: targetDefault.__proto__,",
          '  ownProto: Object.hasOwn(targetDefault, "__proto__"),',
          "}));",
          "",
        ].join("\n"),
      );

      const { stdout } = await execFileAsync(process.execPath, [probePath]);
      expect(JSON.parse(stdout)).toEqual({
        answer: 0,
        proto: 0,
        defaultAnswer: 0,
        defaultProto: 0,
        ownProto: true,
      });
    });
  });

  test("rejects imported local bindings that shadow renderer instrumentation", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "target",
              importedName: "answer",
              localName: "globalThis",
            },
          ],
          events: [{ module: "entry", phase: "evaluate", value: 1 }],
        },
        {
          id: "target",
          format: "esm",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(() => renderProgram(analyzeProgram(program))).toThrowError(
      [
        "Cannot render invalid program:",
        '- modules[0].dependencies[0].localName: reserved renderer binding identifier "globalThis"',
      ].join("\n"),
    );
  });

  test("escapes generated JavaScript strings and never uses raw module IDs as file names", () => {
    const moduleId = 'entry"\n\u2028';
    const registration = 'load"]\n\u2029';
    const event = {
      module: moduleId,
      phase: "phase\\\u2029",
      value: 'value"\n\u2028',
    } as const;
    const program = {
      modules: [
        {
          id: moduleId,
          format: "esm",
          dependencies: [
            {
              kind: "esm-dynamic-import",
              target: "lazy",
              registration,
            },
          ],
          events: [event],
        },
        {
          id: "lazy",
          format: "esm",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: 'main"\n', moduleId }],
      schedule: [
        { kind: "import-entry", entry: 'main"\n' },
        { kind: "trigger-dynamic-import", registration },
      ],
    } satisfies ProgramModel;

    const rendered = renderProgram(analyzeProgram(program));
    const source = fileContents(rendered.files, "module-0000.mjs");

    expect(rendered.files.map((file) => file.path)).toEqual([
      "module-0000.mjs",
      "module-0001.mjs",
      "schedule.json",
    ]);
    expect(source).not.toContain("\u2028");
    expect(source).not.toContain("\u2029");
    expect(source).toContain("\\u2028");
    expect(source).toContain("\\u2029");
    expect(source).toContain('\\"');
    expect(source).toContain("\\n");
    expect(JSON.parse(fileContents(rendered.files, rendered.schedulePath))).toEqual(
      rendered.schedule,
    );
  });

  test("returns byte-for-byte deterministic output for the same program", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-dynamic-import",
              target: "lazy",
              registration: "load",
            },
          ],
          events: [{ module: "entry", phase: "evaluate", value: 1 }],
        },
        {
          id: "lazy",
          format: "cjs",
          dependencies: [],
          events: [{ module: "lazy", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [
        { kind: "import-entry", entry: "main" },
        { kind: "trigger-dynamic-import", registration: "load" },
      ],
    } satisfies ProgramModel;

    expect(renderProgram(analyzeProgram(program))).toEqual(
      renderProgram(analyzeProgram(structuredClone(program))),
    );
  });

  test("clones schedule operations so later model mutation cannot diverge from schedule.json", () => {
    const scheduleOperation = {
      kind: "import-entry" as const,
      entry: "main",
    };
    const schedule = [scheduleOperation];
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [],
          events: [],
        },
      ],
      entries: [
        { name: "main", moduleId: "entry" },
        { name: "alternate", moduleId: "entry" },
      ],
      schedule,
    } satisfies ProgramModel;

    const rendered = renderProgram(analyzeProgram(program));

    scheduleOperation.entry = "alternate";
    schedule.push({ kind: "import-entry", entry: "alternate" });

    expect(rendered.schedule.operations).toEqual([{ kind: "import-entry", entry: "main" }]);
    expect(rendered.schedule.operations).not.toBe(schedule);
    expect(rendered.schedule.operations[0]).not.toBe(scheduleOperation);
    expect(JSON.parse(fileContents(rendered.files, rendered.schedulePath))).toEqual(
      rendered.schedule,
    );
  });

  test("emits CJS named exports that native Node detects", async () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "target",
              importedName: "answer",
              localName: "answer",
            },
          ],
          events: [],
        },
        {
          id: "target",
          format: "cjs",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    const rendered = renderProgram(analyzeProgram(program));

    await withRenderedProgram(rendered.files, async (directory) => {
      const namespace = await import(pathToFileURL(join(directory, "module-0001.cjs")).href);
      expect(namespace.answer).toBe(0);
    });
  });

  test("folds ESM value reads into events and state-derived exports, then round-trips", async () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "reader",
              importedName: "w",
              localName: "readerValue",
            },
          ],
          events: [],
        },
        {
          id: "reader",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "source",
              importedName: "v",
              localName: "srcValue",
            },
          ],
          events: [
            {
              module: "reader",
              phase: "evaluate",
              value: 100,
              reads: [{ binding: "srcValue" }],
            },
          ],
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

    expect(fileContents(rendered.files, "module-0001.mjs")).toBe(
      [
        'import { v as srcValue } from "./module-0002.mjs";',
        "",
        'globalThis.__orderEvent({ module: "reader", phase: "evaluate", value: 100 + srcValue });',
        "",
        "const __orderExport0 = 100 + srcValue;",
        "export { __orderExport0 as w };",
        "",
      ].join("\n"),
    );
    expect(fileContents(rendered.files, "module-0002.mjs")).toBe(
      [
        'globalThis.__orderEvent({"module":"source","phase":"evaluate","value":7});',
        "",
        "const __orderExport0 = 7;",
        "export { __orderExport0 as v };",
        "",
      ].join("\n"),
    );

    await withRenderedProgram(rendered.files, async (directory) => {
      await expect(executeManifest(join(directory, rendered.schedulePath))).resolves.toEqual({
        version: 1,
        status: "ok",
        events: [
          { version: 1, module: "source", phase: "evaluate", value: 7 },
          { version: 1, module: "reader", phase: "evaluate", value: 107 },
          entryMarker(0),
        ],
      });
    });
  });

  test("renders a #9961-shaped side-effect-free value module under a synthetic package, then round-trips", async () => {
    // A flagged transitive value module: source (side-effectful) -> flagged (value only, no events)
    // -> entry (folds the flagged value into an event). Its initialization order matters through the
    // reads, so a dropped/reordered init would change the observed number or crash.
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

    expect(rendered.files.map((file) => file.path)).toEqual([
      "module-0000.mjs",
      "side-effect-free/module-0001.mjs",
      "module-0002.mjs",
      "side-effect-free/package.json",
      "schedule.json",
    ]);
    expect(fileContents(rendered.files, "module-0000.mjs")).toBe(
      [
        'import { w as flaggedW } from "./side-effect-free/module-0001.mjs";',
        "",
        'globalThis.__orderEvent({ module: "entry", phase: "evaluate", value: 1 + flaggedW });',
        "",
      ].join("\n"),
    );
    // The flagged module renders inside the side-effect-free package, reads upstream through a
    // parent-relative specifier, emits no events, and exports only its folded value.
    expect(fileContents(rendered.files, "side-effect-free/module-0001.mjs")).toBe(
      [
        'import { v as sourceV } from "../module-0002.mjs";',
        "",
        "const __orderExport0 = 0 + sourceV;",
        "export { __orderExport0 as w };",
        "",
      ].join("\n"),
    );
    expect(fileContents(rendered.files, "side-effect-free/package.json")).toBe(
      '{\n  "sideEffects": false\n}\n',
    );

    await withRenderedProgram(rendered.files, async (directory) => {
      await expect(executeManifest(join(directory, rendered.schedulePath))).resolves.toEqual({
        version: 1,
        status: "ok",
        events: [
          { version: 1, module: "source", phase: "evaluate", value: 7 },
          { version: 1, module: "entry", phase: "evaluate", value: 8 },
          entryMarker(0),
        ],
      });
    });
  });

  test("binds a CJS require result and reads a member across interop, then round-trips", async () => {
    const program = {
      modules: [
        {
          id: "cjs-reader",
          format: "cjs",
          dependencies: [
            {
              kind: "cjs-require",
              target: "cjs-source",
              resultBinding: "sourceExports",
              readName: "vs",
            },
          ],
          events: [
            {
              module: "cjs-reader",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "sourceExports", member: "vs" }],
            },
          ],
        },
        {
          id: "cjs-source",
          format: "cjs",
          dependencies: [],
          events: [{ module: "cjs-source", phase: "evaluate", value: 40 }],
        },
      ],
      entries: [{ name: "main", moduleId: "cjs-reader" }],
      schedule: [{ kind: "require-entry", entry: "main" }],
    } satisfies ProgramModel;

    const rendered = renderProgram(analyzeProgram(program));

    expect(fileContents(rendered.files, "module-0000.cjs")).toBe(
      [
        'const sourceExports = require("./module-0001.cjs");',
        "",
        'globalThis.__orderEvent({ module: "cjs-reader", phase: "evaluate", value: 1 + sourceExports.vs });',
        "",
      ].join("\n"),
    );
    expect(fileContents(rendered.files, "module-0001.cjs")).toBe(
      [
        'globalThis.__orderEvent({"module":"cjs-source","phase":"evaluate","value":40});',
        "",
        "exports.vs = 40;",
        "",
      ].join("\n"),
    );

    await withRenderedProgram(rendered.files, async (directory) => {
      await expect(executeManifest(join(directory, rendered.schedulePath))).resolves.toEqual({
        version: 1,
        status: "ok",
        events: [
          { version: 1, module: "cjs-source", phase: "evaluate", value: 40 },
          { version: 1, module: "cjs-reader", phase: "evaluate", value: 41 },
          entryMarker(0),
        ],
      });
    });
  });

  test("renders an ESM namespace import with a folded member read, then round-trips", async () => {
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
              readMembers: ["vt"],
            },
          ],
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "ns0", member: "vt" }],
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

    const rendered = renderProgram(analyzeProgram(program));

    expect(fileContents(rendered.files, "module-0000.mjs")).toBe(
      [
        'import * as ns0 from "./module-0001.mjs";',
        "",
        'globalThis.__orderEvent({ module: "entry", phase: "evaluate", value: 1 + ns0.vt });',
        "",
      ].join("\n"),
    );
    expect(fileContents(rendered.files, "module-0001.mjs")).toContain(
      "export { __orderExport0 as vt };",
    );

    await withRenderedProgram(rendered.files, async (directory) => {
      await expect(executeManifest(join(directory, rendered.schedulePath))).resolves.toEqual({
        version: 1,
        status: "ok",
        events: [
          { version: 1, module: "target", phase: "evaluate", value: 40 },
          { version: 1, module: "entry", phase: "evaluate", value: 41 },
          entryMarker(0),
        ],
      });
    });
  });

  test("renders a re-export barrel chain (star then named), then round-trips", async () => {
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

    const rendered = renderProgram(analyzeProgram(program));

    // The barrels forward the value; only the definer synthesizes it, so a dropped barrel init is
    // observable downstream (rolldown #8777 / #9299 shape).
    expect(fileContents(rendered.files, "module-0000.mjs")).toBe(
      [
        'import { vdef as r } from "./module-0001.mjs";',
        "",
        'globalThis.__orderEvent({ module: "reader", phase: "evaluate", value: 1 + r });',
        "",
      ].join("\n"),
    );
    expect(fileContents(rendered.files, "module-0001.mjs")).toBe(
      ['export * from "./module-0002.mjs";', ""].join("\n"),
    );
    expect(fileContents(rendered.files, "module-0002.mjs")).toBe(
      ['export { vdef } from "./module-0003.mjs";', ""].join("\n"),
    );
    expect(fileContents(rendered.files, "module-0003.mjs")).toContain(
      "export { __orderExport0 as vdef };",
    );

    await withRenderedProgram(rendered.files, async (directory) => {
      await expect(executeManifest(join(directory, rendered.schedulePath))).resolves.toEqual({
        version: 1,
        status: "ok",
        events: [
          { version: 1, module: "def", phase: "evaluate", value: 7 },
          { version: 1, module: "reader", phase: "evaluate", value: 8 },
          entryMarker(0),
        ],
      });
    });
  });

  test("renders a default-as-name re-export forwarding a definer's default, then round-trips", async () => {
    const program = {
      modules: [
        {
          id: "reader",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "barrel", importedName: "vdef", localName: "r" },
          ],
          events: [{ module: "reader", phase: "evaluate", value: 2, reads: [{ binding: "r" }] }],
        },
        {
          id: "barrel",
          format: "esm",
          dependencies: [
            {
              kind: "esm-reexport-named",
              target: "def",
              sourceName: "default",
              exportedName: "vdef",
            },
          ],
          events: [],
        },
        {
          id: "def",
          format: "esm",
          dependencies: [],
          events: [{ module: "def", phase: "evaluate", value: 5 }],
        },
      ],
      entries: [{ name: "main", moduleId: "reader" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    const rendered = renderProgram(analyzeProgram(program));

    expect(fileContents(rendered.files, "module-0001.mjs")).toBe(
      ['export { default as vdef } from "./module-0002.mjs";', ""].join("\n"),
    );
    // The definer's demanded export is `default`, sourced through the default-as-name re-export.
    expect(fileContents(rendered.files, "module-0002.mjs")).toContain(
      "export { __orderExport0 as default };",
    );

    await withRenderedProgram(rendered.files, async (directory) => {
      await expect(executeManifest(join(directory, rendered.schedulePath))).resolves.toEqual({
        version: 1,
        status: "ok",
        events: [
          { version: 1, module: "def", phase: "evaluate", value: 5 },
          { version: 1, module: "reader", phase: "evaluate", value: 7 },
          entryMarker(0),
        ],
      });
    });
  });

  test("renders a CJS require of an ESM barrel's forwarded member, then round-trips", async () => {
    // The model supports a CJS reader requiring a barrel and reading a re-exported member; the
    // existing readable-require rendering handles it and the demand routes through the barrel.
    const program = {
      modules: [
        {
          id: "cjs-reader",
          format: "cjs",
          dependencies: [
            { kind: "cjs-require", target: "barrel", resultBinding: "b", readName: "vdef" },
          ],
          events: [
            {
              module: "cjs-reader",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "b", member: "vdef" }],
            },
          ],
        },
        {
          id: "barrel",
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
          events: [{ module: "def", phase: "evaluate", value: 9 }],
        },
      ],
      entries: [{ name: "main", moduleId: "cjs-reader" }],
      schedule: [{ kind: "require-entry", entry: "main" }],
    } satisfies ProgramModel;

    const rendered = renderProgram(analyzeProgram(program));

    expect(fileContents(rendered.files, "module-0000.cjs")).toBe(
      [
        'const b = require("./module-0001.mjs");',
        "",
        'globalThis.__orderEvent({ module: "cjs-reader", phase: "evaluate", value: 1 + b.vdef });',
        "",
      ].join("\n"),
    );

    await withRenderedProgram(rendered.files, async (directory) => {
      await expect(executeManifest(join(directory, rendered.schedulePath))).resolves.toEqual({
        version: 1,
        status: "ok",
        events: [
          { version: 1, module: "def", phase: "evaluate", value: 9 },
          { version: 1, module: "cjs-reader", phase: "evaluate", value: 10 },
          entryMarker(0),
        ],
      });
    });
  });

  test("renders a multi-kind pair as several statements for one specifier, then round-trips", async () => {
    // The same target is imported for side effect AND value AND dynamically — the wave-5 multi-edge
    // pair. Rendering emits one statement per dependency (deterministic array order), and the dynamic
    // import of the already-statically-loaded module must not re-run it: `lib` evaluates exactly once.
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-side-effect-import", target: "lib" },
            { kind: "esm-value-import", target: "lib", importedName: "v", localName: "libV" },
            { kind: "esm-dynamic-import", target: "lib", registration: "load-lib" },
          ],
          events: [{ module: "entry", phase: "evaluate", value: 1, reads: [{ binding: "libV" }] }],
        },
        {
          id: "lib",
          format: "esm",
          dependencies: [],
          events: [{ module: "lib", phase: "evaluate", value: 5 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [
        { kind: "import-entry", entry: "main" },
        { kind: "trigger-dynamic-import", registration: "load-lib" },
      ],
    } satisfies ProgramModel;

    const rendered = renderProgram(analyzeProgram(program));

    expect(fileContents(rendered.files, "module-0000.mjs")).toBe(
      [
        'import "./module-0001.mjs";',
        'import { v as libV } from "./module-0001.mjs";',
        "",
        'globalThis.__orderDynamicImports["load-lib"] = () => import("./module-0001.mjs");',
        "",
        'globalThis.__orderEvent({ module: "entry", phase: "evaluate", value: 1 + libV });',
        "",
      ].join("\n"),
    );

    await withRenderedProgram(rendered.files, async (directory) => {
      await expect(executeManifest(join(directory, rendered.schedulePath))).resolves.toEqual({
        version: 1,
        status: "ok",
        // `lib` appears once: the dynamic trigger finds it already loaded and does not re-run it.
        events: [
          { version: 1, module: "lib", phase: "evaluate", value: 5 },
          { version: 1, module: "entry", phase: "evaluate", value: 6 },
          entryMarker(0),
          dynamicMarker(1),
        ],
      });
    });
  });

  // Finding 7 (renderer dependency order): PIN the CURRENT category-ordered emission. Dependencies
  // render by category (ESM: imports, then re-exports, then dynamic registrations; CJS: requires, then
  // dynamic registrations), NOT by dependency-array position. These cases put a dynamic import FIRST in
  // the array yet expect the static edge to render FIRST, locking today's behavior so the scheduled
  // interop-wave correction to a single ordered requested-module stream is deliberate and re-accepted.
  test("PINS category-ordered dependency emission (ESM: imports before dynamic registrations)", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-dynamic-import", target: "lazy", registration: "r" },
            { kind: "esm-value-import", target: "val", importedName: "v", localName: "entryV" },
          ],
          events: [
            { module: "entry", phase: "evaluate", value: 1, reads: [{ binding: "entryV" }] },
          ],
        },
        { id: "lazy", format: "esm", dependencies: [], events: [] },
        {
          id: "val",
          format: "esm",
          dependencies: [],
          events: [{ module: "val", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    const contents = fileContents(renderProgram(analyzeProgram(program)).files, "module-0000.mjs");
    const importAt = contents.indexOf("import { v as entryV }");
    const dynamicAt = contents.indexOf("__orderDynamicImports");
    expect(importAt).toBeGreaterThanOrEqual(0);
    expect(dynamicAt).toBeGreaterThanOrEqual(0);
    // The static import renders before the dynamic registration although the dynamic edge is first.
    expect(importAt).toBeLessThan(dynamicAt);
  });

  test("PINS category-ordered dependency emission (CJS: requires before dynamic registrations)", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "cjs",
          dependencies: [
            { kind: "esm-dynamic-import", target: "lazy", registration: "r" },
            { kind: "cjs-require", target: "dep", resultBinding: "d", readName: "vdep" },
          ],
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "d", member: "vdep" }],
            },
          ],
        },
        { id: "lazy", format: "esm", dependencies: [], events: [] },
        {
          id: "dep",
          format: "cjs",
          dependencies: [],
          events: [{ module: "dep", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "require-entry", entry: "main" }],
    } satisfies ProgramModel;
    const contents = fileContents(renderProgram(analyzeProgram(program)).files, "module-0000.cjs");
    const requireAt = contents.indexOf("const d = require(");
    const dynamicAt = contents.indexOf("__orderDynamicImports");
    expect(requireAt).toBeGreaterThanOrEqual(0);
    expect(dynamicAt).toBeGreaterThanOrEqual(0);
    // The require renders before the dynamic registration although the dynamic edge is first.
    expect(requireAt).toBeLessThan(dynamicAt);
  });
});

async function withRenderedProgram(
  files: readonly { readonly path: string; readonly contents: string }[],
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "order-render-"));

  try {
    await Promise.all(
      files.map(async (file) => {
        const path = join(directory, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.contents);
      }),
    );
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("reserved export-name declarations (finding 2.3)", () => {
  test("a callable-own-state definer synthesizing `default` uses a fresh local + export-as", () => {
    const program = {
      modules: [
        {
          id: "consumer",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "def",
              importedName: "default",
              localName: "d",
              call: true,
            },
          ],
          events: [
            {
              module: "consumer",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "d", call: true }],
            },
          ],
        },
        {
          id: "def",
          format: "esm",
          dependencies: [],
          events: [{ module: "def", phase: "evaluate", value: 5 }],
          callableOwnState: true,
        },
      ],
      entries: [{ name: "main", moduleId: "consumer" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
    const def = fileContents(renderProgram(analyzeProgram(program)).files, "module-0001.mjs");
    // `export function default()` is a syntax error; a fresh local aliased to `default` is valid.
    expect(def).not.toContain("export function default(");
    expect(def).toContain("as default };");
  });

  test("an object definer synthesizing `default` uses a fresh local + export-as", () => {
    const program = {
      modules: [
        {
          id: "consumer",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "obj",
              importedName: "default",
              localName: "o",
              objectRef: true,
            },
          ],
          events: [
            {
              module: "consumer",
              phase: "evaluate",
              value: 1,
              identityCheck: { leftBinding: "o", rightBinding: "o" },
            },
          ],
        },
        { id: "obj", format: "esm", dependencies: [], events: [], objectExport: true },
      ],
      entries: [{ name: "main", moduleId: "consumer" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
    const obj = fileContents(renderProgram(analyzeProgram(program)).files, "module-0001.mjs");
    // `export const default = …` is a syntax error; a fresh local aliased to `default` is valid.
    expect(obj).not.toContain("export const default ");
    expect(obj).toContain("as default };");
  });
});
