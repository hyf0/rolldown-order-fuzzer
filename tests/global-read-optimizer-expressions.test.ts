/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { describe, expect, test } from "vite-plus/test";

import { OPTIMIZER_GLOBAL_READ_BUILTIN_KINDS } from "../src/global-read-builtins.ts";
import {
  ADJACENT_INSTANCEOF_CONSTRUCTOR_OPTIMIZER_EXPRESSION_KINDS,
  COMPOUND_RECEIVER_OPTIMIZER_EXPRESSION_KINDS,
  COMPUTED_LOCAL_CONST_OPTIMIZER_EXPRESSION_KINDS,
  COMPUTED_KEY_EXPRESSION_OPTIMIZER_EXPRESSION_KINDS,
  EFFECT_PRESERVATION_OPTIMIZER_EXPRESSION_KINDS,
  GLOBAL_READ_OPTIMIZER_EFFECT_COUNTER,
  GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS,
  GLOBAL_READ_OPTIMIZER_EXPRESSION_SPECS,
  INSTANCEOF_CONSTRUCTOR_OPTIMIZER_EXPRESSION_KINDS,
  INSTANCEOF_LEFT_EXPRESSION_OPTIMIZER_EXPRESSION_KINDS,
  MINIFIER_TRANSFORM_OPTIMIZER_EXPRESSION_KINDS,
  NUMBER_NAN_OPTIMIZER_EXPRESSION_KINDS,
  OPTIONAL_COMPUTED_KEY_OPTIMIZER_EXPRESSION_KINDS,
  OPTIONAL_PARENTHESIZED_CALLEE_OPTIMIZER_EXPRESSION_KINDS,
  OPTIONAL_RECEIVER_OPTIMIZER_EXPRESSION_KINDS,
  PARENTHESIZED_STATIC_RECEIVER_OPTIMIZER_EXPRESSION_KINDS,
  SECOND_WAVE_COERCION_OPTIMIZER_EXPRESSION_KINDS,
  SECOND_WAVE_EFFECT_PRESERVATION_OPTIMIZER_EXPRESSION_KINDS,
  globalReadOptimizerExpressionSpec,
  type AdjacentInstanceofConstructorVariant,
  type CompoundReceiverVariant,
  type ComputedKeyExpressionVariant,
  type GlobalReadOptimizerExpressionFamily,
  type GlobalReadOptimizerExpressionKind,
  type InstanceofLeftExpressionVariant,
  type InstanceofConstructorVariant,
  type OptionalParenthesizedCalleeVariant,
} from "../src/global-read-optimizer-expressions.ts";

const NON_MEMBER_BUILTIN_KINDS = new Set([
  "global-encode-uri",
  "global-encode-uri-component",
  "global-decode-uri",
  "global-decode-uri-component",
  "global-is-nan",
  "global-is-finite",
  "global-parse-float",
  "global-parse-int",
]);

const EXPECTED_COMPUTED_KEYS = OPTIMIZER_GLOBAL_READ_BUILTIN_KINDS.filter(
  (kind) => !NON_MEMBER_BUILTIN_KINDS.has(kind),
).map((kind) => `${kind}-computed` as GlobalReadOptimizerExpressionKind);

const EXPECTED_LOCAL_CONST_KEYS = [
  "string-to-lower-case-local-const",
  "string-to-upper-case-local-const",
  "string-trim-local-const",
  "string-trim-start-local-const",
  "string-trim-end-local-const",
  "number-to-string-local-const",
  "string-to-string-local-const",
  "boolean-to-string-local-const",
  "bigint-to-string-local-const",
] as const satisfies readonly GlobalReadOptimizerExpressionKind[];

const EXPECTED_COMPUTED_LOCAL_CONST_SPECS = {
  "string-to-lower-case-local-const-computed": {
    builtinKind: "string-to-lower-case",
    readerBinding: "__optimizerString",
    readerPrelude: 'const __optimizerString = "ABC";',
    numericExpression: '__optimizerString["toLowerCase"]().length',
  },
  "string-to-upper-case-local-const-computed": {
    builtinKind: "string-to-upper-case",
    readerBinding: "__optimizerString",
    readerPrelude: 'const __optimizerString = "abc";',
    numericExpression: '__optimizerString["toUpperCase"]().length',
  },
  "string-trim-local-const-computed": {
    builtinKind: "string-trim",
    readerBinding: "__optimizerString",
    readerPrelude: 'const __optimizerString = " a ";',
    numericExpression: '__optimizerString["trim"]().length',
  },
  "string-trim-start-local-const-computed": {
    builtinKind: "string-trim-start",
    readerBinding: "__optimizerString",
    readerPrelude: 'const __optimizerString = " a ";',
    numericExpression: '__optimizerString["trimStart"]().length',
  },
  "string-trim-end-local-const-computed": {
    builtinKind: "string-trim-end",
    readerBinding: "__optimizerString",
    readerPrelude: 'const __optimizerString = " a ";',
    numericExpression: '__optimizerString["trimEnd"]().length',
  },
  "number-to-string-local-const-computed": {
    builtinKind: "number-to-string",
    readerBinding: "__optimizerNumber",
    readerPrelude: "const __optimizerNumber = 12;",
    numericExpression: '__optimizerNumber["toString"]().length',
  },
  "string-to-string-local-const-computed": {
    builtinKind: "string-to-string",
    readerBinding: "__optimizerString",
    readerPrelude: 'const __optimizerString = "abc";',
    numericExpression: '__optimizerString["toString"]().length',
  },
  "boolean-to-string-local-const-computed": {
    builtinKind: "boolean-to-string",
    readerBinding: "__optimizerBoolean",
    readerPrelude: "const __optimizerBoolean = true;",
    numericExpression: '__optimizerBoolean["toString"]().length',
  },
  "bigint-to-string-local-const-computed": {
    builtinKind: "bigint-to-string",
    readerBinding: "__optimizerBigInt",
    readerPrelude: "const __optimizerBigInt = 1n;",
    numericExpression: '__optimizerBigInt["toString"]().length',
  },
} as const satisfies Partial<
  Record<
    GlobalReadOptimizerExpressionKind,
    {
      readonly builtinKind: string;
      readonly readerBinding: string;
      readonly readerPrelude: string;
      readonly numericExpression: string;
    }
  >
