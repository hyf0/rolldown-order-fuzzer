/// <reference types="node" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, test } from "vite-plus/test";

import {
  RELEASE_INSTANCEOF_EXPRESSION_KINDS,
  RELEASE_GLOBAL_READ_FORMS,
  RELEASE_OPTIMIZER_BUILTIN_KINDS,
  RELEASE_OPTIMIZER_EXPRESSION_KINDS,
  RELEASE_REGRESSION_CASES,
  aggregateReleaseGateResults,
} from "../scripts/release-order-regressions.ts";
import { analyzeProgram } from "../src/analyzed-program.ts";
import { executeManifest } from "../src/execute.ts";
import {
  ANALYZER_GLOBAL_READ_FORMS,
  AUTHORED_COLLISION_BINDING_NAMES,
  CJS_AUTHORED_COLLISION_BINDING_NAMES,
  GLOBAL_READ_FORMS,
  generateAuthoredNameCollisionCase,
  generateCase,
  generateGlobalReadInstanceofOrderCase,
  generateGlobalReadOptimizerExpressionOrderCase,
  generateGlobalReadOrderCase,
  type GeneratedCase,
} from "../src/generate.ts";
import {
  globalReadBuiltinSpec,
  OPTIMIZER_GLOBAL_READ_BUILTIN_KINDS,
  projectGlobalReadBuiltinCall,
} from "../src/global-read-builtins.ts";
import {
  GLOBAL_READ_INSTANCEOF_KINDS,
  globalReadInstanceofSpec,
  renderGlobalReadInstanceofExpression,
} from "../src/global-read-instanceof.ts";
import {
  GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS,
  MINIFIER_TRANSFORM_OPTIMIZER_EXPRESSION_KINDS,
  globalReadOptimizerExpressionSpec,
  type GlobalReadOptimizerExpressionKind,
} from "../src/global-read-optimizer-expressions.ts";
import { writeFailureArtifacts } from "../src/main.ts";
import {
  buildConfigOf,
  DEFAULT_TREESHAKE_CONFIG,
  isManualPureSideEffectForm,
  MANUAL_PURE_SIDE_EFFECT_COUNTER_GLOBAL,
  MANUAL_PURE_SIDE_EFFECT_FORMS,
  type GlobalReadForm,
  type ProgramModel,
} from "../src/model.ts";
import type { CampaignCaseResult } from "../src/program-run.ts";
import type { ObservedRuntimeIdentity } from "../src/rolldown-adapter.ts";
import { renderProgram, type RenderedProgram } from "../src/render.ts";
import {
  BUILD_CHILD_PROTOCOL_VERSION,
  createOutputOptions,
  parseBuildChildRequest,
  type BuildChildRequest,
} from "../src/rolldown-build-child.ts";
import { candidates } from "../src/shrink.ts";
import { validateProgramModel } from "../src/validate-model.ts";
import { fileContents } from "./fixtures.ts";

const EXPECTED_GLOBAL_READ_SYNTAX = {
  direct: "const __orderGlobalReadValue0 = Math.hypot(3, 4);",
  "class-static-field-declaration":
    "class __OrderGlobalReadClass0 { static value = Math.hypot(3, 4); }",
  "class-static-field-expression":
    "const __OrderGlobalReadClass0 = class { static value = Math.hypot(3, 4); };",
  "class-static-field-default-export":
    "export default class __OrderGlobalReadClass0 { static value = Math.hypot(3, 4); }",
  "class-static-field-iife":
    "class __OrderGlobalReadClass0 { static value = (() => Math.hypot(3, 4))(); }",
  "class-heritage": "class __OrderGlobalReadClass0 extends (Math.hypot(3, 4) ===",
  "class-computed-key": "class __OrderGlobalReadClass0 { static [Math.hypot(3, 4) ===",
  "class-computed-accessor-key": "static get [Math.hypot(3, 4) ===",
  "class-nested-static-field": "static Inner = class { static value = Math.hypot(3, 4); };",
  "class-static-block": "static { this.value = Math.hypot(3, 4); }",
  "class-instance-field-immediate-construction":
    "const __OrderGlobalReadClass0 = new (class { value = Math.hypot(3, 4); })();",
  "direct-arrow-iife": "const __orderGlobalReadValue0 = (() => Math.hypot(3, 4))();",
  "direct-arrow-block-iife":
    "const __orderGlobalReadValue0 = (() => { return Math.hypot(3, 4); })();",
  "arrow-argument-iife": "const __orderGlobalReadValue0 = ((unused) => Math.hypot(3, 4))(",
  "direct-function-iife":
    "const __orderGlobalReadValue0 = (function () { return Math.hypot(3, 4); })();",
  "sequence-callee-iife": "const __orderGlobalReadValue0 = (0, () => Math.hypot(3, 4))();",
  "optional-call-iife": "const __orderGlobalReadValue0 = (() => Math.hypot(3, 4))?.();",
  "rest-parameter-iife": "const __orderGlobalReadValue0 = ((...args) => Math.hypot(3, 4))();",
  "named-function-iife":
    "const __orderGlobalReadValue0 = (function named() { return Math.hypot(3, 4); })();",
  "local-const-iife":
    "const __orderGlobalReadValue0 = (() => { const result = Math.hypot(3, 4); return result; })();",
  "if-body-iife":
    "const __orderGlobalReadValue0 = (() => { if (true) return Math.hypot(3, 4); return 5; })();",
  "try-finally-iife":
    "const __orderGlobalReadValue0 = (() => { try { return Math.hypot(3, 4); } finally {} })();",
  "switch-body-iife":
    "const __orderGlobalReadValue0 = (() => { switch (0) { case 0: return Math.hypot(3, 4); } })();",
  "returned-class-iife":
    "const __OrderGlobalReadClass0 = (() => class { static value = Math.hypot(3, 4); })();",
  "conditional-callee-iife":
    "const __orderGlobalReadValue0 = (true ? (() => Math.hypot(3, 4)) : (() => 5))();",
  "logical-callee-iife": "const __orderGlobalReadValue0 = (true && (() => Math.hypot(3, 4)))();",
  "array-member": "const __orderGlobalReadValue0 = [Math.hypot(3, 4)][0];",
  "array-member-bigint-index": "const __orderGlobalReadValue0 = [Math.hypot(3, 4)][0n];",
  "optional-array-member": "const __orderGlobalReadValue0 = [Math.hypot(3, 4)]?.[0];",
  "sequence-array-member": "const __orderGlobalReadValue0 = ([5], [Math.hypot(3, 4)])[0];",
  "conditional-array-member": "const __orderGlobalReadValue0 = [true ? Math.hypot(3, 4) : 5][0];",
  "spread-array-member": "const __orderGlobalReadValue0 = [...[Math.hypot(3, 4)]][0];",
  "array-length-call-effect": "const __orderGlobalReadValue0 = [Math.hypot(3, 4)].length;",
  "object-member": "const __orderGlobalReadValue0 = ({ value: Math.hypot(3, 4) }).value;",
  "object-computed-key": "const __orderGlobalReadValue0 = ({ [Math.hypot(3, 4)]:",
  "nested-object-member":
    "const __orderGlobalReadValue0 = ({ inner: { value: Math.hypot(3, 4) } }).inner.value;",
  "computed-string-object-member":
    'const __orderGlobalReadValue0 = ({ value: Math.hypot(3, 4) })["value"];',
  "computed-number-object-member": "})[Math.hypot(3, 4)];",
  "local-computed-object-member":
    "const __orderGlobalReadValue0 = __orderGlobalReadTable0[Math.hypot(3, 4)];",
  "optional-object-member": "const __orderGlobalReadValue0 = ({ value: Math.hypot(3, 4) })?.value;",
  "optional-computed-object-member": "})?.[Math.hypot(3, 4)];",
  "nested-optional-object-member":
    "const __orderGlobalReadValue0 = ({ inner: { value: Math.hypot(3, 4) } })?.inner?.value;",
  "object-binding-default": "const { value: __orderGlobalReadValue0 = Math.hypot(3, 4) } = {};",
  "object-binding-computed-key": "const { [Math.hypot(3, 4)]: __orderGlobalReadValue0 } = {",
  "nested-object-binding-default":
    "const { inner: { value: __orderGlobalReadValue0 = Math.hypot(3, 4) } = {} } = {};",
  "nested-object-binding-computed-key":
    "const { inner: { [Math.hypot(3, 4)]: __orderGlobalReadValue0 } } = { inner: {",
  "member-assignment-value":
    "const __orderGlobalReadValue0 = __orderGlobalReadBox0.value = Math.hypot(3, 4);",
  "annotated-pure-member": "const __orderGlobalReadValue0 = (/* @__PURE__ */ make()).value;",
  "manual-pure-member": "const __orderGlobalReadValue0 = make().value;",
  "manual-pure-computed-member": "const __orderGlobalReadValue0 = make()[Math.hypot(3, 4)];",
  "manual-pure-string-member": 'const __orderGlobalReadValue0 = make()["value"];',
  "manual-pure-numeric-member": "function make() { return { 0: Math.hypot(3, 4) }; }",
  "manual-pure-nested-member": "const __orderGlobalReadValue0 = make().inner.value;",
  "manual-pure-optional-member": "const __orderGlobalReadValue0 = make()?.value;",
  "manual-pure-optional-computed-member":
    "const __orderGlobalReadValue0 = make()?.[Math.hypot(3, 4)];",
  "manual-pure-member-call": "const __orderGlobalReadValue0 = make().read();",
  "manual-pure-new": "function Box() { this.value = Math.hypot(3, 4); }",
  "manual-pure-class-instance-field": "class Box { value = Math.hypot(3, 4); }",
  "manual-pure-class-default-parameter":
    "class Box { constructor(value = Math.hypot(3, 4)) { this.value = value; } }",
  "manual-pure-returned-class": "function make() { return class { value = Math.hypot(3, 4); }; }",
  "manual-pure-tagged-template": "function tag() { return Math.hypot(3, 4); }",
  "manual-pure-computed-key-effect": "make()[__orderManualPureEffect0()];",
  "manual-pure-call-argument-effect": "make(__orderManualPureEffect0()).value;",
  "manual-pure-new-callee-computed-key-effect": "new (make()[__orderManualPureEffect0()].Box)();",
} as const satisfies Record<GlobalReadForm, string>;

