import "../../index.css";
import { EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import { readerAtReadingEnd, withReadingEnd } from "./readerScrollPolicy";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  partwayPromptOffset,
  readTimelinePosition,
  rememberTimelinePosition,
  withRealTimelineEnd,
} from "./timelineScrollAnchoring";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const listRef = createRef<LegendListRef>();
const env = EnvironmentId.make("scroll-geometry-tests");
const date = "2026-09-29T00:00:00.000Z";
function entry(index: number, text = `Message ${index}\n\n${"Readable paragraph. ".repeat(28)}`) {
  return {
    kind: "message" as const,
    id: `entry-${index}`,
    createdAt: date,
    message: {
      id: MessageId.make(`message-${index}`),
      role: "user" as const,
      text,
      turnId: TurnId.make(`turn-${index}`),
      createdAt: date,
      updatedAt: date,
      streaming: false,
    },
  };
}
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
  contentInsetEndAdjustment: 100,
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

it("holds a measured viewport through repeated appended rows and completion", async () => {
  let entries = Array.from({ length: 20 }, (_, i) => entry(i));
  render("geometry:stream", entries);
  await expect.poll(() => listRef.current?.getScrollableNode()?.scrollTop ?? 0).toBeGreaterThan(0);
  await frames();
  const node = listRef.current!.getScrollableNode()!;
  await listRef.current!.scrollToOffset({ offset: 300, animated: false });
  await frames();
  const original = node.scrollTop;
  for (let i = 20; i < 45; i++) {
    entries = [...entries, entry(i)];
    render("geometry:stream", entries, { isWorking: true });
    await frames(2);
    expect(Math.abs(node.scrollTop - original)).toBeLessThanOrEqual(1);
  }
  render("geometry:stream", entries, { isWorking: false });
  await frames();
  expect(Math.abs(node.scrollTop - original)).toBeLessThanOrEqual(1);
});

it("restores the same message after switching threads with a saved at-end position", async () => {
  const entries = Array.from({ length: 15 }, (_, i) => entry(i));
  render("geometry:a", entries);
  await expect.poll(() => readTimelinePosition("geometry:a")?.messageId).toBeDefined();
  const saved = readTimelinePosition("geometry:a")!;
  render(
    "geometry:b",
    Array.from({ length: 4 }, (_, i) => entry(i + 100)),
  );
  await expect.poll(() => readTimelinePosition("geometry:b")).toBeDefined();
  render("geometry:a", [...entries, ...Array.from({ length: 10 }, (_, i) => entry(i + 15))]);
  await expect.poll(() => readTimelinePosition("geometry:a")?.messageId).toBe(saved.messageId);
  await frames(6);
  const node = listRef.current!.getScrollableNode()!;
  await expect
    .poll(
      () => {
        const live = listRef.current!.getState();
        const i = live.data.findIndex(
          (row: { message?: { id: string } }) => row.message?.id === saved.messageId,
        );
        const el = live.elementAtIndex(i);
        return el
          ? Math.abs(
              node.getBoundingClientRect().top -
                el.getBoundingClientRect().top -
                saved.offsetWithinRow,
            )
          : Infinity;
      },
      { timeout: 5000 },
    )
    .toBeLessThanOrEqual(2);
});

it("captures the last scroll before an immediate thread switch", async () => {
  const entries = Array.from({ length: 20 }, (_, i) => entry(i));
  render("geometry:quick-switch", entries);
  await expect.poll(() => readTimelinePosition("geometry:quick-switch")).toBeDefined();
  await listRef.current!.scrollToOffset({ offset: 300, animated: false });
  await frames();
  const node = listRef.current!.getScrollableNode()!;
  // No timer, polling, or animation frame between this gesture and navigation.
  node.scrollTop += 35;
  node.dispatchEvent(new Event("scroll"));
  const expectedOffset = node.scrollTop;
  render("geometry:quick-other", [entry(100)]);
  await frames(8);
  render("geometry:quick-switch", entries);
  await frames(16);
  expect(listRef.current!.getScrollableNode()!.scrollTop).toBeCloseTo(expectedOffset, 0);
});

