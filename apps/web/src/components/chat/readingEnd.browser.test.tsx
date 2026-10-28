import {
  fakeTimers,
  act as _fixtureAct,
  render as _fixtureRender,
  type Screen,
} from "../../../test/render";
import { advanceTestClock } from "../../../test/testClock";
import "../../index.css";
import { EnvironmentId, MessageId, RunId, TurnId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";

import { expect, it, vi, type TestContext } from "vite-plus/test";
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import { MessagesTimeline } from "./MessagesTimeline";
import { readerAtReadingEnd, readingEndGapOnScreen, withReadingEnd } from "./readerScrollPolicy";
import { readTimelinePosition, rememberTimelinePosition } from "./timelineScrollAnchoring";

// Real Chromium geometry guards reading-end placement and sent-response reveal across layout
// changes.

const env = EnvironmentId.make("reading-end-tests");
const COMPOSER_INSET = 100;
function message(
  index: number,
  role: "user" | "assistant",
  text: string,
  run = `run-${index}`,
  createdAt = "2026-09-29T00:00:00.000Z",
  streaming = false,
) {
  return {
    kind: "message" as const,
    id: `entry-${index}`,
    createdAt,
    message: {
      id: MessageId.make(`message-${index}`),
      role,
      text,
      runId: RunId.make(run),
      createdAt,
      updatedAt: createdAt,
      streaming,
    },
  };
}
const paragraph = (index: number) => `Message ${index}\n\n${"Readable paragraph. ".repeat(28)}`;
const history = (count: number) =>
  Array.from({ length: count }, (_, i) => message(i, "user", paragraph(i)));

/** Legend's receipt needs scheduled work; waitFor drives the owned clock while it is pending. */
async function scroll(operation: () => Promise<void>) {
  let receipt!: Promise<void>;
  await _fixtureAct(() => {
    receipt = operation();
  });
  await vi.waitFor(() => receipt);
}

async function advanceClock(_fixture: _Fixture, ms = 64) {
  await advanceTestClock(_fixture.signal, ms);
}
async function render(
  _fixture: _Fixture,
  key: string,
  entries: React.ComponentProps<typeof MessagesTimeline>["timelineEntries"],
  extra: Partial<React.ComponentProps<typeof MessagesTimeline>> = {},
) {
  if (!_fixture.host) {
    _fixture.host = document.createElement("div");
    Object.assign(_fixture.host.style, { width: "720px", height: "600px" });
    document.body.append(_fixture.host);
    // No routed controls are exercised in this measured viewport fixture.
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
    _fixture.stack.use(fakeTimers());
  }
  await _fixtureAct(
    async () =>
      await _fixture.root0!.rerender(
        <MessagesTimeline
          emptyPlaceholderInset={0}
          {..._fixture.base}
          routeThreadKey={key}
          timelineEntries={[...entries]}
          {...extra}
        />,
      ),
  );
}
async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}
const node = (_fixture: _Fixture) => _fixture.listRef.current!.getScrollableNode()!;
const gapToListEnd = (_fixture: _Fixture) =>
  node(_fixture).scrollHeight - node(_fixture).clientHeight - node(_fixture).scrollTop;
function rowRect(_fixture: _Fixture, messageId: string) {
  const state = _fixture.listRef.current!.getState();
  const index = state.data.findIndex(
    (row: { kind: string; message?: { id: string } }) =>
      row.kind === "message" && row.message?.id === messageId,
  );
  return state.elementAtIndex(index)?.getBoundingClientRect() ?? null;
}
/** Whether the first lines of a message sit inside the visible area above the composer. */
function firstLinesVisible(_fixture: _Fixture, messageId: string) {
  const rect = rowRect(_fixture, messageId);
  if (!rect) return false;
  const view = node(_fixture).getBoundingClientRect();
  // Its first lines, or all of it when it is shorter than that.
  const firstLinesBottom = Math.min(rect.top + 40, rect.bottom);
  return (
    rect.top >= view.top + 20 &&
    firstLinesBottom <= view.top + node(_fixture).clientHeight - COMPOSER_INSET + 1
  );
}

