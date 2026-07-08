export const STRICT_EXECUTION_ORDER_ACTION = "StrictExecutionOrderPlanReady" as const;
export const STRICT_EXECUTION_ORDER_TRACE_VERSION = 2 as const;
export const SUPPORTED_STRICT_EXECUTION_ORDER_TRACE_VERSIONS = [1, 2] as const;

const PLAN_REASONS = [
  "direct-violation",
  "sensitive-suffix",
  "static-importer",
  "top-level-reader",
] as const;
const WRAP_KINDS = ["none", "cjs", "esm"] as const;
const WRAPPER_ORIGINS = ["none", "interop-cjs", "interop-esm", "execution-order"] as const;
const ENTRY_TRIGGERS = ["none", "cjs-require", "interop-init", "order-init"] as const;
const INIT_OBLIGATION_KINDS = ["direct-import", "transitive-init-target"] as const;
const UINT32_MAX = 0xffff_ffff;

export interface StrictExecutionOrderRoot {
  readonly root_module_id: string;
  readonly expected_order: readonly string[];
  readonly predicted_pre_wrap_order: readonly string[];
  readonly at_risk_modules: readonly string[];
}

export interface StrictExecutionOrderPlanModule {
  readonly module_id: string;
  readonly reasons: readonly (typeof PLAN_REASONS)[number][];
}

export interface StrictExecutionOrderModule {
  readonly module_id: string;
  readonly interop_wrap_kind: (typeof WRAP_KINDS)[number];
  readonly order_wrapped: boolean;
  readonly wrapper_origin: (typeof WRAPPER_ORIGINS)[number];
  readonly entry_trigger: (typeof ENTRY_TRIGGERS)[number];
  readonly final_chunk_id: number | null;
  readonly entry_chunk_id: number | null;
  readonly wrapper_included: boolean;
  readonly tla_tainted: boolean;
}

export interface StrictExecutionOrderChunk {
  readonly chunk_id: number;
  readonly module_ids: readonly string[];
  readonly static_chunk_imports: readonly number[];
  readonly dynamic_chunk_imports: readonly number[];
}

export interface StrictExecutionOrderInitObligation {
  readonly kind: (typeof INIT_OBLIGATION_KINDS)[number];
  readonly importer_id: string;
  readonly importee_id: string;
  readonly awaited: boolean;
  readonly importer_tla_tainted: boolean;
  readonly importee_tla_tainted: boolean;
}

export interface StrictExecutionOrderPlanReady {
  readonly action: typeof STRICT_EXECUTION_ORDER_ACTION;
  readonly version: (typeof SUPPORTED_STRICT_EXECUTION_ORDER_TRACE_VERSIONS)[number];
  readonly roots: readonly StrictExecutionOrderRoot[];
  readonly plan_modules: readonly StrictExecutionOrderPlanModule[];
  readonly included_modules: readonly StrictExecutionOrderModule[];
  readonly rendered_chunks: readonly StrictExecutionOrderChunk[];
  readonly init_obligations: readonly StrictExecutionOrderInitObligation[];
}

export interface StrictExecutionOrderEventEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: "static-chunk" | "chunk-module-order" | "init" | "awaited-init" | "entry-trigger";
}

export interface StrictExecutionOrderEventGraph {
  readonly nodes: readonly string[];
  readonly edges: readonly StrictExecutionOrderEventEdge[];
}

export function parseStrictExecutionOrderLogs(
  contents: string,
): StrictExecutionOrderPlanReady | null {
  const matches: StrictExecutionOrderPlanReady[] = [];
  const lines = contents.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new TypeError(
        `Invalid Rolldown devtools JSON on line ${index + 1}: ${errorMessage(error)}`,
      );
    }

    if (isRecord(value) && value.action === STRICT_EXECUTION_ORDER_ACTION) {
      matches.push(parseStrictExecutionOrderPlanReady(value));
    }
  }

  if (matches.length > 1) {
    throw new TypeError(
      `Expected at most one ${STRICT_EXECUTION_ORDER_ACTION} action, found ${matches.length}`,
    );
  }
  return matches[0] ?? null;
}

