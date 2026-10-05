import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { MessageId, RunId } from "@t3tools/contracts";
import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { readerAtReadingEnd, readingIdentity } from "./readerScrollPolicy";
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
    rememberTimelinePosition(listIdentityKey, {
      ...position,
      ...identity,
      offsetWithinRow: identity.rowId
        ? element.getBoundingClientRect().top - row.getBoundingClientRect().top
        : 0,
      atEnd: readerAtReadingEnd(state, contentInsetEndAdjustment, turnUnfinished) ?? false,
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
