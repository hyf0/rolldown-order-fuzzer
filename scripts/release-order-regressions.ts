/// <reference types="node" />

/// Release gate for the syntax-analysis, global-read optimization, and authored-name collision gaps
/// exposed by rolldown #10322, #10336, and the adjacent release audit.
///
/// The syntax cases use a fixture-owned global function behind a pure call, keep the reader event-free,
/// and observe its exported value downstream. This prevents either an ordinary side effect, built-in
/// monkey-patching, or constant evaluation from masking the syntax path under test. Required manual-pure
/// cases separately assert that deleting a declared-pure call preserves eager argument, computed-key,
/// and `new`-callee child effects. Other wrap-all cases record optimizer behavior outside the
/// no-monkey-patching assumption. The authored-name cases use strict wrap-all with real
/// `codeSplitting: false`, which puts runtime helpers and author bindings in the same root scope — the
/// load-bearing #10336 shape.
///
/// Run against the exact release candidate:
///
///   RELEASE_ROLLDOWN=/absolute/path/to/rolldown/dist/index.mjs npm run release:order-regressions
///
/// Pass one or more case ids to run a subset. Required cases must PASS. Assumption probes record semantic
/// mismatches without blocking a release, because they deliberately monkey-patch built-ins and therefore
/// test an optimizer assumption boundary rather than ordinary program semantics. Oxc documents this
/// assumption for minification; Rolldown still needs to state whether its default non-minify constant
/// evaluation adopts the same policy. Invalid source, build failures, and harness failures remain fatal
/// for every case so a broken probe cannot make the gate look healthy. Machine-readable evidence is
/// written to `.agents/evidence/release-order-regressions.json` by default.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AUTHORED_COLLISION_BINDING_NAMES,
  GLOBAL_READ_FORMS,
  generateAuthoredNameCollisionCase,
  generateGlobalReadInstanceofOrderCase,
  generateGlobalReadOptimizerExpressionOrderCase,
  generateGlobalReadOrderCase,
  type GeneratedCase,
} from "../src/generate.ts";
import {
  globalReadBuiltinSpec,
  OPTIMIZER_GLOBAL_READ_BUILTIN_KINDS,
} from "../src/global-read-builtins.ts";
import {
  GLOBAL_READ_INSTANCEOF_KINDS,
  globalReadInstanceofSpec,
} from "../src/global-read-instanceof.ts";
import {
  GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS,
  globalReadOptimizerExpressionSpec,
} from "../src/global-read-optimizer-expressions.ts";
import {
  buildConfigOf,
  isManualPureSideEffectForm,
  MANUAL_PURE_SIDE_EFFECT_FORMS,
  type GlobalReadForm,
} from "../src/model.ts";
import { executeProgram, type CampaignVerdict } from "../src/program-run.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = process.env.RELEASE_ROLLDOWN ?? process.env.ROLLDOWN_PACKAGE ?? "rolldown";
const SEED = Number(process.env.RELEASE_SEED ?? "0");
const EVIDENCE_OUT =
  process.env.EVIDENCE_OUT ?? resolve(REPO_ROOT, ".agents/evidence/release-order-regressions.json");

