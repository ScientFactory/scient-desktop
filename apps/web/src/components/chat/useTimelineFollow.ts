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
import {
  type MessageId,
  type ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

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
import { type ChatComposerHandle } from "./ChatComposer";
import { createPageScrollController, type PageScrollKey } from "./pageScrollController";
import { createUpwardScrollDetector, isTimelineScrollTarget } from "./timelineScrollTarget";

import { releaseChatTimelineAnchor } from "../ChatView.logic";
import type { Dispatch, RefObject } from "react";

const TIMELINE_SCROLL_CANCEL_SENTINEL = Object.freeze({});

interface TimelineAnchor {
  readonly threadKey: string | null;
  readonly messageId: MessageId | null;
}

interface TimelineFollowInput {
  readonly legendListRef: RefObject<LegendListRef | null>;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly composerOverlayElement: HTMLDivElement | null;
  readonly composerTimelineInset: number;
  readonly routeThreadKey: string;
  readonly activeThreadKey: string | null;
  readonly activeThreadId: ThreadId | undefined;
  readonly isServerThread: boolean;
  readonly serverProjection: OrchestrationV2ThreadProjection | null;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly isDraftHeroState: boolean;
  readonly hasLatestRun: boolean;
  readonly turnUnfinished: boolean;
  readonly currentRouteThreadKeyRef: RefObject<string | null>;
  readonly setTimelineAnchor: Dispatch<SetStateAction<TimelineAnchor>>;
}

// SCIENT-FORK: bounded send-follow and reader policy have one owner in this extracted host.
export function useTimelineFollow(input: TimelineFollowInput) {
  const {
    legendListRef,
    composerRef,
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
  useLayoutEffect(() => {
    turnUnfinishedRef.current = turnUnfinished;
  });
  // SCIENT-FORK:START — reader navigation (A): the end control owns Scroll to end and its
  // unread count (chat/useTimelineEndControl.ts) and changes the follow modes once per
  // transition. The timeline never pins to its end, so a report of leaving it is never
  // swallowed (that hid Scroll to end while an answer grew below). One owner for the send
  // follow (chat/responseFollow.ts). The reader's navigation cancels placement and the
  // follow without removing reserved room. This extracted host composes Scient's policy.
  const timelineScrollIntentRef = useRef<"toward-end" | "away-from-end" | null>(null);
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
    // Arriving at the end by scrolling toward it brings back a collapsed composer.
    onReachedEnd: () => {
      if (timelineScrollIntentRef.current === "toward-end") {
        composerRef.current?.restoreAfterTimelineReachedEnd();
      }
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
      // While following or anchoring, our scrollToEnd/scrollToOffset calls can
      // sit in LegendList's pending-imperative-scroll queue (it defers them
      // while layout settles) and fire seconds later with stale targets,
      // yanking the view away after the user scrolled. Starting a new
      // imperative scroll cancels everything queued; targeting an item that
      // is not in the data makes the new request itself resolve without ever
      // scrolling, so this is a pure cancel.
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
    timelineScrollIntentRef.current = key === "PageUp" ? "away-from-end" : "toward-end";
    composerRef.current?.collapseForTimelineScrollKey(key);
    // SCIENT-FORK:START — Page Up always cancels placement and the follow; Page Down never does.
    if (key === "PageUp") cancelTimelinePositioning();
    // SCIENT-FORK:END
  });
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
  // SCIENT-FORK:START — reader navigation (C): Scroll to end is one-shot (it releases reserved
  // room, ends the follow and never re-arms following); a send captures whether the reader
  // was at the end and frames the prompt; a queued prompt delivered while at the end gets
  // the same follow (chat/responseFollow.ts).
  // Explicit navigation is a one-shot operation; it never enables live following.
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
  useEffect(() => {
    const composer = composerRef;
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
        // The gestures below must only break follow when they can actually
        // move the viewport away from the live edge (#5566): a spurious break
        // while pinned at the end produces no scroll event, never re-arms,
        // and streaming silently stops following. Underflowing content can't
        // scroll at all, so nothing there should break follow.
        const contentScrollsUp = () => timelineRealContentOverflowsViewportStable();
        // Any outer-list navigation cancels pending placement. Nested scrolls keep their owner.
        const handleWheel = (event: WheelEvent) => {
          if (event.ctrlKey || !isTimelineScrollTarget(event.target, scrollNode, event.deltaY))
            return;
          if (event.deltaY > 0) {
            timelineScrollIntentRef.current = "toward-end";
            if (isAtEndRef.current) {
              composer.current?.restoreAfterTimelineReachedEnd();
            }
          } else if (event.deltaY < 0) {
            timelineScrollIntentRef.current = "away-from-end";
          }
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
            timelineScrollIntentRef.current = "away-from-end";
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
          switch (event.key) {
            case "PageUp":
            case "Home":
            case "ArrowUp":
              timelineScrollIntentRef.current = "away-from-end";
              if (contentScrollsUp()) {
                handleManualNavigation();
                composer.current?.collapseForTimelineScrollKey(event.key);
              }
              break;
            case "PageDown":
            case "End":
            case "ArrowDown":
              // Moving toward the end never cancels a reveal, like scrolling down.
              timelineScrollIntentRef.current = "toward-end";
              composer.current?.collapseForTimelineScrollKey(event.key);
              if (isTimelineAtLogicalEndStable()) {
                composer.current?.restoreAfterTimelineReachedEnd();
              }
              break;
            default:
              break;
          }
        };
        // Input inside an embedded frame reaches none of the listeners above,
        // but its scroll still chains out to the timeline (#17056).
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
    composerRef,
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
  const onToolOutputCollapsedAtEnd = () => {
    composerRef.current?.restoreAfterTimelineReachedEnd();
  };
  const onToolOutputCollapsedAtEndStable = useStableCallback(onToolOutputCollapsedAtEnd);

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
  useEffect(() => {
    const { followEnd } = timelineThreadReset;
    resetEndControlForThread(followEnd);
    timelineScrollIntentRef.current = null;
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
    onToolOutputCollapsedAtEndStable,
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