function expectedFixtureGlobalReadSyntax(form: GlobalReadForm): string {
  const call = "/* @__PURE__ */ globalThis.__orderRead?.()";
  const expression = `(${call} ?? 5)`;
  return EXPECTED_GLOBAL_READ_SYNTAX[form].replaceAll("Math.hypot(3, 4)", expression);
}

describe("release order regression surface", () => {
  test("the release script separates required regressions from optimizer assumption probes", () => {
    expect(GLOBAL_READ_FORMS).toEqual(Object.keys(EXPECTED_GLOBAL_READ_SYNTAX));
    expect(RELEASE_GLOBAL_READ_FORMS).toEqual(ANALYZER_GLOBAL_READ_FORMS);

    const ids = RELEASE_REGRESSION_CASES.map((entry) => entry.id);
    const exact10322Forms: ReadonlySet<GlobalReadForm> = new Set([
      "class-static-field-declaration",
      "class-static-field-expression",
      "class-static-field-default-export",
      "class-static-field-iife",
      "class-heritage",
      "class-computed-key",
      "class-computed-accessor-key",
      "class-nested-static-field",
    ]);
    for (const form of RELEASE_GLOBAL_READ_FORMS) {
      const isExact10322 = exact10322Forms.has(form);
      const expectedId = isExact10322 ? `10322-${form}` : `adjacent-analyzer-${form}`;
      const entry = RELEASE_REGRESSION_CASES.find((candidate) => candidate.id === expectedId);
      expect(entry, form).toBeDefined();
      expect(entry?.issue, form).toBe(isExact10322 ? "#10322" : "adjacent/analyzer");
      expect(entry?.policy, form).toBe("required");
    }
    expect(ids).not.toContain("adjacent-analyzer-array-length-call-effect");
    for (const form of MANUAL_PURE_SIDE_EFFECT_FORMS) {
      const entry = RELEASE_REGRESSION_CASES.find(
        (candidate) => candidate.id === `adjacent-tree-shaking-${form}`,
      );
      expect(entry, form).toBeDefined();
      expect(entry?.issue, form).toBe("adjacent/tree-shaking");
      expect(entry?.policy, form).toBe("required");
    }
    expect(new Set(ids).size).toBe(ids.length);
    const exact10336Names: ReadonlySet<string> = new Set([
      "__esmMin",
      "__esm",
      "__getOwnPropNames",
    ]);
    for (const authoredName of AUTHORED_COLLISION_BINDING_NAMES) {
      const isExact10336 = exact10336Names.has(authoredName);
      const expectedId = isExact10336
        ? `10336-authored-${authoredName}`
        : `adjacent-deconfliction-authored-${authoredName}`;
      const entry = RELEASE_REGRESSION_CASES.find((candidate) => candidate.id === expectedId);
      expect(entry, authoredName).toBeDefined();
      expect(entry?.issue, authoredName).toBe(isExact10336 ? "#10336" : "adjacent/deconfliction");
      expect(entry?.policy, authoredName).toBe("required");
    }
    for (const id of [
      "10336-authored-__esmMin-cjs",
      "10336-authored-__esm-cjs",
      "10336-authored-__getOwnPropNames-cjs",
    ]) {
      const cjsCollisionCase = RELEASE_REGRESSION_CASES.find((entry) => entry.id === id);
      expect(cjsCollisionCase, id).toBeDefined();
      if (cjsCollisionCase === undefined) {
        throw new Error(`missing CJS-output collision case ${id}`);
      }
      expect(cjsCollisionCase.issue, id).toBe("#10336");
      expect(cjsCollisionCase.policy, id).toBe("required");
      expect(buildConfigOf(cjsCollisionCase.generate(17).program).outputFormat, id).toBe("cjs");
    }
    expect(ids).toContain("optimizer-array-length-call-effect");
    expect(ids).toContain("optimizer-math-max-direct");
    expect(ids).toContain("optimizer-string-from-char-code-length-direct");
    expect(RELEASE_OPTIMIZER_BUILTIN_KINDS).toEqual(OPTIMIZER_GLOBAL_READ_BUILTIN_KINDS);
    expect(RELEASE_INSTANCEOF_EXPRESSION_KINDS).toEqual(GLOBAL_READ_INSTANCEOF_KINDS);
    expect(RELEASE_OPTIMIZER_EXPRESSION_KINDS).toEqual(GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS);
    for (const kind of OPTIMIZER_GLOBAL_READ_BUILTIN_KINDS) {
      expect(ids).toContain(`optimizer-${kind}-direct`);
    }
    for (const kind of GLOBAL_READ_INSTANCEOF_KINDS) {
      expect(ids).toContain(`optimizer-${kind}-direct`);
    }
    for (const kind of GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS) {
      expect(ids).toContain(`optimizer-${kind}`);
    }
    expect(ids).toHaveLength(
      RELEASE_GLOBAL_READ_FORMS.length +
        AUTHORED_COLLISION_BINDING_NAMES.length +
        OPTIMIZER_GLOBAL_READ_BUILTIN_KINDS.length +
        GLOBAL_READ_INSTANCEOF_KINDS.length +
        GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS.length +
        MANUAL_PURE_SIDE_EFFECT_FORMS.length +
        4,
    );
    expect(
      RELEASE_REGRESSION_CASES.filter((entry) => entry.issue === "adjacent/analyzer"),
    ).toHaveLength(52);
    expect(RELEASE_REGRESSION_CASES.filter((entry) => entry.policy === "required")).toHaveLength(
      72,
    );
    expect(
      RELEASE_REGRESSION_CASES.filter((entry) => entry.policy === "assumption-probe"),
    ).toHaveLength(934);
    const arrayLengthProbe = RELEASE_REGRESSION_CASES.find(
      (entry) => entry.id === "optimizer-array-length-call-effect",
    );
    expect(arrayLengthProbe?.policy).toBe("assumption-probe");
    const arrayLengthReader = arrayLengthProbe
      ?.generate(17)
      .program.modules.find((module) => module.id === "gr-reader");
    expect(
      arrayLengthReader?.format === "esm"
        ? arrayLengthReader.globalReadExport?.read.kind
        : undefined,
    ).toBe("math-hypot");

    for (const entry of RELEASE_REGRESSION_CASES) {
      const generated = entry.generate(17);
      expect(validateProgramModel(generated.analyzed), entry.id).toEqual([]);
      expect(entry.onDemandWrapping, entry.id).toBe(
        entry.issue === "#10322" || entry.issue === "adjacent/analyzer",
      );
      if (entry.issue === "adjacent/optimizer") {
        expect(entry.policy, entry.id).toBe("assumption-probe");
        expect(buildConfigOf(generated.program).chunking, entry.id).toEqual({ kind: "disabled" });
      } else {
        expect(entry.policy, entry.id).toBe("required");
      }
    }
  });

  test("only required failures and invalid assumption probes reject the release gate", () => {
    const accepted = aggregateReleaseGateResults([
      { id: "required-pass", policy: "required", verdictKind: "pass" },
      { id: "probe-pass", policy: "assumption-probe", verdictKind: "pass" },
      { id: "probe-mismatch", policy: "assumption-probe", verdictKind: "mismatch" },
    ] as const);
    expect(accepted).toEqual({
      requiredFailures: [],
      assumptionObservations: [
        { id: "probe-mismatch", policy: "assumption-probe", verdictKind: "mismatch" },
      ],
      assumptionProbeValidityFailures: [],
      accepted: true,
      exitCode: 0,
    });

    const requiredFailureKinds = [
      "mismatch",
      "invalid-source",
      "invalid-harness",
      "build-failure",
    ] as const;
    for (const verdictKind of requiredFailureKinds) {
      const result = aggregateReleaseGateResults([
        { id: `required-${verdictKind}`, policy: "required", verdictKind },
      ] as const);
      expect(
        result.requiredFailures.map((failure) => failure.id),
        verdictKind,
      ).toEqual([`required-${verdictKind}`]);
      expect(result.accepted, verdictKind).toBe(false);
      expect(result.exitCode, verdictKind).toBe(1);
    }

    const invalidProbeKinds = ["invalid-source", "invalid-harness", "build-failure"] as const;
    for (const verdictKind of invalidProbeKinds) {
      const result = aggregateReleaseGateResults([
        { id: `probe-${verdictKind}`, policy: "assumption-probe", verdictKind },
      ] as const);
      expect(
        result.assumptionProbeValidityFailures.map((failure) => failure.id),
        verdictKind,
      ).toEqual([`probe-${verdictKind}`]);
      expect(result.assumptionObservations, verdictKind).toEqual([]);
      expect(result.accepted, verdictKind).toBe(false);
      expect(result.exitCode, verdictKind).toBe(1);
    }
  });

  test("renders every global-read form in an event-free reader and observes the patched value downstream", async () => {
    for (const form of GLOBAL_READ_FORMS) {
      const generated = generateGlobalReadOrderCase(41, form);
      const reader = generated.program.modules.find((module) => module.id === "gr-reader");
      const patch = generated.program.modules.find((module) => module.id === "gr-patch");
      const observer = generated.program.modules.find((module) => module.id === "gr-observer");
      if (reader?.format !== "esm" || patch?.format !== "esm" || observer?.format !== "esm") {
        throw new Error(`missing directed global-read modules for ${form}`);
      }

      expect(reader.events).toEqual([]);
      expect(reader.dependencies).toEqual([]);
      expect(reader.globalReadExport?.form).toBe(form);
      expect(generated.coverageTags).toContain(`variation:global-read-form:${form}`);
      const rendered = renderProgram(generated.analyzed);
      const readerPath = rendered.modulePaths.get(reader.id);
      if (readerPath === undefined) {
        throw new Error(`missing rendered reader path for ${form}`);
      }
      const readerSource = fileContents(rendered.files, readerPath);
      expect(readerSource).not.toContain("__orderEvent");

      const eventBase = observer.events[0]?.value;
      const expectedValue = reader.globalReadExport?.expectedValue;
      if (typeof eventBase !== "number" || typeof expectedValue !== "number") {
        throw new Error(`missing numeric global-read oracle values for ${form}`);
      }
      let effectCount = 0;
      if (isManualPureSideEffectForm(form)) {
        expect(readerSource).toContain(EXPECTED_GLOBAL_READ_SYNTAX[form]);
        expect(readerSource).toContain(
          `globalThis["${MANUAL_PURE_SIDE_EFFECT_COUNTER_GLOBAL}"] = 0;`,
        );
        expect(readerSource).not.toContain("globalThis.__orderRead");
        expect(patch.fixtureFunctionAssignment).toBeUndefined();
        expect(reader.globalReadExport).toMatchObject({
          read: { kind: "global-property", name: MANUAL_PURE_SIDE_EFFECT_COUNTER_GLOBAL },
          expectedValue: 1,
          fallbackValue: 0,
        });
        expect(buildConfigOf(generated.program).treeshake.manualPureFunctions).toEqual(["make"]);
      } else if (form === "array-length-call-effect") {
        expect(readerSource).toContain(EXPECTED_GLOBAL_READ_SYNTAX[form]);
        expect(readerSource).not.toContain("globalThis.__orderRead");
        expect(patch.fixtureFunctionAssignment).toBeUndefined();
        expect(patch.builtinAssignments?.[0]).toMatchObject({
          kind: "math-hypot",
          counterGlobal: "__orderFuzzerMathHypotCallCount",
        });
        expect(reader.globalReadExport?.read).toEqual({ kind: "math-hypot" });
        expect(reader.globalReadExport?.expectedValue).toBe(1);
        expect(reader.globalReadExport?.fallbackValue).toBe(1);
        effectCount = 1;
        const counterReader = generated.program.modules.find(
          (module) => module.id === "gr-call-count",
        );
        expect(
          counterReader?.format === "esm"
            ? counterReader.globalReadExport?.expectedValue
            : undefined,
        ).toBe(1);
        expect(observer.events[0]?.reads).toEqual([
          { binding: "observed" },
          { binding: "callCount" },
        ]);
      } else {
        const assignment = patch.fixtureFunctionAssignment;
        if (assignment === undefined) {
          throw new Error(`missing fixture function assignment for ${form}`);
        }
        expect(readerSource).toContain(expectedFixtureGlobalReadSyntax(form));
        expect(readerSource).toContain("/* @__PURE__ */ globalThis.__orderRead?.()");
        expect(readerSource).not.toContain("Math.hypot");
        expect(patch.builtinAssignments).toBeUndefined();
        expect(reader.globalReadExport?.read).toEqual({ kind: "fixture-function-call" });
        expect(expectedValue).toBe(assignment.value);
        if (form === "manual-pure-tagged-template") {
          expect(readerSource).toContain(" = tag``;");
          expect(readerSource).not.toContain("tag`${");
          expect(buildConfigOf(generated.program).treeshake.manualPureFunctions).toEqual(["tag"]);
        }
      }
      await withRenderedProgram(rendered, async (manifestPath) => {
        const outcome = await executeManifest(manifestPath);
        expect(outcome.status, form).toBe("ok");
        expect(outcome.events, form).toContainEqual({
          version: 1,
          module: "gr-observer",
          phase: "evaluate",
          value: eventBase + expectedValue + effectCount,
        });
      });
    }
  }, 30_000);

  test("renders and executes every typed constant-evaluator built-in call", async () => {
    for (const kind of OPTIMIZER_GLOBAL_READ_BUILTIN_KINDS) {
      const spec = globalReadBuiltinSpec(kind);
      const projectedCall = projectGlobalReadBuiltinCall(spec);
      expect(runInNewContext(projectedCall), kind).toBe(spec.fallbackValue);

      const generated = generateGlobalReadOrderCase(47, "direct", kind);
      expect(validateProgramModel(generated.analyzed), kind).toEqual([]);
      expect(buildConfigOf(generated.program).chunking, kind).toEqual({ kind: "disabled" });
      expect(generated.coverageTags, kind).toContain(`variation:global-read-kind:${kind}`);
      const patch = generated.program.modules.find((module) => module.id === "gr-patch");
      const reader = generated.program.modules.find((module) => module.id === "gr-reader");
      const observer = generated.program.modules.find((module) => module.id === "gr-observer");
      if (patch?.format !== "esm" || reader?.format !== "esm" || observer?.format !== "esm") {
        throw new Error(`missing directed optimizer modules for ${kind}`);
      }
      expect(patch.builtinAssignments).toEqual([{ kind, value: spec.patchedValue }]);
      expect(reader.globalReadExport).toMatchObject({
        form: "direct",
        read: { kind },
        expectedValue: spec.patchedValue,
        fallbackValue: spec.fallbackValue,
      });
      const rendered = renderProgram(generated.analyzed);
      const patchPath = rendered.modulePaths.get(patch.id);
      const readerPath = rendered.modulePaths.get(reader.id);
      if (patchPath === undefined || readerPath === undefined) {
        throw new Error(`missing rendered optimizer paths for ${kind}`);
      }
      expect(fileContents(rendered.files, patchPath), kind).toContain(
        `${spec.assignmentTarget} = () =>`,
      );
      expect(fileContents(rendered.files, readerPath), kind).toContain(projectedCall);

      const eventBase = observer.events[0]?.value;
      if (typeof eventBase !== "number") {
        throw new Error(`missing optimizer event base for ${kind}`);
      }
      await withRenderedProgram(rendered, async (manifestPath) => {
        const outcome = await executeManifest(manifestPath);
        expect(outcome.status, kind).toBe("ok");
        expect(outcome.events, kind).toContainEqual({
          version: 1,
          module: "gr-observer",
          phase: "evaluate",
          value: eventBase + spec.patchedValue,
        });
      });
    }
  }, 60_000);

  test("keeps instanceof patches as a separate typed expression family", async () => {
    for (const kind of GLOBAL_READ_INSTANCEOF_KINDS) {
      const spec = globalReadInstanceofSpec(kind);
      const projectedExpression = renderGlobalReadInstanceofExpression(spec);
      expect(runInNewContext(projectedExpression), kind).toBe(spec.fallbackValue);

      const generated = generateGlobalReadInstanceofOrderCase(53, kind);
      expect(validateProgramModel(generated.analyzed), kind).toEqual([]);
      expect(buildConfigOf(generated.program).chunking, kind).toEqual({ kind: "disabled" });
      expect(generated.coverageTags, kind).toContain(`variation:global-read-instanceof:${kind}`);
      const patch = generated.program.modules.find((module) => module.id === "gr-patch");
      const reader = generated.program.modules.find((module) => module.id === "gr-reader");
      const observer = generated.program.modules.find((module) => module.id === "gr-observer");
      if (patch?.format !== "esm" || reader?.format !== "esm" || observer?.format !== "esm") {
        throw new Error(`missing directed instanceof modules for ${kind}`);
      }
      expect(patch.builtinAssignments).toBeUndefined();
      expect(patch.instanceofAssignments).toEqual([{ kind }]);
      expect(reader.globalReadExport).toMatchObject({
        form: "direct",
        read: { kind: "instanceof", expression: kind },
        expectedValue: spec.patchedValue,
        fallbackValue: spec.fallbackValue,
      });

      const rendered = renderProgram(generated.analyzed);
      const patchPath = rendered.modulePaths.get(patch.id);
      const readerPath = rendered.modulePaths.get(reader.id);
      if (patchPath === undefined || readerPath === undefined) {
        throw new Error(`missing rendered instanceof paths for ${kind}`);
      }
      expect(fileContents(rendered.files, patchPath), kind).toContain(
        `globalThis.${spec.constructorName} =`,
      );
      expect(fileContents(rendered.files, readerPath), kind).toContain(projectedExpression);

      const eventBase = observer.events[0]?.value;
      if (typeof eventBase !== "number") {
        throw new Error(`missing instanceof event base for ${kind}`);
      }
      await withRenderedProgram(rendered, async (manifestPath) => {
        const outcome = await executeManifest(manifestPath);
        expect(outcome.status, kind).toBe("ok");
        expect(outcome.events, kind).toContainEqual({
          version: 1,
          module: "gr-observer",
          phase: "evaluate",
          value: eventBase + spec.patchedValue,
        });
      });
    }
  }, 15_000);

  test("renders and executes every closed optimizer-expression key", async () => {
    let minifierSpecCount = 0;
    const executions: Array<() => Promise<void>> = [];
    for (const kind of GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS) {
      const spec = globalReadOptimizerExpressionSpec(kind);
      const generated = generateGlobalReadOptimizerExpressionOrderCase(59, kind);
      expect(validateProgramModel(generated.analyzed), kind).toEqual([]);
      const build = buildConfigOf(generated.program);
      expect(build.chunking, kind).toEqual({ kind: "disabled" });
      expect(build.minify, kind).toBe(spec.requiresMinify === true);
      if (spec.requiresMinify === true) {
        minifierSpecCount += 1;
      }
      expect(generated.coverageTags, kind).toContain(
        `variation:global-read-optimizer-expression:${kind}`,
      );
      expect(generated.coverageTags, kind).toContain(
        `variation:global-read-optimizer-family:${spec.family}`,
      );
      const patch = generated.program.modules.find((module) => module.id === "gr-patch");
      const reader = generated.program.modules.find((module) => module.id === "gr-reader");
      const observer = generated.program.modules.find((module) => module.id === "gr-observer");
      if (patch?.format !== "esm" || reader?.format !== "esm" || observer?.format !== "esm") {
        throw new Error(`missing directed optimizer-expression modules for ${kind}`);
      }
      expect(patch.builtinAssignments).toBeUndefined();
      expect(patch.instanceofAssignments).toBeUndefined();
      expect(patch.optimizerExpressionAssignments).toEqual([{ kind }]);
      expect(reader.globalReadExport).toMatchObject({
        form: "direct",
        read: { kind: "optimizer-expression", expression: kind },
        expectedValue: spec.patchedValue,
        fallbackValue: spec.fallbackValue,
      });
      const counterReader = generated.program.modules.find(
        (module) => module.id === "gr-call-count",
      );
      if (spec.family === "effect-preservation") {
        expect(counterReader?.format).toBe("esm");
        expect(
          counterReader?.format === "esm" ? counterReader.globalReadExport : undefined,
        ).toMatchObject({
          form: "direct",
          read: { kind: "global-property", name: spec.counterGlobal },
          expectedValue: spec.expectedCount,
          fallbackValue: 0,
        });
        expect(observer.dependencies).toContainEqual({
          kind: "esm-value-import",
          target: "gr-call-count",
          importedName: "observedCallCount",
          localName: "callCount",
        });
        expect(observer.events[0]?.reads).toContainEqual({ binding: "callCount" });
      } else {
        expect(counterReader).toBeUndefined();
      }

      const rendered = renderProgram(generated.analyzed);
      const patchPath = rendered.modulePaths.get(patch.id);
      const readerPath = rendered.modulePaths.get(reader.id);
      if (patchPath === undefined || readerPath === undefined) {
        throw new Error(`missing rendered optimizer-expression paths for ${kind}`);
      }
      expect(fileContents(rendered.files, patchPath), kind).toContain(spec.patchStatement);
      const readerSource = fileContents(rendered.files, readerPath);
      expect(readerSource, kind).toContain(spec.numericExpression);
      if (spec.readerPrelude !== undefined) {
        expect(readerSource, kind).toContain(spec.readerPrelude);
      }

      const eventBase = observer.events[0]?.value;
      if (typeof eventBase !== "number") {
        throw new Error(`missing optimizer-expression event base for ${kind}`);
      }
      executions.push(() =>
        withRenderedProgram(rendered, async (manifestPath) => {
          const outcome = await executeManifest(manifestPath);
          expect(outcome.status, `${kind}: ${JSON.stringify(outcome)}`).toBe("ok");
          expect(outcome.events, kind).toContainEqual({
            version: 1,
            module: "gr-observer",
            phase: "evaluate",
            value:
              eventBase +
              spec.patchedValue +
              (spec.family === "effect-preservation" ? spec.expectedCount : 0),
          });
        }),
      );
    }
    const executionConcurrency = 16;
    for (let index = 0; index < executions.length; index += executionConcurrency) {
      await Promise.all(executions.slice(index, index + executionConcurrency).map((run) => run()));
    }
    expect(minifierSpecCount).toBe(MINIFIER_TRANSFORM_OPTIMIZER_EXPRESSION_KINDS.length);
    expect(minifierSpecCount).toBe(9);
  }, 300_000);

  test("freshens dot and computed local-constant receivers around author-selected exports", async () => {
    const cases = [
      {
        kind: "string-to-lower-case-local-const",
        expectedRead: "__optimizerString0.toLowerCase().length",
      },
      {
        kind: "string-to-lower-case-local-const-computed",
        expectedRead: '__optimizerString0["toLowerCase"]().length',
      },
    ] as const satisfies readonly {
      readonly kind: GlobalReadOptimizerExpressionKind;
      readonly expectedRead: string;
    }[];

    for (const { kind, expectedRead } of cases) {
      const generated = generateGlobalReadOptimizerExpressionOrderCase(61, kind);
      const program: ProgramModel = {
        ...generated.program,
        modules: generated.program.modules.map((module) =>
          module.id === "gr-reader" && module.format === "esm"
            ? {
                ...module,
                authoredExportBindings: [
                  { exportedName: "observedGlobalRead", localName: "__optimizerString" },
                ],
              }
            : module,
        ),
      };
      const analyzed = analyzeProgram(program);
      expect(validateProgramModel(analyzed), kind).toEqual([]);
      const rendered = renderProgram(analyzed);
      const readerSource = fileContents(rendered.files, "module-0002.mjs");
      expect(readerSource, kind).toContain('const __optimizerString0 = "ABC";');
      expect(readerSource, kind).toContain(`const __optimizerString = ${expectedRead};`);
      await withRenderedProgram(rendered, async (manifestPath) => {
        const outcome = await executeManifest(manifestPath);
        expect(outcome.status, kind).toBe("ok");
      });
    }
  });

  test("renders exact author-selected locals and composes readable profiler helper names", async () => {
    for (const authoredName of AUTHORED_COLLISION_BINDING_NAMES) {
      const generated = generateAuthoredNameCollisionCase(73, authoredName);
      const build = buildConfigOf(generated.program);
      expect(build.chunking).toEqual({ kind: "disabled" });
      expect(build.strictExecutionOrder).toBe(true);
      expect(build.profilerNames).toBe(
        authoredName === "__esm" ||
          authoredName === "__commonJS" ||
          authoredName === "__getOwnPropNames",
      );
      expect(generated.coverageTags).toContain("mechanism:authored-binding-deconfliction");
      expect(generated.coverageTags).toContain(
        `variation:generated-name-collision:${authoredName}`,
      );

      const reader = generated.program.modules.find((module) => module.id === "nc-user-binding");
      if (reader?.format !== "esm") {
        throw new Error(`missing authored collision reader for ${authoredName}`);
      }
      expect(reader.events).toEqual([]);
      expect(reader.authoredExportBindings).toEqual([
        { exportedName: authoredName, localName: authoredName },
      ]);
      expect(reader.globalReadExport?.form).toBe("direct");

      const rendered = renderProgram(generated.analyzed);
      const readerPath = rendered.modulePaths.get(reader.id);
      if (readerPath === undefined) {
        throw new Error(`missing authored collision path for ${authoredName}`);
      }
      const source = fileContents(rendered.files, readerPath);
      expect(source).toContain(`const ${authoredName} = (globalThis[`);
      expect(source).toContain(`export { ${authoredName} };`);
      expect(source).not.toContain("__orderEvent");

      await withRenderedProgram(rendered, async (manifestPath) => {
        const outcome = await executeManifest(manifestPath);
        expect(outcome.status, authoredName).toBe("ok");
      });
    }
  });

  test("freshens renderer aliases and hidden-read helpers around author-selected locals", async () => {
    const program: ProgramModel = {
      modules: [
        {
          id: "leaf",
          format: "esm",
          dependencies: [],
          events: [{ module: "leaf", phase: "evaluate", value: 2 }],
        },
        {
          id: "consumer",
          format: "esm",
          dependencies: [
            {
              kind: "esm-namespace-import",
              target: "leaf",
              localName: "ns",
              readMembers: [["value"]],
            },
          ],
          events: [
            {
              module: "consumer",
              phase: "evaluate",
              value: 10,
              reads: [{ binding: "ns", memberPath: ["value"], alias: true }],
              hiddenReadFn: true,
            },
          ],
          authoredExportBindings: [
            { exportedName: "ns_alias", localName: "ns_alias" },
            { exportedName: "__hiddenRead0", localName: "__hiddenRead0" },
          ],
        },
        {
          id: "entry",
          format: "esm",
          dependencies: [
            {
              kind: "esm-value-import",
              target: "consumer",
              importedName: "ns_alias",
              localName: "aliasedValue",
            },
            {
              kind: "esm-value-import",
              target: "consumer",
              importedName: "__hiddenRead0",
              localName: "hiddenValue",
            },
          ],
          events: [
            {
              module: "entry",
              phase: "evaluate",
              value: 100,
              reads: [{ binding: "aliasedValue" }, { binding: "hiddenValue" }],
            },
          ],
        },
      ],
      entries: [{ name: "main", moduleId: "entry" }],
      schedule: [{ kind: "import-entry", entry: "main" }],
    };

    const analyzed = analyzeProgram(program);
    expect(validateProgramModel(analyzed)).toEqual([]);
    const rendered = renderProgram(analyzed);
    const source = fileContents(rendered.files, "module-0001.mjs");
    expect(source).toContain("const ns_alias0 = ns;");
    expect(source).toContain("function __hiddenRead1() { return ns_alias0.value; }");
    expect(source).toContain("const ns_alias = 10 + ns.value;");
    expect(source).toContain("const __hiddenRead0 = 10 + ns.value;");

    await withRenderedProgram(rendered, async (manifestPath) => {
      const outcome = await executeManifest(manifestPath);
      expect(outcome.status).toBe("ok");
      expect(outcome.events).toContainEqual({
        version: 1,
        module: "entry",
        phase: "evaluate",
        value: 124,
      });
    });
  });

  test("maps disabled splitting and profilerNames to the public Rolldown output options", () => {
    const request = buildChildRequest(true, true);
    expect(parseBuildChildRequest(request)).toEqual(request);
    expect(createOutputOptions(request)).toMatchObject({
      codeSplitting: false,
      generatedCode: { profilerNames: true },
    });
  });

  test("rejects illegal disabled/authored-name models and shrinks both new build axes", () => {
    const generated = generateAuthoredNameCollisionCase(11, "__esm");
    const twoEntryProgram: ProgramModel = {
      ...generated.program,
      entries: [...generated.program.entries, { name: "duplicate-entry", moduleId: "nc-entry" }],
    };
    expect(validateProgramModel(analyzeProgram(twoEntryProgram))).toContain(
      "build.chunking: disabled code splitting requires exactly one entry, received 2",
    );

    const invalidAuthoredLocal: ProgramModel = {
      ...generated.program,
      modules: generated.program.modules.map((module) =>
        module.id === "nc-user-binding" && module.format === "esm"
          ? {
              ...module,
              authoredExportBindings: [{ exportedName: "__esm", localName: "globalThis" }],
            }
          : module,
      ),
    };
    expect(validateProgramModel(analyzeProgram(invalidAuthoredLocal))).toContain(
      'modules[1].authoredExportBindings[0].localName: reserved renderer binding identifier "globalThis"',
    );

    const validCandidates = [...candidates(generated.program)].filter(
      (candidate) => validateProgramModel(analyzeProgram(candidate)).length === 0,
    );
    expect(
      validCandidates.some((candidate) => buildConfigOf(candidate).chunking.kind === "automatic"),
    ).toBe(true);
    expect(
      validCandidates.some((candidate) => buildConfigOf(candidate).profilerNames === false),
    ).toBe(true);
  });

  test("validates exclusive global patches and shrinks typed expression syntax", () => {
    const generated = generateGlobalReadOrderCase(19, "direct", "math-max");
    const withTwoPatchFamilies: ProgramModel = {
      ...generated.program,
      modules: generated.program.modules.map((module) =>
        module.id === "gr-patch" && module.format === "esm"
          ? { ...module, instanceofAssignments: [{ kind: "array-instanceof-object" }] }
          : module,
      ),
    };
    expect(validateProgramModel(analyzeProgram(withTwoPatchFamilies))).toContain(
      "modules[1]: a global patch module may carry at most one fixture-function, builtin, instanceof, or optimizer-expression assignment, received 2",
    );

    const manualPureEffect = generateGlobalReadOrderCase(19, "manual-pure-computed-key-effect");
    const withoutManualPure = structuredClone(manualPureEffect.program) as ProgramModel;
    if (withoutManualPure.build === undefined) {
      throw new Error("missing manual-pure effect build config");
    }
    (
      withoutManualPure.build.treeshake as unknown as {
        manualPureFunctions: string[];
      }
    ).manualPureFunctions = [];
    expect(validateProgramModel(analyzeProgram(withoutManualPure))).toContain(
      'manual-pure side-effect witness requires build.treeshake.manualPureFunctions to include "make"',
    );

    const taggedTemplate = generateGlobalReadOrderCase(19, "manual-pure-tagged-template");
    const taggedTemplateWithoutManualPure = structuredClone(taggedTemplate.program) as ProgramModel;
    if (taggedTemplateWithoutManualPure.build === undefined) {
      throw new Error("missing tagged-template build config");
    }
    (
      taggedTemplateWithoutManualPure.build.treeshake as unknown as {
        manualPureFunctions: string[];
      }
    ).manualPureFunctions = [];
    expect(validateProgramModel(analyzeProgram(taggedTemplateWithoutManualPure))).toContain(
      'modules[2].globalReadExport.form: manual-pure-tagged-template requires build.treeshake.manualPureFunctions to include "tag"',
    );

    const wrongManualPureCounter = structuredClone(manualPureEffect.program) as ProgramModel;
    const manualPureReader = wrongManualPureCounter.modules.find(
      (module) => module.id === "gr-reader",
    );
    if (
      manualPureReader?.format !== "esm" ||
      manualPureReader.globalReadExport?.read.kind !== "global-property"
    ) {
      throw new Error("missing manual-pure side-effect reader");
    }
    (
      manualPureReader.globalReadExport.read as unknown as {
        name: string;
      }
    ).name = "__wrongManualPureEffectCounter";
    expect(validateProgramModel(analyzeProgram(wrongManualPureCounter))).toContain(
      `modules[2].globalReadExport.read: manual-pure-computed-key-effect requires the fixture-owned "${MANUAL_PURE_SIDE_EFFECT_COUNTER_GLOBAL}" global-property counter`,
    );

    const callEffect = generateGlobalReadOrderCase(23, "array-length-call-effect");
    expect(
      [...candidates(callEffect.program)].some((candidate) => {
        const patch = candidate.modules.find((module) => module.id === "gr-patch");
        return (
          patch?.format === "esm" &&
          patch.builtinAssignments?.[0]?.kind === "math-hypot" &&
          patch.builtinAssignments[0]?.counterGlobal === undefined
        );
      }),
    ).toBe(true);

    const computed = generateGlobalReadOptimizerExpressionOrderCase(29, "math-max-computed");
    expect(
      [...candidates(computed.program)].some((candidate) => {
        const patch = candidate.modules.find((module) => module.id === "gr-patch");
        const reader = candidate.modules.find((module) => module.id === "gr-reader");
        return (
          patch?.format === "esm" &&
          patch.optimizerExpressionAssignments === undefined &&
          patch.builtinAssignments?.[0]?.kind === "math-max" &&
          reader?.format === "esm" &&
          reader.globalReadExport?.read.kind === "math-max"
        );
      }),
    ).toBe(true);

    const computedLocal = generateGlobalReadOptimizerExpressionOrderCase(
      31,
      "string-to-lower-case-local-const-computed",
    );
    expect(
      [...candidates(computedLocal.program)].some((candidate) => {
        const patch = candidate.modules.find((module) => module.id === "gr-patch");
        const reader = candidate.modules.find((module) => module.id === "gr-reader");
        return (
          patch?.format === "esm" &&
          patch.optimizerExpressionAssignments === undefined &&
          patch.builtinAssignments?.[0]?.kind === "string-to-lower-case" &&
          reader?.format === "esm" &&
          reader.globalReadExport?.read.kind === "string-to-lower-case"
        );
      }),
    ).toBe(true);

    const effect = generateGlobalReadOptimizerExpressionOrderCase(
      37,
      "array-computed-length-effect",
    );
    expect(
      [...candidates(effect.program)].some((candidate) =>
        candidate.modules.some(
          (module) => module.format === "esm" && (module.builtinAssignments?.length ?? 0) > 0,
        ),
      ),
    ).toBe(false);

    const ordinaryEqualValue = structuredClone(computed.program) as ProgramModel;
    const ordinaryEqualReader = ordinaryEqualValue.modules.find(
      (module) => module.id === "gr-reader",
    );
    if (
      ordinaryEqualReader?.format !== "esm" ||
      ordinaryEqualReader.globalReadExport === undefined
    ) {
      throw new Error("missing ordinary optimizer reader for equal-value validation");
    }
    (
      ordinaryEqualReader.globalReadExport as unknown as {
        expectedValue: number;
        readonly fallbackValue: number;
      }
    ).expectedValue = ordinaryEqualReader.globalReadExport.fallbackValue;
    expect(validateProgramModel(analyzeProgram(ordinaryEqualValue))).toContain(
      "modules[2].globalReadExport: expectedValue and fallbackValue must differ so reordering is observable",
    );

    const wrongEffectCounter = structuredClone(effect.program) as ProgramModel;
    const counterReader = wrongEffectCounter.modules.find(
      (module) => module.id === "gr-call-count",
    );
    if (
      counterReader?.format !== "esm" ||
      counterReader.globalReadExport?.read.kind !== "global-property"
    ) {
      throw new Error("missing effect-preservation counter reader");
    }
    (
      counterReader.globalReadExport.read as unknown as {
        name: string;
      }
    ).name = "__wrongOptimizerEffectCounter";
    expect(validateProgramModel(analyzeProgram(wrongEffectCounter))).toContain(
      'modules[2].globalReadExport: effect-preservation expression "array-computed-length-effect" requires exactly one direct "__orderFuzzerOptimizerEffectCallCount" counter reader expecting 1, received 0',
    );

    const earlyEffectCounter = structuredClone(effect.program) as ProgramModel;
    const earlyCounterObserver = earlyEffectCounter.modules.find(
      (module) => module.id === "gr-observer",
    );
    if (earlyCounterObserver?.format !== "esm") {
      throw new Error("missing effect-preservation observer");
    }
    const mutableDependencies = earlyCounterObserver.dependencies as unknown as Array<
      (typeof earlyCounterObserver.dependencies)[number]
    >;
    const valueDependency = mutableDependencies[1];
    const counterDependency = mutableDependencies[2];
    if (valueDependency === undefined || counterDependency === undefined) {
      throw new Error("missing effect-preservation value/counter dependencies");
    }
    mutableDependencies[1] = counterDependency;
    mutableDependencies[2] = valueDependency;
    expect(validateProgramModel(analyzeProgram(earlyEffectCounter))).toContain(
      'modules[2].globalReadExport: effect-preservation expression "array-computed-length-effect" requires a downstream event that imports its patch, expression, and "__orderFuzzerOptimizerEffectCallCount" counter in that order and reads both values',
    );

    const invalidKey = structuredClone(computed.program) as unknown as {
      modules: Array<{
        id: string;
        optimizerExpressionAssignments?: Array<{ kind: string }>;
        globalReadExport?: { read: { kind: string; expression?: string } };
      }>;
    };
    const invalidPatch = invalidKey.modules.find((module) => module.id === "gr-patch");
    const invalidReader = invalidKey.modules.find((module) => module.id === "gr-reader");
    if (
      invalidPatch?.optimizerExpressionAssignments?.[0] === undefined ||
      invalidReader?.globalReadExport === undefined
    ) {
      throw new Error("missing optimizer-expression modules for invalid-key validation");
    }
    invalidPatch.optimizerExpressionAssignments[0].kind = "not-a-closed-key";
    invalidReader.globalReadExport.read.expression = "not-a-closed-key";
    const invalidErrors = validateProgramModel(
      analyzeProgram(invalidKey as unknown as ProgramModel),
    );
    expect(invalidErrors).toContain(
      'modules[1].optimizerExpressionAssignments[0].kind: unknown optimizer expression assignment "not-a-closed-key"',
    );
    expect(invalidErrors).toContain(
      'modules[2].globalReadExport.read.expression: unknown optimizer expression "not-a-closed-key"',
    );

    const invalidForm = structuredClone(computed.program) as ProgramModel;
    const invalidFormReader = invalidForm.modules.find((module) => module.id === "gr-reader");
    if (invalidFormReader?.format !== "esm" || invalidFormReader.globalReadExport === undefined) {
      throw new Error("missing optimizer-expression reader for direct-form validation");
    }
    (
      invalidFormReader as unknown as {
        globalReadExport: { form: GlobalReadForm };
      }
    ).globalReadExport.form = "direct-arrow-iife";
    expect(validateProgramModel(analyzeProgram(invalidForm))).toContain(
      "modules[2].globalReadExport.form: optimizer-expression reads require the direct form",
    );
  });

  test("persists disabled splitting and profilerNames in failure artifact identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-release-identity-"));
    const generated = generateAuthoredNameCollisionCase(29, "__esm");
    try {
      const artifactDirectory = await writeFailureArtifacts(failedCase(generated), directory, 0);
      const identity = JSON.parse(
        await readFile(join(artifactDirectory, "identity.json"), "utf8"),
      ) as {
        readonly inputs: {
          readonly buildOptions: {
            readonly codeSplitting: unknown;
            readonly profilerNames: unknown;
          };
        };
      };
      expect(identity.inputs.buildOptions.codeSplitting).toBe(false);
      expect(identity.inputs.buildOptions.profilerNames).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("persists every typed optimizer expression family in artifact identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "order-optimizer-identity-"));
    const generatedCases = [
      generateGlobalReadOrderCase(31, "direct", "string-replace-all"),
      generateGlobalReadInstanceofOrderCase(31, "array-instanceof-object"),
      generateGlobalReadOptimizerExpressionOrderCase(31, "array-subtraction-coercion"),
      generateGlobalReadOptimizerExpressionOrderCase(31, "array-computed-length-effect"),
    ];
    try {
      const artifactDirectories = await Promise.all(
        generatedCases.map((generated, index) =>
          writeFailureArtifacts(failedCase(generated), directory, index),
        ),
      );
      expect(new Set(artifactDirectories).size).toBe(artifactDirectories.length);
      for (const [index, artifactDirectory] of artifactDirectories.entries()) {
        const identity = JSON.parse(
          await readFile(join(artifactDirectory, "identity.json"), "utf8"),
        ) as { readonly inputs: { readonly case: { readonly model: ProgramModel } } };
        expect(identity.inputs.case.model).toEqual(generatedCases[index]?.program);
        expect(JSON.parse(await readFile(join(artifactDirectory, "model.json"), "utf8"))).toEqual(
          generatedCases[index]?.program,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("ordinary campaign cycles through required escaped families without assumption probes", () => {
    for (const [index, form] of ANALYZER_GLOBAL_READ_FORMS.entries()) {
      const generated = generateCase(index * 32, 4);
      const reader = generated.program.modules.find((module) => module.id === "gr-reader");
      expect(reader?.format).toBe("esm");
      expect(reader?.format === "esm" ? reader.globalReadExport?.form : undefined).toBe(form);
    }
    for (const [index, authoredName] of AUTHORED_COLLISION_BINDING_NAMES.entries()) {
      const generated = generateCase(index * 32 + 1, 4);
      const reader = generated.program.modules.find((module) => module.id === "nc-user-binding");
      expect(reader?.format).toBe("esm");
      expect(
        reader?.format === "esm" ? reader.authoredExportBindings?.[0]?.localName : undefined,
      ).toBe(authoredName);
      expect(buildConfigOf(generated.program).outputFormat).toBe("esm");
      expect(generated.onDemandWrapping).toBe(false);
    }
    for (const [index, authoredName] of CJS_AUTHORED_COLLISION_BINDING_NAMES.entries()) {
      const generated = generateCase(index * 32 + 6, 4);
      const reader = generated.program.modules.find((module) => module.id === "nc-user-binding");
      expect(reader?.format).toBe("esm");
      expect(
        reader?.format === "esm" ? reader.authoredExportBindings?.[0]?.localName : undefined,
      ).toBe(authoredName);
      expect(buildConfigOf(generated.program).outputFormat).toBe("cjs");
      expect(generated.onDemandWrapping).toBe(false);
    }
    for (const lane of [2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]) {
      for (let cycle = 0; cycle < 4; cycle += 1) {
        const generated = generateCase(cycle * 32 + lane, 4);
        expect(
          generated.program.modules.some(
            (module) =>
              module.format === "esm" &&
              (module.fixtureFunctionAssignment !== undefined ||
                (module.authoredExportBindings?.length ?? 0) > 0 ||
                (module.builtinAssignments?.length ?? 0) > 0 ||
                (module.instanceofAssignments?.length ?? 0) > 0 ||
                (module.optimizerExpressionAssignments?.length ?? 0) > 0),
          ),
          `retired lane ${String(lane)}, cycle ${String(cycle)}`,
        ).toBe(false);
      }
    }
  });
});

function buildChildRequest(
  disableCodeSplitting: boolean,
  profilerNames: boolean,
): BuildChildRequest {
  return {
    version: BUILD_CHILD_PROTOCOL_VERSION,
    packageSpecifier: "rolldown",
    input: { main: "/fixture/source/entry.mjs" },
    preserveEntrySignatures: "allow-extension",
    includeDependenciesRecursively: true,
    lazyBarrel: false,
    onDemandWrapping: false,
    disableCodeSplitting,
    treeshake: DEFAULT_TREESHAKE_CONFIG,
    bundleDirectory: "/fixture/bundle",
    manualChunkGroups: [],
    organicChunkGroups: [],
    output: {
      format: "esm",
      strictExecutionOrder: true,
      entryFileNames: "entries/[name].js",
      chunkFileNames: "chunks/[name].js",
      assetFileNames: "assets/[name][extname]",
      cleanDir: false,
      minify: false,
      profilerNames,
    },
  };
}

function failedCase(generated: GeneratedCase): CampaignCaseResult {
  const rendered = renderProgram(generated.analyzed);
  return {
    generated,
    options: {
      seed: generated.seed,
      cases: 1,
      caseSize: generated.size,
      sizeMix: false,
      onDemandWrapping: false,
      rolldownPackage: "rolldown",
      outDir: "failures",
      continueOnFail: false,
    },
    rendered,
    sourceOutcome: {
      version: 1,
      status: "ok",
      events: [{ version: 1, module: "missing", phase: "evaluate", value: 1 }],
    },
    bundleOutcome: { version: 1, status: "ok", events: [] },
    bundleManifest: null,
    bundleFiles: [],
    runtimeIdentity: testRuntimeIdentity(),
    verdict: {
      kind: "mismatch",
      reason: "events-missing",
      signature: 'events-missing:source=[["missing","evaluate",1]]:bundle=[]',
    },
  };
}

function testRuntimeIdentity(): ObservedRuntimeIdentity {
  return {
    processVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    requestedPackageSpecifier: "rolldown",
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

async function withRenderedProgram(
  rendered: RenderedProgram,
  run: (manifestPath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "order-release-regression-"));
  try {
    for (const file of rendered.files) {
      const path = join(directory, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.contents);
    }
    await run(join(directory, rendered.schedulePath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
