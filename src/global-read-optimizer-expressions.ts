import {
  globalReadBuiltinSpec,
  renderGlobalReadBuiltinReplacement,
  type GlobalReadBuiltinKind,
} from "./global-read-builtins.ts";
import {
  globalReadInstanceofSpec,
  renderGlobalReadInstanceofAssignment,
  type GlobalReadInstanceofKind,
} from "./global-read-instanceof.ts";

/// The optimizer-expression registry is deliberately closed. Program models carry only one of these
/// stable keys; executable snippets never enter artifacts through an unchecked model string.
export type GlobalReadOptimizerExpressionFamily =
  | "computed-callee"
  | "local-const-casing"
  | "local-const-to-string"
  | "local-const-computed"
  | "computed-key-expression"
  | "optional-receiver"
  | "instanceof-constructor"
  | "parenthesized-static-receiver"
  | "compound-receiver"
  | "optional-computed-key"
  | "optional-parenthesized-callee"
  | "instanceof-constructor-adjacent"
  | "instanceof-left-expression"
  | "coercion"
  | "number-infinity-type-shortcut"
  | "number-nan-type-shortcut"
  | "minifier-transform"
  | "effect-preservation";

export const GLOBAL_READ_OPTIMIZER_EFFECT_COUNTER =
  "__orderFuzzerOptimizerEffectCallCount" as const;

interface GlobalReadOptimizerExpressionSpecBase {
  readonly key: string;
  readonly family: GlobalReadOptimizerExpressionFamily;
  /// A fixed statement executed by the patch module before the reader module.
  readonly patchStatement: string;
  /// Fixed declarations emitted immediately before the reader's exported value, when needed.
  readonly readerPrelude?: string;
  /// A fixed expression whose result is always a finite number in both patched and native execution.
  readonly numericExpression: string;
  readonly patchedValue: number;
  readonly fallbackValue: number;
  readonly description: string;
  /// Only minifier-specific expressions require this build axis; every other spec leaves it absent.
  readonly requiresMinify?: true;
}

export interface ComputedCalleeOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "computed-callee";
  /// The semantic call remains the existing closed built-in kind; only its property syntax changes.
  readonly builtinKind: GlobalReadBuiltinKind;
}

export interface LocalConstOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "local-const-casing" | "local-const-to-string" | "local-const-computed";
  readonly builtinKind: GlobalReadBuiltinKind;
  /// Closed placeholder binding used by both `readerPrelude` and `numericExpression`. The renderer
  /// freshens it around imports and author-selected export locals before emitting either string.
  readonly readerBinding: string;
  readonly readerPrelude: string;
}

export type ComputedKeyExpressionVariant =
  | "concatenation"
  | "conditional"
  | "sequence"
  | "logical-and"
  | "logical-or"
  | "nullish-coalescing";

export interface ComputedKeyExpressionOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "computed-key-expression";
  readonly builtinKind: GlobalReadBuiltinKind;
  readonly sourceExpressionKind: ComputedMemberSourceKind;
  readonly keyExpressionVariant: ComputedKeyExpressionVariant;
}

export interface OptionalReceiverOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "optional-receiver";
  readonly builtinKind: GlobalReadBuiltinKind;
  readonly sourceExpressionKind: OptionalReceiverSourceKind;
}

export type InstanceofConstructorVariant =
  | "conditional"
  | "sequence"
  | "logical-and"
  | "parenthesized";

export interface InstanceofConstructorOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "instanceof-constructor";
  readonly instanceofKind: GlobalReadInstanceofKind;
  readonly constructorVariant: InstanceofConstructorVariant;
}

export interface ParenthesizedStaticReceiverOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "parenthesized-static-receiver";
  readonly builtinKind: GlobalReadBuiltinKind;
  readonly sourceExpressionKind: ParenthesizedStaticReceiverSourceKind;
}

export type CompoundReceiverVariant =
  | "concatenation"
  | "conditional"
  | "sequence"
  | "logical-and"
  | "logical-or"
  | "nullish-coalescing";

export interface CompoundReceiverOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "compound-receiver";
  readonly builtinKind: GlobalReadBuiltinKind;
  readonly sourceExpressionKind: OptionalReceiverSourceKind;
  readonly receiverVariant: CompoundReceiverVariant;
}

export interface OptionalComputedKeyOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "optional-computed-key";
  readonly builtinKind: GlobalReadBuiltinKind;
  readonly sourceExpressionKind: OptionalReceiverSourceKind;
  readonly keyExpressionVariant: ComputedKeyExpressionVariant;
}

export type OptionalParenthesizedCalleeVariant = "computed" | "dot";

export interface OptionalParenthesizedCalleeOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "optional-parenthesized-callee";
  readonly builtinKind: GlobalReadBuiltinKind;
  readonly sourceExpressionKind: OptionalReceiverSourceKind;
  readonly calleeVariant: OptionalParenthesizedCalleeVariant;
}

export type AdjacentInstanceofConstructorVariant =
  | "logical-or"
  | "nullish-coalescing"
  | "undefined-nullish-coalescing";

export interface AdjacentInstanceofConstructorOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "instanceof-constructor-adjacent";
  readonly instanceofKind: GlobalReadInstanceofKind;
  readonly constructorVariant: AdjacentInstanceofConstructorVariant;
}

export type InstanceofLeftExpressionVariant =
  | "conditional"
  | "sequence"
  | "logical-and"
  | "logical-or"
  | "nullish-coalescing";

export interface InstanceofLeftExpressionOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "instanceof-left-expression";
  readonly instanceofKind: GlobalReadInstanceofKind;
  readonly leftVariant: InstanceofLeftExpressionVariant;
}

export interface CoercionOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "coercion";
}

export interface NumberInfinityOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "number-infinity-type-shortcut";
}

export interface NumberNaNOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "number-nan-type-shortcut";
}

export type MinifierTransformKind =
  | "math-pow"
  | "array-of"
  | "string-concat"
  | "array-concat"
  | "boolean-call"
  | "number-call"
  | "string-call"
  | "array-call"
  | "object-call";

export interface MinifierOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "minifier-transform";
  readonly transformKind: MinifierTransformKind;
  readonly requiresMinify: true;
}

export interface EffectPreservationOptimizerExpressionSpec extends GlobalReadOptimizerExpressionSpecBase {
  readonly family: "effect-preservation";
  /// The one fixture-private observation channel initialized by the closed patch. Keeping both the
  /// identity and expected count in the spec makes an equal-value expression a typed witness instead
  /// of relying on a generator-side string that the validator and tests cannot inspect.
  readonly counterGlobal: typeof GLOBAL_READ_OPTIMIZER_EFFECT_COUNTER;
  readonly expectedCount: 1;
}

export type GlobalReadOptimizerExpressionSpec =
  | ComputedCalleeOptimizerExpressionSpec
  | LocalConstOptimizerExpressionSpec
  | ComputedKeyExpressionOptimizerExpressionSpec
  | OptionalReceiverOptimizerExpressionSpec
  | InstanceofConstructorOptimizerExpressionSpec
  | ParenthesizedStaticReceiverOptimizerExpressionSpec
  | CompoundReceiverOptimizerExpressionSpec
  | OptionalComputedKeyOptimizerExpressionSpec
  | OptionalParenthesizedCalleeOptimizerExpressionSpec
  | AdjacentInstanceofConstructorOptimizerExpressionSpec
  | InstanceofLeftExpressionOptimizerExpressionSpec
  | CoercionOptimizerExpressionSpec
  | NumberInfinityOptimizerExpressionSpec
  | NumberNaNOptimizerExpressionSpec
  | MinifierOptimizerExpressionSpec
  | EffectPreservationOptimizerExpressionSpec;

function builtinPatchStatement(kind: GlobalReadBuiltinKind): string {
  const spec = globalReadBuiltinSpec(kind);
  const replacement = renderGlobalReadBuiltinReplacement(spec, spec.patchedValue);
  return `${spec.assignmentTarget} = () => ${replacement};`;
}

function computedCalleeSpec(
  key: string,
  builtinKind: GlobalReadBuiltinKind,
  numericExpression: string,
): ComputedCalleeOptimizerExpressionSpec {
  const builtin = globalReadBuiltinSpec(builtinKind);
  return Object.freeze({
    key,
    family: "computed-callee",
    builtinKind,
    patchStatement: builtinPatchStatement(builtinKind),
    numericExpression,
    patchedValue: builtin.patchedValue,
    fallbackValue: builtin.fallbackValue,
    description: `${builtin.description} through a computed-string callee`,
  });
}

function localConstSpec(
  key: string,
  family: LocalConstOptimizerExpressionSpec["family"],
  builtinKind: GlobalReadBuiltinKind,
  readerBinding: string,
  readerPrelude: string,
  numericExpression: string,
): LocalConstOptimizerExpressionSpec {
  const builtin = globalReadBuiltinSpec(builtinKind);
  return Object.freeze({
    key,
    family,
    builtinKind,
    readerBinding,
    patchStatement: builtinPatchStatement(builtinKind),
    readerPrelude,
    numericExpression,
    patchedValue: builtin.patchedValue,
    fallbackValue: builtin.fallbackValue,
    description:
      family === "local-const-computed"
        ? `${builtin.description} through a same-module constant receiver and computed-string callee`
        : `${builtin.description} through a same-module constant receiver`,
  });
}

function expressionSpec(
  spec:
    | CoercionOptimizerExpressionSpec
    | NumberInfinityOptimizerExpressionSpec
    | NumberNaNOptimizerExpressionSpec
    | MinifierOptimizerExpressionSpec,
): GlobalReadOptimizerExpressionSpec {
  return Object.freeze(spec);
}

function effectPreservationSpec(
  key: string,
  patchKind: "math-hypot-call" | "date-construction",
  numericExpression: string,
  value: number,
  description: string,
): EffectPreservationOptimizerExpressionSpec {
  const counter = JSON.stringify(GLOBAL_READ_OPTIMIZER_EFFECT_COUNTER);
  const patchStatement =
    patchKind === "math-hypot-call"
      ? `globalThis[${counter}] = 0; Math.hypot = () => { globalThis[${counter}] += 1; return 42; };`
      : `globalThis[${counter}] = 0; globalThis.Date = class { constructor() { globalThis[${counter}] += 1; } };`;
  return Object.freeze({
    key,
    family: "effect-preservation",
    patchStatement,
    numericExpression,
    patchedValue: value,
    fallbackValue: value,
    description,
    counterGlobal: GLOBAL_READ_OPTIMIZER_EFFECT_COUNTER,
    expectedCount: 1,
  });
}

