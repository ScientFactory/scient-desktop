import { canApplySendAnchor, savedPositionIsAtEnd, readerAtReadingEnd } from "./readerScrollPolicy";
import { followModeAfterEndTransition, useTimelineEndControl } from "./useTimelineEndControl";
import { useQueuedDeliveryFollow, useResponseFollow } from "./responseFollow";
import { type ChatMessage } from "../../types";

import { useStableCallback } from "../../hooks/useStableCallback";
import {
  eventPathContainsSelector,
  TYPE_TO_FOCUS_EDITABLE_SELECTOR,
  TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR,
} from "./composerFocusRedirect";
import { type MessageId } from "@t3tools/contracts";

import {
  type SetStateAction,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type LegendListRef } from "@legendapp/list/react";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  timelineContentOverflowsViewport,
  readTimelinePosition,
  type TimelineScrollMode,
} from "./timelineScrollAnchoring";
import { createPageScrollController, type PageScrollKey } from "./pageScrollController";
import { createUpwardScrollDetector, isTimelineScrollTarget } from "./timelineScrollTarget";

import { releaseChatTimelineAnchor } from "../ChatView.logic";
import type { Dispatch, RefObject } from "react";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";

const TIMELINE_SCROLL_CANCEL_SENTINEL = Object.freeze({});

interface TimelineAnchor {
  readonly threadKey: string | null;
  readonly messageId: MessageId | null;
}

interface TimelineFollowInput {
  readonly legendListRef: RefObject<LegendListRef | null>;
  readonly composerOverlayElement: HTMLDivElement | null;
  readonly composerTimelineInset: number;
  readonly routeThreadKey: string;
  readonly activeThreadKey: string | null;
  readonly isServerThread: boolean;
  readonly serverProjection: ThreadStructure | null;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly isDraftHeroState: boolean;
  readonly hasLatestRun: boolean;
  readonly turnUnfinished: boolean;
  readonly currentRouteThreadKeyRef: RefObject<string | null>;
  readonly setTimelineAnchor: Dispatch<SetStateAction<TimelineAnchor>>;
}