/// A `Record` is deliberate: adding another model-level form becomes a type error here until the release
/// gate names it. The forms that first exposed #10322 are part of this larger adjacent-syntax set.
const GLOBAL_READ_DESCRIPTIONS = {
  direct: "direct initializer",
  "class-static-field-declaration": "class declaration static field",
  "class-static-field-expression": "class expression static field",
  "class-static-field-default-export": "default-export class static field",
  "class-static-field-iife": "class static field containing a direct IIFE",
  "class-heritage": "class heritage expression",
  "class-computed-key": "class computed key",
  "class-computed-accessor-key": "class computed accessor key",
  "class-nested-static-field": "nested class in a static field",
  "class-static-block": "class static block",
  "class-instance-field-immediate-construction":
    "immediately constructed class-expression instance field",
  "direct-arrow-iife": "direct arrow IIFE",
  "direct-arrow-block-iife": "direct block-bodied arrow IIFE",
  "arrow-argument-iife": "arrow IIFE with an argument",
  "direct-function-iife": "direct function IIFE",
  "sequence-callee-iife": "sequence-wrapped arrow IIFE callee",
  "optional-call-iife": "optional-call arrow IIFE",
  "rest-parameter-iife": "arrow IIFE with a rest parameter",
  "named-function-iife": "named function IIFE",
  "local-const-iife": "arrow IIFE with a local constant",
  "if-body-iife": "arrow IIFE with an if body",
  "try-finally-iife": "arrow IIFE with a try/finally body",
  "switch-body-iife": "arrow IIFE with a switch body",
  "returned-class-iife": "arrow IIFE returning a class with a static initializer",
  "conditional-callee-iife": "conditional-expression IIFE callee",
  "logical-callee-iife": "logical-expression IIFE callee",
  "array-member": "array member wrapper",
  "array-member-bigint-index": "array member with bigint index",
  "optional-array-member": "optional array member",
  "sequence-array-member": "sequence-wrapped array member",
  "conditional-array-member": "conditional array member",
  "spread-array-member": "spread array member",
  "array-length-call-effect": "array length with an observable element-call effect",
  "object-member": "object member wrapper",
  "nested-object-member": "nested object member wrapper",
  "computed-string-object-member": "computed string object member",
  "computed-number-object-member": "computed numeric-key object member",
  "local-computed-object-member": "local object computed member",
  "optional-object-member": "optional object member",
  "optional-computed-object-member": "optional computed object member",
  "nested-optional-object-member": "nested optional object member",
  "object-binding-default": "object binding default initializer",
  "object-binding-computed-key": "object binding computed key",
  "nested-object-binding-default": "nested object binding default initializer",
  "nested-object-binding-computed-key": "nested object binding computed key",
  "member-assignment-value": "member assignment value",
  "annotated-pure-member": "pure-annotated function result member",
  "manual-pure-member": "manual-pure function result member",
  "manual-pure-computed-member": "manual-pure function result computed member",
  "manual-pure-string-member": "manual-pure function result string member",
  "manual-pure-numeric-member": "manual-pure function result numeric member",
  "manual-pure-nested-member": "manual-pure function result nested member",
  "manual-pure-optional-member": "manual-pure function result optional member",
  "manual-pure-optional-computed-member": "manual-pure function result optional computed member",
  "manual-pure-member-call": "manual-pure function result member call",
  "manual-pure-new": "manual-pure constructor",
  "manual-pure-class-instance-field": "manual-pure class instance field initializer",
  "manual-pure-class-default-parameter": "manual-pure class constructor default parameter",
  "manual-pure-returned-class": "manual-pure returned class construction",
  "manual-pure-tagged-template": "manual-pure tagged-template invocation",
  "manual-pure-computed-key-effect": "manual-pure result computed-key side effect",
  "manual-pure-call-argument-effect": "manual-pure call-argument side effect",
  "manual-pure-new-callee-computed-key-effect":
    "manual-pure computed-key side effect inside a new-expression callee",
} as const satisfies Record<GlobalReadForm, string>;

/// The array-length form is registered once below as an optimizer-assumption probe instead of being
/// duplicated in the on-demand analyzer group. The currently green direct and class-static-block forms
/// remain required boundary controls so the complete non-effect syntax matrix catches future regressions.
export const RELEASE_GLOBAL_READ_FORMS = GLOBAL_READ_FORMS.filter(
  (form) => form !== "array-length-call-effect" && !isManualPureSideEffectForm(form),
);

export type ReleaseRegressionPolicy = "required" | "assumption-probe";

export interface ReleaseRegressionCase {
  readonly id: string;
  readonly issue:
    | "#10322"
    | "#10336"
    | "adjacent/analyzer"
    | "adjacent/deconfliction"
    | "adjacent/tree-shaking"
    | "adjacent/optimizer";
  readonly policy: ReleaseRegressionPolicy;
  readonly description: string;
  readonly onDemandWrapping: boolean;
  readonly generate: (seed: number) => GeneratedCase;
}

const PR_10322_EXACT_FORMS: ReadonlySet<GlobalReadForm> = new Set([
  "class-static-field-declaration",
  "class-static-field-expression",
  "class-static-field-default-export",
  "class-static-field-iife",
  "class-heritage",
  "class-computed-key",
  "class-computed-accessor-key",
  "class-nested-static-field",
]);

const globalReadCases: readonly ReleaseRegressionCase[] = RELEASE_GLOBAL_READ_FORMS.map((form) => {
  const isExact10322 = PR_10322_EXACT_FORMS.has(form);
  return {
    id: isExact10322 ? `10322-${form}` : `adjacent-analyzer-${form}`,
    issue: isExact10322 ? "#10322" : "adjacent/analyzer",
    policy: "required",
    description: GLOBAL_READ_DESCRIPTIONS[form],
    onDemandWrapping: true,
    generate: (seed: number) => generateGlobalReadOrderCase(seed, form),
  };
});

