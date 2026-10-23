import {
  fakeTimers,
  act as _fixtureAct,
  render as _fixtureRender,
  type Screen,
} from "../../../test/render";
import { useStableCallback } from "~/hooks/useStableCallback";
import "../../index.css";
import { EnvironmentId, MessageId, ProviderInstanceId, RunId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { StrictMode, createRef, useLayoutEffect, useRef, useState } from "react";

import { expect, it, vi } from "vite-plus/test";
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import { readerAtReadingEnd, readingEndGapOnScreen, withReadingEnd } from "./readerScrollPolicy";
import { MessagesTimeline } from "./MessagesTimeline";
import { HandoffRow } from "./V2LifecycleRow";
import { useTimelineEndControl } from "./useTimelineEndControl";
import { readTimelinePosition, rememberTimelinePosition } from "./timelineScrollAnchoring";

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
      runId: RunId.make(`run-${index}`),
      createdAt: date,
      updatedAt: date,
      streaming: false,
    },
  };
}

/** Legend's receipt needs scheduled work; waitFor drives the owned clock while it is pending. */
async function scroll(operation: () => Promise<void>) {
  let receipt!: Promise<void>;
  await _fixtureAct(() => {
    receipt = operation();
  });
  await vi.waitFor(() => receipt);
}

async function advanceClock(ms = 64) {
  await _fixtureAct(() => vi.advanceTimersByTimeAsync(ms));
}
async function mountHost(_fixture: _Fixture) {
  if (!_fixture.host) {
    _fixture.host = document.createElement("div");
    Object.assign(_fixture.host.style, { width: "720px", height: "600px" });
    document.body.append(_fixture.host);
    // No routed controls are exercised in this measured viewport fixture.
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
    _fixture.timers ??= _fixture.cleanup.use(fakeTimers());
  }
}
async function render(
  _fixture: _Fixture,
  key: string,
  entries: React.ComponentProps<typeof MessagesTimeline>["timelineEntries"],
  extra: Partial<React.ComponentProps<typeof MessagesTimeline>> = {},
) {
  await mountHost(_fixture);
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

it("holds a measured viewport through repeated appended rows and completion", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  let entries = Array.from({ length: 20 }, (_, i) => entry(i));
  await render(_fixture, "geometry:stream", entries);
  await vi.waitFor(() => {
    expect(_fixture.listRef.current?.getScrollableNode()?.scrollTop ?? 0).toBeGreaterThan(0);
  });
  // Opening a thread holds the end until its rows stop growing; a position is
  // saved only once that is done. Only then is the reader moved up, or the
  // opening's own settling would take them back to the end.
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:stream")).toBeDefined();
  });
  await advanceClock();
  const node = _fixture.listRef.current!.getScrollableNode()!;
  await scroll(() => _fixture.listRef.current!.scrollToOffset({ offset: 300, animated: false }));
  await advanceClock();
  const original = node.scrollTop;
  // The reader really is away from the end, reading at 300.
  expect(Math.abs(original - 300)).toBeLessThanOrEqual(1);
  for (let i = 20; i < 45; i++) {
    entries.push(entry(i));
    await render(_fixture, "geometry:stream", entries, { isWorking: true });
    await advanceClock(32);
    expect(Math.abs(node.scrollTop - original)).toBeLessThanOrEqual(1);
  }
  await render(_fixture, "geometry:stream", entries, { isWorking: false });
  await advanceClock();
  expect(Math.abs(node.scrollTop - original)).toBeLessThanOrEqual(1);
});

it("restores the same message after switching threads with a saved at-end position", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const entries = Array.from({ length: 15 }, (_, i) => entry(i));
  await render(_fixture, "geometry:a", entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:a")?.messageId).toBeDefined();
  });
  const saved = readTimelinePosition("geometry:a")!;
  await render(
    _fixture,
    "geometry:b",
    Array.from({ length: 4 }, (_, i) => entry(i + 100)),
  );
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:b")).toBeDefined();
  });
  await render(_fixture, "geometry:a", [
    ...entries,
    ...Array.from({ length: 10 }, (_, i) => entry(i + 15)),
  ]);
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:a")?.messageId).toBe(saved.messageId);
  });
  await advanceClock(96);
  const node = _fixture.listRef.current!.getScrollableNode()!;
  await vi.waitFor(() => {
    expect(
      (() => {
        const live = _fixture.listRef.current!.getState();
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
      })(),
    ).toBeLessThanOrEqual(2);
  });
});

