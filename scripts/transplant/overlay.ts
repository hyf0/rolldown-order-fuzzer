/// <reference types="node" />

/// Transplant unit 4 — the WITNESS OVERLAY. Plants the fuzzer's known bug-family witnesses onto a
/// transplanted skeleton at structurally-chosen sites, so a green pure-order transplant becomes a case
/// that goes RED on a buggy bundler, shrinks to its minimal core, and returns to GREEN on the fixed one
/// — the same witnesses the random generator plants, riding on a real graph shape.
///
/// - FAMILY A (`overlayFamilyA`): an inferred-pure definer behind a STAR barrel, split-read by two
///   namespace-importing entries (one reads the definer, one the side-effectful sibling). Under strict
///   order a buggy on-demand/wrap-all emits the barrel's init WITHOUT the definer's, so the definer's
///   value folds `undefined` -> NaN -> the event channel rejects it (`bundle-only-crash`). Reds BOTH
///   modes — the family-A fingerprint. The cluster is appended and read through two dedicated entries
///   (the spike-proven shape); when the skeleton has a real star-barrel namespace-imported by >=2
///   consumers, that site's presence is recorded as the structural anchor.
/// - OBJECT IDENTITY (`overlayObjectIdentity`): an object-export definer captured through two paths
///   (direct + barrel-forwarded) and compared for identity in an entry event. A silent double-init (a
///   no-events module run twice, invisible to a numeric oracle) shifts the identity check and is caught.
///
/// Phase markers come free from the schedule. Pure modules stay event-free per the inferred-pure
/// discipline. The overlay is optional per case — a green pure-order transplant is still a useful order
/// test.

import type { EsmModuleModel, ProgramModel } from "../../src/model.ts";
import type { ReducedGraph } from "./reduce.ts";

export interface OverlayResult {
  readonly program: ProgramModel;
  readonly witness: "family-a" | "object-identity";
  readonly clusterModuleIds: readonly string[];
  /// Real star-barrel sites (namespace-imported by >=2 kept consumers) the skeleton offered as anchors.
  readonly realStarBarrelSites: number;
}

function nextBase(program: ProgramModel): number {
  // Skeleton ids are `m<index>`; append the cluster after the highest index so ids stay unique.
  let max = -1;
  for (const module of program.modules) {
    const match = /^m(\d+)$/.exec(module.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/// Append the family-A conjunction (inferred-pure definer / side-effectful sibling / star+named barrel /
/// two split-reading entries) — the empirically-minimal shape that reds both wrap modes.
export function overlayFamilyA(program: ProgramModel, reduced?: ReducedGraph): OverlayResult {
  const base = nextBase(program);
  const def = `m${base}`;
  const sib = `m${base + 1}`;
  const bar = `m${base + 2}`;
  const entryA = `m${base + 3}`;
  const entryB = `m${base + 4}`;
  const vDef = `v${base}`;
  const vSib = `v${base + 1}`;

  const clusterModules: EsmModuleModel[] = [
    // inferred-pure definer: non-inlinable pure value, no events, value-only.
    { id: def, format: "esm", dependencies: [], events: [], inferredPure: true, pureBase: 7 },
    // side-effectful sibling: keeps the barrel a real wrapped chunk; supplies vSib.
    {
      id: sib,
      format: "esm",
      dependencies: [],
      events: [{ module: sib, phase: "evaluate", value: 5 }],
    },
    // barrel: STAR-forwards the definer (load-bearing), NAMED-forwards the sibling.
    {
      id: bar,
      format: "esm",
      dependencies: [
        { kind: "esm-reexport-star", target: def },
        { kind: "esm-reexport-named", target: sib, sourceName: vSib, exportedName: vSib },
      ],
      events: [],
    },
    // entry A reads the DEFINER through the barrel namespace (the value that goes undefined on a bug).
    {
      id: entryA,
      format: "esm",
      dependencies: [
        { kind: "esm-namespace-import", target: bar, localName: "nsA", readMembers: [[vDef]] },
      ],
      events: [
        {
          module: entryA,
          phase: "evaluate",
          value: 1,
          reads: [{ binding: "nsA", memberPath: [vDef] }],
        },
      ],
    },
    // entry B reads the SIBLING through the barrel namespace (the split that triggers on-demand).
    {
      id: entryB,
      format: "esm",
      dependencies: [
        { kind: "esm-namespace-import", target: bar, localName: "nsB", readMembers: [[vSib]] },
      ],
      events: [
        {
          module: entryB,
          phase: "evaluate",
          value: 2,
          reads: [{ binding: "nsB", memberPath: [vSib] }],
        },
      ],
    },
  ];

  const program2: ProgramModel = {
    ...program,
    modules: [...program.modules, ...clusterModules],
    entries: [
      ...program.entries,
      { name: "wA", moduleId: entryA },
      { name: "wB", moduleId: entryB },
    ],
    schedule: [
      ...program.schedule,
      { kind: "import-entry", entry: "wA" },
      { kind: "import-entry", entry: "wB" },
    ],
  };
  return {
    program: program2,
    witness: "family-a",
    clusterModuleIds: [def, sib, bar, entryA, entryB],
    realStarBarrelSites: reduced?.meta.starBarrelSites ?? 0,
  };
}

/// Append an object-identity double-init witness: an object-export definer captured directly and
/// through a barrel, compared for identity in an entry event. Green when the definer runs once (the two
/// captures are one object); red if the bundler silently re-runs it (a late capture is a new object).
export function overlayObjectIdentity(
  program: ProgramModel,
  reduced?: ReducedGraph,
): OverlayResult {
  const base = nextBase(program);
  const def = `m${base}`;
  const bar = `m${base + 1}`;
  const entry = `m${base + 2}`;
  const objName = `o${base}`;

  const clusterModules: EsmModuleModel[] = [
    // object-export definer: a fresh object literal per demanded export, no events.
    { id: def, format: "esm", dependencies: [], events: [], objectExport: true },
    // barrel star-forwards the definer, so the entry can capture it a second way.
    {
      id: bar,
      format: "esm",
      dependencies: [{ kind: "esm-reexport-star", target: def }],
      events: [],
    },
    // entry captures the object DIRECTLY and through the BARREL, compares identity.
    {
      id: entry,
      format: "esm",
      dependencies: [
        {
          kind: "esm-value-import",
          target: def,
          importedName: objName,
          localName: "direct",
          objectRef: true,
        },
        {
          kind: "esm-value-import",
          target: bar,
          importedName: objName,
          localName: "viaBarrel",
          objectRef: true,
        },
      ],
      events: [
        {
          module: entry,
          phase: "evaluate",
          value: 1,
          identityCheck: { leftBinding: "direct", rightBinding: "viaBarrel" },
        },
      ],
    },
  ];

  const program2: ProgramModel = {
    ...program,
    modules: [...program.modules, ...clusterModules],
    entries: [...program.entries, { name: "wObj", moduleId: entry }],
    schedule: [...program.schedule, { kind: "import-entry", entry: "wObj" }],
  };
  return {
    program: program2,
    witness: "object-identity",
    clusterModuleIds: [def, bar, entry],
    realStarBarrelSites: reduced?.meta.starBarrelSites ?? 0,
  };
}