it("reveals past progress notes to the start of the message the agent is writing", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:notes";
  const entries = history(10);
  await render(_fixture, key, entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  const prompt = message(20, "user", "A new question");
  const running = { isWorking: true, readingFollowPromptId: prompt.message.id };
  const notes = [0, 1, 2, 3, 4].map((i) =>
    message(
      21 + i,
      "assistant",
      `Progress note ${i}. ${"Checking one more file. ".repeat(40)}`,
      "turn-20",
    ),
  );
  let timeline = [...entries, prompt];
  await render(_fixture, key, timeline, running);
  await advanceClock(_fixture, 128);
  for (const note of notes) {
    timeline.push(note);
    await render(_fixture, key, timeline, running);
    await advanceClock(_fixture, 192);
  }
  const latest = notes.at(-1)!.message.id;
  await vi.waitFor(() => {
    expect(firstLinesVisible(_fixture, latest)).toBe(true);
  });
});

it("counts one unread per response, not one per progress note", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:unread";
  const entries = history(15);
  const onUnreadBelowChange = vi.fn();
  await render(_fixture, key, entries, { onUnreadBelowChange });
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToOffset({ offset: 200, animated: false }));
  await advanceClock(_fixture);
  const later = "2026-09-29T01:00:00.000Z";
  let timeline = [...entries, message(40, "user", "Question", "turn-40", later)];
  for (let i = 0; i < 5; i++) {
    timeline.push(
      message(41 + i, "assistant", `Note ${i}. ${"Working. ".repeat(20)}`, "turn-40", later),
    );
    // A running turn keeps its notes as rows (a settled one folds them).
    await render(_fixture, key, timeline, {
      onUnreadBelowChange,
      isWorking: true,
      runningRunId: RunId.make("turn-40"),
    });
    await advanceClock(_fixture, 48);
  }
  await vi.waitFor(() => {
    expect(onUnreadBelowChange.mock.lastCall?.[0]).toBe(1);
  });
});

it("keeps revealing after a click or text selection in the timeline", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:click";
  const entries = history(10);
  await render(_fixture, key, entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  const prompt = message(20, "user", "Question");
  const running = { isWorking: true, readingFollowPromptId: prompt.message.id };
  await render(_fixture, key, [...entries, prompt], running);
  await advanceClock(_fixture, 128);
  node(_fixture).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  // Scrolling down (or trackpad momentum toward the end) is not a cancel either.
  node(_fixture).dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true }));
  const answer = message(21, "assistant", `Answer. ${"Explaining. ".repeat(300)}`, "turn-20");
  await render(_fixture, key, [...entries, prompt, answer], running);
  await vi.waitFor(() => {
    expect(firstLinesVisible(_fixture, answer.message.id)).toBe(true);
  });
});

it("treats the end of the last message's text as the bottom", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:bottom";
  const onIsAtEndChange = vi.fn();
  await render(
    _fixture,
    key,
    [...history(8), message(30, "assistant", `Answer. ${"Text. ".repeat(80)}`)],
    {
      onIsAtEndChange,
    },
  );
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  await advanceClock(_fixture);
  const state = _fixture.listRef.current!.getState();
  const reading = withReadingEnd(state, COMPOSER_INSET)!;
  // Rows after the answer's text (its timestamp and actions) are not reading content.
  const trailing = state.contentLength - reading.contentLength;
  expect(trailing).toBeGreaterThan(0);
  // Scrolled up so the trailing rows plus a little more are hidden: the
  // answer's text is still fully in view, so this is the bottom.
  await scroll(() =>
    _fixture.listRef.current!.scrollToOffset({
      offset: node(_fixture).scrollTop - trailing - 30,
      animated: false,
    }),
  );
  await advanceClock(_fixture);
  expect(
    resolveTimelineIsAtEnd(withReadingEnd(_fixture.listRef.current!.getState(), COMPOSER_INSET)),
  ).toBe(true);
  expect(onIsAtEndChange.mock.lastCall?.[0]).toBe(true);
});

