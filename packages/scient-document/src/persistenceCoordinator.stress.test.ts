import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DocumentPersistenceCoordinator } from "./persistenceCoordinator.ts";
import { reconcileKeyedLines, type KeyedLinesReconciliation } from "./testing/keyedLines.ts";
import {
  runStressScenario,
  totalStressStats,
  type StressDocumentFormat,
  type StressResult,
} from "./testing/stressHarness.ts";

const LOCAL_KEYS = ["l0", "l1", "l2", "l3"];
const AGENT_KEYS = ["a0", "a1", "a2", "a3"];
const SHARED_KEYS = ["s0", "s1"];
const KEYS = [...LOCAL_KEYS, ...AGENT_KEYS, ...SHARED_KEYS];

function values(source: string): Map<string, string> {
  return new Map(
    source
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
  );
}

function serialize(entries: ReadonlyMap<string, string>): string {
  return KEYS.map((key) => `${key}=${entries.get(key) ?? "0"}\n`).join("");
}

const keyedLines: StressDocumentFormat = {
  initial: serialize(new Map()),
  values,
  owner: (key) => (key.startsWith("s") ? "shared" : key.startsWith("a") ? "agent" : "local"),
  edit: (source, side, random, stamp) => {
    const entries = values(source);
    const own = side === "local" ? LOCAL_KEYS : AGENT_KEYS;
    const key = random() < 0.8 ? own[Math.floor(random() * own.length)]! : SHARED_KEYS[0]!;
    entries.set(key, stamp);
    return { source: serialize(entries), key, value: stamp };
  },
};

describe("DocumentPersistenceCoordinator under randomized interleavings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never silently loses a change or stalls, and settles on the disk bytes", async () => {
    const results: StressResult[] = [];
    for (let seed = 1; seed <= 400; seed += 1) {
      results.push(
        await runStressScenario<KeyedLinesReconciliation>({
          format: keyedLines,
          createCoordinator: (options) =>
            new DocumentPersistenceCoordinator({ ...options, reconcile: reconcileKeyedLines }),
          advanceTime: async (ms) => {
            await vi.advanceTimersByTimeAsync(ms);
          },
          seed,
          steps: 80,
        }),
      );
    }
    expect(results.flatMap((result) => result.violations)).toEqual([]);
    // Every path must be exercised for the checks above to mean anything.
    const total = totalStressStats(results);
    expect(total.runsWithoutChoices).toBeGreaterThan(50);
    expect(total.runsWithoutChoices).toBeLessThan(400);
    expect(total.merges).toBeGreaterThan(200);
    expect(total.mergesWithLocalEdits).toBeGreaterThan(150);
    expect(total.conflicts).toBeGreaterThan(50);
    expect(total.disconnects).toBeGreaterThan(50);
    expect(total.renames).toBeGreaterThan(20);
    expect(total.refusedDuringRename).toBeGreaterThan(20);
    expect(total.bursts).toBeGreaterThan(200);
    expect(total.deferrals).toBeGreaterThan(20);
    expect(total.viewRefusals).toBeGreaterThan(10);
  });
});
