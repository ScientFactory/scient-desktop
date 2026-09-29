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
  return (
    rect.top >= view.top + 20 && rect.top + 40 <= view.top + node().clientHeight - COMPOSER_INSET
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
