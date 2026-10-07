import type { LegendListRef } from "@legendapp/list/react";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";
import { END_GAP, promptResponseLastIndex } from "./useBoundedAnswerFollow";

/** How much of a message counts as its start being shown: its first lines. */
const FIRST_LINES_PX = 48;

/**
 * Where the follow of `promptId` would have the view now (a scroll offset),
 * for a reader who left while following it and comes back. If everything
 * since that prompt fits, the end of its response (the bottom when it is the
 * latest prompt). Otherwise the prompt rests at the top of the reading area,
 * unless its response's latest message's start would then be below the
 * screen: that start rests at the top instead. A later prompt and its
 * response never move it further.
 *
 * When a row this needs has never been rendered (outside the list's window),
 * it says which row to bring into view first, so it can be measured. Null
 * when the list cannot be measured or the prompt is not in the loaded rows.
 */
export function liveFollowOffset(
  list: LegendListRef,
  rows: readonly MessagesTimelineRow[],
  composerInset: number,
  promptId: string,
): { offset: number } | { mount: number } | null {
  const viewport = list.getScrollableNode();
  if (!viewport) return null;
  const state = list.getState();
  const bottom = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
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
  const promptIndex = rows.findIndex(
    (row) => row.kind === "message" && row.message.role === "user" && row.message.id === promptId,
  );
  if (promptIndex < 0) return null;
  const readingHeight = viewport.clientHeight - composerInset;
  const lastIndex = promptResponseLastIndex(rows, promptIndex);
  let end = bottom;
  if (lastIndex < rows.length - 1) {
    // A later prompt follows: the end is this response's last row, resting
    // above the composer as the follow leaves it.
    const lastTop = rowTop(lastIndex);
    const element = state.elementAtIndex(lastIndex);
    const size = element?.isConnected
      ? element.getBoundingClientRect().height
      : state.sizeAtIndex(lastIndex);
    if (lastTop === null || size === undefined) return { mount: lastIndex };
    end = Math.min(bottom, Math.max(0, lastTop + size - (readingHeight - END_GAP)));
  }
  const promptTop = rowTop(promptIndex, '[data-user-message-body="true"]');
  if (promptTop === null) return { mount: promptIndex };
  const promptAtTop = Math.max(0, promptTop - CHAT_TIMELINE_ANCHOR_OFFSET);
  if (end <= promptAtTop) return { offset: end };
  let latestIndex = -1;
  for (let index = lastIndex; index > promptIndex; index -= 1) {
    const row = rows[index];
    if (row?.kind === "message" && row.message.role === "assistant" && row.message.text.trim()) {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex < 0) return { offset: promptAtTop };
  const latestTop = rowTop(latestIndex);
  if (latestTop === null) return { mount: latestIndex };
  // Its first lines already show below the prompt: stay with the prompt.
  if (latestTop + FIRST_LINES_PX <= promptAtTop + readingHeight) return { offset: promptAtTop };
  return {
    offset: Math.min(end, Math.max(promptAtTop, latestTop - CHAT_TIMELINE_ANCHOR_OFFSET)),
  };
}

/**
 * Brings a reader who left while following `promptId` back to where its
 * follow would be now: to the end first, then to `liveFollowOffset` until it
 * holds for two frames (at most 60 frames). A needed row the list has not
 * rendered yet is scrolled into view first and measured there. Frames go through `nextFrame`, so the caller's restore
 * cleanup cancels them; `done` runs once it holds, or when it gives up.
 */
export function returnToLiveFollow(input: {
  list: LegendListRef;
  rows: readonly MessagesTimelineRow[];
  composerInset: number;
  /** The prompt being followed when the reader left. */
  promptId: string;
  cancelled: () => boolean;
  nextFrame: (step: () => void) => void;
  done: () => void;
}) {
  const { list, rows, composerInset, promptId, cancelled, nextFrame, done } = input;
  void Promise.resolve(list.scrollToEnd({ animated: false })).then(() => {
    if (cancelled()) return;
    let stableFrames = 0;
    let remainingFrames = 60;
    const settle = () => {
      if (cancelled()) return;
      const target = liveFollowOffset(list, rows, composerInset, promptId);
      const element = list.getScrollableNode();
      if (target === null || !element || --remainingFrames <= 0) {
        done();
        return;
      }
      if ("mount" in target) {
        stableFrames = 0;
        void Promise.resolve(
          list.scrollToIndex({ index: target.mount, animated: false, viewPosition: 1 }),
        ).then(() => {
          if (!cancelled()) nextFrame(settle);
        });
        return;
      }
      if (Math.abs(element.scrollTop - target.offset) > 1) {
        stableFrames = 0;
        void list.scrollToOffset({ offset: target.offset, animated: false }).then(() => {
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