// Bounded send-follow and reader policy have one owner in this extracted host.
export function useTimelineFollow(input: TimelineFollowInput) {
  const {
    legendListRef,
    composerOverlayElement,
    composerTimelineInset,
    routeThreadKey,
    activeThreadKey,
    isServerThread,
    serverProjection,
    timelineMessages,
    isDraftHeroState,
    hasLatestRun,
    turnUnfinished,
    currentRouteThreadKeyRef,
    setTimelineAnchor,
  } = input;
  const isAtEndRef = useRef(true);
  const turnUnfinishedRef = useRef(false);
  const readerAtEndNow = () =>
    readerAtReadingEnd(
      legendListRef.current?.getState(),
      composerTimelineInset,
      turnUnfinishedRef.current,
    );
  const isTimelineAtLogicalEnd = () => readerAtEndNow() ?? isAtEndRef.current;
  const isTimelineAtLogicalEndStable = useStableCallback(isTimelineAtLogicalEnd);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the turn state into a ref read by scroll measurements outside render
  useLayoutEffect(() => {
    turnUnfinishedRef.current = turnUnfinished;
  });
  // SCIENT-FORK:START — useTimelineEndControl owns end controls, unread counts and follow transitions.
  // Never swallow leaving-end reports as an answer grows; responseFollow owns send following.
  // Reader navigation cancels placement/follow without removing reserved room.
  const timelineScrollModeRef = useRef<TimelineScrollMode>("free-scrolling");
  const anchorUserScrollGenerationRef = useRef(0);
  const liveFollowUserScrollGenerationRef = useRef<number | null>(0);
  const {
    showScrollToBottom,
    unreadBelowCount,
    setUnreadBelowCount,
    resetForThread: resetEndControlForThread,
    onIsAtEndChange: onEndControlIsAtEndChange,
  } = useTimelineEndControl({
    isAtEndRef,
    onReachedEnd: () => {
      // The follow modes change once per transition, as in upstream's handler;
      // a first send being placed keeps its own.
      if (followModeAfterEndTransition(timelineScrollModeRef.current, "reached") === null) return;
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      // The reader came back to the end on their own: the anchored run framing is over.
      setTimelineAnchor(releaseChatTimelineAnchor);
    },
    onLeftEnd: () => {
      if (followModeAfterEndTransition(timelineScrollModeRef.current, "left") === null) return;
      timelineScrollModeRef.current = "free-scrolling";
      liveFollowUserScrollGenerationRef.current = null;
    },
  });
  const [timelinePositioningPending, setTimelinePositioningPending] = useState(false);
  // One owner for the send follow: which prompt's response is followed, settled by that
  // prompt's own V2 run (chat/responseFollow.ts).
  const responseFollow = useResponseFollow({
    threadKey: routeThreadKey,
    runs: serverProjection?.runs,
    messages: timelineMessages,
    loaded: !isServerThread || serverProjection !== null,
  });
  const { start: startResponseFollow, clear: clearResponseFollow } = responseFollow;
  const followSentPrompt = responseFollow.followSent;
  const positionedTimelineAnchorRef = useRef<MessageId | null>(null);
  const programmaticScrollPendingRef = useRef(false);
  const cancelPositionRestoreRef = useRef<(() => void) | null>(null);
  const settledTimelineAnchorRef = useRef<MessageId | null>(null);
  const activeTimelineAnchorIndexRef = useRef<number | null>(null);
  const pendingAnchorScrollRestoreRef = useRef<{
    readonly messageId: MessageId;
    readonly offset: number;
    readonly userScrollGeneration: number;
  } | null>(null);
  const anchorScrollRestoreFrameRef = useRef<number | null>(null);
  // Manual navigation cancels pending placement without removing anchored end space.
  // Collapsing that space during a gesture clamps the viewport back to the end.
  const cancelTimelinePositioning = () => {
    cancelPositionRestoreRef.current?.();
    anchorUserScrollGenerationRef.current += 1;
    const wasProgrammaticScrollMode = timelineScrollModeRef.current !== "free-scrolling";
    if (positionedTimelineAnchorRef.current !== null || programmaticScrollPendingRef.current) {
      const list = legendListRef.current;
      const node = list?.getScrollableNode();
      if (node) void list?.scrollToOffset(liveScrollOffsetRequest(node));
    }
    timelineScrollModeRef.current = "free-scrolling";
    liveFollowUserScrollGenerationRef.current = null;
    clearResponseFollow();
    setTimelinePositioningPending(false);
    programmaticScrollPendingRef.current = false;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    pendingAnchorScrollRestoreRef.current = null;
    if (anchorScrollRestoreFrameRef.current !== null) {
      cancelAnimationFrame(anchorScrollRestoreFrameRef.current);
      anchorScrollRestoreFrameRef.current = null;
    }
    if (wasProgrammaticScrollMode) {
      // LegendList may run queued scrolls after user navigation. A new imperative
      // scroll cancels that queue; a missing item cancels without moving the view.
      void legendListRef.current?.scrollToItem({
        item: TIMELINE_SCROLL_CANCEL_SENTINEL,
        animated: false,
      });
      // An already-started animated scroll (behavior: smooth) keeps running in
      // the browser regardless of the queue; a same-position instant write is
      // the only way to halt it where it is.
      const scrollNode = legendListRef.current?.getScrollableNode() as
        | { scrollTop?: number }
        | null
        | undefined;
      const currentScrollTop = scrollNode?.scrollTop;
      if (scrollNode && typeof currentScrollTop === "number") {
        scrollNode.scrollTop = currentScrollTop;
      }
    }
  };
  const cancelTimelinePositioningRef = useRef(cancelTimelinePositioning);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the latest cancel callback into a ref read by DOM scroll listeners
  useEffect(() => {
    cancelTimelinePositioningRef.current = cancelTimelinePositioning;
  }, [cancelTimelinePositioning]);
  // SCIENT-FORK:END
  const timelineRealContentOverflowsViewport = (list?: LegendListRef | null) =>
    timelineContentOverflowsViewport((list ?? legendListRef.current)?.getState(), {
      composerInset: composerTimelineInset,
      anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
    });
  const timelineRealContentOverflowsViewportStable = useStableCallback(
    timelineRealContentOverflowsViewport,
  );
  const pageScrollControllerRef = useRef<ReturnType<typeof createPageScrollController> | null>(
    null,
  );
  const handlePageScrollStart = useEffectEvent((key: PageScrollKey) => {
    // SCIENT-FORK:START — Page Up always cancels placement and the follow; Page Down never does.
    if (key === "PageUp") cancelTimelinePositioning();
    // SCIENT-FORK:END
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the page scroll controller attached to the timeline's scroll container
  useEffect(() => {
    const controller = createPageScrollController({
      getContainer: () => legendListRef.current?.getScrollableNode() ?? null,
      getScrollPaddingBottomPx: () => composerOverlayElement?.getBoundingClientRect().height ?? 0,
      onScrollStart: handlePageScrollStart,
    });
    pageScrollControllerRef.current = controller;

    return () => {
      controller.dispose();
      if (pageScrollControllerRef.current === controller) {
        pageScrollControllerRef.current = null;
      }
    };
  }, [composerOverlayElement, legendListRef]);
  const onComposerPageScrollKeyDown = (key: PageScrollKey) => {
    pageScrollControllerRef.current?.handleKeyDown(key);
  };
  const onComposerPageScrollKeyDownStable = useStableCallback(onComposerPageScrollKeyDown);
  const onComposerPageScrollKeyUp = (key: string) => {
    pageScrollControllerRef.current?.handleKeyUp(key);
  };
  const onComposerPageScrollKeyUpStable = useStableCallback(onComposerPageScrollKeyUp);
  const onComposerPageScrollRelease = () => {
    pageScrollControllerRef.current?.releaseActiveKey();
  };
  const onComposerPageScrollReleaseStable = useStableCallback(onComposerPageScrollRelease);
  // SCIENT-FORK:START — Scroll to end releases room and follows once; it never re-arms live following.
  // Sends capture end position and frame the prompt; queued prompts delivered at the end share responseFollow.
  const scrollToEnd = (animated = false) => {
    cancelTimelinePositioning();
    const generation = anchorUserScrollGenerationRef.current;
    setTimelineAnchor(releaseChatTimelineAnchor);
    programmaticScrollPendingRef.current = true;
    setTimelinePositioningPending(true);
    requestAnimationFrame(() => {
      if (generation !== anchorUserScrollGenerationRef.current) return;
      void Promise.resolve(
        legendListRef.current?.scrollToEnd({
          animated: animated && !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        }),
      ).then(() => {
        if (generation !== anchorUserScrollGenerationRef.current) return;
        programmaticScrollPendingRef.current = false;
        setTimelinePositioningPending(false);
        legendListRef.current?.getScrollableNode()?.dispatchEvent(new Event("scroll"));
      });
    });
  };

  const captureSendReadingPosition = () => ({
    atEnd: isDraftHeroState || (readerAtEndNow() ?? isAtEndRef.current),
    firstMessage: !hasLatestRun && !timelineMessages.some((message) => message.role === "user"),
    threadKey: routeThreadKey,
    navigationGeneration: anchorUserScrollGenerationRef.current,
  });
  const frameSubmittedMessage = (
    messageId: MessageId,
    snapshot: ReturnType<typeof captureSendReadingPosition>,
  ) => {
    if (
      !canApplySendAnchor({
        ...snapshot,
        currentThreadKey: currentRouteThreadKeyRef.current ?? "",
        currentNavigationGeneration: anchorUserScrollGenerationRef.current,
      })
    )
      return;
    if (!snapshot.firstMessage) {
      // One bounded controller reveals the prompt and follows its whole response
      // to the end. Retain existing tail space until it can disappear without
      // clamping the viewport.
      cancelTimelinePositioning();
      followSentPrompt(messageId, snapshot.firstMessage);
      return;
    }
    cancelPositionRestoreRef.current?.();
    // The first prompt keeps its placement; its answer is revealed.
    followSentPrompt(messageId, snapshot.firstMessage);
    timelineScrollModeRef.current = "anchoring-new-turn";
    setTimelinePositioningPending(true);
    positionedTimelineAnchorRef.current = null;
    setTimelineAnchor({ threadKey: activeThreadKey, messageId });
  };
  // A queued prompt the server delivers while the reader is at the end gets the same follow
  // as a send.
  const latestPrompt = timelineMessages.findLast((message) => message.role === "user") ?? null;
  const readerWasAtEnd = () => isAtEndRef.current;
  const followDeliveredPrompt = (promptId: MessageId) => {
    cancelTimelinePositioning();
    startResponseFollow(promptId, true);
  };
  useQueuedDeliveryFollow({
    threadKey: routeThreadKey,
    latestPrompt,
    readerAtEnd: readerWasAtEnd,
    follow: followDeliveredPrompt,
  });
  // SCIENT-FORK:END
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches reader scroll opt-out listeners to the timeline's scroll node for this thread
  useEffect(() => {
    const attachedThreadKey = routeThreadKey;
    let removeListeners: (() => void) | null = null;
    let frame: number | null = null;
    const attach = (remainingAttempts: number) => {
      frame = requestAnimationFrame(() => {
        frame = null;
        if (currentRouteThreadKeyRef.current !== attachedThreadKey) return;
        const scrollNode = legendListRef.current?.getScrollableNode();
        if (!scrollNode) {
          // The list may not have mounted on the first frame after a thread
          // switch — without a retry the opt-out listeners never attach and
          // live-follow becomes impossible to escape for the whole thread.
          if (remainingAttempts > 0) {
            attach(remainingAttempts - 1);
          }
          return;
        }
        // SCIENT-FORK:START — reader navigation (D): wheel, touch, scrollbar drag and keys cancel
        // placement and the follow only when moving toward older content that can scroll
        // (touch direction and scrollbar-drag detection are Scient); moving toward the end
        // never cancels.
        const handleManualNavigation = () => {
          cancelTimelinePositioningRef.current();
        };
        // Only break follow for gestures that can move away from the live edge.
        // A spurious break emits no scroll event to re-arm follow, so streaming stops
        // following. Underflowing content cannot scroll and must keep following.
        const contentScrollsUp = () => timelineRealContentOverflowsViewportStable();
        // Any outer-list navigation cancels pending placement. Nested scrolls keep their owner.
        const handleWheel = (event: WheelEvent) => {
          if (event.ctrlKey || !isTimelineScrollTarget(event.target, scrollNode, event.deltaY))
            return;
          // Scrolling down, momentum toward the end and pinch never cancel a
          // reveal; scrolling back up through content does.
          if (event.deltaY < 0 && contentScrollsUp()) {
            handleManualNavigation();
          }
        };
        // A finger moving down drags older content into view: that is scrolling
        // back up, which cancels. Direction is read move by move, so reversing
        // a drag counts. Dragging toward newer content never cancels.
        let touchY: number | null = null;
        const handleTouchStart = (event: TouchEvent) => {
          touchY = event.touches[0]?.clientY ?? null;
        };
        const handleTouchMove = (event: TouchEvent) => {
          const y = event.touches[0]?.clientY;
          if (touchY === null || y === undefined) return;
          const movedTowardOlder = y - touchY > 2;
          touchY = y;
          if (movedTowardOlder && contentScrollsUp()) {
            handleManualNavigation();
          }
        };
        // Pointer presses (content clicks, selection, padding) never cancel on
        // their own. A scrollbar drag is a press on the scroll node itself;
        // once it actually moves toward older content, it is scrolling up.
        let scrollbarDrag: { top: number } | null = null;
        const handlePointerDown = (event: PointerEvent) => {
          scrollbarDrag = event.target === scrollNode ? { top: scrollNode.scrollTop } : null;
        };
        const handlePointerUp = () => {
          scrollbarDrag = null;
        };
        const handleScrollbarScroll = () => {
          if (!scrollbarDrag) return;
          if (scrollNode.scrollTop < scrollbarDrag.top - 2) {
            scrollbarDrag = null;
            handleManualNavigation();
          } else {
            scrollbarDrag.top = Math.max(scrollbarDrag.top, scrollNode.scrollTop);
          }
        };

        // Keyboard scrolling (PageUp/Home/ArrowUp) bypasses wheel and
        // pointer events entirely; without this the timeline yanks back to
        // the end on the next stream chunk. Clicking message text can leave
        // DOM focus on body, so these keys must also be heard at document.
        const handleKeyDown = (event: KeyboardEvent) => {
          if (
            !(event.target instanceof Node) ||
            (!scrollNode.contains(event.target) &&
              event.target !== document.body &&
              event.target !== document.documentElement) ||
            event.defaultPrevented ||
            event.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR) ||
            document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)
          ) {
            return;
          }
          if (!["PageUp", "Home", "ArrowUp", "PageDown", "End", "ArrowDown"].includes(event.key))
            return;
          const scrollDirection = ["PageUp", "Home", "ArrowUp"].includes(event.key) ? -1 : 1;
          if (
            scrollNode.contains(event.target) &&
            !isTimelineScrollTarget(event.target, scrollNode, scrollDirection)
          )
            return;
          // Moving toward the end never cancels a reveal, like scrolling down.
          if (scrollDirection < 0 && contentScrollsUp()) {
            handleManualNavigation();
          }
        };
        // Input inside an embedded frame reaches none of the listeners above,
        // but its scroll still chains out to the timeline.
        const scrolledUp = createUpwardScrollDetector({
          top: scrollNode.scrollTop,
          height: scrollNode.scrollHeight,
        });
        const handleScroll = () => {
          if (
            scrolledUp({
              top: scrollNode.scrollTop,
              height: scrollNode.scrollHeight,
              programmatic:
                positionedTimelineAnchorRef.current !== null &&
                positionedTimelineAnchorRef.current !== settledTimelineAnchorRef.current,
            }) &&
            timelineScrollModeRef.current !== "free-scrolling" &&
            // LegendList updates its scroll state on the next animation frame.
            !isTimelineAtLogicalEndStable()
          ) {
            handleManualNavigation();
          }
        };
        scrollNode.addEventListener("scroll", handleScroll, { passive: true });
        scrollNode.addEventListener("wheel", handleWheel, {
          passive: true,
        });
        scrollNode.addEventListener("pointerdown", handlePointerDown, { passive: true });
        scrollNode.ownerDocument.addEventListener("pointerup", handlePointerUp);
        scrollNode.ownerDocument.addEventListener("pointercancel", handlePointerUp);
        // Some engines end a scrollbar drag with mouseup and no pointerup.
        scrollNode.ownerDocument.addEventListener("mouseup", handlePointerUp);
        scrollNode.addEventListener("scroll", handleScrollbarScroll, { passive: true });
        scrollNode.addEventListener("touchstart", handleTouchStart, {
          passive: true,
        });
        scrollNode.addEventListener("touchmove", handleTouchMove, {
          passive: true,
        });
        document.addEventListener("keydown", handleKeyDown);
        removeListeners = () => {
          scrollNode.removeEventListener("scroll", handleScroll);
          scrollNode.removeEventListener("wheel", handleWheel);
          scrollNode.removeEventListener("pointerdown", handlePointerDown);
          scrollNode.ownerDocument.removeEventListener("pointerup", handlePointerUp);
          scrollNode.ownerDocument.removeEventListener("pointercancel", handlePointerUp);
          scrollNode.ownerDocument.removeEventListener("mouseup", handlePointerUp);
          scrollNode.removeEventListener("scroll", handleScrollbarScroll);
          scrollNode.removeEventListener("touchstart", handleTouchStart);
          scrollNode.removeEventListener("touchmove", handleTouchMove);
          document.removeEventListener("keydown", handleKeyDown);
        };
        // SCIENT-FORK:END
      });
    };
    attach(12);

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      removeListeners?.();
    };
  }, [
    routeThreadKey,
    currentRouteThreadKeyRef,
    legendListRef,
    isTimelineAtLogicalEndStable,
    timelineRealContentOverflowsViewportStable,
  ]);

  // SCIENT-FORK:START — reader navigation (E): only the first message is placed, by message id at
  // the timeline's anchor offset; measurement updates never restart a finished or cancelled
  // placement, and its end clears the positioning flag.
  const onTimelineAnchorReady = (messageId: MessageId, _anchorIndex: number) => {
    // Measurement updates may not restart a completed or cancelled placement.
    if (timelineScrollModeRef.current !== "anchoring-new-turn") {
      return;
    }
    if (positionedTimelineAnchorRef.current === messageId) {
      return;
    }
    positionedTimelineAnchorRef.current = messageId;
    const positionAnchor = (remainingAttempts: number) => {
      requestAnimationFrame(() => {
        if (positionedTimelineAnchorRef.current !== messageId) {
          return;
        }
        const list = legendListRef.current;
        if (!list) {
          if (remainingAttempts > 0) {
            positionAnchor(remainingAttempts - 1);
          }
          return;
        }
        const currentAnchorIndex = list
          .getState()
          .data.findIndex(
            (row: { kind: string; message?: { id: string } }) =>
              row.kind === "message" && row.message?.id === messageId,
          );
        if (currentAnchorIndex < 0) return;
        void list
          .scrollToIndex({
            index: currentAnchorIndex,
            animated: true,
            viewPosition: 0,
            viewOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
          })
          .then(() => {
            if (positionedTimelineAnchorRef.current !== messageId) {
              return;
            }
            setTimelinePositioningPending(false);
            positionedTimelineAnchorRef.current = null;
            timelineScrollModeRef.current = "free-scrolling";
            legendListRef.current?.getScrollableNode()?.dispatchEvent(new Event("scroll"));
          });
      });
    };
    requestAnimationFrame(() => positionAnchor(12));
  };
  const onTimelineAnchorReadyStable = useStableCallback(onTimelineAnchorReady);
  // SCIENT-FORK:END
  const onTimelineAnchorSizeChanged = (messageId: MessageId) => {
    if (settledTimelineAnchorRef.current !== messageId) {
      return;
    }
    if (liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current) {
      return;
    }
    const scrollOffset = legendListRef.current?.getState().scroll;
    if (scrollOffset === undefined) {
      return;
    }
    if (pendingAnchorScrollRestoreRef.current === null) {
      pendingAnchorScrollRestoreRef.current = {
        messageId,
        offset: scrollOffset,
        userScrollGeneration: anchorUserScrollGenerationRef.current,
      };
    }
    if (anchorScrollRestoreFrameRef.current !== null) {
      return;
    }
    anchorScrollRestoreFrameRef.current = requestAnimationFrame(() => {
      anchorScrollRestoreFrameRef.current = null;
      const pending = pendingAnchorScrollRestoreRef.current;
      pendingAnchorScrollRestoreRef.current = null;
      if (
        pending &&
        settledTimelineAnchorRef.current === pending.messageId &&
        pending.userScrollGeneration === anchorUserScrollGenerationRef.current
      ) {
        const list = legendListRef.current;
        const currentScrollOffset = list?.getState().scroll;
        if (
          typeof currentScrollOffset === "number" &&
          Math.abs(currentScrollOffset - pending.offset) <= 2
        ) {
          void list?.scrollToOffset({ offset: pending.offset, animated: false });
        }
      }
    });
  };
  const onTimelineAnchorSizeChangedStable = useStableCallback(onTimelineAnchorSizeChanged);

  // SCIENT-FORK:START — reserved room nobody can reach is released (MessagesTimeline reports it).
  const releaseUnusedTimelineAnchor = () => {
    setTimelineAnchor(releaseChatTimelineAnchor);
  };
  // SCIENT-FORK:END
  // SCIENT-FORK: upstream follows footer growth here. Scient's reading end is the latest
  // answer, so footer rows (state line, queued turns) never move a reader resting there.

  // SCIENT-FORK:START — the end-control hook owns the pill, the unread count
  // and the follow modes (its onReachedEnd/onLeftEnd above). The tool-activity
  // release below is upstream's, unchanged; it sits inside this pair only because
  // the diff cannot align it past upstream's removed end handler.
  const onIsAtEndChange = onEndControlIsAtEndChange;

  // SCIENT-FORK:END

  // SCIENT-FORK:START — reader navigation (F): a thread switch resets the end control (a thread
  // returned to mid-history shows it right away), the follow and placement, per route thread.
  // State resets during render; the refs the scroll handlers read catch up after commit.
  const [timelineThreadReset, setTimelineThreadReset] = useState(() => ({
    threadKey: routeThreadKey,
    followEnd: savedPositionIsAtEnd(readTimelinePosition(routeThreadKey)),
  }));
  if (timelineThreadReset.threadKey !== routeThreadKey) {
    const followEnd = savedPositionIsAtEnd(readTimelinePosition(routeThreadKey));
    setTimelineThreadReset({ threadKey: routeThreadKey, followEnd });
    setTimelinePositioningPending(false);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets scroll refs and the end control for a new thread, invalidating the previous thread's scroll generation on cleanup
  useEffect(() => {
    const { followEnd } = timelineThreadReset;
    resetEndControlForThread(followEnd);
    timelineScrollModeRef.current = followEnd ? "following-end" : "free-scrolling";
    liveFollowUserScrollGenerationRef.current = followEnd
      ? anchorUserScrollGenerationRef.current
      : null;
    clearResponseFollow();
    programmaticScrollPendingRef.current = false;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    return () => {
      anchorUserScrollGenerationRef.current += 1;
    };
  }, [timelineThreadReset, resetEndControlForThread, clearResponseFollow]);
  // SCIENT-FORK:END

  return {
    showScrollToBottom,
    unreadBelowCount,
    setUnreadBelowCount,
    timelinePositioningPending,
    responseFollow,
    cancelPositionRestoreRef,
    isTimelineAtLogicalEndStable,
    onComposerPageScrollKeyDownStable,
    onComposerPageScrollKeyUpStable,
    onComposerPageScrollReleaseStable,
    scrollToEnd,
    onTimelineAnchorReadyStable,
    onTimelineAnchorSizeChangedStable,
    onIsAtEndChange,
    captureSendReadingPosition,
    frameSubmittedMessage,
    releaseUnusedTimelineAnchor,
    cancelTimelinePositioning,
  };
}

function liveScrollOffsetRequest(node: { readonly scrollTop: number }) {
  return {
    get offset() {
      return node.scrollTop;
    },
    animated: false,
  };
}