it("opens a thread without a saved position at the end, even when rows grow after the first jump", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:fresh-open";
  const entries = [...history(11), message(11, "assistant", "Short answer.")];
  await render(_fixture, key, entries);
  await advanceClock(_fixture, 48);
  // The last answer grows just after the first jump to the end (late layout).
  await render(_fixture, key, [
    ...entries.slice(0, -1),
    message(11, "assistant", paragraph(11).repeat(4)),
  ]);
  await vi.waitFor(() => {
    expect(gapToListEnd(_fixture)).toBeLessThanOrEqual(1);
  });
});

it("keeps a fresh open at the end when the last answer grows in the frame the open settles", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:fresh-open-settled";
  const positioned: Array<string | null> = [];
  const onPositionedThreadKeyChange = (threadKey: string | null) => {
    positioned.push(threadKey);
  };
  const entries = [...history(11), message(11, "assistant", "Short answer.")];
  await render(_fixture, key, entries, { onPositionedThreadKeyChange });
  for (let frame = 0; frame < 120 && positioned.at(-1) !== key; frame++)
    await advanceClock(_fixture, 16);
  expect(positioned.at(-1)).toBe(key);
  // Late layout right as the open settles, before another frame: the open no
  // longer holds the end, so idle end keeping must already know it rests there.
  await render(
    _fixture,
    key,
    [...entries.slice(0, -1), message(11, "assistant", paragraph(11).repeat(4))],
    { onPositionedThreadKeyChange },
  );
  for (let frame = 0; frame < 60 && gapToListEnd(_fixture) > 1; frame++)
    await advanceClock(_fixture, 16);
  expect(gapToListEnd(_fixture)).toBeLessThanOrEqual(1);
});

it("keeps the end in view while idle, and never moves the reader while the thread works", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:idle";
  const entries = [...history(11), message(11, "assistant", "Short answer.")];
  await render(_fixture, key, entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  await advanceClock(_fixture, 160);
  expect(gapToListEnd(_fixture)).toBeLessThanOrEqual(1);
  // Late layout at the end of an idle thread (a diagram finishing its render).
  await render(_fixture, key, [
    ...entries.slice(0, -1),
    message(11, "assistant", paragraph(11).repeat(3)),
  ]);
  await vi.waitFor(() => {
    expect(gapToListEnd(_fixture)).toBeLessThanOrEqual(1);
  });
  // While the thread works, growth lands below the reader.
  const before = node(_fixture).scrollTop;
  await render(
    _fixture,
    key,
    [...entries.slice(0, -1), message(11, "assistant", paragraph(11).repeat(6))],
    {
      isWorking: true,
    },
  );
  await advanceClock(_fixture, 128);
  expect(Math.abs(node(_fixture).scrollTop - before)).toBeLessThanOrEqual(1);
});

it("stops paging history for a missing saved message after a few pages", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:missing";
  rememberTimelinePosition(key, {
    rowId: "entry-gone",
    messageId: "message-gone",
    turnId: "turn-gone",
    offsetWithinRow: 0,
    scrollOffset: 5000,
    atEnd: false,
  });
  const recent = Array.from({ length: 10 }, (_, i) => message(i + 100, "user", paragraph(i + 100)));
  const load = vi.fn();
  let cursor = 0;
  const loadEarlier = () => ({
    loading: false,
    cursor: `page-${cursor}`,
    onLoadEarlier: () => {
      load();
      cursor += 1;
    },
  });
  await render(_fixture, key, recent, { loadEarlier: loadEarlier() });
  for (let i = 0; i < 6; i++) {
    await advanceClock(_fixture, 64);
    await render(_fixture, key, recent, { loadEarlier: loadEarlier() });
  }
  await advanceClock(_fixture, 128);
  expect(load.mock.calls.length).toBeLessThanOrEqual(2);
  // The reader is placed (at a neighbor or the end) rather than left waiting.
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)?.messageId).not.toBe("message-gone");
  });
});

