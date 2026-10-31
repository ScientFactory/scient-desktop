import { describe, expect, it } from "vite-plus/test";
import { MessageId, RunId } from "@t3tools/contracts";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  endTransition,
  savedPositionIsAtEnd,
  shouldFollowArrivedPrompt,
} from "./readerScrollPolicy";
import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";
import {
  boundedAnswerScrollDelta,
  followLimitIndex,
  placeUnmountedRow,
} from "./useBoundedAnswerFollow";

// Viewport 0..600, reading margin at the anchor offset.
const view = { viewportTop: 0, viewportBottom: 600 };

describe("boundedAnswerScrollDelta", () => {
  it("follows the response to its live end while nothing limits it", () => {
    expect(
      boundedAnswerScrollDelta({
        ...view,
        limitTop: null,
        answerTop: null,
        answerBottom: 340,
        endBelow: 1500,
      }),
    ).toBe(1500);
  });

  it("stops once a reading row's start reaches the margin", () => {
    expect(
      boundedAnswerScrollDelta({
        ...view,
        limitTop: 300,
        answerTop: 300,
        answerBottom: 900,
        endBelow: 1500,
      }),
    ).toBe(300 - CHAT_TIMELINE_ANCHOR_OFFSET);
    // At the margin: the growing answer is read, not followed.
    expect(
      boundedAnswerScrollDelta({
        ...view,
        limitTop: CHAT_TIMELINE_ANCHOR_OFFSET,
        answerTop: CHAT_TIMELINE_ANCHOR_OFFSET,
        answerBottom: 2000,
        endBelow: 1400,
      }),
    ).toBe(0);
  });

  it("goes past the limit only to show the first lines of a message pushed below the fold", () => {
    // Traces pushed the latest message to 900: show its first lines, no more.
    const delta = boundedAnswerScrollDelta({
      ...view,
      limitTop: CHAT_TIMELINE_ANCHOR_OFFSET,
      answerTop: 900,
      answerBottom: 2000,
    });
    expect(delta).toBeGreaterThan(300);
    expect(900 - delta + 48).toBeLessThanOrEqual(600);
    expect(900 - delta).toBeGreaterThan(CHAT_TIMELINE_ANCHOR_OFFSET);
  });

  it("never scrolls a message above the reading margin", () => {
    expect(
      boundedAnswerScrollDelta({
        ...view,
        limitTop: -500,
        answerTop: CHAT_TIMELINE_ANCHOR_OFFSET + 10,
        answerBottom: 3000,
      }),
    ).toBe(0);
  });
});

describe("followLimitIndex", () => {
  const at = "2026-10-29T00:00:00Z";
  const message = (
    id: string,
    role: "user" | "assistant",
    text: string,
    streaming = false,
  ): MessagesTimelineRow => ({
    kind: "message",
    id,
    createdAt: at,
    message: {
      id: MessageId.make(id),
      runId: RunId.make("run"),
      role,
      text,
      createdAt: at,
      updatedAt: at,
      streaming,
    },
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  });
  const work = (id: string, expanded: boolean): MessagesTimelineRow => ({
    kind: "work-toggle",
    id,
    createdAt: at,
    groupId: id,
    hiddenCount: 3,
    expanded,
    summary: "Ran 3 commands",
    summaryKind: "command",
    hasFailure: false,
  });
  const answer = `## Result\n\n${"A real answer. ".repeat(30)}`;
  const limit = (rows: MessagesTimelineRow[], passed: string[] = []) =>
    rows[followLimitIndex(rows, 0, rows.length - 1, new Set(passed))]?.id ?? null;

  it("passes work, thinking and finished short notes; stops at what the reader reads", () => {
    const prompt = message("prompt", "user", "Check the logs");
    // Work and progress notes are watched, not read.
    expect(
      limit([prompt, work("tools", false), message("note", "assistant", "Checking the logs.")]),
    ).toBeNull();
    // A note still arriving, a real answer, and work the reader opened are read.
    expect(limit([prompt, work("tools", false), message("live", "assistant", "Che", true)])).toBe(
      "live",
    );
    expect(
      limit([prompt, message("note", "assistant", "Ok."), message("answer", "assistant", answer)]),
    ).toBe("answer");
    expect(limit([prompt, work("opened", true), message("note", "assistant", "Ok.")])).toBe(
      "opened",
    );
  });

  it("lets the reader's scrolling past a finished answer release it, but never a streaming one", () => {
    const prompt = message("prompt", "user", "Check the logs");
    const rows = [prompt, message("answer", "assistant", answer), work("tools", false)];
    expect(limit(rows, ["answer"])).toBeNull();
    const streaming = [prompt, message("answer", "assistant", answer, true)];
    expect(limit(streaming, ["answer"])).toBe("answer");
  });
});