export function parseStrictExecutionOrderPlanReady(value: unknown): StrictExecutionOrderPlanReady {
  const path = STRICT_EXECUTION_ORDER_ACTION;
  const action = requireRecord(value, path);
  requireLiteral(action.action, STRICT_EXECUTION_ORDER_ACTION, `${path}.action`);
  if (!SUPPORTED_STRICT_EXECUTION_ORDER_TRACE_VERSIONS.includes(action.version as 1 | 2)) {
    throw new TypeError(
      `Unsupported ${STRICT_EXECUTION_ORDER_ACTION} version: ${describeValue(action.version)}`,
    );
  }
  const version = action.version as 1 | 2;

  const roots = requireArray(action.roots, `${path}.roots`).map((root, index) => {
    const itemPath = `${path}.roots[${index}]`;
    const item = requireRecord(root, itemPath);
    requireString(item.root_module_id, `${itemPath}.root_module_id`);
    requireStringArray(item.expected_order, `${itemPath}.expected_order`);
    requireStringArray(item.predicted_pre_wrap_order, `${itemPath}.predicted_pre_wrap_order`);
    requireStringArray(item.at_risk_modules, `${itemPath}.at_risk_modules`);
    return {
      root_module_id: item.root_module_id,
      expected_order: [...item.expected_order],
      predicted_pre_wrap_order: [...item.predicted_pre_wrap_order],
      at_risk_modules: [...item.at_risk_modules],
    };
  });

  const planModules = requireArray(action.plan_modules, `${path}.plan_modules`).map(
    (module, index) => {
      const itemPath = `${path}.plan_modules[${index}]`;
      const item = requireRecord(module, itemPath);
      requireString(item.module_id, `${itemPath}.module_id`);
      requireLiteralArray(item.reasons, PLAN_REASONS, `${itemPath}.reasons`);
      return {
        module_id: item.module_id,
        reasons: [...item.reasons],
      };
    },
  );

  const includedModules = requireArray(action.included_modules, `${path}.included_modules`).map(
    (module, index) => {
      const itemPath = `${path}.included_modules[${index}]`;
      const item = requireRecord(module, itemPath);
      requireString(item.module_id, `${itemPath}.module_id`);
      const normalized =
        version === 1 && "original_wrap_kind" in item
          ? parseVersion1Module(item, itemPath)
          : parseVersion2Module(item, itemPath);
      requireUint32OrNull(item.final_chunk_id, `${itemPath}.final_chunk_id`);
      requireUint32OrNull(item.entry_chunk_id, `${itemPath}.entry_chunk_id`);
      requireBoolean(item.wrapper_included, `${itemPath}.wrapper_included`);
      requireBoolean(item.tla_tainted, `${itemPath}.tla_tainted`);
      return {
        module_id: item.module_id,
        ...normalized,
        final_chunk_id: item.final_chunk_id,
        entry_chunk_id: item.entry_chunk_id,
        wrapper_included: item.wrapper_included,
        tla_tainted: item.tla_tainted,
      };
    },
  );

  const renderedChunks = requireArray(action.rendered_chunks, `${path}.rendered_chunks`).map(
    (chunk, index) => {
      const itemPath = `${path}.rendered_chunks[${index}]`;
      const item = requireRecord(chunk, itemPath);
      requireUint32(item.chunk_id, `${itemPath}.chunk_id`);
      requireStringArray(item.module_ids, `${itemPath}.module_ids`);
      requireUint32Array(item.static_chunk_imports, `${itemPath}.static_chunk_imports`);
      requireUint32Array(item.dynamic_chunk_imports, `${itemPath}.dynamic_chunk_imports`);
      return {
        chunk_id: item.chunk_id,
        module_ids: [...item.module_ids],
        static_chunk_imports: [...item.static_chunk_imports],
        dynamic_chunk_imports: [...item.dynamic_chunk_imports],
      };
    },
  );

  const initObligations = requireArray(action.init_obligations, `${path}.init_obligations`).map(
    (obligation, index) => {
      const itemPath = `${path}.init_obligations[${index}]`;
      const item = requireRecord(obligation, itemPath);
      requireLiteral(item.kind, INIT_OBLIGATION_KINDS, `${itemPath}.kind`);
      requireString(item.importer_id, `${itemPath}.importer_id`);
      requireString(item.importee_id, `${itemPath}.importee_id`);
      requireBoolean(item.awaited, `${itemPath}.awaited`);
      requireBoolean(item.importer_tla_tainted, `${itemPath}.importer_tla_tainted`);
      requireBoolean(item.importee_tla_tainted, `${itemPath}.importee_tla_tainted`);
      return {
        kind: item.kind,
        importer_id: item.importer_id,
        importee_id: item.importee_id,
        awaited: item.awaited,
        importer_tla_tainted: item.importer_tla_tainted,
        importee_tla_tainted: item.importee_tla_tainted,
      };
    },
  );

  return {
    action: STRICT_EXECUTION_ORDER_ACTION,
    version,
    roots,
    plan_modules: planModules,
    included_modules: includedModules,
    rendered_chunks: renderedChunks,
    init_obligations: initObligations,
  };
}