it("waits for a history page still loading before giving up on the saved message", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:slow-page";
  const saved = message(3, "user", paragraph(3));
  rememberTimelinePosition(key, {
    rowId: saved.id,
    messageId: saved.message.id,
    // The persisted field is still named `turnId`; the timeline is keyed on runs.
    ...(saved.message.runId ? { turnId: saved.message.runId } : {}),
    offsetWithinRow: 0,
    scrollOffset: 5000,
    atEnd: false,
  });
  const recent = Array.from({ length: 10 }, (_, i) => message(i + 40, "user", paragraph(i + 40)));
  const load = vi.fn();
  await render(_fixture, key, recent, {
    loadEarlier: { loading: false, cursor: "page-1", onLoadEarlier: load },
  });
  await vi.waitFor(() => {
    expect(load.mock.calls.length).toBe(1);
  });
  const middle = Array.from({ length: 10 }, (_, i) => message(i + 20, "user", paragraph(i + 20)));
  await render(_fixture, key, [...middle, ...recent], {
    loadEarlier: { loading: false, cursor: "page-2", onLoadEarlier: load },
  });
  await vi.waitFor(() => {
    expect(load.mock.calls.length).toBe(2);
  });
  // The second page is slow: restoration must keep waiting for it.
  await render(_fixture, key, [...middle, ...recent], {
    loadEarlier: { loading: true, cursor: "page-2", onLoadEarlier: load },
  });
  await advanceClock(_fixture, 480);
  const all = [
    ...Array.from({ length: 10 }, (_, i) => message(i, "user", paragraph(i))),
    ...middle,
    ...recent,
  ];
  await render(_fixture, key, all, {
    loadEarlier: { loading: false, cursor: null, onLoadEarlier: load },
  });
  await vi.waitFor(() => {
    expect(
      (() => {
        const rect = rowRect(_fixture, saved.message.id);
        return rect ? Math.abs(rect.top - node(_fixture).getBoundingClientRect().top) : Infinity;
      })(),
    ).toBeLessThanOrEqual(2);
  });
});

it("pins the idle end again once a reveal has finished", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:after-reveal";
  const entries = history(10);
  await render(_fixture, key, entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  const prompt = message(20, "user", "Question");
  const answer = message(21, "assistant", "Short answer.", "turn-20");
  // The response has settled; the reveal stops, but the prompt id stays set.
  await render(_fixture, key, [...entries, prompt, answer], {
    readingFollowPromptId: prompt.message.id,
  });
  await advanceClock(_fixture, 160);
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  await advanceClock(_fixture, 160);
  await render(
    _fixture,
    key,
    [...entries, prompt, message(21, "assistant", paragraph(21).repeat(3), "turn-20")],
    {
      readingFollowPromptId: prompt.message.id,
    },
  );
  await vi.waitFor(() => {
    expect(gapToListEnd(_fixture)).toBeLessThanOrEqual(1);
  });
});

it("does not pin the end right after a click that expands content", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:click-expand";
  const entries = [...history(11), message(11, "assistant", "Short answer.")];
  await render(_fixture, key, entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  await advanceClock(_fixture, 160);
  const before = node(_fixture).scrollTop;
  // A click (e.g. Show full message) grows content below the reader.
  node(_fixture).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await render(_fixture, key, [
    ...entries.slice(0, -1),
    message(11, "assistant", paragraph(11).repeat(3)),
  ]);
  await advanceClock(_fixture, 96);
  expect(Math.abs(node(_fixture).scrollTop - before)).toBeLessThanOrEqual(1);
});

