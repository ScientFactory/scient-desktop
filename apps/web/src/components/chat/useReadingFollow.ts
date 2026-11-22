import type { MessageId } from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { type ChatMessage } from "../../types";
import { releaseChatTimelineAnchor } from "../ChatView.logic";
import { canApplySendAnchor, readerAtReadingEnd, savedPositionIsAtEnd } from "./readerScrollPolicy";
import { useArrivedPromptFollow, useResponseFollow } from "./responseFollow";
import { CHAT_TIMELINE_ANCHOR_OFFSET, readTimelinePosition } from "./timelineScrollAnchoring";
import {
  navigationReleasesFollow,
  type TimelineNavigation,
  type TimelineViewport,
} from "./timelineViewport";
import { type TimelineFollowPolicy, useTimelineFollow } from "./useTimelineFollow";

type TimelineFollowInput = Parameters<typeof useTimelineFollow>[0];

interface ReadingFollowInput extends Omit<TimelineFollowInput, "policy"> {
  readonly composerOverlayElement: HTMLElement | null;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly isDraftHeroState: boolean;
  readonly hasLatestRun: boolean;
  /** The latest turn runs or ended unfinished; its latest content is then the reading end. */
  readonly turnUnfinished: boolean;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
}

/**
 * While a response is followed, only moving toward older content lets go: Scient's follow
 * reveals the response from its start and yields to the reader's own scrolling toward the end
 * (chat/useBoundedAnswerFollow.ts), which hears a press or a touch drag that moves up as a scroll
 * it did not make. Otherwise the timeline's own rule applies.
 */
export function readingNavigationReleasesFollow(
  navigation: TimelineNavigation,
  viewport: Parameters<typeof navigationReleasesFollow>[1],
  followingResponse: boolean,
): boolean {
  if (!followingResponse) return navigationReleasesFollow(navigation, viewport);
  switch (navigation.source) {
    case "wheel":
    case "key":
      return navigation.direction === "up" && viewport.contentScrollsUp();
    case "pointer":
    case "touch":
      return false;
    case "scroll":
      return true;
    case "command":
      return navigation.releasesFollow;
  }
}

/**
 * Scient's reading policy on the timeline's follow (chat/useTimelineFollow.ts): a sent prompt's
 * response is revealed from its start rather than pinned to the live end, only a thread's first
 * prompt is anchored, the end is the answer's readable content, and the end control shows
 * whenever the reader is away from it, with the unread count below.
 */