const NUMBER_INFINITY_PATCH =
  'globalThis.Number = ((original) => { const replacement = function (...args) { return new.target ? Reflect.construct(original, args, new.target === replacement ? original : new.target) : Reflect.apply(original, this, args); }; Object.setPrototypeOf(replacement, original); replacement.prototype = original.prototype; Object.defineProperties(replacement, { POSITIVE_INFINITY: { value: "x" }, NEGATIVE_INFINITY: { value: "x" } }); return replacement; })(Number);';

/// These are the 90 hand-authored RED expressions adjacent to, but not duplicated by, the first 49
/// direct-call/instanceof cases: 37 computed callees, nine same-module constant receivers with dot
/// properties, nine same-module constant receivers with computed properties, 16 coercions, and two
/// Number-infinity type-shortcut cases, plus 17 equal-value expressions whose dropped evaluation is
/// observed through a typed call counter. Product dimensions below add 338 more closed expressions.
const BASE_GLOBAL_READ_OPTIMIZER_EXPRESSION_SPECS = Object.freeze({
  "math-abs-computed": computedCalleeSpec("math-abs-computed", "math-abs", 'Math["abs"](-2)'),
  "math-ceil-computed": computedCalleeSpec("math-ceil-computed", "math-ceil", 'Math["ceil"](1.2)'),
  "math-floor-computed": computedCalleeSpec(
    "math-floor-computed",
    "math-floor",
    'Math["floor"](1.8)',
  ),
  "math-round-computed": computedCalleeSpec(
    "math-round-computed",
    "math-round",
    'Math["round"](1.2)',
  ),
  "math-fround-computed": computedCalleeSpec(
    "math-fround-computed",
    "math-fround",
    'Math["fround"](2)',
  ),
  "math-trunc-computed": computedCalleeSpec(
    "math-trunc-computed",
    "math-trunc",
    'Math["trunc"](1.8)',
  ),
  "math-sign-computed": computedCalleeSpec("math-sign-computed", "math-sign", 'Math["sign"](-2)'),
  "math-clz32-computed": computedCalleeSpec(
    "math-clz32-computed",
    "math-clz32",
    'Math["clz32"](1)',
  ),
  "math-sqrt-computed": computedCalleeSpec("math-sqrt-computed", "math-sqrt", 'Math["sqrt"](4)'),
  "math-cbrt-computed": computedCalleeSpec("math-cbrt-computed", "math-cbrt", 'Math["cbrt"](8)'),
  "math-imul-computed": computedCalleeSpec("math-imul-computed", "math-imul", 'Math["imul"](2, 3)'),
  "math-min-computed": computedCalleeSpec("math-min-computed", "math-min", 'Math["min"](1, 2)'),
  "math-max-computed": computedCalleeSpec("math-max-computed", "math-max", 'Math["max"](1, 2)'),
  "number-is-finite-computed": computedCalleeSpec(
    "number-is-finite-computed",
    "number-is-finite",
    '+Number["isFinite"](1)',
  ),
  "number-is-nan-computed": computedCalleeSpec(
    "number-is-nan-computed",
    "number-is-nan",
    '+Number["isNaN"](1)',
  ),
  "number-is-integer-computed": computedCalleeSpec(
    "number-is-integer-computed",
    "number-is-integer",
    '+Number["isInteger"](1)',
  ),
  "number-is-safe-integer-computed": computedCalleeSpec(
    "number-is-safe-integer-computed",
    "number-is-safe-integer",
    '+Number["isSafeInteger"](1)',
  ),
  "string-from-char-code-length-computed": computedCalleeSpec(
    "string-from-char-code-length-computed",
    "string-from-char-code-length",
    'String["fromCharCode"](65).length',
  ),
  "string-to-lower-case-computed": computedCalleeSpec(
    "string-to-lower-case-computed",
    "string-to-lower-case",
    '"ABC"["toLowerCase"]().length',
  ),
  "string-to-upper-case-computed": computedCalleeSpec(
    "string-to-upper-case-computed",
    "string-to-upper-case",
    '"abc"["toUpperCase"]().length',
  ),
  "string-trim-computed": computedCalleeSpec(
    "string-trim-computed",
    "string-trim",
    '" a "["trim"]().length',
  ),
  "string-trim-start-computed": computedCalleeSpec(
    "string-trim-start-computed",
    "string-trim-start",
    '" a "["trimStart"]().length',
  ),
  "string-trim-end-computed": computedCalleeSpec(
    "string-trim-end-computed",
    "string-trim-end",
    '" a "["trimEnd"]().length',
  ),
  "string-substring-computed": computedCalleeSpec(
    "string-substring-computed",
    "string-substring",
    '"abcd"["substring"](1, 3).length',
  ),
  "string-slice-computed": computedCalleeSpec(
    "string-slice-computed",
    "string-slice",
    '"abcd"["slice"](1, 3).length',
  ),
  "string-index-of-computed": computedCalleeSpec(
    "string-index-of-computed",
    "string-index-of",
    '"abcd"["indexOf"]("b")',
  ),
  "string-last-index-of-computed": computedCalleeSpec(
    "string-last-index-of-computed",
    "string-last-index-of",
    '"abcb"["lastIndexOf"]("b")',
  ),
  "string-char-at-computed": computedCalleeSpec(
    "string-char-at-computed",
    "string-char-at",
    '"abc"["charAt"](1).length',
  ),
  "string-char-code-at-computed": computedCalleeSpec(
    "string-char-code-at-computed",
    "string-char-code-at",
    '"abc"["charCodeAt"](1)',
  ),
  "string-starts-with-computed": computedCalleeSpec(
    "string-starts-with-computed",
    "string-starts-with",
    '+"abc"["startsWith"]("a")',
  ),
  "string-replace-computed": computedCalleeSpec(
    "string-replace-computed",
    "string-replace",
    '"abc"["replace"]("a", "z").length',
  ),
  "string-replace-all-computed": computedCalleeSpec(
    "string-replace-all-computed",
    "string-replace-all",
    '"aba"["replaceAll"]("a", "z").length',
  ),
  "string-to-string-computed": computedCalleeSpec(
    "string-to-string-computed",
    "string-to-string",
    '"abc"["toString"]().length',
  ),
  "boolean-to-string-computed": computedCalleeSpec(
    "boolean-to-string-computed",
    "boolean-to-string",
    '(true)["toString"]().length',
  ),
  "bigint-to-string-computed": computedCalleeSpec(
    "bigint-to-string-computed",
    "bigint-to-string",
    '(1n)["toString"]().length',
  ),
  "regexp-to-string-computed": computedCalleeSpec(
    "regexp-to-string-computed",
    "regexp-to-string",
    '/a/["toString"]().length',
  ),
  "number-to-string-computed": computedCalleeSpec(
    "number-to-string-computed",
    "number-to-string",
    '(12)["toString"]().length',
  ),

  "string-to-lower-case-local-const": localConstSpec(
    "string-to-lower-case-local-const",
    "local-const-casing",
    "string-to-lower-case",
    "__optimizerString",
    'const __optimizerString = "ABC";',
    "__optimizerString.toLowerCase().length",
  ),
  "string-to-upper-case-local-const": localConstSpec(
    "string-to-upper-case-local-const",
    "local-const-casing",
    "string-to-upper-case",
    "__optimizerString",
    'const __optimizerString = "abc";',
    "__optimizerString.toUpperCase().length",
  ),
  "string-trim-local-const": localConstSpec(
    "string-trim-local-const",
    "local-const-casing",
    "string-trim",
    "__optimizerString",
    'const __optimizerString = " a ";',
    "__optimizerString.trim().length",
  ),
  "string-trim-start-local-const": localConstSpec(
    "string-trim-start-local-const",
    "local-const-casing",
    "string-trim-start",
    "__optimizerString",
    'const __optimizerString = " a ";',
    "__optimizerString.trimStart().length",
  ),
  "string-trim-end-local-const": localConstSpec(
    "string-trim-end-local-const",
    "local-const-casing",
    "string-trim-end",
    "__optimizerString",
    'const __optimizerString = " a ";',
    "__optimizerString.trimEnd().length",
  ),
  "number-to-string-local-const": localConstSpec(
    "number-to-string-local-const",
    "local-const-to-string",
    "number-to-string",
    "__optimizerNumber",
    "const __optimizerNumber = 12;",
    "__optimizerNumber.toString().length",
  ),
  "string-to-string-local-const": localConstSpec(
    "string-to-string-local-const",
    "local-const-to-string",
    "string-to-string",
    "__optimizerString",
    'const __optimizerString = "abc";',
    "__optimizerString.toString().length",
  ),
  "boolean-to-string-local-const": localConstSpec(
    "boolean-to-string-local-const",
    "local-const-to-string",
    "boolean-to-string",
    "__optimizerBoolean",
    "const __optimizerBoolean = true;",
    "__optimizerBoolean.toString().length",
  ),
  "bigint-to-string-local-const": localConstSpec(
    "bigint-to-string-local-const",
    "local-const-to-string",
    "bigint-to-string",
    "__optimizerBigInt",
    "const __optimizerBigInt = 1n;",
    "__optimizerBigInt.toString().length",
  ),

  "string-to-lower-case-local-const-computed": localConstSpec(
    "string-to-lower-case-local-const-computed",
    "local-const-computed",
    "string-to-lower-case",
    "__optimizerString",
    'const __optimizerString = "ABC";',
    '__optimizerString["toLowerCase"]().length',
  ),
  "string-to-upper-case-local-const-computed": localConstSpec(
    "string-to-upper-case-local-const-computed",
    "local-const-computed",
    "string-to-upper-case",
    "__optimizerString",
    'const __optimizerString = "abc";',
    '__optimizerString["toUpperCase"]().length',
  ),
  "string-trim-local-const-computed": localConstSpec(
    "string-trim-local-const-computed",
    "local-const-computed",
    "string-trim",
    "__optimizerString",
    'const __optimizerString = " a ";',
    '__optimizerString["trim"]().length',
  ),
  "string-trim-start-local-const-computed": localConstSpec(
    "string-trim-start-local-const-computed",
    "local-const-computed",
    "string-trim-start",
    "__optimizerString",
    'const __optimizerString = " a ";',
    '__optimizerString["trimStart"]().length',
  ),
  "string-trim-end-local-const-computed": localConstSpec(
    "string-trim-end-local-const-computed",
    "local-const-computed",
    "string-trim-end",
    "__optimizerString",
    'const __optimizerString = " a ";',
    '__optimizerString["trimEnd"]().length',
  ),
  "number-to-string-local-const-computed": localConstSpec(
    "number-to-string-local-const-computed",
    "local-const-computed",
    "number-to-string",
    "__optimizerNumber",
    "const __optimizerNumber = 12;",
    '__optimizerNumber["toString"]().length',
  ),
  "string-to-string-local-const-computed": localConstSpec(
    "string-to-string-local-const-computed",
    "local-const-computed",
    "string-to-string",
    "__optimizerString",
    'const __optimizerString = "abc";',
    '__optimizerString["toString"]().length',
  ),
  "boolean-to-string-local-const-computed": localConstSpec(
    "boolean-to-string-local-const-computed",
    "local-const-computed",
    "boolean-to-string",
    "__optimizerBoolean",
    "const __optimizerBoolean = true;",
    '__optimizerBoolean["toString"]().length',
  ),
  "bigint-to-string-local-const-computed": localConstSpec(
    "bigint-to-string-local-const-computed",
    "local-const-computed",
    "bigint-to-string",
    "__optimizerBigInt",
    "const __optimizerBigInt = 1n;",
    '__optimizerBigInt["toString"]().length',
  ),

  "array-to-number-via-to-string": expressionSpec({
    key: "array-to-number-via-to-string",
    family: "coercion",
    patchStatement: 'Array.prototype.toString = () => "777";',
    numericExpression: "+[]",
    patchedValue: 777,
    fallbackValue: 0,
    description: "array numeric coercion through a patched toString",
  }),
  "array-to-number-via-join": expressionSpec({
    key: "array-to-number-via-join",
    family: "coercion",
    patchStatement: 'Array.prototype.join = () => "777";',
    numericExpression: "+[]",
    patchedValue: 777,
    fallbackValue: 0,
    description: "array numeric coercion through a patched join",
  }),
  "array-to-number-via-value-of": expressionSpec({
    key: "array-to-number-via-value-of",
    family: "coercion",
    patchStatement: "Array.prototype.valueOf = () => 777;",
    numericExpression: "+[]",
    patchedValue: 777,
    fallbackValue: 0,
    description: "array numeric coercion through a patched valueOf",
  }),
  "array-to-number-via-to-primitive": expressionSpec({
    key: "array-to-number-via-to-primitive",
    family: "coercion",
    patchStatement: "Array.prototype[Symbol.toPrimitive] = () => 777;",
    numericExpression: "+[]",
    patchedValue: 777,
    fallbackValue: 0,
    description: "array numeric coercion through a patched Symbol.toPrimitive",
  }),
  "object-to-number-via-to-string": expressionSpec({
    key: "object-to-number-via-to-string",
    family: "coercion",
    patchStatement: 'Object.prototype.toString = () => "777";',
    numericExpression: "+(+({}) === 777)",
    patchedValue: 1,
    fallbackValue: 0,
    description: "object numeric coercion through a patched toString",
  }),
  "object-to-number-via-value-of": expressionSpec({
    key: "object-to-number-via-value-of",
    family: "coercion",
    patchStatement: "Object.prototype.valueOf = () => 777;",
    numericExpression: "+(+({}) === 777)",
    patchedValue: 1,
    fallbackValue: 0,
    description: "object numeric coercion through a patched valueOf",
  }),
  "object-to-number-via-to-primitive": expressionSpec({
    key: "object-to-number-via-to-primitive",
    family: "coercion",
    patchStatement: "Object.prototype[Symbol.toPrimitive] = () => 777;",
    numericExpression: "+(+({}) === 777)",
    patchedValue: 1,
    fallbackValue: 0,
    description: "object numeric coercion through a patched Symbol.toPrimitive",
  }),
  "regexp-to-number-via-to-string": expressionSpec({
    key: "regexp-to-number-via-to-string",
    family: "coercion",
    patchStatement: 'RegExp.prototype.toString = () => "777";',
    numericExpression: "+(+(/a/) === 777)",
    patchedValue: 1,
    fallbackValue: 0,
    description: "RegExp numeric coercion through a patched toString",
  }),
  "regexp-to-number-via-value-of": expressionSpec({
    key: "regexp-to-number-via-value-of",
    family: "coercion",
    patchStatement: "RegExp.prototype.valueOf = () => 777;",
    numericExpression: "+(+(/a/) === 777)",
    patchedValue: 1,
    fallbackValue: 0,
    description: "RegExp numeric coercion through a patched valueOf",
  }),
  "regexp-to-number-via-to-primitive": expressionSpec({
    key: "regexp-to-number-via-to-primitive",
    family: "coercion",
    patchStatement: "RegExp.prototype[Symbol.toPrimitive] = () => 777;",
    numericExpression: "+(+(/a/) === 777)",
    patchedValue: 1,
    fallbackValue: 0,
    description: "RegExp numeric coercion through a patched Symbol.toPrimitive",
  }),
  "array-to-string-addition": expressionSpec({
    key: "array-to-string-addition",
    family: "coercion",
    patchStatement: 'Array.prototype.toString = () => "x".repeat(777);',
    numericExpression: '("" + []).length',
    patchedValue: 777,
    fallbackValue: 0,
    description: "array string coercion in addition",
  }),
  "object-to-string-addition": expressionSpec({
    key: "object-to-string-addition",
    family: "coercion",
    patchStatement: 'Object.prototype.toString = () => "x".repeat(777);',
    numericExpression: '("" + {}).length',
    patchedValue: 777,
    fallbackValue: 15,
    description: "object string coercion in addition",
  }),
  "regexp-to-string-addition": expressionSpec({
    key: "regexp-to-string-addition",
    family: "coercion",
    patchStatement: 'RegExp.prototype.toString = () => "x".repeat(777);',
    numericExpression: '("" + /a/).length',
    patchedValue: 777,
    fallbackValue: 3,
    description: "RegExp string coercion in addition",
  }),
  "array-bitwise-not-coercion": expressionSpec({
    key: "array-bitwise-not-coercion",
    family: "coercion",
    patchStatement: "Array.prototype.valueOf = () => 777;",
    numericExpression: "~[]",
    patchedValue: -778,
    fallbackValue: -1,
    description: "array numeric coercion in bitwise not",
  }),
  "array-subtraction-coercion": expressionSpec({
    key: "array-subtraction-coercion",
    family: "coercion",
    patchStatement: "Array.prototype.valueOf = () => 777;",
    numericExpression: "[] - 0",
    patchedValue: 777,
    fallbackValue: 0,
    description: "array numeric coercion in subtraction",
  }),
  "array-element-object-coercion": expressionSpec({
    key: "array-element-object-coercion",
    family: "coercion",
    patchStatement: 'Object.prototype.toString = () => "777";',
    numericExpression: "+(+[{}] === 777)",
    patchedValue: 1,
    fallbackValue: 0,
    description: "nested object string coercion during array numeric coercion",
  }),

  "number-positive-infinity-type-shortcut": expressionSpec({
    key: "number-positive-infinity-type-shortcut",
    family: "number-infinity-type-shortcut",
    patchStatement: NUMBER_INFINITY_PATCH,
    numericExpression: '+(Number.POSITIVE_INFINITY === "x")',
    patchedValue: 1,
    fallbackValue: 0,
    description: "strict equality after replacing Number.POSITIVE_INFINITY with a string",
  }),
  "number-negative-infinity-type-shortcut": expressionSpec({
    key: "number-negative-infinity-type-shortcut",
    family: "number-infinity-type-shortcut",
    patchStatement: NUMBER_INFINITY_PATCH,
    numericExpression: '+(Number.NEGATIVE_INFINITY === "x")',
    patchedValue: 1,
    fallbackValue: 0,
    description: "strict equality after replacing Number.NEGATIVE_INFINITY with a string",
  }),

  "array-computed-length-effect": effectPreservationSpec(
    "array-computed-length-effect",
    "math-hypot-call",
    '[Math.hypot()]["length"]',
    1,
    "computed array length whose element call must be preserved",
  ),
  "unary-void-call-effect": effectPreservationSpec(
    "unary-void-call-effect",
    "math-hypot-call",
    "+(void Math.hypot() === undefined)",
    1,
    "void evaluation whose discarded call must be preserved",
  ),
  "sequence-call-effect": effectPreservationSpec(
    "sequence-call-effect",
    "math-hypot-call",
    "(Math.hypot(), 1)",
    1,
    "sequence expression whose discarded call must be preserved",
  ),
  "not-array-call-effect": effectPreservationSpec(
    "not-array-call-effect",
    "math-hypot-call",
    "+(![Math.hypot()])",
    0,
    "array truthiness fold whose element call must be preserved",
  ),
  "typeof-object-call-effect": effectPreservationSpec(
    "typeof-object-call-effect",
    "math-hypot-call",
    "(typeof ({ x: Math.hypot() })).length",
    6,
    "object typeof fold whose property initializer call must be preserved",
  ),
  "strict-eq-date-effect": effectPreservationSpec(
    "strict-eq-date-effect",
    "date-construction",
    "+(new Date() === 0)",
    0,
    "strict equality fold whose Date construction must be preserved",
  ),
  "logical-array-and-effect": effectPreservationSpec(
    "logical-array-and-effect",
    "math-hypot-call",
    "([Math.hypot()] && 1)",
    1,
    "array truthiness in logical AND whose element call must be preserved",
  ),
  "instanceof-array-call-effect": effectPreservationSpec(
    "instanceof-array-call-effect",
    "math-hypot-call",
    "+([Math.hypot()] instanceof Object)",
    1,
    "array instanceof fold whose element call must be preserved",
  ),
  "not-class-static-call-effect": effectPreservationSpec(
    "not-class-static-call-effect",
    "math-hypot-call",
    "+(!(class { static x = Math.hypot(); }))",
    0,
    "class truthiness fold whose static field call must be preserved",
  ),
  "not-date-construction-effect": effectPreservationSpec(
    "not-date-construction-effect",
    "date-construction",
    "+(!new Date())",
    0,
    "Date truthiness fold whose construction must be preserved",
  ),
  "not-object-call-effect": effectPreservationSpec(
    "not-object-call-effect",
    "math-hypot-call",
    "+(!({ x: Math.hypot() }))",
    0,
    "object truthiness fold whose property initializer call must be preserved",
  ),
  "sequence-date-construction-effect": effectPreservationSpec(
    "sequence-date-construction-effect",
    "date-construction",
    "(new Date(), 1)",
    1,
    "sequence expression whose discarded Date construction must be preserved",
  ),
  "strict-eq-array-call-effect": effectPreservationSpec(
    "strict-eq-array-call-effect",
    "math-hypot-call",
    "+([Math.hypot()] === 0)",
    0,
    "strict equality fold whose array element call must be preserved",
  ),
  "strict-eq-object-call-effect": effectPreservationSpec(
    "strict-eq-object-call-effect",
    "math-hypot-call",
    "+(({ x: Math.hypot() }) === 0)",
    0,
    "strict equality fold whose object property initializer call must be preserved",
  ),
  "typeof-array-call-effect": effectPreservationSpec(
    "typeof-array-call-effect",
    "math-hypot-call",
    "(typeof [Math.hypot()]).length",
    6,
    "array typeof fold whose element call must be preserved",
  ),
  "typeof-class-static-call-effect": effectPreservationSpec(
    "typeof-class-static-call-effect",
    "math-hypot-call",
    "(typeof class { static x = Math.hypot(); }).length",
    8,
    "class typeof fold whose static field call must be preserved",
  ),
  "unary-void-date-effect": effectPreservationSpec(
    "unary-void-date-effect",
    "date-construction",
    "+(void new Date() === undefined)",
    1,
    "void evaluation whose discarded Date construction must be preserved",
  ),
} as const satisfies Record<string, GlobalReadOptimizerExpressionSpec>);

