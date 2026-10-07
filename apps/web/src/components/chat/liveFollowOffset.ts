import type { LegendListRef } from "@legendapp/list/react";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";

/** How much of a message counts as its start being shown: its first lines. */
const FIRST_LINES_PX = 48;

/**
 * Where the follow would have the view now (a scroll offset), for a reader
 * who left while following a working thread and comes back. If everything
 * since their latest prompt fits, the end. Otherwise the prompt rests at the
 * top of the reading area, unless the latest message's start would then be
 * below the screen: that start rests at the top instead. Never past the end.
 * Null when the list cannot be measured.
 */
export function liveFollowOffset(
  list: LegendListRef,
  rows: readonly MessagesTimelineRow[],
  composerInset: number,
): number | null {
  const viewport = list.getScrollableNode();
  if (!viewport) return null;
  const state = list.getState();
  const end = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const viewportTop = viewport.getBoundingClientRect().top;
  // A row's top in scroll offsets: measured on screen when it is rendered.
  const rowTop = (index: number, selector?: string) => {
    const element = state.elementAtIndex(index);
    if (element?.isConnected) {
      const target = (selector && element.querySelector(selector)) || element;
      return viewport.scrollTop + target.getBoundingClientRect().top - viewportTop;
    }
    return state.positionAtIndex(index) ?? null;
  };
  const promptIndex = rows.findLastIndex(
    (row) => row.kind === "message" && row.message.role === "user",
  );
  if (promptIndex < 0) return end;
  const promptTop = rowTop(promptIndex, '[data-user-message-body="true"]');
  if (promptTop === null) return end;
  const promptAtTop = Math.max(0, promptTop - CHAT_TIMELINE_ANCHOR_OFFSET);
  if (end <= promptAtTop) return end;
  let latestIndex = -1;
  for (let index = rows.length - 1; index > promptIndex; index -= 1) {
    const row = rows[index];
    if (row?.kind === "message" && row.message.role === "assistant" && row.message.text.trim()) {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex < 0) return promptAtTop;
  const latestTop = rowTop(latestIndex);
  if (latestTop === null) return promptAtTop;
  const readingHeight = viewport.clientHeight - composerInset;
  // Its first lines already show below the prompt: stay with the prompt.
  if (latestTop + FIRST_LINES_PX <= promptAtTop + readingHeight) return promptAtTop;
  return Math.min(end, Math.max(promptAtTop, latestTop - CHAT_TIMELINE_ANCHOR_OFFSET));
}

/**
 * Brings a reader who left while following back to where the follow would be
 * now: to the end first, then to `liveFollowOffset` until it holds for two
 * frames (at most 60). Frames go through `nextFrame`, so the caller's restore
 * cleanup cancels them; `done` runs once it holds, or when it gives up.
 */
export function returnToLiveFollow(input: {
  list: LegendListRef;
  rows: readonly MessagesTimelineRow[];
  composerInset: number;
  cancelled: () => boolean;
  nextFrame: (step: () => void) => void;
  done: () => void;
}) {
  const { list, rows, composerInset, cancelled, nextFrame, done } = input;
  void Promise.resolve(list.scrollToEnd({ animated: false })).then(() => {
    if (cancelled()) return;
    let stableFrames = 0;
    let remainingFrames = 60;
    const settle = () => {
      if (cancelled()) return;
      const offset = liveFollowOffset(list, rows, composerInset);
      const element = list.getScrollableNode();
      if (offset === null || !element || --remainingFrames <= 0) {
        done();
        return;
      }
      if (Math.abs(element.scrollTop - offset) > 1) {
        stableFrames = 0;
        void list.scrollToOffset({ offset, animated: false }).then(() => {
          if (!cancelled()) nextFrame(settle);
        });
        return;
      }
      if (++stableFrames < 2) nextFrame(settle);
      else done();
    };
    nextFrame(settle);
  });
}
