import { describe, expect, test } from "vite-plus/test";

import { analyzeProgram } from "../src/analyzed-program.ts";
import type { BuildConfig, ProgramModel } from "../src/model.ts";
import type { ModuleModel } from "../src/model.ts";
import { buildConfigOf, DEFAULT_BUILD_CONFIG, programChunking } from "../src/model.ts";
import { renderProgram } from "../src/render.ts";
import { validateProgramModel } from "../src/validate-model.ts";
import { sideEffectFreeTransitiveProgram } from "./fixtures.ts";

describe("validateProgramModel", () => {
  test("accepts a program using every initial model operation", () => {
    const program = {
      modules: [
        {
          id: "esm-entry",
          format: "esm",
          dependencies: [
            { kind: "esm-side-effect-import", target: "cjs-leaf" },
            {
              kind: "esm-value-import",
              target: "esm-value",
              importedName: "value",
              localName: "importedValue",
            },
            {
              kind: "esm-dynamic-import",
              target: "esm-lazy",
              registration: "load-lazy",
            },
          ],
          events: [{ module: "esm-entry", phase: "evaluate", value: 1 }],
        },
        {
          id: "cjs-entry",
          format: "cjs",
          dependencies: [{ kind: "cjs-require", target: "esm-value" }],
          events: [{ module: "cjs-entry", phase: "evaluate", value: true }],
        },
        {
          id: "cjs-leaf",
          format: "cjs",
          dependencies: [],
          events: [{ module: "cjs-leaf", phase: "evaluate", value: null }],
        },
        {
          id: "esm-value",
          format: "esm",
          dependencies: [],
          events: [{ module: "esm-value", phase: "evaluate", value: "value" }],
        },
        {
          id: "esm-lazy",
          format: "esm",
          dependencies: [],
          events: [{ module: "esm-lazy", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [
        { name: "main", moduleId: "esm-entry" },
        { name: "worker", moduleId: "cjs-entry" },
      ],
      schedule: [
        { kind: "import-entry", entry: "main" },
        { kind: "require-entry", entry: "worker" },
        { kind: "trigger-dynamic-import", registration: "load-lazy" },
      ],
      manualChunkGroups: [
        { name: "carriers", moduleIds: ["esm-entry", "cjs-entry"] },
        { name: "interop", moduleIds: ["cjs-leaf", "esm-value"] },
      ],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
  });

  test("accepts value-carrying events and readable requires", () => {
    const program = {
      modules: [
        {
          id: "esm-reader",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "esm-source",
              importedName: "v",
              localName: "sourceValue",
            },
          ],
          events: [
            {
              module: "esm-reader",
              phase: "evaluate",
              value: 10,
              reads: [{ binding: "sourceValue" }],
            },
          ],
        },
        {
          id: "esm-source",
          format: "esm",
          dependencies: [],
          events: [{ module: "esm-source", phase: "evaluate", value: 3 }],
        },
        {
          id: "cjs-reader",
          format: "cjs",
          dependencies: [
            {
              kind: "cjs-require",
              target: "cjs-target",
              resultBinding: "targetExports",
              readName: "vt",
            },
          ],
          events: [
            {
              module: "cjs-reader",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "targetExports", memberPath: ["vt"] }],
            },
          ],
        },
        {
          id: "cjs-target",
          format: "cjs",
          dependencies: [],
          events: [{ module: "cjs-target", phase: "evaluate", value: 5 }],
        },
      ],
      entries: [
        { name: "main", moduleId: "esm-reader" },
        { name: "worker", moduleId: "cjs-reader" },
      ],
      schedule: [
        { kind: "import-entry", entry: "main" },
        { kind: "require-entry", entry: "worker" },
      ],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
  });

  test("accepts a side-effect-free transitive value module", () => {
    expect(validateProgramModel(analyzeProgram(sideEffectFreeTransitiveProgram()))).toEqual([]);
  });

  test("rejects a side-effect-free module that emits events, is CJS, or carries non-value dependencies", () => {
    const program = {
      modules: [
        {
          id: "flagged-cjs",
          format: "cjs",
          sideEffectFree: true,
          dependencies: [{ kind: "cjs-require", target: "leaf" }],
          events: [{ module: "flagged-cjs", phase: "evaluate", value: 1 }],
        },
        {
          id: "flagged-esm",
          format: "esm",
          sideEffectFree: true,
          dependencies: [{ kind: "esm-side-effect-import", target: "leaf" }],
          events: [],
        },
        { id: "leaf", format: "cjs", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "flagged-esm" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    // The legacy flags normalize to sideEffects:false packages, so the metadata-purity contract is
    // enforced on the PACKAGE view — one message vocabulary for legacy and package models alike.
    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      "modules[0]: a metadata-pure package member module must be ESM, received cjs",
      "modules[0]: a metadata-pure package member module must not emit events; its events can be legally dropped under the package's sideEffects metadata",
      "modules[0].dependencies[0]: a metadata-pure package member module may only carry value-only ESM dependencies, received cjs-require",
      "modules[1].dependencies[0]: a metadata-pure package member module may only carry value-only ESM dependencies, received esm-side-effect-import",
    ]);
  });

  test("accepts a namespace import with folded member reads (ESM and CJS targets)", () => {
    const program = {
      modules: [
        {
          id: "reader",
          format: "esm",
          dependencies: [
            {
              kind: "esm-namespace-import",
              target: "esm-target",
              localName: "ns0",
              readMembers: [["a"], ["b"]],
            },
            {
              kind: "esm-namespace-import",
              target: "cjs-target",
              localName: "ns1",
              readMembers: [["c"]],
            },
          ],
          events: [
            {
              module: "reader",
              phase: "evaluate",
              value: 1,
              reads: [
                { binding: "ns0", memberPath: ["a"] },
                { binding: "ns0", memberPath: ["b"] },
                { binding: "ns1", memberPath: ["c"] },
              ],
            },
          ],
        },
        { id: "esm-target", format: "esm", dependencies: [], events: [] },
        { id: "cjs-target", format: "cjs", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "reader" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
  });

  test("rejects a namespace read of an undeclared member", () => {
    const program = {
      modules: [
        {
          id: "reader",
          format: "esm",
          dependencies: [
            {
              kind: "esm-namespace-import",
              target: "target",
              localName: "ns0",
              readMembers: [["a"]],
            },
          ],
          events: [
            {
              module: "reader",
              phase: "evaluate",
              value: 0,
              reads: [{ binding: "ns0", memberPath: ["b"] }, { binding: "ns0" }],
            },
          ],
        },
        { id: "target", format: "esm", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "reader" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[0].events[0].reads[0].memberPath: expected a declared namespace member path for binding "ns0", received "b"',
      'modules[0].events[0].reads[1].memberPath: expected a declared namespace member path for binding "ns0", received no member',
    ]);
  });

  test("accepts a re-export (barrel) chain including star and default-as-name forms", () => {
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
            {
              kind: "esm-reexport-named",
              target: "def",
              sourceName: "default",
              exportedName: "vdef",
            },
          ],
          events: [],
        },
        { id: "def", format: "esm", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "reader" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
  });

  test("accepts a side-effect-free (flagged) barrel re-exporting a value-only definer", () => {
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

    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
  });

  test("rejects invalid re-export identifier names", () => {
    const program = {
      modules: [
        {
          id: "esm-barrel",
          format: "esm",
          dependencies: [
            {
              kind: "esm-reexport-named",
              target: "target",
              sourceName: "ok",
              exportedName: "not ok",
            },
            {
              kind: "esm-reexport-named",
              target: "target",
              sourceName: "no-dash",
              exportedName: "fine",
            },
          ],
          events: [],
        },
        { id: "target", format: "esm", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "esm-barrel" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[0].dependencies[0].exportedName: invalid JavaScript identifier "not ok"',
      'modules[0].dependencies[1].sourceName: invalid JavaScript identifier "no-dash"',
    ]);
  });

  test("rejects namespace imports and re-exports on CJS modules", () => {
    // The model types forbid these on a CJS module; the runtime check guards a model loaded from
    // JSON (e.g. by the shrinker), so this simulates that with an explicit cast.
    const program = {
      modules: [
        {
          id: "cjs-reader",
          format: "cjs",
          dependencies: [
            {
              kind: "esm-namespace-import",
              target: "target",
              localName: "ns",
              readMembers: [["a"]],
            },
            { kind: "esm-reexport-star", target: "target" },
          ],
          events: [],
        },
        { id: "target", format: "esm", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "target" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } as unknown as ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      "modules[0].dependencies[0]: CJS modules cannot use esm-namespace-import",
      "modules[0].dependencies[1]: CJS modules cannot use esm-reexport-star",
    ]);
  });

  test("rejects event reads that do not resolve to a readable binding", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "source",
              importedName: "v",
              localName: "sourceValue",
            },
          ],
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 0,
              reads: [
                { binding: "missing" },
                { binding: "sourceValue", memberPath: ["notAMember"] },
              ],
            },
            {
              module: "entry",
              phase: "evaluate",
              value: "not-a-number",
              reads: [{ binding: "sourceValue" }],
            },
          ],
        },
        {
          id: "source",
          format: "esm",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[0].events[0].reads[0].binding: unknown readable binding "missing" in this module',
      'modules[0].events[0].reads[1].memberPath: expected no member for binding "sourceValue", received "notAMember"',
      "modules[0].events[1].value: expected a finite JSON number when the event carries reads",
    ]);
  });

  test("rejects a require read with the wrong member", () => {
    const program = {
      modules: [
        {
          id: "reader",
          format: "cjs",
          dependencies: [
            {
              kind: "cjs-require",
              target: "target",
              resultBinding: "targetExports",
              readName: "vt",
            },
          ],
          events: [
            {
              module: "reader",
              phase: "evaluate",
              value: 0,
              reads: [{ binding: "targetExports" }],
            },
          ],
        },
        { id: "target", format: "cjs", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "reader" }],
      schedule: [{ kind: "require-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[0].events[0].reads[0].memberPath: expected "vt" for binding "targetExports", received no member',
    ]);
  });

  test("rejects colliding readable bindings and unpaired readable-require fields", () => {
    const program = {
      modules: [
        {
          id: "reader",
          format: "cjs",
          dependencies: [
            {
              kind: "cjs-require",
              target: "first",
              resultBinding: "shared",
              readName: "a",
            },
            {
              kind: "cjs-require",
              target: "second",
              resultBinding: "shared",
              readName: "b",
            },
            { kind: "cjs-require", target: "third", resultBinding: "other" },
          ],
          events: [],
        },
        { id: "first", format: "cjs", dependencies: [], events: [] },
        { id: "second", format: "cjs", dependencies: [], events: [] },
        { id: "third", format: "cjs", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "reader" }],
      schedule: [{ kind: "require-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[0].dependencies[1].resultBinding: duplicate module local binding "shared"',
      "modules[0].dependencies[2]: resultBinding and readName must be set together on a readable require",
    ]);
  });

  test("rejects triggering a dynamic import before its owner is evaluated", () => {
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
          events: [],
        },
        {
          id: "lazy",
          format: "esm",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [
        { kind: "trigger-dynamic-import", registration: "load-lazy" },
        { kind: "import-entry", entry: "main" },
      ],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'schedule[0].registration: dynamic import registration "load-lazy" is unavailable before module "entry" is evaluated',
    ]);
  });

  test("makes registrations available through static and require dependencies", () => {
    const program = {
      modules: [
        {
          id: "cjs-entry",
          format: "cjs",
          dependencies: [{ kind: "cjs-require", target: "esm-carrier" }],
          events: [],
        },
        {
          id: "esm-carrier",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "registration-owner" }],
          events: [],
        },
        {
          id: "registration-owner",
          format: "esm",
          dependencies: [
            {
              kind: "esm-dynamic-import",
              target: "lazy",
              registration: "load-lazy",
            },
          ],
          events: [],
        },
        {
          id: "lazy",
          format: "esm",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "cjs-entry" }],
      schedule: [
        { kind: "require-entry", entry: "main" },
        { kind: "trigger-dynamic-import", registration: "load-lazy" },
      ],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
  });

  test("treats an awaited trigger's dynamic subtree as evaluated", () => {
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
          events: [],
        },
        {
          id: "lazy",
          format: "esm",
          dependencies: [
            {
              kind: "esm-dynamic-import",
              target: "nested",
              registration: "load-nested",
            },
          ],
          events: [],
        },
        {
          id: "nested",
          format: "esm",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [
        { kind: "import-entry", entry: "main" },
        { kind: "trigger-dynamic-import", registration: "load-lazy" },
        { kind: "trigger-dynamic-import", registration: "load-nested" },
      ],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);

    const nestedBeforeParent = {
      ...program,
      schedule: [
        { kind: "import-entry", entry: "main" },
        { kind: "trigger-dynamic-import", registration: "load-nested" },
        { kind: "trigger-dynamic-import", registration: "load-lazy" },
      ],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(nestedBeforeParent))).toEqual([
      'schedule[1].registration: dynamic import registration "load-nested" is unavailable before module "lazy" is evaluated',
    ]);
  });

  test("rejects invalid ESM imported and local identifiers", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "value",
              importedName: "not-valid",
              localName: "first",
            },
            {
              kind: "esm-value-import",
              target: "value",
              importedName: "value",
              localName: "not-valid",
            },
            {
              kind: "esm-value-import",
              target: "value",
              importedName: "value",
              localName: "await",
            },
          ],
          events: [],
        },
        {
          id: "value",
          format: "esm",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[0].dependencies[0].importedName: invalid JavaScript identifier "not-valid"',
      'modules[0].dependencies[1].localName: invalid JavaScript binding identifier "not-valid"',
      'modules[0].dependencies[2].localName: invalid JavaScript binding identifier "await"',
    ]);
  });

  test("rejects duplicate ESM local bindings", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "first",
              importedName: "value",
              localName: "shared",
            },
            {
              kind: "esm-value-import",
              target: "second",
              importedName: "value",
              localName: "shared",
            },
          ],
          events: [],
        },
        {
          id: "first",
          format: "esm",
          dependencies: [],
          events: [],
        },
        {
          id: "second",
          format: "esm",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[0].dependencies[1].localName: duplicate module local binding "shared"',
    ]);
  });

  test("allows keyword export names with valid local bindings", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "value",
              importedName: "default",
              localName: "defaultValue",
            },
          ],
          events: [],
        },
        {
          id: "value",
          format: "esm",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
  });

  test("rejects dangling dependency targets", () => {
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

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[0].dependencies[0].target: unknown module id "missing"',
    ]);
  });

  test("rejects duplicate module IDs", () => {
    const program = {
      modules: [
        {
          id: "duplicate",
          format: "esm",
          dependencies: [],
          events: [],
        },
        {
          id: "duplicate",
          format: "cjs",
          dependencies: [],
          events: [],
        },
      ],
      entries: [],
      schedule: [],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[1].id: duplicate module id "duplicate"',
    ]);
  });

  test("rejects entries that reference missing modules", () => {
    const program = {
      modules: [],
      entries: [{ name: "main", moduleId: "missing" }],
      schedule: [],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'entries[0].moduleId: unknown module id "missing"',
    ]);
  });

  test("rejects requiring an ESM module marked with top-level await", () => {
    const program = {
      modules: [
        {
          id: "cjs-entry",
          format: "cjs",
          dependencies: [{ kind: "cjs-require", target: "async-esm" }],
          events: [],
        },
        {
          id: "async-esm",
          format: "esm",
          dependencies: [],
          events: [],
          hasTopLevelAwait: true,
        },
      ],
      entries: [{ name: "main", moduleId: "cjs-entry" }],
      schedule: [{ kind: "require-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[0].dependencies[0]: cannot require ESM module "async-esm" because it has top-level await',
    ]);
  });

  test("rejects requiring an ESM graph containing top-level await", () => {
    const program = {
      modules: [
        {
          id: "cjs-entry",
          format: "cjs",
          dependencies: [{ kind: "cjs-require", target: "esm-wrapper" }],
          events: [],
        },
        {
          id: "esm-wrapper",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "async-esm" }],
          events: [],
        },
        {
          id: "async-esm",
          format: "esm",
          dependencies: [],
          events: [],
          hasTopLevelAwait: true,
        },
      ],
      entries: [{ name: "main", moduleId: "cjs-entry" }],
      schedule: [{ kind: "require-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[0].dependencies[0]: cannot require ESM module "esm-wrapper" because it has top-level await',
    ]);
  });

  test(
    "validates a 10,000-module TLA chain without recursive overflow",
    { timeout: 10_000 },
    () => {
      const chainLength = 10_000;
      const modules: ModuleModel[] = [
        {
          id: "cjs-entry",
          format: "cjs",
          dependencies: [{ kind: "cjs-require", target: "esm-0" }],
          events: [],
        },
      ];

      for (let index = 0; index < chainLength; index += 1) {
        const isLastModule = index === chainLength - 1;
        modules.push({
          id: `esm-${index}`,
          format: "esm",
          dependencies: isLastModule
            ? []
            : [
                {
                  kind: "esm-side-effect-import",
                  target: `esm-${index + 1}`,
                },
              ],
          events: [],
          ...(isLastModule ? { hasTopLevelAwait: true as const } : {}),
        });
      }

      const program = {
        modules,
        entries: [{ name: "main", moduleId: "cjs-entry" }],
        schedule: [{ kind: "require-entry", entry: "main" }],
      } satisfies ProgramModel;

      expect(validateProgramModel(analyzeProgram(program))).toEqual([
        'modules[0].dependencies[0]: cannot require ESM module "esm-0" because it has top-level await',
      ]);
    },
  );

  test("rejects non-finite event numbers", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [],
          events: [
            { module: "entry", phase: "evaluate", value: Number.NaN },
            { module: "entry", phase: "evaluate", value: Number.POSITIVE_INFINITY },
          ],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      "modules[0].events[0].value: expected a finite JSON number",
      "modules[0].events[1].value: expected a finite JSON number",
    ]);
  });

  test("rejects events attributed to a different module", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [],
          events: [{ module: "other", phase: "evaluate", value: 1 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[0].events[0].module: expected containing module id "entry", received "other"',
    ]);
  });

  test("returns multiple validation errors in model order", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "missing-dependency" }],
          events: [],
        },
        {
          id: "entry",
          format: "cjs",
          dependencies: [],
          events: [],
        },
      ],
      entries: [{ name: "main", moduleId: "missing-entry" }],
      schedule: [],
    } satisfies ProgramModel;

    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[1].id: duplicate module id "entry"',
      'modules[0].dependencies[0].target: unknown module id "missing-dependency"',
      'entries[0].moduleId: unknown module id "missing-entry"',
    ]);
  });

  test("accepts Node-legal cycle value flow: hoisted calls (ESM) and guarded partial reads (CJS)", () => {
    const esmCycle = {
      modules: [
        {
          id: "a",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "b",
              importedName: "fb",
              localName: "a_fb",
              call: true,
            },
          ],
          events: [
            { module: "a", phase: "evaluate", value: 1, reads: [{ binding: "a_fb", call: true }] },
          ],
        },
        {
          id: "b",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "a",
              importedName: "fa",
              localName: "b_fa",
              call: true,
            },
          ],
          events: [
            { module: "b", phase: "evaluate", value: 2, reads: [{ binding: "b_fa", call: true }] },
          ],
        },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(esmCycle))).toEqual([]);

    const cjsCycle = {
      modules: [
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
              value: 1,
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
              value: 2,
              reads: [{ binding: "b_a", memberPath: ["va"], guard: true }],
            },
          ],
        },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "require-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(cjsCycle))).toEqual([]);
  });

  test("rejects unsound cycle reads: plain value/namespace closing a cycle, unguarded partial require, call to CJS", () => {
    const plainValueCycle = {
      modules: [
        {
          id: "a",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "b", importedName: "vb", localName: "a_vb" },
          ],
          events: [{ module: "a", phase: "evaluate", value: 1, reads: [{ binding: "a_vb" }] }],
        },
        {
          id: "b",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "a",
              importedName: "fa",
              localName: "b_fa",
              call: true,
            },
          ],
          events: [
            { module: "b", phase: "evaluate", value: 2, reads: [{ binding: "b_fa", call: true }] },
          ],
        },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(plainValueCycle))).toEqual([
      "modules[0].dependencies[0]: an ESM value import that closes a cycle must be a hoisted-function call import (call: true) to avoid TDZ",
    ]);

    const namespaceCycle = {
      modules: [
        {
          id: "a",
          format: "esm",
          dependencies: [
            { kind: "esm-namespace-import", target: "b", localName: "a_ns", readMembers: [["vb"]] },
          ],
          events: [
            {
              module: "a",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "a_ns", memberPath: ["vb"] }],
            },
          ],
        },
        {
          id: "b",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "a" }],
          events: [{ module: "b", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(namespaceCycle))).toEqual([
      "modules[0].dependencies[0]: an ESM namespace import cannot close a cycle; a member read would hit TDZ",
    ]);

    const unguardedCycle = {
      modules: [
        {
          id: "a",
          format: "cjs",
          dependencies: [
            { kind: "cjs-require", target: "b", resultBinding: "a_b", readName: "vb" },
          ],
          events: [
            {
              module: "a",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "a_b", memberPath: ["vb"] }],
            },
          ],
        },
        {
          id: "b",
          format: "cjs",
          dependencies: [{ kind: "cjs-require", target: "a" }],
          events: [{ module: "b", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "require-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(unguardedCycle))).toEqual([
      "modules[0].dependencies[0]: a readable require that closes a cycle must be guarded (guard: true) so a partial export folds to a sentinel instead of NaN",
    ]);

    const callToCjs = {
      modules: [
        {
          id: "a",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "b",
              importedName: "fb",
              localName: "a_fb",
              call: true,
            },
          ],
          events: [
            { module: "a", phase: "evaluate", value: 1, reads: [{ binding: "a_fb", call: true }] },
          ],
        },
        {
          id: "b",
          format: "cjs",
          dependencies: [],
          events: [{ module: "b", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(callToCjs))).toEqual([
      'modules[0].dependencies[0]: a hoisted-function call import must target an ESM module, target "b" is cjs',
      // The plan (finding 3) also rejects the call itself: a CJS definer renders numeric exports only, so
      // `fb` is a `value`, not a callable — calling it is a TypeError, not a witness.
      'export "fb" on "b": called consumed by module "a" (demand "fb" on "b") but the definer renders a value — a call must reach a callable-own-state definer or a directly call-marked export',
    ]);
  });

  test("permits an ESM {side-effect + value + dynamic} multi-kind pair to one target", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-side-effect-import", target: "target" },
            { kind: "esm-value-import", target: "target", importedName: "v", localName: "tv" },
            { kind: "esm-dynamic-import", target: "target", registration: "load-target" },
          ],
          events: [{ module: "entry", phase: "evaluate", value: 1, reads: [{ binding: "tv" }] }],
        },
        {
          id: "target",
          format: "esm",
          dependencies: [],
          events: [{ module: "target", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
  });

  test("permits a CJS {require + dynamic} multi-kind pair to one target", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "cjs",
          dependencies: [
            { kind: "cjs-require", target: "target", resultBinding: "t", readName: "v" },
            { kind: "esm-dynamic-import", target: "target", registration: "load-target" },
          ],
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "t", memberPath: ["v"] }],
            },
          ],
        },
        {
          id: "target",
          format: "esm",
          dependencies: [],
          events: [{ module: "target", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "require-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
  });

  test("permits repeated value imports for one pair (two named imports)", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "t", importedName: "a", localName: "la" },
            { kind: "esm-value-import", target: "t", importedName: "b", localName: "lb" },
          ],
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "la" }, { binding: "lb" }],
            },
          ],
        },
        {
          id: "t",
          format: "esm",
          dependencies: [],
          events: [{ module: "t", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
  });

  test("rejects a second side-effect import for one pair", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-side-effect-import", target: "t" },
            { kind: "esm-side-effect-import", target: "t" },
          ],
          events: [],
        },
        { id: "t", format: "esm", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[0].dependencies[1]: a (importer, target) pair to "t" may carry at most one side-effect dependency',
    ]);
  });

  test("rejects a second dynamic registration for one pair", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [
            { kind: "esm-dynamic-import", target: "t", registration: "r0" },
            { kind: "esm-dynamic-import", target: "t", registration: "r1" },
          ],
          events: [],
        },
        { id: "t", format: "esm", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[0].dependencies[1]: a (importer, target) pair to "t" may carry at most one dynamic dependency',
    ]);
  });

  // Finding 1 (capture/export-demand analyzer): tightenings that close contract gaps the direct-target
  // checks missed. Each rejects a crafted illegal model; the generated corpus is unaffected (a 6000-case
  // sweep validates clean), proving these only exclude hand-crafted / drifted models.

  test("rejects an event read whose call/guard disagrees with its binding's capability", () => {
    // A plain (numeric) value import read AS A CALL would invoke a number.
    const callingANumber = {
      modules: [
        {
          id: "a",
          format: "esm",
          dependencies: [
            { kind: "esm-value-import", target: "b", importedName: "vb", localName: "a_vb" },
          ],
          events: [
            { module: "a", phase: "evaluate", value: 1, reads: [{ binding: "a_vb", call: true }] },
          ],
        },
        {
          id: "b",
          format: "esm",
          dependencies: [],
          events: [{ module: "b", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(callingANumber))).toEqual([
      'modules[0].events[0].reads[0].call: read of "a_vb" must not be a call to match its binding\'s capability',
    ]);

    // A hoisted-function CALL import read WITHOUT a call folds the function's source text into a number.
    const foldingFunctionSource = {
      modules: [
        {
          id: "a",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "b",
              importedName: "fb",
              localName: "a_fb",
              call: true,
            },
          ],
          events: [{ module: "a", phase: "evaluate", value: 1, reads: [{ binding: "a_fb" }] }],
        },
        {
          id: "b",
          format: "esm",
          dependencies: [],
          events: [{ module: "b", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(foldingFunctionSource))).toEqual([
      'modules[0].events[0].reads[0].call: read of "a_fb" must be a call (call: true) to match its binding\'s capability',
    ]);
  });

  test("rejects a callable-own-state export consumed as a plain fold through a barrel", () => {
    const program = {
      modules: [
        {
          id: "consumer",
          format: "esm",
          dependencies: [
            // A namespace import of the BARREL (not the definer), reading the forwarded member
            // WITHOUT marking it callable — the direct-target check never sees the definer.
            {
              kind: "esm-namespace-import",
              target: "barrel",
              localName: "ns",
              readMembers: [["vdef"]],
            },
          ],
          events: [],
        },
        {
          id: "barrel",
          format: "esm",
          dependencies: [{ kind: "esm-reexport-star", target: "def" }],
          events: [],
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
    // The plan resolves the member through the star barrel to the callable-own-state definer and rejects
    // the numeric fold — the definer renders a function, so folding its member concatenates source text.
    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'export "vdef" on "def": folded numerically consumed by module "consumer" (demand "vdef" on "barrel") but the definer renders a function; folding a function (a function\'s source text or an object) is unsound',
    ]);
  });

  test("rejects a call import of an object-export module", () => {
    const program = {
      modules: [
        {
          id: "consumer",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "obj",
              importedName: "vobj",
              localName: "o",
              call: true,
            },
          ],
          events: [
            {
              module: "consumer",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "o", call: true }],
            },
          ],
        },
        { id: "obj", format: "esm", dependencies: [], events: [], objectExport: true },
      ],
      entries: [{ name: "main", moduleId: "consumer" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    // The plan rejects the call: an object-export definer renders an object literal, not a function, so
    // calling it is a TypeError — a call must reach a callable-own-state or directly call-marked export.
    expect(validateProgramModel(analyzeProgram(program))).toContain(
      'export "vobj" on "obj": called consumed by module "consumer" (demand "vobj" on "obj") but the definer renders a object — a call must reach a callable-own-state definer or a directly call-marked export',
    );
  });

  test("rejects a readable require reading default from a CJS module", () => {
    const program = {
      modules: [
        {
          id: "a",
          format: "cjs",
          dependencies: [
            { kind: "cjs-require", target: "b", resultBinding: "r", readName: "default" },
          ],
          events: [
            {
              module: "a",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "r", memberPath: ["default"] }],
            },
          ],
        },
        {
          id: "b",
          format: "cjs",
          dependencies: [],
          events: [{ module: "b", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "require-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toContain(
      'modules[0].dependencies[0]: a readable require cannot read "default" from CJS module "b"; a CommonJS provider supplies no default property',
    );
  });

  test("rejects a duplicate named re-export of the same exportedName regardless of origin (finding 6)", () => {
    const program = {
      modules: [
        {
          id: "barrel",
          format: "esm",
          dependencies: [
            { kind: "esm-reexport-named", target: "def", sourceName: "vx", exportedName: "shared" },
            // A SECOND explicit re-export of the SAME exported name — even resolving to the SAME origin
            // `def`, this renders `export { … as shared }` twice, a Node SyntaxError (Duplicate export of
            // 'shared'). resolveExportRoute dedups by origin, so only a structural check catches it.
            { kind: "esm-reexport-named", target: "def", sourceName: "vx", exportedName: "shared" },
          ],
          events: [],
        },
        {
          id: "def",
          format: "esm",
          dependencies: [],
          events: [{ module: "def", phase: "evaluate", value: 1 }],
        },
      ],
      entries: [{ name: "main", moduleId: "barrel" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'modules[0].dependencies[1].exportedName: duplicate named re-export of "shared"; a module may export a name at most once (Node: Duplicate export)',
    ]);
  });

  // Program-level export-demand rules (finding 2), read from the canonical ExportDemandPlan. Each
  // rejects a hand-crafted model the direct-target capability walk cannot see; the generator produces
  // none of them (proven by the 6000-case validate sweep).
  describe("program-level export demand", () => {
    const leaf = (id: string): ModuleModel => ({
      id,
      format: "esm",
      dependencies: [],
      events: [{ module: id, phase: "evaluate", value: 5 }],
    });

    test("rejects a default import through a star-only barrel (unsupplied — star never forwards default)", () => {
      const program = {
        modules: [
          {
            id: "consumer",
            format: "esm",
            dependencies: [
              {
                kind: "esm-value-import",
                target: "barrel",
                importedName: "default",
                localName: "d",
              },
            ],
            events: [],
          },
          {
            id: "barrel",
            format: "esm",
            dependencies: [{ kind: "esm-reexport-star", target: "def" }],
            events: [],
          },
          leaf("def"),
        ],
        entries: [{ name: "main", moduleId: "consumer" }],
        schedule: [{ kind: "import-entry", entry: "main" }],
      } satisfies ProgramModel;
      expect(
        validateProgramModel(analyzeProgram(program)).some((error) => error.includes("unsupplied")),
      ).toBe(true);
      // Invariant behind build-failure:link — an unsupplied model is rejected BEFORE build: renderProgram
      // validates first and throws, so the plan's supply-status validation guarantees a generated model
      // can never reach Rolldown with an unresolvable export (a model-caused link failure). A
      // build-failure:link is therefore always a genuine Rolldown linker bug, never the fuzzer's own model.
      expect(() => renderProgram(analyzeProgram(program))).toThrow(/Cannot render invalid program/);
    });

    test("rejects a named re-export of default through a star-only barrel (link-required, unsupplied)", () => {
      // The model-authored MISSING_EXPORT channel W14a.1 closes: `export { default as x } from` a star-only
      // barrel. The named re-export demands `default` on the barrel; a star never forwards `default` and a
      // barrel carrying a star synthesizes nothing local, so the demand is unsupplied. Named re-exports are
      // now LINK-REQUIRED demands on the ONE plan (checked for supply), so this fails validation — before,
      // named re-exports were omitted from the plan, so the invalid source reached Rolldown and link-errored
      // (a model-authored `build-failure:link` false positive). The fixpoint no longer forwards `default`
      // through the star either, agreeing with the supply rule.
      const program = {
        modules: [
          {
            id: "facade",
            format: "esm",
            dependencies: [
              {
                kind: "esm-reexport-named",
                target: "barrel",
                sourceName: "default",
                exportedName: "x",
              },
            ],
            events: [],
          },
          {
            id: "barrel",
            format: "esm",
            dependencies: [{ kind: "esm-reexport-star", target: "def" }],
            events: [],
          },
          leaf("def"),
        ],
        entries: [{ name: "main", moduleId: "facade" }],
        schedule: [{ kind: "import-entry", entry: "main" }],
      } satisfies ProgramModel;
      expect(
        validateProgramModel(analyzeProgram(program)).some((error) => error.includes("unsupplied")),
      ).toBe(true);
      expect(() => renderProgram(analyzeProgram(program))).toThrow(/Cannot render invalid program/);
    });

    test("rejects a name provided by two star re-exports (ambiguous)", () => {
      const program = {
        modules: [
          {
            id: "consumer",
            format: "esm",
            dependencies: [
              { kind: "esm-value-import", target: "barrel", importedName: "vx", localName: "x" },
            ],
            events: [],
          },
          {
            id: "barrel",
            format: "esm",
            dependencies: [
              { kind: "esm-reexport-star", target: "A" },
              { kind: "esm-reexport-star", target: "B" },
            ],
            events: [],
          },
          leaf("A"),
          leaf("B"),
        ],
        entries: [{ name: "main", moduleId: "consumer" }],
        schedule: [{ kind: "import-entry", entry: "main" }],
      } satisfies ProgramModel;
      expect(
        validateProgramModel(analyzeProgram(program)).some((error) => error.includes("ambiguous")),
      ).toBe(true);
    });

    test("rejects one numeric export consumed as BOTH a call and a plain fold (incompatible shapes)", () => {
      const program = {
        modules: [
          {
            id: "caller",
            format: "esm",
            dependencies: [
              {
                kind: "esm-value-import",
                target: "def",
                importedName: "vx",
                localName: "c",
                call: true,
              },
            ],
            events: [
              {
                module: "caller",
                phase: "evaluate",
                value: 1,
                reads: [{ binding: "c", call: true }],
              },
            ],
          },
          {
            id: "folder",
            format: "esm",
            dependencies: [
              { kind: "esm-value-import", target: "def", importedName: "vx", localName: "f" },
            ],
            events: [{ module: "folder", phase: "evaluate", value: 2, reads: [{ binding: "f" }] }],
          },
          leaf("def"),
        ],
        entries: [
          { name: "c", moduleId: "caller" },
          { name: "f", moduleId: "folder" },
        ],
        schedule: [
          { kind: "import-entry", entry: "c" },
          { kind: "import-entry", entry: "f" },
        ],
      } satisfies ProgramModel;
      // The direct-target capability walk sees a plain numeric definer for BOTH consumers and passes;
      // only the whole-program aggregation catches the conflict.
      expect(
        validateProgramModel(analyzeProgram(program)).some((error) =>
          error.includes("incompatible consumption"),
        ),
      ).toBe(true);
    });

    test("rejects a call routed through a barrel to a numeric definer (callability not forwarded)", () => {
      const program = {
        modules: [
          {
            id: "consumer",
            format: "esm",
            dependencies: [
              {
                kind: "esm-namespace-import",
                target: "barrel",
                localName: "ns",
                readMembers: [["vx"]],
                callMembers: ["vx"],
              },
            ],
            events: [
              {
                module: "consumer",
                phase: "evaluate",
                value: 1,
                reads: [{ binding: "ns", memberPath: ["vx"], call: true }],
              },
            ],
          },
          {
            id: "barrel",
            format: "esm",
            dependencies: [{ kind: "esm-reexport-star", target: "def" }],
            events: [],
          },
          leaf("def"),
        ],
        entries: [{ name: "main", moduleId: "consumer" }],
        schedule: [{ kind: "import-entry", entry: "main" }],
      } satisfies ProgramModel;
      expect(
        validateProgramModel(analyzeProgram(program)).some((error) =>
          error.includes("callability is not forwarded through a barrel"),
        ),
      ).toBe(true);
    });

    // The two degenerate crash models finding 3 closes: the plan's rendered form is now the SOLE dispatch,
    // so an inferred-pure-numeric and a CJS-numeric definer stay `value` and a callable consumption of one
    // is REJECTED at validation instead of rendering a const/`exports.x = 5` the caller then invokes
    // (a `TypeError: x is not a function` — a degenerate both-sides crash). Reproduced with /tmp probes.
    test("rejects a DIRECT call import of an inferred-pure numeric definer (finding 3a)", () => {
      const program = {
        modules: [
          {
            id: "consumer",
            format: "esm",
            dependencies: [
              {
                kind: "esm-value-import",
                target: "pure",
                importedName: "vp",
                localName: "p",
                call: true,
              },
            ],
            events: [
              {
                module: "consumer",
                phase: "evaluate",
                value: 1,
                reads: [{ binding: "p", call: true }],
              },
            ],
          },
          // An inferred-pure definer renders `vp` as a non-inlinable `const`, never a callable.
          {
            id: "pure",
            format: "esm",
            dependencies: [],
            events: [],
            inferredPure: true,
            pureBase: 42,
          },
        ],
        entries: [{ name: "main", moduleId: "consumer" }],
        schedule: [{ kind: "import-entry", entry: "main" }],
      } satisfies ProgramModel;
      expect(validateProgramModel(analyzeProgram(program))).toContain(
        'export "vp" on "pure": called consumed by module "consumer" (demand "vp" on "pure") but the definer renders a value — a call must reach a callable-own-state definer or a directly call-marked export',
      );
    });

    test("rejects namespace callMembers against a numeric CJS definer (finding 3b)", () => {
      const program = {
        modules: [
          {
            id: "consumer",
            format: "esm",
            dependencies: [
              {
                kind: "esm-namespace-import",
                target: "cjsdef",
                localName: "ns",
                readMembers: [["vx"]],
                callMembers: ["vx"],
              },
            ],
            events: [
              {
                module: "consumer",
                phase: "evaluate",
                value: 1,
                reads: [{ binding: "ns", memberPath: ["vx"], call: true }],
              },
            ],
          },
          // A CJS definer renders `exports.vx = <number>` — a value, never a callable function.
          {
            id: "cjsdef",
            format: "cjs",
            dependencies: [],
            events: [{ module: "cjsdef", phase: "evaluate", value: 5 }],
          },
        ],
        entries: [{ name: "main", moduleId: "consumer" }],
        schedule: [{ kind: "import-entry", entry: "main" }],
      } satisfies ProgramModel;
      expect(validateProgramModel(analyzeProgram(program))).toContain(
        'export "vx" on "cjsdef": called consumed by module "consumer" (demand "vx" on "cjsdef") but the definer renders a value — a call must reach a callable-own-state definer or a directly call-marked export',
      );
    });

    // A compact table over origin profile x consumption shape on a DIRECT edge: the plan's rendered-form
    // must agree with each consumer's shape. Sound rows validate; unsound rows are rejected (by the
    // capability walk or the plan). The route axis is covered by the crafted tests above.
    const definerOf = (kind: "numeric" | "callable" | "object"): ModuleModel =>
      kind === "callable"
        ? {
            id: "def",
            format: "esm",
            dependencies: [],
            events: [{ module: "def", phase: "evaluate", value: 4 }],
            callableOwnState: true,
          }
        : kind === "object"
          ? { id: "def", format: "esm", dependencies: [], events: [], objectExport: true }
          : {
              id: "def",
              format: "esm",
              dependencies: [],
              events: [{ module: "def", phase: "evaluate", value: 4 }],
            };

    const rows: {
      readonly origin: "numeric" | "callable" | "object";
      readonly shape: "fold" | "call" | "objectRef";
      readonly sound: boolean;
    }[] = [
      { origin: "numeric", shape: "fold", sound: true },
      { origin: "numeric", shape: "call", sound: true },
      { origin: "callable", shape: "call", sound: true },
      { origin: "object", shape: "objectRef", sound: true },
      { origin: "callable", shape: "fold", sound: false },
      { origin: "object", shape: "fold", sound: false },
      { origin: "object", shape: "call", sound: false },
    ];

    for (const { origin, shape, sound } of rows) {
      test(`${origin} definer consumed by ${shape} is ${sound ? "accepted" : "rejected"}`, () => {
        const dep =
          shape === "call"
            ? {
                kind: "esm-value-import" as const,
                target: "def",
                importedName: "vx",
                localName: "l",
                call: true as const,
              }
            : shape === "objectRef"
              ? {
                  kind: "esm-value-import" as const,
                  target: "def",
                  importedName: "vx",
                  localName: "l",
                  objectRef: true as const,
                }
              : {
                  kind: "esm-value-import" as const,
                  target: "def",
                  importedName: "vx",
                  localName: "l",
                };
        const event =
          shape === "objectRef"
            ? {
                module: "consumer",
                phase: "evaluate",
                value: 1,
                identityCheck: { leftBinding: "l", rightBinding: "l" },
              }
            : {
                module: "consumer",
                phase: "evaluate",
                value: 1,
                reads: [
                  shape === "call" ? { binding: "l", call: true as const } : { binding: "l" },
                ],
              };
        const program = {
          modules: [
            { id: "consumer", format: "esm", dependencies: [dep], events: [event] },
            definerOf(origin),
          ],
          entries: [{ name: "main", moduleId: "consumer" }],
          schedule: [{ kind: "import-entry", entry: "main" }],
        } satisfies ProgramModel;
        expect(validateProgramModel(analyzeProgram(program)).length === 0).toBe(sound);
      });
    }
  });

  test("rejects an object-identity check comparing captures of DIFFERENT objects", () => {
    const program = {
      modules: [
        {
          id: "consumer",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "obj1",
              importedName: "vobj1",
              localName: "l",
              objectRef: true,
            },
            {
              kind: "esm-value-import",
              target: "obj2",
              importedName: "vobj2",
              localName: "r",
              objectRef: true,
            },
          ],
          events: [
            {
              module: "consumer",
              phase: "evaluate",
              value: 1,
              identityCheck: { leftBinding: "l", rightBinding: "r" },
            },
          ],
        },
        { id: "obj1", format: "esm", dependencies: [], events: [], objectExport: true },
        { id: "obj2", format: "esm", dependencies: [], events: [], objectExport: true },
      ],
      entries: [{ name: "main", moduleId: "consumer" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      "modules[0].events[0].identityCheck: leftBinding and rightBinding must capture the SAME object export; they resolve to different origins",
    ]);
  });

  test("rejects a synchronous cycle that mixes ESM and CJS members", () => {
    const program = {
      modules: [
        {
          id: "a",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "b" }],
          events: [{ module: "a", phase: "evaluate", value: 1 }],
        },
        {
          id: "b",
          format: "cjs",
          dependencies: [{ kind: "cjs-require", target: "a" }],
          events: [{ module: "b", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      'synchronous cycle {"a", "b"} mixes module formats (cjs, esm); a mixed-format cycle is Node-illegal',
    ]);
  });

  // Finding 5 (module-profile normalization): metadata purity and callable-own-state are incompatible.
  test("rejects a module that is both sideEffectFree and callableOwnState", () => {
    const program = {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [],
          events: [{ module: "entry", phase: "evaluate", value: 1 }],
        },
        {
          id: "flagged",
          format: "esm",
          dependencies: [],
          events: [],
          sideEffectFree: true,
          callableOwnState: true,
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(analyzeProgram(program))).toEqual([
      "modules[1]: a metadata-pure package member cannot be callableOwnState; a legal DCE may drop the state a callable-own-state export reads",
    ]);
  });
});

describe("organic chunk groups (wave 6)", () => {
  function baseProgram(): ProgramModel {
    return {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "leaf" }],
          events: [{ module: "entry", phase: "evaluate", value: 1 }],
        },
        {
          id: "leaf",
          format: "esm",
          dependencies: [],
          events: [{ module: "leaf", phase: "evaluate", value: 2 }],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    };
  }

  test("accepts and round-trips a program carrying organic chunk groups", () => {
    const program: ProgramModel = {
      ...baseProgram(),
      organicChunkGroups: [
        {
          name: "organic-vendor",
          test: "\\.mjs$",
          minShareCount: 2,
          maxSize: 800,
          priority: 1,
          includeDependenciesRecursively: false,
        },
        { name: "organic-sized", minShareCount: 1, minSize: 128 },
      ],
    };
    expect(validateProgramModel(analyzeProgram(program))).toEqual([]);
    // Serialize -> parse -> identical, and still valid (byte-identical replay through model.json).
    const roundTripped = JSON.parse(JSON.stringify(program)) as ProgramModel;
    expect(roundTripped).toEqual(program);
    expect(JSON.stringify(roundTripped)).toBe(JSON.stringify(program));
    expect(validateProgramModel(analyzeProgram(roundTripped))).toEqual([]);
  });

  test("rejects carrying both manual and organic chunk groups", () => {
    const program: ProgramModel = {
      ...baseProgram(),
      manualChunkGroups: [{ name: "manual", moduleIds: ["leaf"] }],
      organicChunkGroups: [{ name: "organic", minShareCount: 1 }],
    };
    expect(validateProgramModel(analyzeProgram(program))).toContain(
      "a program may carry either manualChunkGroups or organicChunkGroups, not both",
    );
  });

  test("rejects invalid organic group fields", () => {
    const program: ProgramModel = {
      ...baseProgram(),
      organicChunkGroups: [{ name: "dup" }, { name: "dup", test: "([unclosed", minShareCount: -1 }],
    };
    const errors = validateProgramModel(analyzeProgram(program));
    expect(errors).toContain('organicChunkGroups[1].name: duplicate group name "dup"');
    expect(errors).toContain(
      'organicChunkGroups[1].test: invalid regular-expression source "([unclosed"',
    );
    expect(errors).toContain(
      "organicChunkGroups[1].minShareCount: must be a finite non-negative number",
    );
  });
});

describe("persisted BuildConfig (W14a, schema 17)", () => {
  function baseModules(): ProgramModel {
    return {
      modules: [
        {
          id: "entry",
          format: "esm",
          dependencies: [{ kind: "esm-side-effect-import", target: "leaf" }],
          events: [{ module: "entry", phase: "evaluate", value: 1 }],
        },
        { id: "leaf", format: "esm", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    };
  }

  const build: BuildConfig = {
    chunking: { kind: "manual", groups: [{ name: "g", moduleIds: ["leaf"] }] },
    includeDependenciesRecursively: false,
    preserveEntrySignatures: "allow-extension",
    lazyBarrel: true,
    strictExecutionOrder: true,
    outputFormat: "esm",
    minify: false,
  };

  test("buildConfigOf returns the persisted build when present", () => {
    const program: ProgramModel = { ...baseModules(), build };
    // `buildConfigOf` NORMALIZES a persisted build (filling any missing FW-A/W12 axis with its default),
    // so a fully-populated config comes back deep-EQUAL — not the same reference — to what was persisted.
    expect(buildConfigOf(program)).toStrictEqual(build);
    expect(programChunking(program)).toEqual({
      kind: "manual",
      groups: [{ name: "g", moduleIds: ["leaf"] }],
    });
  });

  test("buildConfigOf defaults a pre-W12 persisted build's missing minify axis to false", () => {
    // A persisted `build` predating the W12 minify axis (and the FW-A output-format axis) carries neither
    // key; the reader defaults each to its historical fixed value so an old artifact still replays.
    const legacyBuild = {
      chunking: { kind: "automatic" },
      includeDependenciesRecursively: true,
      preserveEntrySignatures: "allow-extension",
      lazyBarrel: false,
      strictExecutionOrder: true,
    };
    const program = {
      ...baseModules(),
      build: legacyBuild,
    } as unknown as ProgramModel;
    const resolved = buildConfigOf(program);
    expect(resolved.minify).toBe(false);
    expect(resolved.outputFormat).toBe("esm");
  });

  test("buildConfigOf derives a v16 program's config: legacy manual resolves IDR to false (W14a.1)", () => {
    // A legacy (schema-16) artifact carries top-level chunk arrays and NO `build`; the reader resolves it
    // to defaults + the derived chunking, so an old artifact still replays. A legacy MANUAL-group artifact
    // historically built with the per-group `includeDependenciesRecursively: false` the child hardcoded on
    // every manual group (W14a.1 made that value the persisted single source), so its resolved global is
    // `false` — NOT the rolldown default `true` in DEFAULT_BUILD_CONFIG.
    const legacyManual: ProgramModel = {
      ...baseModules(),
      manualChunkGroups: [{ name: "legacy", moduleIds: ["leaf"] }],
    };
    expect(buildConfigOf(legacyManual)).toEqual({
      ...DEFAULT_BUILD_CONFIG,
      chunking: { kind: "manual", groups: [{ name: "legacy", moduleIds: ["leaf"] }] },
      includeDependenciesRecursively: false,
    });
    expect(programChunking(legacyManual).kind).toBe("manual");
    // The legacy model still validates and round-trips (replay).
    expect(validateProgramModel(analyzeProgram(legacyManual))).toEqual([]);

    // A legacy AUTOMATIC artifact keeps the rolldown default `true` — the per-group hardcode never applied
    // (automatic carries no groups), so the reconciliation is manual-only.
    const legacyAutomatic: ProgramModel = { ...baseModules() };
    expect(buildConfigOf(legacyAutomatic).chunking).toEqual({ kind: "automatic" });
    expect(buildConfigOf(legacyAutomatic).includeDependenciesRecursively).toBe(true);
  });

  test("programChunking normalizes an empty groups union to automatic", () => {
    for (const empty of [
      { kind: "manual", groups: [] } as const,
      { kind: "organic", groups: [] } as const,
    ]) {
      const program: ProgramModel = { ...baseModules(), build: { ...build, chunking: empty } };
      expect(programChunking(program)).toEqual({ kind: "automatic" });
    }
  });

  test("validates chunking through build.chunking (unknown module id is rejected)", () => {
    const program: ProgramModel = {
      ...baseModules(),
      build: {
        ...build,
        chunking: { kind: "manual", groups: [{ name: "g", moduleIds: ["ghost"] }] },
      },
    };
    expect(validateProgramModel(analyzeProgram(program))).toContain(
      'manualChunkGroups[0].moduleIds[0]: unknown module id "ghost"',
    );
  });

  test("accepts a valid build config, including strictExecutionOrder:false (W14c rollable axis)", () => {
    expect(validateProgramModel(analyzeProgram({ ...baseModules(), build }))).toEqual([]);
    // seo:false is REPRESENTABLE as of W14c — it is tied to the reachability-isolation oracle in
    // program-run, so the validator accepts a seo:false model rather than rejecting it.
    const seoFalse: ProgramModel = {
      ...baseModules(),
      build: { ...build, chunking: { kind: "automatic" }, strictExecutionOrder: false },
    };
    expect(validateProgramModel(analyzeProgram(seoFalse))).toEqual([]);
    // A NON-boolean strictExecutionOrder is still rejected.
    const seoBogus: ProgramModel = {
      ...baseModules(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      build: { ...build, chunking: { kind: "automatic" }, strictExecutionOrder: "yes" as any },
    };
    expect(validateProgramModel(analyzeProgram(seoBogus))).toContain(
      "build.strictExecutionOrder: must be a boolean",
    );
  });

  test("rejects an invalid preserveEntrySignatures value", () => {
    const program: ProgramModel = {
      ...baseModules(),
      build: {
        ...build,
        chunking: { kind: "automatic" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        preserveEntrySignatures: "bogus" as any,
      },
    };
    expect(validateProgramModel(analyzeProgram(program))).toContain(
      'build.preserveEntrySignatures: invalid value "bogus"',
    );
  });

  test("rejects an unknown chunking kind discriminant", () => {
    // A `{ kind: "bogus" }` chunking otherwise falls through `programChunking` / the adapter switch to
    // AUTOMATIC silently — a crafted or shrunk model would build a different chunking than it names. The
    // validator rejects the unknown discriminant so the union stays sound.
    const program: ProgramModel = {
      ...baseModules(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      build: { ...build, chunking: { kind: "bogus" } as any },
    };
    expect(validateProgramModel(analyzeProgram(program))).toContain(
      'build.chunking: unknown chunking kind "bogus" (expected automatic, manual, or organic)',
    );
  });
});
