import { describe, expect, it } from "vite-plus/test";
import { MessageId, RunId } from "@t3tools/contracts";
import { canApplySendAnchor, readingIdentity, resolveReadingRow } from "./readerScrollPolicy";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

function message(
  id: string,
  run: string,
  role: "user" | "assistant" = "assistant",
): MessagesTimelineRow {
  return {
    kind: "message",
    id: `message:${id}`,
    createdAt: "2026-09-29T00:00:00Z",
    message: {
      id: MessageId.make(id),
      runId: RunId.make(run),
      role,
      text: id,
      createdAt: "2026-09-29T00:00:00Z",
      updatedAt: "2026-09-29T00:00:00Z",
      streaming: false,
    },
    durationStart: "2026-09-29T00:00:00Z",
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  };
}
const position = {
  rowId: "working-indicator-row",
  turnId: "run-a",
  offsetWithinRow: 180,
  scrollOffset: 5200,
  atEnd: false,
  neighborMessageIds: ["prompt-a"],
};

describe("reader-owned scrolling", () => {
  it("invalidates a send placement after manual navigation or a thread switch", () => {
    const intent = {
      atEnd: true,
      threadKey: "a",
      currentThreadKey: "a",
      navigationGeneration: 4,
      currentNavigationGeneration: 4,
    };
    expect(canApplySendAnchor(intent)).toBe(true);
    expect(canApplySendAnchor({ ...intent, currentNavigationGeneration: 5 })).toBe(false);
    expect(canApplySendAnchor({ ...intent, currentThreadKey: "b" })).toBe(false);
    expect(canApplySendAnchor({ ...intent, atEnd: false })).toBe(false);
  });

  it("never restores a reused working indicator in a later run", () => {
    const rows: MessagesTimelineRow[] = [
      message("prompt-a", "run-a", "user"),
      message("answer-a", "run-a"),
      message("prompt-b", "run-b", "user"),
      { kind: "working", id: "working-indicator-row", createdAt: null },
    ];
    expect(resolveReadingRow(rows, position, true)).toEqual({ index: 1, exact: false });
    const saved = readingIdentity(rows, 3, RunId.make("run-b"));
    expect(saved?.rowId).toBe("");
    // `turnId` is the persisted field name; the timeline itself is keyed on runs.
    expect(saved?.turnId).toBe("run-b");
  });

  it("waits for paged-out content instead of using a stale absolute offset", () => {
    const rows = [message("recent", "run-z")];
    expect(resolveReadingRow(rows, position, false)).toBeNull();
    expect(resolveReadingRow([message("answer-a", "run-a"), ...rows], position, false)).toEqual({
      index: 0,
      exact: false,
    });
  });

  it("uses surviving neighbors only after older history has been resolved", () => {
    const rows = [message("prompt-a", "different-run", "user")];
    expect(resolveReadingRow(rows, position, false)).toBeNull();
    expect(resolveReadingRow(rows, position, true)).toEqual({ index: 0, exact: false });
  });

  it("preserves message identity across optimistic acknowledgement and render-wrapper changes", () => {
    const rows = [message("same", "acknowledged-run")];
    expect(
      resolveReadingRow(rows, { ...position, rowId: "optimistic", messageId: "same" }, false),
    ).toEqual({ index: 0, exact: true });
  });

  it("isolates restoration across thousands of completed and live run transitions", () => {
    for (let index = 0; index < 2000; index++) {
      const run = `run-${index}`;
      const rows = [
        message(`answer-${index}`, run),
        message("newer", `run-${index + 1}`),
        { kind: "working" as const, id: "working-indicator-row", createdAt: null },
      ];
      expect(resolveReadingRow(rows, { ...position, turnId: run }, false)).toEqual({
        index: 0,
        exact: false,
      });
    }
  });
});