it("keeps the end of the answer's text in view while idle, not the end of what follows it", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:idle-text-end";
  const answer = (text: string) => message(30, "assistant", text, "turn-30");
  const entries = [...history(10), message(29, "user", "Question", "turn-30")];
  await render(_fixture, key, [...entries, answer("Short answer.")]);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  await advanceClock(_fixture, 96);
  // Rest exactly at the end of the answer's text, above its trailing rows.
  const state = _fixture.listRef.current!.getState();
  const trailing = state.contentLength - withReadingEnd(state, COMPOSER_INSET)!.contentLength;
  await scroll(() =>
    _fixture.listRef.current!.scrollToOffset({
      offset: node(_fixture).scrollTop - trailing,
      animated: false,
    }),
  );
  await advanceClock(_fixture, 96);
  const readingGap = () => {
    const now = _fixture.listRef.current!.getState();
    return withReadingEnd(now, COMPOSER_INSET)!.contentLength - now.scroll - now.scrollLength;
  };
  const before = readingGap();
  // The answer's content grows late (an image or diagram finishing its render).
  await render(_fixture, key, [...entries, answer(paragraph(30).repeat(3))]);
  await vi.waitFor(() => {
    expect(Math.abs(readingGap() - before)).toBeLessThanOrEqual(2);
  });
});

it("keeps the answer's end in view when content above it grows in the same layout", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:grow-above";
  const earlier = message(28, "assistant", "Earlier short answer.", "turn-28");
  const answer = message(30, "assistant", `Answer. ${"Text. ".repeat(40)}`, "turn-30");
  const entries = [...history(8), earlier, message(29, "user", "Question", "turn-30")];
  await render(_fixture, key, [...entries, answer]);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  await advanceClock(_fixture, 128);
  const readingGap = () => {
    const now = _fixture.listRef.current!.getState();
    // The virtualizer can report its requested scroll after the browser clamps
    // it. Both measurements must describe the rendered viewport.
    const gap = readingEndGapOnScreen(now, node(_fixture), COMPOSER_INSET);
    expect(gap).not.toBeNull();
    return gap!;
  };
  const before = readingGap();
  // Both an earlier answer (above, still rendered) and the last answer grow at once.
  await render(_fixture, key, [
    ...history(8),
    message(28, "assistant", paragraph(28).repeat(2), "turn-28"),
    message(29, "user", "Question", "turn-30"),
    message(30, "assistant", paragraph(30).repeat(3), "turn-30"),
  ]);
  await vi.waitFor(() => {
    expect(Math.abs(readingGap() - before)).toBeLessThanOrEqual(2);
  });
});

it("never pulls the reader back when they scroll in the same frame the answer grows", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:scroll-and-grow";
  const entries = [...history(11), message(11, "assistant", "Short answer.")];
  await render(_fixture, key, entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  await advanceClock(_fixture, 160);
  // The reader scrolls up, and the answer grows before the next frame.
  node(_fixture).dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  node(_fixture).scrollTop -= 120;
  const readerTop = node(_fixture).scrollTop;
  await render(_fixture, key, [
    ...entries.slice(0, -1),
    message(11, "assistant", paragraph(11).repeat(3)),
  ]);
  await advanceClock(_fixture, 128);
  expect(Math.abs(node(_fixture).scrollTop - readerTop)).toBeLessThanOrEqual(1);
});

it("never pulls the reader back during a scrollbar drag that spans several frames", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:scrollbar-drag";
  const entries = [...history(11), message(11, "assistant", "Short answer.")];
  await render(_fixture, key, entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  await advanceClock(_fixture, 160);
  // A press on the scroll node itself (its scrollbar), then movement over frames.
  node(_fixture).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  for (let step = 0; step < 3; step++) {
    node(_fixture).scrollTop -= 40;
    await advanceClock(_fixture, 16);
  }
  const readerTop = node(_fixture).scrollTop;
  // A late render lands mid-drag, several frames after the only input event.
  await render(_fixture, key, [
    ...entries.slice(0, -1),
    message(11, "assistant", paragraph(11).repeat(3)),
  ]);
  await advanceClock(_fixture, 128);
  expect(Math.abs(node(_fixture).scrollTop - readerTop)).toBeLessThanOrEqual(1);
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
});

