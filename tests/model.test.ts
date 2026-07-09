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
      "modules[0].dependencies[0]: a side-effect-free module may only carry esm-value-import dependencies, received cjs-require",
      "modules[1].dependencies[0]: a side-effect-free module may only carry esm-value-import dependencies, received esm-side-effect-import",
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
});
