/// <reference types="node" />

import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { generateCase, MIXED_TEMPLATE_NAMES, type GeneratedCase } from "../src/generate.ts";
import { parseStrictExecutionOrderPlanReady } from "../src/order-trace.ts";
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
import {
  inspectRolldownRuntimeIdentity,
  withRolldownBuild,
  type ObservedRuntimeIdentity,
} from "../src/rolldown-adapter.ts";
import type { Verdict } from "../src/verdict.ts";

describe("parseCliArgs", () => {
  test("uses artifact schema version 4", () => {
    expect(FAILURE_ARTIFACT_SCHEMA_VERSION).toBe(4);
  });

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
      collectOrderTrace: true,
    });

    expect(parseCliArgs(["--stop-on-fail"])).toMatchObject({
      continueOnFail: false,
      collectOrderTrace: true,
    });
    expect(parseCliArgs(["--no-order-trace"])).toMatchObject({
      collectOrderTrace: false,
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
  test("sets the strict-order trace environment once for the campaign and restores it", async () => {
    const previous = process.env.ROLLDOWN_STRICT_ORDER_TRACE;
    const observed: (string | undefined)[] = [];
    delete process.env.ROLLDOWN_STRICT_ORDER_TRACE;

    try {
      await runCampaign(campaignOptions({ cases: 2, continueOnFail: true }), {
        executeCase: async (generated) => {
          observed.push(process.env.ROLLDOWN_STRICT_ORDER_TRACE);
          return passedCase(generated);
        },
        writeFailure: async () => {
          throw new Error("passing cases must not write artifacts");
        },
        writeLine: () => {},
      });

      expect(observed).toEqual(["1", "1"]);
      expect(process.env.ROLLDOWN_STRICT_ORDER_TRACE).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.ROLLDOWN_STRICT_ORDER_TRACE;
      } else {
        process.env.ROLLDOWN_STRICT_ORDER_TRACE = previous;
      }
    }
  });

  test("serializes concurrent traced and opt-out campaigns around the process environment", async () => {
    const previous = process.env.ROLLDOWN_STRICT_ORDER_TRACE;
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const observed: (string | undefined)[] = [];
    let optOutStarted = false;
    delete process.env.ROLLDOWN_STRICT_ORDER_TRACE;

    try {
      const traced = runCampaign(campaignOptions(), {
        executeCase: async (generated) => {
          observed.push(process.env.ROLLDOWN_STRICT_ORDER_TRACE);
          firstStarted.resolve();
          await releaseFirst.promise;
          return passedCase(generated);
        },
        writeFailure: async () => {
          throw new Error("passing cases must not write artifacts");
        },
        writeLine: () => {},
      });
      await firstStarted.promise;

      const optOut = runCampaign(campaignOptions({ collectOrderTrace: false }), {
        executeCase: async (generated) => {
          optOutStarted = true;
          observed.push(process.env.ROLLDOWN_STRICT_ORDER_TRACE);
          return passedCase(generated);
        },
        writeFailure: async () => {
          throw new Error("passing cases must not write artifacts");
        },
        writeLine: () => {},
      });

      await delay(10);
      expect(optOutStarted).toBe(false);
      expect(process.env.ROLLDOWN_STRICT_ORDER_TRACE).toBe("1");

      releaseFirst.resolve();
      await Promise.all([traced, optOut]);

      expect(observed).toEqual(["1", undefined]);
      expect(process.env.ROLLDOWN_STRICT_ORDER_TRACE).toBeUndefined();
    } finally {
      releaseFirst.resolve();
      if (previous === undefined) {
        delete process.env.ROLLDOWN_STRICT_ORDER_TRACE;
      } else {
        process.env.ROLLDOWN_STRICT_ORDER_TRACE = previous;
      }
    }
  });

  test("prints the selected wrap count without changing a passing verdict", async () => {
    const generated = generateCase(100, DEFAULT_CASE_SIZE);
    const lines: string[] = [];
    const result = {
      ...passedCase(generated),
      orderTrace: orderTraceAction(),
    } satisfies CampaignCaseResult;

    const summary = await runCampaign(campaignOptions(), {
      generate: () => generated,
      executeCase: async () => result,
      writeFailure: async () => {
        throw new Error("passing cases must not write artifacts");
      },
      writeLine: (line) => {
        lines.push(line);
      },
    });

    expect(summary).toEqual({ casesRun: 1, passed: 1, failed: 0, exitCode: 0 });
    expect(lines[0]).toContain("wraps=1");
    expect(lines[0]).toContain("signature=pass");
  });

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
        orderTrace: null,
        runtimeIdentity: testRuntimeIdentity(),
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
            orderTrace: null,
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
      expect(failureArtifactPath(first, directory, 0)).toBe(
        failureArtifactPath(second, directory, 0),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("captures emitted bundle files when Rolldown fails after writing output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-partial-bundle-"));
    const packagePath = join(directory, "rolldown.mjs");
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({ type: "module", version: "1.2.3" })}\n`,
    );
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
      const resolvedPackagePath = await realpath(packagePath);

      expect(result.verdict.kind).toBe("build-failure");
      expect(result.bundleManifest).toBeNull();
      expect(result.bundleFiles.map((file) => file.path)).toEqual(["entries/__entry_0000.js"]);
      expect(Buffer.from(result.bundleFiles[0]?.contents ?? []).toString("utf8")).toBe(
        "export const emitted = true;\n",
      );
      expect(result.runtimeIdentity).toEqual({
        processVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        requestedPackageSpecifier: pathToFileURL(packagePath).href,
        resolvedEntryUrl: pathToFileURL(resolvedPackagePath).href,
        resolvedEntryPath: resolvedPackagePath,
        packageVersion: "1.2.3",
        resolvedEntrySha256: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown as string,
        packageRootPath: await realpath(directory),
        packageJsonPath: await realpath(join(directory, "package.json")),
        packageContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown as string,
        packageContentFiles: ["package.json", "rolldown.mjs"],
        fuzzerLockfilePath: await realpath(
          fileURLToPath(new URL("../package-lock.json", import.meta.url)),
        ),
        fuzzerLockfileSha256: createHash("sha256")
          .update(await readFile(fileURLToPath(new URL("../package-lock.json", import.meta.url))))
          .digest("hex"),
        optionalBindingPackages: [],
      });

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

  test("hashes runtime-relevant package contents without following external symlinks", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "order-runtime-package-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "order-runtime-outside-"));
    const entryPath = join(packageRoot, "dist/index.mjs");
    const sharedPath = join(packageRoot, "dist/shared.mjs");
    const nativePath = join(packageRoot, "native/addon.node");
    const ignoredPath = join(packageRoot, "node_modules/ignored.js");
    const outsidePath = join(outsideRoot, "outside.js");

    try {
      await Promise.all([
        mkdir(dirname(entryPath), { recursive: true }),
        mkdir(dirname(nativePath), { recursive: true }),
        mkdir(dirname(ignoredPath), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(packageRoot, "package.json"),
          `${JSON.stringify({ type: "module", version: "9.8.7" })}\n`,
        ),
        writeFile(entryPath, 'export { value } from "./shared.mjs";\n'),
        writeFile(sharedPath, "export const value = 1;\n"),
        writeFile(nativePath, Buffer.from([0, 1, 2, 3])),
        writeFile(join(packageRoot, "runtime-helper.js"), "export const helper = 1;\n"),
        writeFile(ignoredPath, "ignored = 1;\n"),
        writeFile(outsidePath, "outside = 1;\n"),
      ]);
      await symlink(outsidePath, join(packageRoot, "dist/outside-link.js"));

      const specifier = pathToFileURL(entryPath).href;
      const first = await inspectRolldownRuntimeIdentity(specifier);
      const identical = await inspectRolldownRuntimeIdentity(specifier);
      await writeFile(sharedPath, "export const value = 2;\n");
      const changedShared = await inspectRolldownRuntimeIdentity(specifier);
      await writeFile(nativePath, Buffer.from([3, 2, 1, 0]));
      const changedNative = await inspectRolldownRuntimeIdentity(specifier);
      await Promise.all([
        writeFile(ignoredPath, "ignored = 2;\n"),
        writeFile(outsidePath, "outside = 2;\n"),
      ]);
      const ignoredChanges = await inspectRolldownRuntimeIdentity(specifier);

      expect(identical).toEqual(first);
      expect(first.packageVersion).toBe("9.8.7");
      expect(first.resolvedEntrySha256).toBe(changedShared.resolvedEntrySha256);
      expect(changedShared.packageContentSha256).not.toBe(first.packageContentSha256);
      expect(changedNative.packageContentSha256).not.toBe(changedShared.packageContentSha256);
      expect(ignoredChanges.packageContentSha256).toBe(changedNative.packageContentSha256);
      expect(first.packageContentFiles).toEqual([
        "dist/index.mjs",
        "dist/shared.mjs",
        "native/addon.node",
        "package.json",
        "runtime-helper.js",
      ]);
    } finally {
      await Promise.all([
        rm(packageRoot, { recursive: true, force: true }),
        rm(outsideRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("hashes resolvable optional sibling binding packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "order-runtime-sibling-"));
    const mainRoot = join(root, "node_modules/rolldown");
    const mainEntry = join(mainRoot, "dist/index.mjs");
    const bindingRoot = join(root, "node_modules/@rolldown/binding-darwin-arm64");
    const bindingPath = join(bindingRoot, "binding.node");
    const bindingName = "@rolldown/binding-darwin-arm64";

    try {
      await Promise.all([
        mkdir(dirname(mainEntry), { recursive: true }),
        mkdir(bindingRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(mainRoot, "package.json"),
          `${JSON.stringify({
            name: "rolldown",
            type: "module",
            version: "1.0.0",
            optionalDependencies: {
              [bindingName]: "1.0.0",
              "@rolldown/binding-linux-x64": "1.0.0",
            },
          })}\n`,
        ),
        writeFile(mainEntry, "export const rolldown = true;\n"),
        writeFile(
          join(bindingRoot, "package.json"),
          `${JSON.stringify({
            name: bindingName,
            version: "1.0.0",
            main: "binding.node",
          })}\n`,
        ),
        writeFile(bindingPath, Buffer.from([0, 1, 2, 3])),
      ]);

      const specifier = pathToFileURL(mainEntry).href;
      const first = await inspectRolldownRuntimeIdentity(specifier);
      const identical = await inspectRolldownRuntimeIdentity(specifier);
      await writeFile(bindingPath, Buffer.from([3, 2, 1, 0]));
      const changedBinding = await inspectRolldownRuntimeIdentity(specifier);

      expect(identical).toEqual(first);
      expect(first.resolvedEntrySha256).toBe(changedBinding.resolvedEntrySha256);
      expect(first.packageContentSha256).toBe(changedBinding.packageContentSha256);
      expect(first.optionalBindingPackages).toEqual([
        {
          name: bindingName,
          version: "1.0.0",
          packageRootPath: await realpath(bindingRoot),
          packageJsonPath: await realpath(join(bindingRoot, "package.json")),
          contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown as string,
          contentFiles: ["binding.node", "package.json"],
        },
      ]);
      expect(changedBinding.optionalBindingPackages[0]?.contentSha256).not.toBe(
        first.optionalBindingPackages[0]?.contentSha256,
      );

      const generated = generateCase(7, DEFAULT_CASE_SIZE);
      const base = failedCase(generated);
      expect(failureArtifactPath({ ...base, runtimeIdentity: first }, root, 0)).not.toBe(
        failureArtifactPath({ ...base, runtimeIdentity: changedBinding }, root, 0),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
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
  test("writes identical canonical trace JSON for different transport metadata", async () => {
    const firstDirectory = await mkdtemp(join(tmpdir(), "order-cli-canonical-trace-a-"));
    const secondDirectory = await mkdtemp(join(tmpdir(), "order-cli-canonical-trace-b-"));
    const generated = generateCase(7, DEFAULT_CASE_SIZE);
    const firstTrace = parseStrictExecutionOrderPlanReady({
      ...orderTraceAction(),
      timestamp: 100,
      session_id: "session-a",
      build_id: "build-a",
      transport_detail: "discard-a",
    });
    const secondTrace = parseStrictExecutionOrderPlanReady({
      ...orderTraceAction(),
      timestamp: 200,
      session_id: "session-b",
      build_id: "build-b",
      transport_detail: "discard-b",
    });
    const firstResult = {
      ...failedCase(generated),
      options: campaignOptions({ seed: generated.seed, outDir: firstDirectory }),
      orderTrace: firstTrace,
    } satisfies CampaignCaseResult;
    const secondResult = {
      ...failedCase(generated),
      options: campaignOptions({ seed: generated.seed, outDir: secondDirectory }),
      orderTrace: secondTrace,
    } satisfies CampaignCaseResult;

    try {
      const [firstArtifact, secondArtifact] = await Promise.all([
        writeFailureArtifacts(firstResult, firstDirectory, 0),
        writeFailureArtifacts(secondResult, secondDirectory, 0),
      ]);
      const [firstJson, secondJson] = await Promise.all([
        readFile(join(firstArtifact, "order-trace.json"), "utf8"),
        readFile(join(secondArtifact, "order-trace.json"), "utf8"),
      ]);

      expect(firstJson).toBe(secondJson);
      expect(firstJson).toBe(`${JSON.stringify(firstTrace, null, 2)}\n`);
    } finally {
      await Promise.all([
        rm(firstDirectory, { recursive: true, force: true }),
        rm(secondDirectory, { recursive: true, force: true }),
      ]);
    }
  });

  test("writes the collected order trace and preserves the opt-out in replay metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-trace-artifact-"));
    const generated = generateCase(7, DEFAULT_CASE_SIZE);
    const result = {
      ...failedCase(generated),
      options: campaignOptions({
        seed: generated.seed,
        outDir: directory,
        collectOrderTrace: false,
      }),
      orderTrace: orderTraceAction(),
    } satisfies CampaignCaseResult;

    try {
      const artifactDirectory = await writeFailureArtifacts(result, directory, 0);

      await expect(readJson(join(artifactDirectory, "order-trace.json"))).resolves.toEqual(
        orderTraceAction(),
      );
      await expect(readJson(join(artifactDirectory, "replay.json"))).resolves.toMatchObject({
        command: expect.arrayContaining(["--no-order-trace"]),
        options: {
          collectOrderTrace: false,
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
      const identity = (await readJson(join(artifactDirectory, "identity.json"))) as {
        readonly inputs: {
          readonly renderedSourceFiles: readonly {
            readonly path: string;
            readonly sha256: string;
          }[];
          readonly sourceManifest: { readonly sha256: string; readonly value: unknown };
          readonly bundleManifest: { readonly sha256: string; readonly value: unknown };
        };
      };
      const expectedRenderedSourcePaths = result.rendered.files.map((file) => file.path).sort();

      expect(artifactDirectory).toBe(expectedArtifactDirectory);
      expect(artifactHash).toMatch(/^[a-f0-9]{64}$/);
      expect(identity.inputs.renderedSourceFiles.map((file) => file.path)).toEqual(
        expectedRenderedSourcePaths,
      );
      expect(expectedRenderedSourcePaths).not.toContain("runtime.cjs");
      expect(expectedRenderedSourcePaths).toHaveLength(generated.program.modules.length + 1);
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
        runtimeIdentity: result.runtimeIdentity,
        renderedSourceFiles: identity.inputs.renderedSourceFiles,
        sourceManifest: {
          path: result.rendered.schedulePath,
          sha256: identity.inputs.sourceManifest.sha256,
        },
        bundleManifest: {
          path: result.rendered.schedulePath,
          sha256: identity.inputs.bundleManifest.sha256,
          isNull: false,
        },
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
          runtimeIdentity: result.runtimeIdentity,
          renderedSourceFiles: identity.inputs.renderedSourceFiles,
          sourceManifest: {
            sha256: identity.inputs.sourceManifest.sha256,
            value: result.rendered.schedule,
          },
          bundleManifest: {
            sha256: identity.inputs.bundleManifest.sha256,
            value: result.bundleManifest,
          },
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
          collectOrderTrace: true,
        },
        runtimeIdentity: result.runtimeIdentity,
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

  test("records a deterministic null bundle manifest identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-null-manifest-"));
    const result = failedCase(generateCase(7, DEFAULT_CASE_SIZE));

    try {
      const artifactDirectory = await writeFailureArtifacts(result, directory, 3);
      await expect(readJson(join(artifactDirectory, "identity.json"))).resolves.toMatchObject({
        inputs: {
          bundleManifest: {
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown as string,
            value: null,
          },
        },
      });
      await expect(readJson(join(artifactDirectory, "case.json"))).resolves.toMatchObject({
        bundleManifest: {
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown as string,
          isNull: true,
        },
      });
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

  test("binds artifact identity to observed outcomes, traces, and emitted bytes", () => {
    const directory = "/tmp/order-cli-observed-identities";
    const generated = generateCase(7, DEFAULT_CASE_SIZE);
    const base = {
      ...failedCase(generated),
      verdict: {
        kind: "mismatch",
        reason: "events-mismatch",
        signature: "stable-signature",
      },
      bundleOutcome: ok([event("bundle", 1)]),
      bundleManifest: renderProgram(generated.program).schedule,
      bundleFiles: [{ path: "entry.js", contents: Buffer.from("first\n") }],
      orderTrace: orderTraceAction(),
    } as const satisfies CampaignCaseResult;
    const changedOutcome = {
      ...base,
      bundleOutcome: ok([event("bundle", 2)]),
    } satisfies CampaignCaseResult;
    const changedTrace = {
      ...base,
      orderTrace: {
        ...orderTraceAction(),
        plan_modules: [{ module_id: "/project/changed.js", reasons: ["direct-violation"] }],
      },
    } satisfies CampaignCaseResult;
    const changedBytes = {
      ...base,
      bundleFiles: [{ path: "entry.js", contents: Buffer.from("second\n") }],
    } satisfies CampaignCaseResult;
    const changedSource = {
      ...base,
      rendered: {
        ...base.rendered,
        files: base.rendered.files.map((file, index) =>
          index === 0 ? { ...file, contents: `${file.contents}// changed\n` } : file,
        ),
      },
    } satisfies CampaignCaseResult;
    const changedBundleManifest = {
      ...base,
      bundleManifest: {
        ...base.bundleManifest,
        entries: base.bundleManifest.entries.map((entry, index) =>
          index === 0 ? { ...entry, path: `${entry.path}.changed` } : entry,
        ),
      },
    } satisfies CampaignCaseResult;

    expect(
      new Set(
        [
          base,
          changedOutcome,
          changedTrace,
          changedBytes,
          changedSource,
          changedBundleManifest,
        ].map((result) => failureArtifactPath(result, directory, 3)),
      ).size,
    ).toBe(6);
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
    collectOrderTrace: true,
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
    orderTrace: null,
    runtimeIdentity: testRuntimeIdentity(),
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
    orderTrace: null,
    runtimeIdentity: testRuntimeIdentity(),
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

