import type { LegendListRef } from "@legendapp/list/react";
import { expect, it, vi } from "vite-plus/test";

import { fakeTimers, render } from "../../../test/render";
import { advanceTestClock } from "../../../test/testClock";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { useBoundedAnswerFollow } from "./useBoundedAnswerFollow";

// Nothing but the follow's own frames may wake it: no resize of the answer and no
// line-by-line reveal (each of those would schedule another follow frame).
vi.mock("~/lib/observeResize", () => ({ observeResize: () => () => {} }));
vi.mock("./useStreamingBlockEntrance", () => ({
  streamingRevealActive: () => false,
  subscribeStreamingReveal: () => () => {},
}));

/** A scrollable viewport whose prompt and answer rows move with its scroll position. */
function timeline() {
  const viewport = document.createElement("div");
  viewport.style.cssText = "height:600px;overflow:auto";
  const content = document.createElement("div");
  content.style.height = "2000px";
  const prompt = document.createElement("div");
  const answer = document.createElement("div");
  content.append(prompt, answer);
  viewport.append(content);
  document.body.append(viewport);
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 720, 600);
  prompt.getBoundingClientRect = () => new DOMRect(0, 400 - viewport.scrollTop, 720, 30);
  answer.getBoundingClientRect = () => new DOMRect(0, 600 - viewport.scrollTop, 720, 200);
  const rows = [
    { id: "prompt", kind: "message", message: { id: "prompt", role: "user", text: "Question" } },
    { id: "answer", kind: "message", message: { id: "answer", role: "assistant", text: "Done." } },
  ] as unknown as MessagesTimelineRow[];
  const state = {
    indexByKey: (key: string) => rows.findIndex((row) => row.id === key),
    elementAtIndex: (index: number) => [prompt, answer][index],
    get scroll() {
      return viewport.scrollTop;
    },
  };
  const list = {
    getScrollableNode: () => viewport,
    getState: () => state,
  } as unknown as LegendListRef;
  return {
    viewport,
    rows,
    listRef: { current: list },
    [Symbol.dispose]() {
      viewport.remove();
    },
  };
}

it("ends a follow that lands on its target, once, with no frames left running", async (context) => {
  // The follow starts in a layout effect, so its frames are fake from the first one.
  using _timers = fakeTimers();
  using dom = timeline();
  const finished = vi.fn();
  function Follow() {
    useBoundedAnswerFollow({
      listRef: dom.listRef,
      rows: dom.rows,
      promptMessageId: "prompt",
      responseSettled: true,
      suspended: false,
      composerInset: 100,
      followResponse: true,
      onFinished: finished,
    });
    return null;
  }
  // A bare hook host: nothing here navigates.
  await using _screen = await render(<Follow />, { router: false });

  for (let frame = 0; frame < 400 && finished.mock.calls.length === 0; frame++)
    await advanceTestClock(context.signal, 16);
  expect(dom.viewport.scrollTop).toBeGreaterThan(300);
  expect(finished).toHaveBeenCalledExactlyOnceWith("prompt");
  // An ended follow schedules nothing more.
  expect(vi.getTimerCount()).toBe(0);
  await advanceTestClock(context.signal, 1_000);
  expect(finished).toHaveBeenCalledOnce();
});