it("captures the last scroll before an immediate thread switch", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const entries = Array.from({ length: 20 }, (_, i) => entry(i));
  await render(_fixture, "geometry:quick-switch", entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:quick-switch")).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToOffset({ offset: 300, animated: false }));
  await advanceClock();
  const node = _fixture.listRef.current!.getScrollableNode()!;
  // No timer, polling, or animation frame between this gesture and navigation.
  node.scrollTop += 35;
  node.dispatchEvent(new Event("scroll"));
  const expectedOffset = node.scrollTop;
  await render(_fixture, "geometry:quick-other", [entry(100)]);
  await advanceClock(128);
  await render(_fixture, "geometry:quick-switch", entries);
  await advanceClock(256);
  expect(_fixture.listRef.current!.getScrollableNode()!.scrollTop).toBeCloseTo(expectedOffset, 0);
});

it("flushes the latest captured position on pagehide before the storage debounce", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await render(
    _fixture,
    "geometry:pagehide",
    Array.from({ length: 20 }, (_, i) => entry(i)),
  );
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:pagehide")).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToOffset({ offset: 300, animated: false }));
  await advanceClock();
  const node = _fixture.listRef.current!.getScrollableNode()!;
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

it("keeps a held thread's exact reading and follow receipt through scroll, pagehide and unmount", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "geometry:held-follow-receipt";
  const entries = Array.from({ length: 20 }, (_, i) => entry(i));
  await render(_fixture, key, entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToOffset({ offset: 300, animated: false }));
  await advanceClock();
  const captured = readTimelinePosition(key)!;
  const saved = { ...captured, atEnd: false, followingPromptId: "message-19" };
  rememberTimelinePosition(key, saved);

  await render(_fixture, key, entries, { paintOnly: true });
  const node = _fixture.listRef.current!.getScrollableNode()!;
  node.scrollTop += 35;
  node.dispatchEvent(new Event("scroll"));
  await advanceClock();
  expect(readTimelinePosition(key)).toEqual(saved);
  window.dispatchEvent(new Event("pagehide"));
  expect(readTimelinePosition(key)).toEqual(saved);
  await _fixture.root0?.unmount();
  _fixture.root0 = undefined;
  expect(readTimelinePosition(key)).toEqual(saved);
});

it("does not offer a jump into reserved blank space but reports a hidden answer", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const prompt = entry(0, "Short prompt");
  const onIsAtEndChange = vi.fn();
  const answer = (text: string) => ({
    ...entry(1, text),
    message: { ...entry(1, text).message, role: "assistant" as const },
  });
  const extra = {
    anchorMessageId: prompt.message.id,
    onAnchorReady: (_id: MessageId, index: number) => {
      void _fixture.listRef.current!.scrollToIndex({
        index,
        viewPosition: 0,
        viewOffset: 24,
        animated: false,
      });
    },
    onIsAtEndChange,
  };
  await render(_fixture, "geometry:reserved-end", [prompt], extra);
  await advanceClock(256);
  expect(onIsAtEndChange.mock.lastCall?.[0]).toBe(true);
  await render(_fixture, "geometry:reserved-end", [prompt, answer("Short answer")], extra);
  await advanceClock(128);
  expect(onIsAtEndChange.mock.lastCall?.[0]).toBe(true);
  // The send gate must agree with the end control even while padding remains.
  expect(
    readerAtReadingEnd(
      _fixture.listRef.current!.getState(),
      _fixture.base.contentInsetEndAdjustment,
    ),
  ).toBe(true);
  await render(
    _fixture,
    "geometry:reserved-end",
    [prompt, answer("Long answer\n\n".repeat(100))],
    extra,
  );
  await advanceClock(128);
  expect(onIsAtEndChange.mock.lastCall?.[0]).toBe(false);
});

it("never paints a cold thread at the beginning before positioning at its end", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await render(
    _fixture,
    "geometry:first-paint",
    Array.from({ length: 25 }, (_, i) => entry(i)),
  );
  let visibleFrames = 0;
  for (let i = 0; i < 16; i++) {
    await advanceClock(16);
    const node = _fixture.listRef.current!.getScrollableNode()!;
    if (getComputedStyle(node).visibility !== "hidden") {
      visibleFrames++;
      expect(node.scrollTop).toBeGreaterThan(0);
      expect(resolveTimelineIsAtEnd(_fixture.listRef.current!.getState())).toBe(true);
    }
  }
  expect(visibleFrames).toBeGreaterThan(0);
});

