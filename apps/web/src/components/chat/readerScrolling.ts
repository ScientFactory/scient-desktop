import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { MessageId, RunId } from "@t3tools/contracts";
import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { AssistantCitationRequest } from "./AssistantCitationSource";
import { returnToLiveFollow } from "./liveFollowOffset";
import {
  readerAtReadingEnd,
  readingEndGapOnScreen,
  readingIdentity,
  resolveReadingRow,
} from "./readerScrollPolicy";
import type { CitationHistoryPage } from "./useAssistantCitationTarget";
import { flushTimelinePositions } from "./readingPositionStore";
import {
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
  }, [
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

/** Older-history pages a missing saved message may load before falling back. */
const MAX_READING_HISTORY_PAGES = 2;

/** Pages of older history requested for one thread's saved position. */
export interface ReadingHistoryPages {
  readonly key: string;
  readonly count: number;
}

/**
 * Where a saved reading position lands in the loaded rows: its message, else
 * the same run, else a neighbor message (readerScrollPolicy.resolveReadingRow).
 * A saved message that is not loaded yet pages in up to
 * MAX_READING_HISTORY_PAGES older pages first; after that a neighbor or the
 * end is used, so a revert or a deleted turn never loads the whole history.
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
  loadEarlier: CitationHistoryPage | null;
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
 * Restores a thread's saved reading position when its list opens: the saved
 * row and offset (also when it was saved at the end), back to a follow the
 * reader left, or the end when nothing was saved. Settles for up to 60
 * frames and gives up visibly (setAbandonedPositionKey). The reader's own
 * wheel, touch, press or scroll key cancels it, and ChatView cancels it
 * through cancelPositionRestoreRef.
 */
export function useReadingPositionRestore({
  listRef,
  rows,
  listIdentityKey,
  rememberedPosition,
  restoringThreadPosition,
  readingListLoaded,
  citationRequest,
  anchorMessageId,
  restoreRowIndex,
  restoreOffset,
  waitingForReadingHistory,
  positionHistoryLoading,
  contentInsetEndAdjustment,
  cancelPositionRestoreRef,
  onManualNavigation,
  onResumeFollow,
  setPositionedThreadKey,
  setAbandonedPositionKey,
}: {
  listRef: RefObject<LegendListRef | null>;
  rows: readonly MessagesTimelineRow[];
  listIdentityKey: string;
  rememberedPosition: RememberedTimelinePosition | undefined;
  restoringThreadPosition: boolean;
  readingListLoaded: boolean;
  citationRequest: AssistantCitationRequest | null;
  anchorMessageId: MessageId | null;
  restoreRowIndex: number;
  restoreOffset: number;
  waitingForReadingHistory: boolean;
  positionHistoryLoading: boolean;
  contentInsetEndAdjustment: number;
  cancelPositionRestoreRef: RefObject<(() => void) | null> | undefined;
  onManualNavigation: () => void;
  onResumeFollow: ((promptId: string) => void) | undefined;
  setPositionedThreadKey: (threadKey: string) => void;
  setAbandonedPositionKey: (threadKey: string) => void;
}) {
  useLayoutEffect(() => {
    if (!restoringThreadPosition || rows.length === 0 || !readingListLoaded) return;
    const list = listRef.current;
    if (!list) return;
    if (citationRequest !== null || (anchorMessageId !== null && !rememberedPosition)) {
      setPositionedThreadKey(listIdentityKey);
      return;
    }
    let cancelled = false;
    let settleFrame: number | null = null;
    const viewport: HTMLElement | null = list.getScrollableNode();
    const cancelRestoration = () => {
      if (cancelled) return;
      cancelled = true;
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      // Supersede any pending estimated-index scroll before the browser applies the gesture.
      if (viewport)
        void list.scrollToOffset({
          get offset() {
            return viewport.scrollTop;
          },
          animated: false,
        });
      setPositionedThreadKey(listIdentityKey);
    };
    const cancelForNavigation = () => {
      cancelRestoration();
      onManualNavigation();
    };
    const onScrollKey = (event: globalThis.KeyboardEvent) => {
      if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) &&
        !(
          event.target instanceof Element &&
          event.target.closest("input, textarea, [contenteditable=true]")
        )
      )
        cancelForNavigation();
    };
    viewport?.addEventListener("wheel", cancelForNavigation, { passive: true });
    viewport?.addEventListener("touchmove", cancelForNavigation, { passive: true });
    viewport?.addEventListener("pointerdown", cancelForNavigation, { passive: true });
    viewport?.ownerDocument.addEventListener("keydown", onScrollKey);
    const position = rememberedPosition;
    const index = restoreRowIndex;
    const targetRowId = rows[index]?.id;
    if (cancelPositionRestoreRef) cancelPositionRestoreRef.current = cancelRestoration;
    const cleanup = () => {
      cancelled = true;
      if (cancelPositionRestoreRef?.current === cancelRestoration) {
        cancelPositionRestoreRef.current = null;
      }
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      viewport?.removeEventListener("wheel", cancelForNavigation);
      viewport?.removeEventListener("touchmove", cancelForNavigation);
      viewport?.removeEventListener("pointerdown", cancelForNavigation);
      viewport?.ownerDocument.removeEventListener("keydown", onScrollKey);
    };
    if (positionHistoryLoading || waitingForReadingHistory) return cleanup;
    // Left while following: back to where the follow is now (chat/liveFollowOffset.ts).
    const followingPromptId = position?.followingPromptId;
    if (followingPromptId) {
      returnToLiveFollow({
        list,
        rows,
        composerInset: contentInsetEndAdjustment,
        promptId: followingPromptId,
        cancelled: () => cancelled,
        nextFrame: (step) => {
          settleFrame = requestAnimationFrame(step);
        },
        done: () => {
          setPositionedThreadKey(listIdentityKey);
          // The follow carries on from here while the prompt's run still works.
          onResumeFollow?.(followingPromptId);
        },
      });
      return cleanup;
    }
    const scrolling =
      position && index >= 0
        ? list.scrollToIndex({
            index,
            animated: false,
            viewPosition: 0,
            viewOffset: -restoreOffset,
          })
        : list.scrollToEnd({ animated: false });
    void Promise.resolve(scrolling).then(() => {
      if (cancelled) return;
      if (!position || index < 0) {
        // Rows measure after the first jump; keep the end in view until the
        // list height holds for two frames, so a fresh open lands at the end.
        let stableEndFrames = 0;
        let remainingEndFrames = 60;
        const settleAtEnd = () => {
          if (cancelled) return;
          const element = list.getScrollableNode();
          if (!element || --remainingEndFrames <= 0) {
            // Gave up: the list never held still (see settledListThreadKey).
            setAbandonedPositionKey(listIdentityKey);
            setPositionedThreadKey(listIdentityKey);
            return;
          }
          if (element.scrollHeight - element.clientHeight - element.scrollTop > 1) {
            stableEndFrames = 0;
            void Promise.resolve(list.scrollToEnd({ animated: false })).then(() => {
              if (!cancelled) settleFrame = requestAnimationFrame(settleAtEnd);
            });
            return;
          }
          if (++stableEndFrames >= 2) setPositionedThreadKey(listIdentityKey);
          else settleFrame = requestAnimationFrame(settleAtEnd);
        };
        settleFrame = requestAnimationFrame(settleAtEnd);
        return;
      }
      // Index scrolling starts from estimates. Keep the saved row mounted
      // until its measured position and the DOM agree for two layout frames.
      let stableFrames = 0;
      let remainingFrames = 60;
      const reconcile = () => {
        if (cancelled) return;
        if (--remainingFrames <= 0) {
          // Gave up: the list never held still (see settledListThreadKey).
          setAbandonedPositionKey(listIdentityKey);
          setPositionedThreadKey(listIdentityKey);
          return;
        }
        const state = list.getState();
        const rowIndex = targetRowId === undefined ? undefined : state.indexByKey(targetRowId);
        const row = rowIndex === undefined ? undefined : state.elementAtIndex(rowIndex);
        const element = list.getScrollableNode();
        if (!row || !element) {
          settleFrame = requestAnimationFrame(reconcile);
          return;
        }
        const offset = Math.max(
          0,
          Math.min(
            element.scrollTop +
              row.getBoundingClientRect().top -
              element.getBoundingClientRect().top +
              restoreOffset,
            element.scrollHeight - element.clientHeight,
          ),
        );
        if (Math.abs(element.scrollTop - offset) > 1) {
          stableFrames = 0;
          void list.scrollToOffset({ offset, animated: false }).then(() => {
            if (!cancelled) settleFrame = requestAnimationFrame(reconcile);
          });
          return;
        }
        if (++stableFrames >= 2) {
          setPositionedThreadKey(listIdentityKey);
        } else {
          settleFrame = requestAnimationFrame(reconcile);
        }
      };
      settleFrame = requestAnimationFrame(reconcile);
    });
    return cleanup;
  }, [
    citationRequest,
    anchorMessageId,
    cancelPositionRestoreRef,
    listIdentityKey,
    listRef,
    onManualNavigation,
    rememberedPosition,
    restoringThreadPosition,
    rows,
    restoreRowIndex,
    restoreOffset,
    waitingForReadingHistory,
    positionHistoryLoading,
    readingListLoaded,
    contentInsetEndAdjustment,
    onResumeFollow,
    setPositionedThreadKey,
    setAbandonedPositionKey,
  ]);
}
