import "../../index.css";
import { EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import { MessagesTimeline } from "./MessagesTimeline";
import { withReadingEnd } from "./readerScrollPolicy";
import { readTimelinePosition, rememberTimelinePosition } from "./timelineScrollAnchoring";

// Real-Chromium geometry for DF-047 and the #396 follow-ups: where the bottom
// is, how a sent prompt's response is revealed, and which layout keeps the end.

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const listRef = createRef<LegendListRef>();
const env = EnvironmentId.make("reading-end-tests");
const COMPOSER_INSET = 100;
function message(
  index: number,
  role: "user" | "assistant",
  text: string,
  turn = `turn-${index}`,
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
      turnId: TurnId.make(turn),
      createdAt,
      updatedAt: createdAt,
      streaming,
    },
  };
}
const paragraph = (index: number) => `Message ${index}\n\n${"Readable paragraph. ".repeat(28)}`;
const history = (count: number) =>
  Array.from({ length: count }, (_, i) => message(i, "user", paragraph(i)));
const base = {
  listRef,
  isWorking: false,
  activeTurnStartedAt: null,
  latestTurn: null,
  runningTurnId: null,
  turnDiffSummaries: [],
  onOpenTurnDiff: () => {},
  supportsConversationRollback: false,
  onRevertToTurnCount: () => {},
  isRevertingCheckpoint: false,
  onImageExpand: () => {},
  activeThreadEnvironmentId: env,
  markdownCwd: undefined,
  resolvedTheme: "light" as const,
  timestampFormat: "locale" as const,
  workspaceRoot: undefined,
  anchorMessageId: null,
  onAnchorReady: () => {},
  contentInsetEndAdjustment: COMPOSER_INSET,
  onIsAtEndChange: vi.fn(),
  onManualNavigation: () => {},
};
const frames = async (count = 4) => {
  for (let i = 0; i < count; i++)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
function render(
  key: string,
  entries: React.ComponentProps<typeof MessagesTimeline>["timelineEntries"],
  extra: Partial<React.ComponentProps<typeof MessagesTimeline>> = {},
) {
  if (!host) {
    host = document.createElement("div");
    Object.assign(host.style, { width: "720px", height: "600px" });
    document.body.append(host);
    root = createRoot(host);
  }
  flushSync(() =>
    root!.render(
      <MessagesTimeline {...base} routeThreadKey={key} timelineEntries={entries} {...extra} />,
    ),
  );
}
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});
const node = () => listRef.current!.getScrollableNode()!;
const gapToListEnd = () => node().scrollHeight - node().clientHeight - node().scrollTop;
function rowRect(messageId: string) {
  const state = listRef.current!.getState();
  const index = state.data.findIndex(
    (row: { kind: string; message?: { id: string } }) =>
      row.kind === "message" && row.message?.id === messageId,
  );
  return state.elementAtIndex(index)?.getBoundingClientRect() ?? null;
}
/** Whether the first lines of a message sit inside the visible area above the composer. */
function firstLinesVisible(messageId: string) {
  const rect = rowRect(messageId);
  if (!rect) return false;
  const view = node().getBoundingClientRect();
  // Its first lines, or all of it when it is shorter than that.
  const firstLinesBottom = Math.min(rect.top + 40, rect.bottom);
  return (
    rect.top >= view.top + 20 &&
    firstLinesBottom <= view.top + node().clientHeight - COMPOSER_INSET + 1
  );
}

it("reveals past progress notes to the start of the message the agent is writing", async () => {
  const key = "reading-end:notes";
  const entries = history(10);
  render(key, entries);
  await expect.poll(() => readTimelinePosition(key)).toBeDefined();
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
  render(key, timeline, running);
  await frames(8);
  for (const note of notes) {
    timeline = [...timeline, note];
    render(key, timeline, running);
    await frames(12);
  }
  const latest = notes.at(-1)!.message.id;
  await expect.poll(() => firstLinesVisible(latest), { timeout: 4000 }).toBe(true);
});