type BaseGlobalReadOptimizerExpressionKind =
  keyof typeof BASE_GLOBAL_READ_OPTIMIZER_EXPRESSION_SPECS;

const COMPUTED_MEMBER_SOURCE_KINDS = [
  "math-abs-computed",
  "math-ceil-computed",
  "math-floor-computed",
  "math-round-computed",
  "math-fround-computed",
  "math-trunc-computed",
  "math-sign-computed",
  "math-clz32-computed",
  "math-sqrt-computed",
  "math-cbrt-computed",
  "math-imul-computed",
  "math-min-computed",
  "math-max-computed",
  "number-is-finite-computed",
  "number-is-nan-computed",
  "number-is-integer-computed",
  "number-is-safe-integer-computed",
  "string-from-char-code-length-computed",
  "string-to-lower-case-computed",
  "string-to-upper-case-computed",
  "string-trim-computed",
  "string-trim-start-computed",
  "string-trim-end-computed",
  "string-substring-computed",
  "string-slice-computed",
  "string-index-of-computed",
  "string-last-index-of-computed",
  "string-char-at-computed",
  "string-char-code-at-computed",
  "string-starts-with-computed",
  "string-replace-computed",
  "string-replace-all-computed",
  "string-to-string-computed",
  "boolean-to-string-computed",
  "bigint-to-string-computed",
  "regexp-to-string-computed",
  "number-to-string-computed",
  "string-to-lower-case-local-const-computed",
  "string-to-upper-case-local-const-computed",
  "string-trim-local-const-computed",
  "string-trim-start-local-const-computed",
  "string-trim-end-local-const-computed",
  "number-to-string-local-const-computed",
  "string-to-string-local-const-computed",
  "boolean-to-string-local-const-computed",
  "bigint-to-string-local-const-computed",
] as const satisfies readonly BaseGlobalReadOptimizerExpressionKind[];

