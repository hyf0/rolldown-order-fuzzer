/// A closed, typed surface for global/prototype calls whose result can be constant-evaluated by the
/// optimizer. The renderer owns no parallel switch: the assignment target, source call, numeric
/// projection, patched observation, and unpatched observation all come from this one table.
export type GlobalReadBuiltinProjection = "identity" | "boolean-to-number" | "length";

export interface GlobalReadBuiltinSpec {
  /// The writable global or prototype property changed by the patch module.
  readonly assignmentTarget: string;
  /// The unprojected call expression evaluated by the reader module.
  readonly callExpression: string;
  /// Every event value is numeric, so string/boolean results are projected without changing the call.
  readonly projection: GlobalReadBuiltinProjection;
  /// The numeric value observed after the patch. String-returning patches return a string of this length;
  /// boolean-returning patches return the boolean represented by zero/one.
  readonly patchedValue: number;
  /// The projected result of the untouched built-in call, independently checked against JavaScript.
  readonly fallbackValue: number;
  readonly description: string;
}

export const GLOBAL_READ_BUILTIN_SPECS = Object.freeze({
  "math-hypot": {
    assignmentTarget: "Math.hypot",
    callExpression: "Math.hypot(3, 4)",
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 5,
    description: "Math.hypot(3, 4)",
  },
  "math-abs": {
    assignmentTarget: "Math.abs",
    callExpression: "Math.abs(-2)",
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 2,
    description: "Math.abs(-2)",
  },
  "math-ceil": {
    assignmentTarget: "Math.ceil",
    callExpression: "Math.ceil(1.2)",
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 2,
    description: "Math.ceil(1.2)",
  },
  "math-floor": {
    assignmentTarget: "Math.floor",
    callExpression: "Math.floor(1.8)",
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 1,
    description: "Math.floor(1.8)",
  },
  "math-round": {
    assignmentTarget: "Math.round",
    callExpression: "Math.round(1.2)",
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 1,
    description: "Math.round(1.2)",
  },
  "math-fround": {
    assignmentTarget: "Math.fround",
    callExpression: "Math.fround(2)",
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 2,
    description: "Math.fround(2)",
  },
  "math-trunc": {
    assignmentTarget: "Math.trunc",
    callExpression: "Math.trunc(1.8)",
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 1,
    description: "Math.trunc(1.8)",
  },
  "math-sign": {
    assignmentTarget: "Math.sign",
    callExpression: "Math.sign(-2)",
    projection: "identity",
    patchedValue: 777,
    fallbackValue: -1,
    description: "Math.sign(-2)",
  },
  "math-clz32": {
    assignmentTarget: "Math.clz32",
    callExpression: "Math.clz32(1)",
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 31,
    description: "Math.clz32(1)",
  },
  "math-sqrt": {
    assignmentTarget: "Math.sqrt",
    callExpression: "Math.sqrt(4)",
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 2,
    description: "Math.sqrt(4)",
  },
  "math-cbrt": {
    assignmentTarget: "Math.cbrt",
    callExpression: "Math.cbrt(8)",
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 2,
    description: "Math.cbrt(8)",
  },
  "math-imul": {
    assignmentTarget: "Math.imul",
    callExpression: "Math.imul(2, 3)",
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 6,
    description: "Math.imul(2, 3)",
  },
  "math-min": {
    assignmentTarget: "Math.min",
    callExpression: "Math.min(1, 2)",
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 1,
    description: "Math.min(1, 2)",
  },
  "math-max": {
    assignmentTarget: "Math.max",
    callExpression: "Math.max(1, 2)",
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 2,
    description: "Math.max(1, 2)",
  },
  "number-is-finite": {
    assignmentTarget: "Number.isFinite",
    callExpression: "Number.isFinite(1)",
    projection: "boolean-to-number",
    patchedValue: 0,
    fallbackValue: 1,
    description: "Number.isFinite(1)",
  },
  "number-is-nan": {
    assignmentTarget: "Number.isNaN",
    callExpression: "Number.isNaN(1)",
    projection: "boolean-to-number",
    patchedValue: 1,
    fallbackValue: 0,
    description: "Number.isNaN(1)",
  },
  "number-is-integer": {
    assignmentTarget: "Number.isInteger",
    callExpression: "Number.isInteger(1)",
    projection: "boolean-to-number",
    patchedValue: 0,
    fallbackValue: 1,
    description: "Number.isInteger(1)",
  },
  "number-is-safe-integer": {
    assignmentTarget: "Number.isSafeInteger",
    callExpression: "Number.isSafeInteger(1)",
    projection: "boolean-to-number",
    patchedValue: 0,
    fallbackValue: 1,
    description: "Number.isSafeInteger(1)",
  },
  "string-from-char-code-length": {
    assignmentTarget: "String.fromCharCode",
    callExpression: "String.fromCharCode(65)",
    projection: "length",
    patchedValue: 777,
    fallbackValue: 1,
    description: "String.fromCharCode(65).length",
  },
  "global-encode-uri": {
    assignmentTarget: "globalThis.encodeURI",
    callExpression: 'encodeURI("a b")',
    projection: "length",
    patchedValue: 777,
    fallbackValue: 5,
    description: 'encodeURI("a b").length',
  },
  "global-encode-uri-component": {
    assignmentTarget: "globalThis.encodeURIComponent",
    callExpression: 'encodeURIComponent("a b")',
    projection: "length",
    patchedValue: 777,
    fallbackValue: 5,
    description: 'encodeURIComponent("a b").length',
  },
  "global-decode-uri": {
    assignmentTarget: "globalThis.decodeURI",
    callExpression: 'decodeURI("a%20b")',
    projection: "length",
    patchedValue: 777,
    fallbackValue: 3,
    description: 'decodeURI("a%20b").length',
  },
  "global-decode-uri-component": {
    assignmentTarget: "globalThis.decodeURIComponent",
    callExpression: 'decodeURIComponent("a%20b")',
    projection: "length",
    patchedValue: 777,
    fallbackValue: 3,
    description: 'decodeURIComponent("a%20b").length',
  },
  "global-is-nan": {
    assignmentTarget: "globalThis.isNaN",
    callExpression: 'isNaN("x")',
    projection: "boolean-to-number",
    patchedValue: 0,
    fallbackValue: 1,
    description: 'isNaN("x")',
  },
  "global-is-finite": {
    assignmentTarget: "globalThis.isFinite",
    callExpression: "isFinite(1)",
    projection: "boolean-to-number",
    patchedValue: 0,
    fallbackValue: 1,
    description: "isFinite(1)",
  },
  "global-parse-float": {
    assignmentTarget: "globalThis.parseFloat",
    callExpression: 'parseFloat("2")',
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 2,
    description: 'parseFloat("2")',
  },
  "global-parse-int": {
    assignmentTarget: "globalThis.parseInt",
    callExpression: 'parseInt("12", 10)',
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 12,
    description: 'parseInt("12", 10)',
  },
  "string-to-lower-case": {
    assignmentTarget: "String.prototype.toLowerCase",
    callExpression: '"ABC".toLowerCase()',
    projection: "length",
    patchedValue: 777,
    fallbackValue: 3,
    description: '"ABC".toLowerCase().length',
  },
  "string-to-upper-case": {
    assignmentTarget: "String.prototype.toUpperCase",
    callExpression: '"abc".toUpperCase()',
    projection: "length",
    patchedValue: 777,
    fallbackValue: 3,
    description: '"abc".toUpperCase().length',
  },
  "string-trim": {
    assignmentTarget: "String.prototype.trim",
    callExpression: '" a ".trim()',
    projection: "length",
    patchedValue: 777,
    fallbackValue: 1,
    description: '" a ".trim().length',
  },
  "string-trim-start": {
    assignmentTarget: "String.prototype.trimStart",
    callExpression: '" a ".trimStart()',
    projection: "length",
    patchedValue: 777,
    fallbackValue: 2,
    description: '" a ".trimStart().length',
  },
  "string-trim-end": {
    assignmentTarget: "String.prototype.trimEnd",
    callExpression: '" a ".trimEnd()',
    projection: "length",
    patchedValue: 777,
    fallbackValue: 2,
    description: '" a ".trimEnd().length',
  },
  "string-substring": {
    assignmentTarget: "String.prototype.substring",
    callExpression: '"abcd".substring(1, 3)',
    projection: "length",
    patchedValue: 777,
    fallbackValue: 2,
    description: '"abcd".substring(1, 3).length',
  },
  "string-slice": {
    assignmentTarget: "String.prototype.slice",
    callExpression: '"abcd".slice(1, 3)',
    projection: "length",
    patchedValue: 777,
    fallbackValue: 2,
    description: '"abcd".slice(1, 3).length',
  },
  "string-index-of": {
    assignmentTarget: "String.prototype.indexOf",
    callExpression: '"abcd".indexOf("b")',
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 1,
    description: '"abcd".indexOf("b")',
  },
  "string-last-index-of": {
    assignmentTarget: "String.prototype.lastIndexOf",
    callExpression: '"abcb".lastIndexOf("b")',
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 3,
    description: '"abcb".lastIndexOf("b")',
  },
  "string-char-at": {
    assignmentTarget: "String.prototype.charAt",
    callExpression: '"abc".charAt(1)',
    projection: "length",
    patchedValue: 777,
    fallbackValue: 1,
    description: '"abc".charAt(1).length',
  },
  "string-char-code-at": {
    assignmentTarget: "String.prototype.charCodeAt",
    callExpression: '"abc".charCodeAt(1)',
    projection: "identity",
    patchedValue: 777,
    fallbackValue: 98,
    description: '"abc".charCodeAt(1)',
  },
  "string-starts-with": {
    assignmentTarget: "String.prototype.startsWith",
    callExpression: '"abc".startsWith("a")',
    projection: "boolean-to-number",
    patchedValue: 0,
    fallbackValue: 1,
    description: '"abc".startsWith("a")',
  },
  "string-replace": {
    assignmentTarget: "String.prototype.replace",
    callExpression: '"abc".replace("a", "z")',
    projection: "length",
    patchedValue: 777,
    fallbackValue: 3,
    description: '"abc".replace("a", "z").length',
  },
  "string-replace-all": {
    assignmentTarget: "String.prototype.replaceAll",
    callExpression: '"aba".replaceAll("a", "z")',
    projection: "length",
    patchedValue: 777,
    fallbackValue: 3,
    description: '"aba".replaceAll("a", "z").length',
  },
  "string-to-string": {
    assignmentTarget: "String.prototype.toString",
    callExpression: '"abc".toString()',
    projection: "length",
    patchedValue: 777,
    fallbackValue: 3,
    description: '"abc".toString().length',
  },
  "boolean-to-string": {
    assignmentTarget: "Boolean.prototype.toString",
    callExpression: "true.toString()",
    projection: "length",
    patchedValue: 777,
    fallbackValue: 4,
    description: "true.toString().length",
  },
  "bigint-to-string": {
    assignmentTarget: "BigInt.prototype.toString",
    callExpression: "(1n).toString()",
    projection: "length",
    patchedValue: 777,
    fallbackValue: 1,
    description: "(1n).toString().length",
  },
  "regexp-to-string": {
    assignmentTarget: "RegExp.prototype.toString",
    callExpression: "/a/.toString()",
    projection: "length",
    patchedValue: 777,
    fallbackValue: 3,
    description: "/a/.toString().length",
  },
  "number-to-string": {
    assignmentTarget: "Number.prototype.toString",
    callExpression: "(12).toString()",
    projection: "length",
    patchedValue: 777,
    fallbackValue: 2,
    description: "(12).toString().length",
  },
} as const satisfies Record<string, GlobalReadBuiltinSpec>);

