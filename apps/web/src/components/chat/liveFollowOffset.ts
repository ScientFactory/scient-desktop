import type { LegendListRef } from "@legendapp/list/react";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";
import {
  END_GAP,
  FIRST_LINES_PX,
  followLimitIndex,
  promptResponseLastIndex,
} from "./useBoundedAnswerFollow";

/**
 * Restore only this prompt's response, where its follow would be now; later prompts must not pull
 * it further. Request rendering of any unmeasured target row before computing its offset, and
 * return null when measurements or the prompt are unavailable.
 */
function liveFollowOffset(
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
  const rowTop = (index: number) => {
    const element = state.elementAtIndex(index);
    if (element?.isConnected) {
      return viewport.scrollTop + element.getBoundingClientRect().top - viewportTop;
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
  // As the follow would: to the end, unless that pushes a reading row's start past the margin.
  const limitIndex = followLimitIndex(rows, promptIndex, lastIndex, new Set());
  if (limitIndex < 0) return { offset: end };
  const limitTop = rowTop(limitIndex);
  if (limitTop === null) return { mount: limitIndex };
  const limitAtTop = Math.max(0, limitTop - CHAT_TIMELINE_ANCHOR_OFFSET);
  if (end <= limitAtTop) return { offset: end };
  let latestIndex = -1;
  for (let index = lastIndex; index > promptIndex; index -= 1) {
    const row = rows[index];
    if (row?.kind === "message" && row.message.role === "assistant" && row.message.text.trim()) {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex < 0) return { offset: limitAtTop };
  const latestTop = rowTop(latestIndex);
  if (latestTop === null) return { mount: latestIndex };
  // Its first lines already show below the limit: stay with the limit.
  if (latestTop + FIRST_LINES_PX <= limitAtTop + readingHeight) return { offset: limitAtTop };
  return {
    offset: Math.min(end, Math.max(limitAtTop, latestTop - CHAT_TIMELINE_ANCHOR_OFFSET)),
  };
}

/**
 * Render and measure needed rows before restoring follow. Route frames through nextFrame so restore
 * cleanup can cancel them; finish after stability or the bounded frame limit.
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