it("does not apply an unrelated offset when a transient saved row disappeared", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const entries = Array.from({ length: 20 }, (_, i) => entry(i));
  rememberTimelinePosition("geometry:transient", {
    rowId: "working-indicator-row",
    turnId: "run-7",
    offsetWithinRow: 0,
    scrollOffset: 99999,
    atEnd: false,
  });
  await render(_fixture, "geometry:transient", entries);
  await vi.waitFor(() => {
    expect(
      _fixture.listRef.current
        ?.getState()
        .data.some((row: { message?: { id: string } }) => row.message?.id === "message-7"),
    ).toBe(true);
  });
  await advanceClock(192);
  const state = _fixture.listRef.current!.getState();
  const index = state.data.findIndex(
    (row: { message?: { id: string } }) => row.message?.id === "message-7",
  );
  const node = _fixture.listRef.current!.getScrollableNode()!;
  const element = state.elementAtIndex(index)!;
  expect(
    Math.abs(element.getBoundingClientRect().top - node.getBoundingClientRect().top),
  ).toBeLessThanOrEqual(2);
});

it("does not follow a growing answer even when the reader starts at the bottom", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const entries = Array.from({ length: 12 }, (_, i) => entry(i));
  await render(_fixture, "geometry:bottom-growth", entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:bottom-growth")).toBeDefined();
  });
  const node = _fixture.listRef.current!.getScrollableNode()!;
  const original = node.scrollTop;
  for (let i = 0; i < 20; i++) {
    await render(_fixture, "geometry:bottom-growth", [
      ...entries,
      ...Array.from({ length: i + 1 }, (_, n) => entry(n + 12)),
    ]);
    await advanceClock(32);
    expect(Math.abs(node.scrollTop - original)).toBeLessThanOrEqual(1);
  }
});

it("waits for older history before restoring a saved reading message", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const old = entry(7);
  rememberTimelinePosition("geometry:paged", {
    rowId: old.id,
    messageId: old.message.id,
    // The persisted field is still named `turnId`; the timeline is keyed on runs.
    ...(old.message.runId ? { turnId: old.message.runId } : {}),
    offsetWithinRow: 0,
    scrollOffset: 8000,
    atEnd: false,
  });
  const recent = Array.from({ length: 10 }, (_, i) => entry(i + 30));
  const load = vi.fn();
  await render(_fixture, "geometry:paged", recent, {
    loadEarlier: { loading: false, cursor: "page-2", onLoadEarlier: load },
  });
  await vi.waitFor(() => {
    expect(load.mock.calls.length).toBe(1);
  });
  await advanceClock();
  expect(readTimelinePosition("geometry:paged")?.messageId).toBe(old.message.id);
  await render(_fixture, "geometry:paged", [
    ...Array.from({ length: 30 }, (_, i) => entry(i)),
    ...recent,
  ]);
  await vi.waitFor(() => {
    expect(
      (() => {
        const state = _fixture.listRef.current!.getState();
        const index = state.data.findIndex(
          (row: { message?: { id: string } }) => row.message?.id === old.message.id,
        );
        const element = state.elementAtIndex(index);
        const node = _fixture.listRef.current!.getScrollableNode()!;
        return element
          ? Math.abs(element.getBoundingClientRect().top - node.getBoundingClientRect().top)
          : Infinity;
      })(),
    ).toBeLessThanOrEqual(2);
  });
});

it("manual navigation cancels restoration while history is still loading", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  rememberTimelinePosition("geometry:cancel", {
    rowId: "gone",
    messageId: "message-1",
    turnId: "run-1",
    offsetWithinRow: 0,
    scrollOffset: 9000,
    atEnd: false,
  });
  const recent = Array.from({ length: 15 }, (_, i) => entry(i + 50));
  const load = vi.fn();
  await render(_fixture, "geometry:cancel", recent, {
    loadEarlier: { loading: false, cursor: "older", onLoadEarlier: load },
  });
  await vi.waitFor(() => {
    expect(load.mock.calls.length).toBe(1);
  });
  await advanceClock();
  const node = _fixture.listRef.current!.getScrollableNode()!;
  node.dispatchEvent(new WheelEvent("wheel", { deltaY: 200, bubbles: true }));
  await scroll(() => _fixture.listRef.current!.scrollToOffset({ offset: 350, animated: false }));
  await advanceClock();
  const before = _fixture.listRef.current!.getState();
  const rowIndex = before.data.findIndex(
    (row: { message?: { id: string } }) => row.message?.id === "message-51",
  );
  const original = before.elementAtIndex(rowIndex)!.getBoundingClientRect().top;
  await render(_fixture, "geometry:cancel", recent, { loadEarlier: null });
  await advanceClock(160);
  expect(
    Math.abs(
      _fixture.listRef.current!.getState().elementAtIndex(rowIndex)!.getBoundingClientRect().top -
        original,
    ),
  ).toBeLessThanOrEqual(1);
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:cancel")?.messageId).not.toBe("message-1");
  });
});

