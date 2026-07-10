/// <reference types="node" />

/// FW-C — the STANDING VERSION-BRACKETED REGRESSION RED-SET runner.
///
/// Each entry in `regression/index.json` is a shape proven RED on the released rolldown BEFORE a
/// historical fix and GREEN AT/after it. For every entry this runner:
///
///   1. acquires the red and green npm targets into a reusable cache
///      (`/tmp/order-fuzzer-regression-targets/<version>`, one isolated `npm install rolldown@<v>`
///      per version so the platform-specific native binding — a SEPARATE optional-dependency
///      package — resolves; a bare `npm pack` tarball is not runnable). RED-0's green target is a
///      LOCAL PR-snapshot path, not an npm version.
///   2. runs the entry's model through the NORMAL executeProgram path (generator form) or builds the
///      raw fixture with the target's rolldown and runs its own `_test.mjs` (raw form) against BOTH
///      targets, and asserts the red target reproduces the manifest's normalized signature and the
///      green target passes.
///
/// It writes a machine-readable evidence file (`EVIDENCE_OUT`, default
/// `.agents/evidence/regression-redset.json`): per-entry verdicts, each target's dist sha256, the
/// node version, and the HEAD hash + dirty status — so the red/green proof is reproducible from a
/// committed record. Non-zero exit on any bracket violation.
///
/// NOT part of `vp test` (it needs network to acquire the npm targets and out-of-tree builds). Run:
///
///   npm run regression:redset            # all entries
///   npm run regression:redset RED-2      # a single entry by id
///
/// See `.agents/docs/regression-red-set.md` for what it is, how to run, and how to add an entry.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  generateCrossChunkInitCycleCase,
  generateCrossEntryLeakCase,
  type GeneratedCase,
} from "../src/generate.ts";
import { executeProgram } from "../src/program-run.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGRESSION_DIR = resolve(REPO_ROOT, "regression");
const MANIFEST_PATH = process.env.REDSET_MANIFEST ?? resolve(REGRESSION_DIR, "index.json");
const CACHE_ROOT = process.env.REDSET_TARGET_CACHE ?? "/tmp/order-fuzzer-regression-targets";
const EVIDENCE_OUT_ENV = process.env.EVIDENCE_OUT;
/// A raw fixture builds and runs in seconds; a hang (e.g. a future infinite-looping bundle) must not
/// stall the runner. On timeout spawnSync sets `error`, which the raw path already maps to a
/// non-green harness verdict — a VIOLATION, never a false HOLD.
const RAW_SPAWN_TIMEOUT_MS = 120_000;

/// The generators a `form: "generator"` entry may name. Adding a new generator-form bracket means
/// registering its generator function here (see the docs' "how to add an entry"); a raw-form bracket
/// needs no registration.
const GENERATORS: Readonly<Record<string, (seed: number) => GeneratedCase>> = {
  generateCrossChunkInitCycleCase,
  generateCrossEntryLeakCase,
};

// ---------------------------------------------------------------------------------------------------
// Manifest model + parsing (unit-testable, no network)
// ---------------------------------------------------------------------------------------------------

export type TargetRef =
  | { readonly kind: "npm"; readonly version: string }
  | { readonly kind: "snapshot" }
  | { readonly kind: "path"; readonly path: string };

export interface RedsetEntry {
  readonly id: string;
  readonly issue: number;
  readonly cluster: string;
  readonly title: string;
  readonly form: "generator" | "raw";
  /// generator form
  readonly generator?: string;
  readonly seed?: number;
  readonly onDemandWrapping?: boolean;
  /// raw form
  readonly dir?: string;
  readonly redTarget: TargetRef;
  readonly greenTarget: TargetRef;
  readonly expectedRedSignature: string;
  /// When true, the bug is still OPEN on the green target too (no fixed build exists YET): the bracket
  /// HOLDs when the RED reproduces on BOTH targets, and the green target is NOT required to pass. When a
  /// fix lands the green target flips and `bracketPending` is dropped, graduating it to a normal bracket.
  readonly bracketPending?: boolean;
  readonly provenance: Readonly<Record<string, string>>;
}

