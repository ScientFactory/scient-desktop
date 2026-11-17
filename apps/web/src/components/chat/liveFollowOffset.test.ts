import type { LegendListRef } from "@legendapp/list/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { returnToLiveFollow } from "./liveFollowOffset";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

describe("returnToLiveFollow", () => {
  it("ends within its frame budget while the end keeps moving and the list never settles", () => {
    const prompt = {
      kind: "message",
      id: "prompt-row",
      message: { id: "prompt", role: "user", text: "Write the essay" },
    } as unknown as MessagesTimelineRow;
    // An answer still appearing below: the end moves every frame, and the list's scroll
    // promises never resolve while it does.
    const viewport = {
      scrollTop: 0,
      scrollHeight: 2000,
      clientHeight: 600,
      getBoundingClientRect: () => ({ top: 0 }),
    };
    const pending = () => new Promise<void>(() => {});
    const list = {
      getScrollableNode: () => viewport,
      getState: () => ({
        data: [prompt],
        elementAtIndex: () => undefined,
        positionAtIndex: () => 0,
        sizeAtIndex: () => 0,
      }),
      scrollToEnd: pending,
      scrollToIndex: pending,
      scrollToOffset: pending,
    } as unknown as LegendListRef;
    const frames: Array<() => void> = [];
    const done = vi.fn();
    returnToLiveFollow({
      list,
      composerInset: 0,
      promptId: "prompt",
      cancelled: () => false,
      nextFrame: (step) => frames.push(step),
      done,
    });
    for (let frame = 0; frame < 100 && frames.length > 0; frame++) {
      viewport.scrollHeight += 40;
      frames.shift()!();
    }
    expect(done).toHaveBeenCalledOnce();
    expect(frames).toEqual([]);
  });
});