export function canonicalizeStrictExecutionOrderModuleIds(
  action: StrictExecutionOrderPlanReady,
  canonicalizeModuleId: (moduleId: string) => string,
): StrictExecutionOrderPlanReady {
  return {
    action: STRICT_EXECUTION_ORDER_ACTION,
    version: action.version,
    roots: action.roots.map((root) => ({
      root_module_id: canonicalizeModuleId(root.root_module_id),
      expected_order: root.expected_order.map(canonicalizeModuleId),
      predicted_pre_wrap_order: root.predicted_pre_wrap_order.map(canonicalizeModuleId),
      at_risk_modules: root.at_risk_modules.map(canonicalizeModuleId),
    })),
    plan_modules: action.plan_modules.map((module) => ({
      module_id: canonicalizeModuleId(module.module_id),
      reasons: [...module.reasons],
    })),
    included_modules: action.included_modules.map((module) => ({
      module_id: canonicalizeModuleId(module.module_id),
      interop_wrap_kind: module.interop_wrap_kind,
      order_wrapped: module.order_wrapped,
      wrapper_origin: module.wrapper_origin,
      entry_trigger: module.entry_trigger,
      final_chunk_id: module.final_chunk_id,
      entry_chunk_id: module.entry_chunk_id,
      wrapper_included: module.wrapper_included,
      tla_tainted: module.tla_tainted,
    })),
    rendered_chunks: action.rendered_chunks.map((chunk) => ({
      chunk_id: chunk.chunk_id,
      module_ids: chunk.module_ids.map(canonicalizeModuleId),
      static_chunk_imports: [...chunk.static_chunk_imports],
      dynamic_chunk_imports: [...chunk.dynamic_chunk_imports],
    })),
    init_obligations: action.init_obligations.map((obligation) => ({
      kind: obligation.kind,
      importer_id: canonicalizeModuleId(obligation.importer_id),
      importee_id: canonicalizeModuleId(obligation.importee_id),
      awaited: obligation.awaited,
      importer_tla_tainted: obligation.importer_tla_tainted,
      importee_tla_tainted: obligation.importee_tla_tainted,
    })),
  };
}

export function reconstructStrictExecutionOrderEventGraph(
  action: StrictExecutionOrderPlanReady,
): StrictExecutionOrderEventGraph {
  const nodes = new Set<string>();
  const edges: StrictExecutionOrderEventEdge[] = [];
  const addEdge = (edge: StrictExecutionOrderEventEdge) => {
    nodes.add(edge.from);
    nodes.add(edge.to);
    edges.push(edge);
  };

  for (const chunk of action.rendered_chunks) {
    const chunkNode = `chunk:${chunk.chunk_id}`;
    nodes.add(chunkNode);
    for (const dependency of chunk.static_chunk_imports) {
      addEdge({
        from: `chunk:${dependency}`,
        to: chunkNode,
        kind: "static-chunk",
      });
    }
    for (let index = 1; index < chunk.module_ids.length; index += 1) {
      addEdge({
        from: `module:${chunk.module_ids[index - 1]}`,
        to: `module:${chunk.module_ids[index]}`,
        kind: "chunk-module-order",
      });
    }
  }

  for (const obligation of action.init_obligations) {
    addEdge({
      from: `module:${obligation.importee_id}`,
      to: `module:${obligation.importer_id}`,
      kind: obligation.awaited ? "awaited-init" : "init",
    });
  }

  for (const module of action.included_modules) {
    nodes.add(`module:${module.module_id}`);
    if (module.entry_chunk_id !== null && module.entry_trigger !== "none") {
      addEdge({
        from: `module:${module.module_id}`,
        to: `entry:${module.entry_chunk_id}`,
        kind: "entry-trigger",
      });
    }
  }

  edges.sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.kind.localeCompare(right.kind),
  );
  return { nodes: [...nodes].sort(), edges };
}