export interface RedsetManifest {
  readonly schema: number;
  readonly title: string;
  readonly description: string;
  readonly miningDoc: string;
  readonly greenSnapshot: { readonly id: string; readonly path: string; readonly note?: string };
  readonly entries: readonly RedsetEntry[];
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`${path}: expected a string`);
  }
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path}: expected a finite number`);
  }
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path}: expected a boolean`);
  }
  return value;
}

function parseTargetRef(value: unknown, path: string): TargetRef {
  const record = asRecord(value, path);
  const kind = asString(record.kind, `${path}.kind`);
  if (kind === "npm") {
    return { kind: "npm", version: asString(record.version, `${path}.version`) };
  }
  if (kind === "snapshot") {
    return { kind: "snapshot" };
  }
  if (kind === "path") {
    return { kind: "path", path: asString(record.path, `${path}.path`) };
  }
  throw new Error(`${path}.kind: unknown target kind ${JSON.stringify(kind)}`);
}

function parseProvenance(value: unknown, path: string): Record<string, string> {
  const record = asRecord(value, path);
  const provenance: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    provenance[key] = asString(entry, `${path}.${key}`);
  }
  return provenance;
}

function parseEntry(value: unknown, index: number): RedsetEntry {
  const path = `entries[${index}]`;
  const record = asRecord(value, path);
  const form = asString(record.form, `${path}.form`);
  if (form !== "generator" && form !== "raw") {
    throw new Error(`${path}.form: expected "generator" | "raw", received ${JSON.stringify(form)}`);
  }
  const base = {
    id: asString(record.id, `${path}.id`),
    issue: asNumber(record.issue, `${path}.issue`),
    cluster: asString(record.cluster, `${path}.cluster`),
    title: asString(record.title, `${path}.title`),
    form,
    redTarget: parseTargetRef(record.redTarget, `${path}.redTarget`),
    greenTarget: parseTargetRef(record.greenTarget, `${path}.greenTarget`),
    expectedRedSignature: asString(record.expectedRedSignature, `${path}.expectedRedSignature`),
    ...(record.bracketPending === undefined
      ? {}
      : { bracketPending: asBoolean(record.bracketPending, `${path}.bracketPending`) }),
    provenance: parseProvenance(record.provenance, `${path}.provenance`),
  } as const;
  if (form === "generator") {
    return {
      ...base,
      generator: asString(record.generator, `${path}.generator`),
      seed: record.seed === undefined ? 0 : asNumber(record.seed, `${path}.seed`),
      onDemandWrapping:
        record.onDemandWrapping === undefined
          ? true
          : asBoolean(record.onDemandWrapping, `${path}.onDemandWrapping`),
    };
  }
  return { ...base, dir: asString(record.dir, `${path}.dir`) };
}

/// Parse and validate the red-set manifest (untrusted JSON). Throws a precise, path-qualified error
/// on any structural problem — exercised by the unit tests without touching the network.
export function parseManifest(raw: unknown): RedsetManifest {
  const record = asRecord(raw, "manifest");
  const schema = asNumber(record.schema, "schema");
  if (schema !== 1) {
    throw new Error(`unsupported manifest schema ${schema} (expected 1)`);
  }
  const snapshotRecord = asRecord(record.greenSnapshot, "greenSnapshot");
  const greenSnapshot = {
    id: asString(snapshotRecord.id, "greenSnapshot.id"),
    path: asString(snapshotRecord.path, "greenSnapshot.path"),
    ...(snapshotRecord.note === undefined
      ? {}
      : { note: asString(snapshotRecord.note, "greenSnapshot.note") }),
  };
  const entriesRaw = record.entries;
  if (!Array.isArray(entriesRaw)) {
    throw new Error("entries: expected an array");
  }
  const entries = entriesRaw.map((entry, index) => parseEntry(entry, index));
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      throw new Error(`duplicate entry id ${JSON.stringify(entry.id)}`);
    }
    seenIds.add(entry.id);
    if (entry.form === "generator" && entry.generator === undefined) {
      throw new Error(`${entry.id}: a generator-form entry requires "generator"`);
    }
    if (entry.form === "raw" && entry.dir === undefined) {
      throw new Error(`${entry.id}: a raw-form entry requires "dir"`);
    }
  }
  return {
    schema,
    title: asString(record.title, "title"),
    description: asString(record.description, "description"),
    miningDoc: asString(record.miningDoc, "miningDoc"),
    greenSnapshot,
    entries,
  };
}

