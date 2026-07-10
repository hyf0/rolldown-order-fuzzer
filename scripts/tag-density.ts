/// <reference types="node" />

/// Coverage-tag density scan.
///
/// Generates a fixed sweep of random-mixed cases and reports how often each coverage tag fires, as a
/// percentage of cases. Used as an acceptance baseline: a predicate correction (finding 8) moves
/// these numbers legitimately, so capture a baseline before the change and diff after — an unexplained
/// move is a bug, an explained one is the corrected predicate.
///
/// Usage:
///   node scripts/tag-density.ts [count]         # print density table (default 3000 cases)
///   node scripts/tag-density.ts write <path>    # write density JSON to <path>
///   node scripts/tag-density.ts diff <path>     # regenerate and print old->new table vs <path>

import { readFileSync, writeFileSync } from "node:fs";

import { generateCase, sampleCaseSize } from "../src/generate.ts";
import { SeededRng } from "../src/rng.ts";

const SEED_BASE = 5_000_000;
const DEFAULT_COUNT = 3000;

interface Density {
  readonly count: number;
  readonly tags: Readonly<Record<string, number>>;
}

function scan(count: number): Density {
  const counts = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const seed = SEED_BASE + index;
    const size = sampleCaseSize(new SeededRng(seed));
    const generated = generateCase(seed, size, "mixed");
    for (const tag of generated.coverageTags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const tags = Object.fromEntries([...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return { count, tags };
}

function percent(hits: number, count: number): string {
  return `${((hits / count) * 100).toFixed(1)}%`;
}

function printTable(density: Density): void {
  const rows = Object.entries(density.tags).sort((a, b) => b[1] - a[1]);
  for (const [tag, hits] of rows) {
    process.stdout.write(`${percent(hits, density.count).padStart(7)}  ${tag}\n`);
  }
  process.stdout.write(`\n${density.count} random-mixed cases\n`);
}

function main(argv: readonly string[]): number {
  const [command, arg] = argv;

  if (command === "write") {
    if (arg === undefined) {
      process.stderr.write("usage: tag-density.ts write <path>\n");
      return 2;
    }
    const density = scan(DEFAULT_COUNT);
    writeFileSync(arg, `${JSON.stringify(density, null, 2)}\n`);
    process.stderr.write(`wrote density for ${density.count} cases to ${arg}\n`);
    return 0;
  }

  if (command === "diff") {
    if (arg === undefined) {
      process.stderr.write("usage: tag-density.ts diff <path>\n");
      return 2;
    }
    const before = JSON.parse(readFileSync(arg, "utf8")) as Density;
    const after = scan(before.count);
    const allTags = [...new Set([...Object.keys(before.tags), ...Object.keys(after.tags)])].sort();
    process.stdout.write("tag                                        old      new    delta\n");
    for (const tag of allTags) {
      const oldHits = before.tags[tag] ?? 0;
      const newHits = after.tags[tag] ?? 0;
      const delta = newHits - oldHits;
      const marker = delta === 0 ? "" : "  <-- moved";
      process.stdout.write(
        `${tag.padEnd(42)} ${percent(oldHits, before.count).padStart(6)}  ${percent(newHits, after.count).padStart(6)}  ${String(delta).padStart(6)}${marker}\n`,
      );
    }
    return 0;
  }

  const count = command === undefined ? DEFAULT_COUNT : Number(command);
  printTable(scan(count));
  return 0;
}

process.exit(main(process.argv.slice(2)));