it("still keeps the end after typing in the composer", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:typing";
  const entries = [...history(11), message(11, "assistant", "Short answer.")];
  await render(_fixture, key, entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  await advanceClock(_fixture, 160);
  const composer = document.createElement("textarea");
  document.body.append(composer);
  composer.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  composer.remove();
  await advanceClock(_fixture, 32);
  await render(_fixture, key, [
    ...entries.slice(0, -1),
    message(11, "assistant", paragraph(11).repeat(3)),
  ]);
  await vi.waitFor(() => {
    expect(gapToListEnd(_fixture)).toBeLessThanOrEqual(1);
  });
});

it("counts the reader at the end when only their own latest message is hidden below the answer", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:own-message-below";
  const onIsAtEndChange = vi.fn();
  const answer = message(30, "assistant", `Answer. ${"Text. ".repeat(60)}`, "turn-30");
  // A message the reader sent (or queued) after the answer, tall enough to hide.
  const sent = message(31, "user", paragraph(31).repeat(2), "turn-31");
  await render(_fixture, key, [...history(8), answer, sent], { onIsAtEndChange });
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  await advanceClock(_fixture, 96);
  // Scroll up until the answer's text ends exactly at the visible bottom.
  const state = _fixture.listRef.current!.getState();
  const atTextEnd = withReadingEnd(state, COMPOSER_INSET)!.contentLength - state.scrollLength;
  await scroll(() =>
    _fixture.listRef.current!.scrollToOffset({ offset: atTextEnd, animated: false }),
  );
  await advanceClock(_fixture, 96);
  expect(rowRect(_fixture, sent.message.id)?.top ?? Infinity).toBeGreaterThan(
    node(_fixture).getBoundingClientRect().top + node(_fixture).clientHeight - COMPOSER_INSET,
  );
  expect(readerAtReadingEnd(_fixture.listRef.current!.getState(), COMPOSER_INSET)).toBe(true);
  expect(onIsAtEndChange.mock.lastCall?.[0]).toBe(true);
});

it("still judges a thread with no answer yet by the reader's own latest message", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:no-answer";
  await render(_fixture, key, history(12));
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  await advanceClock(_fixture, 96);
  expect(readerAtReadingEnd(_fixture.listRef.current!.getState(), COMPOSER_INSET)).toBe(true);
  // Before any answer, the inherited 40px band holds past the message's text
  // end: 30px hidden is the end, 60px is not (three lines would allow ~68px).
  const end = node(_fixture).scrollTop;
  const state = _fixture.listRef.current!.getState();
  const atTextEnd = withReadingEnd(state, COMPOSER_INSET)!.contentLength - state.scrollLength;
  await scroll(() =>
    _fixture.listRef.current!.scrollToOffset({ offset: atTextEnd - 30, animated: false }),
  );
  await advanceClock(_fixture, 64);
  expect(readerAtReadingEnd(_fixture.listRef.current!.getState(), COMPOSER_INSET)).toBe(true);
  await scroll(() =>
    _fixture.listRef.current!.scrollToOffset({ offset: atTextEnd - 60, animated: false }),
  );
  await advanceClock(_fixture, 64);
  expect(readerAtReadingEnd(_fixture.listRef.current!.getState(), COMPOSER_INSET)).toBe(false);
  await scroll(() => _fixture.listRef.current!.scrollToOffset({ offset: end, animated: false }));
  await advanceClock(_fixture, 64);
  // Well above the end (far more than three lines) is not the end.
  await scroll(() =>
    _fixture.listRef.current!.scrollToOffset({
      offset: node(_fixture).scrollTop - 400,
      animated: false,
    }),
  );
  await advanceClock(_fixture, 64);
  expect(readerAtReadingEnd(_fixture.listRef.current!.getState(), COMPOSER_INSET)).toBe(false);
});

