import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { observeResize } from "~/lib/observeResize";
import { END_GAP } from "./useBoundedAnswerFollow";

/** QueuedRunsControl's own bottom padding: its last controls end above it. */
const QUEUE_BOTTOM_PADDING = 16;

/**
 * Keeps the reader's queued messages reachable at the end of the timeline. A queue wholly in view
 * stays in view as it grows or the composer grows over it, and a message this window queued from
 * the end is brought into view; a running follow does both itself. Returns whether the queue is
 * hidden below the reading area, so Scroll to end can show and name it.
 */
export function useQueuedRunsInView(input: {
  listRef: RefObject<LegendListRef | null>;
  /** The element holding the queue, while the timeline shows one. */
  element: HTMLElement | null;
  composerInset: number;
  threadKey: string;
  /** Messages this window queued that the server has not listed yet. */
  ownQueuedIds: readonly string[];
  readerAtEnd: () => boolean;
  following: boolean;
}): boolean {
  const { listRef, element, composerInset, threadKey, following } = input;
  const [hiddenBelow, setHiddenBelow] = useState(false);
  const inViewRef = useRef({ threadKey, inView: false });
  const revealPendingRef = useRef(false);
  const ownRef = useRef({ threadKey, ids: new Set(input.ownQueuedIds) });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the reader's end position when this window's queued send renders
  useLayoutEffect(() => {
    const own = ownRef.current;
    const added = input.ownQueuedIds.some((id) => !own.ids.has(id));
    if (added && own.threadKey === input.threadKey && input.readerAtEnd())
      revealPendingRef.current = true;
    ownRef.current = { threadKey: input.threadKey, ids: new Set(input.ownQueuedIds) };
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the queue against the scrolling timeline and scrolls it into view
  useLayoutEffect(() => {
    const viewport = listRef.current?.getScrollableNode();
    if (inViewRef.current.threadKey !== threadKey) inViewRef.current = { threadKey, inView: false };
    if (!element || !viewport) {
      inViewRef.current = { threadKey, inView: false };
      setHiddenBelow(false);
      return;
    }
    const readingBottom = () =>
      viewport.getBoundingClientRect().top + viewport.clientHeight - composerInset;
    let revealing = false;
    const check = () => {
      if (revealing) return;
      const hidden =
        element.getBoundingClientRect().bottom - QUEUE_BOTTOM_PADDING > readingBottom() + 1;
      inViewRef.current = { threadKey, inView: !hidden };
      setHiddenBelow(hidden);
    };
    const reveal = () => {
      const distance = Math.min(
        element.getBoundingClientRect().bottom - (readingBottom() - END_GAP),
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      );
      if (distance <= 1) return;
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      revealing = !reducedMotion;
      viewport.scrollBy({ top: distance, behavior: reducedMotion ? "auto" : "smooth" });
    };
    const keepInView = () => {
      if (!following && (inViewRef.current.inView || revealPendingRef.current)) reveal();
      revealPendingRef.current = false;
      check();
    };
    const onScrollEnd = () => {
      revealing = false;
      check();
    };
    keepInView();
    const stopResize = observeResize(element, keepInView);
    viewport.addEventListener("scroll", check, { passive: true });
    viewport.addEventListener("scrollend", onScrollEnd, { passive: true });
    return () => {
      stopResize();
      viewport.removeEventListener("scroll", check);
      viewport.removeEventListener("scrollend", onScrollEnd);
    };
  }, [listRef, element, composerInset, threadKey, following]);
  return hiddenBelow;
}