const manualPureSideEffectCases: readonly ReleaseRegressionCase[] =
  MANUAL_PURE_SIDE_EFFECT_FORMS.map((form) => ({
    id: `adjacent-tree-shaking-${form}`,
    issue: "adjacent/tree-shaking",
    policy: "required",
    description: GLOBAL_READ_DESCRIPTIONS[form],
    onDemandWrapping: false,
    generate: (seed: number) => generateGlobalReadOrderCase(seed, form),
  }));

const PR_10336_BRACKET_NAMES: ReadonlySet<string> = new Set([
  "__esmMin",
  "__esm",
  "__getOwnPropNames",
]);

const authoredNameCases: readonly ReleaseRegressionCase[] = AUTHORED_COLLISION_BINDING_NAMES.map(
  (authoredName) => {
    const isExact10336 = PR_10336_BRACKET_NAMES.has(authoredName);
    return {
      id: isExact10336
        ? `10336-authored-${authoredName}`
        : `adjacent-deconfliction-authored-${authoredName}`,
      issue: isExact10336 ? "#10336" : "adjacent/deconfliction",
      policy: "required",
      description: `strict wrap-all, no-splitting collision with authored ${authoredName}`,
      onDemandWrapping: false,
      generate: (seed: number) => generateAuthoredNameCollisionCase(seed, authoredName),
    };
  },
);

const authoredNameOutputCases: readonly ReleaseRegressionCase[] = [
  {
    id: "10336-authored-__esmMin-cjs",
    issue: "#10336",
    policy: "required",
    description: "strict wrap-all, no-splitting CJS-output collision with authored __esmMin",
    onDemandWrapping: false,
    generate: (seed: number) => generateAuthoredNameCollisionCase(seed, "__esmMin", "cjs"),
  },
  {
    id: "10336-authored-__esm-cjs",
    issue: "#10336",
    policy: "required",
    description: "strict wrap-all, no-splitting CJS-output collision with authored __esm",
    onDemandWrapping: false,
    generate: (seed: number) => generateAuthoredNameCollisionCase(seed, "__esm", "cjs"),
  },
  {
    id: "10336-authored-__getOwnPropNames-cjs",
    issue: "#10336",
    policy: "required",
    description:
      "strict wrap-all, no-splitting CJS-output collision with authored __getOwnPropNames",
    onDemandWrapping: false,
    generate: (seed: number) => generateAuthoredNameCollisionCase(seed, "__getOwnPropNames", "cjs"),
  },
];

export const RELEASE_OPTIMIZER_BUILTIN_KINDS = OPTIMIZER_GLOBAL_READ_BUILTIN_KINDS;

const optimizerBuiltinCases: readonly ReleaseRegressionCase[] = RELEASE_OPTIMIZER_BUILTIN_KINDS.map(
  (kind) => ({
    id: `optimizer-${kind}-direct`,
    issue: "adjacent/optimizer",
    policy: "assumption-probe",
    description: `direct ${globalReadBuiltinSpec(kind).description} result folded across an earlier monkey-patch`,
    onDemandWrapping: false,
    generate: (seed: number) => generateGlobalReadOrderCase(seed, "direct", kind),
  }),
);

export const RELEASE_INSTANCEOF_EXPRESSION_KINDS = GLOBAL_READ_INSTANCEOF_KINDS;

const optimizerInstanceofCases: readonly ReleaseRegressionCase[] =
  RELEASE_INSTANCEOF_EXPRESSION_KINDS.map((kind) => ({
    id: `optimizer-${kind}-direct`,
    issue: "adjacent/optimizer",
    policy: "assumption-probe",
    description: `direct ${globalReadInstanceofSpec(kind).description} result folded across an earlier Symbol.hasInstance patch`,
    onDemandWrapping: false,
    generate: (seed: number) => generateGlobalReadInstanceofOrderCase(seed, kind),
  }));

export const RELEASE_OPTIMIZER_EXPRESSION_KINDS = GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS;

const optimizerExpressionCases: readonly ReleaseRegressionCase[] =
  RELEASE_OPTIMIZER_EXPRESSION_KINDS.map((kind) => ({
    id: `optimizer-${kind}`,
    issue: "adjacent/optimizer",
    policy: "assumption-probe",
    description: `direct ${globalReadOptimizerExpressionSpec(kind).description} folded across an earlier global/prototype patch`,
    onDemandWrapping: false,
    generate: (seed: number) => generateGlobalReadOptimizerExpressionOrderCase(seed, kind),
  }));

