/// <reference types="node" />

import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { generateCase, MIXED_TEMPLATE_NAMES, type GeneratedCase } from "../src/generate.ts";
import {
  classifyCampaignVerdict,
  DEFAULT_CASE_SIZE,
  executeGeneratedCase,
  FAILURE_ARTIFACT_SCHEMA_VERSION,
  failureArtifactPath,
  parseCliArgs,
  runCampaign,
  writeFailureArtifacts,
  type BundleNotRunOutcome,
  type CampaignCaseResult,
  type CampaignOptions,
} from "../src/main.ts";
import { projectStatus } from "../src/project.ts";
import type { ExecutionOutcome } from "../src/protocol.ts";
import { renderProgram } from "../src/render.ts";
import { withRolldownBuild } from "../src/rolldown-adapter.ts";
import type { Verdict } from "../src/verdict.ts";

describe("parseCliArgs", () => {
  test("parses the complete campaign option set", () => {
    expect(
      parseCliArgs([
        "--seed",
        "4294967295",
        "--cases",
        "12",
        "--rolldown-package",
        "file:///tmp/rolldown.mjs",
        "--out-dir",
        "artifacts",
        "--continue-on-fail",
      ]),
    ).toEqual({
      seed: 4_294_967_295,
      cases: 12,
      rolldownPackage: "file:///tmp/rolldown.mjs",
      outDir: "artifacts",
      continueOnFail: true,
    });

    expect(parseCliArgs(["--stop-on-fail"])).toMatchObject({
      continueOnFail: false,
    });
  });

  test("rejects unknown, missing, conflicting, and invalid arguments", () => {
    expect(() => parseCliArgs(["--unknown"])).toThrowError("Unknown argument: --unknown");
    expect(() => parseCliArgs(["--seed"])).toThrowError("Missing value for --seed");
    expect(() => parseCliArgs(["--seed", "-1"])).toThrowError(
      "--seed must be an unsigned 32-bit integer",
    );
    expect(() => parseCliArgs(["--cases", "0"])).toThrowError("--cases must be a positive integer");
    expect(() => parseCliArgs(["--out-dir", ""])).toThrowError("--out-dir must not be empty");
    expect(() => parseCliArgs(["--out-dir", "--continue-on-fail"])).toThrowError(
      "Missing value for --out-dir",
    );
    expect(() => parseCliArgs(["--rolldown-package", "--stop-on-fail"])).toThrowError(
      "Missing value for --rolldown-package",
    );
    expect(() => parseCliArgs(["--continue-on-fail", "--stop-on-fail"])).toThrowError(
      "Choose only one of --continue-on-fail and --stop-on-fail",
    );
    expect(() =>
      parseCliArgs(["--seed", "4294967295", "--cases", String(Number.MAX_SAFE_INTEGER)]),
    ).toThrowError("--seed and --cases must define a safe integer range");
  });

  test("accepts the largest seed range whose last seed is safe", () => {
    const seed = 4_294_967_295;
    const cases = Number.MAX_SAFE_INTEGER - seed + 1;

    expect(parseCliArgs(["--seed", String(seed), "--cases", String(cases)])).toMatchObject({
      seed,
      cases,
    });
  });
});

test("reports the project as an MVP", () => {
  expect(projectStatus.phase).toBe("mvp");
});