it("keeps the saved reading position while a send is being placed", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const entries = Array.from({ length: 20 }, (_, i) => entry(i));
  await render(_fixture, "geometry:single-writer", entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:single-writer")?.messageId).toBeDefined();
  });
  await advanceClock();
  const saved = readTimelinePosition("geometry:single-writer")!;
  // While the placement is in flight, scrolling saves nothing: the record that
  // names its message stays (no raw record without one replaces it).
  await render(_fixture, "geometry:single-writer", entries, { timelinePositioningPending: true });
  await scroll(() => _fixture.listRef.current!.scrollToOffset({ offset: 300, animated: false }));
  _fixture.listRef.current!.getScrollableNode()!.dispatchEvent(new Event("scroll"));
  await advanceClock(96);
  expect(readTimelinePosition("geometry:single-writer")).toEqual(saved);
  // Once it is done, the reader's place is saved again, by message.
  await render(_fixture, "geometry:single-writer", entries, { timelinePositioningPending: false });
  _fixture.listRef.current!.getScrollableNode()!.dispatchEvent(new Event("scroll"));
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:single-writer")?.offsetWithinRow).not.toBe(
      saved.offsetWithinRow,
    );
  });
  expect(readTimelinePosition("geometry:single-writer")?.messageId).toBeDefined();
});

it("keeps existing first-message framing and short-answer space through completion", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const entries: ReturnType<typeof entry>[] = [];
  const followUp = entry(8, "Follow-up prompt");
  let positioned = false;
  const onAnchorReady = (_id: MessageId, index: number) => {
    if (positioned) return;
    positioned = true;
    void _fixture.listRef.current!.scrollToIndex({
      index,
      viewPosition: 0,
      viewOffset: 24,
      animated: false,
    });
  };
  const extra = { anchorMessageId: followUp.message.id, onAnchorReady };
  await render(_fixture, "geometry:anchor", [...entries, followUp], extra);
  await vi.waitFor(() => {
    expect(positioned).toBe(true);
  });
  await advanceClock(192);
  const node = _fixture.listRef.current!.getScrollableNode()!;
  const original = node.scrollTop;
  await render(
    _fixture,
    "geometry:anchor",
    [...entries, followUp, entry(9, "Short answer")],
    extra,
  );
  await advanceClock(128);
  expect(Math.abs(node.scrollTop - original)).toBeLessThanOrEqual(1);
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:anchor")?.anchorMessageId).toBe(followUp.message.id);
  });
  const saved = readTimelinePosition("geometry:anchor")!;
  await _fixture.root0!.unmount();
  _fixture.host!.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
  await render(_fixture, "geometry:anchor", [...entries, followUp, entry(9, "Short answer")], {
    ...extra,
    onAnchorReady: () => {},
  });
  await vi.waitFor(() => {
    expect(_fixture.listRef.current?.getScrollableNode()?.scrollTop).toBeCloseTo(original, 0);
  });
  expect(readTimelinePosition("geometry:anchor")?.messageId).toBe(saved.messageId);
});

it("preserves the original near-bottom tolerance for lines hidden by the composer", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await render(
    _fixture,
    "geometry:strict-edge",
    Array.from({ length: 20 }, (_, i) => entry(i)),
  );
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:strict-edge")).toBeDefined();
  });
  const list = _fixture.listRef.current!;
  const initial = list.getScrollableNode()!.scrollTop;
  expect(resolveTimelineIsAtEnd(list.getState())).toBe(true);
  await scroll(() => list.scrollToOffset({ offset: initial - 20, animated: false }));
  await advanceClock();
  expect(resolveTimelineIsAtEnd(list.getState())).toBe(true);
  await scroll(() => list.scrollToOffset({ offset: initial - 80, animated: false }));
  await advanceClock();
  expect(resolveTimelineIsAtEnd(list.getState())).toBe(false);
});