const optimizerCases: readonly ReleaseRegressionCase[] = [
  {
    id: "optimizer-array-length-call-effect",
    issue: "adjacent/optimizer",
    policy: "assumption-probe",
    description: "array-length folding must preserve an observable element call",
    onDemandWrapping: false,
    generate: (seed: number) =>
      generateGlobalReadOrderCase(seed, "array-length-call-effect", "math-hypot"),
  },
  ...optimizerBuiltinCases,
  ...optimizerInstanceofCases,
  ...optimizerExpressionCases,
];

/// Public so the unit suite pins the exact directed release surface without running an external build.
export const RELEASE_REGRESSION_CASES: readonly ReleaseRegressionCase[] = Object.freeze([
  ...globalReadCases,
  ...manualPureSideEffectCases,
  ...authoredNameCases,
  ...authoredNameOutputCases,
  ...optimizerCases,
]);

export interface CaseEvidence {
  readonly id: string;
  readonly issue: ReleaseRegressionCase["issue"];
  readonly policy: ReleaseRegressionPolicy;
  readonly description: string;
  readonly wrapMode: "on-demand" | "wrap-all";
  readonly coverageTags: readonly string[];
  readonly build: ReturnType<typeof buildConfigOf>;
  readonly verdictKind: CampaignVerdict["kind"];
  readonly signature: string;
  readonly sourceStatus: string;
  readonly bundleStatus: string;
}

export interface ReleaseGateAggregation<Result> {
  readonly requiredFailures: readonly Result[];
  readonly assumptionObservations: readonly Result[];
  readonly assumptionProbeValidityFailures: readonly Result[];
  readonly accepted: boolean;
  readonly exitCode: 0 | 1;
}

/// Only a semantic mismatch is an accepted observation for an assumption probe. Any source, build, or
/// harness invalidity means the probe itself did not run correctly and must still fail the release gate.
export function aggregateReleaseGateResults<
  Result extends {
    readonly policy: ReleaseRegressionPolicy;
    readonly verdictKind: CampaignVerdict["kind"];
  },
>(results: readonly Result[]): ReleaseGateAggregation<Result> {
  const requiredFailures = results.filter(
    (result) => result.policy === "required" && result.verdictKind !== "pass",
  );
  const assumptionObservations = results.filter(
    (result) => result.policy === "assumption-probe" && result.verdictKind === "mismatch",
  );
  const assumptionProbeValidityFailures = results.filter(
    (result) =>
      result.policy === "assumption-probe" &&
      result.verdictKind !== "pass" &&
      result.verdictKind !== "mismatch",
  );
  const accepted = requiredFailures.length === 0 && assumptionProbeValidityFailures.length === 0;
  return {
    requiredFailures,
    assumptionObservations,
    assumptionProbeValidityFailures,
    accepted,
    exitCode: accepted ? 0 : 1,
  };
}

