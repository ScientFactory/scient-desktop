import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { MessageId, RunId } from "@t3tools/contracts";
import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { readerAtReadingEnd, readingEndGapOnScreen, readingIdentity } from "./readerScrollPolicy";
import {
  flushTimelinePositions,
  rememberTimelinePosition,
  type RememberedTimelinePosition,
} from "./timelineScrollAnchoring";

type ReadingDisclosures = NonNullable<RememberedTimelinePosition["disclosures"]>;

/**
 * Tracks the reader's own input on the timeline: clicks and keys that may
 * toggle content, and scrolling the reader does themselves, recorded in the
 * caller's refs. Idle end keeping and the per-frame bookkeeping read this
 * state; neither acts on the reader's own movement. Returns whether a click
 * or key just happened (interaction settling).
 */
export function useReaderScrollInput({
  listRef,
  viewport,
  readerInputRef,
  scrollbarHeldRef,
  stillFramesRef,
  scheduleBookkeepingRef,
}: {
  listRef: RefObject<LegendListRef | null>;
  viewport: HTMLDivElement | null;
  readerInputRef: RefObject<boolean>;
  scrollbarHeldRef: RefObject<boolean>;
  stillFramesRef: RefObject<number>;
  scheduleBookkeepingRef: RefObject<() => void>;
}) {
  // Any click or key in the timeline can expand or collapse content (a long
  // message, a plan, tool output). Idle end pinning pauses briefly after one,
  // so the toggled content keeps its place instead of being pinned to its end.
  const [interactionSettling, setInteractionSettling] = useState(false);

  useEffect(() => {
    if (!viewport) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      setInteractionSettling(true);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setInteractionSettling(false);
      }, 400);
    };
    // The reader's own scrolling input; idle end keeping never acts on it.
    const input = () => {
      readerInputRef.current = true;
      stillFramesRef.current = 0;
      scheduleBookkeepingRef.current();
    };
    // A scrollbar drag moves the view on every frame until release.
    const pressed = (event: PointerEvent) => {
      if (event.target !== listRef.current?.getScrollableNode()) return;
      scrollbarHeldRef.current = true;
      input();
    };
    const released = () => {
      scrollbarHeldRef.current = false;
    };
    const keyed = (event: globalThis.KeyboardEvent) => {
      // Keys typed into the composer or another field don't scroll the timeline.
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, [contenteditable=true], [contenteditable='']")
      )
        return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
        input();
    };
    const ownerDocument = viewport.ownerDocument;
    viewport.addEventListener("click", settle, { capture: true });
    viewport.addEventListener("keydown", settle, { capture: true });
    viewport.addEventListener("wheel", input, { capture: true, passive: true });
    viewport.addEventListener("touchmove", input, { capture: true, passive: true });
    viewport.addEventListener("pointerdown", pressed, { capture: true });
    ownerDocument.addEventListener("keydown", keyed, { capture: true });
    ownerDocument.addEventListener("pointerup", released);
    ownerDocument.addEventListener("pointercancel", released);
    ownerDocument.addEventListener("mouseup", released);
    return () => {
      if (timer !== null) clearTimeout(timer);
      viewport.removeEventListener("click", settle, { capture: true });
      viewport.removeEventListener("keydown", settle, { capture: true });
      viewport.removeEventListener("wheel", input, { capture: true });
      viewport.removeEventListener("touchmove", input, { capture: true });
      viewport.removeEventListener("pointerdown", pressed, { capture: true });
      ownerDocument.removeEventListener("keydown", keyed, { capture: true });
      ownerDocument.removeEventListener("pointerup", released);
      ownerDocument.removeEventListener("pointercancel", released);
      ownerDocument.removeEventListener("mouseup", released);
    };
    // The refs are the caller's stable useRef objects; listing them changes nothing.
  }, [listRef, viewport, readerInputRef, scrollbarHeldRef, stillFramesRef, scheduleBookkeepingRef]);

  return interactionSettling;
}

/**
 * Remembers where the reader is reading, by row identity, so the thread
 * reopens there. Saves are skipped while a position is being restored or a
 * jump is in flight; the latest position is also saved, and flushed, when the
 * thread changes, the timeline unmounts or the page is hidden.
 */
