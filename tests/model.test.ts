import { describe, expect, test } from "vite-plus/test";

import type { ModuleModel, ProgramModel } from "../src/model.ts";
import { validateProgramModel } from "../src/validate-model.ts";

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

    expect(validateProgramModel(program)).toEqual([]);
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
              reads: [{ binding: "targetExports", member: "vt" }],
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

    expect(validateProgramModel(program)).toEqual([]);
  });

  test("accepts a side-effect-free transitive value module", () => {
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

    expect(validateProgramModel(program)).toEqual([]);
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

    expect(validateProgramModel(program)).toEqual([
      "modules[0]: a side-effect-free module must be ESM, received cjs",
      "modules[0]: a side-effect-free module must not emit events; its events can be legally dropped under sideEffects:false",
      "modules[0].dependencies[0]: a side-effect-free module may only carry value-only ESM dependencies, received cjs-require",
      "modules[1].dependencies[0]: a side-effect-free module may only carry value-only ESM dependencies, received esm-side-effect-import",
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
              readMembers: ["a", "b"],
            },
            {
              kind: "esm-namespace-import",
              target: "cjs-target",
              localName: "ns1",
              readMembers: ["c"],
            },
          ],
          events: [
            {
              module: "reader",
              phase: "evaluate",
              value: 1,
              reads: [
                { binding: "ns0", member: "a" },
                { binding: "ns0", member: "b" },
                { binding: "ns1", member: "c" },
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

    expect(validateProgramModel(program)).toEqual([]);
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
              readMembers: ["a"],
            },
          ],
          events: [
            {
              module: "reader",
              phase: "evaluate",
              value: 0,
              reads: [{ binding: "ns0", member: "b" }, { binding: "ns0" }],
            },
          ],
        },
        { id: "target", format: "esm", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "reader" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } satisfies ProgramModel;

    expect(validateProgramModel(program)).toEqual([
      'modules[0].events[0].reads[0].member: expected a namespace member for binding "ns0", received "b"',
      'modules[0].events[0].reads[1].member: expected a namespace member for binding "ns0", received no member',
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

    expect(validateProgramModel(program)).toEqual([]);
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

    expect(validateProgramModel(program)).toEqual([]);
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

    expect(validateProgramModel(program)).toEqual([
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
            { kind: "esm-namespace-import", target: "target", localName: "ns", readMembers: ["a"] },
            { kind: "esm-reexport-star", target: "target" },
          ],
          events: [],
        },
        { id: "target", format: "esm", dependencies: [], events: [] },
      ],
      entries: [{ name: "main", moduleId: "target" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    } as unknown as ProgramModel;

    expect(validateProgramModel(program)).toEqual([
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
              reads: [{ binding: "missing" }, { binding: "sourceValue", member: "notAMember" }],
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

    expect(validateProgramModel(program)).toEqual([
      'modules[0].events[0].reads[0].binding: unknown readable binding "missing" in this module',
      'modules[0].events[0].reads[1].member: expected no member for binding "sourceValue", received "notAMember"',
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

    expect(validateProgramModel(program)).toEqual([
      'modules[0].events[0].reads[0].member: expected "vt" for binding "targetExports", received no member',
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

    expect(validateProgramModel(program)).toEqual([
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

    expect(validateProgramModel(program)).toEqual([
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

    expect(validateProgramModel(program)).toEqual([]);
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

    expect(validateProgramModel(program)).toEqual([]);

    const nestedBeforeParent = {
      ...program,
      schedule: [
        { kind: "import-entry", entry: "main" },
        { kind: "trigger-dynamic-import", registration: "load-nested" },
        { kind: "trigger-dynamic-import", registration: "load-lazy" },
      ],
    } satisfies ProgramModel;

    expect(validateProgramModel(nestedBeforeParent)).toEqual([
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

    expect(validateProgramModel(program)).toEqual([
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

    expect(validateProgramModel(program)).toEqual([
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

    expect(validateProgramModel(program)).toEqual([]);
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

    expect(validateProgramModel(program)).toEqual([
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

    expect(validateProgramModel(program)).toEqual([
      'modules[1].id: duplicate module id "duplicate"',
    ]);
  });

  test("rejects entries that reference missing modules", () => {
    const program = {
      modules: [],
      entries: [{ name: "main", moduleId: "missing" }],
      schedule: [],
    } satisfies ProgramModel;

    expect(validateProgramModel(program)).toEqual([
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

    expect(validateProgramModel(program)).toEqual([
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

    expect(validateProgramModel(program)).toEqual([
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

      expect(validateProgramModel(program)).toEqual([
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

    expect(validateProgramModel(program)).toEqual([
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

    expect(validateProgramModel(program)).toEqual([
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

    expect(validateProgramModel(program)).toEqual([
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
    expect(validateProgramModel(esmCycle)).toEqual([]);

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
              reads: [{ binding: "a_b", member: "vb", guard: true }],
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
              reads: [{ binding: "b_a", member: "va", guard: true }],
            },
          ],
        },
      ],
      entries: [{ name: "main", moduleId: "a" }],
      schedule: [{ kind: "require-entry", entry: "main" }],
    } satisfies ProgramModel;
    expect(validateProgramModel(cjsCycle)).toEqual([]);
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
    expect(validateProgramModel(plainValueCycle)).toEqual([
      "modules[0].dependencies[0]: an ESM value import that closes a cycle must be a hoisted-function call import (call: true) to avoid TDZ",
    ]);

    const namespaceCycle = {
      modules: [
        {
          id: "a",
          format: "esm",
          dependencies: [
            { kind: "esm-namespace-import", target: "b", localName: "a_ns", readMembers: ["vb"] },
          ],
          events: [
            {
              module: "a",
              phase: "evaluate",
              value: 1,
              reads: [{ binding: "a_ns", member: "vb" }],
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
    expect(validateProgramModel(namespaceCycle)).toEqual([
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
            { module: "a", phase: "evaluate", value: 1, reads: [{ binding: "a_b", member: "vb" }] },
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
    expect(validateProgramModel(unguardedCycle)).toEqual([
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
    expect(validateProgramModel(callToCjs)).toEqual([
      'modules[0].dependencies[0]: a hoisted-function call import must target an ESM module, target "b" is cjs',
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
    expect(validateProgramModel(program)).toEqual([]);
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
              reads: [{ binding: "t", member: "v" }],
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
    expect(validateProgramModel(program)).toEqual([]);
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
    expect(validateProgramModel(program)).toEqual([]);
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
    expect(validateProgramModel(program)).toEqual([
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
    expect(validateProgramModel(program)).toEqual([
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
    expect(validateProgramModel(callingANumber)).toEqual([
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
    expect(validateProgramModel(foldingFunctionSource)).toEqual([
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
              readMembers: ["vdef"],
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
    expect(validateProgramModel(program)).toEqual([
      'modules[0].dependencies[0]: namespace member "vdef" resolves to a callable-own-state export; it must be in callMembers, a plain member fold of a function is unsound',
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
    expect(validateProgramModel(program)).toContain(
      'modules[0].dependencies[0]: import "vobj" resolves to an object export; it must be an objectRef capture, folding or calling an object is unsound',
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
              reads: [{ binding: "r", member: "default" }],
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
    expect(validateProgramModel(program)).toContain(
      'modules[0].dependencies[0]: a readable require cannot read "default" from CJS module "b"; a CommonJS provider supplies no default property',
    );
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
    expect(validateProgramModel(program)).toEqual([
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
    expect(validateProgramModel(program)).toEqual([
      'synchronous cycle {"a", "b"} mixes module formats (cjs, esm); a mixed-format cycle is Node-illegal',
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
    expect(validateProgramModel(program)).toEqual([]);
    // Serialize -> parse -> identical, and still valid (byte-identical replay through model.json).
    const roundTripped = JSON.parse(JSON.stringify(program)) as ProgramModel;
    expect(roundTripped).toEqual(program);
    expect(JSON.stringify(roundTripped)).toBe(JSON.stringify(program));
    expect(validateProgramModel(roundTripped)).toEqual([]);
  });

  test("rejects carrying both manual and organic chunk groups", () => {
    const program: ProgramModel = {
      ...baseProgram(),
      manualChunkGroups: [{ name: "manual", moduleIds: ["leaf"] }],
      organicChunkGroups: [{ name: "organic", minShareCount: 1 }],
    };
    expect(validateProgramModel(program)).toContain(
      "a program may carry either manualChunkGroups or organicChunkGroups, not both",
    );
  });

  test("rejects invalid organic group fields", () => {
    const program: ProgramModel = {
      ...baseProgram(),
      organicChunkGroups: [{ name: "dup" }, { name: "dup", test: "([unclosed", minShareCount: -1 }],
    };
    const errors = validateProgramModel(program);
    expect(errors).toContain('organicChunkGroups[1].name: duplicate group name "dup"');
    expect(errors).toContain(
      'organicChunkGroups[1].test: invalid regular-expression source "([unclosed"',
    );
    expect(errors).toContain(
      "organicChunkGroups[1].minShareCount: must be a finite non-negative number",
    );
  });
});
