import "../../index.css";
import { EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import { readSendScrollAllowance } from "./readerScrollPolicy";
import { MessagesTimeline } from "./MessagesTimeline";
import { readTimelinePosition, rememberTimelinePosition } from "./timelineScrollAnchoring";

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
    sendAnchorPending: true,
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

it("allows two rendered lines on send, but not more, at different text sizes", async () => {
  render(
    "geometry:two-line-send",
    Array.from({ length: 20 }, (_, i) => entry(i)),
  );
  await expect.poll(() => readTimelinePosition("geometry:two-line-send")).toBeDefined();
  const list = listRef.current!;
  const node = list.getScrollableNode()!;
  for (const lineHeight of [20, 28, 36]) {
    const body = node.querySelector<HTMLElement>('[data-message-id="message-19"] .chat-markdown')!;
    body.style.fontSize = `${lineHeight / 1.5}px`;
    body.style.lineHeight = `${lineHeight}px`;
    await frames(6);
    expect(readSendScrollAllowance(node)).toBe(lineHeight * 2);
    const state = list.getState();
    const bottom = state.contentLength - state.scrollLength;
    for (const hiddenLines of [0, 1, 2, 2.1, 3]) {
      await list.scrollToOffset({ offset: bottom - lineHeight * hiddenLines, animated: false });
      await frames(2);
      expect(
        resolveTimelineIsAtEnd(list.getState(), readSendScrollAllowance(node)),
        JSON.stringify({
          lineHeight,
          hiddenLines,
          allowance: readSendScrollAllowance(node),
          gap:
            list.getState().contentLength - list.getState().scroll - list.getState().scrollLength,
        }),
      ).toBe(hiddenLines <= 2);
    }
  }
});