export function useSaveReadingPosition({
  listRef,
  restoringThreadPosition,
  readingListLoaded,
  positionHistoryLoading,
  citationPositioning,
  timelinePositioningPending,
  runningRunId,
  turnUnfinished,
  isWorking,
  revealActive,
  rows,
  listIdentityKey,
  anchorMessageId,
  contentInsetEndAdjustment,
  paintedExpandedRunIds,
  paintedExpandedWorkGroupIds,
  paintedExpandedAttemptIds,
  workGroupViewState,
}: {
  listRef: RefObject<LegendListRef | null>;
  restoringThreadPosition: boolean;
  readingListLoaded: boolean;
  positionHistoryLoading: boolean;
  citationPositioning: boolean;
  timelinePositioningPending: boolean;
  runningRunId: RunId | null | undefined;
  turnUnfinished: boolean;
  /** The thread is working: a reader at the end, or still followed, is following it. */
  isWorking: boolean;
  /** The bounded follow of a sent prompt's response is still running. */
  revealActive: boolean;
  rows: readonly MessagesTimelineRow[];
  listIdentityKey: string;
  anchorMessageId: MessageId | null;
  contentInsetEndAdjustment: number;
  paintedExpandedRunIds: ReadingDisclosures["runs"];
  paintedExpandedWorkGroupIds: ReadingDisclosures["workGroups"];
  paintedExpandedAttemptIds: ReadingDisclosures["attempts"];
  workGroupViewState: ReadingDisclosures["workGroupState"];
}) {
  const saveReadingPosition = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (
      restoringThreadPosition ||
      !readingListLoaded ||
      positionHistoryLoading ||
      citationPositioning ||
      timelinePositioningPending ||
      state?.data !== rows
    )
      return;
    const element = listRef.current?.getScrollableNode();
    const position =
      state?.data?.length && element
        ? resolveWorkGroupScrollAnchor({ ...state, scroll: element.scrollTop })
        : undefined;
    if (!position || !state) return;
    const index = rows.findIndex((row) => row.id === position.rowId);
    const identity = readingIdentity(rows, index, runningRunId);
    const row = state.elementAtIndex(index);
    if (!identity || !row || !element) return;
    const atEnd = readerAtReadingEnd(state, contentInsetEndAdjustment, turnUnfinished) ?? false;
    rememberTimelinePosition(listIdentityKey, {
      ...position,
      ...identity,
      offsetWithinRow: identity.rowId
        ? element.getBoundingClientRect().top - row.getBoundingClientRect().top
        : 0,
      atEnd,
      // Following a working thread: at the end, or the follow still running.
      ...(isWorking && (atEnd || revealActive) ? { following: true } : {}),
      ...(anchorMessageId ? { anchorMessageId } : {}),
      disclosures: {
        runs: paintedExpandedRunIds,
        workGroups: paintedExpandedWorkGroupIds,
        attempts: paintedExpandedAttemptIds,
        workGroupState: workGroupViewState,
      },
    });
  }, [
    listRef,
    restoringThreadPosition,
    readingListLoaded,
    positionHistoryLoading,
    citationPositioning,
    timelinePositioningPending,
    runningRunId,
    turnUnfinished,
    isWorking,
    revealActive,
    rows,
    listIdentityKey,
    anchorMessageId,
    contentInsetEndAdjustment,
    paintedExpandedRunIds,
    paintedExpandedWorkGroupIds,
    paintedExpandedAttemptIds,
    workGroupViewState,
  ]);
  const saveReadingPositionRef = useRef(saveReadingPosition);
  useLayoutEffect(() => {
    saveReadingPositionRef.current = saveReadingPosition;
  });
  useLayoutEffect(() => {
    const save = () => {
      saveReadingPositionRef.current();
      flushTimelinePositions();
    };
    window.addEventListener("pagehide", save);
    return () => {
      save();
      window.removeEventListener("pagehide", save);
    };
  }, [listIdentityKey]);
  return saveReadingPosition;
}

/** Which rows are listed: a new or removed row changes it, a row changing size does not. */
export function timelineRowsKey(data: readonly unknown[]) {
  const last = data.at(-1) as { id?: string } | undefined;
  return `${data.length}:${last?.id ?? ""}`;
}

/** Where the reader last rested at the reading end (see the timeline's handleScroll). */
export interface RestingAtReadingEnd {
  gap: number;
  contentEnd: number;
  /** The rows at rest (count and last row): only their size changes are kept in view. */
  rowsKey: string;
}

/**
 * Runs the timeline's position, unread and end bookkeeping (`handleScroll`)
 * at most once per frame, and keeps the reading end in view while the reader
 * rests there on an idle thread. Returns the per-frame scheduler.
 */