function testRuntimeIdentity(requestedPackageSpecifier = "rolldown"): ObservedRuntimeIdentity {
  return {
    processVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    requestedPackageSpecifier,
    resolvedEntryUrl: null,
    resolvedEntryPath: null,
    packageVersion: null,
    resolvedEntrySha256: null,
    packageRootPath: null,
    packageJsonPath: null,
    packageContentSha256: null,
    packageContentFiles: [],
    fuzzerLockfilePath: null,
    fuzzerLockfileSha256: null,
    optionalBindingPackages: [],
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function orderTraceAction() {
  return {
    action: "StrictExecutionOrderPlanReady",
    version: 1,
    roots: [
      {
        root_module_id: "/project/entry.js",
        expected_order: ["/project/entry.js"],
        predicted_pre_wrap_order: ["/project/entry.js"],
        at_risk_modules: [],
      },
    ],
    plan_modules: [{ module_id: "/project/entry.js", reasons: ["direct-violation"] }],
    included_modules: [
      {
        module_id: "/project/entry.js",
        original_wrap_kind: "none",
        final_wrap_kind: "esm",
        final_chunk_id: 1,
        entry_chunk_id: 1,
        wrapper_included: true,
        tla_tainted: false,
      },
    ],
    rendered_chunks: [
      {
        chunk_id: 1,
        module_ids: ["/project/entry.js"],
        static_chunk_imports: [],
        dynamic_chunk_imports: [],
      },
    ],
    init_obligations: [],
  } as const;
}
