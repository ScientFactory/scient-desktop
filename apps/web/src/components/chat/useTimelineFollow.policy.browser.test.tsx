import type { LegendListRef } from "@legendapp/list/react";
import { MessageId } from "@t3tools/contracts";
import { type RefObject, useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { type TimelineFollowPolicy, useTimelineFollow } from "./useTimelineFollow";

type Follow = ReturnType<typeof useTimelineFollow>;

function list(scrollToIndex = vi.fn(async () => {})) {
  const node = document.createElement("div");
  const scrollToEnd = vi.fn(async () => {});
  return {
    scrollToIndex,
    scrollToEnd,
    ref: {
      current: {
        getScrollableNode: () => node,
        // The list shows both anchored messages, so positioning one is still current.
        getState: () => ({
          data: ["sent-now", "kept-from-before"].map((id) => ({
            kind: "message",
            message: { id },
          })),
          scroll: 0,
          scrollLength: 600,
        }),
        scrollToIndex,
        scrollToEnd,
        scrollToOffset: async () => {},
        cancelScroll: () => {},
      } as unknown as LegendListRef,
    } as RefObject<LegendListRef | null>,
  };
}

function Probe({
  legendListRef,
  policy,
  onFollow,
  threadKey = "thread",
}: {
  legendListRef: RefObject<LegendListRef | null>;
  policy: TimelineFollowPolicy;
  onFollow: (follow: Follow) => void;
  threadKey?: string;
}) {
  const follow = useTimelineFollow({
    legendListRef,
    composerTimelineInset: 0,
    routeThreadKey: threadKey,
    activeThreadKey: threadKey,
    isServerThread: false,
    serverProjection: null,
    threadStatus: "live",
    activeActivityRun: null,
    activeRunningTurnId: null,
    timelineEntries: [],
    timelineAnchorMessageId: null,
    setTimelineAnchor: () => {},
    policy,
  });
  useLayoutEffect(() => onFollow(follow));
  return null;
}

async function renderFollow(policy: TimelineFollowPolicy, scrollToIndex?: () => Promise<void>) {
  const target = list(scrollToIndex ? vi.fn(scrollToIndex) : undefined);
  const follow: { current: Follow | null } = { current: null };
  const probe = (threadKey?: string) => (
    <Probe
      legendListRef={target.ref}
      policy={policy}
      onFollow={(next) => {
        follow.current = next;
      }}
      {...(threadKey ? { threadKey } : {})}
    />
  );
  const screen = await render(probe(), { router: false });
  return {
    screen,
    follow,
    scrollToIndex: target.scrollToIndex,
    scrollToEnd: target.scrollToEnd,
    showThread: (threadKey: string) => screen.rerender(probe(threadKey)),
  };
}

describe("useTimelineFollow policy", () => {
  it("shows the end control while following once the reader leaves the end, however often it is reported", async () => {
    const { screen, follow } = await renderFollow({ endControlWhileFollowing: true });
    await using _screen = screen;
    using _timers = fakeTimers();
    // Streaming reports the same end on every frame; only the crossing starts the delay.
    for (let report = 0; report < 8; report++) {
      await act(() => {
        follow.current!.onIsAtEndChangeStable(false);
        vi.advanceTimersByTime(40);
      });
    }
    expect(follow.current!.showScrollToBottom).toBe(true);
    await act(() => follow.current!.onIsAtEndChangeStable(true));
    expect(follow.current!.showScrollToBottom).toBe(false);
  });

  it("keeps the end control hidden while following by default", async () => {
    const { screen, follow } = await renderFollow({});
    await using _screen = screen;
    using _timers = fakeTimers();
    await act(() => {
      follow.current!.onIsAtEndChangeStable(false);
      vi.advanceTimersByTime(300);
    });
    expect(follow.current!.showScrollToBottom).toBe(false);
  });

  it("places only the anchors the policy places", async () => {
    const placed = MessageId.make("sent-now");
    const kept = MessageId.make("kept-from-before");
    const onAnchorPositioned = vi.fn();
    const { screen, follow, scrollToIndex } = await renderFollow(
      { placesAnchor: (messageId) => messageId === placed, onAnchorPositioned },
      async () => {},
    );
    await using _screen = screen;
    using _timers = fakeTimers();
    await act(() => {
      follow.current!.onTimelineAnchorReadyStable(kept, 3);
      vi.advanceTimersByTime(100);
    });
    expect(scrollToIndex).not.toHaveBeenCalled();
    await act(() => {
      follow.current!.onTimelineAnchorReadyStable(placed, 4);
      vi.advanceTimersByTime(100);
    });
    expect(scrollToIndex).toHaveBeenCalledOnce();
  });

  it("drops a scroll to end requested in a thread the reader has left", async () => {
    const onScrolledToEnd = vi.fn();
    const { screen, follow, scrollToEnd, showThread } = await renderFollow({ onScrolledToEnd });
    await using _screen = screen;
    using _timers = fakeTimers();
    await act(() => follow.current!.scrollToEnd(true));
    await showThread("another-thread");
    await act(() => vi.advanceTimersByTime(100));
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(onScrolledToEnd).toHaveBeenCalledExactlyOnceWith(false);
  });
});
