/// <reference types="node" />

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, test } from "vite-plus/test";

import { executeManifest } from "../src/execute.ts";
import type { ProgramModel } from "../src/model.ts";
import { renderProgram } from "../src/render.ts";

const execFileAsync = promisify(execFile);

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

    const rendered = renderProgram(program);

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

    const rendered = renderProgram(program);

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
        'const __orderExport0 = "answer";',
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

    const rendered = renderProgram(program);

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
        'exports.shared = "shared";',
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
          { version: 1, module: "shared-cjs", phase: "evaluate", value: "once" },
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

    const rendered = renderProgram(program);

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
          { version: 1, module: "lazy", phase: "evaluate", value: 3 },
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

    const rendered = renderProgram(program);
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

    expect(() => renderProgram(program)).toThrowError(
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

    const rendered = renderProgram(program);

    expect(fileContents(rendered.files, "module-0001.mjs")).toBe(
      [
        'import { source as __orderExport0 } from "./module-0002.mjs";',
        "",
        'const __orderExport1 = "default";',
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

    const rendered = renderProgram(program);

    expect(fileContents(rendered.files, "module-0001.cjs")).toBe(
      [
        'Object.defineProperty(exports, "__proto__", { value: "__proto__", enumerable: true });',
        "",
      ].join("\n"),
    );
    await withRenderedProgram(rendered.files, async (directory) => {
      await import(pathToFileURL(join(directory, "module-0000.mjs")).href);
      const namespace = await import(pathToFileURL(join(directory, "module-0001.cjs")).href);
      expect(namespace.__proto__).toBe("__proto__");
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

    const rendered = renderProgram(program);

    expect(fileContents(rendered.files, "module-0001.cjs")).toBe(
      ['module.exports = "default";', ""].join("\n"),
    );
    await withRenderedProgram(rendered.files, async (directory) => {
      await import(pathToFileURL(join(directory, "module-0000.mjs")).href);
      const namespace = await import(pathToFileURL(join(directory, "module-0001.cjs")).href);
      expect(namespace.default).toBe("default");
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

    const rendered = renderProgram(program);

    expect(fileContents(rendered.files, "module-0001.cjs")).toBe(
      [
        "module.exports = {};",
        'module.exports.answer = "answer";',
        'Object.defineProperty(module.exports, "__proto__", { value: "__proto__", enumerable: true });',
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
        answer: "answer",
        proto: "__proto__",
        defaultAnswer: "answer",
        defaultProto: "__proto__",
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

    expect(() => renderProgram(program)).toThrowError(
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

    const rendered = renderProgram(program);
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

    expect(renderProgram(program)).toEqual(renderProgram(structuredClone(program)));
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

    const rendered = renderProgram(program);

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
    const rendered = renderProgram(program);

    await withRenderedProgram(rendered.files, async (directory) => {
      const namespace = await import(pathToFileURL(join(directory, "module-0001.cjs")).href);
      expect(namespace.answer).toBe("answer");
    });
  });
});

function fileContents(
  files: readonly { readonly path: string; readonly contents: string }[],
  path: string,
): string {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`Missing rendered file ${JSON.stringify(path)}`);
  }
  return file.contents;
}

async function withRenderedProgram(
  files: readonly { readonly path: string; readonly contents: string }[],
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "order-render-"));

  try {
    await Promise.all(files.map((file) => writeFile(join(directory, file.path), file.contents)));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