it("flushes the latest captured position on pagehide before the storage debounce", async () => {
  render(
    "geometry:pagehide",
    Array.from({ length: 20 }, (_, i) => entry(i)),
  );
  await expect.poll(() => readTimelinePosition("geometry:pagehide")).toBeDefined();
  await listRef.current!.scrollToOffset({ offset: 300, animated: false });
  await frames();
  const node = listRef.current!.getScrollableNode()!;
  node.scrollTop += 35;
  node.dispatchEvent(new Event("scroll"));
  window.dispatchEvent(new Event("pagehide"));
  const records = JSON.parse(sessionStorage.getItem("scient:timeline-reading-position:v1")!);
  const saved = records.find(([key]: [string]) => key === "geometry:pagehide")[1];
  const receipt = readTimelinePosition("geometry:pagehide")!;
  expect(receipt.scrollOffset).toBe(node.scrollTop);
  expect(saved.rowId).toBe(receipt.rowId);
  expect(saved.offsetWithinRow).toBe(receipt.offsetWithinRow);
});

it("does not offer a jump into reserved blank space but reports a hidden answer", async () => {
  const prompt = entry(0, "Short prompt");
  const onIsAtEndChange = vi.fn();
  const answer = (text: string) => ({
    ...entry(1, text),
    message: { ...entry(1, text).message, role: "assistant" as const },
  });
  const extra = {
    anchorMessageId: prompt.message.id,
    onAnchorReady: (_id: MessageId, index: number) => {
      void listRef.current!.scrollToIndex({
        index,
        viewPosition: 0,
        viewOffset: 24,
        animated: false,
      });
    },
    onIsAtEndChange,
  };
  render("geometry:reserved-end", [prompt], extra);
  await frames(16);
  expect(onIsAtEndChange.mock.lastCall?.[0]).toBe(true);
  render("geometry:reserved-end", [prompt, answer("Short answer")], extra);
  await frames(8);
  expect(onIsAtEndChange.mock.lastCall?.[0]).toBe(true);
  // The send gate must agree with the end control even while padding remains.
  expect(readerAtReadingEnd(listRef.current!.getState(), base.contentInsetEndAdjustment)).toBe(
    true,
  );
  render("geometry:reserved-end", [prompt, answer("Long answer\n\n".repeat(100))], extra);
  await frames(8);
  expect(onIsAtEndChange.mock.lastCall?.[0]).toBe(false);
});

it("never paints a cold thread at the beginning before positioning at its end", async () => {
  render(
    "geometry:first-paint",
    Array.from({ length: 25 }, (_, i) => entry(i)),
  );
  let visibleFrames = 0;
  for (let i = 0; i < 16; i++) {
    await frames(1);
    const node = listRef.current!.getScrollableNode()!;
    if (getComputedStyle(node).visibility !== "hidden") {
      visibleFrames++;
      expect(node.scrollTop).toBeGreaterThan(0);
      expect(resolveTimelineIsAtEnd(listRef.current!.getState())).toBe(true);
    }
  }
  expect(visibleFrames).toBeGreaterThan(0);
});

it("does not apply an unrelated offset when a transient saved row disappeared", async () => {
  const entries = Array.from({ length: 20 }, (_, i) => entry(i));
  rememberTimelinePosition("geometry:transient", {
    rowId: "working-indicator-row",
    turnId: "turn-7",
    offsetWithinRow: 0,
    scrollOffset: 99999,
    atEnd: false,
  });
  render("geometry:transient", entries);
  await expect
    .poll(() =>
      listRef.current
        ?.getState()
        .data.some((row: { message?: { id: string } }) => row.message?.id === "message-7"),
    )
    .toBe(true);
  await frames(12);
  const state = listRef.current!.getState();
  const index = state.data.findIndex(
    (row: { message?: { id: string } }) => row.message?.id === "message-7",
  );
  const node = listRef.current!.getScrollableNode()!;
  const element = state.elementAtIndex(index)!;
  expect(
    Math.abs(element.getBoundingClientRect().top - node.getBoundingClientRect().top),
  ).toBeLessThanOrEqual(2);
});