>;

type ExpectedComputedLocalConstKind = keyof typeof EXPECTED_COMPUTED_LOCAL_CONST_SPECS;

const EXPECTED_COMPUTED_LOCAL_CONST_KEYS = Object.freeze(
  Object.keys(EXPECTED_COMPUTED_LOCAL_CONST_SPECS) as ExpectedComputedLocalConstKind[],
);

const EXPECTED_COMPUTED_KEY_VARIANTS = [
  "concatenation",
  "conditional",
  "sequence",
  "logical-and",
  "logical-or",
  "nullish-coalescing",
] as const satisfies readonly ComputedKeyExpressionVariant[];

const EXPECTED_COMPUTED_MEMBER_SOURCE_KEYS = [
  ...EXPECTED_COMPUTED_KEYS,
  ...EXPECTED_COMPUTED_LOCAL_CONST_KEYS,
] as const;

const EXPECTED_COMPUTED_KEY_EXPRESSION_KEYS = EXPECTED_COMPUTED_MEMBER_SOURCE_KEYS.flatMap(
  (sourceKind) =>
    EXPECTED_COMPUTED_KEY_VARIANTS.map(
      (variant) => `${sourceKind}-key-${variant}` as GlobalReadOptimizerExpressionKind,
    ),
);

const EXPECTED_OPTIONAL_SOURCE_KEYS = [
  ...EXPECTED_COMPUTED_KEYS.slice(18),
  ...EXPECTED_COMPUTED_LOCAL_CONST_KEYS,
] as const;

const EXPECTED_OPTIONAL_RECEIVER_KEYS = EXPECTED_OPTIONAL_SOURCE_KEYS.map(
  (sourceKind) => `${sourceKind}-optional-receiver` as GlobalReadOptimizerExpressionKind,
);

const EXPECTED_INSTANCEOF_CONSTRUCTOR_VARIANTS = [
  "conditional",
  "sequence",
  "logical-and",
  "parenthesized",
] as const satisfies readonly InstanceofConstructorVariant[];

const EXPECTED_INSTANCEOF_SOURCE_KEYS = [
  "array-instanceof-object",
  "number-instanceof-number",
  "boolean-instanceof-boolean",
  "string-instanceof-string",
] as const;

const EXPECTED_INSTANCEOF_CONSTRUCTOR_KEYS = EXPECTED_INSTANCEOF_SOURCE_KEYS.flatMap((sourceKind) =>
  EXPECTED_INSTANCEOF_CONSTRUCTOR_VARIANTS.map(
    (variant) => `${sourceKind}-constructor-${variant}` as GlobalReadOptimizerExpressionKind,
  ),
);

const EXPECTED_ADJACENT_INSTANCEOF_CONSTRUCTOR_VARIANTS = [
  "logical-or",
  "nullish-coalescing",
  "undefined-nullish-coalescing",
] as const satisfies readonly AdjacentInstanceofConstructorVariant[];

const EXPECTED_ADJACENT_INSTANCEOF_CONSTRUCTOR_KEYS = EXPECTED_INSTANCEOF_SOURCE_KEYS.flatMap(
  (sourceKind) =>
    EXPECTED_ADJACENT_INSTANCEOF_CONSTRUCTOR_VARIANTS.map(
      (variant) => `${sourceKind}-constructor-${variant}` as GlobalReadOptimizerExpressionKind,
    ),
);

const EXPECTED_INSTANCEOF_LEFT_VARIANTS = [
  "conditional",
  "sequence",
  "logical-and",
  "logical-or",
  "nullish-coalescing",
] as const satisfies readonly InstanceofLeftExpressionVariant[];

const EXPECTED_INSTANCEOF_LEFT_KEYS = EXPECTED_INSTANCEOF_SOURCE_KEYS.flatMap((sourceKind) =>
  EXPECTED_INSTANCEOF_LEFT_VARIANTS.map(
    (variant) => `${sourceKind}-left-${variant}` as GlobalReadOptimizerExpressionKind,
  ),
);

const EXPECTED_PARENTHESIZED_STATIC_RECEIVER_KEYS = EXPECTED_COMPUTED_KEYS.slice(0, 18).map(
  (sourceKind) => `${sourceKind}-parenthesized-receiver` as GlobalReadOptimizerExpressionKind,
);

const EXPECTED_COMPOUND_RECEIVER_VARIANTS = [
  "conditional",
  "sequence",
  "logical-and",
  "logical-or",
  "nullish-coalescing",
] as const satisfies readonly Exclude<CompoundReceiverVariant, "concatenation">[];

const EXPECTED_STRING_RECEIVER_SOURCE_KEYS = [
  ...EXPECTED_COMPUTED_KEYS.slice(18, 33),
  ...EXPECTED_COMPUTED_LOCAL_CONST_KEYS.filter((kind) => kind.startsWith("string-")),
] as const;

const EXPECTED_STRING_RECEIVER_SOURCE_SET = new Set<string>(EXPECTED_STRING_RECEIVER_SOURCE_KEYS);

const EXPECTED_COMPOUND_RECEIVER_KEYS = EXPECTED_OPTIONAL_SOURCE_KEYS.flatMap((sourceKind) => [
  ...EXPECTED_COMPOUND_RECEIVER_VARIANTS.map(
    (variant) => `${sourceKind}-receiver-${variant}` as GlobalReadOptimizerExpressionKind,
  ),
  ...(EXPECTED_STRING_RECEIVER_SOURCE_SET.has(sourceKind)
    ? ([`${sourceKind}-receiver-concatenation`] as GlobalReadOptimizerExpressionKind[])
    : []),
]);

