import { describe, expect, it } from "vite-plus/test";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { currentLiveActivityRowId, liveActivitySweepSeconds } from "./liveActivity";

const row = (value: Record<string, unknown>) => value as unknown as MessagesTimelineRow;

describe("currentLiveActivityRowId", () => {
  it("picks the latest live activity row, so only it sweeps", () => {
    const rows = [
      row({ kind: "working", id: "working-indicator-row" }),
      row({ kind: "work-live", id: "earlier-group", active: true }),
      row({ kind: "message", id: "note" }),
      row({ kind: "work-live", id: "current-group", active: true }),
    ];
    expect(currentLiveActivityRowId(rows)).toBe("current-group");
  });

  it("counts Thinking, active compaction and running setup, and nothing settled", () => {
    expect(currentLiveActivityRowId([row({ kind: "thinking", id: "thinking" })])).toBe("thinking");
    expect(
      currentLiveActivityRowId([
        row({ kind: "context-compaction", id: "compaction", active: true }),
      ]),
    ).toBe("compaction");
    expect(
      currentLiveActivityRowId([
        row({ kind: "worktree-setup", id: "setup", snapshot: { phase: "running" } }),
      ]),
    ).toBe("setup");
    expect(
      currentLiveActivityRowId([
        row({ kind: "work-live", id: "settled", active: false }),
        row({ kind: "context-compaction", id: "done", active: false }),
        row({ kind: "worktree-setup", id: "finished", snapshot: { phase: "done" } }),
        row({ kind: "working", id: "working-indicator-row" }),
      ]),
    ).toBeNull();
  });
});

describe("liveActivitySweepSeconds", () => {
  it("keeps one pace for any label length, with a pause between passes", () => {
    const short = liveActivitySweepSeconds(60, 16);
    const long = liveActivitySweepSeconds(300, 16);
    // The light moves at the same speed: the extra time is the extra distance.
    expect(long - short).toBeCloseTo((300 - 60) / 160 / 0.8, 5);
    // A short label: 60px + two 7rem band widths at 160px/s, over 80% of the cycle.
    expect(short).toBeCloseTo((60 + 2 * 112) / 160 / 0.8, 5);
  });
});

describe("currentLiveActivityRowId while compacting or preparing a worktree", () => {
  const working = row({ kind: "working", id: "working-indicator-row" });
  const thinking = row({ kind: "thinking", id: "live-activity-row" });
  it("gives the activity to the header while the Thinking row stands empty", () => {
    expect(currentLiveActivityRowId([working, thinking], true)).toBe("working-indicator-row");
    expect(currentLiveActivityRowId([working, thinking], false)).toBe("live-activity-row");
  });
  it("gives it to the setup or compaction row once that exists", () => {
    const setup = row({ kind: "worktree-setup", id: "setup", snapshot: { phase: "running" } });
    expect(currentLiveActivityRowId([working, setup, thinking], true)).toBe("setup");
  });
});