it("does not follow a growing answer even when the reader starts at the bottom", async () => {
  const entries = Array.from({ length: 12 }, (_, i) => entry(i));
  render("geometry:bottom-growth", entries);
  await expect.poll(() => readTimelinePosition("geometry:bottom-growth")).toBeDefined();
  const node = listRef.current!.getScrollableNode()!;
  const original = node.scrollTop;
  for (let i = 0; i < 20; i++) {
    render("geometry:bottom-growth", [
      ...entries,
      ...Array.from({ length: i + 1 }, (_, n) => entry(n + 12)),
    ]);
    await frames(2);
    expect(Math.abs(node.scrollTop - original)).toBeLessThanOrEqual(1);
  }
});

it("waits for older history before restoring a saved reading message", async () => {
  const old = entry(7);
  rememberTimelinePosition("geometry:paged", {
    rowId: old.id,
    messageId: old.message.id,
    turnId: old.message.turnId,
    offsetWithinRow: 0,
    scrollOffset: 8000,
    atEnd: false,
  });
  const recent = Array.from({ length: 10 }, (_, i) => entry(i + 30));
  const load = vi.fn();
  render("geometry:paged", recent, {
    loadEarlier: { loading: false, cursor: "page-2", onLoadEarlier: load },
  });
  await expect.poll(() => load.mock.calls.length).toBe(1);
  await frames();
  expect(readTimelinePosition("geometry:paged")?.messageId).toBe(old.message.id);
  render("geometry:paged", [...Array.from({ length: 30 }, (_, i) => entry(i)), ...recent]);
  await expect
    .poll(
      () => {
        const state = listRef.current!.getState();
        const index = state.data.findIndex(
          (row: { message?: { id: string } }) => row.message?.id === old.message.id,
        );
        const element = state.elementAtIndex(index);
        const node = listRef.current!.getScrollableNode()!;
        return element
          ? Math.abs(element.getBoundingClientRect().top - node.getBoundingClientRect().top)
          : Infinity;
      },
      { timeout: 5000 },
    )
    .toBeLessThanOrEqual(2);
});

it("manual navigation cancels restoration while history is still loading", async () => {
  rememberTimelinePosition("geometry:cancel", {
    rowId: "gone",
    messageId: "message-1",
    turnId: "turn-1",
    offsetWithinRow: 0,
    scrollOffset: 9000,
    atEnd: false,
  });
  const recent = Array.from({ length: 15 }, (_, i) => entry(i + 50));
  const load = vi.fn();
  render("geometry:cancel", recent, {
    loadEarlier: { loading: false, cursor: "older", onLoadEarlier: load },
  });
  await expect.poll(() => load.mock.calls.length).toBe(1);
  await frames();
  const node = listRef.current!.getScrollableNode()!;
  node.dispatchEvent(new WheelEvent("wheel", { deltaY: 200, bubbles: true }));
  await listRef.current!.scrollToOffset({ offset: 350, animated: false });
  await frames();
  const before = listRef.current!.getState();
  const rowIndex = before.data.findIndex(
    (row: { message?: { id: string } }) => row.message?.id === "message-51",
  );
  const original = before.elementAtIndex(rowIndex)!.getBoundingClientRect().top;
  render("geometry:cancel", recent, { loadEarlier: null });
  await frames(10);
  expect(
    Math.abs(
      listRef.current!.getState().elementAtIndex(rowIndex)!.getBoundingClientRect().top - original,
    ),
  ).toBeLessThanOrEqual(1);
  await expect.poll(() => readTimelinePosition("geometry:cancel")?.messageId).not.toBe("message-1");
});