export type GlobalReadBuiltinKind = keyof typeof GLOBAL_READ_BUILTIN_SPECS;

export const GLOBAL_READ_BUILTIN_KINDS = Object.freeze(
  Object.keys(GLOBAL_READ_BUILTIN_SPECS) as GlobalReadBuiltinKind[],
);

/// `Math.hypot` is reserved for the array-length call-effect assumption probe. Every other entry is a
/// direct constant-evaluator assumption probe; analyzer syntax cases use the fixture-owned function.
export const OPTIMIZER_GLOBAL_READ_BUILTIN_KINDS = Object.freeze(
  GLOBAL_READ_BUILTIN_KINDS.filter((kind) => kind !== "math-hypot"),
);

export function globalReadBuiltinSpec(kind: GlobalReadBuiltinKind): GlobalReadBuiltinSpec {
  return GLOBAL_READ_BUILTIN_SPECS[kind];
}

export function projectGlobalReadBuiltinCall(spec: GlobalReadBuiltinSpec): string {
  switch (spec.projection) {
    case "identity":
      return spec.callExpression;
    case "boolean-to-number":
      return `+${spec.callExpression}`;
    case "length":
      return `${spec.callExpression}.length`;
  }
}

export function renderGlobalReadBuiltinReplacement(
  spec: GlobalReadBuiltinSpec,
  projectedValue: number,
): string {
  switch (spec.projection) {
    case "identity":
      return String(projectedValue);
    case "boolean-to-number":
      return projectedValue === 0 ? "false" : "true";
    case "length":
      // Keep the replacement's real return type (string) instead of substituting a carrier object. The
      // directed generator bounds this at 777; validation rejects invalid string lengths in artifacts.
      return `"x".repeat(${String(projectedValue)})`;
  }
}