export function useReadingFollow(input: ReadingFollowInput) {
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
  // Whether the reader is at the reading end, as the timeline last reported it.
  const isAtEndRef = useRef(true);
  const turnUnfinishedRef = useRef(turnUnfinished);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the turn state into a ref read by scroll measurements outside render
  useLayoutEffect(() => {
    turnUnfinishedRef.current = turnUnfinished;
  });
  const readerAtEndNow = () =>
    readerAtReadingEnd(
      legendListRef.current?.getState(),
      composerTimelineInset,
      turnUnfinishedRef.current,
    );
  const isTimelineAtLogicalEndStable = useStableCallback(
    () => readerAtEndNow() ?? isAtEndRef.current,
  );
  // A first prompt being placed, or a scroll to the end in flight: saves and the follow wait.
  const [timelinePositioningPending, setTimelinePositioningPending] = useState(false);
  const [unreadBelowCount, setUnreadBelowCount] = useState(0);
  // The first prompt this window sent, until its placement ends.
  const placedAnchorRef = useRef<MessageId | null>(null);
  // Counts navigations that let go of the follow, so a send framed after one is not applied.
  const navigationGenerationRef = useRef(0);
  const responseFollow = useResponseFollow({
    threadKey: routeThreadKey,
    runs: serverProjection?.runs,
    messages: timelineMessages,
    loaded: !isServerThread || serverProjection !== null,
  });
  const {
    start: startResponseFollow,
    join: joinResponseFollow,
    clear: clearResponseFollow,
  } = responseFollow;
  const followingResponse = responseFollow.promptId !== null;

  // A new thread starts over: its end control shows at once when it reopens mid-history.
  const [resetThreadKey, setResetThreadKey] = useState(routeThreadKey);
  if (resetThreadKey !== routeThreadKey) {
    setResetThreadKey(routeThreadKey);
    setTimelinePositioningPending(false);
    setUnreadBelowCount(0);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets the reading-end ref and the navigation generation the scroll handlers read for a new thread
  useLayoutEffect(() => {
    isAtEndRef.current = savedPositionIsAtEnd(readTimelinePosition(routeThreadKey));
    navigationGenerationRef.current += 1;
    clearResponseFollow();
  }, [routeThreadKey, clearResponseFollow]);

  const policy: TimelineFollowPolicy = {
    releasesFollow: (navigation, viewport) =>
      readingNavigationReleasesFollow(navigation, viewport, followingResponse),
    onNavigation: (_navigation, released) => {
      if (!released) return;
      navigationGenerationRef.current += 1;
      clearResponseFollow();
      setTimelinePositioningPending(false);
    },
    // Page Up always lets go; Page Down only moves toward the end.
    pageScrollReleasesFollow: (key) => key === "PageUp",
    // A prompt arriving at the end is followed instead (useArrivedPromptFollow below).
    anchorStartedRuns: false,
    // The follow reveals the response from its start; it never jumps to the live end.
    releaseAnchorForActivity: false,
    // Footer status never moves the reader; chat/queuedRunsInView.ts keeps their queue in view.
    followFooterGrowth: false,
    endControlWhileFollowing: true,
    // The first prompt lands where its reserved room starts.
    anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
    // Only the first prompt this window just sent is placed; an anchor kept with a saved
    // reading position (ChatView) holds its room without moving the reader.
    placesAnchor: (messageId) => messageId === placedAnchorRef.current,
    onAnchorPositioned: (messageId) => {
      if (placedAnchorRef.current === messageId) placedAnchorRef.current = null;
      setTimelinePositioningPending(false);
    },
    onScrolledToEnd: (following) => {
      setTimelinePositioningPending(false);
      if (!following) return;
      legendListRef.current?.getScrollableNode()?.dispatchEvent(new Event("scroll"));
      joinResponseFollow();
    },
  };
  const follow = useTimelineFollow({ ...input, policy });
  const { attachComposerOverlay } = follow;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the composer overlay element to the page-key scroll padding
  useLayoutEffect(() => {
    attachComposerOverlay(composerOverlayElement);
    return () => attachComposerOverlay(null);
  }, [attachComposerOverlay, composerOverlayElement]);

  const onIsAtEndChange = useStableCallback((isAtEnd: boolean) => {
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) setUnreadBelowCount(0);
    follow.onIsAtEndChangeStable(isAtEnd);
  });

  // Scroll to end stops the follow while it moves, then rejoins a working thread's follow.
  const scrollToEnd = useStableCallback((animated: boolean = false) => {
    clearResponseFollow();
    setTimelinePositioningPending(true);
    follow.scrollToEnd(animated);
  });

  const captureSendReadingPosition = () => ({
    atEnd: isDraftHeroState || (readerAtEndNow() ?? isAtEndRef.current),
    firstMessage: !hasLatestRun && !timelineMessages.some((message) => message.role === "user"),
    threadKey: routeThreadKey,
    navigationGeneration: navigationGenerationRef.current,
  });
  /** A send from the reading end reveals the prompt and follows its whole response. */
  const frameSubmittedMessage = (
    messageId: MessageId,
    snapshot: ReturnType<typeof captureSendReadingPosition>,
  ) => {
    if (
      !canApplySendAnchor({
        ...snapshot,
        currentThreadKey: currentRouteThreadKeyRef.current ?? "",
        currentNavigationGeneration: navigationGenerationRef.current,
      })
    )
      return;
    follow.followLiveEnd();
    startResponseFollow(messageId);
    if (!snapshot.firstMessage) return;
    // A thread's first prompt is placed at the top; the follow starts from there.
    setTimelinePositioningPending(true);
    placedAnchorRef.current = messageId;
    follow.anchorNewTurn(activeThreadKey ?? routeThreadKey, messageId);
  };

  // A prompt arriving while the reader is at the end, from anywhere, gets the same follow as a send.
  const latestPrompt = timelineMessages.findLast((message) => message.role === "user") ?? null;
  useArrivedPromptFollow({
    threadKey: routeThreadKey,
    latestPrompt,
    readerAtEnd: () => isAtEndRef.current,
    followingPromptId: responseFollow.promptId,
    follow: (promptId) => {
      if (!responseFollow.followable(promptId)) return;
      follow.followLiveEnd();
      startResponseFollow(promptId);
    },
  });

  return {
    showScrollToBottom: follow.showScrollToBottom,
    unreadBelowCount,
    setUnreadBelowCount,
    timelinePositioningPending,
    responseFollow,
    isTimelineAtLogicalEndStable,
    onComposerPageScrollKeyDownStable: follow.onComposerPageScrollKeyDownStable,
    onComposerPageScrollKeyUpStable: follow.onComposerPageScrollKeyUpStable,
    onComposerPageScrollReleaseStable: follow.onComposerPageScrollReleaseStable,
    scrollToEnd,
    onTimelineAnchorReadyStable: follow.onTimelineAnchorReadyStable,
    onTimelineAnchorSizeChangedStable: follow.onTimelineAnchorSizeChangedStable,
    onIsAtEndChange,
    attachTimelineViewport: follow.attachTimelineViewport as (
      viewport: TimelineViewport,
    ) => () => void,
    captureSendReadingPosition,
    frameSubmittedMessage,
    releaseUnusedTimelineAnchor: () => setTimelineAnchor(releaseChatTimelineAnchor),
  };
}