const EXPECTED_OPTIONAL_COMPUTED_KEY_KEYS = EXPECTED_OPTIONAL_SOURCE_KEYS.flatMap((sourceKind) =>
  EXPECTED_COMPUTED_KEY_VARIANTS.map(
    (variant) => `${sourceKind}-optional-key-${variant}` as GlobalReadOptimizerExpressionKind,
  ),
);

const EXPECTED_OPTIONAL_PARENTHESIZED_CALLEE_VARIANTS = [
  "computed",
  "dot",
] as const satisfies readonly OptionalParenthesizedCalleeVariant[];

const EXPECTED_OPTIONAL_PARENTHESIZED_CALLEE_KEYS = EXPECTED_OPTIONAL_SOURCE_KEYS.flatMap(
  (sourceKind) =>
    EXPECTED_OPTIONAL_PARENTHESIZED_CALLEE_VARIANTS.map(
      (variant) =>
        `${sourceKind}-optional-parenthesized-${variant}-callee` as GlobalReadOptimizerExpressionKind,
    ),
);

const EXPECTED_COERCION_KEYS = [
  "array-to-number-via-to-string",
  "array-to-number-via-join",
  "array-to-number-via-value-of",
  "array-to-number-via-to-primitive",
  "object-to-number-via-to-string",
  "object-to-number-via-value-of",
  "object-to-number-via-to-primitive",
  "regexp-to-number-via-to-string",
  "regexp-to-number-via-value-of",
  "regexp-to-number-via-to-primitive",
  "array-to-string-addition",
  "object-to-string-addition",
  "regexp-to-string-addition",
  "array-bitwise-not-coercion",
  "array-subtraction-coercion",
  "array-element-object-coercion",
] as const satisfies readonly GlobalReadOptimizerExpressionKind[];

const EXPECTED_SECOND_WAVE_COERCION_KEYS = [
  "array-multiplication-coercion",
  "array-division-coercion",
  "array-remainder-coercion",
  "array-exponentiation-coercion",
  "array-bitwise-or-coercion",
  "array-bitwise-and-coercion",
  "array-bitwise-xor-coercion",
  "array-shift-left-coercion",
  "array-shift-right-coercion",
  "array-unsigned-shift-right-coercion",
  "array-template-coercion",
  "math-abs-array-argument-coercion",
] as const satisfies readonly GlobalReadOptimizerExpressionKind[];

const EXPECTED_NUMBER_INFINITY_KEYS = [
  "number-positive-infinity-type-shortcut",
  "number-negative-infinity-type-shortcut",
] as const satisfies readonly GlobalReadOptimizerExpressionKind[];

const EXPECTED_EFFECT_PRESERVATION_SPECS = {
  "array-computed-length-effect": {
    numericExpression: '[Math.hypot()]["length"]',
    value: 1,
  },
  "unary-void-call-effect": {
    numericExpression: "+(void Math.hypot() === undefined)",
    value: 1,
  },
  "sequence-call-effect": { numericExpression: "(Math.hypot(), 1)", value: 1 },
  "not-array-call-effect": { numericExpression: "+(![Math.hypot()])", value: 0 },
  "typeof-object-call-effect": {
    numericExpression: "(typeof ({ x: Math.hypot() })).length",
    value: 6,
  },
  "strict-eq-date-effect": { numericExpression: "+(new Date() === 0)", value: 0 },
  "logical-array-and-effect": { numericExpression: "([Math.hypot()] && 1)", value: 1 },
  "instanceof-array-call-effect": {
    numericExpression: "+([Math.hypot()] instanceof Object)",
    value: 1,
  },
  "not-class-static-call-effect": {
    numericExpression: "+(!(class { static x = Math.hypot(); }))",
    value: 0,
  },
  "not-date-construction-effect": { numericExpression: "+(!new Date())", value: 0 },
  "not-object-call-effect": {
    numericExpression: "+(!({ x: Math.hypot() }))",
    value: 0,
  },
  "sequence-date-construction-effect": { numericExpression: "(new Date(), 1)", value: 1 },
  "strict-eq-array-call-effect": {
    numericExpression: "+([Math.hypot()] === 0)",
    value: 0,
  },
  "strict-eq-object-call-effect": {
    numericExpression: "+(({ x: Math.hypot() }) === 0)",
    value: 0,
  },
  "typeof-array-call-effect": {
    numericExpression: "(typeof [Math.hypot()]).length",
    value: 6,
  },
  "typeof-class-static-call-effect": {
    numericExpression: "(typeof class { static x = Math.hypot(); }).length",
    value: 8,
  },
  "unary-void-date-effect": {
    numericExpression: "+(void new Date() === undefined)",
    value: 1,
  },
} as const satisfies Partial<
  Record<
    GlobalReadOptimizerExpressionKind,
    { readonly numericExpression: string; readonly value: number }
  >
>;

type ExpectedEffectPreservationKind = keyof typeof EXPECTED_EFFECT_PRESERVATION_SPECS;

const EXPECTED_EFFECT_PRESERVATION_KEYS = Object.freeze(
  Object.keys(EXPECTED_EFFECT_PRESERVATION_SPECS) as ExpectedEffectPreservationKind[],
);