const OPTIONAL_RECEIVER_SOURCE_KINDS = [
  "string-to-lower-case-computed",
  "string-to-upper-case-computed",
  "string-trim-computed",
  "string-trim-start-computed",
  "string-trim-end-computed",
  "string-substring-computed",
  "string-slice-computed",
  "string-index-of-computed",
  "string-last-index-of-computed",
  "string-char-at-computed",
  "string-char-code-at-computed",
  "string-starts-with-computed",
  "string-replace-computed",
  "string-replace-all-computed",
  "string-to-string-computed",
  "boolean-to-string-computed",
  "bigint-to-string-computed",
  "regexp-to-string-computed",
  "number-to-string-computed",
  "string-to-lower-case-local-const-computed",
  "string-to-upper-case-local-const-computed",
  "string-trim-local-const-computed",
  "string-trim-start-local-const-computed",
  "string-trim-end-local-const-computed",
  "number-to-string-local-const-computed",
  "string-to-string-local-const-computed",
  "boolean-to-string-local-const-computed",
  "bigint-to-string-local-const-computed",
] as const satisfies readonly (typeof COMPUTED_MEMBER_SOURCE_KINDS)[number][];

/// Binary concatenation preserves the selected receiver only for these string-valued sources. The
/// other five compound-receiver variants preserve every optional-source receiver's original type.
const STRING_RECEIVER_SOURCE_KINDS = [
  "string-to-lower-case-computed",
  "string-to-upper-case-computed",
  "string-trim-computed",
  "string-trim-start-computed",
  "string-trim-end-computed",
  "string-substring-computed",
  "string-slice-computed",
  "string-index-of-computed",
  "string-last-index-of-computed",
  "string-char-at-computed",
  "string-char-code-at-computed",
  "string-starts-with-computed",
  "string-replace-computed",
  "string-replace-all-computed",
  "string-to-string-computed",
  "string-to-lower-case-local-const-computed",
  "string-to-upper-case-local-const-computed",
  "string-trim-local-const-computed",
  "string-trim-start-local-const-computed",
  "string-trim-end-local-const-computed",
  "string-to-string-local-const-computed",
] as const satisfies readonly (typeof OPTIONAL_RECEIVER_SOURCE_KINDS)[number][];

const PARENTHESIZED_STATIC_RECEIVER_SOURCES = [
  { sourceKind: "math-abs-computed", receiver: "Math" },
  { sourceKind: "math-ceil-computed", receiver: "Math" },
  { sourceKind: "math-floor-computed", receiver: "Math" },
  { sourceKind: "math-round-computed", receiver: "Math" },
  { sourceKind: "math-fround-computed", receiver: "Math" },
  { sourceKind: "math-trunc-computed", receiver: "Math" },
  { sourceKind: "math-sign-computed", receiver: "Math" },
  { sourceKind: "math-clz32-computed", receiver: "Math" },
  { sourceKind: "math-sqrt-computed", receiver: "Math" },
  { sourceKind: "math-cbrt-computed", receiver: "Math" },
  { sourceKind: "math-imul-computed", receiver: "Math" },
  { sourceKind: "math-min-computed", receiver: "Math" },
  { sourceKind: "math-max-computed", receiver: "Math" },
  { sourceKind: "number-is-finite-computed", receiver: "Number" },
  { sourceKind: "number-is-nan-computed", receiver: "Number" },
  { sourceKind: "number-is-integer-computed", receiver: "Number" },
  { sourceKind: "number-is-safe-integer-computed", receiver: "Number" },
  { sourceKind: "string-from-char-code-length-computed", receiver: "String" },
] as const satisfies readonly {
  readonly sourceKind: (typeof COMPUTED_MEMBER_SOURCE_KINDS)[number];
  readonly receiver: "Math" | "Number" | "String";
}[];

const COMPUTED_KEY_EXPRESSION_VARIANTS = [
  "concatenation",
  "conditional",
  "sequence",
  "logical-and",
  "logical-or",
  "nullish-coalescing",
] as const satisfies readonly ComputedKeyExpressionVariant[];

const INSTANCEOF_CONSTRUCTOR_VARIANTS = [
  "conditional",
  "sequence",
  "logical-and",
  "parenthesized",
] as const satisfies readonly InstanceofConstructorVariant[];

const COMPOUND_RECEIVER_VARIANTS = [
  "conditional",
  "sequence",
  "logical-and",
  "logical-or",
  "nullish-coalescing",
] as const satisfies readonly Exclude<CompoundReceiverVariant, "concatenation">[];

const OPTIONAL_PARENTHESIZED_CALLEE_VARIANTS = [
  "computed",
  "dot",
] as const satisfies readonly OptionalParenthesizedCalleeVariant[];

const ADJACENT_INSTANCEOF_CONSTRUCTOR_VARIANTS = [
  "logical-or",
  "nullish-coalescing",
  "undefined-nullish-coalescing",
] as const satisfies readonly AdjacentInstanceofConstructorVariant[];

const INSTANCEOF_LEFT_EXPRESSION_VARIANTS = [
  "conditional",
  "sequence",
  "logical-and",
  "logical-or",
  "nullish-coalescing",
] as const satisfies readonly InstanceofLeftExpressionVariant[];

export type ComputedMemberSourceKind = (typeof COMPUTED_MEMBER_SOURCE_KINDS)[number];
export type OptionalReceiverSourceKind = (typeof OPTIONAL_RECEIVER_SOURCE_KINDS)[number];
export type ParenthesizedStaticReceiverSourceKind =
  (typeof PARENTHESIZED_STATIC_RECEIVER_SOURCES)[number]["sourceKind"];
export type StringReceiverSourceKind = (typeof STRING_RECEIVER_SOURCE_KINDS)[number];
export type ComputedKeyExpressionOptimizerExpressionKind =
  `${ComputedMemberSourceKind}-key-${ComputedKeyExpressionVariant}`;
export type OptionalReceiverOptimizerExpressionKind =
  `${OptionalReceiverSourceKind}-optional-receiver`;
export type InstanceofConstructorOptimizerExpressionKind =
  `${GlobalReadInstanceofKind}-constructor-${InstanceofConstructorVariant}`;
export type ParenthesizedStaticReceiverOptimizerExpressionKind =
  `${ParenthesizedStaticReceiverSourceKind}-parenthesized-receiver`;
export type CompoundReceiverOptimizerExpressionKind =
  | `${OptionalReceiverSourceKind}-receiver-${Exclude<CompoundReceiverVariant, "concatenation">}`
  | `${StringReceiverSourceKind}-receiver-concatenation`;
export type OptionalComputedKeyOptimizerExpressionKind =
  `${OptionalReceiverSourceKind}-optional-key-${ComputedKeyExpressionVariant}`;
export type OptionalParenthesizedCalleeOptimizerExpressionKind =
  `${OptionalReceiverSourceKind}-optional-parenthesized-${OptionalParenthesizedCalleeVariant}-callee`;
export type AdjacentInstanceofConstructorOptimizerExpressionKind =
  `${GlobalReadInstanceofKind}-constructor-${AdjacentInstanceofConstructorVariant}`;
export type InstanceofLeftExpressionOptimizerExpressionKind =
  `${GlobalReadInstanceofKind}-left-${InstanceofLeftExpressionVariant}`;

function frozenRecordFromEntries<K extends string, V>(
  entries: readonly (readonly [K, V])[],
): Readonly<Record<K, V>> {
  const record: Record<string, V> = {};
  for (const [key, value] of entries) {
    if (Object.hasOwn(record, key)) {
      throw new Error(`duplicate optimizer-expression key ${JSON.stringify(key)}`);
    }
    record[key] = value;
  }
  return Object.freeze(record) as Readonly<Record<K, V>>;
}

function computedPropertySource(expression: string): {
  readonly source: string;
  readonly propertyName: string;
} {
  const matches = [...expression.matchAll(/\["([A-Za-z0-9]+)"\]/g)];
  if (matches.length !== 1 || matches[0]?.[0] === undefined || matches[0][1] === undefined) {
    throw new Error(
      `optimizer member source must contain exactly one computed identifier property: ${expression}`,
    );
  }
  return { source: matches[0][0], propertyName: matches[0][1] };
}