it("keeps existing first-message framing and short-answer space through completion", async () => {
  const entries: ReturnType<typeof entry>[] = [];
  const followUp = entry(8, "Follow-up prompt");
  let positioned = false;
  const onAnchorReady = (_id: MessageId, index: number) => {
    if (positioned) return;
    positioned = true;
    void listRef.current!.scrollToIndex({
      index,
      viewPosition: 0,
      viewOffset: 24,
      animated: false,
    });
  };
  const extra = { anchorMessageId: followUp.message.id, onAnchorReady };
  render("geometry:anchor", [...entries, followUp], extra);
  await expect.poll(() => positioned).toBe(true);
  await frames(12);
  const node = listRef.current!.getScrollableNode()!;
  const original = node.scrollTop;
  render("geometry:anchor", [...entries, followUp, entry(9, "Short answer")], extra);
  await frames(8);
  expect(Math.abs(node.scrollTop - original)).toBeLessThanOrEqual(1);
  await expect
    .poll(() => readTimelinePosition("geometry:anchor")?.anchorMessageId)
    .toBe(followUp.message.id);
  const saved = readTimelinePosition("geometry:anchor")!;
  root!.unmount();
  host!.remove();
  root = undefined;
  host = undefined;
  render("geometry:anchor", [...entries, followUp, entry(9, "Short answer")], {
    ...extra,
    onAnchorReady: () => {},
  });
  await expect.poll(() => listRef.current?.getScrollableNode()?.scrollTop).toBeCloseTo(original, 0);
  expect(readTimelinePosition("geometry:anchor")?.messageId).toBe(saved.messageId);
});

function failedTool(index: number) {
  return {
    id: `follow-up-tool-${index}`,
    kind: "work" as const,
    createdAt: date,
    entry: {
      id: `follow-up-tool-${index}`,
      createdAt: date,
      turnId: TurnId.make("turn-10"),
      label: `Run command ${index}`,
      tone: "error" as const,
      toolLifecycleStatus: "completed" as const,
      detail: "Command failed",
    },
  };
}

it("places a later prompt partway, then follows its traces until it reaches the top", async () => {
  const answer = (index: number) => ({
    ...entry(index),
    message: { ...entry(index).message, role: "assistant" as const },
  });
  const history = Array.from({ length: 10 }, (_, i) => (i % 2 ? answer(i) : entry(i)));
  render("geometry:follow-up", history);
  await expect.poll(() => readTimelinePosition("geometry:follow-up")?.atEnd).toBe(true);
  const node = listRef.current!.getScrollableNode()!;
  const readingHeight = node.clientHeight - base.contentInsetEndAdjustment;
  const onIsAtEndChange = vi.fn();
  let positioned = false;
  const prompt = entry(10, "Short follow-up");
  const extra = {
    isWorking: true,
    runningTurnId: TurnId.make("turn-10"),
    readingFollowPromptId: prompt.message.id,
    anchorMessageId: prompt.message.id,
    // What ChatView does for a later prompt sent at the end.
    onAnchorReady: (_id: MessageId, index: number) => {
      if (positioned) return;
      positioned = true;
      const height = listRef.current!.getState().sizeAtIndex(index) ?? 0;
      void listRef.current!.scrollToIndex({
        index,
        viewPosition: 0,
        viewOffset: partwayPromptOffset(readingHeight, height),
        animated: false,
      });
    },
    onIsAtEndChange,
  };
  // Placement holds the reveal back until it is done, as in ChatView.
  render("geometry:follow-up", [...history, prompt], {
    ...extra,
    timelinePositioningPending: true,
  });
  await expect.poll(() => positioned).toBe(true);
  await frames(12);
  render("geometry:follow-up", [...history, prompt], extra);
  await frames(4);
  const promptBox = () => {
    const state = listRef.current!.getState();
    const row = state.elementAtIndex(10)!;
    const text = row.querySelector('[data-user-message-body="true"]')!.getBoundingClientRect();
    const top = node.getBoundingClientRect().top;
    // The text's top (only the bubble's padding may pass the margin), the row's bottom.
    return { top: text.top - top, bottom: row.getBoundingClientRect().bottom - top };
  };
  // Partway: its bottom at the middle of the reading area, the lower half free.
  expect(Math.abs(promptBox().bottom - readingHeight / 2)).toBeLessThanOrEqual(2);
  expect(onIsAtEndChange.mock.lastCall?.[0]).toBe(true);
  const rested = node.scrollTop;
  // The first traces fill the free half without moving anything.
  render("geometry:follow-up", [...history, prompt, failedTool(0)], extra);
  await frames(8);
  expect(Math.abs(node.scrollTop - rested)).toBeLessThanOrEqual(1);
  // Then the view follows them, keeping the latest in view, up to the top margin.
  const tools = [];
  for (let i = 0; i < 24; i++) {
    tools.push(failedTool(i));
    render("geometry:follow-up", [...history, prompt, ...tools], extra);
    // Settled: the latest trace is in view, unless the prompt reached the top.
    await expect
      .poll(() => {
        const state = listRef.current!.getState();
        const last = state.data.length - 1;
        const bottom =
          (state.elementAtIndex(last)?.getBoundingClientRect().bottom ?? Infinity) -
          node.getBoundingClientRect().top;
        return bottom <= readingHeight + 2 || promptBox().top <= CHAT_TIMELINE_ANCHOR_OFFSET + 1;
      })
      .toBe(true);
    expect(promptBox().top).toBeGreaterThanOrEqual(CHAT_TIMELINE_ANCHOR_OFFSET - 1);
  }
  expect(node.scrollTop).toBeGreaterThan(rested);
  await expect.poll(() => promptBox().top).toBeLessThanOrEqual(CHAT_TIMELINE_ANCHOR_OFFSET + 1);
  // At the top it stops: more activity goes below the fold.
  const stopped = node.scrollTop;
  render(
    "geometry:follow-up",
    [...history, prompt, ...tools, failedTool(24), failedTool(25)],
    extra,
  );
  await frames(10);
  expect(Math.abs(node.scrollTop - stopped)).toBeLessThanOrEqual(1);
});

