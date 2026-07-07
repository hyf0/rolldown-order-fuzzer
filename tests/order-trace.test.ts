import { describe, expect, test } from "vite-plus/test";

import {
  parseStrictExecutionOrderLogs,
  parseStrictExecutionOrderPlanReady,
} from "../src/order-trace.ts";

describe("parseStrictExecutionOrderPlanReady", () => {
  test("constructs a canonical schema-only version 1 action", () => {
    const action = {
      ...validAction(),
      timestamp: 123,
      session_id: "session-a",
      build_id: "build-a",
    };

    const parsed = parseStrictExecutionOrderPlanReady(action);

    expect(parsed).not.toBe(action);
    expect(parsed).toEqual(canonicalAction());
    expect(parsed).not.toHaveProperty("timestamp");
    expect(parsed).not.toHaveProperty("session_id");
    expect(parsed).not.toHaveProperty("build_id");
    expect(parsed).not.toHaveProperty("future_top_level_field");
    expect(parsed.roots[0]).not.toHaveProperty("future_root_field");
  });

  test("rejects malformed required shapes", () => {
    expect(() =>
      parseStrictExecutionOrderPlanReady({
        ...validAction(),
        roots: [
          {
            ...validAction().roots[0],
            expected_order: "not-an-array",
          },
        ],
      }),
    ).toThrowError("StrictExecutionOrderPlanReady.roots[0].expected_order must be an array");

    expect(() =>
      parseStrictExecutionOrderPlanReady({
        ...validAction(),
        included_modules: [
          {
            ...validAction().included_modules[0],
            final_chunk_id: 1.5,
          },
        ],
      }),
    ).toThrowError(
      "StrictExecutionOrderPlanReady.included_modules[0].final_chunk_id must be an unsigned 32-bit integer or null",
    );
  });

  test("rejects unsupported versions", () => {
    expect(() =>
      parseStrictExecutionOrderPlanReady({
        ...validAction(),
        version: 2,
      }),
    ).toThrowError("Unsupported StrictExecutionOrderPlanReady version: 2");
  });

  test("enforces unsigned 32-bit bounds for every chunk ID and reference", () => {
    const invalidCases = [
      {
        value: {
          ...validAction(),
          included_modules: [
            {
              ...validAction().included_modules[0],
              final_chunk_id: -1,
            },
          ],
        },
        path: "StrictExecutionOrderPlanReady.included_modules[0].final_chunk_id",
        nullable: true,
      },
      {
        value: {
          ...validAction(),
          included_modules: [
            {
              ...validAction().included_modules[0],
              entry_chunk_id: 0x1_0000_0000,
            },
          ],
        },
        path: "StrictExecutionOrderPlanReady.included_modules[0].entry_chunk_id",
        nullable: true,
      },
      {
        value: {
          ...validAction(),
          rendered_chunks: [
            {
              ...validAction().rendered_chunks[0],
              chunk_id: -1,
            },
          ],
        },
        path: "StrictExecutionOrderPlanReady.rendered_chunks[0].chunk_id",
        nullable: false,
      },
      {
        value: {
          ...validAction(),
          rendered_chunks: [
            {
              ...validAction().rendered_chunks[0],
              static_chunk_imports: [0x1_0000_0000],
            },
          ],
        },
        path: "StrictExecutionOrderPlanReady.rendered_chunks[0].static_chunk_imports[0]",
        nullable: false,
      },
      {
        value: {
          ...validAction(),
          rendered_chunks: [
            {
              ...validAction().rendered_chunks[0],
              dynamic_chunk_imports: [-1],
            },
          ],
        },
        path: "StrictExecutionOrderPlanReady.rendered_chunks[0].dynamic_chunk_imports[0]",
        nullable: false,
      },
    ];

    for (const invalid of invalidCases) {
      expect(() => parseStrictExecutionOrderPlanReady(invalid.value)).toThrowError(
        `${invalid.path} must be an unsigned 32-bit integer${invalid.nullable ? " or null" : ""}`,
      );
    }
  });

  test("accepts unsigned 32-bit chunk ID boundaries", () => {
    const action = {
      ...validAction(),
      included_modules: [
        {
          ...validAction().included_modules[0],
          final_chunk_id: 0,
          entry_chunk_id: 0xffff_ffff,
        },
      ],
      rendered_chunks: [
        {
          ...validAction().rendered_chunks[0],
          chunk_id: 0xffff_ffff,
          static_chunk_imports: [0],
          dynamic_chunk_imports: [0xffff_ffff],
        },
      ],
    };

    expect(parseStrictExecutionOrderPlanReady(action)).toEqual({
      ...canonicalAction(),
      included_modules: [
        {
          ...canonicalAction().included_modules[0],
          final_chunk_id: 0,
          entry_chunk_id: 0xffff_ffff,
        },
      ],
      rendered_chunks: [
        {
          ...canonicalAction().rendered_chunks[0],
          chunk_id: 0xffff_ffff,
          static_chunk_imports: [0],
          dynamic_chunk_imports: [0xffff_ffff],
        },
      ],
    });
  });
});