it("shows the end control while a running turn has new activity below the reader", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:running-activity";
  const onIsAtEndChange = vi.fn();
  const answer = message(30, "assistant", `Previous answer. ${"Text. ".repeat(40)}`, "turn-30");
  const prompt = message(31, "user", "A short question", "turn-40");
  // The running turn has produced tool steps only, no answer text yet.
  const tools = Array.from({ length: 8 }, (_, i) => ({
    id: `tool-${i}`,
    kind: "work" as const,
    createdAt: "2026-09-29T02:00:00.000Z",
    entry: {
      id: `tool-${i}`,
      createdAt: "2026-09-29T02:00:00.000Z",
      runId: RunId.make("turn-40"),
      turnId: TurnId.make("turn-40"),
      label: `Run command ${i}`,
      tone: "tool" as const,
      toolLifecycleStatus: "completed" as const,
      detail: `Command output ${i}`,
    },
  }));
  const running = { isWorking: true, runningRunId: RunId.make("turn-40"), onIsAtEndChange };
  await render(_fixture, key, [...history(8), answer, prompt, ...tools], running);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  await advanceClock(_fixture, 96);
  expect(readerAtReadingEnd(_fixture.listRef.current!.getState(), COMPOSER_INSET, true)).toBe(true);
  // The reader scrolls up a little: the turn's latest tool steps are now below them.
  await scroll(() =>
    _fixture.listRef.current!.scrollToOffset({
      offset: node(_fixture).scrollTop - 200,
      animated: false,
    }),
  );
  await advanceClock(_fixture, 96);
  const state = _fixture.listRef.current!.getState();
  // Precondition: the previous answer is still in view, while new activity
  // is hidden below (judging by that answer alone would say "at the end").
  expect(rowRect(_fixture, answer.message.id)!.top).toBeLessThan(
    node(_fixture).getBoundingClientRect().top + node(_fixture).clientHeight - COMPOSER_INSET,
  );
  expect(state.contentLength - state.scroll - state.scrollLength).toBeGreaterThan(120);
  // While the turn runs, that activity is what's new: not at the end.
  expect(readerAtReadingEnd(state, COMPOSER_INSET, true)).toBe(false);
  expect(onIsAtEndChange.mock.lastCall?.[0]).toBe(false);
});