function computedMemberSource(expression: string): {
  readonly projectionPrefix: "" | "+";
  readonly receiverSource: string;
  readonly propertySource: string;
  readonly propertyName: string;
  readonly suffix: string;
} {
  const property = computedPropertySource(expression);
  const propertyIndex = expression.indexOf(property.source);
  const projectionPrefix = expression.startsWith("+") ? "+" : "";
  const receiverSource = expression.slice(projectionPrefix.length, propertyIndex);
  if (receiverSource.length === 0) {
    throw new Error(`optimizer member source has no receiver: ${expression}`);
  }
  return {
    projectionPrefix,
    receiverSource,
    propertySource: property.source,
    propertyName: property.propertyName,
    suffix: expression.slice(propertyIndex + property.source.length),
  };
}

function renderComputedKeyExpression(
  variant: ComputedKeyExpressionVariant,
  propertyName: string,
): string {
  const property = JSON.stringify(propertyName);
  switch (variant) {
    case "concatenation":
      return `${JSON.stringify(propertyName.slice(0, 1))} + ${JSON.stringify(propertyName.slice(1))}`;
    case "conditional":
      return `true ? ${property} : "__missing"`;
    case "sequence":
      return `0, ${property}`;
    case "logical-and":
      return `true && ${property}`;
    case "logical-or":
      return `false || ${property}`;
    case "nullish-coalescing":
      return `null ?? ${property}`;
  }
}

function renderCompoundReceiver(variant: CompoundReceiverVariant, receiverSource: string): string {
  switch (variant) {
    case "concatenation":
      return `("" + ${receiverSource})`;
    case "conditional":
      return `(true ? ${receiverSource} : null)`;
    case "sequence":
      return `(0, ${receiverSource})`;
    case "logical-and":
      return `(true && ${receiverSource})`;
    case "logical-or":
      return `(false || ${receiverSource})`;
    case "nullish-coalescing":
      return `(null ?? ${receiverSource})`;
  }
}

function computedKeyExpressionSpecs(): Readonly<
  Record<ComputedKeyExpressionOptimizerExpressionKind, ComputedKeyExpressionOptimizerExpressionSpec>
> {
  const entries: [
    ComputedKeyExpressionOptimizerExpressionKind,
    ComputedKeyExpressionOptimizerExpressionSpec,
  ][] = [];
  for (const sourceKind of COMPUTED_MEMBER_SOURCE_KINDS) {
    const sourceSpec = BASE_GLOBAL_READ_OPTIMIZER_EXPRESSION_SPECS[sourceKind];
    const computedProperty = computedPropertySource(sourceSpec.numericExpression);
    for (const variant of COMPUTED_KEY_EXPRESSION_VARIANTS) {
      const key = `${sourceKind}-key-${variant}` as const;
      const keyExpression = renderComputedKeyExpression(variant, computedProperty.propertyName);
      const numericExpression = sourceSpec.numericExpression.replace(
        computedProperty.source,
        `[${keyExpression}]`,
      );
      entries.push([
        key,
        Object.freeze({
          key,
          family: "computed-key-expression",
          builtinKind: sourceSpec.builtinKind,
          sourceExpressionKind: sourceKind,
          keyExpressionVariant: variant,
          patchStatement: sourceSpec.patchStatement,
          ...("readerBinding" in sourceSpec
            ? {
                readerBinding: sourceSpec.readerBinding,
                readerPrelude: sourceSpec.readerPrelude,
              }
            : {}),
          numericExpression,
          patchedValue: sourceSpec.patchedValue,
          fallbackValue: sourceSpec.fallbackValue,
          description: `${sourceSpec.description} through a ${variant} computed property key`,
        }),
      ]);
    }
  }
  return frozenRecordFromEntries(entries);
}

function optionalReceiverSpecs(): Readonly<
  Record<OptionalReceiverOptimizerExpressionKind, OptionalReceiverOptimizerExpressionSpec>
> {
  const entries: [
    OptionalReceiverOptimizerExpressionKind,
    OptionalReceiverOptimizerExpressionSpec,
  ][] = [];
  for (const sourceKind of OPTIONAL_RECEIVER_SOURCE_KINDS) {
    const sourceSpec = BASE_GLOBAL_READ_OPTIMIZER_EXPRESSION_SPECS[sourceKind];
    const computedProperty = computedPropertySource(sourceSpec.numericExpression);
    const key = `${sourceKind}-optional-receiver` as const;
    const numericExpression = sourceSpec.numericExpression.replace(
      computedProperty.source,
      `?.${computedProperty.source}`,
    );
    entries.push([
      key,
      Object.freeze({
        key,
        family: "optional-receiver",
        builtinKind: sourceSpec.builtinKind,
        sourceExpressionKind: sourceKind,
        patchStatement: sourceSpec.patchStatement,
        ...("readerBinding" in sourceSpec
          ? {
              readerBinding: sourceSpec.readerBinding,
              readerPrelude: sourceSpec.readerPrelude,
            }
          : {}),
        numericExpression,
        patchedValue: sourceSpec.patchedValue,
        fallbackValue: sourceSpec.fallbackValue,
        description: `${sourceSpec.description} through an optional receiver`,
      }),
    ]);
  }
  return frozenRecordFromEntries(entries);
}

function compoundReceiverSpecs(): Readonly<
  Record<CompoundReceiverOptimizerExpressionKind, CompoundReceiverOptimizerExpressionSpec>