it("preserves the original near-bottom tolerance for lines hidden by the composer", async () => {
  render(
    "geometry:strict-edge",
    Array.from({ length: 20 }, (_, i) => entry(i)),
  );
  await expect.poll(() => readTimelinePosition("geometry:strict-edge")).toBeDefined();
  const list = listRef.current!;
  const initial = list.getScrollableNode()!.scrollTop;
  expect(resolveTimelineIsAtEnd(list.getState())).toBe(true);
  await list.scrollToOffset({ offset: initial - 20, animated: false });
  await frames();
  expect(resolveTimelineIsAtEnd(list.getState())).toBe(true);
  await list.scrollToOffset({ offset: initial - 80, animated: false });
  await frames();
  expect(resolveTimelineIsAtEnd(list.getState())).toBe(false);
});

it("counts new answers below the reader once while streaming, then clears them on reaching them", async () => {
  const entries = Array.from({ length: 15 }, (_, i) => entry(i));
  const onUnreadBelowChange = vi.fn();
  const extra = { onUnreadBelowChange };
  render("geometry:unread", entries, extra);
  await expect.poll(() => readTimelinePosition("geometry:unread")).toBeDefined();
  await listRef.current!.scrollToOffset({ offset: 250, animated: false });
  await frames();
  const original = listRef.current!.getScrollableNode()!.scrollTop;
  let answer = {
    ...entry(20),
    message: { ...entry(20).message, role: "assistant" as const, streaming: true },
  };
  for (let chunk = 0; chunk < 12; chunk++) {
    answer = {
      ...answer,
      message: {
        ...answer.message,
        text: answer.message.text + "\n\nAnother paragraph. ".repeat(4),
      },
    };
    render("geometry:unread", [...entries, answer], extra);
    await frames(2);
    expect(
      Math.abs(listRef.current!.getScrollableNode()!.scrollTop - original),
    ).toBeLessThanOrEqual(1);
  }
  await expect.poll(() => onUnreadBelowChange.mock.lastCall?.[0]).toBe(1);
  await listRef.current!.scrollToEnd({ animated: false });
  await expect.poll(() => onUnreadBelowChange.mock.lastCall?.[0]).toBe(0);
  await listRef.current!.scrollToOffset({ offset: 250, animated: false });
  render(
    "geometry:unread",
    [...entries, { ...answer, message: { ...answer.message, streaming: false } }],
    extra,
  );
  await frames(5);
  expect(onUnreadBelowChange.mock.lastCall?.[0]).toBe(0);
});