it("counts new answers below the reader once while streaming, then clears them on reaching them", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const entries = Array.from({ length: 15 }, (_, i) => entry(i));
  const onUnreadBelowChange = vi.fn();
  const extra = { onUnreadBelowChange };
  await render(_fixture, "geometry:unread", entries, extra);
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:unread")).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToOffset({ offset: 250, animated: false }));
  await advanceClock();
  const original = _fixture.listRef.current!.getScrollableNode()!.scrollTop;
  let answer = {
    ...entry(20),
    message: { ...entry(20).message, role: "assistant" as const, streaming: true },
  };
  for (let chunk = 0; chunk < 12; chunk++) {
    answer = {
      id: answer.id,
      kind: answer.kind,
      createdAt: answer.createdAt,
      message: {
        ...answer.message,
        text: answer.message.text + "\n\nAnother paragraph. ".repeat(4),
      },
    };
    await render(_fixture, "geometry:unread", [...entries, answer], extra);
    await advanceClock(32);
    expect(
      Math.abs(_fixture.listRef.current!.getScrollableNode()!.scrollTop - original),
    ).toBeLessThanOrEqual(1);
  }
  await vi.waitFor(() => {
    expect(onUnreadBelowChange.mock.lastCall?.[0]).toBe(1);
  });
  await scroll(() => _fixture.listRef.current!.scrollToEnd({ animated: false }));
  // A streaming answer shows nothing until its first lines appear (after a
  // short wait): an answer not yet seen is not read. Once they show at the
  // end, it is.
  const revealFront = () =>
    Number.parseFloat(
      _fixture
        .host!.querySelector<HTMLElement>('[data-message-id="message-20"] .chat-markdown')
        ?.style.getPropertyValue("--reveal-front") || "0",
    );
  // The reveal runs on the clock after its wait; a slow runner needs more than the default second.
  await vi.waitFor(() => {
    expect(revealFront()).toBeGreaterThan(0);
  });
  await vi.waitFor(() => {
    expect(onUnreadBelowChange.mock.lastCall?.[0]).toBe(0);
  });
  await scroll(() => _fixture.listRef.current!.scrollToOffset({ offset: 250, animated: false }));
  await render(
    _fixture,
    "geometry:unread",
    [...entries, { ...answer, message: { ...answer.message, streaming: false } }],
    extra,
  );
  await advanceClock(80);
  expect(onUnreadBelowChange.mock.lastCall?.[0]).toBe(0);
});

it("reveals a growing answer only until the sent prompt text reaches the top margin", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const entries = Array.from({ length: 10 }, (_, i) => entry(i));
  await render(_fixture, "geometry:bounded", entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:bounded")).toBeDefined();
  });
  const node = _fixture.listRef.current!.getScrollableNode()!;
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
      id: answer.id,
      kind: answer.kind,
      createdAt: answer.createdAt,
      message: {
        ...answer.message,
        text:
          answer.message.text +
          "\n\nA readable paragraph that grows below the beginning. ".repeat(2),
      },
    };
    await render(_fixture, "geometry:bounded", [...entries, answer], extra);
    await advanceClock(80);
  }
  const promptTextTop = () => {
    const state = _fixture.listRef.current!.getState();
    const index = state.data.findIndex(
      (row: { message?: { id: string } }) => row.message?.id === entries[9]!.message.id,
    );
    const body = state.elementAtIndex(index)!.querySelector('[data-user-message-body="true"]')!;
    return body.getBoundingClientRect().top - node.getBoundingClientRect().top;
  };
  // The same eased reveal; a slow runner needs more than the default second.
  await vi.waitFor(() => {
    expect(promptTextTop()).toBeLessThanOrEqual(25);
  });
  expect(promptTextTop()).toBeGreaterThanOrEqual(23);
  expect(node.scrollTop).toBeGreaterThan(initial);
  const capped = node.scrollTop;
  await render(
    _fixture,
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
  await advanceClock(192);
  expect(Math.abs(node.scrollTop - capped)).toBeLessThanOrEqual(1);
});