function gitOutput(args: readonly string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/// A directly unpacked CI artifact has no package.json, so the adapter cannot discover its adjacent
/// native binding through package metadata. Hash sibling `.node` files explicitly; otherwise pre/fixed
/// artifacts can share byte-identical `index.mjs` while executing different native code.
function adjacentNativeLibraries(packageSpecifier: string): readonly {
  readonly path: string;
  readonly sha256: string;
}[] {
  let entryPath: string;
  try {
    entryPath = packageSpecifier.startsWith("file:")
      ? fileURLToPath(packageSpecifier)
      : packageSpecifier;
    if (!isAbsolute(entryPath)) {
      return [];
    }
    const directory = dirname(realpathSync(entryPath));
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".node"))
      .map((entry) => {
        const path = resolve(directory, entry.name);
        return {
          path,
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
  } catch {
    return [];
  }
}

function selectedCases(args: readonly string[]): readonly ReleaseRegressionCase[] {
  if (args.length === 0) {
    return RELEASE_REGRESSION_CASES;
  }
  const byId = new Map(RELEASE_REGRESSION_CASES.map((entry) => [entry.id, entry]));
  return args.map((id) => {
    const entry = byId.get(id);
    if (entry === undefined) {
      throw new Error(
        `Unknown release regression case ${JSON.stringify(id)}. Known ids: ${RELEASE_REGRESSION_CASES.map((candidate) => candidate.id).join(", ")}`,
      );
    }
    return entry;
  });
}

function bundleStatusOf(
  bundleOutcome: Awaited<ReturnType<typeof executeProgram>>["bundleOutcome"],
): string {
  return bundleOutcome.status === "not-run" ? bundleOutcome.reason : bundleOutcome.status;
}

async function main(args: readonly string[]): Promise<number> {
  if (!Number.isInteger(SEED) || SEED < 0 || SEED >= 0x1_0000_0000) {
    process.stderr.write(
      `FAIL: RELEASE_SEED must be an unsigned 32-bit integer, received ${String(SEED)}\n`,
    );
    return 2;
  }

  let cases: readonly ReleaseRegressionCase[];
  try {
    cases = selectedCases(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  process.stderr.write(
    `release order regressions — target=${TARGET}, seed=${SEED}, directed cases=${cases.length}\n`,
  );
  const results: CaseEvidence[] = [];
  let runtimeIdentity: Awaited<ReturnType<typeof executeProgram>>["runtimeIdentity"] | null = null;

  for (const entry of cases) {
    const generated = entry.generate(SEED);
    const run = await executeProgram(
      generated.program,
      { rolldownPackage: TARGET, onDemandWrapping: entry.onDemandWrapping },
      {},
      generated.analyzed,
    );
    runtimeIdentity ??= run.runtimeIdentity;
    const signature = run.verdict.kind === "pass" ? "pass" : run.verdict.signature;
    const evidence: CaseEvidence = {
      id: entry.id,
      issue: entry.issue,
      policy: entry.policy,
      description: entry.description,
      wrapMode: entry.onDemandWrapping ? "on-demand" : "wrap-all",
      coverageTags: generated.coverageTags,
      build: buildConfigOf(generated.program),
      verdictKind: run.verdict.kind,
      signature,
      sourceStatus: run.sourceOutcome.status,
      bundleStatus: bundleStatusOf(run.bundleOutcome),
    };
    results.push(evidence);
    const status =
      evidence.signature === "pass"
        ? "PASS"
        : entry.policy === "assumption-probe" && evidence.verdictKind === "mismatch"
          ? `OBSERVED ${evidence.signature}`
          : `FAIL ${evidence.signature}`;
    process.stdout.write(
      `${entry.id.padEnd(57)} ${entry.policy.padEnd(16)} ${evidence.wrapMode.padEnd(9)} ${status}\n`,
    );
  }

  const aggregation = aggregateReleaseGateResults(results);
  const evidence = {
    proof:
      "Required release gate for #10322, adjacent global-read analyzer findings, manual-pure child effects, #10336, and adjacent authored-name deconfliction; non-blocking optimizer assumption probes are recorded separately",
    generatedAt: new Date().toISOString(),
    head: gitOutput(["rev-parse", "HEAD"]),
    dirty: gitOutput(["status", "--porcelain"]).length > 0,
    node: process.version,
    seed: SEED,
    target: TARGET,
    adjacentNativeLibraries: adjacentNativeLibraries(TARGET),
    runtimeIdentity:
      runtimeIdentity === null
        ? null
        : {
            requestedPackageSpecifier: runtimeIdentity.requestedPackageSpecifier,
            resolvedEntryPath: runtimeIdentity.resolvedEntryPath,
            packageVersion: runtimeIdentity.packageVersion,
            resolvedEntrySha256: runtimeIdentity.resolvedEntrySha256,
            packageContentSha256: runtimeIdentity.packageContentSha256,
            optionalBindingPackages: runtimeIdentity.optionalBindingPackages.map((binding) => ({
              name: binding.name,
              version: binding.version,
              contentSha256: binding.contentSha256,
            })),
            napiRsNativeLibrary: runtimeIdentity.napiRsNativeLibrary,
          },
    accepted: aggregation.accepted,
    requiredFailures: aggregation.requiredFailures,
    assumptionObservations: aggregation.assumptionObservations,
    assumptionProbeValidityFailures: aggregation.assumptionProbeValidityFailures,
    results,
  };
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
  writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`wrote evidence to ${EVIDENCE_OUT}\n`);

  if (!aggregation.accepted) {
    process.stderr.write(
      `\nRELEASE CATCH: ${aggregation.requiredFailures.length} required failure(s), ${aggregation.assumptionProbeValidityFailures.length} invalid assumption probe(s); ${aggregation.assumptionObservations.length} non-blocking assumption observation(s) recorded\n`,
    );
    return aggregation.exitCode;
  }
  const requiredCount = results.filter((result) => result.policy === "required").length;
  const probeCount = results.length - requiredCount;
  process.stdout.write(
    `\nOK: all ${requiredCount} required release regressions pass; ${aggregation.assumptionObservations.length}/${probeCount} assumption probes recorded non-blocking semantic mismatches\n`,
  );
  return aggregation.exitCode;
}

const invokedPath = process.argv[1];
const isEntrypoint =
  invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href;
if (isEntrypoint) {
  process.exit(await main(process.argv.slice(2)));
}