const EXPECTED_SECOND_WAVE_EFFECT_SPECS = {
  "conditional-array-call-effect": {
    numericExpression: "+([Math.hypot()] ? 1 : 0)",
    value: 1,
  },
  "conditional-object-call-effect": {
    numericExpression: "+(({ x: Math.hypot() }) ? 1 : 0)",
    value: 1,
  },
  "conditional-class-static-call-effect": {
    numericExpression: "+((class { static x = Math.hypot(); }) ? 1 : 0)",
    value: 1,
  },
  "conditional-date-effect": { numericExpression: "+(new Date() ? 1 : 0)", value: 1 },
  "unary-void-array-call-effect": {
    numericExpression: "+(void [Math.hypot()] === undefined)",
    value: 1,
  },
  "unary-void-object-call-effect": {
    numericExpression: "+(void ({ x: Math.hypot() }) === undefined)",
    value: 1,
  },
  "unary-void-class-static-call-effect": {
    numericExpression: "+(void (class { static x = Math.hypot(); }) === undefined)",
    value: 1,
  },
  "sequence-array-call-effect": { numericExpression: "([Math.hypot()], 1)", value: 1 },
  "sequence-object-call-effect": {
    numericExpression: "(({ x: Math.hypot() }), 1)",
    value: 1,
  },
  "sequence-class-static-call-effect": {
    numericExpression: "((class { static x = Math.hypot(); }), 1)",
    value: 1,
  },
  "strict-eq-class-static-call-effect": {
    numericExpression: "+((class { static x = Math.hypot(); }) === 0)",
    value: 0,
  },
  "instanceof-class-static-call-effect": {
    numericExpression: "+((class { static x = Math.hypot(); }) instanceof Object)",
    value: 1,
  },
  "logical-object-and-effect": {
    numericExpression: "(({ x: Math.hypot() }) && 1)",
    value: 1,
  },
  "logical-class-and-effect": {
    numericExpression: "((class { static x = Math.hypot(); }) && 1)",
    value: 1,
  },
  "logical-array-or-effect": { numericExpression: "([Math.hypot()] || 1).length", value: 1 },
  "logical-date-and-effect": { numericExpression: "(new Date() && 1)", value: 1 },
  "logical-date-or-effect": { numericExpression: "+((new Date() || 1) === 1)", value: 0 },
} as const satisfies Partial<
  Record<
    GlobalReadOptimizerExpressionKind,
    { readonly numericExpression: string; readonly value: number }
  >
>;

type ExpectedSecondWaveEffectKind = keyof typeof EXPECTED_SECOND_WAVE_EFFECT_SPECS;

const EXPECTED_SECOND_WAVE_EFFECT_KEYS = Object.freeze(
  Object.keys(EXPECTED_SECOND_WAVE_EFFECT_SPECS) as ExpectedSecondWaveEffectKind[],
);

const EXPECTED_NUMBER_NAN_KEYS = [
  "number-nan-type-shortcut",
] as const satisfies readonly GlobalReadOptimizerExpressionKind[];

const EXPECTED_MINIFIER_SPECS = {
  "minifier-math-pow": {
    transformKind: "math-pow",
    patchStatement: "Math.pow = () => 777;",
    numericExpression: "Math.pow(2, 3)",
    patchedValue: 777,
    fallbackValue: 8,
  },
  "minifier-array-of": {
    transformKind: "array-of",
    patchStatement: "Array.of = () => ({ length: 777 });",
    numericExpression: "Array.of(1, 2).length",
    patchedValue: 777,
    fallbackValue: 2,
  },
  "minifier-string-concat": {
    transformKind: "string-concat",
    patchStatement: 'String.prototype.concat = () => "x".repeat(777);',
    numericExpression: '"a".concat("b").length',
    patchedValue: 777,
    fallbackValue: 2,
  },
  "minifier-array-concat": {
    transformKind: "array-concat",
    patchStatement: "Array.prototype.concat = () => ({ length: 777 });",
    numericExpression: "[].concat(1, 2).length",
    patchedValue: 777,
    fallbackValue: 2,
  },
  "minifier-boolean-call": {
    transformKind: "boolean-call",
    patchStatement: "globalThis.Boolean = () => 777;",
    numericExpression: "+Boolean(0)",
    patchedValue: 777,
    fallbackValue: 0,
  },
  "minifier-number-call": {
    transformKind: "number-call",
    patchStatement: "globalThis.Number = () => 777;",
    numericExpression: "Number(1)",
    patchedValue: 777,
    fallbackValue: 1,
  },
  "minifier-string-call": {
    transformKind: "string-call",
    patchStatement: 'globalThis.String = () => "x".repeat(777);',
    numericExpression: "String(1).length",
    patchedValue: 777,
    fallbackValue: 1,
  },
  "minifier-array-call": {
    transformKind: "array-call",
    patchStatement: "globalThis.Array = () => ({ length: 777 });",
    numericExpression: "Array().length",
    patchedValue: 777,
    fallbackValue: 0,
  },
  "minifier-object-call": {
    transformKind: "object-call",
    patchStatement: "globalThis.Object = () => ({ value: 777 });",
    numericExpression: "+(Object().value ?? 0)",
    patchedValue: 777,
    fallbackValue: 0,
  },
} as const;

type ExpectedMinifierKind = keyof typeof EXPECTED_MINIFIER_SPECS;

const EXPECTED_MINIFIER_KEYS = Object.freeze(
  Object.keys(EXPECTED_MINIFIER_SPECS) as ExpectedMinifierKind[],
);

const EXPECTED_KEYS: readonly GlobalReadOptimizerExpressionKind[] = [
  ...EXPECTED_COMPUTED_KEYS,
  ...EXPECTED_LOCAL_CONST_KEYS,
  ...EXPECTED_COMPUTED_LOCAL_CONST_KEYS,
  ...EXPECTED_COERCION_KEYS,
  ...EXPECTED_NUMBER_INFINITY_KEYS,
  ...EXPECTED_EFFECT_PRESERVATION_KEYS,
  ...EXPECTED_COMPUTED_KEY_EXPRESSION_KEYS,
  ...EXPECTED_OPTIONAL_RECEIVER_KEYS,
  ...EXPECTED_INSTANCEOF_CONSTRUCTOR_KEYS,
  ...EXPECTED_PARENTHESIZED_STATIC_RECEIVER_KEYS,
  ...EXPECTED_COMPOUND_RECEIVER_KEYS,
  ...EXPECTED_OPTIONAL_COMPUTED_KEY_KEYS,
  ...EXPECTED_OPTIONAL_PARENTHESIZED_CALLEE_KEYS,
  ...EXPECTED_ADJACENT_INSTANCEOF_CONSTRUCTOR_KEYS,
  ...EXPECTED_INSTANCEOF_LEFT_KEYS,
  ...EXPECTED_SECOND_WAVE_COERCION_KEYS,
  ...EXPECTED_SECOND_WAVE_EFFECT_KEYS,
  ...EXPECTED_NUMBER_NAN_KEYS,
  ...EXPECTED_MINIFIER_KEYS,
];