it("counts one unread per response, not one per progress note", async () => {
  const key = "reading-end:unread";
  const entries = history(15);
  const onUnreadBelowChange = vi.fn();
  render(key, entries, { onUnreadBelowChange });
  await expect.poll(() => readTimelinePosition(key)).toBeDefined();
  await listRef.current!.scrollToOffset({ offset: 200, animated: false });
  await frames();
  const later = "2026-09-29T01:00:00.000Z";
  let timeline = [...entries, message(40, "user", "Question", "turn-40", later)];
  for (let i = 0; i < 5; i++) {
    timeline = [
      ...timeline,
      message(41 + i, "assistant", `Note ${i}. ${"Working. ".repeat(20)}`, "turn-40", later),
    ];
    // A running turn keeps its notes as rows (a settled one folds them).
    render(key, timeline, {
      onUnreadBelowChange,
      isWorking: true,
      runningTurnId: TurnId.make("turn-40"),
    });
    await frames(3);
  }
  await expect.poll(() => onUnreadBelowChange.mock.lastCall?.[0]).toBe(1);
});

it("keeps revealing after a click or text selection in the timeline", async () => {
  const key = "reading-end:click";
  const entries = history(10);
  render(key, entries);
  await expect.poll(() => readTimelinePosition(key)).toBeDefined();
  const prompt = message(20, "user", "Question");
  const running = { isWorking: true, readingFollowPromptId: prompt.message.id };
  render(key, [...entries, prompt], running);
  await frames(8);
  node().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  // Scrolling down (or trackpad momentum toward the end) is not a cancel either.
  node().dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true }));
  const answer = message(21, "assistant", `Answer. ${"Explaining. ".repeat(300)}`, "turn-20");
  render(key, [...entries, prompt, answer], running);
  await expect.poll(() => firstLinesVisible(answer.message.id), { timeout: 4000 }).toBe(true);
});

it("treats the end of the last message's text as the bottom", async () => {
  const key = "reading-end:bottom";
  const onIsAtEndChange = vi.fn();
  render(key, [...history(8), message(30, "assistant", `Answer. ${"Text. ".repeat(80)}`)], {
    onIsAtEndChange,
  });
  await expect.poll(() => readTimelinePosition(key)).toBeDefined();
  await listRef.current!.scrollToEnd({ animated: false });
  await frames();
  const state = listRef.current!.getState();
  const reading = withReadingEnd(state, COMPOSER_INSET)!;
  // Rows after the answer's text (its timestamp and actions) are not reading content.
  const trailing = state.contentLength - reading.contentLength;
  expect(trailing).toBeGreaterThan(0);
  // Scrolled up so the trailing rows plus a little more are hidden: the
  // answer's text is still fully in view, so this is the bottom.
  await listRef.current!.scrollToOffset({
    offset: node().scrollTop - trailing - 30,
    animated: false,
  });
  await frames();
  expect(resolveTimelineIsAtEnd(withReadingEnd(listRef.current!.getState(), COMPOSER_INSET))).toBe(
    true,
  );
  expect(onIsAtEndChange.mock.lastCall?.[0]).toBe(true);
});

it("opens a thread without a saved position at the end, even when rows grow after the first jump", async () => {
  const key = "reading-end:fresh-open";
  const entries = [...history(11), message(11, "assistant", "Short answer.")];
  render(key, entries);
  await frames(3);
  // The last answer grows just after the first jump to the end (late layout).
  render(key, [...entries.slice(0, -1), message(11, "assistant", paragraph(11).repeat(4))]);
  await expect.poll(() => gapToListEnd(), { timeout: 4000 }).toBeLessThanOrEqual(1);
});

it("keeps the end in view while idle, and never moves the reader while the thread works", async () => {
  const key = "reading-end:idle";
  const entries = [...history(11), message(11, "assistant", "Short answer.")];
  render(key, entries);
  await expect.poll(() => readTimelinePosition(key)).toBeDefined();
  await listRef.current!.scrollToEnd({ animated: false });
  await frames(10);
  expect(gapToListEnd()).toBeLessThanOrEqual(1);
  // Late layout at the end of an idle thread (a diagram finishing its render).
  render(key, [...entries.slice(0, -1), message(11, "assistant", paragraph(11).repeat(3))]);
  await expect.poll(() => gapToListEnd(), { timeout: 4000 }).toBeLessThanOrEqual(1);
  // While the thread works, growth lands below the reader.
  const before = node().scrollTop;
  render(key, [...entries.slice(0, -1), message(11, "assistant", paragraph(11).repeat(6))], {
    isWorking: true,
  });
  await frames(8);
  expect(Math.abs(node().scrollTop - before)).toBeLessThanOrEqual(1);
});

