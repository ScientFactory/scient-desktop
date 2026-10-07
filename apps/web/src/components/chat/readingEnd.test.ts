import { describe, expect, it } from "vite-plus/test";
import {
  endTransition,
  savedPositionIsAtEnd,
  shouldRevealArrivedPrompt,
} from "./readerScrollPolicy";
import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";
import { boundedAnswerScrollDelta } from "./useBoundedAnswerFollow";

// Viewport 0..600, reading margin at the anchor offset.
const view = { viewportTop: 0, viewportBottom: 600 };

describe("boundedAnswerScrollDelta", () => {
  it("reveals growth only while the prompt keeps room above it", () => {
    expect(
      boundedAnswerScrollDelta({ ...view, promptTextTop: 300, answerTop: 400, answerBottom: 900 }),
    ).toBe(300 - CHAT_TIMELINE_ANCHOR_OFFSET);
    // The prompt at the margin: the growing answer is read, not followed.
    expect(
      boundedAnswerScrollDelta({
        ...view,
        promptTextTop: CHAT_TIMELINE_ANCHOR_OFFSET,
        answerTop: 100,
        answerBottom: 2000,
      }),
    ).toBe(0);
  });

  it("goes past the prompt only to show the first lines of a message pushed below the fold", () => {
    // Traces pushed the latest message to 900: show its first lines, no more.
    const delta = boundedAnswerScrollDelta({
      ...view,
      promptTextTop: CHAT_TIMELINE_ANCHOR_OFFSET,
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
        promptTextTop: -500,
        answerTop: CHAT_TIMELINE_ANCHOR_OFFSET + 10,
        answerBottom: 3000,
      }),
    ).toBe(0);
  });

  it("follows a later prompt's whole response to the end, only until the prompt reaches the top", () => {
    // No answer yet; the conversation's end (a trace) is 150px below its resting place.
    expect(
      boundedAnswerScrollDelta({
        ...view,
        promptTextTop: 300,
        answerTop: null,
        answerBottom: 340,
        endBelow: 150,
      }),
    ).toBe(150);
    expect(
      boundedAnswerScrollDelta({
        ...view,
        promptTextTop: 100,
        answerTop: null,
        answerBottom: 140,
        endBelow: 1500,
      }),
    ).toBe(100 - CHAT_TIMELINE_ANCHOR_OFFSET);
  });

  it("reveals the prompt itself before any answer exists", () => {
    expect(
      boundedAnswerScrollDelta({ ...view, promptTextTop: 500, answerTop: null, answerBottom: 700 }),
    ).toBe(100);
  });
});

describe("shouldRevealArrivedPrompt", () => {
  const previous = { threadKey: "thread", id: "p1", delivered: false };
  const arrived = {
    previous,
    threadKey: "thread",
    latestPromptId: "p2",
    delivered: true,
    readerAtEnd: true,
  };

  it("reveals a queued prompt the server delivered while the reader was at the end", () => {
    expect(shouldRevealArrivedPrompt(arrived)).toBe(true);
  });

  it("reveals a prompt already listed here once V2 reports it delivered from the queue", () => {
    // Sent from this window and shown before its receipt said it was queued.
    expect(shouldRevealArrivedPrompt({ ...arrived, previous: { ...previous, id: "p2" } })).toBe(
      true,
    );
    // Already a delivered prompt: nothing new arrived.
    expect(
      shouldRevealArrivedPrompt({
        ...arrived,
        previous: { ...previous, id: "p2", delivered: true },
      }),
    ).toBe(false);
  });

  it("leaves direct sends, readers away from the end, and thread changes alone", () => {
    // A direct send (from this or another window) is not a queued delivery.
    expect(shouldRevealArrivedPrompt({ ...arrived, delivered: false })).toBe(false);
    expect(shouldRevealArrivedPrompt({ ...arrived, readerAtEnd: false })).toBe(false);
    expect(shouldRevealArrivedPrompt({ ...arrived, threadKey: "other" })).toBe(false);
    // Opening a thread, or its first prompt, is not an arrival.
    expect(shouldRevealArrivedPrompt({ ...arrived, previous: null })).toBe(false);
    expect(shouldRevealArrivedPrompt({ ...arrived, previous: { ...previous, id: null } })).toBe(
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
