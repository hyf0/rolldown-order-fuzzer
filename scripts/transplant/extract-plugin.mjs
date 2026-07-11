// Production extractor (transplant unit 1): a rolldown/Vite build-time plugin that dumps a real
// app's order-relevant module-graph skeleton during ONE ordinary build.
//
// The CORE graph facts come from `ModuleInfo` (faithful, no inference): module set, per-module input
// format, static + dynamic import edges, reverse edges, export-name lists, entry flags, plus the real
// chunk composition from `OutputChunk`. On TOP of that the plugin adds two inferences the feasibility
// spike flagged as needed for a production extractor:
//
//   1. edge-precise import KIND / export SHAPE (named / default / namespace / side-effect;
//      reexport-star / reexport-named / reexport-namespace) via the plugin context's own AST parser
//      (`this.parse`, the Rollup/Rolldown-standard API — NOT a regex scanner), correlated to the
//      resolved `importedIds` through `this.resolve`. A parse or resolve failure degrades gracefully
//      to a module-granularity regex classification, and the plugin NEVER throws (a classification
//      failure must never break the app's build).
//   2. the package BOUNDARY from the id path (`node_modules/<pkg>` or pnpm `.pnpm/<pkg>@<ver>`), plus
//      that package's `sideEffects` metadata read once per package from its `package.json` — the two
//      facts rolldown-vite does not surface per `ModuleInfo`.
//
// Output: one stable graph JSON per app at `SKELETON_OUT`.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const OUT = process.env.SKELETON_OUT || "/tmp/skeleton-graph.json";
const APP = process.env.SKELETON_APP || "app";

// Per-id AST classification collected in `transform` (the transformed source is discarded at once).
// Each entry: { statements: [{ source, kind, names? }], localExports: [name], parsed: boolean }.
const classified = new Map();

// -----------------------------------------------------------------------------------------------
// AST classification (this.parse). Walks only TOP-LEVEL import/export statements. `kind` is one of
// named | default | namespace | side-effect | reexport-named | reexport-star | reexport-namespace.
// -----------------------------------------------------------------------------------------------
function classifyAst(parse, code) {
  const statements = [];
  const localExports = [];
  const program = parse(code); // ESTree Program; throws on non-JS — caller falls back.
  for (const node of program.body ?? []) {
    if (node.type === "ImportDeclaration") {
      const source = node.source?.value;
      if (typeof source !== "string") continue;
      const specifiers = node.specifiers ?? [];
      if (specifiers.length === 0) {
        statements.push({ source, kind: "side-effect" });
        continue;
      }
      for (const spec of specifiers) {
        if (spec.type === "ImportDefaultSpecifier") statements.push({ source, kind: "default" });
        else if (spec.type === "ImportNamespaceSpecifier")
          statements.push({ source, kind: "namespace" });
        else
          statements.push({ source, kind: "named", name: spec.imported?.name ?? spec.local?.name });
      }
    } else if (node.type === "ExportAllDeclaration") {
      const source = node.source?.value;
      if (typeof source !== "string") continue;
      if (node.exported) {
        statements.push({
          source,
          kind: "reexport-namespace",
          exportedName: nameOf(node.exported),
        });
      } else {
        statements.push({ source, kind: "reexport-star" });
      }
    } else if (node.type === "ExportNamedDeclaration") {
      const source = node.source?.value;
      if (typeof source === "string") {
        const names = {};
        for (const spec of node.specifiers ?? []) {
          const local = nameOf(spec.local);
          const exported = nameOf(spec.exported);
          if (local && exported) names[local] = exported;
        }
        statements.push({ source, kind: "reexport-named", names });
      } else {
        // export { a, b };  /  export const/function/class X ...  -> local export names
        if (node.declaration) {
          for (const name of declaredNames(node.declaration)) localExports.push(name);
        }
        for (const spec of node.specifiers ?? []) {
          const exported = nameOf(spec.exported);
          if (exported) localExports.push(exported);
        }
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      localExports.push("default");
    }
  }
  return { statements, localExports, parsed: true };
}

function nameOf(node) {
  if (!node) return undefined;
  return node.type === "Literal" ? node.value : node.name;
}

function declaredNames(decl) {
  const names = [];
  if (decl.type === "VariableDeclaration") {
    for (const d of decl.declarations ?? []) {
      if (d.id?.type === "Identifier") names.push(d.id.name);
    }
  } else if (decl.id?.type === "Identifier") {
    names.push(decl.id.name); // function / class
  }
  return names;
}

// Fallback: a crude regex statement scanner (the spike's approach), module-granularity only.
function classifyRegex(code) {
  const statements = [];
  const localExports = [];
  const src = String(code);
  for (const m of src.matchAll(/export\s+\*\s+as\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]/g))
    statements.push({ source: m[2], kind: "reexport-namespace", exportedName: m[1] });
  for (const m of src.matchAll(/export\s+\*\s+from\s*['"]([^'"]+)['"]/g))
    statements.push({ source: m[1], kind: "reexport-star" });
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = {};
    for (const part of m[1].split(",")) {
      const bits = part.trim().split(/\s+as\s+/);
      const local = bits[0]?.trim();
      const exported = (bits[1] ?? bits[0])?.trim();
      if (local && exported) names[local] = exported;
    }
    statements.push({ source: m[2], kind: "reexport-named", names });
  }
  for (const m of src.matchAll(/import\s+\*\s+as\s+[\w$]+\s+from\s*['"]([^'"]+)['"]/g))
    statements.push({ source: m[1], kind: "namespace" });
  for (const m of src.matchAll(/import\s+[\w$]+\s*,\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/g))
    statements.push({ source: m[1], kind: "default" }, { source: m[1], kind: "named" });
  for (const m of src.matchAll(/import\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/g))
    statements.push({ source: m[1], kind: "named" });
  for (const m of src.matchAll(/import\s+[\w$]+\s+from\s*['"]([^'"]+)['"]/g))
    statements.push({ source: m[1], kind: "default" });
  for (const m of src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g))
    statements.push({ source: m[1], kind: "side-effect" });
  return { statements, localExports, parsed: false };
}

