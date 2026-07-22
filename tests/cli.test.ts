/// <reference types="node" />

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
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

import {
  generateAuthoredNameCollisionCase,
  generateCase,
  type GeneratedCase,
} from "../src/generate.ts";
import { buildConfigOf, packagesOf } from "../src/model.ts";
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
import type { ExecutionOutcome } from "../src/protocol.ts";
import { renderProgram } from "../src/render.ts";
import {
  inspectRolldownRuntimeIdentity,
  withRolldownBuild,
  type ObservedRuntimeIdentity,
} from "../src/rolldown-adapter.ts";
import type { Verdict } from "../src/verdict.ts";

describe("parseCliArgs", () => {
  test("uses artifact schema version 25", () => {
    expect(FAILURE_ARTIFACT_SCHEMA_VERSION).toBe(25);
  });

  test("parses and validates --format-regime", () => {
    const options = parseCliArgs(["--format-regime", "pure-cjs"]);
    expect(options.formatRegime).toBe("pure-cjs");
    expect(parseCliArgs([]).formatRegime).toBeUndefined();
    expect(() => parseCliArgs(["--format-regime", "esm-only"])).toThrow(
      /--format-regime must be one of/,
    );
  });

  test("parses the complete campaign option set", () => {
    expect(
      parseCliArgs([
        "--seed",
        "4294967295",
        "--cases",
        "12",
        "--case-size",
        "9",
        "--rolldown-package",
        "file:///tmp/rolldown.mjs",
        "--out-dir",
        "artifacts",
        "--continue-on-fail",
      ]),
    ).toEqual({
      seed: 4_294_967_295,
      cases: 12,
      caseSize: 9,
      sizeMix: false,
      onDemandWrapping: true,
      rolldownPackage: "file:///tmp/rolldown.mjs",
      outDir: "artifacts",
      continueOnFail: true,
    });

    expect(parseCliArgs(["--stop-on-fail"])).toMatchObject({
      continueOnFail: false,
    });
  });

  test("enables the size mix by default and disables it when --case-size is given", () => {
    // No --case-size: the campaign draws each case's size from the small/medium/large spread.
    expect(parseCliArgs([])).toMatchObject({ sizeMix: true, caseSize: DEFAULT_CASE_SIZE });
    expect(parseCliArgs(["--seed", "7"])).toMatchObject({ sizeMix: true });
    // Explicit --case-size pins the size and turns the mix off.
    expect(parseCliArgs(["--case-size", "32"])).toMatchObject({ sizeMix: false, caseSize: 32 });
  });

  test("rejects unknown, missing, conflicting, and invalid arguments", () => {
    expect(() => parseCliArgs(["--unknown"])).toThrowError("Unknown argument: --unknown");
    expect(() => parseCliArgs(["--seed"])).toThrowError("Missing value for --seed");
    expect(() => parseCliArgs(["--seed", "-1"])).toThrowError(
      "--seed must be an unsigned 32-bit integer",
    );
    expect(() => parseCliArgs(["--cases", "0"])).toThrowError("--cases must be a positive integer");
    expect(() => parseCliArgs(["--case-size", "0"])).toThrowError(
      "--case-size must be an integer from 1 through 48",
    );
    expect(() => parseCliArgs(["--case-size", "49"])).toThrowError(
      "--case-size must be an integer from 1 through 48",
    );
    expect(parseCliArgs(["--case-size", "48"])).toMatchObject({ caseSize: 48, sizeMix: false });
    expect(parseCliArgs(["--wrap-all"])).toMatchObject({ onDemandWrapping: false });
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
        rendered: renderProgram(generated.analyzed),
        sourceOutcome,
        bundleOutcome,
        bundleManifest: null,
        bundleFiles: [],
        runtimeIdentity: testRuntimeIdentity(),
        verdict: classifyCampaignVerdict(sourceOutcome, bundleOutcome),
      }),
      writeFailure: async () => "failure",
      writeLine: () => {},
    });

    expect(summary).toEqual({ casesRun: 1, passed: 0, failed: 1, exitCode: 2 });
  });

  test("classifies a Rolldown build panic as a failing verdict, not a harness discard", async () => {
    const bundleOutcome = {
      status: "not-run",
      reason: "adapter-failure",
      adapterFailure: {
        status: "build-error",
        stage: "build",
        packageSpecifier: "rolldown",
        panic: true,
        error: {
          name: "RolldownBuildPanic",
          message: "Rolldown build process crashed with signal SIGABRT",
        },
      },
    } as const satisfies BundleNotRunOutcome;

    const verdict = classifyCampaignVerdict(ok([event("entry", 1)]), bundleOutcome);
    expect(verdict).toEqual({
      kind: "build-failure",
      reason: "panic",
      signature:
        'build-failure:panic:["RolldownBuildPanic","Rolldown build process crashed with signal SIGABRT"]',
    });

    // A panic fails the campaign as a real bug (exit code 1), never as a harness error (exit code 2).
    const generated = generateCase(100, DEFAULT_CASE_SIZE);
    const summary = await runCampaign(campaignOptions(), {
      executeCase: async () => ({
        generated,
        options: campaignOptions(),
        rendered: renderProgram(generated.analyzed),
        sourceOutcome: ok([event("entry", 1)]),
        bundleOutcome,
        bundleManifest: null,
        bundleFiles: [],
        runtimeIdentity: testRuntimeIdentity(),
        verdict,
      }),
      writeFailure: async () => "failure",
      writeLine: () => {},
    });

    expect(summary).toEqual({ casesRun: 1, passed: 0, failed: 1, exitCode: 1 });
  });

  test("classifies a MISSING_EXPORT link failure as a first-class build-failure:link catch", () => {
    // A Rolldown link-time resolution failure (the #10044 family): the linker cannot resolve an export
    // a retained consumer references. It classifies to a distinct `build-failure:link` verdict carrying
    // the missing (export, module) identity — NOT a generic build error and NOT a runtime crash — so a
    // link-time regression deduplicates to one signature and reads as a real, first-class catch.
    const bundleOutcome = {
      status: "not-run",
      reason: "adapter-failure",
      adapterFailure: {
        status: "build-error",
        stage: "build",
        packageSpecifier: "rolldown",
        error: {
          name: "Error",
          message:
            '[MISSING_EXPORT] "RESET" is not exported by "node_modules/@griffel/core/src/index.js".',
        },
      },
    } as const satisfies BundleNotRunOutcome;

    const verdict = classifyCampaignVerdict(ok([event("entry", 1)]), bundleOutcome);
    expect(verdict).toEqual({
      kind: "build-failure",
      reason: "link",
      signature: 'build-failure:link:["RESET","node_modules/@griffel/core/src/index.js"]',
    });
  });

  test("does NOT classify a harness-stage MISSING_EXPORT as a link failure (W14a.1)", () => {
    // A package that fails to LOAD with a message that merely CONTAINS MISSING_EXPORT is an environment
    // problem, never a Rolldown linker bug. Link detection is gated to a genuine BUILD-stage build error;
    // a harness-error at stage load-package keeps its stage identity, so the false `build-failure:link` no
    // longer poisons the artifacts / shrink / dedup (the CLI exit code already recovered separately).
    const bundleOutcome = {
      status: "not-run",
      reason: "adapter-failure",
      adapterFailure: {
        status: "harness-error",
        stage: "load-package",
        packageSpecifier: "rolldown",
        error: {
          name: "Error",
          message:
            '[MISSING_EXPORT] "RESET" is not exported by "node_modules/@griffel/core/src/index.js".',
        },
      },
    } as const satisfies BundleNotRunOutcome;

    const verdict = classifyCampaignVerdict(ok([event("entry", 1)]), bundleOutcome);
    expect(verdict.kind).toBe("build-failure");
    if (verdict.kind === "build-failure") {
      expect(verdict.reason).not.toBe("link");
      expect(verdict.reason).toBe("load-package");
      expect(verdict.signature.startsWith("build-failure:harness-error:load-package:")).toBe(true);
    }
  });

  test("classifies a build-stage MISSING_EXPORT with no parseable identity as build-failure:link:unknown", () => {
    // A link failure whose message carries only the MISSING_EXPORT code (no `"X" is not exported by "Y"`
    // phrase) is still a link failure, but with no parseable (export, module) identity. It gets a STABLE
    // identity-free signature — not the old fabricated `("<unknown>", <whole message>)` pair whose volatile
    // message defeated deduplication.
    const bundleOutcome = {
      status: "not-run",
      reason: "adapter-failure",
      adapterFailure: {
        status: "build-error",
        stage: "build",
        packageSpecifier: "rolldown",
        error: { name: "MISSING_EXPORT", message: "the linker could not resolve an export" },
      },
    } as const satisfies BundleNotRunOutcome;

    const verdict = classifyCampaignVerdict(ok([event("entry", 1)]), bundleOutcome);
    expect(verdict).toEqual({
      kind: "build-failure",
      reason: "link",
      signature: "build-failure:link:unknown",
    });
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

  test("case-owned wrapping overrides the campaign mode and is persisted", async () => {
    const generated = generateAuthoredNameCollisionCase(1, "__esmMin");
    const options = campaignOptions({ onDemandWrapping: true });
    let builtWithOnDemand: boolean | undefined;

    const result = await executeGeneratedCase(generated, options, {
      executeSource: async () => ok([]),
      buildBundle: async (_program, rendered, executionOptions) => {
        builtWithOnDemand = executionOptions.onDemandWrapping;
        return {
          status: "ok",
          value: {
            bundleOutcome: ok([]),
            bundleManifest: rendered.schedule,
            bundleFiles: [],
            runtimeIdentity: testRuntimeIdentity(),
          },
        };
      },
    });

    expect(generated.onDemandWrapping).toBe(false);
    expect(options.onDemandWrapping).toBe(true);
    expect(builtWithOnDemand).toBe(false);
    expect(result.options.onDemandWrapping).toBe(false);
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
      expect(failureArtifactPath(first, directory, 0)).toBe(
        failureArtifactPath(second, directory, 0),
      );
      const firstArtifact = await writeFailureArtifacts(first, join(directory, "first"), 0);
      const secondArtifact = await writeFailureArtifacts(second, join(directory, "second"), 0);
      const firstPersistedOutcome = await readFile(
        join(firstArtifact, "bundle-outcome.json"),
        "utf8",
      );
      const secondPersistedOutcome = await readFile(
        join(secondArtifact, "bundle-outcome.json"),
        "utf8",
      );
      expect(secondPersistedOutcome).toBe(firstPersistedOutcome);
      expect(firstPersistedOutcome).toContain("<rolldown-root>/source/");
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
    // The fake package reports exactly one entry chunk, so pick a one-entry case.
    const generated = findGeneratedCase(
      (candidate) => candidate.program.entries.length === 1,
      "single-entry case",
    );
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
        napiRsNativeLibrary: {
          requested: null,
          loaderPath: null,
          loaderCandidates: [],
          resolvedPath: null,
          realPath: null,
          sha256: null,
        },
      });

      const artifactDirectory = await writeFailureArtifacts(result, directory, 0);
      await expect(
        readFile(join(artifactDirectory, "bundle/entries/__entry_0000.js"), "utf8"),
      ).resolves.toBe("export const emitted = true;\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("persists a harness failure when reported output files are missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-missing-output-"));
    const packagePath = join(directory, "rolldown.mjs");
    await writeFile(
      packagePath,
      [
        "export async function rolldown(inputOptions) {",
        "  return {",
        "    async write() {",
        "      return {",
        "        output: [{",
        '          type: "chunk",',
        '          fileName: "entries/__entry_0000.js",',
        '          name: "__entry_0000",',
        "          isEntry: true,",
        "          facadeModuleId: Object.values(inputOptions.input)[0],",
        "        }],",
        "      };",
        "    },",
        "    async close() {},",
        "  };",
        "}",
        "",
      ].join("\n"),
    );
    // The fake package reports exactly one entry chunk, so pick a one-entry case.
    const generated = findGeneratedCase(
      (candidate) => candidate.program.entries.length === 1,
      "single-entry case",
    );
    const options = campaignOptions({
      seed: generated.seed,
      rolldownPackage: pathToFileURL(packagePath).href,
      outDir: directory,
    });

    try {
      const result = await executeGeneratedCase(generated, options);

      expect(result.verdict).toMatchObject({
        kind: "build-failure",
        reason: "consume-output",
      });
      expect(result.bundleManifest).not.toBeNull();
      expect(result.bundleFiles).toEqual([]);

      const artifactDirectory = await writeFailureArtifacts(result, directory, 0);
      await expect(readJson(join(artifactDirectory, "bundle-outcome.json"))).resolves.toMatchObject(
        {
          status: "not-run",
          reason: "adapter-failure",
          adapterFailure: {
            status: "harness-error",
            stage: "consume-output",
            error: { name: "Error" },
          },
        },
      );
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
    const rendered = renderProgram(generated.analyzed);
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
    const nativeTargetRoot = await mkdtemp(join(tmpdir(), "order-runtime-binding-target-"));
    const bindingPath = join(bindingRoot, "binding.node");
    const bindingTargetPath = join(nativeTargetRoot, "binding.node");
    const retargetedBindingPath = join(nativeTargetRoot, "retargeted-binding.node");
    const ignoredLinkPath = join(bindingRoot, "ignored.js");
    const ignoredTargetPath = join(nativeTargetRoot, "ignored.js");
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
        writeFile(bindingTargetPath, Buffer.from([0, 1, 2, 3])),
        writeFile(retargetedBindingPath, Buffer.from([0, 1, 2, 3])),
        writeFile(ignoredTargetPath, "ignored = 1;\n"),
      ]);
      await Promise.all([
        symlink(bindingTargetPath, bindingPath),
        symlink(ignoredTargetPath, ignoredLinkPath),
      ]);

      const specifier = pathToFileURL(mainEntry).href;
      const first = await inspectRolldownRuntimeIdentity(specifier);
      const identical = await inspectRolldownRuntimeIdentity(specifier);
      await rm(bindingPath);
      await symlink(retargetedBindingPath, bindingPath);
      const retargetedBinding = await inspectRolldownRuntimeIdentity(specifier);
      await writeFile(retargetedBindingPath, Buffer.from([3, 2, 1, 0]));
      const changedBinding = await inspectRolldownRuntimeIdentity(specifier);
      await writeFile(ignoredTargetPath, "ignored = 2;\n");
      const ignoredChange = await inspectRolldownRuntimeIdentity(specifier);

      expect(identical).toEqual(first);
      expect(first.resolvedEntrySha256).toBe(changedBinding.resolvedEntrySha256);
      expect(first.packageContentSha256).toBe(changedBinding.packageContentSha256);
      expect(retargetedBinding.optionalBindingPackages[0]?.contentSha256).not.toBe(
        first.optionalBindingPackages[0]?.contentSha256,
      );
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
        retargetedBinding.optionalBindingPackages[0]?.contentSha256,
      );
      expect(ignoredChange.optionalBindingPackages).toEqual(changedBinding.optionalBindingPackages);

      const generated = generateCase(7, DEFAULT_CASE_SIZE);
      const base = failedCase(generated);
      expect(failureArtifactPath({ ...base, runtimeIdentity: first }, root, 0)).not.toBe(
        failureArtifactPath({ ...base, runtimeIdentity: retargetedBinding }, root, 0),
      );
      expect(
        failureArtifactPath({ ...base, runtimeIdentity: retargetedBinding }, root, 0),
      ).not.toBe(failureArtifactPath({ ...base, runtimeIdentity: changedBinding }, root, 0));
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(nativeTargetRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("resolves NAPI_RS_NATIVE_LIBRARY_PATH from the generated binding loader", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "order-runtime-override-package-"));
    const targetRoot = await mkdtemp(join(tmpdir(), "order-runtime-override-target-"));
    const entryPath = join(packageRoot, "dist/index.mjs");
    const loaderPath = join(packageRoot, "dist/shared/binding-test.mjs");
    const secondLoaderPath = join(packageRoot, "dist/shared/binding-other.mjs");
    const publicOverridePath = join(packageRoot, "dist/override.node");
    const loaderOverrideLinkPath = join(packageRoot, "dist/shared/override.node");
    const loaderOverrideTargetPath = join(targetRoot, "override.node");
    const previousOverride = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;

    try {
      await mkdir(dirname(loaderPath), { recursive: true });
      await Promise.all([
        writeFile(
          join(packageRoot, "package.json"),
          `${JSON.stringify({ type: "module", version: "1.0.0" })}\n`,
        ),
        writeFile(entryPath, "export const rolldown = true;\n"),
        writeFile(
          loaderPath,
          "const nativePath = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;\nexport { nativePath };\n",
        ),
        writeFile(publicOverridePath, Buffer.from([9, 9, 9, 9])),
        writeFile(loaderOverrideTargetPath, Buffer.from([0, 1, 2, 3])),
      ]);
      await symlink(loaderOverrideTargetPath, loaderOverrideLinkPath);
      process.env.NAPI_RS_NATIVE_LIBRARY_PATH = "./override.node";

      const specifier = pathToFileURL(entryPath).href;
      const first = await inspectRolldownRuntimeIdentity(specifier);
      const resolvedOverride = createRequire(loaderPath).resolve("./override.node");
      await writeFile(publicOverridePath, Buffer.from([8, 8, 8, 8]));
      const changedPublic = await inspectRolldownRuntimeIdentity(specifier);
      await writeFile(loaderOverrideTargetPath, Buffer.from([3, 2, 1, 0]));
      const changedLoader = await inspectRolldownRuntimeIdentity(specifier);

      expect(first.napiRsNativeLibrary).toEqual({
        requested: "./override.node",
        loaderPath: await realpath(loaderPath),
        loaderCandidates: [await realpath(loaderPath)],
        resolvedPath: resolvedOverride,
        realPath: await realpath(resolvedOverride),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown as string,
      });
      expect(changedPublic.napiRsNativeLibrary).toEqual(first.napiRsNativeLibrary);
      expect(changedLoader.napiRsNativeLibrary.sha256).not.toBe(first.napiRsNativeLibrary.sha256);

      const generated = generateCase(7, DEFAULT_CASE_SIZE);
      const base = failedCase(generated);
      expect(failureArtifactPath({ ...base, runtimeIdentity: first }, packageRoot, 0)).not.toBe(
        failureArtifactPath({ ...base, runtimeIdentity: changedLoader }, packageRoot, 0),
      );

      await writeFile(loaderPath, "export const withoutMarker = true;\n");
      const noMarker = await inspectRolldownRuntimeIdentity(specifier);
      expect(noMarker.napiRsNativeLibrary).toEqual({
        requested: "./override.node",
        loaderPath: null,
        loaderCandidates: [],
        resolvedPath: null,
        realPath: null,
        sha256: null,
      });

      await Promise.all([
        writeFile(
          loaderPath,
          "const first = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;\nexport { first };\n",
        ),
        writeFile(
          secondLoaderPath,
          "const second = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;\nexport { second };\n",
        ),
      ]);
      const ambiguous = await inspectRolldownRuntimeIdentity(specifier);
      expect(ambiguous.napiRsNativeLibrary).toEqual({
        requested: "./override.node",
        loaderPath: null,
        loaderCandidates: [await realpath(secondLoaderPath), await realpath(loaderPath)].sort(),
        resolvedPath: null,
        realPath: null,
        sha256: null,
      });
    } finally {
      if (previousOverride === undefined) {
        delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
      } else {
        process.env.NAPI_RS_NATIVE_LIBRARY_PATH = previousOverride;
      }
      await Promise.all([
        rm(packageRoot, { recursive: true, force: true }),
        rm(targetRoot, { recursive: true, force: true }),
      ]);
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

      // Installed Rolldown may genuinely fail generated cases; this test verifies the
      // campaign plumbing, so it accepts real verdicts and rejects only harness noise.
      expect(summary.casesRun).toBe(9);
      expect(summary.passed + summary.failed).toBe(9);
      expect(summary.exitCode).toBe(summary.failed === 0 ? 0 : 1);
      expect(lines.at(-1)).toBe(`summary cases=9 pass=${summary.passed} fail=${summary.failed}`);
      for (const line of lines.slice(0, -1)) {
        expect(line).toMatch(/^(PASS|FAIL) case=\d+ seed=\d+ template=/);
        expect(line).not.toContain("harness-error");
      }
      for (let seed = 0; seed < 9; seed += 1) {
        const expectedTemplate = generateCase(seed, DEFAULT_CASE_SIZE).template;
        expect(
          lines.some(
            (line) =>
              line.includes(` seed=${seed} `) && line.includes(`template=${expectedTemplate}`),
          ),
        ).toBe(true);
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
      const identity = (await readJson(join(artifactDirectory, "identity.json"))) as {
        readonly inputs: {
          readonly renderedSourceFiles: readonly {
            readonly path: string;
            readonly sha256: string;
          }[];
          readonly sourceManifest: { readonly sha256: string; readonly value: unknown };
          readonly bundleManifest: { readonly sha256: string; readonly value: unknown };
          readonly buildOptions: { readonly treeshake: unknown };
        };
      };
      const expectedRenderedSourcePaths = result.rendered.files.map((file) => file.path).sort();

      expect(artifactDirectory).toBe(expectedArtifactDirectory);
      expect(artifactHash).toMatch(/^[a-f0-9]{64}$/);
      expect(identity.inputs.renderedSourceFiles.map((file) => file.path)).toEqual(
        expectedRenderedSourcePaths,
      );
      expect(identity.inputs.buildOptions.treeshake).toEqual(
        buildConfigOf(generated.program).treeshake,
      );
      expect(expectedRenderedSourcePaths).not.toContain("runtime.cjs");
      // One rendered file per module plus schedule.json, and one generated package.json per
      // resolved package (W14b: the packages view, through the one packagesOf seam).
      expect(expectedRenderedSourcePaths).toHaveLength(
        generated.program.modules.length + 1 + packagesOf(generated.program).length,
      );
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
          buildOptions: {
            treeshake: buildConfigOf(generated.program).treeshake,
          },
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
          "--case-size",
          String(generated.size),
          "--rolldown-package",
          "rolldown",
          "--out-dir",
          directory,
          "--stop-on-fail",
        ],
        options: {
          seed: generated.seed,
          cases: 1,
          caseSize: generated.size,
          sizeMix: false,
          onDemandWrapping: true,
          rolldownPackage: options.rolldownPackage,
          outDir: directory,
          continueOnFail: false,
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

  test("rejects an existing incomplete final artifact without overwriting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-existing-"));
    const generated = generateCase(7, DEFAULT_CASE_SIZE);
    const result = failedCase(generated);
    const finalDirectory = failureArtifactPath(result, directory, 3);

    try {
      await mkdir(finalDirectory, { recursive: true });
      await writeFile(join(finalDirectory, "existing.txt"), "keep\n");

      await expect(writeFailureArtifacts(result, directory, 3)).rejects.toThrow(
        "Existing failure artifact is incomplete or has a different identity",
      );
      await expect(readFile(join(finalDirectory, "existing.txt"), "utf8")).resolves.toBe("keep\n");
      await expect(access(join(finalDirectory, "model.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await readdir(directory)).filter((name) => name.startsWith(".case-"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects an existing artifact whose persisted contents were modified", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-tampered-"));
    const generated = generateCase(7, DEFAULT_CASE_SIZE);
    const result = failedCase(generated);

    try {
      const artifactDirectory = await writeFailureArtifacts(result, directory, 3);
      await writeFile(join(artifactDirectory, "signature.txt"), "tampered\n");

      await expect(writeFailureArtifacts(result, directory, 3)).rejects.toThrow(
        "Existing failure artifact is incomplete or has a different identity",
      );
      await expect(readFile(join(artifactDirectory, "signature.txt"), "utf8")).resolves.toBe(
        "tampered\n",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects unexpected files and symlink-backed files in an existing artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-artifact-shape-"));
    const generated = generateCase(7, DEFAULT_CASE_SIZE);
    const result = failedCase(generated);

    try {
      const artifactDirectory = await writeFailureArtifacts(result, directory, 3);
      await writeFile(join(artifactDirectory, "unexpected.txt"), "unexpected\n");
      await expect(writeFailureArtifacts(result, directory, 3)).rejects.toThrow(
        "Existing failure artifact is incomplete or has a different identity",
      );

      await rm(join(artifactDirectory, "unexpected.txt"));
      const signaturePath = join(artifactDirectory, "signature.txt");
      const signatureTarget = join(directory, "signature-target.txt");
      await writeFile(signatureTarget, `${result.verdict.signature}\n`);
      await rm(signaturePath);
      await symlink(signatureTarget, signaturePath);
      await expect(writeFailureArtifacts(result, directory, 3)).rejects.toThrow(
        "Existing failure artifact is incomplete or has a different identity",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects an existing artifact path that is itself a symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-cli-artifact-root-link-"));
    const targetDirectory = await mkdtemp(join(tmpdir(), "order-cli-artifact-root-target-"));
    const generated = generateCase(7, DEFAULT_CASE_SIZE);
    const result = failedCase(generated);
    const artifactDirectory = failureArtifactPath(result, directory, 3);

    try {
      const targetArtifact = await writeFailureArtifacts(result, targetDirectory, 3);
      await symlink(targetArtifact, artifactDirectory);

      await expect(writeFailureArtifacts(result, directory, 3)).rejects.toThrow(
        "Existing failure artifact is incomplete or has a different identity",
      );
    } finally {
      await Promise.all([
        rm(directory, { recursive: true, force: true }),
        rm(targetDirectory, { recursive: true, force: true }),
      ]);
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

  test("binds artifact identity to observed outcomes and emitted bytes", () => {
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
      bundleManifest: renderProgram(generated.analyzed).schedule,
      bundleFiles: [{ path: "entry.js", contents: Buffer.from("first\n") }],
    } as const satisfies CampaignCaseResult;
    const changedOutcome = {
      ...base,
      bundleOutcome: ok([event("bundle", 2)]),
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
        [base, changedOutcome, changedBytes, changedSource, changedBundleManifest].map((result) =>
          failureArtifactPath(result, directory, 3),
        ),
      ).size,
    ).toBe(5);
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
    caseSize: DEFAULT_CASE_SIZE,
    sizeMix: false,
    onDemandWrapping: true,
    rolldownPackage: "rolldown",
    outDir: "failures",
    continueOnFail: false,
    ...overrides,
  };
}

function passedCase(generated: GeneratedCase): CampaignCaseResult {
  const rendered = renderProgram(generated.analyzed);
  return {
    generated,
    options: campaignOptions({ seed: generated.seed }),
    rendered,
    sourceOutcome: ok([]),
    bundleOutcome: ok([]),
    bundleManifest: rendered.schedule,
    bundleFiles: [],
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
    rendered: renderProgram(generated.analyzed),
    sourceOutcome,
    bundleOutcome,
    bundleManifest: null,
    bundleFiles: [],
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
    napiRsNativeLibrary: {
      requested: null,
      loaderPath: null,
      loaderCandidates: [],
      resolvedPath: null,
      realPath: null,
      sha256: null,
    },
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

function findGeneratedCase(
  matches: (candidate: GeneratedCase) => boolean,
  description: string,
): GeneratedCase {
  for (let seed = 0; seed < 1_000; seed += 1) {
    const candidate = generateCase(seed, DEFAULT_CASE_SIZE);
    if (matches(candidate)) {
      return candidate;
    }
  }
  throw new Error(`No ${description} found within 1000 seeds`);
}