describe("runCampaign", () => {
  test("stops after the first failure by default", async () => {
    const seeds: number[] = [];
    const lines: string[] = [];
    const artifacts: number[] = [];
    const options = campaignOptions({ cases: 4, continueOnFail: false });

    const summary = await runCampaign(options, {
      generate: (seed, size) => {
        seeds.push(seed);
        return generateCase(seed, size);
      },
      executeCase: async (generated) => failedCase(generated),
      writeFailure: async (_result, _outDir, caseIndex) => {
        artifacts.push(caseIndex);
        return `failure-${caseIndex}`;
      },
      writeLine: (line) => {
        lines.push(line);
      },
    });

    expect(seeds).toEqual([options.seed]);
    expect(artifacts).toEqual([0]);
    expect(summary).toEqual({ casesRun: 1, passed: 0, failed: 1, exitCode: 1 });
    expect(lines).toEqual([
      expect.stringContaining("FAIL case=0 seed=100 template=") as unknown as string,
      "summary cases=1 pass=0 fail=1",
    ]);
    expect(lines[0]).toContain(
      'signature=events-missing:source=[["missing","evaluate",1]]:bundle=[]',
    );
  });

  test("continues with incremented replay seeds when requested", async () => {
    const seeds: number[] = [];
    const options = campaignOptions({ cases: 3, continueOnFail: true });

    const summary = await runCampaign(options, {
      generate: (seed, size) => {
        seeds.push(seed);
        return generateCase(seed, size);
      },
      executeCase: async (generated) =>
        generated.seed === 101 ? failedCase(generated) : passedCase(generated),
      writeFailure: async () => "failure",
      writeLine: () => {},
    });

    expect(seeds).toEqual([100, 101, 102]);
    expect(summary).toEqual({ casesRun: 3, passed: 2, failed: 1, exitCode: 1 });
  });

  test("wraps campaign seeds as unsigned 32-bit integers", async () => {
    const seeds: number[] = [];

    await runCampaign(campaignOptions({ seed: 4_294_967_295, cases: 2 }), {
      generate: (seed, size) => {
        seeds.push(seed);
        return generateCase(seed, size);
      },
      executeCase: async (generated) => passedCase(generated),
      writeFailure: async () => {
        throw new Error("passing cases must not write artifacts");
      },
      writeLine: () => {},
    });

    expect(seeds).toEqual([4_294_967_295, 0]);
  });

  test("returns exit code 2 for classified harness failures", async () => {
    const generated = generateCase(100, DEFAULT_CASE_SIZE);
    const adapterFailure = {
      status: "harness-error",
      stage: "load-package",
      packageSpecifier: "missing",
      error: { name: "Error", message: "load failed" },
    } as const;
    const bundleOutcome = {
      status: "not-run",
      reason: "adapter-failure",
      adapterFailure,
    } as const satisfies BundleNotRunOutcome;
    const sourceOutcome = {
      version: 1,
      status: "harness-error",
      events: [],
      error: { name: "ChildProcessError", message: "runner failed" },
    } as const satisfies ExecutionOutcome;

    const summary = await runCampaign(campaignOptions(), {
      executeCase: async () => ({
        generated,
        options: campaignOptions(),
        rendered: renderProgram(generated.program),
        sourceOutcome,
        bundleOutcome,
        bundleManifest: null,
        bundleFiles: [],
        verdict: classifyCampaignVerdict(sourceOutcome, bundleOutcome),
      }),
      writeFailure: async () => "failure",
      writeLine: () => {},
    });

    expect(summary).toEqual({ casesRun: 1, passed: 0, failed: 1, exitCode: 2 });
  });

  test("keeps source invalidity ahead of an adapter failure", () => {
    const bundleOutcome = {
      status: "not-run",
      reason: "adapter-failure",
      adapterFailure: {
        status: "build-error",
        stage: "build",
        packageSpecifier: "rolldown",
        error: { name: "Error", message: "build failed" },
      },
    } as const satisfies BundleNotRunOutcome;

    expect(classifyCampaignVerdict(timeout(), bundleOutcome)).toEqual({
      kind: "invalid-source",
      reason: "source-timeout",
      signature: "invalid-source:source-timeout",
    });
  });

  test("does not invoke Rolldown for a source timeout or harness error", async () => {
    const generated = generateCase(2, DEFAULT_CASE_SIZE);
    const sourceOutcomes = [
      timeout(),
      {
        version: 1,
        status: "harness-error",
        events: [],
        error: { name: "ChildProcessError", message: "runner failed" },
      },
    ] as const satisfies readonly ExecutionOutcome[];

    for (const sourceOutcome of sourceOutcomes) {
      let buildCalls = 0;
      const result = await executeGeneratedCase(generated, campaignOptions(), {
        executeSource: async () => sourceOutcome,
        buildBundle: async () => {
          buildCalls += 1;
          throw new Error("build must not run");
        },
      });

      expect(buildCalls).toBe(0);
      expect(result.sourceOutcome).toEqual(sourceOutcome);
      expect(result.bundleOutcome).toEqual({
        status: "not-run",
        reason: "source-invalid",
      });
      expect(result.verdict.kind).toBe(
        sourceOutcome.status === "timeout" ? "invalid-source" : "invalid-harness",
      );
    }
  });

  test("continues to Rolldown for a comparable source error", async () => {
    const generated = generateCase(2, DEFAULT_CASE_SIZE);
    const sourceOutcome = {
      version: 1,
      status: "error",
      events: [],
      error: { name: "TypeError", message: "expected failure" },
    } as const satisfies ExecutionOutcome;
    let buildCalls = 0;

    const result = await executeGeneratedCase(generated, campaignOptions(), {
      executeSource: async () => sourceOutcome,
      buildBundle: async (_generated, rendered) => {
        buildCalls += 1;
        return {
          status: "ok",
          value: {
            bundleOutcome: structuredClone(sourceOutcome),
            bundleManifest: rendered.schedule,
            bundleFiles: [],
          },
        };
      },
    });

    expect(buildCalls).toBe(1);
    expect(result.verdict).toEqual({ kind: "pass", signature: "pass" });
  });

  test("keeps package specifiers intact in adapter failure signatures", () => {
    const packageSpecifier = "rolldown-order-fuzzer-package-that-does-not-exist";
    const bundleOutcome = {
      status: "not-run",
      reason: "adapter-failure",
      adapterFailure: {
        status: "harness-error",
        stage: "load-package",
        packageSpecifier,
        error: {
          name: "Error",
          message: `Cannot find package '${packageSpecifier}'`,
        },
      },
    } as const satisfies BundleNotRunOutcome;

    expect(classifyCampaignVerdict(ok([]), bundleOutcome).signature).toContain(packageSpecifier);
  });

  test("keeps repository paths intact in adapter failure signatures", () => {
    const repositoryPath = "/workspace/rolldown-order-fuzzer-mvp/src/rolldown-adapter.ts";
    const bundleOutcome = {
      status: "not-run",
      reason: "adapter-failure",
      adapterFailure: {
        status: "harness-error",
        stage: "load-package",
        packageSpecifier: "missing",
        error: {
          name: "Error",
          message: `Cannot load package imported from ${repositoryPath}`,
        },
      },
    } as const satisfies BundleNotRunOutcome;

    expect(classifyCampaignVerdict(ok([]), bundleOutcome).signature).toContain(repositoryPath);
  });

  test("normalizes the current checkout root in adapter failure signatures", () => {
    const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
    const bundleOutcome = {
      status: "not-run",
      reason: "adapter-failure",
      adapterFailure: {
        status: "harness-error",
        stage: "load-package",
        packageSpecifier: "missing",
        error: {
          name: "Error",
          message: `Cannot load package imported from ${join(repositoryRoot, "src/rolldown-adapter.ts")}`,
        },
      },
    } as const satisfies BundleNotRunOutcome;
    const signature = classifyCampaignVerdict(ok([]), bundleOutcome).signature;

    expect(signature).toContain("<fuzzer-root>/src/rolldown-adapter.ts");
    expect(signature).not.toContain(repositoryRoot);
  });

  test("normalizes temporary roots in exact build-failure signatures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-package-"));
    const packagePath = join(directory, "rolldown.mjs");
    await writeFile(
      packagePath,
      [
        "export async function rolldown(options) {",
        "  throw new Error(`build failed for ${Object.values(options.input)[0]}`);",
        "}",
        "",
      ].join("\n"),
    );
    const generated = generateCase(2, DEFAULT_CASE_SIZE);
    const options = campaignOptions({
      seed: generated.seed,
      rolldownPackage: pathToFileURL(packagePath).href,
    });

    try {
      const first = await executeGeneratedCase(generated, options);
      const second = await executeGeneratedCase(generated, options);

      expect(first.verdict.kind).toBe("build-failure");
      expect(second.verdict.signature).toBe(first.verdict.signature);
      expect(first.verdict.signature).toContain("<rolldown-root>/source/");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("captures emitted bundle files when Rolldown fails after writing output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-partial-bundle-"));
    const packagePath = join(directory, "rolldown.mjs");
    await writeFile(
      packagePath,
      [
        'import { mkdir, writeFile } from "node:fs/promises";',
        'import { join } from "node:path";',
        "",
        "export async function rolldown() {",
        "  return {",
        "    async write(options) {",
        '      const fileName = "entries/__entry_0000.js";',
        '      await mkdir(join(options.dir, "entries"), { recursive: true });',
        '      await writeFile(join(options.dir, fileName), "export const emitted = true;\\n");',
        "      return { output: [] };",
        "    },",
        "    async close() {",
        '      throw new Error("close failed after output");',
        "    },",
        "  };",
        "}",
        "",
      ].join("\n"),
    );
    const generated = generateCase(2, DEFAULT_CASE_SIZE);
    const options = campaignOptions({
      seed: generated.seed,
      rolldownPackage: pathToFileURL(packagePath).href,
      outDir: directory,
    });

    try {
      const result = await executeGeneratedCase(generated, options);

      expect(result.verdict.kind).toBe("build-failure");
      expect(result.bundleManifest).toBeNull();
      expect(result.bundleFiles.map((file) => file.path)).toEqual(["entries/__entry_0000.js"]);
      expect(Buffer.from(result.bundleFiles[0]?.contents ?? []).toString("utf8")).toBe(
        "export const emitted = true;\n",
      );

      const artifactDirectory = await writeFailureArtifacts(result, directory, 0);
      await expect(
        readFile(join(artifactDirectory, "bundle/entries/__entry_0000.js"), "utf8"),
      ).resolves.toBe("export const emitted = true;\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("awaits delayed failure artifact copying before adapter cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-delayed-copy-"));
    const packagePath = join(directory, "rolldown.mjs");
    await writeFile(
      packagePath,
      [
        'import { mkdir, writeFile } from "node:fs/promises";',
        'import { join } from "node:path";',
        "",
        "export async function rolldown() {",
        "  return {",
        "    async write(options) {",
        '      await mkdir(join(options.dir, "chunks"), { recursive: true });',
        '      await writeFile(join(options.dir, "chunks/delayed.js"), "delayed\\n");',
        "      return { output: [] };",
        "    },",
        "    async close() {",
        '      throw new Error("close failed after delayed output");',
        "    },",
        "  };",
        "}",
        "",
      ].join("\n"),
    );
    const generated = generateCase(2, DEFAULT_CASE_SIZE);
    const rendered = renderProgram(generated.program);
    let copied = "";

    try {
      const result = await withRolldownBuild(
        generated.program,
        rendered,
        async (): Promise<never> => {
          throw new Error("success callback must not run");
        },
        {
          packageSpecifier: pathToFileURL(packagePath).href,
          onFailureArtifacts: async (_failure, artifacts) => {
            await delay(50);
            copied = await readFile(join(artifacts.bundleDirectory, "chunks/delayed.js"), "utf8");
          },
        },
      );

      expect(result.status).toBe("build-error");
      expect(copied).toBe("delayed\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("runs a small real campaign through installed Rolldown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-real-"));

    try {
      const lines: string[] = [];
      const summary = await runCampaign(
        campaignOptions({
          seed: 0,
          cases: 9,
          continueOnFail: true,
          outDir: directory,
        }),
        {
          writeLine: (line) => {
            lines.push(line);
          },
        },
      );

      expect(summary).toEqual({ casesRun: 9, passed: 9, failed: 0, exitCode: 0 });
      expect(lines.at(-1)).toBe("summary cases=9 pass=9 fail=0");
      for (const template of MIXED_TEMPLATE_NAMES) {
        expect(lines.some((line) => line.includes(`template=${template}`))).toBe(true);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("writeFailureArtifacts", () => {
  test("writes replay metadata, exact outcomes and signature, and rendered source files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-artifacts-"));
    const generated = generateCase(7, DEFAULT_CASE_SIZE);
    const options = campaignOptions({
      seed: generated.seed,
      outDir: directory,
    });

    try {
      const executed = await executeGeneratedCase(generated, options);
      expect(executed.bundleManifest).not.toBeNull();
      expect(executed.bundleFiles.length).toBeGreaterThan(0);
      const result = {
        ...executed,
        verdict: failedCase(generated).verdict,
      } satisfies CampaignCaseResult;
      const artifactDirectory = await writeFailureArtifacts(result, directory, 3);
      const expectedArtifactDirectory = failureArtifactPath(result, directory, 3);
      const artifactHash = expectedArtifactDirectory.slice(
        expectedArtifactDirectory.lastIndexOf("-") + 1,
      );

      expect(artifactDirectory).toBe(expectedArtifactDirectory);
      expect(artifactHash).toMatch(/^[a-f0-9]{64}$/);
      await expect(readJson(join(artifactDirectory, "model.json"))).resolves.toEqual(
        generated.program,
      );
      await expect(readJson(join(artifactDirectory, "case.json"))).resolves.toEqual({
        artifactSchemaVersion: FAILURE_ARTIFACT_SCHEMA_VERSION,
        executionProtocolVersion: 1,
        artifactIdentity: artifactHash,
        caseIndex: 3,
        seed: generated.seed,
        size: generated.size,
        template: generated.template,
        coverageTags: generated.coverageTags,
        rolldownPackage: options.rolldownPackage,
      });
      await expect(readJson(join(artifactDirectory, "identity.json"))).resolves.toMatchObject({
        hash: artifactHash,
        inputs: {
          schemaVersion: FAILURE_ARTIFACT_SCHEMA_VERSION,
          protocolVersion: 1,
          case: {
            index: 3,
            seed: generated.seed,
            template: generated.template,
            model: generated.program,
          },
          rolldownPackage: options.rolldownPackage,
          verdictSignature: result.verdict.signature,
        },
      });
      await expect(readJson(join(artifactDirectory, "replay.json"))).resolves.toEqual({
        command: [
          "vp",
          "exec",
          "node",
          "src/main.ts",
          "--seed",
          "7",
          "--cases",
          "1",
          "--rolldown-package",
          "rolldown",
          "--out-dir",
          directory,
          "--stop-on-fail",
        ],
        options: {
          seed: generated.seed,
          size: generated.size,
          cases: 1,
          rolldownPackage: options.rolldownPackage,
          outDir: directory,
          continueOnFail: false,
        },
      });
      await expect(readJson(join(artifactDirectory, "source-manifest.json"))).resolves.toEqual(
        result.rendered.schedule,
      );
      await expect(readJson(join(artifactDirectory, "bundle-manifest.json"))).resolves.toEqual(
        result.bundleManifest,
      );
      await expect(readJson(join(artifactDirectory, "source-outcome.json"))).resolves.toEqual(
        result.sourceOutcome,
      );
      await expect(readJson(join(artifactDirectory, "bundle-outcome.json"))).resolves.toEqual(
        result.bundleOutcome,
      );
      await expect(readJson(join(artifactDirectory, "verdict.json"))).resolves.toEqual(
        result.verdict,
      );
      await expect(readFile(join(artifactDirectory, "signature.txt"), "utf8")).resolves.toBe(
        `${result.verdict.signature}\n`,
      );

      for (const file of result.rendered.files) {
        await expect(readFile(join(artifactDirectory, "source", file.path), "utf8")).resolves.toBe(
          file.contents,
        );
      }
      for (const file of result.bundleFiles) {
        await expect(readFile(join(artifactDirectory, "bundle", file.path))).resolves.toEqual(
          Buffer.from(file.contents),
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps an existing complete final artifact without overwriting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-existing-"));
    const generated = generateCase(7, DEFAULT_CASE_SIZE);
    const result = failedCase(generated);
    const finalDirectory = failureArtifactPath(result, directory, 3);

    try {
      await mkdir(finalDirectory, { recursive: true });
      await writeFile(join(finalDirectory, "existing.txt"), "keep\n");

      await expect(writeFailureArtifacts(result, directory, 3)).resolves.toBe(finalDirectory);
      await expect(readFile(join(finalDirectory, "existing.txt"), "utf8")).resolves.toBe("keep\n");
      await expect(access(join(finalDirectory, "model.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await readdir(directory)).filter((name) => name.startsWith(".case-"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("publishes one complete winner when concurrent writers target the same case", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-concurrent-"));
    const generated = generateCase(7, DEFAULT_CASE_SIZE);
    const result = {
      ...failedCase(generated),
      bundleFiles: [
        {
          path: "winner.js",
          contents: Buffer.from("export const winner = true;\n"),
        },
      ],
    } satisfies CampaignCaseResult;

    try {
      const published = await Promise.all([
        writeFailureArtifacts(result, directory, 3),
        writeFailureArtifacts(structuredClone(result), directory, 3),
      ]);
      const finalDirectory = failureArtifactPath(result, directory, 3);

      expect(published).toEqual([finalDirectory, finalDirectory]);
      const bundleFiles = await readdir(join(finalDirectory, "bundle"));
      expect(bundleFiles).toEqual(["winner.js"]);
      await expect(readJson(join(finalDirectory, "verdict.json"))).resolves.toEqual(result.verdict);
      expect((await readdir(directory)).filter((name) => name.startsWith(".case-"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("never exposes a partial final directory when staging is interrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-interrupted-"));
    const generated = generateCase(7, DEFAULT_CASE_SIZE);
    const result = {
      ...failedCase(generated),
      bundleFiles: [
        { path: "collision", contents: Buffer.from("file") },
        { path: "collision/child.js", contents: Buffer.from("child") },
      ],
    } satisfies CampaignCaseResult;
    const finalDirectory = failureArtifactPath(result, directory, 3);

    try {
      await expect(writeFailureArtifacts(result, directory, 3)).rejects.toBeDefined();
      await expect(access(finalDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(directory)).filter((name) => name.startsWith(".case-"))).toHaveLength(
        1,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("uses distinct identities for different package, verdict, and effective options", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-identities-"));
    const generated = generateCase(7, DEFAULT_CASE_SIZE);
    const base = failedCase(generated);
    const cases = [
      base,
      {
        ...base,
        options: { ...base.options, rolldownPackage: "rolldown-preview" },
      },
      {
        ...base,
        verdict: {
          kind: "mismatch",
          reason: "events-mismatch",
          signature: `${base.verdict.signature}:different`,
        },
      },
      {
        ...base,
        options: { ...base.options, continueOnFail: true },
      },
    ] satisfies readonly CampaignCaseResult[];

    try {
      const expectedPaths = cases.map((result) => failureArtifactPath(result, directory, 3));
      expect(new Set(expectedPaths).size).toBe(cases.length);

      const published = await Promise.all(
        cases.map((result) => writeFailureArtifacts(result, directory, 3)),
      );
      expect(published).toEqual(expectedPaths);
      await Promise.all(published.map((path) => expect(access(path)).resolves.toBeUndefined()));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports the current hashed artifact path from the campaign", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-reported-artifact-"));
    const generated = generateCase(7, DEFAULT_CASE_SIZE);
    const options = campaignOptions({
      seed: generated.seed,
      outDir: directory,
    });
    const result = {
      ...failedCase(generated),
      options,
    } satisfies CampaignCaseResult;
    const lines: string[] = [];

    try {
      await runCampaign(options, {
        generate: () => generated,
        executeCase: async () => result,
        writeLine: (line) => {
          lines.push(line);
        },
      });

      const expectedPath = failureArtifactPath(result, directory, 0);
      expect(lines[0]).toContain(`artifact=${expectedPath}`);
      await expect(access(expectedPath)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function campaignOptions(overrides: Partial<CampaignOptions> = {}): CampaignOptions {
  return {
    seed: 100,
    cases: 1,
    rolldownPackage: "rolldown",
    outDir: "failures",
    continueOnFail: false,
    ...overrides,
  };
}

function passedCase(generated: GeneratedCase): CampaignCaseResult {
  const rendered = renderProgram(generated.program);
  return {
    generated,
    options: campaignOptions({ seed: generated.seed }),
    rendered,
    sourceOutcome: ok([]),
    bundleOutcome: ok([]),
    bundleManifest: rendered.schedule,
    bundleFiles: [],
    verdict: { kind: "pass", signature: "pass" },
  };
}

function failedCase(generated: GeneratedCase): CampaignCaseResult {
  const sourceOutcome = ok([event("missing", 1)]);
  const bundleOutcome = ok([]);
  const verdict = {
    kind: "mismatch",
    reason: "events-missing",
    signature: 'events-missing:source=[["missing","evaluate",1]]:bundle=[]',
  } as const satisfies Verdict;

  return {
    generated,
    options: campaignOptions({ seed: generated.seed }),
    rendered: renderProgram(generated.program),
    sourceOutcome,
    bundleOutcome,
    bundleManifest: null,
    bundleFiles: [],
    verdict,
  };
}

function ok(events: ExecutionOutcome["events"]): ExecutionOutcome {
  return { version: 1, status: "ok", events };
}

function event(module: string, value: number): ExecutionOutcome["events"][number] {
  return { version: 1, module, phase: "evaluate", value };
}

function timeout(): ExecutionOutcome {
  return { version: 1, status: "timeout", events: [] };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