it("manual scrolling cancels limited answer following without rearming it", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const entries = Array.from({ length: 10 }, (_, i) => entry(i));
  await render(_fixture, "geometry:bounded-cancel", entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:bounded-cancel")).toBeDefined();
  });
  const node = _fixture.listRef.current!.getScrollableNode()!;
  const answer = {
    ...entry(20),
    message: {
      ...entry(20).message,
      role: "assistant" as const,
      streaming: true,
      text: "Beginning.",
    },
  };
  // A streaming answer belongs to a working run. On an idle thread, a reader
  // still within the end's last lines is kept at the end instead, which is
  // not the follow this test is about.
  const extra = { readingFollowPromptId: entries[9]!.message.id, isWorking: true };
  await render(_fixture, "geometry:bounded-cancel", [...entries, answer], extra);
  await advanceClock(48);
  node.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, bubbles: true }));
  await scroll(() =>
    _fixture.listRef.current!.scrollToOffset({ offset: node.scrollTop - 80, animated: false }),
  );
  await advanceClock(48);
  const original = node.scrollTop;
  await render(
    _fixture,
    "geometry:bounded-cancel",
    [
      ...entries,
      { ...answer, message: { ...answer.message, text: "Long answer.\n\n".repeat(300) } },
    ],
    extra,
  );
  await advanceClock(192);
  expect(Math.abs(node.scrollTop - original)).toBeLessThanOrEqual(1);
});

it("keeps the sent prompt visible even when a full answer arrives before layout settles", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const entries = Array.from({ length: 10 }, (_, i) => entry(i));
  await render(_fixture, "geometry:fast-answer", entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:fast-answer")).toBeDefined();
  });
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
  await render(_fixture, "geometry:fast-answer", [...entries, prompt, answer], {
    ...extra,
    timelinePositioningPending: true,
  });
  await advanceClock(64);
  const list = _fixture.listRef.current!;
  await render(_fixture, "geometry:fast-answer", [...entries, prompt, answer], extra);
  // Observe the prompt alignment reached by the controlled reveal.
  await vi.waitFor(() => {
    expect(
      (() => {
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
      })(),
    ).toBeLessThanOrEqual(25);
  });
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
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const entries = Array.from({ length: 20 }, (_, i) => entry(i));
  await render(_fixture, "geometry:reload-window", entries);
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:reload-window")).toBeDefined();
  });
  await scroll(() => _fixture.listRef.current!.scrollToOffset({ offset: 900, animated: false }));
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:reload-window")?.scrollOffset).toBeGreaterThan(800);
  });
  const saved = readTimelinePosition("geometry:reload-window")!;
  await render(_fixture, "geometry:reload-window", [], { positionHistoryLoading: true });
  await advanceClock();
  await render(_fixture, "geometry:reload-window", entries);
  await vi.waitFor(() => {
    expect(
      (() => {
        const list = _fixture.listRef.current!;
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
      })(),
    ).toBeLessThanOrEqual(2);
  });
});

it("allows three of the answer's lines hidden, but not more, at different text sizes", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const answer = {
    ...entry(20),
    message: {
      ...entry(20).message,
      role: "assistant" as const,
      text: "Answer paragraph. ".repeat(60),
    },
  };
  await render(_fixture, "geometry:three-line-end", [
    ...Array.from({ length: 20 }, (_, i) => entry(i)),
    answer,
  ]);
  await vi.waitFor(() => {
    expect(readTimelinePosition("geometry:three-line-end")).toBeDefined();
  });
  const list = _fixture.listRef.current!;
  const node = list.getScrollableNode()!;
  const inset = _fixture.base.contentInsetEndAdjustment;
  for (const lineHeight of [20, 28, 36]) {
    const body = node.querySelector<HTMLElement>('[data-message-id="message-20"] .chat-markdown')!;
    body.style.fontSize = `${lineHeight / 1.5}px`;
    body.style.lineHeight = `${lineHeight}px`;
    await advanceClock(96);
    // Native resize delivery is not driven by the controlled clock.
    await vi.waitFor(() => {
      const state = list.getState();
      const answerIndex = state.data.findIndex(
        (row: { message?: { id: string } }) => row.message?.id === answer.message.id,
      );
      const row = state.elementAtIndex(answerIndex);
      expect(row).toBeInstanceOf(HTMLElement);
      expect(state.sizeAtIndex(answerIndex)).toBe(row!.getBoundingClientRect().height);
    });
    // Scroll offset at which the answer's text end sits exactly at the visible bottom.
    const state = list.getState();
    const atTextEnd = withReadingEnd(state, inset)!.contentLength - state.scrollLength;
    for (const hiddenLines of [0, 1, 2, 2.9, 3.3, 4]) {
      await scroll(() =>
        list.scrollToOffset({ offset: atTextEnd - lineHeight * hiddenLines, animated: false }),
      );
      await advanceClock(32);
      expect(
        readerAtReadingEnd(list.getState(), inset),
        JSON.stringify({ lineHeight, hiddenLines }),
      ).toBe(hiddenLines <= 3);
    }
  }
});