function parseVersion1Module(
  item: Record<string, unknown>,
  itemPath: string,
): Pick<
  StrictExecutionOrderModule,
  "interop_wrap_kind" | "order_wrapped" | "wrapper_origin" | "entry_trigger"
> {
  requireLiteral(item.original_wrap_kind, WRAP_KINDS, `${itemPath}.original_wrap_kind`);
  requireLiteral(item.final_wrap_kind, WRAP_KINDS, `${itemPath}.final_wrap_kind`);
  requireUint32OrNull(item.entry_chunk_id, `${itemPath}.entry_chunk_id`);
  const orderWrapped = item.original_wrap_kind === "none" && item.final_wrap_kind === "esm";
  const wrapperOrigin =
    item.original_wrap_kind === "cjs"
      ? "interop-cjs"
      : item.original_wrap_kind === "esm"
        ? "interop-esm"
        : orderWrapped
          ? "execution-order"
          : "none";
  const entryTrigger =
    item.entry_chunk_id === null
      ? "none"
      : wrapperOrigin === "interop-cjs"
        ? "cjs-require"
        : wrapperOrigin === "interop-esm"
          ? "interop-init"
          : wrapperOrigin === "execution-order"
            ? "order-init"
            : "none";
  return {
    interop_wrap_kind: item.original_wrap_kind,
    order_wrapped: orderWrapped,
    wrapper_origin: wrapperOrigin,
    entry_trigger: entryTrigger,
  };
}

function parseVersion2Module(
  item: Record<string, unknown>,
  itemPath: string,
): Pick<
  StrictExecutionOrderModule,
  "interop_wrap_kind" | "order_wrapped" | "wrapper_origin" | "entry_trigger"
> {
  requireLiteral(item.interop_wrap_kind, WRAP_KINDS, `${itemPath}.interop_wrap_kind`);
  requireBoolean(item.order_wrapped, `${itemPath}.order_wrapped`);
  requireLiteral(item.wrapper_origin, WRAPPER_ORIGINS, `${itemPath}.wrapper_origin`);
  requireLiteral(item.entry_trigger, ENTRY_TRIGGERS, `${itemPath}.entry_trigger`);
  return {
    interop_wrap_kind: item.interop_wrap_kind,
    order_wrapped: item.order_wrapped,
    wrapper_origin: item.wrapper_origin,
    entry_trigger: item.entry_trigger,
  };
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array`);
  }
  return value;
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${path} must be a string`);
  }
}

function requireBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${path} must be a boolean`);
  }
}

function requireUint32(value: unknown, path: string): asserts value is number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > UINT32_MAX) {
    throw new TypeError(`${path} must be an unsigned 32-bit integer`);
  }
}

function requireUint32OrNull(value: unknown, path: string): asserts value is number | null {
  if (
    value !== null &&
    (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > UINT32_MAX)
  ) {
    throw new TypeError(`${path} must be an unsigned 32-bit integer or null`);
  }
}

function requireStringArray(value: unknown, path: string): asserts value is readonly string[] {
  requireArray(value, path).forEach((item, index) => {
    requireString(item, `${path}[${index}]`);
  });
}

function requireUint32Array(value: unknown, path: string): asserts value is readonly number[] {
  requireArray(value, path).forEach((item, index) => {
    requireUint32(item, `${path}[${index}]`);
  });
}

function requireLiteral<const T extends readonly string[]>(
  value: unknown,
  expected: T[number] | T,
  path: string,
): asserts value is T[number] {
  const expectedValues = typeof expected === "string" ? [expected] : expected;
  if (typeof value !== "string" || !expectedValues.includes(value)) {
    throw new TypeError(
      `${path} must be one of ${expectedValues.map((item) => JSON.stringify(item)).join(", ")}`,
    );
  }
}

function requireLiteralArray<const T extends readonly string[]>(
  value: unknown,
  expected: T,
  path: string,
): asserts value is readonly T[number][] {
  requireArray(value, path).forEach((item, index) => {
    requireLiteral(item, expected, `${path}[${index}]`);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized ?? String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