it("reveals a growing answer only until the sent prompt text reaches the top margin", async () => {
  const entries = Array.from({ length: 10 }, (_, i) => entry(i));
  render("geometry:bounded", entries);
  await expect.poll(() => readTimelinePosition("geometry:bounded")).toBeDefined();
  const node = listRef.current!.getScrollableNode()!;
  const initial = node.scrollTop;
  let answer = {
    ...entry(20),
    message: {
      ...entry(20).message,
      role: "assistant" as const,
      streaming: true,
      text: "Beginning of the answer.",
    },
  };
  const extra = { readingFollowPromptId: entries[9]!.message.id };
  for (let chunk = 0; chunk < 20; chunk++) {
    answer = {
      ...answer,
      message: {
        ...answer.message,
        text:
          answer.message.text +
          "\n\nA readable paragraph that grows below the beginning. ".repeat(2),
      },
    };
    render("geometry:bounded", [...entries, answer], extra);
    await frames(5);
  }
  const promptTextTop = () => {
    const state = listRef.current!.getState();
    const index = state.data.findIndex(
      (row: { message?: { id: string } }) => row.message?.id === entries[9]!.message.id,
    );
    const body = state.elementAtIndex(index)!.querySelector('[data-user-message-body="true"]')!;
    return body.getBoundingClientRect().top - node.getBoundingClientRect().top;
  };
  await expect.poll(promptTextTop).toBeLessThanOrEqual(25);
  expect(promptTextTop()).toBeGreaterThanOrEqual(23);
  expect(node.scrollTop).toBeGreaterThan(initial);
  const capped = node.scrollTop;
  render(
    "geometry:bounded",
    [
      ...entries,
      {
        ...answer,
        message: { ...answer.message, text: answer.message.text.repeat(3), streaming: false },
      },
    ],
    extra,
  );
  await frames(12);
  expect(Math.abs(node.scrollTop - capped)).toBeLessThanOrEqual(1);
});

it("manual scrolling cancels limited answer following without rearming it", async () => {
  const entries = Array.from({ length: 10 }, (_, i) => entry(i));
  render("geometry:bounded-cancel", entries);
  await expect.poll(() => readTimelinePosition("geometry:bounded-cancel")).toBeDefined();
  const node = listRef.current!.getScrollableNode()!;
  const answer = {
    ...entry(20),
    message: {
      ...entry(20).message,
      role: "assistant" as const,
      streaming: true,
      text: "Beginning.",
    },
  };
  const extra = { readingFollowPromptId: entries[9]!.message.id };
  render("geometry:bounded-cancel", [...entries, answer], extra);
  await frames(3);
  node.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, bubbles: true }));
  await listRef.current!.scrollToOffset({ offset: node.scrollTop - 80, animated: false });
  await frames(3);
  const original = node.scrollTop;
  render(
    "geometry:bounded-cancel",
    [
      ...entries,
      { ...answer, message: { ...answer.message, text: "Long answer.\n\n".repeat(300) } },
    ],
    extra,
  );
  await frames(12);
  expect(Math.abs(node.scrollTop - original)).toBeLessThanOrEqual(1);
});

