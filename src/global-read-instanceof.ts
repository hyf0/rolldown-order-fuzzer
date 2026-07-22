/// `instanceof` constant evaluation is a separate expression family from built-in calls. Each typed
/// case patches the selected constructor's own `Symbol.hasInstance`, then observes the same expression
/// numerically. `defineProperty` is required because Function.prototype's inherited method is not
/// writable by ordinary strict-mode assignment.
export interface GlobalReadInstanceofSpec {
  readonly constructorName: "Object" | "Number" | "Boolean" | "String";
  readonly expression: string;
  readonly patchedResult: boolean;
  readonly patchedValue: 0 | 1;
  readonly fallbackValue: 0 | 1;
  readonly description: string;
}

export const GLOBAL_READ_INSTANCEOF_SPECS = Object.freeze({
  "array-instanceof-object": {
    constructorName: "Object",
    expression: "[] instanceof Object",
    patchedResult: false,
    patchedValue: 0,
    fallbackValue: 1,
    description: "[] instanceof Object",
  },
  "number-instanceof-number": {
    constructorName: "Number",
    expression: "1 instanceof Number",
    patchedResult: true,
    patchedValue: 1,
    fallbackValue: 0,
    description: "1 instanceof Number",
  },
  "boolean-instanceof-boolean": {
    constructorName: "Boolean",
    expression: "true instanceof Boolean",
    patchedResult: true,
    patchedValue: 1,
    fallbackValue: 0,
    description: "true instanceof Boolean",
  },
  "string-instanceof-string": {
    constructorName: "String",
    expression: '"x" instanceof String',
    patchedResult: true,
    patchedValue: 1,
    fallbackValue: 0,
    description: '"x" instanceof String',
  },
} as const satisfies Record<string, GlobalReadInstanceofSpec>);

export type GlobalReadInstanceofKind = keyof typeof GLOBAL_READ_INSTANCEOF_SPECS;

export const GLOBAL_READ_INSTANCEOF_KINDS = Object.freeze(
  Object.keys(GLOBAL_READ_INSTANCEOF_SPECS) as GlobalReadInstanceofKind[],
);

export function globalReadInstanceofSpec(kind: GlobalReadInstanceofKind): GlobalReadInstanceofSpec {
  return GLOBAL_READ_INSTANCEOF_SPECS[kind];
}

export function renderGlobalReadInstanceofAssignment(spec: GlobalReadInstanceofSpec): string {
  // Replace the constructor, matching the real optimizer probe, while forwarding ordinary calls and
  // static-property reads to the original. The forwarding keeps the execution runner healthy after a
  // Number/Object/String patch (it legitimately calls Number.isFinite and other constructor statics).
  return `globalThis.${spec.constructorName} = ((original) => { const replacement = function (...args) { return Reflect.apply(original, this, args); }; Object.setPrototypeOf(replacement, original); replacement.prototype = original.prototype; Object.defineProperty(replacement, Symbol.hasInstance, { value: () => ${String(spec.patchedResult)} }); return replacement; })(${spec.constructorName});`;
}

export function renderGlobalReadInstanceofExpression(spec: GlobalReadInstanceofSpec): string {
  return `+(${spec.expression})`;
}