it("stops paging history for a missing saved message after a few pages", async () => {
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
  render(key, recent, { loadEarlier: loadEarlier() });
  for (let i = 0; i < 6; i++) {
    await frames(4);
    render(key, recent, { loadEarlier: loadEarlier() });
  }
  await frames(8);
  expect(load.mock.calls.length).toBeLessThanOrEqual(2);
  // The reader is placed (at a neighbor or the end) rather than left waiting.
  await expect.poll(() => readTimelinePosition(key)?.messageId).not.toBe("message-gone");
});

it("reveals the latest message after very tall notes", async () => {
  const key = "reading-end:virtualized";
  const entries = history(10);
  render(key, entries);
  await expect.poll(() => readTimelinePosition(key)).toBeDefined();
  const prompt = message(20, "user", "A question with a long investigation");
  // A running turn keeps its notes as rows; a settled one would fold them.
  const running = {
    isWorking: true,
    runningTurnId: TurnId.make("turn-20"),
    readingFollowPromptId: prompt.message.id,
  };
  render(key, [...entries, prompt], running);
  await frames(8);
  // Several very tall notes push the next message far past the rendered window.
  const tallNotes = [21, 22, 23, 24].map((index) =>
    message(
      index,
      "assistant",
      `Investigation ${index}. ${"Reading the logs. ".repeat(900)}`,
      "turn-20",
    ),
  );
  const latest = message(25, "assistant", "Here is what I found.", "turn-20");
  // The notes are measured first; the latest message arrives afterwards, far
  // below the rendered window.
  render(key, [...entries, prompt, ...tallNotes], running);
  await frames(12);
  render(key, [...entries, prompt, ...tallNotes, latest], running);
  await frames(1);
  // Precondition: the latest message has never been rendered.
  expect(rowRect(latest.message.id)).toBeNull();
  await expect.poll(() => firstLinesVisible(latest.message.id), { timeout: 8000 }).toBe(true);
});

it("waits for a history page still loading before giving up on the saved message", async () => {
  const key = "reading-end:slow-page";
  const saved = message(3, "user", paragraph(3));
  rememberTimelinePosition(key, {
    rowId: saved.id,
    messageId: saved.message.id,
    turnId: saved.message.turnId,
    offsetWithinRow: 0,
    scrollOffset: 5000,
    atEnd: false,
  });
  const recent = Array.from({ length: 10 }, (_, i) => message(i + 40, "user", paragraph(i + 40)));
  const load = vi.fn();
  render(key, recent, { loadEarlier: { loading: false, cursor: "page-1", onLoadEarlier: load } });
  await expect.poll(() => load.mock.calls.length).toBe(1);
  const middle = Array.from({ length: 10 }, (_, i) => message(i + 20, "user", paragraph(i + 20)));
  render(key, [...middle, ...recent], {
    loadEarlier: { loading: false, cursor: "page-2", onLoadEarlier: load },
  });
  await expect.poll(() => load.mock.calls.length).toBe(2);
  // The second page is slow: restoration must keep waiting for it.
  render(key, [...middle, ...recent], {
    loadEarlier: { loading: true, cursor: "page-2", onLoadEarlier: load },
  });
  await frames(30);
  const all = [
    ...Array.from({ length: 10 }, (_, i) => message(i, "user", paragraph(i))),
    ...middle,
    ...recent,
  ];
  render(key, all, { loadEarlier: { loading: false, cursor: null, onLoadEarlier: load } });
  await expect
    .poll(
      () => {
        const rect = rowRect(saved.message.id);
        return rect ? Math.abs(rect.top - node().getBoundingClientRect().top) : Infinity;
      },
      { timeout: 5000 },
    )
    .toBeLessThanOrEqual(2);
});

it("pins the idle end again once a reveal has finished", async () => {
  const key = "reading-end:after-reveal";
  const entries = history(10);
  render(key, entries);
  await expect.poll(() => readTimelinePosition(key)).toBeDefined();
  const prompt = message(20, "user", "Question");
  const answer = message(21, "assistant", "Short answer.", "turn-20");
  // The response has settled; the reveal stops, but the prompt id stays set.
  render(key, [...entries, prompt, answer], { readingFollowPromptId: prompt.message.id });
  await frames(10);
  await listRef.current!.scrollToEnd({ animated: false });
  await frames(10);
  render(key, [...entries, prompt, message(21, "assistant", paragraph(21).repeat(3), "turn-20")], {
    readingFollowPromptId: prompt.message.id,
  });
  await expect.poll(() => gapToListEnd(), { timeout: 4000 }).toBeLessThanOrEqual(1);
});

