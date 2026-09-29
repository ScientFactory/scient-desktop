import { describe, expect, it } from "vite-plus/test";
import { shouldRevealArrivedPrompt } from "./readerScrollPolicy";
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

  it("reveals the prompt itself before any answer exists", () => {
    expect(
      boundedAnswerScrollDelta({ ...view, promptTextTop: 500, answerTop: null, answerBottom: 700 }),
    ).toBe(100);
  });
});

describe("shouldRevealArrivedPrompt", () => {
  const previous = { threadKey: "thread", id: "p1" };
  const arrived = {
    previous,
    threadKey: "thread",
    latestPromptId: "p2",
    sentHere: false,
    readerAtEnd: true,
  };

  it("reveals a queued prompt the server delivered while the reader was at the end", () => {
    expect(shouldRevealArrivedPrompt(arrived)).toBe(true);
  });

  it("leaves prompts sent here, readers away from the end, and thread changes alone", () => {
    expect(shouldRevealArrivedPrompt({ ...arrived, sentHere: true })).toBe(false);
    expect(shouldRevealArrivedPrompt({ ...arrived, readerAtEnd: false })).toBe(false);
    expect(shouldRevealArrivedPrompt({ ...arrived, threadKey: "other" })).toBe(false);
    expect(shouldRevealArrivedPrompt({ ...arrived, latestPromptId: "p1" })).toBe(false);
    // Opening a thread, or its first prompt, is not an arrival.
    expect(shouldRevealArrivedPrompt({ ...arrived, previous: null })).toBe(false);
    expect(shouldRevealArrivedPrompt({ ...arrived, previous: { ...previous, id: null } })).toBe(
      false,
    );
  });
});