it("keeps the sent prompt visible even when a full answer arrives before layout settles", async () => {
  const entries = Array.from({ length: 10 }, (_, i) => entry(i));
  render("geometry:fast-answer", entries);
  await expect.poll(() => readTimelinePosition("geometry:fast-answer")).toBeDefined();
  const prompt = entry(10, "New question");
  const answer = {
    ...entry(11),
    message: {
      ...entry(11).message,
      role: "assistant" as const,
      text: "Beginning of a fast answer.\n\n".repeat(90),
    },
  };
  const extra = { readingFollowPromptId: prompt.message.id };
  render("geometry:fast-answer", [...entries, prompt, answer], {
    ...extra,
    timelinePositioningPending: true,
  });
  await frames(4);
  const list = listRef.current!;
  render("geometry:fast-answer", [...entries, prompt, answer], extra);
  await expect
    .poll(() => {
      const state = list.getState();
      const answerIndex = state.data.findIndex(
        (row: { message?: { id: string } }) => row.message?.id === prompt.message.id,
      );
      return (
        state
          .elementAtIndex(answerIndex)!
          .querySelector('[data-user-message-body="true"]')!
          .getBoundingClientRect().top - list.getScrollableNode()!.getBoundingClientRect().top
      );
    })
    .toBeLessThanOrEqual(25);
  const state = list.getState();
  const answerIndex = state.data.findIndex(
    (row: { message?: { id: string } }) => row.message?.id === prompt.message.id,
  );
  expect(
    state
      .elementAtIndex(answerIndex)!
      .querySelector('[data-user-message-body="true"]')!
      .getBoundingClientRect().top - list.getScrollableNode()!.getBoundingClientRect().top,
  ).toBeGreaterThanOrEqual(23);
});

it("retains the reading position when the same thread briefly has no loaded rows", async () => {
  const entries = Array.from({ length: 20 }, (_, i) => entry(i));
  render("geometry:reload-window", entries);
  await expect.poll(() => readTimelinePosition("geometry:reload-window")).toBeDefined();
  await listRef.current!.scrollToOffset({ offset: 900, animated: false });
  await expect
    .poll(() => readTimelinePosition("geometry:reload-window")?.scrollOffset)
    .toBeGreaterThan(800);
  const saved = readTimelinePosition("geometry:reload-window")!;
  render("geometry:reload-window", [], { positionHistoryLoading: true });
  await frames();
  render("geometry:reload-window", entries);
  await expect
    .poll(
      () => {
        const list = listRef.current!;
        const state = list.getState();
        const index = state.data.findIndex(
          (row: { message?: { id: string } }) => row.message?.id === saved.messageId,
        );
        const element = state.elementAtIndex(index);
        return element
          ? Math.abs(
              list.getScrollableNode()!.getBoundingClientRect().top -
                element.getBoundingClientRect().top -
                saved.offsetWithinRow,
            )
          : Infinity;
      },
      { timeout: 5000 },
    )
    .toBeLessThanOrEqual(2);
});

it("allows three of the answer's lines hidden, but not more, at different text sizes", async () => {
  const answer = {
    ...entry(20),
    message: {
      ...entry(20).message,
      role: "assistant" as const,
      text: "Answer paragraph. ".repeat(60),
    },
  };
  render("geometry:three-line-end", [...Array.from({ length: 20 }, (_, i) => entry(i)), answer]);
  await expect.poll(() => readTimelinePosition("geometry:three-line-end")).toBeDefined();
  const list = listRef.current!;
  const node = list.getScrollableNode()!;
  const inset = base.contentInsetEndAdjustment;
  for (const lineHeight of [20, 28, 36]) {
    const body = node.querySelector<HTMLElement>('[data-message-id="message-20"] .chat-markdown')!;
    body.style.fontSize = `${lineHeight / 1.5}px`;
    body.style.lineHeight = `${lineHeight}px`;
    await frames(6);
    // Scroll offset at which the answer's text end sits exactly at the visible bottom.
    const state = list.getState();
    const atTextEnd = withReadingEnd(state, inset)!.contentLength - state.scrollLength;
    for (const hiddenLines of [0, 1, 2, 2.9, 3.3, 4]) {
      await list.scrollToOffset({ offset: atTextEnd - lineHeight * hiddenLines, animated: false });
      await frames(2);
      expect(
        readerAtReadingEnd(list.getState(), inset),
        JSON.stringify({ lineHeight, hiddenLines }),
      ).toBe(hiddenLines <= 3);
    }
  }
});