it("remeasures pending handoff footer layout and clears end navigation through the reader owner", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const key = "geometry:pending-handoff-end";
  const answer = {
    ...entry(13),
    message: {
      ...entry(13).message,
      role: "assistant" as const,
      text:
        "## Completed answer\n\n" +
        "A readable scientific paragraph. ".repeat(80) +
        "\n\n| Sample | Value |\n| --- | --- |\n| A | 1 |\n| B | 4 |\n\nThe final answer ends here.",
    },
  };
  const entries = [...Array.from({ length: 13 }, (_, index) => entry(index)), answer];
  const providers: React.ComponentProps<typeof HandoffRow>["providers"] = [];
  const endpoints = {
    from: [{ instanceId: ProviderInstanceId.make("pi"), model: "same-model" }],
    to: { instanceId: ProviderInstanceId.make("pi_visual"), model: "same-model" },
  };
  let resizeFooter: (height: number) => void = () => {
    throw new Error("The pending footer has not mounted.");
  };
  let positionedThreadKey: string | null = null;
  const reports: Array<{
    atEnd: boolean;
    measuredGap: number | null;
    predicate: boolean | undefined;
    scrollTop: number;
    virtualScroll: number;
    virtualViewport: number;
    positionedThreadKey: string | null;
  }> = [];
  function PendingFooter() {
    const [height, setHeight] = useState(32);
    useLayoutEffect(() => {
      resizeFooter = setHeight;
    }, []);
    return (
      <div
        className="chat-content-lane"
        data-pending-handoff-appendix
        style={{ minHeight: height }}
      >
        <HandoffRow environmentId={env} endpoints={endpoints} providers={providers} pending />
      </div>
    );
  }
  function Reader({ pending }: { pending: boolean }) {
    const isAtEndRef = useRef(true);
    const control = useTimelineEndControl({ isAtEndRef, onReachedEnd: () => {} });
    const report = useStableCallback((atEnd: boolean) => {
      const list = _fixture.listRef.current;
      const viewport = list?.getScrollableNode();
      const state = list?.getState();
      if (state && viewport)
        reports.push({
          atEnd,
          measuredGap: readingEndGapOnScreen(
            state,
            viewport,
            _fixture.base.contentInsetEndAdjustment,
          ),
          predicate: readerAtReadingEnd(state, _fixture.base.contentInsetEndAdjustment),
          scrollTop: viewport.scrollTop,
          virtualScroll: state.scroll,
          virtualViewport: state.scrollLength,
          positionedThreadKey,
        });
      control.onIsAtEndChange(atEnd);
    });
    return (
      <div style={{ position: "relative", height: "100%" }}>
        <MessagesTimeline
          emptyPlaceholderInset={0}
          {..._fixture.base}
          routeThreadKey={key}
          timelineEntries={entries}
          footer={pending ? <PendingFooter /> : null}
          onIsAtEndChange={report}
          onPositionedThreadKeyChange={(nextKey) => {
            positionedThreadKey = nextKey;
          }}
        />
        {control.showScrollToBottom ? (
          <button
            type="button"
            data-reader-end-control
            onPointerDown={(event) => event.preventDefault()}
            style={{ position: "absolute", bottom: _fixture.base.contentInsetEndAdjustment + 4 }}
            onClick={async () => {
              await _fixture.listRef.current?.scrollToEnd({ animated: false });
              _fixture.listRef.current?.getScrollableNode()?.dispatchEvent(new Event("scroll"));
            }}
          >
            Scroll to end
          </button>
        ) : null}
      </div>
    );
  }
  const renderControlled = async (pending: boolean) => {
    await mountHost(_fixture);
    await _fixtureAct(
      async () =>
        await _fixture.root0!.rerender(
          <StrictMode>
            <Reader pending={pending} />
          </StrictMode>,
        ),
    );
  };
  await renderControlled(false);
  await vi.waitFor(() => {
    expect(positionedThreadKey).toBe(key);
  });
  // Production's StrictMode replays effect cleanup/setup before the first RAF.
  // A cancelled frame must not leave the only bookkeeping owner permanently busy.
  await vi.waitFor(() => {
    expect(
      reports.length,
      "Reader bookkeeping must resume after StrictMode effect replay.",
    ).toBeGreaterThan(0);
  });
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)).toBeDefined();
  });
  await advanceClock();
  const list = _fixture.listRef.current!;
  const viewport = list.getScrollableNode()!;
  await scroll(() => list.scrollToOffset({ offset: 300, animated: false }));
  await vi.waitFor(() => {
    expect(_fixture.host!.querySelector("[data-reader-end-control]")).not.toBeNull();
  });
  const scrollBefore = viewport.scrollTop;
  const state = list.getState();
  const anchor = state.elementAtIndex(state.start)!;
  expect(anchor?.isConnected).toBe(true);
  const anchorBefore = anchor.getBoundingClientRect().top;
  for (const pending of [true, false, true]) {
    await renderControlled(pending);
    await advanceClock(128);
    expect(viewport.scrollTop).toBeCloseTo(scrollBefore, 0);
    expect(anchor.getBoundingClientRect().top).toBe(anchorBefore);
  }

  // A child-only appendix reflow changes no rows, viewport, or Reader props and
  // sends no scroll event. It still must produce fresh end/position bookkeeping.
  const reportCount = reports.length;
  await _fixtureAct(() => resizeFooter(160));
  await vi.waitFor(() => {
    expect(
      reports.length,
      JSON.stringify({ phase: "footer-only-reflow", reportCount, last: reports.at(-1) }),
    ).toBeGreaterThan(reportCount);
  });
  expect(viewport.scrollTop).toBeCloseTo(scrollBefore, 0);
  expect(reports.at(-1)?.atEnd, JSON.stringify(reports.at(-1))).toBe(false);

  const endControl = _fixture.host!.querySelector<HTMLButtonElement>("[data-reader-end-control]")!;
  endControl.click();
  await vi.waitFor(() => {
    expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThanOrEqual(
      1,
    );
  });
  await vi.waitFor(() => {
    expect(_fixture.host!.querySelector("[data-reader-end-control]")).toBeNull();
  });
  const reached = reports.at(-1)!;
  expect(reached.measuredGap, JSON.stringify(reached)).not.toBeNull();
  expect(reached.measuredGap, JSON.stringify(reached)).toBeLessThanOrEqual(40);
  expect(reached.predicate, JSON.stringify(reached)).toBe(true);
  expect(reached.atEnd).toBe(true);
  await vi.waitFor(() => {
    expect(readTimelinePosition(key)?.atEnd).toBe(true);
  });

  // Metadata may grow below the answer without becoming unread answer content
  // or moving the reader. The already-visible answer still owns being at end.
  const endScroll = viewport.scrollTop;
  const answerEnd = viewport
    .querySelector<HTMLElement>("[data-reading-end]")!
    .getBoundingClientRect().bottom;
  const endReportCount = reports.length;
  await _fixtureAct(() => resizeFooter(240));
  await vi.waitFor(() => {
    expect(
      reports.length,
      JSON.stringify({
        phase: "footer-growth-at-end",
        endReportCount,
        last: reports.at(-1),
      }),
    ).toBeGreaterThan(endReportCount);
  });
  expect(viewport.scrollTop).toBeCloseTo(endScroll, 0);
  expect(
    viewport.querySelector<HTMLElement>("[data-reading-end]")!.getBoundingClientRect().bottom,
  ).toBe(answerEnd);
  expect(reports.at(-1)?.predicate, JSON.stringify(reports.at(-1))).toBe(true);
  expect(_fixture.host!.querySelector("[data-reader-end-control]")).toBeNull();
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  const listRef = createRef<LegendListRef>();
  const base = {
    listRef,
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    latestRun: null,
    runningRunId: null,
    turnDiffSummaries: [],
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: () => Promise.resolve(),
    onRollbackCheckpoint: () => {},
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
    contentInsetEndAdjustment: 100,
    onIsAtEndChange: vi.fn(),
    onManualNavigation: () => {},
  };
  return {
    listRef,
    base,
    timers: undefined as ReturnType<typeof fakeTimers> | undefined,
    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
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