export function useReadingBookkeepingFrame({
  handleScroll,
  listRef,
  contentInsetEndAdjustment,
  restingAtReadingEndRef,
  readerInputRef,
  scheduleBookkeepingRef,
  isWorking,
  revealActive,
  interactionSettling,
  timelinePositioningPending,
  citationPositioning,
  restoringThreadPosition,
  anchoredEndSpace,
  disclosureToggleSettling,
}: {
  handleScroll: () => void;
  listRef: RefObject<LegendListRef | null>;
  contentInsetEndAdjustment: number;
  restingAtReadingEndRef: RefObject<RestingAtReadingEnd | null>;
  readerInputRef: RefObject<boolean>;
  scheduleBookkeepingRef: RefObject<() => void>;
  isWorking: boolean;
  revealActive: boolean;
  interactionSettling: boolean;
  timelinePositioningPending: boolean;
  citationPositioning: boolean;
  restoringThreadPosition: boolean;
  /** The anchored end space config, when a sent prompt holds one. */
  anchoredEndSpace: unknown;
  disclosureToggleSettling: boolean;
}): () => void {
  // Row size changes arrive many times per frame while an answer streams, and
  // new rows or state arrive on top of them. The position, unread and end
  // bookkeeping runs at most once per frame, with the latest state.
  const handleScrollRef = useRef(handleScroll);
  useLayoutEffect(() => {
    handleScrollRef.current = handleScroll;
  });
  // While the reader rests at the end of an idle thread, late layout (a
  // resized window, a diagram or image finishing its render) keeps the end of
  // the last message's text where it was. New rows, streaming, reveals, and
  // content the reader just toggled never move the reader.
  const idleEndKeeping =
    !isWorking &&
    !revealActive &&
    !interactionSettling &&
    !timelinePositioningPending &&
    !citationPositioning &&
    !restoringThreadPosition &&
    !anchoredEndSpace &&
    !disclosureToggleSettling;
  const idleEndKeepingRef = useRef(idleEndKeeping);
  useLayoutEffect(() => {
    idleEndKeepingRef.current = idleEndKeeping;
  });
  const keepReadingEndInView = useCallback(() => {
    const resting = restingAtReadingEndRef.current;
    const list = listRef.current;
    const viewport = list?.getScrollableNode();
    if (!idleEndKeepingRef.current || !resting || !list || !viewport) return;
    const state = list.getState();
    // New rows grow below the reader and never move them; a frame with the
    // reader's own scrolling input is theirs, whatever else changed in it.
    if (readerInputRef.current || timelineRowsKey(state.data) !== resting.rowsKey) return;
    // Measured on screen: the list's own positions can trail the rendered rows.
    const gap = readingEndGapOnScreen(state, viewport, contentInsetEndAdjustment);
    if (gap === null) return;
    // Only content moving the text end counts. A scroll alone (the reader, a
    // minimap or citation jump, find in page) leaves the text end where it is
    // in the content, and is the reader's new position; content above that
    // the list already compensated for leaves the on-screen gap unchanged.
    const contentEnd = gap + viewport.scrollTop;
    if (Math.abs(contentEnd - resting.contentEnd) <= 1) return;
    const grown = gap - resting.gap;
    if (grown > 1) viewport.scrollTop += grown;
    // The refs are the caller's stable useRef objects; listing them changes nothing.
  }, [contentInsetEndAdjustment, listRef, readerInputRef, restingAtReadingEndRef]);
  const keepReadingEndInViewRef = useRef(keepReadingEndInView);
  useLayoutEffect(() => {
    keepReadingEndInViewRef.current = keepReadingEndInView;
  });
  const bookkeepingFrameRef = useRef<number | null>(null);
  const handleScrollOnNextFrame: () => void = useCallback(() => {
    if (bookkeepingFrameRef.current !== null) return;
    bookkeepingFrameRef.current = requestAnimationFrame(() => {
      bookkeepingFrameRef.current = null;
      keepReadingEndInViewRef.current();
      handleScrollRef.current();
    });
  }, []);
  useLayoutEffect(() => {
    scheduleBookkeepingRef.current = handleScrollOnNextFrame;
  }, [handleScrollOnNextFrame, scheduleBookkeepingRef]);
  useEffect(
    () => () => {
      if (bookkeepingFrameRef.current !== null) cancelAnimationFrame(bookkeepingFrameRef.current);
    },
    [],
  );
  return handleScrollOnNextFrame;
}