describe("parseStrictExecutionOrderLogs", () => {
  test("returns the single matching action from JSON-lines logs", () => {
    const action = validAction();
    const logs = [
      JSON.stringify({ action: "BuildStart", build_id: "build-1" }),
      JSON.stringify(action),
      "",
    ].join("\n");

    expect(parseStrictExecutionOrderLogs(logs)).toEqual(canonicalAction());
  });

  test("rejects duplicate matching actions", () => {
    const line = JSON.stringify(validAction());

    expect(() => parseStrictExecutionOrderLogs(`${line}\n${line}\n`)).toThrowError(
      "Expected at most one StrictExecutionOrderPlanReady action, found 2",
    );
  });
});

function validAction() {
  return {
    action: "StrictExecutionOrderPlanReady",
    version: 1,
    roots: [
      {
        root_module_id: "/project/main.js",
        expected_order: ["/project/dependency.js", "/project/main.js"],
        predicted_pre_wrap_order: ["/project/main.js", "/project/dependency.js"],
        at_risk_modules: ["/project/dependency.js"],
        future_root_field: "preserved",
      },
    ],
    plan_modules: [
      {
        module_id: "/project/dependency.js",
        reasons: ["direct-violation", "sensitive-suffix"],
      },
    ],
    included_modules: [
      {
        module_id: "/project/dependency.js",
        original_wrap_kind: "none",
        final_wrap_kind: "esm",
        final_chunk_id: 1,
        entry_chunk_id: null,
        wrapper_included: true,
        tla_tainted: false,
      },
    ],
    rendered_chunks: [
      {
        chunk_id: 1,
        module_ids: ["/project/dependency.js"],
        static_chunk_imports: [],
        dynamic_chunk_imports: [2],
      },
    ],
    init_obligations: [
      {
        kind: "direct-import",
        importer_id: "/project/main.js",
        importee_id: "/project/dependency.js",
        awaited: false,
        importer_tla_tainted: false,
        importee_tla_tainted: false,
      },
    ],
    future_top_level_field: { enabled: true },
  };
}

function canonicalAction() {
  return {
    action: "StrictExecutionOrderPlanReady",
    version: 1,
    roots: [
      {
        root_module_id: "/project/main.js",
        expected_order: ["/project/dependency.js", "/project/main.js"],
        predicted_pre_wrap_order: ["/project/main.js", "/project/dependency.js"],
        at_risk_modules: ["/project/dependency.js"],
      },
    ],
    plan_modules: [
      {
        module_id: "/project/dependency.js",
        reasons: ["direct-violation", "sensitive-suffix"],
      },
    ],
    included_modules: [
      {
        module_id: "/project/dependency.js",
        original_wrap_kind: "none",
        final_wrap_kind: "esm",
        final_chunk_id: 1,
        entry_chunk_id: null,
        wrapper_included: true,
        tla_tainted: false,
      },
    ],
    rendered_chunks: [
      {
        chunk_id: 1,
        module_ids: ["/project/dependency.js"],
        static_chunk_imports: [],
        dynamic_chunk_imports: [2],
      },
    ],
    init_obligations: [
      {
        kind: "direct-import",
        importer_id: "/project/main.js",
        importee_id: "/project/dependency.js",
        awaited: false,
        importer_tla_tainted: false,
        importee_tla_tainted: false,
      },
    ],
  };
}
