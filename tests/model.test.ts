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

  test("does not predict completion of a triggered dynamic import", () => {
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

    expect(validateProgramModel(program)).toEqual([
      'schedule[2].registration: dynamic import registration "load-nested" is unavailable before module "lazy" is evaluated',
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
      'modules[0].dependencies[1].localName: duplicate ESM local binding "shared"',
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
