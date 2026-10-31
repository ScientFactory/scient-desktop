import { describe, expect, it, vi } from "vite-plus/test";

import { runToolScan, type ToolScanMessage } from "./ToolDiscovery.ts";
import type { FoundLanguageTool } from "./ToolScan.ts";

const perl: FoundLanguageTool = {
  languageId: "perl",
  name: "perl",
  executable: "/usr/bin/perl",
  identity: "/usr/bin/perl",
  version: null,
  origin: null,
};

/** A scan whose worker is driven by hand, as a real one would answer or stall. */
function harness(stalled: ReadonlyArray<string> = [], blocked = { count: 0 }) {
  const runs: Array<{
    skip: ReadonlyArray<string>;
    send: (message: ToolScanMessage) => void;
    fail: () => void;
    stopped: boolean;
  }> = [];
  const stalls: string[] = [];
  const releases: Array<() => void> = [];
  const result = runToolScan(
    (skip, onMessage, onFailure) => {
      const run = { skip, send: onMessage, fail: onFailure, stopped: false };
      runs.push(run);
      return {
        stop: () => {
          run.stopped = true;
          return new Promise<void>((release) => releases.push(release));
        },
      };
    },
    stalled,
    (source) => stalls.push(source),
    () => undefined,
    blocked,
  );
  return { runs, stalls, result, releases };
}

describe("the scan's deadline", () => {
  it("answers with everything a healthy scan found", async () => {
    const { runs, result } = harness();
    runs[0]!.send({ kind: "start", source: "/usr/bin" });
    runs[0]!.send({ kind: "found", source: "/usr/bin", tools: [perl] });
    runs[0]!.send({ kind: "done" });
    const snapshot = await result;
    expect(snapshot.complete).toBe(true);
    expect(snapshot.tools.get("perl")).toEqual([perl]);
  });

  it("sets a stalled place aside, keeps what was found, and finishes the rest in a new worker", async () => {
    vi.useFakeTimers();
    try {
      const { runs, stalls, result } = harness();
      runs[0]!.send({ kind: "start", source: "/usr/bin" });
      runs[0]!.send({ kind: "found", source: "/usr/bin", tools: [perl] });
      runs[0]!.send({ kind: "start", source: "/mnt/dead" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(stalls).toEqual(["/mnt/dead"]);
      expect(runs[0]!.stopped).toBe(true);
      expect(runs[1]!.skip).toEqual(["/usr/bin", "/mnt/dead"]);
      runs[1]!.send({ kind: "done" });
      const snapshot = await result;
      expect(snapshot.complete).toBe(false);
      expect(snapshot.tools.get("perl")).toEqual([perl]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at a few stuck workers across scans, because each stays until its call returns", async () => {
    vi.useFakeTimers();
    try {
      const blocked = { count: 0 };
      const first = harness([], blocked);
      for (const index of [0, 1, 2]) {
        first.runs[index]!.send({ kind: "start", source: `/mnt/dead${index}` });
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(first.runs).toHaveLength(3);
      expect((await first.result).complete).toBe(false);
      const second = harness([], blocked);
      expect(second.runs).toHaveLength(0);
      expect((await second.result).complete).toBe(false);
      // A worker that finally stops frees its place for the next scan.
      first.releases[0]!();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness([], blocked).runs).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a stopped worker that answers late", async () => {
    vi.useFakeTimers();
    try {
      const { runs, result } = harness();
      runs[0]!.send({ kind: "start", source: "/mnt/slow" });
      await vi.advanceTimersByTimeAsync(1000);
      runs[0]!.send({ kind: "found", source: "/mnt/slow", tools: [perl] });
      runs[1]!.send({ kind: "done" });
      expect((await result).tools.has("perl")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports what it skipped as unfinished, and does not read it again", async () => {
    const { runs, result } = harness(["/mnt/dead"]);
    expect(runs[0]!.skip).toEqual(["/mnt/dead"]);
    runs[0]!.send({ kind: "done" });
    expect((await result).complete).toBe(false);
  });

  it("answers when the worker cannot start", async () => {
    const { runs, result } = harness();
    runs[0]!.fail();
    expect((await result).complete).toBe(false);
  });
});
