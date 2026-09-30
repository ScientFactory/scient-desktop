import {
  runStressScenario,
  totalStressStats,
  type StressDocumentFormat,
  type StressResult,
} from "@scientfactory/scient-document/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MarkdownPersistenceCoordinator } from "./persistenceCoordinator.ts";
import type { MarkdownReconciliation } from "./reconciliation.ts";

/**
 * The document-session stress scenarios, run through the real Markdown
 * reconciliation. Tracked units are one-line paragraphs `key · value`, placed
 * between structural blocks that neither side edits; paragraphs are edited,
 * inserted, and deleted. Every published source must keep the untouched
 * blocks byte-for-byte.
 */

const FRONT_MATTER = "---\ntitle: Stress\n---\n\n";
const FIXED_BLOCKS = [
  "# Stress document",
  "- item one\n- item two",
  "```ts\nconst fixed = true;\n```",
  "$$\nE = mc^2\n$$",
  "> A quoted line with a [reference][ref].",
  "[ref]: https://example.com",
];

const INITIAL =
  FRONT_MATTER +
  [
    FIXED_BLOCKS[0],
    "l0 · v0",
    "a0 · v0",
    "s0 · v0",
    "l1 · v0",
    FIXED_BLOCKS[1],
    "a1 · v0",
    "l2 · v0",
    FIXED_BLOCKS[2],
    "s1 · v0",
    "a2 · v0",
    FIXED_BLOCKS[3],
    "l3 · v0",
    FIXED_BLOCKS[4],
    "a3 · v0",
    FIXED_BLOCKS[5],
  ].join("\n\n") +
  "\n";

const UNIT = /^([a-z]+\d+) · (.*)$/u;

function values(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of source.split("\n")) {
    const match = UNIT.exec(line);
    if (match) result.set(match[1]!, match[2]!);
  }
  return result;
}

const owner = (key: string) =>
  key.startsWith("s")
    ? ("shared" as const)
    : key.startsWith("a")
      ? ("agent" as const)
      : ("local" as const);

// Values mix scripts, astral characters, and inline syntax so UTF-16 offsets
// and inline parsing are exercised, while each paragraph stays one line.
function valueFor(stamp: string, random: () => number): string {
  const decorations = ["", " שלום עולם", " 🎉 naïve café", " *emphasis* and `code`", " x_1 + y^2"];
  return stamp + decorations[Math.floor(random() * decorations.length)]!;
}

function unitLine(key: string): RegExp {
  return new RegExp(`^${key} · [^\\n]*$`, "mu");
}

const markdown: StressDocumentFormat = {
  initial: INITIAL,
  values,
  owner,
  edit: (source, side, random, stamp) => {
    const present = [...values(source).keys()];
    const own = present.filter((key) => owner(key) === side);
    const shared = present.filter((key) => owner(key) === "shared");
    const inserted = own.filter((key) => /^[a-z]{2}/u.test(key));
    const roll = random();
    const value = valueFor(stamp, random);
    if (roll < 0.6) {
      const key = own[Math.floor(random() * own.length)];
      if (key === undefined) return null;
      return { source: source.replace(unitLine(key), `${key} · ${value}`), key, value };
    }
    if (roll < 0.75) {
      const key = shared[Math.floor(random() * shared.length)]!;
      return { source: source.replace(unitLine(key), `${key} · ${value}`), key, value };
    }
    if (roll < 0.9 || side === "agent" || inserted.length === 0) {
      const after = own[Math.floor(random() * own.length)];
      if (after === undefined) return null;
      const key = `${side === "local" ? "ln" : "an"}${stamp.slice(1)}`;
      return {
        source: source.replace(unitLine(after), (line) => `${line}\n\n${key} · ${value}`),
        key,
        value,
      };
    }
    const key = inserted[Math.floor(random() * inserted.length)]!;
    return {
      source: source.replace(new RegExp(`\\n\\n${key} · [^\\n]*`, "u"), ""),
      key,
      value: undefined,
    };
  },
  validate: (source) => {
    if (!source.startsWith(FRONT_MATTER)) return "front matter changed";
    if (!source.endsWith("\n") || source.endsWith("\n\n")) return "final newline changed";
    if (source.includes("\n\n\n")) return "blank lines between blocks changed";
    let cursor = 0;
    for (const block of FIXED_BLOCKS) {
      const found = source.indexOf(`\n\n${block}\n`, cursor - 1);
      if (found < 0 || source.indexOf(`\n\n${block}\n`, found + 1) >= 0)
        return `an untouched block changed or moved: ${block.split("\n")[0]}`;
      cursor = found + block.length;
    }
    for (const line of source.split("\n")) {
      if (/^[a-z]+\d+ ·/u.test(line) && !UNIT.test(line)) return `a paragraph was damaged: ${line}`;
    }
    return null;
  },
};

describe("MarkdownPersistenceCoordinator under randomized interleavings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges through Markdown reconciliation without losing a change or an untouched byte", async () => {
    expect(markdown.validate!(INITIAL)).toBeNull();
    const results: StressResult[] = [];
    for (let seed = 1; seed <= 300; seed += 1) {
      results.push(
        await runStressScenario<MarkdownReconciliation>({
          format: markdown,
          createCoordinator: (options) => new MarkdownPersistenceCoordinator(options),
          advanceTime: async (ms) => {
            await vi.advanceTimersByTimeAsync(ms);
          },
          seed,
          steps: 80,
        }),
      );
    }
    expect(results.flatMap((result) => result.violations)).toEqual([]);
    const total = totalStressStats(results);
    expect(total.runsWithoutChoices).toBeGreaterThan(30);
    expect(total.runsWithoutChoices).toBeLessThan(300);
    expect(total.merges).toBeGreaterThan(150);
    expect(total.mergesWithLocalEdits).toBeGreaterThan(150);
    expect(total.disconnects).toBeGreaterThan(50);
    expect(total.refusedDuringRename).toBeGreaterThan(20);
    expect(total.conflicts).toBeGreaterThan(30);
    expect(total.renames).toBeGreaterThan(15);
    expect(total.bursts).toBeGreaterThan(150);
    expect(total.deferrals).toBeGreaterThan(15);
    expect(total.viewRefusals).toBeGreaterThan(10);
  });
});