it("does not pin the end right after a click that expands content", async () => {
  const key = "reading-end:click-expand";
  const entries = [...history(11), message(11, "assistant", "Short answer.")];
  render(key, entries);
  await expect.poll(() => readTimelinePosition(key)).toBeDefined();
  await listRef.current!.scrollToEnd({ animated: false });
  await frames(10);
  const before = node().scrollTop;
  // A click (e.g. Show full message) grows content below the reader.
  node().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  render(key, [...entries.slice(0, -1), message(11, "assistant", paragraph(11).repeat(3))]);
  await frames(6);
  expect(Math.abs(node().scrollTop - before)).toBeLessThanOrEqual(1);
});

it("keeps the end of the answer's text in view while idle, not the end of what follows it", async () => {
  const key = "reading-end:idle-text-end";
  const answer = (text: string) => message(30, "assistant", text, "turn-30");
  const entries = [...history(10), message(29, "user", "Question", "turn-30")];
  render(key, [...entries, answer("Short answer.")]);
  await expect.poll(() => readTimelinePosition(key)).toBeDefined();
  await listRef.current!.scrollToEnd({ animated: false });
  await frames(6);
  // Rest exactly at the end of the answer's text, above its trailing rows.
  const state = listRef.current!.getState();
  const trailing = state.contentLength - withReadingEnd(state, COMPOSER_INSET)!.contentLength;
  await listRef.current!.scrollToOffset({ offset: node().scrollTop - trailing, animated: false });
  await frames(6);
  const readingGap = () => {
    const now = listRef.current!.getState();
    return withReadingEnd(now, COMPOSER_INSET)!.contentLength - now.scroll - now.scrollLength;
  };
  const before = readingGap();
  // The answer's content grows late (an image or diagram finishing its render).
  render(key, [...entries, answer(paragraph(30).repeat(3))]);
  await expect
    .poll(() => Math.abs(readingGap() - before), { timeout: 4000 })
    .toBeLessThanOrEqual(2);
});

it("keeps the answer's end in view when content above it grows in the same layout", async () => {
  const key = "reading-end:grow-above";
  const earlier = message(28, "assistant", "Earlier short answer.", "turn-28");
  const answer = message(30, "assistant", `Answer. ${"Text. ".repeat(40)}`, "turn-30");
  const entries = [...history(8), earlier, message(29, "user", "Question", "turn-30")];
  render(key, [...entries, answer]);
  await expect.poll(() => readTimelinePosition(key)).toBeDefined();
  await listRef.current!.scrollToEnd({ animated: false });
  await frames(8);
  const readingGap = () => {
    const now = listRef.current!.getState();
    return withReadingEnd(now, COMPOSER_INSET)!.contentLength - now.scroll - now.scrollLength;
  };
  const before = readingGap();
  // Both an earlier answer (above, still rendered) and the last answer grow at once.
  render(key, [
    ...history(8),
    message(28, "assistant", paragraph(28).repeat(2), "turn-28"),
    message(29, "user", "Question", "turn-30"),
    message(30, "assistant", paragraph(30).repeat(3), "turn-30"),
  ]);
  await expect
    .poll(() => Math.abs(readingGap() - before), { timeout: 4000 })
    .toBeLessThanOrEqual(2);
});

it("never pulls the reader back when they scroll in the same frame the answer grows", async () => {
  const key = "reading-end:scroll-and-grow";
  const entries = [...history(11), message(11, "assistant", "Short answer.")];
  render(key, entries);
  await expect.poll(() => readTimelinePosition(key)).toBeDefined();
  await listRef.current!.scrollToEnd({ animated: false });
  await frames(10);
  // The reader scrolls up, and the answer grows before the next frame.
  node().dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  node().scrollTop -= 120;
  const readerTop = node().scrollTop;
  render(key, [...entries.slice(0, -1), message(11, "assistant", paragraph(11).repeat(3))]);
  await frames(8);
  expect(Math.abs(node().scrollTop - readerTop)).toBeLessThanOrEqual(1);
});
