import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import {
  normalizeSignature,
  parseManifest,
  type RedsetManifest,
} from "../scripts/regression-redset.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function validManifest(): Record<string, unknown> {
  return {
    schema: 1,
    title: "t",
    description: "d",
    miningDoc: "doc",
    greenSnapshot: { id: "snap", path: "/tmp/snap/dist/index.mjs" },
    entries: [
      {
        id: "RED-0",
        issue: 9887,
        cluster: "c",
        title: "gen",
        form: "generator",
        generator: "generateCrossChunkInitCycleCase",
        seed: 0,
        redTarget: { kind: "npm", version: "1.1.5" },
        greenTarget: { kind: "snapshot" },
        expectedRedSignature: 'bundle-only-crash:["TypeError","x"]',
        provenance: { fixPr: "#9887" },
      },
      {
        id: "RED-1",
        issue: 9502,
        cluster: "c",
        title: "raw",
        form: "raw",
        dir: "raw/9502",
        redTarget: { kind: "npm", version: "1.1.1" },
        greenTarget: { kind: "npm", version: "1.1.2" },
        expectedRedSignature: 'raw-crash:["ReferenceError","init_shared is not defined"]',
        provenance: { fixPr: "#9502 / #9717" },
      },
    ],
  };
}

describe("parseManifest", () => {
  test("accepts a well-formed manifest and resolves both entry forms", () => {
    const manifest = parseManifest(validManifest());
    expect(manifest.schema).toBe(1);
    expect(manifest.entries).toHaveLength(2);
    const [generatorEntry, rawEntry] = manifest.entries;
    expect(generatorEntry?.form).toBe("generator");
    expect(generatorEntry?.generator).toBe("generateCrossChunkInitCycleCase");
    // A generator entry with no explicit onDemandWrapping defaults to true.
    expect(generatorEntry?.onDemandWrapping).toBe(true);
    expect(generatorEntry?.greenTarget).toEqual({ kind: "snapshot" });
    expect(rawEntry?.form).toBe("raw");
    expect(rawEntry?.dir).toBe("raw/9502");
    expect(rawEntry?.greenTarget).toEqual({ kind: "npm", version: "1.1.2" });
  });

  test("rejects an unsupported schema", () => {
    expect(() => parseManifest({ ...validManifest(), schema: 2 })).toThrow(/schema 2/);
  });

  test("rejects a non-object", () => {
    expect(() => parseManifest(null)).toThrow(/expected an object/);
    expect(() => parseManifest([])).toThrow(/expected an object/);
  });

  test("rejects entries that are not an array", () => {
    expect(() => parseManifest({ ...validManifest(), entries: {} })).toThrow(
      /entries: expected an array/,
    );
  });

  test("rejects an unknown target kind with a path-qualified error", () => {
    const manifest = validManifest();
    (manifest.entries as Record<string, unknown>[])[0]!.redTarget = { kind: "git" };
    expect(() => parseManifest(manifest)).toThrow(/redTarget\.kind: unknown target kind "git"/);
  });

  test("rejects a generator-form entry that omits its generator", () => {
    const manifest = validManifest();
    const entry = (manifest.entries as Record<string, unknown>[])[0]!;
    delete entry.generator;
    expect(() => parseManifest(manifest)).toThrow(/entries\[0\]\.generator: expected a string/);
  });

  test("rejects a raw-form entry that omits its dir", () => {
    const manifest = validManifest();
    const entry = (manifest.entries as Record<string, unknown>[])[1]!;
    delete entry.dir;
    expect(() => parseManifest(manifest)).toThrow(/entries\[1\]\.dir: expected a string/);
  });

  test("rejects duplicate entry ids", () => {
    const manifest = validManifest();
    (manifest.entries as Record<string, unknown>[])[1]!.id = "RED-0";
    expect(() => parseManifest(manifest)).toThrow(/duplicate entry id "RED-0"/);
  });

  test("parses the committed regression/index.json and pins its four brackets", () => {
    const raw = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "regression/index.json"), "utf8"),
    ) as unknown;
    const manifest: RedsetManifest = parseManifest(raw);
    const ids = manifest.entries.map((entry) => entry.id).sort();
    expect(ids).toEqual(["RED-0", "RED-1", "RED-2", "RED-3"]);
    // Exactly one generator-form bracket (RED-0), three raw brackets.
    expect(manifest.entries.filter((entry) => entry.form === "generator").map((e) => e.id)).toEqual(
      ["RED-0"],
    );
    // Every expected red signature is already in its normalized form (idempotent under normalize).
    for (const entry of manifest.entries) {
      expect(normalizeSignature(entry.expectedRedSignature)).toBe(entry.expectedRedSignature);
    }
  });
});

describe("normalizeSignature", () => {
  test("leaves the four live bracket signatures unchanged (they carry no content hash)", () => {
    for (const signature of [
      'bundle-only-crash:["TypeError","init_module_0003 is not a function"]',
      'raw-crash:["ReferenceError","init_shared is not defined"]',
      'raw-crash:["TypeError","Cannot read properties of undefined (reading \'EventMatch\')"]',
      'raw-crash:["TypeError","__commonJSMin is not a function"]',
    ]) {
      expect(normalizeSignature(signature)).toBe(signature);
    }
  });

  test("collapses a Rolldown content-hash chunk-id suffix to a stable placeholder", () => {
    expect(
      normalizeSignature('raw-crash:["Error","Cannot find module ./chunks/shared-Bx2qtI_L.js"]'),
    ).toBe('raw-crash:["Error","Cannot find module ./chunks/shared-<hash>.js"]');
    expect(normalizeSignature("rolldown-runtime-DudxFV0I.mjs")).toBe("rolldown-runtime-<hash>.mjs");
  });

  test("is idempotent", () => {
    const once = normalizeSignature("chunk-A1b2C3d4.js");
    expect(normalizeSignature(once)).toBe(once);
  });
});