/// Normalize a red signature so a bracket stays comparable across builds/versions: collapse the
/// Rolldown content-hash chunk-id suffix a crash message may quote (e.g. `shared-Bx2qtI_L.js`,
/// `rolldown-runtime-DudxFV0I.mjs`) to a stable placeholder. The signatures the current brackets
/// produce carry NO hash (a stable `init_shared` / `init_module_0003` / `__commonJSMin` / a fixed
/// enum name), so this is a no-op on them today — it only future-proofs a hash-bearing message.
export function normalizeSignature(signature: string): string {
  return signature.replaceAll(/-[A-Za-z0-9_-]{8}(?=\.[cm]?js\b)/g, "-<hash>");
}

// ---------------------------------------------------------------------------------------------------
// Target acquisition
// ---------------------------------------------------------------------------------------------------

interface ResolvedTarget {
  readonly label: string;
  readonly distPath: string;
}

/// Whether an installed tree carries a rolldown native binding (`@rolldown/binding-*`). A FAILED
/// optional binding does NOT make `npm install` exit non-zero, so an install can "succeed" yet be
/// unloadable on this platform; we verify one is present before trusting the cache.
function hasRolldownBinding(nodeModulesDir: string): boolean {
  try {
    return readdirSync(join(nodeModulesDir, "@rolldown")).some((name) =>
      name.startsWith("binding-"),
    );
  } catch {
    return false;
  }
}

