import { describe, expect, test } from "vite-plus/test";

import type { ModuleModel } from "../src/model.ts";
import { ProgramFacts } from "../src/program-facts.ts";

function facts(modules: readonly ModuleModel[]): ProgramFacts {
  return ProgramFacts.from(modules);
}

describe("wouldCloseSynchronousEdge (finding A)", () => {
  // A dynamic import A -> B is NOT a synchronous edge; B synchronously imports A. `edgeClosesCycle`
  // (an SCC-membership test on the CURRENT synchronous graph) says A and B are not in one cycle — true,
  // there is no synchronous cycle yet. But ADDING a synchronous A -> B would close one, which is the
  // question a graph mutator (augmentMultiEdgePairs) must ask. `wouldCloseSynchronousEdge` answers it.
  test("catches a synchronous back-edge that edgeClosesCycle misses on a dynamic-only pair", () => {
    const f = facts([
      {
        id: "A",
        format: "esm",
        events: [],
        dependencies: [{ kind: "esm-dynamic-import", target: "B", registration: "r" }],
      },
      {
        id: "B",
        format: "esm",
        events: [],
        dependencies: [{ kind: "esm-side-effect-import", target: "A" }],
      },
    ]);
    // No synchronous cycle exists yet (the only synchronous edge is B -> A).
    expect(f.edgeClosesCycle("A", "B")).toBe(false);
    // But adding a synchronous A -> B would close one, because B already synchronously reaches A.
    expect(f.wouldCloseSynchronousEdge("A", "B")).toBe(true);
  });

  test("a self-edge always closes a cycle", () => {
    const f = facts([{ id: "A", format: "esm", events: [], dependencies: [] }]);
    expect(f.wouldCloseSynchronousEdge("A", "A")).toBe(true);
  });

  test("agrees with edgeClosesCycle on an already-synchronous cycle", () => {
    const f = facts([
      {
        id: "A",
        format: "esm",
        events: [],
        dependencies: [{ kind: "esm-side-effect-import", target: "B" }],
      },
      {
        id: "B",
        format: "esm",
        events: [],
        dependencies: [{ kind: "esm-side-effect-import", target: "A" }],
      },
    ]);
    expect(f.edgeClosesCycle("A", "B")).toBe(true);
    expect(f.wouldCloseSynchronousEdge("A", "B")).toBe(true);
  });

  test("a forward edge to a leaf closes nothing", () => {
    const f = facts([
      {
        id: "A",
        format: "esm",
        events: [],
        dependencies: [{ kind: "esm-side-effect-import", target: "B" }],
      },
      { id: "B", format: "esm", events: [], dependencies: [] },
    ]);
    expect(f.wouldCloseSynchronousEdge("A", "B")).toBe(false);
  });
});

describe("resolveExportRoute supply resolution", () => {
  const definer = (id: string): ModuleModel => ({
    id,
    format: "esm",
    events: [],
    dependencies: [],
  });

  test("a star re-export supplies a name and records the star hop", () => {
    const f = facts([
      definer("def"),
      {
        id: "bar",
        format: "esm",
        events: [],
        dependencies: [{ kind: "esm-reexport-star", target: "def" }],
      },
    ]);
    const route = f.resolveExportRoute("bar", "v");
    expect(route.status).toBe("supplied");
    if (route.status === "supplied") {
      expect(route.origin).toEqual({ moduleId: "def", exportName: "v" });
      expect(route.hops).toEqual([
        { via: "star", through: "bar", target: "def", exportedName: "v", importedName: "v" },
      ]);
    }
  });

  test("a named re-export supplies a name and records the named hop", () => {
    const f = facts([
      definer("def"),
      {
        id: "bar",
        format: "esm",
        events: [],
        dependencies: [
          { kind: "esm-reexport-named", target: "def", sourceName: "v", exportedName: "w" },
        ],
      },
    ]);
    const route = f.resolveExportRoute("bar", "w");
    expect(route.status).toBe("supplied");
    if (route.status === "supplied") {
      expect(route.origin).toEqual({ moduleId: "def", exportName: "v" });
      expect(route.hops).toEqual([
        { via: "named", through: "bar", target: "def", exportedName: "w", importedName: "v" },
      ]);
    }
  });

  test("a default import through a star-only barrel is unsupplied (a star never forwards default)", () => {
    const f = facts([
      definer("def"),
      {
        id: "bar",
        format: "esm",
        events: [],
        dependencies: [{ kind: "esm-reexport-star", target: "def" }],
      },
    ]);
    expect(f.resolveExportRoute("bar", "default").status).toBe("unsupplied");
  });

  test("two star re-exports each providing the name is ambiguous", () => {
    const f = facts([
      definer("A"),
      definer("B"),
      {
        id: "bar",
        format: "esm",
        events: [],
        dependencies: [
          { kind: "esm-reexport-star", target: "A" },
          { kind: "esm-reexport-star", target: "B" },
        ],
      },
    ]);
    const route = f.resolveExportRoute("bar", "x");
    expect(route.status).toBe("ambiguous");
    if (route.status === "ambiguous") {
      expect(route.origins.map((origin) => origin.moduleId).sort()).toEqual(["A", "B"]);
    }
  });

  test("duplicate named exports of the same name are ambiguous", () => {
    const f = facts([
      definer("A"),
      definer("B"),
      {
        id: "bar",
        format: "esm",
        events: [],
        dependencies: [
          { kind: "esm-reexport-named", target: "A", sourceName: "v", exportedName: "y" },
          { kind: "esm-reexport-named", target: "B", sourceName: "v", exportedName: "y" },
        ],
      },
    ]);
    expect(f.resolveExportRoute("bar", "y").status).toBe("ambiguous");
  });

  test("a leaf definer supplies any demanded name directly", () => {
    const route = facts([definer("def")]).resolveExportRoute("def", "anything");
    expect(route.status).toBe("supplied");
    if (route.status === "supplied") {
      expect(route.hops).toEqual([]);
    }
  });
});
