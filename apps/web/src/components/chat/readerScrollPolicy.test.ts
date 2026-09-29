import { describe, expect, it } from "vite-plus/test";
import { MessageId, TurnId } from "@t3tools/contracts";
import { canApplySendAnchor, readingIdentity, resolveReadingRow } from "./readerScrollPolicy";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

function message(
  id: string,
  turn: string,
  role: "user" | "assistant" = "assistant",
): MessagesTimelineRow {
  return {
    kind: "message",
    id: `message:${id}`,
    createdAt: "2026-09-29T00:00:00Z",
    message: {
      id: MessageId.make(id),
      turnId: TurnId.make(turn),
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
  turnId: "turn-a",
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

  it("never restores a reused working indicator in a later turn", () => {
    const rows: MessagesTimelineRow[] = [
      message("prompt-a", "turn-a", "user"),
      message("answer-a", "turn-a"),
      message("prompt-b", "turn-b", "user"),
      { kind: "working", id: "working-indicator-row", createdAt: null },
    ];
    expect(resolveReadingRow(rows, position, true)).toEqual({ index: 1, exact: false });
    const saved = readingIdentity(rows, 3, "turn-b");
    expect(saved?.rowId).toBe("");
    expect(saved?.turnId).toBe("turn-b");
  });

  it("waits for paged-out content instead of using a stale absolute offset", () => {
    const rows = [message("recent", "turn-z")];
    expect(resolveReadingRow(rows, position, false)).toBeNull();
    expect(resolveReadingRow([message("answer-a", "turn-a"), ...rows], position, false)).toEqual({
      index: 0,
      exact: false,
    });
  });

  it("uses surviving neighbors only after older history has been resolved", () => {
    const rows = [message("prompt-a", "different-turn", "user")];
    expect(resolveReadingRow(rows, position, false)).toBeNull();
    expect(resolveReadingRow(rows, position, true)).toEqual({ index: 0, exact: false });
  });

  it("preserves message identity across optimistic acknowledgement and render-wrapper changes", () => {
    const rows = [message("same", "acknowledged-turn")];
    expect(
      resolveReadingRow(rows, { ...position, rowId: "optimistic", messageId: "same" }, false),
    ).toEqual({ index: 0, exact: true });
  });

  it("isolates restoration across thousands of completed and live turn transitions", () => {
    for (let index = 0; index < 2000; index++) {
      const turnId = `turn-${index}`;
      const rows = [
        message(`answer-${index}`, turnId),
        message("newer", `turn-${index + 1}`),
        { kind: "working" as const, id: "working-indicator-row", createdAt: null },
      ];
      expect(resolveReadingRow(rows, { ...position, turnId }, false)).toEqual({
        index: 0,
        exact: false,
      });
    }
  });
});
