import { describe, expect, it } from "vite-plus/test";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  findWorkingRow,
  nextWorkingRowExit,
  withExitingWorkingRow,
  type WorkingRowExitState,
} from "./workingRowExit";

const prompt = { kind: "thinking", id: "prompt" } as unknown as MessagesTimelineRow;
const answer = { kind: "thinking", id: "answer" } as unknown as MessagesTimelineRow;
const working: MessagesTimelineRow = {
  kind: "working",
  id: "working-indicator-row",
  createdAt: null,
};
const runningRows = [prompt, working, answer];
const doneRows = [prompt, answer];
const shown: WorkingRowExitState = {
  threadKey: "t",
  last: findWorkingRow(runningRows),
  exiting: null,
};

describe("working header exit", () => {
  it("keeps a header that left in its place", () => {
    const next = nextWorkingRowExit(shown, { threadKey: "t", current: null, animate: true });
    expect(next.exiting?.afterId).toBe("prompt");
    const rows = withExitingWorkingRow(doneRows, next.exiting);
    expect(rows.map((row) => row.id)).toEqual(["prompt", "working-indicator-row", "answer"]);
    expect(rows[1]).toBe(working);
  });

  it("leaves at once with reduced motion, on a thread change, or when a new header shows", () => {
    expect(
      nextWorkingRowExit(shown, { threadKey: "t", current: null, animate: false }).exiting,
    ).toBeNull();
    const exiting = nextWorkingRowExit(shown, { threadKey: "t", current: null, animate: true });
    // Reduced motion turning on mid-exit ends it too.
    expect(
      nextWorkingRowExit(exiting, { threadKey: "t", current: null, animate: false }).exiting,
    ).toBeNull();
    expect(
      nextWorkingRowExit(exiting, { threadKey: "other", current: null, animate: true }).exiting,
    ).toBeNull();
    expect(
      nextWorkingRowExit(exiting, {
        threadKey: "t",
        current: findWorkingRow(runningRows),
        animate: true,
      }).exiting,
    ).toBeNull();
  });

  it("changes nothing while the same header shows", () => {
    expect(nextWorkingRowExit(shown, { threadKey: "t", current: shown.last, animate: true })).toBe(
      shown,
    );
    expect(withExitingWorkingRow(runningRows, shown.last)).toBe(runningRows);
  });
});