/// This independently pins the executable source shape, not merely its native value. A computed
/// callee changed back to dot syntax, or a same-module constant inlined into the expression, can have
/// identical JavaScript results while silently removing the optimizer path this registry exists for.
const EXPECTED_SOURCE_SHAPE_SHA256 =
  "96c2d53ddf8bc1ee0af950b03b3c3789d8f8e87622328d14735a30a9a9b0cb48";

describe("closed global-read optimizer expressions", () => {
  test("pins all 884 stable keys and their independent implementation families", () => {
    expect(GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS).toEqual(EXPECTED_KEYS);
    expect(COMPUTED_LOCAL_CONST_OPTIMIZER_EXPRESSION_KINDS).toEqual(
      EXPECTED_COMPUTED_LOCAL_CONST_KEYS,
    );
    expect(EFFECT_PRESERVATION_OPTIMIZER_EXPRESSION_KINDS).toEqual(
      EXPECTED_EFFECT_PRESERVATION_KEYS,
    );
    expect(COMPUTED_KEY_EXPRESSION_OPTIMIZER_EXPRESSION_KINDS).toEqual(
      EXPECTED_COMPUTED_KEY_EXPRESSION_KEYS,
    );
    expect(OPTIONAL_RECEIVER_OPTIMIZER_EXPRESSION_KINDS).toEqual(EXPECTED_OPTIONAL_RECEIVER_KEYS);
    expect(INSTANCEOF_CONSTRUCTOR_OPTIMIZER_EXPRESSION_KINDS).toEqual(
      EXPECTED_INSTANCEOF_CONSTRUCTOR_KEYS,
    );
    expect(PARENTHESIZED_STATIC_RECEIVER_OPTIMIZER_EXPRESSION_KINDS).toEqual(
      EXPECTED_PARENTHESIZED_STATIC_RECEIVER_KEYS,
    );
    expect(COMPOUND_RECEIVER_OPTIMIZER_EXPRESSION_KINDS).toEqual(EXPECTED_COMPOUND_RECEIVER_KEYS);
    expect(OPTIONAL_COMPUTED_KEY_OPTIMIZER_EXPRESSION_KINDS).toEqual(
      EXPECTED_OPTIONAL_COMPUTED_KEY_KEYS,
    );
    expect(OPTIONAL_PARENTHESIZED_CALLEE_OPTIMIZER_EXPRESSION_KINDS).toEqual(
      EXPECTED_OPTIONAL_PARENTHESIZED_CALLEE_KEYS,
    );
    expect(ADJACENT_INSTANCEOF_CONSTRUCTOR_OPTIMIZER_EXPRESSION_KINDS).toEqual(
      EXPECTED_ADJACENT_INSTANCEOF_CONSTRUCTOR_KEYS,
    );
    expect(INSTANCEOF_LEFT_EXPRESSION_OPTIMIZER_EXPRESSION_KINDS).toEqual(
      EXPECTED_INSTANCEOF_LEFT_KEYS,
    );
    expect(SECOND_WAVE_COERCION_OPTIMIZER_EXPRESSION_KINDS).toEqual(
      EXPECTED_SECOND_WAVE_COERCION_KEYS,
    );
    expect(SECOND_WAVE_EFFECT_PRESERVATION_OPTIMIZER_EXPRESSION_KINDS).toEqual(
      EXPECTED_SECOND_WAVE_EFFECT_KEYS,
    );
    expect(NUMBER_NAN_OPTIMIZER_EXPRESSION_KINDS).toEqual(EXPECTED_NUMBER_NAN_KEYS);
    expect(MINIFIER_TRANSFORM_OPTIMIZER_EXPRESSION_KINDS).toEqual(EXPECTED_MINIFIER_KEYS);
    expect(GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS).toHaveLength(884);
    expect(new Set(GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS).size).toBe(884);
    expect(Object.isFrozen(GLOBAL_READ_OPTIMIZER_EXPRESSION_SPECS)).toBe(true);

    const familyCounts = new Map<GlobalReadOptimizerExpressionFamily, number>();
    for (const kind of GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS) {
      const spec = globalReadOptimizerExpressionSpec(kind);
      expect(spec.key, kind).toBe(kind);
      expect(Object.isFrozen(spec), kind).toBe(true);
      expect(spec.patchStatement.length, kind).toBeGreaterThan(0);
      expect(spec.numericExpression.length, kind).toBeGreaterThan(0);
      expect(spec.description.length, kind).toBeGreaterThan(0);
      expect(Number.isFinite(spec.patchedValue), kind).toBe(true);
      expect(Number.isFinite(spec.fallbackValue), kind).toBe(true);
      expect(spec.requiresMinify, kind).toBe(
        spec.family === "minifier-transform" ? true : undefined,
      );
      if (spec.family === "effect-preservation") {
        expect(spec.patchedValue, kind).toBe(spec.fallbackValue);
        expect(spec.counterGlobal, kind).toBe(GLOBAL_READ_OPTIMIZER_EFFECT_COUNTER);
        expect(spec.expectedCount, kind).toBe(1);
        expect(spec.patchStatement, kind).toContain(
          `globalThis[${JSON.stringify(GLOBAL_READ_OPTIMIZER_EFFECT_COUNTER)}] = 0;`,
        );
      } else {
        expect(spec.patchedValue, kind).not.toBe(spec.fallbackValue);
      }
      familyCounts.set(spec.family, (familyCounts.get(spec.family) ?? 0) + 1);
    }

    expect(Object.fromEntries(familyCounts)).toEqual({
      "computed-callee": 37,
      "local-const-casing": 5,
      "local-const-to-string": 4,
      "local-const-computed": 9,
      coercion: 28,
      "number-infinity-type-shortcut": 2,
      "effect-preservation": 34,
      "computed-key-expression": 276,
      "optional-receiver": 28,
      "instanceof-constructor": 16,
      "parenthesized-static-receiver": 18,
      "compound-receiver": 161,
      "optional-computed-key": 168,
      "optional-parenthesized-callee": 56,
      "instanceof-constructor-adjacent": 12,
      "instanceof-left-expression": 20,
      "number-nan-type-shortcut": 1,
      "minifier-transform": 9,
    });
  });

  test("pins the exact 17 equal-value effect-preservation evaluator arms", () => {
    expect(EXPECTED_EFFECT_PRESERVATION_KEYS).toHaveLength(17);
    for (const kind of EXPECTED_EFFECT_PRESERVATION_KEYS) {
      const spec = globalReadOptimizerExpressionSpec(kind);
      const expected = EXPECTED_EFFECT_PRESERVATION_SPECS[kind];
      expect(spec.family, kind).toBe("effect-preservation");
      if (spec.family !== "effect-preservation") {
        throw new Error(`effect-preservation key ${kind} has family ${spec.family}`);
      }
      expect("builtinKind" in spec, kind).toBe(false);
      expect(spec.numericExpression, kind).toBe(expected.numericExpression);
      expect(spec.patchedValue, kind).toBe(expected.value);
      expect(spec.fallbackValue, kind).toBe(expected.value);
    }
  });

  test("pins the exact 17 second-wave effect-preservation evaluator arms", () => {
    expect(EXPECTED_SECOND_WAVE_EFFECT_KEYS).toHaveLength(17);
    for (const kind of EXPECTED_SECOND_WAVE_EFFECT_KEYS) {
      const spec = globalReadOptimizerExpressionSpec(kind);
      const expected = EXPECTED_SECOND_WAVE_EFFECT_SPECS[kind];
      expect(spec.family, kind).toBe("effect-preservation");
      if (spec.family !== "effect-preservation") {
        throw new Error(`effect-preservation key ${kind} has family ${spec.family}`);
      }
      expect(spec.numericExpression, kind).toBe(expected.numericExpression);
      expect(spec.patchedValue, kind).toBe(expected.value);
      expect(spec.fallbackValue, kind).toBe(expected.value);
      expect(spec.expectedCount, kind).toBe(1);
    }
  });

  test("pins the exact nine minifier-only patches and numeric observations", () => {
    expect(EXPECTED_MINIFIER_KEYS).toHaveLength(9);
    for (const kind of EXPECTED_MINIFIER_KEYS) {
      const spec = globalReadOptimizerExpressionSpec(kind);
      const expected = EXPECTED_MINIFIER_SPECS[kind];
      expect(spec.family, kind).toBe("minifier-transform");
      if (spec.family !== "minifier-transform") {
        throw new Error(`minifier key ${kind} has family ${spec.family}`);
      }
      expect(
        {
          transformKind: spec.transformKind,
          patchStatement: spec.patchStatement,
          numericExpression: spec.numericExpression,
          patchedValue: spec.patchedValue,
          fallbackValue: spec.fallbackValue,
          requiresMinify: spec.requiresMinify,
        },
        kind,
      ).toEqual({ ...expected, requiresMinify: true });
    }
  });

  test("keeps every computed callee tied to its existing semantic built-in kind", () => {
    for (const kind of EXPECTED_COMPUTED_KEYS) {
      const spec = globalReadOptimizerExpressionSpec(kind);
      expect(spec.family, kind).toBe("computed-callee");
      if (spec.family !== "computed-callee") {
        throw new Error(`computed key ${kind} has family ${spec.family}`);
      }
      expect(`${spec.builtinKind}-computed`, kind).toBe(kind);
    }
  });

  test("pins the exact nine computed-property calls on same-module constant receivers", () => {
    expect(EXPECTED_COMPUTED_LOCAL_CONST_KEYS).toHaveLength(9);
    for (const kind of EXPECTED_COMPUTED_LOCAL_CONST_KEYS) {
      const spec = globalReadOptimizerExpressionSpec(kind);
      const expected = EXPECTED_COMPUTED_LOCAL_CONST_SPECS[kind];
      expect(spec.family, kind).toBe("local-const-computed");
      if (spec.family !== "local-const-computed" || expected === undefined) {
        throw new Error(`computed local-constant key ${kind} has family ${spec.family}`);
      }
      expect(
        {
          builtinKind: spec.builtinKind,
          readerBinding: spec.readerBinding,
          readerPrelude: spec.readerPrelude,
          numericExpression: spec.numericExpression,
        },
        kind,
      ).toEqual(expected);

      const source = `${spec.readerPrelude}
const fallbackValue = (${spec.numericExpression});
${spec.patchStatement}
const patchedValue = (${spec.numericExpression});
process.stdout.write(JSON.stringify({ fallbackValue, patchedValue }));`;
      const execution = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
        encoding: "utf8",
        timeout: 2_000,
      });
      expect(execution.error, kind).toBeUndefined();
      expect(execution.status, `${kind}: ${execution.stderr}`).toBe(0);
      expect(JSON.parse(execution.stdout), kind).toEqual({
        fallbackValue: spec.fallbackValue,
        patchedValue: spec.patchedValue,
      });
    }
  });

  test("pins every generated product dimension and its closed source member", () => {
    expect(EXPECTED_COMPUTED_MEMBER_SOURCE_KEYS).toHaveLength(46);
    expect(EXPECTED_COMPUTED_KEY_VARIANTS).toHaveLength(6);
    for (const [sourceIndex, sourceKind] of EXPECTED_COMPUTED_MEMBER_SOURCE_KEYS.entries()) {
      for (const [variantIndex, variant] of EXPECTED_COMPUTED_KEY_VARIANTS.entries()) {
        const kind =
          EXPECTED_COMPUTED_KEY_EXPRESSION_KEYS[
            sourceIndex * EXPECTED_COMPUTED_KEY_VARIANTS.length + variantIndex
          ];
        if (kind === undefined) {
          throw new Error(`missing computed-key product for ${sourceKind} and ${variant}`);
        }
        const spec = globalReadOptimizerExpressionSpec(kind);
        expect(spec.family, kind).toBe("computed-key-expression");
        if (spec.family !== "computed-key-expression") {
          throw new Error(`computed-key product ${kind} has family ${spec.family}`);
        }
        expect(spec.sourceExpressionKind, kind).toBe(sourceKind);
        expect(spec.keyExpressionVariant, kind).toBe(variant);
      }
    }

    expect(EXPECTED_OPTIONAL_RECEIVER_KEYS).toHaveLength(28);
    for (const [index, kind] of EXPECTED_OPTIONAL_RECEIVER_KEYS.entries()) {
      const spec = globalReadOptimizerExpressionSpec(kind);
      expect(spec.family, kind).toBe("optional-receiver");
      if (spec.family !== "optional-receiver") {
        throw new Error(`optional-receiver product ${kind} has family ${spec.family}`);
      }
      const expectedSource = [
        ...EXPECTED_COMPUTED_KEYS.slice(18),
        ...EXPECTED_COMPUTED_LOCAL_CONST_KEYS,
      ][index];
      expect(spec.sourceExpressionKind, kind).toBe(expectedSource);
      expect(spec.numericExpression, kind).toContain("?.[");
    }

    expect(EXPECTED_INSTANCEOF_CONSTRUCTOR_KEYS).toHaveLength(16);
    for (const [sourceIndex, sourceKind] of EXPECTED_INSTANCEOF_SOURCE_KEYS.entries()) {
      for (const [variantIndex, variant] of EXPECTED_INSTANCEOF_CONSTRUCTOR_VARIANTS.entries()) {
        const kind =
          EXPECTED_INSTANCEOF_CONSTRUCTOR_KEYS[
            sourceIndex * EXPECTED_INSTANCEOF_CONSTRUCTOR_VARIANTS.length + variantIndex
          ];
        if (kind === undefined) {
          throw new Error(`missing instanceof product for ${sourceKind} and ${variant}`);
        }
        const spec = globalReadOptimizerExpressionSpec(kind);
        expect(spec.family, kind).toBe("instanceof-constructor");
        if (spec.family !== "instanceof-constructor") {
          throw new Error(`instanceof product ${kind} has family ${spec.family}`);
        }
        expect(spec.instanceofKind, kind).toBe(sourceKind);
        expect(spec.constructorVariant, kind).toBe(variant);
      }
    }

    expect(EXPECTED_PARENTHESIZED_STATIC_RECEIVER_KEYS).toHaveLength(18);
    for (const [index, kind] of EXPECTED_PARENTHESIZED_STATIC_RECEIVER_KEYS.entries()) {
      const spec = globalReadOptimizerExpressionSpec(kind);
      expect(spec.family, kind).toBe("parenthesized-static-receiver");
      if (spec.family !== "parenthesized-static-receiver") {
        throw new Error(`parenthesized-receiver product ${kind} has family ${spec.family}`);
      }
      expect(spec.sourceExpressionKind, kind).toBe(EXPECTED_COMPUTED_KEYS[index]);
      expect(spec.numericExpression, kind).toMatch(/\((?:Math|Number|String)\)\[/);
    }

    expect(EXPECTED_COMPOUND_RECEIVER_KEYS).toHaveLength(161);
    let compoundIndex = 0;
    for (const sourceKind of EXPECTED_OPTIONAL_SOURCE_KEYS) {
      const variants: readonly CompoundReceiverVariant[] = [
        ...EXPECTED_COMPOUND_RECEIVER_VARIANTS,
        ...(EXPECTED_STRING_RECEIVER_SOURCE_SET.has(sourceKind)
          ? (["concatenation"] as const)
          : []),
      ];
      for (const variant of variants) {
        const kind = EXPECTED_COMPOUND_RECEIVER_KEYS[compoundIndex];
        compoundIndex += 1;
        if (kind === undefined) {
          throw new Error(`missing compound receiver for ${sourceKind} and ${variant}`);
        }
        const spec = globalReadOptimizerExpressionSpec(kind);
        expect(spec.family, kind).toBe("compound-receiver");
        if (spec.family !== "compound-receiver") {
          throw new Error(`compound-receiver product ${kind} has family ${spec.family}`);
        }
        expect(spec.sourceExpressionKind, kind).toBe(sourceKind);
        expect(spec.receiverVariant, kind).toBe(variant);
      }
    }
    expect(compoundIndex).toBe(161);

    expect(EXPECTED_OPTIONAL_COMPUTED_KEY_KEYS).toHaveLength(168);
    for (const [sourceIndex, sourceKind] of EXPECTED_OPTIONAL_SOURCE_KEYS.entries()) {
      for (const [variantIndex, variant] of EXPECTED_COMPUTED_KEY_VARIANTS.entries()) {
        const kind =
          EXPECTED_OPTIONAL_COMPUTED_KEY_KEYS[
            sourceIndex * EXPECTED_COMPUTED_KEY_VARIANTS.length + variantIndex
          ];
        if (kind === undefined) {
          throw new Error(`missing optional-key product for ${sourceKind} and ${variant}`);
        }
        const spec = globalReadOptimizerExpressionSpec(kind);
        expect(spec.family, kind).toBe("optional-computed-key");
        if (spec.family !== "optional-computed-key") {
          throw new Error(`optional-key product ${kind} has family ${spec.family}`);
        }
        expect(spec.sourceExpressionKind, kind).toBe(sourceKind);
        expect(spec.keyExpressionVariant, kind).toBe(variant);
        expect(spec.numericExpression, kind).toContain("?.[");
      }
    }

    expect(EXPECTED_OPTIONAL_PARENTHESIZED_CALLEE_KEYS).toHaveLength(56);
    for (const [sourceIndex, sourceKind] of EXPECTED_OPTIONAL_SOURCE_KEYS.entries()) {
      for (const [
        variantIndex,
        variant,
      ] of EXPECTED_OPTIONAL_PARENTHESIZED_CALLEE_VARIANTS.entries()) {
        const kind =
          EXPECTED_OPTIONAL_PARENTHESIZED_CALLEE_KEYS[
            sourceIndex * EXPECTED_OPTIONAL_PARENTHESIZED_CALLEE_VARIANTS.length + variantIndex
          ];
        if (kind === undefined) {
          throw new Error(`missing optional-callee product for ${sourceKind} and ${variant}`);
        }
        const spec = globalReadOptimizerExpressionSpec(kind);
        expect(spec.family, kind).toBe("optional-parenthesized-callee");
        if (spec.family !== "optional-parenthesized-callee") {
          throw new Error(`optional-callee product ${kind} has family ${spec.family}`);
        }
        expect(spec.sourceExpressionKind, kind).toBe(sourceKind);
        expect(spec.calleeVariant, kind).toBe(variant);
      }
    }

    expect(EXPECTED_ADJACENT_INSTANCEOF_CONSTRUCTOR_KEYS).toHaveLength(12);
    for (const [sourceIndex, sourceKind] of EXPECTED_INSTANCEOF_SOURCE_KEYS.entries()) {
      for (const [
        variantIndex,
        variant,
      ] of EXPECTED_ADJACENT_INSTANCEOF_CONSTRUCTOR_VARIANTS.entries()) {
        const kind =
          EXPECTED_ADJACENT_INSTANCEOF_CONSTRUCTOR_KEYS[
            sourceIndex * EXPECTED_ADJACENT_INSTANCEOF_CONSTRUCTOR_VARIANTS.length + variantIndex
          ];
        if (kind === undefined) {
          throw new Error(`missing adjacent instanceof product for ${sourceKind} and ${variant}`);
        }
        const spec = globalReadOptimizerExpressionSpec(kind);
        expect(spec.family, kind).toBe("instanceof-constructor-adjacent");
        if (spec.family !== "instanceof-constructor-adjacent") {
          throw new Error(`adjacent instanceof product ${kind} has family ${spec.family}`);
        }
        expect(spec.instanceofKind, kind).toBe(sourceKind);
        expect(spec.constructorVariant, kind).toBe(variant);
      }
    }

    expect(EXPECTED_INSTANCEOF_LEFT_KEYS).toHaveLength(20);
    for (const [sourceIndex, sourceKind] of EXPECTED_INSTANCEOF_SOURCE_KEYS.entries()) {
      for (const [variantIndex, variant] of EXPECTED_INSTANCEOF_LEFT_VARIANTS.entries()) {
        const kind =
          EXPECTED_INSTANCEOF_LEFT_KEYS[
            sourceIndex * EXPECTED_INSTANCEOF_LEFT_VARIANTS.length + variantIndex
          ];
        if (kind === undefined) {
          throw new Error(`missing instanceof-left product for ${sourceKind} and ${variant}`);
        }
        const spec = globalReadOptimizerExpressionSpec(kind);
        expect(spec.family, kind).toBe("instanceof-left-expression");
        if (spec.family !== "instanceof-left-expression") {
          throw new Error(`instanceof-left product ${kind} has family ${spec.family}`);
        }
        expect(spec.instanceofKind, kind).toBe(sourceKind);
        expect(spec.leftVariant, kind).toBe(variant);
      }
    }
  });

  test("pins every load-bearing patch, prelude, and expression source shape", () => {
    const sourceShapes = GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS.map((kind) => {
      const spec = globalReadOptimizerExpressionSpec(kind);
      return {
        key: spec.key,
        family: spec.family,
        builtinKind: "builtinKind" in spec ? spec.builtinKind : null,
        patchStatement: spec.patchStatement,
        readerPrelude: spec.readerPrelude ?? null,
        numericExpression: spec.numericExpression,
        requiresMinify: spec.requiresMinify ?? false,
        counterGlobal: spec.family === "effect-preservation" ? spec.counterGlobal : null,
        expectedCount: spec.family === "effect-preservation" ? spec.expectedCount : null,
      };
    });
    const sha256 = createHash("sha256").update(JSON.stringify(sourceShapes)).digest("hex");
    expect(sha256).toBe(EXPECTED_SOURCE_SHAPE_SHA256);
  });

  test(
    "proves every fixed expression's native patched and fallback values in an isolated process",
    { timeout: 120_000 },
    () => {
      for (const kind of GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS) {
        const spec = globalReadOptimizerExpressionSpec(kind);
        const source = `${spec.readerPrelude ?? ""}
const fallbackValue = (${spec.numericExpression});
${spec.patchStatement}
const patchedValue = (${spec.numericExpression});
const effectCount = ${spec.family === "effect-preservation" ? `globalThis[${JSON.stringify(spec.counterGlobal)}]` : "null"};
process.stdout.write(JSON.stringify({ fallbackValue, patchedValue, effectCount }));`;
        const execution = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
          encoding: "utf8",
          timeout: 2_000,
        });

        expect(execution.error, kind).toBeUndefined();
        expect(execution.status, `${kind}: ${execution.stderr}`).toBe(0);
        expect(JSON.parse(execution.stdout), kind).toEqual({
          fallbackValue: spec.fallbackValue,
          patchedValue: spec.patchedValue,
          effectCount: spec.family === "effect-preservation" ? spec.expectedCount : null,
        });
      }
    },
  );
});