// -----------------------------------------------------------------------------------------------
// Package boundary + sideEffects (id-path inference + one package.json read per package).
// -----------------------------------------------------------------------------------------------
const PNPM =
  /[\\/]node_modules[\\/]\.pnpm[\\/](.+?)[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/;
const PLAIN = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/;
const pkgSideEffectsCache = new Map(); // packageName -> sideEffects value | null

function packageOf(id) {
  const pnpm = PNPM.exec(id);
  if (pnpm) return { name: pnpm[2].replaceAll("\\", "/"), version: versionFromPnpm(pnpm[1]) };
  const plain = PLAIN.exec(id);
  if (plain) return { name: plain[1].replaceAll("\\", "/"), version: null };
  return null;
}

function versionFromPnpm(segment) {
  // ".pnpm/lucide-react@1.8.0_react@19.2.7" -> "1.8.0"; scoped "@griffel+core@1.21.2" -> "1.21.2".
  const at = segment.lastIndexOf("@");
  if (at <= 0) return null;
  const rest = segment.slice(at + 1);
  return rest.split("_")[0] ?? null;
}

function packageJsonSideEffects(id, pkgName) {
  if (pkgSideEffectsCache.has(pkgName)) return pkgSideEffectsCache.get(pkgName);
  let value = null;
  // Walk up from the module id to the nearest node_modules/<pkg>/package.json.
  const marker = `node_modules${id.includes("/") ? "/" : "\\"}`;
  const idx = id.lastIndexOf(pkgName.split("/")[0]);
  try {
    // Reconstruct the package root: everything up to and including the package-name segment.
    const nameSeg = `node_modules/${pkgName}`.replaceAll("/", id.includes("/") ? "/" : "\\");
    const rootEnd = id.indexOf(nameSeg);
    if (rootEnd >= 0) {
      const root = id.slice(0, rootEnd + nameSeg.length);
      const pkgJson = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
      value = pkgJson.sideEffects ?? null;
    }
  } catch {
    value = null;
  }
  void marker;
  void idx;
  pkgSideEffectsCache.set(pkgName, value);
  return value;
}

// -----------------------------------------------------------------------------------------------
// Plugin
// -----------------------------------------------------------------------------------------------
export function skeletonExtractPlugin() {
  let astOk = 0;
  let astFail = 0;
  return {
    name: "skeleton-extract",
    enforce: "post",
    transform(code, id) {
      try {
        if (typeof code !== "string" || classified.has(id)) return null;
        let rec;
        try {
          rec = classifyAst((c) => this.parse(c), code);
          astOk += 1;
        } catch {
          rec = classifyRegex(code);
          astFail += 1;
        }
        classified.set(id, rec);
      } catch {
        /* never break the build */
      }
      return null;
    },
    async buildEnd() {
      try {
        const ids = Array.from(this.getModuleIds());
        const modules = [];
        let resolveOk = 0;
        let resolveFail = 0;
        for (const id of ids) {
          let info;
          try {
            info = this.getModuleInfo(id);
          } catch {
            info = null;
          }
          if (!info) continue;
          const cls = classified.get(id) ?? null;
          const importedIds = info.importedIds ?? [];
          const importedSet = new Set(importedIds);
          const pkg = packageOf(id);
          const pkgSideEffects = pkg ? packageJsonSideEffects(id, pkg.name) : null;

          // Edge-precise classification: resolve each classified statement's source to an id and
          // attach its kind to that edge. Re-export targets are recorded separately (they are the
          // star/named/namespace forwarding the reducer + #10044 need).
          const edgeKinds = {};
          const starReexportTargets = [];
          const nsReexports = [];
          const namedReexports = [];
          if (cls && cls.statements.length > 0) {
            for (const st of cls.statements) {
              let targetId;
              try {
                const resolved = await this.resolve(st.source, id, { skipSelf: true });
                targetId = resolved?.id;
                if (targetId) resolveOk += 1;
              } catch {
                targetId = undefined;
              }
              if (!targetId || !importedSet.has(targetId)) {
                if (targetId === undefined) resolveFail += 1;
                continue;
              }
              (edgeKinds[targetId] ??= []).push(st.kind);
              if (st.kind === "reexport-star") starReexportTargets.push(targetId);
              else if (st.kind === "reexport-namespace")
                nsReexports.push({ target: targetId, exportedName: st.exportedName });
              else if (st.kind === "reexport-named")
                namedReexports.push({ target: targetId, names: st.names ?? {} });
            }
          }

          modules.push({
            id,
            isEntry: !!info.isEntry,
            format: info.inputFormat ?? null,
            exports: info.exports ?? [],
            localExports: cls?.localExports ?? [],
            moduleSideEffects: info.moduleSideEffects ?? null,
            pkg,
            pkgSideEffects,
            importedIds,
            dynamicallyImportedIds: info.dynamicallyImportedIds ?? [],
            importers: info.importers ?? [],
            dynamicImporters: info.dynamicImporters ?? [],
            edgeKinds,
            starReexportTargets,
            nsReexports,
            namedReexports,
            classifiedBy: cls ? (cls.parsed ? "ast" : "regex") : "none",
          });
        }
        this.__skeletonModules = modules;
        globalThis.__SKELETON_MODULES__ = modules;
        globalThis.__SKELETON_STATS__ = { astOk, astFail, resolveOk, resolveFail };
      } catch (e) {
        try {
          writeFileSync(`${OUT}.buildEndError.txt`, String((e && e.stack) || e));
        } catch {
          /* ignore */
        }
      }
    },
    generateBundle(_options, bundle) {
      try {
        const chunks = [];
        for (const [fileName, out] of Object.entries(bundle)) {
          if (!out || out.type !== "chunk") continue;
          const renderedModules = {};
          for (const [mid, rm] of Object.entries(out.modules || {})) {
            renderedModules[mid] = {
              renderedLength: rm?.renderedLength ?? null,
              renderedExports: rm?.renderedExports ?? [],
            };
          }
          chunks.push({
            fileName,
            name: out.name,
            isEntry: !!out.isEntry,
            isDynamicEntry: !!out.isDynamicEntry,
            facadeModuleId: out.facadeModuleId ?? null,
            moduleIds: out.moduleIds ?? [],
            exports: out.exports ?? [],
            imports: out.imports ?? [],
            dynamicImports: out.dynamicImports ?? [],
            renderedModules,
          });
        }
        const modules = this.__skeletonModules || globalThis.__SKELETON_MODULES__ || [];
        const stats = globalThis.__SKELETON_STATS__ || {};
        const payload = {
          meta: {
            app: APP,
            generatedAt: new Date().toISOString(),
            moduleCount: modules.length,
            chunkCount: chunks.length,
            cwd: process.cwd(),
            classification: stats,
          },
          modules,
          chunks,
        };
        mkdirSync(dirname(OUT), { recursive: true });
        writeFileSync(OUT, JSON.stringify(payload));
        // eslint-disable-next-line no-console
        console.log(
          `[skeleton-extract] ${APP}: ${modules.length} modules, ${chunks.length} chunks ` +
            `(ast ${stats.astOk}/${stats.astOk + stats.astFail}) -> ${OUT}`,
        );
      } catch (e) {
        try {
          writeFileSync(`${OUT}.error.txt`, String((e && e.stack) || e));
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export default skeletonExtractPlugin;
