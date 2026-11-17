import { useStableCallback } from "~/hooks/useStableCallback";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { MessageId, RunId } from "@t3tools/contracts";
import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { returnToLiveFollow } from "./liveFollowOffset";
import {
  readerAtReadingEnd,
  readingEndGapOnScreen,
  restingEndGrowth,
  readingIdentity,
  resolveReadingRow,
} from "./readerScrollPolicy";
import { flushTimelinePositions } from "./readingPositionStore";
import {
  rememberTimelinePosition,
  type RememberedTimelinePosition,
} from "./timelineScrollAnchoring";
import type { TimelineViewport } from "./timelineViewport";

type ReadingDisclosures = NonNullable<RememberedTimelinePosition["disclosures"]>;

/** One older page of the thread, requested while the restore looks for its saved message. */
export interface ReadingHistoryPage {
  readonly loading: boolean;
  readonly cursor?: string | null;
  readonly onLoadEarlier: () => void;
}

/**
 * Any click or key in the timeline can open or close content (a long message, a plan, tool
 * output). Idle end keeping pauses briefly after one, so the toggled content keeps its place
 * instead of being pinned to its end. Returns whether it is settling, and a way to start it.
 */
export function useInteractionSettling(
  viewport: HTMLElement | null,
): readonly [boolean, () => void] {
  const [settling, setSettling] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settle = useStableCallback(() => {
    setSettling(true);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setSettling(false);
    }, 400);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for clicks and keys in the timeline viewport while it is mounted
  useEffect(() => {
    if (!viewport) return;
    viewport.addEventListener("click", settle, { capture: true });
    viewport.addEventListener("keydown", settle, { capture: true });
    return () => {
      viewport.removeEventListener("click", settle, { capture: true });
      viewport.removeEventListener("keydown", settle, { capture: true });
    };
  }, [viewport, settle]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the pending settle timer on unmount
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  return [settling, settle] as const;
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
  followingPromptId,
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
  /**
   * The prompt whose response the send follow is following right now (not
   * cancelled, not finished), read as the position is saved.
   */
  followingPromptId: () => string | null;
  rows: readonly MessagesTimelineRow[];
  listIdentityKey: string;
  anchorMessageId: MessageId | null;
  contentInsetEndAdjustment: number;
  paintedExpandedRunIds: ReadingDisclosures["runs"];
  paintedExpandedWorkGroupIds: ReadingDisclosures["workGroups"];
  paintedExpandedAttemptIds: ReadingDisclosures["attempts"];
  workGroupViewState: ReadingDisclosures["workGroupState"];
}) {
  const saveReadingPosition = useStableCallback((threadKey = listIdentityKey) => {
    const state = listRef.current?.getState?.();
    if (
      threadKey !== listIdentityKey ||
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
    const following = followingPromptId();
    rememberTimelinePosition(listIdentityKey, {
      ...position,
      ...identity,
      offsetWithinRow: identity.rowId
        ? element.getBoundingClientRect().top - row.getBoundingClientRect().top
        : 0,
      atEnd,
      // Only a follow that is still going, never a reader merely at the end.
      ...(following ? { followingPromptId: following } : {}),
      ...(anchorMessageId ? { anchorMessageId } : {}),
      disclosures: {
        runs: paintedExpandedRunIds,
        workGroups: paintedExpandedWorkGroupIds,
        attempts: paintedExpandedAttemptIds,
        workGroupState: workGroupViewState,
      },
    });
  });
  const saveReadingPositionRef = useRef(saveReadingPosition);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps saveReadingPositionRef current with the latest closure for the pagehide listener
  useLayoutEffect(() => {
    saveReadingPositionRef.current = saveReadingPosition;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- flushes the reading position to the positions store on pagehide and unmount; owns the pagehide listener
  useLayoutEffect(() => {
    const save = () => {
      saveReadingPositionRef.current(listIdentityKey);
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps handleScrollRef current with the latest handleScroll for the per-frame scheduler
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps idleEndKeepingRef current with the latest idle end-keeping derivation for the frame scheduler
  useLayoutEffect(() => {
    idleEndKeepingRef.current = idleEndKeeping;
  });
  const keepReadingEndInView = useStableCallback(() => {
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
    const grown = restingEndGrowth(resting, gap, viewport.scrollTop);
    if (grown > 1) viewport.scrollTop += grown;
    // The refs are the caller's stable useRef objects; listing them changes nothing.
  });
  const keepReadingEndInViewRef = useRef(keepReadingEndInView);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps keepReadingEndInViewRef current with the latest closure for the frame scheduler
  useLayoutEffect(() => {
    keepReadingEndInViewRef.current = keepReadingEndInView;
  });
  // A finished restore leaves the reader where it placed them: record that at
  // once, so late layout in the very next frame is kept in view too (idle end
  // keeping needs where the reader rests, which the bookkeeping records).
  const restoringRef = useRef(restoringThreadPosition);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the reader's rest position via handleScroll the moment a restore finishes, so the next frame's idle end keeping sees it
  useLayoutEffect(() => {
    const restored = restoringRef.current && !restoringThreadPosition;
    restoringRef.current = restoringThreadPosition;
    if (restored) handleScrollRef.current();
  }, [restoringThreadPosition]);
  const bookkeepingFrameRef = useRef<number | null>(null);
  const handleScrollOnNextFrame: () => void = useStableCallback(() => {
    if (bookkeepingFrameRef.current !== null) return;
    bookkeepingFrameRef.current = requestAnimationFrame(() => {
      bookkeepingFrameRef.current = null;
      keepReadingEndInViewRef.current();
      handleScrollRef.current();
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the per-frame bookkeeping scheduler into the caller's shared ref
  useLayoutEffect(() => {
    scheduleBookkeepingRef.current = handleScrollOnNextFrame;
  }, [handleScrollOnNextFrame, scheduleBookkeepingRef]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the pending requestAnimationFrame bookkeeping frame held until unmount
  useEffect(
    () => () => {
      if (bookkeepingFrameRef.current !== null) {
        cancelAnimationFrame(bookkeepingFrameRef.current);
        // Effect replay must be able to schedule again after cancelling this frame.
        bookkeepingFrameRef.current = null;
      }
    },
    [],
  );
  return handleScrollOnNextFrame;
}

/** Older-history pages a missing saved message may load before falling back. */
const MAX_READING_HISTORY_PAGES = 2;

/** Pages of older history requested for one thread's saved position. */
export interface ReadingHistoryPages {
  readonly key: string;
  readonly count: number;
}

/**
 * Page history only to the bounded limit before falling back to same-run/neighbor/end.
 * Deleted/reverted targets must not force loading the entire conversation.
 */
export function useReadingRestoreTarget({
  rows,
  rememberedPosition,
  restoringThreadPosition,
  positionHistoryLoading,
  loadEarlier,
  listIdentityKey,
  readingHistoryPages,
  setReadingHistoryPages,
  requestedReadingPages,
}: {
  rows: readonly MessagesTimelineRow[];
  rememberedPosition: RememberedTimelinePosition | undefined;
  restoringThreadPosition: boolean;
  positionHistoryLoading: boolean;
  loadEarlier: ReadingHistoryPage | null;
  listIdentityKey: string;
  readingHistoryPages: ReadingHistoryPages;
  setReadingHistoryPages: Dispatch<SetStateAction<ReadingHistoryPages>>;
  requestedReadingPages: RefObject<{ key: string; cursors: Set<string> }>;
}) {
  const readingHistoryPageCount =
    readingHistoryPages.key === listIdentityKey ? readingHistoryPages.count : 0;
  // The last allowed page must arrive before the saved message is given up on.
  const readingHistoryExhausted =
    loadEarlier === null ||
    (readingHistoryPageCount >= MAX_READING_HISTORY_PAGES && !loadEarlier.loading);
  const restoreTarget = rememberedPosition
    ? resolveReadingRow(rows, rememberedPosition, readingHistoryExhausted)
    : null;
  const restoreRowIndex = restoreTarget?.index ?? -1;
  const restoreOffset = restoreTarget?.exact ? (rememberedPosition?.offsetWithinRow ?? 0) : 0;
  const waitingForReadingHistory =
    restoringThreadPosition &&
    !!rememberedPosition &&
    restoreTarget === null &&
    !readingHistoryExhausted;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests older reading-history pages from the list's loader while a restore waits for the saved message
  useEffect(() => {
    if (
      !waitingForReadingHistory ||
      positionHistoryLoading ||
      !loadEarlier ||
      loadEarlier.loading ||
      readingHistoryPageCount >= MAX_READING_HISTORY_PAGES
    )
      return;
    const cursor = loadEarlier.cursor ?? "initial";
    if (requestedReadingPages.current.cursors.has(cursor)) return;
    requestedReadingPages.current.cursors.add(cursor);
    setReadingHistoryPages((current) => ({
      key: listIdentityKey,
      count: (current.key === listIdentityKey ? current.count : 0) + 1,
    }));
    loadEarlier.onLoadEarlier();
  }, [
    waitingForReadingHistory,
    positionHistoryLoading,
    loadEarlier,
    listIdentityKey,
    readingHistoryPageCount,
    requestedReadingPages,
    setReadingHistoryPages,
  ]);
  return { restoreRowIndex, restoreOffset, waitingForReadingHistory };
}

/**
 * Returns a reader who left while following to where that follow is now (chat/liveFollowOffset.ts),
 * and reports the thread positioned so the follow carries on. Any navigation on the viewport
 * stops it where it is. Returns the stop for the restore's owner.
 */
export function startFollowResume({
  list,
  viewport,
  composerInset,
  promptId,
  listIdentityKey,
  onPositioned,
}: {
  list: LegendListRef;
  viewport: TimelineViewport;
  composerInset: number;
  promptId: string;
  listIdentityKey: string;
  onPositioned: (identity: string) => void;
}): () => void {
  let cancelled = false;
  let frame: number | null = null;
  const releaseScrollHold = viewport.holdProgrammaticScroll();
  const stop = () => {
    cancelled = true;
    if (frame !== null) cancelAnimationFrame(frame);
    releaseScrollHold();
    unsubscribe();
  };
  const unsubscribe = viewport.subscribe(() => {
    if (cancelled) return;
    stop();
    void list.scrollToOffset({ offset: viewport.scrollNode.scrollTop, animated: false });
    onPositioned(listIdentityKey);
  });
  returnToLiveFollow({
    list,
    composerInset,
    promptId,
    cancelled: () => cancelled,
    nextFrame: (step) => {
      frame = requestAnimationFrame(step);
    },
    done: () => {
      if (cancelled) return;
      stop();
      onPositioned(listIdentityKey);
    },
  });
  return stop;
}

/**
 * While an opening settles at the end, it only ever scrolls down (or clamps at the end). Moving
 * up away from the end without wheel, touch, press or key input, as a screen reader moving to a
 * heading does, is the reader's own navigation. Returns the stop.
 */
export function watchReaderLeavingEnd(viewport: TimelineViewport): () => void {
  const node = viewport.scrollNode;
  let lastScrollTop = node.scrollTop;
  const onScroll = () => {
    const top = node.scrollTop;
    const movedUp = top < lastScrollTop - 1;
    lastScrollTop = top;
    if (movedUp && node.scrollHeight - node.clientHeight - top > 1) {
      viewport.navigate({ releasesFollow: true });
    }
  };
  node.addEventListener("scroll", onScroll, { passive: true });
  return () => node.removeEventListener("scroll", onScroll);
}