describe("shouldFollowArrivedPrompt", () => {
  const previous = { threadKey: "thread", id: "p1", delivered: false };
  const arrived = {
    previous,
    threadKey: "thread",
    latestPromptId: "p2",
    delivered: false,
    readerAtEnd: true,
  };

  it("follows a new prompt from anywhere while the reader is at the end", () => {
    expect(shouldFollowArrivedPrompt(arrived)).toBe(true);
    expect(shouldFollowArrivedPrompt({ ...arrived, delivered: true })).toBe(true);
  });

  it("follows a prompt already listed here once V2 reports it delivered from the queue", () => {
    // Sent from this window and shown before its receipt said it was queued.
    const listed = { ...arrived, previous: { ...previous, id: "p2" } };
    expect(shouldFollowArrivedPrompt({ ...listed, delivered: true })).toBe(true);
    // Nothing new arrived.
    expect(shouldFollowArrivedPrompt(listed)).toBe(false);
    expect(
      shouldFollowArrivedPrompt({
        ...listed,
        delivered: true,
        previous: { ...previous, id: "p2", delivered: true },
      }),
    ).toBe(false);
  });

  it("leaves readers away from the end, thread changes and a thread's first listing alone", () => {
    expect(shouldFollowArrivedPrompt({ ...arrived, readerAtEnd: false })).toBe(false);
    expect(shouldFollowArrivedPrompt({ ...arrived, threadKey: "other" })).toBe(false);
    expect(shouldFollowArrivedPrompt({ ...arrived, previous: null })).toBe(false);
    expect(shouldFollowArrivedPrompt({ ...arrived, previous: { ...previous, id: null } })).toBe(
      false,
    );
  });
});

describe("end control transitions", () => {
  it("reacts only when the reader crosses the end", () => {
    expect(endTransition(true, true)).toBeNull();
    expect(endTransition(false, false)).toBeNull();
    expect(endTransition(true, false)).toBe("left");
    expect(endTransition(false, true)).toBe("reached");
  });

  it("starts a thread returned to mid-history away from the end", () => {
    expect(savedPositionIsAtEnd({ atEnd: false })).toBe(false);
    expect(savedPositionIsAtEnd({ atEnd: true })).toBe(true);
    expect(savedPositionIsAtEnd(null)).toBe(true);
  });
});

describe("placeUnmountedRow", () => {
  // Rows 0..2 measured far below the rendered window; row 3 never rendered.
  const positions = [0, 9000, 18000];
  const sizes = [9000, 9000, 9000];
  const state = {
    scroll: 1000,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };

  it("places a row outside the rendered window from its measured position", () => {
    expect(placeUnmountedRow(state, 2, 50)).toEqual({ top: 17050, bottom: 26050 });
  });

  it("places a row never rendered right after the row before it, at the estimated size", () => {
    const placed = placeUnmountedRow(state, 3, 50);
    expect(placed?.top).toBe(26050);
    expect(placed!.bottom).toBeGreaterThan(placed!.top);
    // Nothing known about it or the row before it: it cannot be placed yet.
    expect(placeUnmountedRow(state, 5, 50)).toBeNull();
  });
});