> {
  const entries: [
    CompoundReceiverOptimizerExpressionKind,
    CompoundReceiverOptimizerExpressionSpec,
  ][] = [];
  for (const sourceKind of OPTIONAL_RECEIVER_SOURCE_KINDS) {
    const sourceSpec = BASE_GLOBAL_READ_OPTIMIZER_EXPRESSION_SPECS[sourceKind];
    const member = computedMemberSource(sourceSpec.numericExpression);
    for (const variant of COMPOUND_RECEIVER_VARIANTS) {
      const key = `${sourceKind}-receiver-${variant}` as const;
      entries.push([
        key,
        Object.freeze({
          key,
          family: "compound-receiver",
          builtinKind: sourceSpec.builtinKind,
          sourceExpressionKind: sourceKind,
          receiverVariant: variant,
          patchStatement: sourceSpec.patchStatement,
          ...("readerBinding" in sourceSpec
            ? {
                readerBinding: sourceSpec.readerBinding,
                readerPrelude: sourceSpec.readerPrelude,
              }
            : {}),
          numericExpression: `${member.projectionPrefix}${renderCompoundReceiver(variant, member.receiverSource)}${member.propertySource}${member.suffix}`,
          patchedValue: sourceSpec.patchedValue,
          fallbackValue: sourceSpec.fallbackValue,
          description: `${sourceSpec.description} through a ${variant} receiver expression`,
        }),
      ]);
    }
    if ((STRING_RECEIVER_SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
      const variant = "concatenation" as const;
      const key = `${sourceKind}-receiver-${variant}` as CompoundReceiverOptimizerExpressionKind;
      entries.push([
        key,
        Object.freeze({
          key,
          family: "compound-receiver",
          builtinKind: sourceSpec.builtinKind,
          sourceExpressionKind: sourceKind,
          receiverVariant: variant,
          patchStatement: sourceSpec.patchStatement,
          ...("readerBinding" in sourceSpec
            ? {
                readerBinding: sourceSpec.readerBinding,
                readerPrelude: sourceSpec.readerPrelude,
              }
            : {}),
          numericExpression: `${member.projectionPrefix}${renderCompoundReceiver(variant, member.receiverSource)}${member.propertySource}${member.suffix}`,
          patchedValue: sourceSpec.patchedValue,
          fallbackValue: sourceSpec.fallbackValue,
          description: `${sourceSpec.description} through a concatenated string receiver`,
        }),
      ]);
    }
  }
  return frozenRecordFromEntries(entries);
}

function optionalComputedKeySpecs(): Readonly<
  Record<OptionalComputedKeyOptimizerExpressionKind, OptionalComputedKeyOptimizerExpressionSpec>
> {
  const entries: [
    OptionalComputedKeyOptimizerExpressionKind,
    OptionalComputedKeyOptimizerExpressionSpec,
  ][] = [];
  for (const sourceKind of OPTIONAL_RECEIVER_SOURCE_KINDS) {
    const sourceSpec = BASE_GLOBAL_READ_OPTIMIZER_EXPRESSION_SPECS[sourceKind];
    const member = computedMemberSource(sourceSpec.numericExpression);
    for (const variant of COMPUTED_KEY_EXPRESSION_VARIANTS) {
      const key = `${sourceKind}-optional-key-${variant}` as const;
      entries.push([
        key,
        Object.freeze({
          key,
          family: "optional-computed-key",
          builtinKind: sourceSpec.builtinKind,
          sourceExpressionKind: sourceKind,
          keyExpressionVariant: variant,
          patchStatement: sourceSpec.patchStatement,
          ...("readerBinding" in sourceSpec
            ? {
                readerBinding: sourceSpec.readerBinding,
                readerPrelude: sourceSpec.readerPrelude,
              }
            : {}),
          numericExpression: `${member.projectionPrefix}${member.receiverSource}?.[${renderComputedKeyExpression(variant, member.propertyName)}]${member.suffix}`,
          patchedValue: sourceSpec.patchedValue,
          fallbackValue: sourceSpec.fallbackValue,
          description: `${sourceSpec.description} through an optional receiver and ${variant} property key`,
        }),
      ]);
    }
  }
  return frozenRecordFromEntries(entries);
}

function optionalParenthesizedCalleeSpecs(): Readonly<
  Record<
    OptionalParenthesizedCalleeOptimizerExpressionKind,
    OptionalParenthesizedCalleeOptimizerExpressionSpec
  >
> {
  const entries: [
    OptionalParenthesizedCalleeOptimizerExpressionKind,
    OptionalParenthesizedCalleeOptimizerExpressionSpec,
  ][] = [];
  for (const sourceKind of OPTIONAL_RECEIVER_SOURCE_KINDS) {
    const sourceSpec = BASE_GLOBAL_READ_OPTIMIZER_EXPRESSION_SPECS[sourceKind];
    const member = computedMemberSource(sourceSpec.numericExpression);
    if (!member.suffix.startsWith("(")) {
      throw new Error(`optimizer member must be used as a callee: ${sourceSpec.numericExpression}`);
    }
    for (const variant of OPTIONAL_PARENTHESIZED_CALLEE_VARIANTS) {
      const key = `${sourceKind}-optional-parenthesized-${variant}-callee` as const;
      const optionalMember =
        variant === "computed"
          ? `${member.receiverSource}?.[${JSON.stringify(member.propertyName)}]`
          : `${member.receiverSource}?.${member.propertyName}`;
      entries.push([
        key,
        Object.freeze({
          key,
          family: "optional-parenthesized-callee",
          builtinKind: sourceSpec.builtinKind,
          sourceExpressionKind: sourceKind,
          calleeVariant: variant,
          patchStatement: sourceSpec.patchStatement,
          ...("readerBinding" in sourceSpec
            ? {
                readerBinding: sourceSpec.readerBinding,
                readerPrelude: sourceSpec.readerPrelude,
              }
            : {}),
          numericExpression: `${member.projectionPrefix}(${optionalMember})${member.suffix}`,
          patchedValue: sourceSpec.patchedValue,
          fallbackValue: sourceSpec.fallbackValue,
          description: `${sourceSpec.description} through a parenthesized optional ${variant} member callee`,
        }),
      ]);
    }
  }
  return frozenRecordFromEntries(entries);
}

function parenthesizedStaticReceiverSpecs(): Readonly<
  Record<
    ParenthesizedStaticReceiverOptimizerExpressionKind,
    ParenthesizedStaticReceiverOptimizerExpressionSpec
  >
> {
  const entries: [
    ParenthesizedStaticReceiverOptimizerExpressionKind,
    ParenthesizedStaticReceiverOptimizerExpressionSpec,
  ][] = [];
  for (const { sourceKind, receiver } of PARENTHESIZED_STATIC_RECEIVER_SOURCES) {
    const sourceSpec = BASE_GLOBAL_READ_OPTIMIZER_EXPRESSION_SPECS[sourceKind];
    const receiverSource = `${receiver}[`;
    if (sourceSpec.numericExpression.split(receiverSource).length !== 2) {
      throw new Error(
        `static receiver source must contain exactly one ${receiverSource}: ${sourceSpec.numericExpression}`,
      );
    }
    const key = `${sourceKind}-parenthesized-receiver` as const;
    entries.push([
      key,
      Object.freeze({
        key,
        family: "parenthesized-static-receiver",
        builtinKind: sourceSpec.builtinKind,
        sourceExpressionKind: sourceKind,
        patchStatement: sourceSpec.patchStatement,
        numericExpression: sourceSpec.numericExpression.replace(receiverSource, `(${receiver})[`),
        patchedValue: sourceSpec.patchedValue,
        fallbackValue: sourceSpec.fallbackValue,
        description: `${sourceSpec.description} through a parenthesized static receiver`,
      }),
    ]);
  }
  return frozenRecordFromEntries(entries);
}

function renderInstanceofConstructorExpression(
  kind: GlobalReadInstanceofKind,
  variant: InstanceofConstructorVariant,
): string {
  const spec = globalReadInstanceofSpec(kind);
  const separator = " instanceof ";
  const parts = spec.expression.split(separator);
  if (parts.length !== 2 || parts[0] === undefined || parts[1] !== spec.constructorName) {
    throw new Error(`unexpected instanceof source ${JSON.stringify(spec.expression)}`);
  }
  const constructorExpression = (() => {
    switch (variant) {
      case "conditional":
        return `true ? ${spec.constructorName} : Function`;
      case "sequence":
        return `0, ${spec.constructorName}`;
      case "logical-and":
        return `true && ${spec.constructorName}`;
      case "parenthesized":
        return spec.constructorName;
    }
  })();
  return `+(${parts[0]} instanceof (${constructorExpression}))`;
}

function instanceofConstructorSpecs(): Readonly<
  Record<InstanceofConstructorOptimizerExpressionKind, InstanceofConstructorOptimizerExpressionSpec>
> {
  const instanceOfKinds = [
    "array-instanceof-object",
    "number-instanceof-number",
    "boolean-instanceof-boolean",
    "string-instanceof-string",
  ] as const satisfies readonly GlobalReadInstanceofKind[];
  const entries: [
    InstanceofConstructorOptimizerExpressionKind,
    InstanceofConstructorOptimizerExpressionSpec,
  ][] = [];
  for (const instanceofKind of instanceOfKinds) {
    const sourceSpec = globalReadInstanceofSpec(instanceofKind);
    for (const variant of INSTANCEOF_CONSTRUCTOR_VARIANTS) {
      const key = `${instanceofKind}-constructor-${variant}` as const;
      entries.push([
        key,
        Object.freeze({
          key,
          family: "instanceof-constructor",
          instanceofKind,
          constructorVariant: variant,
          patchStatement: renderGlobalReadInstanceofAssignment(sourceSpec),
          numericExpression: renderInstanceofConstructorExpression(instanceofKind, variant),
          patchedValue: sourceSpec.patchedValue,
          fallbackValue: sourceSpec.fallbackValue,
          description: `${sourceSpec.description} through a ${variant} constructor expression`,
        }),
      ]);
    }
  }
  return frozenRecordFromEntries(entries);
}

function renderAdjacentInstanceofConstructorExpression(
  kind: GlobalReadInstanceofKind,
  variant: AdjacentInstanceofConstructorVariant,
): string {
  const spec = globalReadInstanceofSpec(kind);
  const separator = " instanceof ";
  const parts = spec.expression.split(separator);
  if (parts.length !== 2 || parts[0] === undefined || parts[1] !== spec.constructorName) {
    throw new Error(`unexpected instanceof source ${JSON.stringify(spec.expression)}`);
  }
  const constructorExpression = (() => {
    switch (variant) {
      case "logical-or":
        return `false || ${spec.constructorName}`;
      case "nullish-coalescing":
        return `null ?? ${spec.constructorName}`;
      case "undefined-nullish-coalescing":
        return `void 0 ?? ${spec.constructorName}`;
    }
  })();
  return `+(${parts[0]} instanceof (${constructorExpression}))`;
}

function adjacentInstanceofConstructorSpecs(): Readonly<
  Record<
    AdjacentInstanceofConstructorOptimizerExpressionKind,
    AdjacentInstanceofConstructorOptimizerExpressionSpec
  >
> {
  const entries: [
    AdjacentInstanceofConstructorOptimizerExpressionKind,
    AdjacentInstanceofConstructorOptimizerExpressionSpec,
  ][] = [];
  for (const instanceofKind of [
    "array-instanceof-object",
    "number-instanceof-number",
    "boolean-instanceof-boolean",
    "string-instanceof-string",
  ] as const satisfies readonly GlobalReadInstanceofKind[]) {
    const sourceSpec = globalReadInstanceofSpec(instanceofKind);
    for (const variant of ADJACENT_INSTANCEOF_CONSTRUCTOR_VARIANTS) {
      const key = `${instanceofKind}-constructor-${variant}` as const;
      entries.push([
        key,
        Object.freeze({
          key,
          family: "instanceof-constructor-adjacent",
          instanceofKind,
          constructorVariant: variant,
          patchStatement: renderGlobalReadInstanceofAssignment(sourceSpec),
          numericExpression: renderAdjacentInstanceofConstructorExpression(instanceofKind, variant),
          patchedValue: sourceSpec.patchedValue,
          fallbackValue: sourceSpec.fallbackValue,
          description: `${sourceSpec.description} through a ${variant} constructor expression`,
        }),
      ]);
    }
  }
  return frozenRecordFromEntries(entries);
}

function renderInstanceofLeftExpression(
  kind: GlobalReadInstanceofKind,
  variant: InstanceofLeftExpressionVariant,
): string {
  const spec = globalReadInstanceofSpec(kind);
  const separator = " instanceof ";
  const parts = spec.expression.split(separator);
  if (parts.length !== 2 || parts[0] === undefined || parts[1] !== spec.constructorName) {
    throw new Error(`unexpected instanceof source ${JSON.stringify(spec.expression)}`);
  }
  const leftExpression = (() => {
    switch (variant) {
      case "conditional":
        return `true ? ${parts[0]} : ${parts[0]}`;
      case "sequence":
        return `0, ${parts[0]}`;
      case "logical-and":
        return `true && ${parts[0]}`;
      case "logical-or":
        return `false || ${parts[0]}`;
      case "nullish-coalescing":
        return `null ?? ${parts[0]}`;
    }
  })();
  return `+((${leftExpression}) instanceof ${spec.constructorName})`;
}

function instanceofLeftExpressionSpecs(): Readonly<
  Record<
    InstanceofLeftExpressionOptimizerExpressionKind,
    InstanceofLeftExpressionOptimizerExpressionSpec
  >
> {
  const entries: [
    InstanceofLeftExpressionOptimizerExpressionKind,
    InstanceofLeftExpressionOptimizerExpressionSpec,
  ][] = [];
  for (const instanceofKind of [
    "array-instanceof-object",
    "number-instanceof-number",
    "boolean-instanceof-boolean",
    "string-instanceof-string",
  ] as const satisfies readonly GlobalReadInstanceofKind[]) {
    const sourceSpec = globalReadInstanceofSpec(instanceofKind);
    for (const variant of INSTANCEOF_LEFT_EXPRESSION_VARIANTS) {
      const key = `${instanceofKind}-left-${variant}` as const;
      entries.push([
        key,
        Object.freeze({
          key,
          family: "instanceof-left-expression",
          instanceofKind,
          leftVariant: variant,
          patchStatement: renderGlobalReadInstanceofAssignment(sourceSpec),
          numericExpression: renderInstanceofLeftExpression(instanceofKind, variant),
          patchedValue: sourceSpec.patchedValue,
          fallbackValue: sourceSpec.fallbackValue,
          description: `${sourceSpec.description} through a ${variant} left operand`,
        }),
      ]);
    }
  }
  return frozenRecordFromEntries(entries);
}

const NUMBER_NAN_PATCH =
  'globalThis.Number = ((original) => { const replacement = function (...args) { return new.target ? Reflect.construct(original, args, new.target === replacement ? original : new.target) : Reflect.apply(original, this, args); }; Object.setPrototypeOf(replacement, original); replacement.prototype = original.prototype; Object.defineProperty(replacement, "NaN", { value: 777 }); return replacement; })(Number);';

/// Hand-authored second-wave cells follow every first-wave product so extending this registry cannot
/// remap any of the 428 already fingerprinted keys.
const SECOND_WAVE_HAND_AUTHORED_EXPRESSION_SPECS = Object.freeze({
  "array-multiplication-coercion": expressionSpec({
    key: "array-multiplication-coercion",
    family: "coercion",
    patchStatement: "Array.prototype.valueOf = () => 777;",
    numericExpression: "[] * 2",
    patchedValue: 1554,
    fallbackValue: 0,
    description: "array numeric coercion in multiplication",
  }),
  "array-division-coercion": expressionSpec({
    key: "array-division-coercion",
    family: "coercion",
    patchStatement: "Array.prototype.valueOf = () => 777;",
    numericExpression: "[] / 1",
    patchedValue: 777,
    fallbackValue: 0,
    description: "array numeric coercion in division",
  }),
  "array-remainder-coercion": expressionSpec({
    key: "array-remainder-coercion",
    family: "coercion",
    patchStatement: "Array.prototype.valueOf = () => 777;",
    numericExpression: "[] % 100",
    patchedValue: 77,
    fallbackValue: 0,
    description: "array numeric coercion in remainder",
  }),
  "array-exponentiation-coercion": expressionSpec({
    key: "array-exponentiation-coercion",
    family: "coercion",
    patchStatement: "Array.prototype.valueOf = () => 777;",
    numericExpression: "[] ** 1",
    patchedValue: 777,
    fallbackValue: 0,
    description: "array numeric coercion in exponentiation",
  }),
  "array-bitwise-or-coercion": expressionSpec({
    key: "array-bitwise-or-coercion",
    family: "coercion",
    patchStatement: "Array.prototype.valueOf = () => 777;",
    numericExpression: "[] | 0",
    patchedValue: 777,
    fallbackValue: 0,
    description: "array numeric coercion in bitwise OR",
  }),
  "array-bitwise-and-coercion": expressionSpec({
    key: "array-bitwise-and-coercion",
    family: "coercion",
    patchStatement: "Array.prototype.valueOf = () => 777;",
    numericExpression: "[] & 1023",
    patchedValue: 777,
    fallbackValue: 0,
    description: "array numeric coercion in bitwise AND",
  }),
  "array-bitwise-xor-coercion": expressionSpec({
    key: "array-bitwise-xor-coercion",
    family: "coercion",
    patchStatement: "Array.prototype.valueOf = () => 777;",
    numericExpression: "[] ^ 0",
    patchedValue: 777,
    fallbackValue: 0,
    description: "array numeric coercion in bitwise XOR",
  }),
  "array-shift-left-coercion": expressionSpec({
    key: "array-shift-left-coercion",
    family: "coercion",
    patchStatement: "Array.prototype.valueOf = () => 777;",
    numericExpression: "[] << 0",
    patchedValue: 777,
    fallbackValue: 0,
    description: "array numeric coercion in left shift",
  }),
  "array-shift-right-coercion": expressionSpec({
    key: "array-shift-right-coercion",
    family: "coercion",
    patchStatement: "Array.prototype.valueOf = () => 777;",
    numericExpression: "[] >> 0",
    patchedValue: 777,
    fallbackValue: 0,
    description: "array numeric coercion in signed right shift",
  }),
  "array-unsigned-shift-right-coercion": expressionSpec({
    key: "array-unsigned-shift-right-coercion",
    family: "coercion",
    patchStatement: "Array.prototype.valueOf = () => 777;",
    numericExpression: "[] >>> 0",
    patchedValue: 777,
    fallbackValue: 0,
    description: "array numeric coercion in unsigned right shift",
  }),
  "array-template-coercion": expressionSpec({
    key: "array-template-coercion",
    family: "coercion",
    patchStatement: 'Array.prototype.toString = () => "777";',
    numericExpression: "`${[]}`.length",
    patchedValue: 3,
    fallbackValue: 0,
    description: "array string coercion in a template substitution",
  }),
  "math-abs-array-argument-coercion": expressionSpec({
    key: "math-abs-array-argument-coercion",
    family: "coercion",
    patchStatement: 'Array.prototype.toString = () => "777";',
    numericExpression: "Math.abs([])",
    patchedValue: 777,
    fallbackValue: 0,
    description: "array numeric coercion inside a folded Math.abs argument",
  }),

  "conditional-array-call-effect": effectPreservationSpec(
    "conditional-array-call-effect",
    "math-hypot-call",
    "+([Math.hypot()] ? 1 : 0)",
    1,
    "array truthiness in a conditional whose element call must be preserved",
  ),
  "conditional-object-call-effect": effectPreservationSpec(
    "conditional-object-call-effect",
    "math-hypot-call",
    "+(({ x: Math.hypot() }) ? 1 : 0)",
    1,
    "object truthiness in a conditional whose property call must be preserved",
  ),
  "conditional-class-static-call-effect": effectPreservationSpec(
    "conditional-class-static-call-effect",
    "math-hypot-call",
    "+((class { static x = Math.hypot(); }) ? 1 : 0)",
    1,
    "class truthiness in a conditional whose static-field call must be preserved",
  ),
  "conditional-date-effect": effectPreservationSpec(
    "conditional-date-effect",
    "date-construction",
    "+(new Date() ? 1 : 0)",
    1,
    "Date truthiness in a conditional whose construction must be preserved",
  ),
  "unary-void-array-call-effect": effectPreservationSpec(
    "unary-void-array-call-effect",
    "math-hypot-call",
    "+(void [Math.hypot()] === undefined)",
    1,
    "void evaluation whose discarded array element call must be preserved",
  ),
  "unary-void-object-call-effect": effectPreservationSpec(
    "unary-void-object-call-effect",
    "math-hypot-call",
    "+(void ({ x: Math.hypot() }) === undefined)",
    1,
    "void evaluation whose discarded object property call must be preserved",
  ),
  "unary-void-class-static-call-effect": effectPreservationSpec(
    "unary-void-class-static-call-effect",
    "math-hypot-call",
    "+(void (class { static x = Math.hypot(); }) === undefined)",
    1,
    "void evaluation whose discarded class static-field call must be preserved",
  ),
  "sequence-array-call-effect": effectPreservationSpec(
    "sequence-array-call-effect",
    "math-hypot-call",
    "([Math.hypot()], 1)",
    1,
    "sequence expression whose discarded array element call must be preserved",
  ),
  "sequence-object-call-effect": effectPreservationSpec(
    "sequence-object-call-effect",
    "math-hypot-call",
    "(({ x: Math.hypot() }), 1)",
    1,
    "sequence expression whose discarded object property call must be preserved",
  ),
  "sequence-class-static-call-effect": effectPreservationSpec(
    "sequence-class-static-call-effect",
    "math-hypot-call",
    "((class { static x = Math.hypot(); }), 1)",
    1,
    "sequence expression whose discarded class static-field call must be preserved",
  ),
  "strict-eq-class-static-call-effect": effectPreservationSpec(
    "strict-eq-class-static-call-effect",
    "math-hypot-call",
    "+((class { static x = Math.hypot(); }) === 0)",
    0,
    "strict equality fold whose class static-field call must be preserved",
  ),
  "instanceof-class-static-call-effect": effectPreservationSpec(
    "instanceof-class-static-call-effect",
    "math-hypot-call",
    "+((class { static x = Math.hypot(); }) instanceof Object)",
    1,
    "instanceof fold whose class static-field call must be preserved",
  ),
  "logical-object-and-effect": effectPreservationSpec(
    "logical-object-and-effect",
    "math-hypot-call",
    "(({ x: Math.hypot() }) && 1)",
    1,
    "object truthiness in logical AND whose property call must be preserved",
  ),
  "logical-class-and-effect": effectPreservationSpec(
    "logical-class-and-effect",
    "math-hypot-call",
    "((class { static x = Math.hypot(); }) && 1)",
    1,
    "class truthiness in logical AND whose static-field call must be preserved",
  ),
  "logical-array-or-effect": effectPreservationSpec(
    "logical-array-or-effect",
    "math-hypot-call",
    "([Math.hypot()] || 1).length",
    1,
    "array truthiness in logical OR whose element call must be preserved",
  ),
  "logical-date-and-effect": effectPreservationSpec(
    "logical-date-and-effect",
    "date-construction",
    "(new Date() && 1)",
    1,
    "Date truthiness in logical AND whose construction must be preserved",
  ),
  "logical-date-or-effect": effectPreservationSpec(
    "logical-date-or-effect",
    "date-construction",
    "+((new Date() || 1) === 1)",
    0,
    "Date truthiness in logical OR whose construction must be preserved",
  ),

  "number-nan-type-shortcut": expressionSpec({
    key: "number-nan-type-shortcut",
    family: "number-nan-type-shortcut",
    patchStatement: NUMBER_NAN_PATCH,
    numericExpression: "+(Number.NaN === 777)",
    patchedValue: 1,
    fallbackValue: 0,
    description: "strict equality after replacing Number.NaN with a finite number",
  }),

  "minifier-math-pow": expressionSpec({
    key: "minifier-math-pow",
    family: "minifier-transform",
    transformKind: "math-pow",
    patchStatement: "Math.pow = () => 777;",
    numericExpression: "Math.pow(2, 3)",
    patchedValue: 777,
    fallbackValue: 8,
    description: "minifier replacement of a patched Math.pow call",
    requiresMinify: true,
  }),
  "minifier-array-of": expressionSpec({
    key: "minifier-array-of",
    family: "minifier-transform",
    transformKind: "array-of",
    patchStatement: "Array.of = () => ({ length: 777 });",
    numericExpression: "Array.of(1, 2).length",
    patchedValue: 777,
    fallbackValue: 2,
    description: "minifier replacement of a patched Array.of call",
    requiresMinify: true,
  }),
  "minifier-string-concat": expressionSpec({
    key: "minifier-string-concat",
    family: "minifier-transform",
    transformKind: "string-concat",
    patchStatement: 'String.prototype.concat = () => "x".repeat(777);',
    numericExpression: '"a".concat("b").length',
    patchedValue: 777,
    fallbackValue: 2,
    description: "minifier replacement of a patched string concat call",
    requiresMinify: true,
  }),
  "minifier-array-concat": expressionSpec({
    key: "minifier-array-concat",
    family: "minifier-transform",
    transformKind: "array-concat",
    patchStatement: "Array.prototype.concat = () => ({ length: 777 });",
    numericExpression: "[].concat(1, 2).length",
    patchedValue: 777,
    fallbackValue: 2,
    description: "minifier replacement of a patched array concat call",
    requiresMinify: true,
  }),
  "minifier-boolean-call": expressionSpec({
    key: "minifier-boolean-call",
    family: "minifier-transform",
    transformKind: "boolean-call",
    patchStatement: "globalThis.Boolean = () => 777;",
    numericExpression: "+Boolean(0)",
    patchedValue: 777,
    fallbackValue: 0,
    description: "minifier replacement of a patched Boolean call",
    requiresMinify: true,
  }),
  "minifier-number-call": expressionSpec({
    key: "minifier-number-call",
    family: "minifier-transform",
    transformKind: "number-call",
    patchStatement: "globalThis.Number = () => 777;",
    numericExpression: "Number(1)",
    patchedValue: 777,
    fallbackValue: 1,
    description: "minifier replacement of a patched Number call",
    requiresMinify: true,
  }),
  "minifier-string-call": expressionSpec({
    key: "minifier-string-call",
    family: "minifier-transform",
    transformKind: "string-call",
    patchStatement: 'globalThis.String = () => "x".repeat(777);',
    numericExpression: "String(1).length",
    patchedValue: 777,
    fallbackValue: 1,
    description: "minifier replacement of a patched String call",
    requiresMinify: true,
  }),
  "minifier-array-call": expressionSpec({
    key: "minifier-array-call",
    family: "minifier-transform",
    transformKind: "array-call",
    patchStatement: "globalThis.Array = () => ({ length: 777 });",
    numericExpression: "Array().length",
    patchedValue: 777,
    fallbackValue: 0,
    description: "minifier replacement of a patched Array constructor call",
    requiresMinify: true,
  }),
  "minifier-object-call": expressionSpec({
    key: "minifier-object-call",
    family: "minifier-transform",
    transformKind: "object-call",
    patchStatement: "globalThis.Object = () => ({ value: 777 });",
    numericExpression: "+(Object().value ?? 0)",
    patchedValue: 777,
    fallbackValue: 0,
    description: "minifier replacement of a patched Object constructor call",
    requiresMinify: true,
  }),
} as const satisfies Record<string, GlobalReadOptimizerExpressionSpec>);

const COMPUTED_KEY_EXPRESSION_SPECS = computedKeyExpressionSpecs();
const OPTIONAL_RECEIVER_SPECS = optionalReceiverSpecs();
const INSTANCEOF_CONSTRUCTOR_SPECS = instanceofConstructorSpecs();
const PARENTHESIZED_STATIC_RECEIVER_SPECS = parenthesizedStaticReceiverSpecs();
const COMPOUND_RECEIVER_SPECS = compoundReceiverSpecs();
const OPTIONAL_COMPUTED_KEY_SPECS = optionalComputedKeySpecs();
const OPTIONAL_PARENTHESIZED_CALLEE_SPECS = optionalParenthesizedCalleeSpecs();
const ADJACENT_INSTANCEOF_CONSTRUCTOR_SPECS = adjacentInstanceofConstructorSpecs();
const INSTANCEOF_LEFT_EXPRESSION_SPECS = instanceofLeftExpressionSpecs();

type SecondWaveHandAuthoredOptimizerExpressionKind =
  keyof typeof SECOND_WAVE_HAND_AUTHORED_EXPRESSION_SPECS;

export type GlobalReadOptimizerExpressionKind =
  | BaseGlobalReadOptimizerExpressionKind
  | ComputedKeyExpressionOptimizerExpressionKind
  | OptionalReceiverOptimizerExpressionKind
  | InstanceofConstructorOptimizerExpressionKind
  | ParenthesizedStaticReceiverOptimizerExpressionKind
  | CompoundReceiverOptimizerExpressionKind
  | OptionalComputedKeyOptimizerExpressionKind
  | OptionalParenthesizedCalleeOptimizerExpressionKind
  | AdjacentInstanceofConstructorOptimizerExpressionKind
  | InstanceofLeftExpressionOptimizerExpressionKind
  | SecondWaveHandAuthoredOptimizerExpressionKind;

export const GLOBAL_READ_OPTIMIZER_EXPRESSION_SPECS: Readonly<
  Record<GlobalReadOptimizerExpressionKind, GlobalReadOptimizerExpressionSpec>
> = Object.freeze({
  ...BASE_GLOBAL_READ_OPTIMIZER_EXPRESSION_SPECS,
  ...COMPUTED_KEY_EXPRESSION_SPECS,
  ...OPTIONAL_RECEIVER_SPECS,
  ...INSTANCEOF_CONSTRUCTOR_SPECS,
  ...PARENTHESIZED_STATIC_RECEIVER_SPECS,
  ...COMPOUND_RECEIVER_SPECS,
  ...OPTIONAL_COMPUTED_KEY_SPECS,
  ...OPTIONAL_PARENTHESIZED_CALLEE_SPECS,
  ...ADJACENT_INSTANCEOF_CONSTRUCTOR_SPECS,
  ...INSTANCEOF_LEFT_EXPRESSION_SPECS,
  ...SECOND_WAVE_HAND_AUTHORED_EXPRESSION_SPECS,
});

/// Kept as an explicit subset so ordinary-campaign lane allocation can add these cases without
/// remapping the previously fingerprinted 64-key optimizer-expression cycle.
export const COMPUTED_LOCAL_CONST_OPTIMIZER_EXPRESSION_KINDS = Object.freeze([
  "string-to-lower-case-local-const-computed",
  "string-to-upper-case-local-const-computed",
  "string-trim-local-const-computed",
  "string-trim-start-local-const-computed",
  "string-trim-end-local-const-computed",
  "number-to-string-local-const-computed",
  "string-to-string-local-const-computed",
  "boolean-to-string-local-const-computed",
  "bigint-to-string-local-const-computed",
] as const satisfies readonly GlobalReadOptimizerExpressionKind[]);

export const COMPUTED_KEY_EXPRESSION_OPTIMIZER_EXPRESSION_KINDS = Object.freeze(
  Object.keys(COMPUTED_KEY_EXPRESSION_SPECS) as ComputedKeyExpressionOptimizerExpressionKind[],
);

export const OPTIONAL_RECEIVER_OPTIMIZER_EXPRESSION_KINDS = Object.freeze(
  Object.keys(OPTIONAL_RECEIVER_SPECS) as OptionalReceiverOptimizerExpressionKind[],
);

export const INSTANCEOF_CONSTRUCTOR_OPTIMIZER_EXPRESSION_KINDS = Object.freeze(
  Object.keys(INSTANCEOF_CONSTRUCTOR_SPECS) as InstanceofConstructorOptimizerExpressionKind[],
);

export const PARENTHESIZED_STATIC_RECEIVER_OPTIMIZER_EXPRESSION_KINDS = Object.freeze(
  Object.keys(
    PARENTHESIZED_STATIC_RECEIVER_SPECS,
  ) as ParenthesizedStaticReceiverOptimizerExpressionKind[],
);

export const COMPOUND_RECEIVER_OPTIMIZER_EXPRESSION_KINDS = Object.freeze(
  Object.keys(COMPOUND_RECEIVER_SPECS) as CompoundReceiverOptimizerExpressionKind[],
);

export const OPTIONAL_COMPUTED_KEY_OPTIMIZER_EXPRESSION_KINDS = Object.freeze(
  Object.keys(OPTIONAL_COMPUTED_KEY_SPECS) as OptionalComputedKeyOptimizerExpressionKind[],
);

export const OPTIONAL_PARENTHESIZED_CALLEE_OPTIMIZER_EXPRESSION_KINDS = Object.freeze(
  Object.keys(
    OPTIONAL_PARENTHESIZED_CALLEE_SPECS,
  ) as OptionalParenthesizedCalleeOptimizerExpressionKind[],
);

export const ADJACENT_INSTANCEOF_CONSTRUCTOR_OPTIMIZER_EXPRESSION_KINDS = Object.freeze(
  Object.keys(
    ADJACENT_INSTANCEOF_CONSTRUCTOR_SPECS,
  ) as AdjacentInstanceofConstructorOptimizerExpressionKind[],
);

export const INSTANCEOF_LEFT_EXPRESSION_OPTIMIZER_EXPRESSION_KINDS = Object.freeze(
  Object.keys(
    INSTANCEOF_LEFT_EXPRESSION_SPECS,
  ) as InstanceofLeftExpressionOptimizerExpressionKind[],
);

export const SECOND_WAVE_COERCION_OPTIMIZER_EXPRESSION_KINDS = Object.freeze([
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
] as const satisfies readonly GlobalReadOptimizerExpressionKind[]);

export const SECOND_WAVE_EFFECT_PRESERVATION_OPTIMIZER_EXPRESSION_KINDS = Object.freeze([
  "conditional-array-call-effect",
  "conditional-object-call-effect",
  "conditional-class-static-call-effect",
  "conditional-date-effect",
  "unary-void-array-call-effect",
  "unary-void-object-call-effect",
  "unary-void-class-static-call-effect",
  "sequence-array-call-effect",
  "sequence-object-call-effect",
  "sequence-class-static-call-effect",
  "strict-eq-class-static-call-effect",
  "instanceof-class-static-call-effect",
  "logical-object-and-effect",
  "logical-class-and-effect",
  "logical-array-or-effect",
  "logical-date-and-effect",
  "logical-date-or-effect",
] as const satisfies readonly GlobalReadOptimizerExpressionKind[]);

export const NUMBER_NAN_OPTIMIZER_EXPRESSION_KINDS = Object.freeze([
  "number-nan-type-shortcut",
] as const satisfies readonly GlobalReadOptimizerExpressionKind[]);

export const MINIFIER_TRANSFORM_OPTIMIZER_EXPRESSION_KINDS = Object.freeze([
  "minifier-math-pow",
  "minifier-array-of",
  "minifier-string-concat",
  "minifier-array-concat",
  "minifier-boolean-call",
  "minifier-number-call",
  "minifier-string-call",
  "minifier-array-call",
  "minifier-object-call",
] as const satisfies readonly GlobalReadOptimizerExpressionKind[]);

export const EFFECT_PRESERVATION_OPTIMIZER_EXPRESSION_KINDS = Object.freeze([
  "array-computed-length-effect",
  "unary-void-call-effect",
  "sequence-call-effect",
  "not-array-call-effect",
  "typeof-object-call-effect",
  "strict-eq-date-effect",
  "logical-array-and-effect",
  "instanceof-array-call-effect",
  "not-class-static-call-effect",
  "not-date-construction-effect",
  "not-object-call-effect",
  "sequence-date-construction-effect",
  "strict-eq-array-call-effect",
  "strict-eq-object-call-effect",
  "typeof-array-call-effect",
  "typeof-class-static-call-effect",
  "unary-void-date-effect",
] as const satisfies readonly GlobalReadOptimizerExpressionKind[]);

export const GLOBAL_READ_OPTIMIZER_EXPRESSION_KINDS = Object.freeze(
  Object.keys(GLOBAL_READ_OPTIMIZER_EXPRESSION_SPECS) as GlobalReadOptimizerExpressionKind[],
);

export function globalReadOptimizerExpressionSpec(
  kind: GlobalReadOptimizerExpressionKind,
): GlobalReadOptimizerExpressionSpec {
  return GLOBAL_READ_OPTIMIZER_EXPRESSION_SPECS[kind];
}