function toolRows(run: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${run}-tool-${i}`,
    kind: "work" as const,
    createdAt: "2026-09-29T02:00:00.000Z",
    entry: {
      id: `${run}-tool-${i}`,
      createdAt: "2026-09-29T02:00:00.000Z",
      runId: RunId.make(run),
      turnId: TurnId.make(run),
      label: `Run command ${i}`,
      tone: "tool" as const,
      toolLifecycleStatus: "completed" as const,
      detail: `Command output ${i}`,
    },
  }));
}
const isAtEndNow = (_fixture: _Fixture, running: boolean) =>
  readerAtReadingEnd(_fixture.listRef.current!.getState(), COMPOSER_INSET, running);

it("keeps an interrupted turn's unseen activity below the reader counted", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:interrupted";
  const onIsAtEndChange = vi.fn();
  const rows = [
    ...history(8),
    message(30, "assistant", `Previous answer. ${"Text. ".repeat(40)}`, "turn-30"),
    message(31, "user", "A short question", "turn-40"),
    // An interim note first ("Let me check…"), then failed tool steps (each its own row).
    message(32, "assistant", "Let me look at the config.", "turn-40"),
    ...toolRows("turn-40", 6).map((row) => ({
      ...row,
      entry: { ...row.entry, tone: "error" as const, detail: "Command failed" },
    })),
  ];
  await render(_fixture, key, rows, {
    isWorking: true,
    runningRunId: RunId.make("turn-40"),
    onIsAtEndChange,
  });
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  await advanceClock(_fixture, 96);
  // Rest with the interim note in view and the tool steps after it hidden.
  const view = () =>
    node(_fixture).getBoundingClientRect().top + node(_fixture).clientHeight - COMPOSER_INSET;
  const noteBottom = rowRect(_fixture, message(32, "assistant", "").message.id)!.bottom;
  await scroll(() =>
    _fixture.listRef.current!.scrollToOffset({
      offset: node(_fixture).scrollTop + noteBottom - view() + 4,
      animated: false,
    }),
  );
  await advanceClock(_fixture, 96);
  const now = _fixture.listRef.current!.getState();
  expect(rowRect(_fixture, message(32, "assistant", "").message.id)!.bottom).toBeLessThanOrEqual(
    view(),
  );
  expect(now.contentLength - now.scroll - now.scrollLength).toBeGreaterThan(90);
  expect(isAtEndNow(_fixture, true)).toBe(false);
  // The turn is stopped before it answers: its tool steps are still unseen.
  const interrupted = {
    runId: RunId.make("turn-40"),
    status: "interrupted" as const,
    startedAt: "2026-09-29T02:00:00.000Z",
    completedAt: "2026-09-29T02:01:00.000Z",
  };
  await render(_fixture, key, rows, {
    isWorking: false,
    runningRunId: null,
    latestRun: interrupted,
    onIsAtEndChange,
  });
  await advanceClock(_fixture, 96);
  expect(isAtEndNow(_fixture, true)).toBe(false);
  expect(onIsAtEndChange.mock.lastCall?.[0]).toBe(false);
});

it("judges a finished turn by its answer, and a busy thread without a running turn too", async (context) => {
  await using _fixture = _createFixture(context);
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "reading-end:finished-turn";
  const onIsAtEndChange = vi.fn();
  const answer = message(41, "assistant", `The answer. ${"Text. ".repeat(40)}`, "turn-40");
  const rows = [
    ...history(8),
    message(31, "user", "A short question", "turn-40"),
    ...toolRows("turn-40", 3),
    answer,
    // What trails the finished answer (a tool summary) is not unread.
    ...toolRows("turn-40-tail", 8),
  ];
  // Forking or reverting keeps the thread busy without a running turn.
  await render(_fixture, key, rows, { isWorking: true, runningRunId: null, onIsAtEndChange });
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  await advanceClock(_fixture, 96);
  const state = _fixture.listRef.current!.getState();
  const atTextEnd = withReadingEnd(state, COMPOSER_INSET)!.contentLength - state.scrollLength;
  await scroll(() =>
    _fixture.listRef.current!.scrollToOffset({ offset: atTextEnd, animated: false }),
  );
  await advanceClock(_fixture, 96);
  const now = _fixture.listRef.current!.getState();
  // Precondition: the trailing tool rows are hidden below.
  expect(now.contentLength - now.scroll - now.scrollLength).toBeGreaterThan(40);
  expect(isAtEndNow(_fixture, false)).toBe(true);
  expect(onIsAtEndChange.mock.lastCall?.[0]).toBe(true);
});

function _createFixture(context: TestContext) {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  const listRef = createRef<LegendListRef>();
  const base = {
    listRef,
    isWorking: false,
    activeTurnStartedAt: null,
    latestRun: null,
    runningRunId: null,
    turnDiffSummaries: [],
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: () => Promise.resolve(),
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: env,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    runs: [],
    providerStatuses: [],
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: COMPOSER_INSET,
    onIsAtEndChange: vi.fn(),
    onManualNavigation: () => {},
  };
  return {
    listRef,
    base,
    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    /** Aborts at the test's deadline; advanceClock stops on it. */
    signal: context.signal,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