/// Acquire a released rolldown version into the reusable cache and return its `dist/index.mjs` path.
/// `npm install rolldown@<version>` into an isolated per-version prefix (the parent tree carries no
/// package.json, so the fuzzer workspace's overrides never leak in) — this is the acquisition the
/// task's "npm pack + extract, reuse" intends, done with `install` because rolldown ships its native
/// binding as a separate optional-dependency package a bare tarball would omit. Cached by the
/// presence of the entry file, so a second run reuses the install.
///
/// Installed into a STAGING sibling and renamed on success (same-directory rename, atomic), so an
/// interrupted or partial install never poisons the cache: a future run would otherwise trust a
/// stale/incomplete `directory` whose entry file happens to exist. On any failure the staging dir is
/// removed and nothing is cached.
function acquireNpmTarget(version: string): string {
  const directory = join(CACHE_ROOT, version);
  const distPath = join(directory, "node_modules", "rolldown", "dist", "index.mjs");
  if (existsSync(distPath)) {
    return distPath;
  }
  mkdirSync(CACHE_ROOT, { recursive: true });
  const staging = mkdtempSync(join(CACHE_ROOT, `.staging-${version}-`));
  try {
    writeFileSync(
      join(staging, "package.json"),
      `${JSON.stringify({
        name: `redset-target-${version.replaceAll(".", "-")}`,
        private: true,
        version: "0.0.0",
      })}\n`,
    );
    process.stderr.write(`  acquiring rolldown@${version} -> ${directory}\n`);
    const result = spawnSync(
      "npm",
      [
        "install",
        `rolldown@${version}`,
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--silent",
      ],
      { cwd: staging, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] },
    );
    if (result.error !== undefined) {
      throw new Error(`npm install rolldown@${version} could not spawn: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`npm install rolldown@${version} failed with exit ${String(result.status)}`);
    }
    const stagedNodeModules = join(staging, "node_modules");
    if (!existsSync(join(stagedNodeModules, "rolldown", "dist", "index.mjs"))) {
      throw new Error(`rolldown@${version} installed but its dist/index.mjs is missing`);
    }
    if (!hasRolldownBinding(stagedNodeModules)) {
      throw new Error(
        `rolldown@${version} installed without an @rolldown/binding-* package (unloadable on this platform)`,
      );
    }
    // Publish atomically: clear any poisoned prior dir, then rename the verified staging into place.
    rmSync(directory, { recursive: true, force: true });
    renameSync(staging, directory);
    return distPath;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function resolveSnapshotPath(manifest: RedsetManifest): string {
  return process.env.REDSET_GREEN_SNAPSHOT ?? manifest.greenSnapshot.path;
}

/// A stable human label for a target reference WITHOUT acquiring it (used in the evidence for an
/// entry that errored before its target could be resolved).
function describeTarget(reference: TargetRef, manifest: RedsetManifest): string {
  if (reference.kind === "npm") {
    return `npm:${reference.version}`;
  }
  if (reference.kind === "snapshot") {
    return `snapshot:${manifest.greenSnapshot.id}`;
  }
  return `path:${reference.path}`;
}

function resolveTarget(reference: TargetRef, manifest: RedsetManifest): ResolvedTarget {
  const label = describeTarget(reference, manifest);
  if (reference.kind === "npm") {
    return { label, distPath: acquireNpmTarget(reference.version) };
  }
  if (reference.kind === "snapshot") {
    const path = resolveSnapshotPath(manifest);
    if (!existsSync(path)) {
      throw new Error(
        `green snapshot missing: ${path} (build it or set REDSET_GREEN_SNAPSHOT to a dist/index.mjs)`,
      );
    }
    return { label, distPath: resolve(path) };
  }
  if (!existsSync(reference.path)) {
    throw new Error(`target path missing: ${reference.path}`);
  }
  return { label, distPath: resolve(reference.path) };
}

// ---------------------------------------------------------------------------------------------------
// Running one entry against one target
// ---------------------------------------------------------------------------------------------------

interface EntryRun {
  readonly green: boolean;
  readonly signature: string;
}

async function runGeneratorEntry(entry: RedsetEntry, distPath: string): Promise<EntryRun> {
  const name = entry.generator;
  if (name === undefined) {
    throw new Error(`${entry.id}: missing generator`);
  }
  const generate = GENERATORS[name];
  if (generate === undefined) {
    throw new Error(
      `${entry.id}: unknown generator ${JSON.stringify(name)} — register it in scripts/regression-redset.ts`,
    );
  }
  const generated = generate(entry.seed ?? 0);
  const run = await executeProgram(
    generated.program,
    { rolldownPackage: distPath, onDemandWrapping: entry.onDemandWrapping ?? true },
    {},
    generated.analyzed,
  );
  if (run.verdict.kind === "pass") {
    return { green: true, signature: "pass" };
  }
  return { green: false, signature: run.verdict.signature };
}

/// The raw fixture's own `_test.mjs`, run through a catch-wrapper so a runtime throw during
/// `await import(builtBundle)` becomes a structured `[name, message]` verdict instead of a stack
/// dump on stderr — the RED is a genuine runtime witness, exactly as the mining harness ran it.
const RAW_TEST_WRAPPER = `try {
  await import('./_test.mjs');
  process.stdout.write('REDSET_GREEN\\n');
} catch (error) {
  const name = error && error.name ? String(error.name) : 'Error';
  const message = error && error.message != null ? String(error.message) : String(error);
  process.stdout.write('REDSET_RED ' + JSON.stringify([name, message]) + '\\n');
}
`;

function classifyRawOutput(stdout: string): EntryRun {
  for (const line of stdout.split("\n")) {
    if (line.startsWith("REDSET_RED ")) {
      const payload = line.slice("REDSET_RED ".length).trim();
      try {
        return { green: false, signature: `raw-crash:${JSON.stringify(JSON.parse(payload))}` };
      } catch {
        return { green: false, signature: `raw-crash:${payload}` };
      }
    }
  }
  if (stdout.includes("REDSET_GREEN")) {
    return { green: true, signature: "pass" };
  }
  return {
    green: false,
    signature: `raw-harness:${JSON.stringify(["NoVerdict", stdout.slice(0, 200)])}`,
  };
}

function runRawEntry(entry: RedsetEntry, distPath: string): EntryRun {
  const dir = entry.dir;
  if (dir === undefined) {
    throw new Error(`${entry.id}: missing dir`);
  }
  const fixtureDir = resolve(REGRESSION_DIR, dir);
  if (!existsSync(fixtureDir)) {
    throw new Error(`${entry.id}: raw fixture dir missing: ${fixtureDir}`);
  }
  const work = mkdtempSync(join(tmpdir(), `redset-${entry.id}-`));
  try {
    // Copy the fixture into an isolated working copy (never any stale/committed build output), so a
    // red build and a green build never contaminate each other and the committed fixture stays clean.
    for (const name of readdirSync(fixtureDir)) {
      if (name === "dist" || name === "node_modules") {
        continue;
      }
      cpSync(join(fixtureDir, name), join(work, name), { recursive: true });
    }
    const build = spawnSync(process.execPath, ["build.mjs"], {
      cwd: work,
      env: { ...process.env, ROLLDOWN: distPath },
      encoding: "utf8",
      timeout: RAW_SPAWN_TIMEOUT_MS,
    });
    if (build.error !== undefined) {
      return {
        green: false,
        signature: `raw-harness:${JSON.stringify(["SpawnError", build.error.message])}`,
      };
    }
    if (build.status !== 0) {
      const stderrText = build.stderr ?? "";
      const stdoutText = build.stdout ?? "";
      const detail = (stderrText.trim().length > 0 ? stderrText : stdoutText).trim();
      const lastLine = detail.split("\n").at(-1) ?? `exit ${String(build.status)}`;
      return {
        green: false,
        signature: `raw-build-failure:${JSON.stringify(["BuildError", lastLine])}`,
      };
    }
    writeFileSync(join(work, "__redset-run.mjs"), RAW_TEST_WRAPPER);
    const test = spawnSync(process.execPath, ["__redset-run.mjs"], {
      cwd: work,
      encoding: "utf8",
      timeout: RAW_SPAWN_TIMEOUT_MS,
    });
    if (test.error !== undefined) {
      return {
        green: false,
        signature: `raw-harness:${JSON.stringify(["SpawnError", test.error.message])}`,
      };
    }
    return classifyRawOutput(test.stdout ?? "");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function runEntryAgainst(entry: RedsetEntry, distPath: string): Promise<EntryRun> {
  if (entry.form === "generator") {
    return runGeneratorEntry(entry, distPath);
  }
  return runRawEntry(entry, distPath);
}

// ---------------------------------------------------------------------------------------------------
// Evidence + main
// ---------------------------------------------------------------------------------------------------

interface TargetEvidence {
  readonly label: string;
  readonly distPath: string;
  readonly sha256: string | null;
}

interface EntryResult {
  readonly id: string;
  readonly issue: number;
  readonly form: string;
  readonly cluster: string;
  readonly redTarget: TargetEvidence;
  readonly greenTarget: TargetEvidence;
  readonly expectedRedSignature: string;
  readonly observedRedSignature: string;
  readonly observedGreenSignature: string;
  readonly redMatches: boolean;
  readonly greenPassed: boolean;
  readonly verdict: "hold" | "violation";
}

function sha256OfFile(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function gitOutput(args: readonly string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function targetEvidence(resolved: ResolvedTarget): TargetEvidence {
  return {
    label: resolved.label,
    distPath: resolved.distPath,
    sha256: sha256OfFile(resolved.distPath),
  };
}

async function main(): Promise<number> {
  const manifest = parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown);
  const onlyId = process.argv[2];
  const entries =
    onlyId === undefined
      ? manifest.entries
      : manifest.entries.filter((entry) => entry.id === onlyId);
  if (entries.length === 0) {
    process.stderr.write(
      onlyId === undefined
        ? "FAIL: manifest has no entries\n"
        : `FAIL: no entry with id ${JSON.stringify(onlyId)}\n`,
    );
    return 2;
  }

  process.stderr.write(`regression red-set — ${entries.length} bracket(s)\n`);
  process.stderr.write(`  manifest: ${MANIFEST_PATH}\n`);
  process.stderr.write(`  target cache: ${CACHE_ROOT}\n`);

  const results: EntryResult[] = [];
  for (const entry of entries) {
    const expectedRed = normalizeSignature(entry.expectedRedSignature);
    try {
      const red = resolveTarget(entry.redTarget, manifest);
      const green = resolveTarget(entry.greenTarget, manifest);
      const redRun = await runEntryAgainst(entry, red.distPath);
      const greenRun = await runEntryAgainst(entry, green.distPath);

      const observedRed = normalizeSignature(redRun.signature);
      const redMatches = !redRun.green && observedRed === expectedRed;
      // A BRACKET-PENDING entry (bug open everywhere, no fixed build yet) HOLDs when the RED reproduces
      // on the red target; its "green" target is expected to be RED too, so it is not required to pass.
      // A normal bracket requires the green target to pass.
      const greenPassed = entry.bracketPending === true ? true : greenRun.green;
      const verdict: "hold" | "violation" = redMatches && greenPassed ? "hold" : "violation";

      results.push({
        id: entry.id,
        issue: entry.issue,
        form: entry.form,
        cluster: entry.cluster,
        redTarget: targetEvidence(red),
        greenTarget: targetEvidence(green),
        expectedRedSignature: expectedRed,
        observedRedSignature: observedRed,
        observedGreenSignature: normalizeSignature(greenRun.signature),
        redMatches,
        greenPassed,
        verdict,
      });

      process.stdout.write(
        `${verdict === "hold" ? "HOLD" : "VIOLATION"}  ${entry.id} #${String(entry.issue)} [${entry.form}]  ` +
          `red=${red.label} green=${green.label}\n`,
      );
      if (!redMatches) {
        process.stdout.write(`  ! red expected: ${expectedRed}\n`);
        process.stdout.write(
          `  ! red observed: ${observedRed}${redRun.green ? " (target was GREEN!)" : ""}\n`,
        );
      }
      if (!greenPassed) {
        process.stdout.write(`  ! green did NOT pass: ${normalizeSignature(greenRun.signature)}\n`);
      }
    } catch (error) {
      // A per-entry failure (target acquisition, a missing fixture, an executeProgram throw) is
      // recorded as that entry's VIOLATION and the run continues, so one broken bracket never aborts
      // the others or loses the evidence write.
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: entry.id,
        issue: entry.issue,
        form: entry.form,
        cluster: entry.cluster,
        redTarget: { label: describeTarget(entry.redTarget, manifest), distPath: "", sha256: null },
        greenTarget: {
          label: describeTarget(entry.greenTarget, manifest),
          distPath: "",
          sha256: null,
        },
        expectedRedSignature: expectedRed,
        observedRedSignature: `runner-error:${JSON.stringify([message])}`,
        observedGreenSignature: "not-run",
        redMatches: false,
        greenPassed: false,
        verdict: "violation",
      });
      process.stdout.write(
        `VIOLATION  ${entry.id} #${String(entry.issue)} [${entry.form}]  runner error\n`,
      );
      process.stdout.write(`  ! ${message}\n`);
    }
  }

  const accepted = results.every((result) => result.verdict === "hold");
  // A single-entry run writes a SUFFIXED evidence file so a debug run never clobbers the canonical
  // full-set evidence (an explicit EVIDENCE_OUT always wins).
  const evidenceOut =
    EVIDENCE_OUT_ENV ??
    resolve(
      REPO_ROOT,
      onlyId === undefined
        ? ".agents/evidence/regression-redset.json"
        : `.agents/evidence/regression-redset.${onlyId}.json`,
    );
  const evidence = {
    proof: "standing version-bracketed regression red-set (FW-C)",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    manifestPath: MANIFEST_PATH,
    cacheRoot: CACHE_ROOT,
    subset: onlyId === undefined ? null : onlyId,
    entryCount: results.length,
    accepted,
    entries: results,
  };
  mkdirSync(dirname(evidenceOut), { recursive: true });
  writeFileSync(evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`\nwrote evidence to ${evidenceOut}\n`);

  if (accepted) {
    process.stdout.write(
      `\nOK: all ${results.length} bracket(s) hold (red reproduces, green passes)\n`,
    );
    return 0;
  }
  process.stderr.write(
    `\nFAIL: ${results.filter((r) => r.verdict === "violation").length} bracket(s) violated\n`,
  );
  return 1;
}

/// Only run the full network/build flow when invoked directly (`npm run regression:redset`); a test
/// or another module can `import` this file for `parseManifest` / `normalizeSignature` without
/// triggering target acquisition.
const invokedPath = process.argv[1];
const isEntrypoint =
  invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href;
if (isEntrypoint) {
  process.exit(await main());
}
