import type { TimelineResponseFollow } from "./responseFollow";
import { deriveTimelineSendMotion } from "./timelineEntranceMotion";
import { useWorkingRowExit } from "./workingRowExit";
import { useBoundedAnswerFollow } from "./useBoundedAnswerFollow";
import {
  timelineRowsKey,
  type RestingAtReadingEnd,
  useReaderScrollInput,
  useReadingBookkeepingFrame,
  useReadingRestoreTarget,
  useSaveReadingPosition,
} from "./readerScrolling";
import { countUnreadBelow, unreadMessagesForThread } from "./unreadTimelineMessages";
import {
  latestTurnUnfinished,
  readerAtReadingEnd,
  readingEndAllowance,
  readingEndGapOnScreen,
} from "./readerScrollPolicy";
import {
  emptyAgentPanelModel,
  type AgentPanelModel,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { observeLiveActivitySweep } from "./liveActivity";
import { type ChatMessage } from "../../types";
import { deriveTerminalAssistantMessageIds } from "./MessagesTimeline.logic";
import { settledListThreadKey } from "../scient-fork/forkLanding";
import type { OrchestrationV2ContextTransfer } from "@t3tools/contracts";
import { ScanTextIcon } from "lucide-react";
import { ForkMarkerSeparator } from "~/scient/fork/ForkMarkerSeparator";
import { TRACE_ICON_STROKE } from "~/scient/presentation/traceIcons";
import { AudioPreviewUnmountContext } from "../files/AudioPreview";
import { ThreadFindTimelineContext } from "./ThreadFindProvider";
import { MarkdownFindContext } from "./markdownFindContext";
import { useChatCanvas } from "./ChatCanvasContext";
import { WorkLogBlock } from "./WorkLog";
import type { WorktreeSetupSnapshot } from "@t3tools/contracts";
import { deriveTimelineMinimapItems } from "./timelineMinimapItems";
import {
  type AssistantCitation,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2TurnItem,
  type RunAttemptId,
  type ServerProviderSkill,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";

import type { WorkflowOpening } from "@t3tools/client-runtime/state/subagentRuntime";
import { observeResize } from "~/lib/observeResize";
import { useStableCallback } from "~/hooks/useStableCallback";

const NOOP_USE_ARTIFACT_TEMPLATE = () => {};
const NOOP_OPEN_ATTACHMENT = (_attachment: ChatFileAttachment) => {};

import { resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";

import {
  memo,
  use,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { type TimelineEntry } from "../../session-logic";
import type { CodexArtifactTemplate } from "@t3tools/shared/codexArtifactTemplates";
import { type ChatFileAttachment, type TurnDiffSummary } from "../../types";
import { ArrowRightIcon, BotIcon, CircleAlertIcon } from "lucide-react";
import { ChevronDown, ChevronRight } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  readTimelinePosition,
  type RememberedTimelinePosition,
  timelineContentOverflowsViewport,
} from "./timelineScrollAnchoring";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { type AssistantCitationRequest } from "./AssistantCitationSource";
import { useAssistantCitationTarget, type CitationHistoryPage } from "./useAssistantCitationTarget";
import {
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapCurrentIndex,
  isTimelineMinimapRowVisible,
  resolveTimelineMinimapVisibleRange,
  resolveTimelineMinimapHitStripWidth,
  timelineTurnFoldRunIdsByEntryId,
  worktreeSetupAgentStarted,
  type MessagesTimelineRow,
  type TimelineLatestRun,
} from "./MessagesTimeline.logic";
import { type ThreadFindMatch } from "./threadFind";
import { useThreadFindNavigation } from "./useThreadFindNavigation";
import { TooltipScrollDismissArea } from "../ui/tooltip";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useClientSettings } from "~/hooks/useSettings";

import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { type HandoffTimelineRun } from "./V2LifecycleRow";
import { TimelineSystemDivider } from "./TimelineSystemDivider";

import { forwardWheelToTimeline } from "./timelineMinimapWheel";
import { TimelineMinimap } from "./TimelineMinimap";
import {
  type TimelineRowSharedState,
  type TimelineRowActivityState,
  TimelineRowCtx,
  TimelineRowActivityCtx,
  type WorkGroupViewState,
  type TimelineRow,
} from "./timelineRowContext";
import { TimelineRowTimestamp, ActivityShimmerOverlay } from "./TimelineRowParts";
import {
  WorkGroupSection,
  WorkingTimelineRow,
  FadingThinkingTimelineRow,
  LiveWorkEntryTimelineRow,
  WorkGroupToggleTimelineRow,
} from "./TimelineWorkGroupRows";
import { UserMessageRow } from "./TimelineUserMessageRow";
import {
  AssistantTimelineRow,
  AssistantMetaTimelineRow,
  ProposedPlanTimelineRow,
  HtmlRenderTimelineRow,
  McpAppTimelineRow,
} from "./TimelineAssistantRows";
import { V2EventTimelineRow } from "./TimelineV2EventRow";
import { useTimelinePositionRestore } from "./useTimelinePositionRestore";
import { useThreadFindPositionReader } from "./useThreadFindPositionReader";
import { ThreadActivityAnnouncer } from "./ThreadActivityAnnouncer";
import { useStableHandoffRuns, useIncrementalTimelineRows, useStableRows } from "./useTimelineRows";

function timelineListStateFor(identity: string): {
  readonly identity: string;
  readonly rememberedPosition: RememberedTimelinePosition | undefined;
  readonly workGroupViewState: WorkGroupViewState;
} {
  const rememberedPosition = readTimelinePosition(identity);
  return {
    identity,
    rememberedPosition,
    workGroupViewState: rememberedPosition?.disclosures?.workGroupState ?? {
      scrollPositions: new Map(),
      expandedEntries: new Set(),
    },
  };
}

const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FADE_HEADER = (
  <div className="h-[var(--workspace-titlebar-scroll-fade-height)]" />
);
function TimelineListFooter({
  composerInset,
  children,
}: {
  readonly composerInset: number;
  readonly children?: ReactNode;
}) {
  return (
    <div>
      {children}
      <div aria-hidden style={{ height: composerInset }} />
      <div aria-hidden className="h-3 sm:h-4" />
    </div>
  );
}

const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const EMPTY_RUN_IDS: ReadonlySet<RunId> = new Set();

export interface MessagesTimelineHistoryControls {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: (throughEntryId?: string) => void;
}

interface MessagesTimelineProps {
  citationRequest?: AssistantCitationRequest | null;
  citationHistoryLoading?: boolean;
  onCiteAssistantText?: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
  // SCIENT-FORK:START — agent-spawn rows read the agent panel model.
  agentPanelModel?: AgentPanelModel;
  onOpenAgents?: () => void;
  // SCIENT-FORK:END
  isWorking: boolean;
  runlessWorkActive?: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt?: string | null;
  worktreeSetup?: WorktreeSetupSnapshot | null;
  onCancelWorktreeSetup?: () => void;
  retryableWorkspacePreparationRunIds?: ReadonlySet<RunId>;
  onRetryWorkspacePreparation?: (runId: RunId) => void;
  onWorktreeSetupWorkLocally?: () => void;
  onOpenWorktreeSetupTerminal?: (terminalId: string) => void;
  isPreparingWorktree?: boolean;
  isCompacting?: boolean;
  awaitingUser?: "approval" | "input" | null;
  /** Which request is waiting, so a second one of the same kind is announced too. */
  awaitingRequestId?: string | null;
  footer?: ReactNode;

  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReadonlyArray<TimelineEntry>;
  // SCIENT-FORK:START — hides the fork-initialization handoff event.
  contextTransfers?: ReadonlyArray<OrchestrationV2ContextTransfer> | undefined;
  // SCIENT-FORK:END
  latestRun: TimelineLatestRun | null;
  /** The run the screen reader announcer follows; see announcedRun. */
  announcedRun?: { readonly runId: RunId; readonly status: TimelineLatestRun["status"] } | null;
  /** See isDetailBehindShell. */
  detailBehindShell?: boolean;
  runningRunId?: RunId | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  routeThreadKey: string;
  displayThreadKey?: string;
  paintOnly?: boolean;
  /** Off where another region already speaks the thread's status, like a subagent's bar. */
  announceTurnStatus?: boolean;
  onOpenTurnDiff?: (runId: RunId, filePath?: string) => void;
  onOpenThread: (threadId: OrchestrationV2TurnItem["threadId"]) => void;
  renderHtmlRender?: TimelineRowSharedState["renderHtmlRender"];
  turnItemSource?: TimelineRowSharedState["turnItemSource"];
  parentThreadLink?: {
    readonly threadId: ThreadId;
    readonly title: string;
  } | null;

  workflowOpening?: WorkflowOpening | null;
  onForkFromRun?: (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => Promise<void>;
  onRollbackCheckpoint: (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => void;
  supportsConversationRollback: boolean;
  threadStartCheckpointReady?: boolean;
  availableRevertTurnCounts?: ReadonlySet<number> | undefined;
  onRevertToTurnCount: (targetTurnCount: number, messageId: MessageId) => void;
  // SCIENT-FORK:START — Scient fork V2: separators and fork buttons.
  hasForkBaseline?: boolean;
  forkBaselineAssistantMessageId?: MessageId | null;
  forkOriginThreadId?: ThreadId | undefined;
  onForkAssistantMessage?: (messageId: MessageId) => void;
  onForkUserMessage?: (message: ChatMessage) => void;
  // SCIENT-FORK:END
  onUseArtifactTemplate?: (template: CodexArtifactTemplate) => void;
  onSendAppMessage?: (text: string) => Promise<void>;
  onRunShellCommand?: (command: string) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onFileOpen?: (attachment: ChatFileAttachment) => void;
  onFileDownload?: (attachment: ChatFileAttachment) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  runs: ReadonlyArray<HandoffTimelineRun>;
  anchorMessageId: MessageId | null;
  onAnchorReady: (messageId: MessageId, anchorIndex: number) => void;
  onAnchorSizeChanged: (messageId: MessageId, size: number) => void;
  contentInsetEndAdjustment: number;
  // SCIENT-FORK:START — placement in flight, the send follow and releasing unused reserved room.
  timelinePositioningPending?: boolean;
  readingFollowPromptId?: string | null;
  /** The send follow's lifecycle, owned by ChatView (chat/responseFollow.ts). */
  responseFollow?: TimelineResponseFollow;
  onReleaseUnusedAnchor?: () => void;
  // SCIENT-FORK:END
  onIsAtEndChange: (isAtEnd: boolean) => void;
  // SCIENT-FORK:START — the unread count below; no live-follow flag: the timeline never pins
  // to its end.
  onUnreadBelowChange?: (count: number) => void;
  // SCIENT-FORK:END
  /**
   * Whether the real rows extend past the viewport above the composer.
   * Reported after scrolls, row size changes, and viewport resizes.
   */
  onContentOverflowChange?: (overflows: boolean) => void;
  onToolOutputCollapsedAtEnd?: () => void;
  onManualNavigation: () => void;
  findOpen?: boolean;
  cancelPositionRestoreRef?: React.RefObject<(() => void) | null> | undefined;
  // SCIENT-FORK:START — a landing fork shows once its list is in place (scient/fork/chatViewFork.tsx).
  /** The thread whose rows the loaded list has positioned and held still, else null. */
  onPositionedThreadKeyChange?: ((threadKey: string | null) => void) | undefined;
  // SCIENT-FORK:END
  hideEmptyPlaceholder?: boolean;
  // SCIENT-FORK:START — the restore waits while older history loads.
  positionHistoryLoading?: boolean;
  // SCIENT-FORK:END
  /** Composer space to center the empty state against; held steady through collapse. */
  emptyPlaceholderInset: number;
  topFadeEnabled?: boolean;
  historyControls?: MessagesTimelineHistoryControls | undefined;
  loadEarlier?: CitationHistoryPage | null;
  findExpanded?: boolean;
  findQuery?: string;
  activeFindMatch?: ThreadFindMatch | null;
  findNavigationId?: number;
}

export function MessagesTimeline(props: MessagesTimelineProps) {
  const find = useContext(ThreadFindTimelineContext);
  const findOpen = find?.findOpen ?? props.findOpen;
  const { onManualNavigation } = props;
  useEffect(() => {
    if (findOpen) onManualNavigation();
  }, [findOpen, onManualNavigation]);
  return <ConversationTimeline {...props} {...find} />;
}

const ConversationTimeline = memo(function ConversationTimeline({
  citationRequest = null,
  citationHistoryLoading = false,
  onCiteAssistantText,
  // SCIENT-FORK:START
  agentPanelModel,
  onOpenAgents = NOOP_OPEN_AGENTS,
  // SCIENT-FORK:END
  isWorking,
  runlessWorkActive = false,
  activeTurnInProgress,
  activeTurnStartedAt = null,
  worktreeSetup = null,
  footer = null,
  onCancelWorktreeSetup,
  retryableWorkspacePreparationRunIds = EMPTY_RUN_IDS,
  onRetryWorkspacePreparation,
  onWorktreeSetupWorkLocally,
  onOpenWorktreeSetupTerminal,
  isPreparingWorktree = false,
  isCompacting = false,
  awaitingUser = null,
  awaitingRequestId = null,
  listRef,
  timelineEntries,
  // SCIENT-FORK:START
  contextTransfers,
  // SCIENT-FORK:END
  findExpanded = false,
  findQuery = "",
  activeFindMatch = null,
  findNavigationId = 0,
  latestRun,
  announcedRun = null,
  detailBehindShell = false,
  runningRunId = null,
  turnDiffSummaries,
  routeThreadKey,
  displayThreadKey,
  paintOnly = false,
  announceTurnStatus = true,
  onOpenTurnDiff,
  onOpenThread,
  renderHtmlRender,
  turnItemSource,
  parentThreadLink = null,
  workflowOpening = null,
  onForkFromRun,
  onRollbackCheckpoint,
  supportsConversationRollback,
  threadStartCheckpointReady = false,
  availableRevertTurnCounts,
  onRevertToTurnCount,
  // SCIENT-FORK:START
  hasForkBaseline,
  forkBaselineAssistantMessageId,
  forkOriginThreadId,
  onForkAssistantMessage,
  onForkUserMessage,
  // SCIENT-FORK:END
  onUseArtifactTemplate = NOOP_USE_ARTIFACT_TEMPLATE,
  onSendAppMessage,
  onRunShellCommand,
  isRevertingCheckpoint,
  onImageExpand,
  onFileOpen = NOOP_OPEN_ATTACHMENT,
  onFileDownload = NOOP_OPEN_ATTACHMENT,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  runs: runsProp,
  anchorMessageId,
  onAnchorReady,
  onAnchorSizeChanged,
  contentInsetEndAdjustment,
  // SCIENT-FORK:START — placement in flight, the send follow and releasing unused reserved room.
  timelinePositioningPending = false,
  readingFollowPromptId = null,
  responseFollow,
  onReleaseUnusedAnchor,
  // SCIENT-FORK:END
  onIsAtEndChange,
  // SCIENT-FORK:START — the unread count below.
  onUnreadBelowChange,
  // SCIENT-FORK:END
  onContentOverflowChange,
  onToolOutputCollapsedAtEnd,
  onManualNavigation,
  cancelPositionRestoreRef,
  // SCIENT-FORK:START
  onPositionedThreadKeyChange,
  // SCIENT-FORK:END
  hideEmptyPlaceholder = false,
  // SCIENT-FORK:START — the restore waits while older history loads.
  positionHistoryLoading = false,
  // SCIENT-FORK:END
  emptyPlaceholderInset,
  topFadeEnabled = false,
  historyControls,
  loadEarlier = null,
}: MessagesTimelineProps) {
  const listIdentityKey = displayThreadKey ?? routeThreadKey;
  // Snapshot restore positions on identity changes; ongoing scroll writes must not move them.
  const [listState, setListState] = useState(() => timelineListStateFor(listIdentityKey));
  const [expandedRunIds, setExpandedRunIds] = useState<ReadonlySet<RunId>>(
    () => listState.rememberedPosition?.disclosures?.runs ?? new Set(),
  );
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(
    () => listState.rememberedPosition?.disclosures?.workGroups ?? new Set(),
  );
  const [expandedAttemptIds, setExpandedAttemptIds] = useState<ReadonlySet<RunAttemptId>>(
    () => listState.rememberedPosition?.disclosures?.attempts ?? new Set(),
  );
  // SCIENT-FORK:START — spawn rows expand in place; upstream dropped this
  // disclosure, so it lives only for the mounted thread.
  const [expandedSpawnEntryIds, setExpandedSpawnEntryIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // SCIENT-FORK:END
  // SCIENT-FORK:START — the reading end, the loaded list and older-history paging for the restore.
  // Whether the latest run is unfinished: its latest content is then the reading end.
  const turnUnfinished = latestTurnUnfinished(runningRunId, latestRun?.status);
  const turnUnfinishedRef = useRef(turnUnfinished);
  useLayoutEffect(() => {
    turnUnfinishedRef.current = turnUnfinished;
  });
  const [readingListLoaded, setReadingListLoaded] = useState(false);
  const requestedReadingPages = useRef({ key: listIdentityKey, cursors: new Set<string>() });
  // Runs before the restore target's paging effect, which reads these cursors.
  useLayoutEffect(() => {
    if (requestedReadingPages.current.key !== listIdentityKey) {
      requestedReadingPages.current = { key: listIdentityKey, cursors: new Set() };
    }
  }, [listIdentityKey]);
  // A saved message that no longer exists (a revert, a deleted turn) must not
  // page in the whole history: after a few pages, a neighbor or the end is used.
  const [readingHistoryPages, setReadingHistoryPages] = useState({
    key: listIdentityKey,
    count: 0,
  });
  // SCIENT-FORK:END
  const [positionedThreadKey, setPositionedThreadKey] = useState<string | null>(() =>
    listState.rememberedPosition?.atEnd === false ? null : listIdentityKey,
  );
  const restoringThreadPosition = positionedThreadKey !== listIdentityKey;
  // SCIENT-FORK:START — the thread whose positioning ran out of frames before it held
  // still. No reduced-motion check and no settling identity: nothing glides to or pins the end.
  const [abandonedPositionKey, setAbandonedPositionKey] = useState<string | null>(null);
  // SCIENT-FORK:END
  const [playingAudioRows, setPlayingAudioRows] = useState<ReadonlyMap<HTMLAudioElement, string>>(
    () => new Map(),
  );
  let paintedExpandedRunIds = expandedRunIds;
  let paintedExpandedWorkGroupIds = expandedWorkGroupIds;
  let paintedExpandedAttemptIds = expandedAttemptIds;
  // SCIENT-FORK:START
  let paintedExpandedSpawnEntryIds = expandedSpawnEntryIds;
  // SCIENT-FORK:END
  const identityChanged = listState.identity !== listIdentityKey;
  const { rememberedPosition, workGroupViewState } = identityChanged
    ? timelineListStateFor(listIdentityKey)
    : listState;
  if (identityChanged) {
    setPlayingAudioRows(new Map());
    setListState({ identity: listIdentityKey, rememberedPosition, workGroupViewState });
    setPositionedThreadKey(null);
    // SCIENT-FORK:START — a new thread's positioning starts over; no settling identity.
    setAbandonedPositionKey(null);
    // SCIENT-FORK:END
    paintedExpandedRunIds = rememberedPosition?.disclosures?.runs ?? new Set();
    paintedExpandedWorkGroupIds = rememberedPosition?.disclosures?.workGroups ?? new Set();
    paintedExpandedAttemptIds = rememberedPosition?.disclosures?.attempts ?? new Set();
    // SCIENT-FORK:START
    paintedExpandedSpawnEntryIds = new Set();
    setExpandedSpawnEntryIds(paintedExpandedSpawnEntryIds);
    // SCIENT-FORK:END
    setExpandedRunIds(paintedExpandedRunIds);
    setExpandedWorkGroupIds(paintedExpandedWorkGroupIds);
    setExpandedAttemptIds(paintedExpandedAttemptIds);
  }
  const citationThreadRef = parseScopedThreadKey(routeThreadKey);
  const openPullRequest = useOpenPrLink(citationThreadRef ?? undefined);
  const expandCitedRun = (runId: RunId) => {
    setExpandedRunIds((current) => (current.has(runId) ? current : new Set([...current, runId])));
  };
  // SCIENT-FORK:START — agent-spawn rows expand in place (scient/presentation/AgentSpawnRow.tsx).
  const onToggleSpawnRow = (entryId: string, expanded: boolean, runId?: RunId) => {
    setExpandedSpawnEntryIds((current) => {
      if (current.has(entryId) === expanded) return current;
      const next = new Set(current);
      if (expanded) next.add(entryId);
      else next.delete(entryId);
      return next;
    });
    // A reader opening Scient members must not lose them to the parent's fold at settlement.
    if (expanded && runId !== undefined) {
      setExpandedRunIds((current) => (current.has(runId) ? current : new Set([...current, runId])));
    }
  };
  // SCIENT-FORK:END
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  // SCIENT-FORK:START — the reader's own scrolling input, held until their movement has
  // stopped: a drag, an animated wheel notch or key scroll moves for several frames.
  const readerInputRef = useRef(false);
  const scrollbarHeldRef = useRef(false);
  const lastBookkeepingScrollRef = useRef<number | null>(null);
  const stillFramesRef = useRef(0);
  // Schedules a bookkeeping pass; set once the per-frame scheduler exists.
  const scheduleBookkeepingRef = useRef<() => void>(() => {});
  // SCIENT-FORK:END
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const disclosureSettleFrameRef = useRef<number | null>(null);
  const disclosureSettleSecondFrameRef = useRef<number | null>(null);
  const normalizedFindQuery = findQuery.trim();
  const findActive = findExpanded;

  useEffect(() => {
    return () => {
      if (disclosureSettleFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleFrameRef.current);
      }
      if (disclosureSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
      }
    };
  }, []);

  // SCIENT-FORK:START — a toggle never pins the end; the toggled row keeps its place, and
  // collapsing at the reading end still reports it (no settling identity, no end pin).
  const suspendEndScrollMaintenanceForDisclosure = (anchorKey: string, collapsed = false) => {
    disclosureAnchorKeyRef.current = anchorKey;
    setDisclosureToggleSettling(true);
    if (disclosureSettleFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleFrameRef.current);
    }
    if (disclosureSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
    }
    disclosureSettleFrameRef.current = requestAnimationFrame(() => {
      disclosureSettleSecondFrameRef.current = requestAnimationFrame(() => {
        disclosureAnchorKeyRef.current = null;
        setDisclosureToggleSettling(false);
        disclosureSettleFrameRef.current = null;
        disclosureSettleSecondFrameRef.current = null;
        // Wait for row measurement and the disclosure click's blur check.
        // Closing output can reveal the end without a scroll event.
        if (
          collapsed &&
          readerAtReadingEnd(
            listRef.current?.getState(),
            contentInsetEndAdjustment,
            turnUnfinishedRef.current,
          ) === true
        ) {
          onToolOutputCollapsedAtEnd?.();
        }
      });
    });
  };
  // SCIENT-FORK:END

  const shouldRestoreVisibleContentPosition = (row: MessagesTimelineRow) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || row.id === disclosureAnchorKey;
  };

  const onToggleTurnFold = (runId: RunId) => {
    suspendEndScrollMaintenanceForDisclosure(`turn-fold:${runId}`);
    setExpandedRunIds((existing) => {
      const next = new Set(existing);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  };
  const onToggleWorkGroup = (groupId: string, anchorKey: string) => {
    suspendEndScrollMaintenanceForDisclosure(anchorKey, expandedWorkGroupIds.has(groupId));
    setExpandedWorkGroupIds((existing) => {
      const next = new Set(existing);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };
  const onToggleAttemptFold = (attemptId: RunAttemptId) => {
    suspendEndScrollMaintenanceForDisclosure(`attempt-fold:${attemptId}`);
    setExpandedAttemptIds((existing) => {
      const next = new Set(existing);
      if (next.has(attemptId)) {
        next.delete(attemptId);
      } else {
        next.add(attemptId);
      }
      return next;
    });
  };

  const previousLatestRunRef = useRef({ identity: listIdentityKey, run: latestRun });
  useEffect(() => {
    const { identity, run: previous } = previousLatestRunRef.current;
    previousLatestRunRef.current = { identity: listIdentityKey, run: latestRun };
    if (identity !== listIdentityKey || !latestRun || previous?.runId === undefined) {
      return;
    }
    if (latestRun.runId === previous.runId) {
      if (previous.status === "running" && latestRun.status === "interrupted") {
        setExpandedRunIds((existing) => {
          const next = new Set(existing);
          next.add(latestRun.runId);
          return next;
        });
      }
      return;
    }
    setExpandedRunIds((existing) => {
      if (!existing.has(previous.runId)) {
        return existing;
      }
      const next = new Set(existing);
      next.delete(previous.runId);
      return next;
    });
  }, [latestRun, listIdentityKey]);

  // Imported turns and post-steer work fold under synthetic keys, not the entries' run ids.
  const findFoldRunIds = findActive
    ? timelineTurnFoldRunIdsByEntryId({
        timelineEntries,
        latestRun,
        runningRunId,
        isWorking,
        runlessWorkActive,
      })
    : null;
  const activeFindRunId =
    findActive && activeFindMatch ? findFoldRunIds?.get(activeFindMatch.entryId) : undefined;
  const [expandedFindRunId, setExpandedFindRunId] = useState<RunId | undefined>();
  if (expandedFindRunId !== activeFindRunId) {
    setExpandedFindRunId(activeFindRunId);
    if (activeFindRunId) {
      setExpandedRunIds((previous) =>
        previous.has(activeFindRunId) ? previous : new Set(previous).add(activeFindRunId),
      );
    }
  }
  const visibleExpandedRunIds =
    !activeFindRunId || paintedExpandedRunIds.has(activeFindRunId)
      ? paintedExpandedRunIds
      : new Set(paintedExpandedRunIds).add(activeFindRunId);

  const activeFindAttemptId = activeFindMatch
    ? timelineEntries.find((entry) => entry.id === activeFindMatch.entryId)?.attempt?.id
    : undefined;
  const [expandedFindAttemptId, setExpandedFindAttemptId] = useState<RunAttemptId | undefined>();
  if (expandedFindAttemptId !== activeFindAttemptId) {
    setExpandedFindAttemptId(activeFindAttemptId);
    if (activeFindAttemptId) {
      setExpandedAttemptIds((previous) =>
        previous.has(activeFindAttemptId) ? previous : new Set(previous).add(activeFindAttemptId),
      );
    }
  }
  const visibleExpandedAttemptIds =
    activeFindAttemptId && !paintedExpandedAttemptIds.has(activeFindAttemptId)
      ? new Set(paintedExpandedAttemptIds).add(activeFindAttemptId)
      : paintedExpandedAttemptIds;

  // SCIENT-FORK:START — match the row header's liveness so a finished
  // sub-agent stops reading as live work.
  const subagentWorkflowIds = new Map(
    (agentPanelModel?.workflows ?? []).flatMap((group) => [
      [group.workflow.id, group.workflow.id] as const,
      ...group.phases
        .flatMap((phase) => phase.members)
        .map((member) => [member.id, group.workflow.id] as const),
      ...group.unphasedMembers.map((member) => [member.id, group.workflow.id] as const),
    ]),
  );
  // SCIENT-FORK:END
  const rawRows = useIncrementalTimelineRows(`${listIdentityKey}\0${workspaceRoot ?? ""}`, {
    timelineEntries,
    latestRun,
    runningRunId,
    expandedRunIds: visibleExpandedRunIds,
    expandedAttemptIds: visibleExpandedAttemptIds,
    expandedWorkGroupIds,
    isWorking,
    runlessWorkActive,
    activeTurnStartedAt,
    turnDiffSummaries,
    supportsConversationRollback,
    // SCIENT-FORK:START
    hasForkBaseline,
    forkBaselineAssistantMessageId,
    contextTransfers,
    subagentWorkflowIds,
    // SCIENT-FORK:END
    threadStartCheckpointReady,
    availableRevertTurnCounts,
    worktreeSetup,
  });
  // SCIENT-FORK:START — a finished turn's working header closes its space (chat/workingRowExit.ts).
  const stableRows = useStableRows(rawRows, listIdentityKey);
  const { rows, exit: workingRowExit } = useWorkingRowExit(stableRows, listIdentityKey);
  // SCIENT-FORK:END
  // SCIENT-FORK:START — ChatView owns the follow; a finished one ends there too.
  // A finished reveal (revealed or cancelled) no longer holds off idle end keeping.
  const [finishedRevealPromptId, setFinishedRevealPromptId] = useState<string | null>(null);
  const onFollowFinished = responseFollow?.onFinished;
  const onResumeFollow = responseFollow?.onResume;
  const onRevealFinished = (promptId: string) => {
    setFinishedRevealPromptId(promptId);
    onFollowFinished?.(promptId);
    // The saved reading position records a follow still going: save it again
    // now, rather than at the reader's next scroll or the next content change.
    scheduleBookkeepingRef.current();
  };
  const revealActive =
    readingFollowPromptId !== null && finishedRevealPromptId !== readingFollowPromptId;
  // The follow settles with the prompt's own run, and says what it follows.
  const followingPromptId = useBoundedAnswerFollow({
    listRef,
    rows,
    promptMessageId: readingFollowPromptId,
    responseSettled: responseFollow ? responseFollow.settled : !isWorking,
    suspended:
      paintOnly ||
      findActive ||
      timelinePositioningPending ||
      restoringThreadPosition ||
      positionHistoryLoading,
    composerInset: contentInsetEndAdjustment,
    followResponse: responseFollow?.followsResponse ?? false,
    onFinished: onRevealFinished,
  });
  // SCIENT-FORK:END
  // Run status/timestamps change per stream event; keep them out of shared row context.
  const runs = useStableHandoffRuns(runsProp);
  const minimapItems = deriveTimelineMinimapItems(rows);
  const minimapRowIndices = minimapItems.map((item) => item.rowIndex);
  // SCIENT-FORK:START — restore by message identity, paging in older history (chat/readerScrolling.ts).
  const { restoreRowIndex, restoreOffset, waitingForReadingHistory } = useReadingRestoreTarget({
    rows,
    rememberedPosition,
    restoringThreadPosition,
    positionHistoryLoading,
    loadEarlier,
    listIdentityKey,
    readingHistoryPages,
    setReadingHistoryPages,
    requestedReadingPages,
  });
  // SCIENT-FORK:END
  const restoringAlwaysRender =
    restoringThreadPosition && restoreRowIndex >= 0 ? { indices: [restoreRowIndex] } : undefined;
  // SCIENT-FORK:START — restore by message identity, settle at the end, give up visibly, and
  // return to a follow the reader left (chat/readerScrolling.ts).
  useTimelinePositionRestore({
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
  });
  // SCIENT-FORK:END
  // SCIENT-FORK:START — report the positioned thread to a landing fork.
  const positionedListThreadKey = settledListThreadKey({
    listThreadKey: listIdentityKey,
    listLoaded: readingListLoaded,
    restoring: restoringThreadPosition,
    abandonedThreadKey: abandonedPositionKey,
  });
  useLayoutEffect(() => {
    onPositionedThreadKeyChange?.(positionedListThreadKey);
  }, [onPositionedThreadKeyChange, positionedListThreadKey]);
  // SCIENT-FORK:END

  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  // SCIENT-FORK:START — the reader's own clicks, keys and scrolling input.
  const interactionSettling = useReaderScrollInput({
    listRef,
    viewport: timelineViewportElement,
    readerInputRef,
    scrollbarHeldRef,
    stillFramesRef,
    scheduleBookkeepingRef,
  });
  // SCIENT-FORK:END
  // Re-measure the minimap gutter when the chat column changes width without a viewport resize.
  const chatWidth = useClientSettings((settings) => settings.chatWidth);
  const {
    target: readyCitationRequest,
    positioning: citationPositioning,
    onListLoad: onCitationListLoad,
    alwaysRender: citationAlwaysRender,
  } = useAssistantCitationTarget({
    request: citationRequest,
    entries: timelineEntries,
    rows,
    listRef,
    viewport: timelineViewportElement,
    historyLoading: citationHistoryLoading,
    loadEarlier,
    getTurnFoldRunId: (entryId) =>
      (
        findFoldRunIds ??
        timelineTurnFoldRunIdsByEntryId({
          timelineEntries,
          latestRun,
          runningRunId,
          isWorking,
          runlessWorkActive,
        })
      ).get(entryId),
    onExpandTurn: expandCitedRun,
    onManualNavigation,
  });
  const [findListReady, setFindListReady] = useState(false);
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false);
  // SCIENT-FORK:START — the followed prompt stays rendered while its response is followed.
  const followPromptIndex = readingFollowPromptId
    ? rows.findIndex((row) => row.kind === "message" && row.message.id === readingFollowPromptId)
    : -1;
  const followAlwaysRender = followPromptIndex >= 0 ? { indices: [followPromptIndex] } : undefined;
  // SCIENT-FORK:END
  const [fullscreenAppRowId, setFullscreenAppRowId] = useState<string | null>(null);
  const onAppFullscreenChange = (rowId: string, fullscreen: boolean) => {
    setFullscreenAppRowId((current) => (fullscreen ? rowId : current === rowId ? null : current));
  };
  // SCIENT-FORK:START — the followed prompt's pin.
  const alwaysRenderIndices = [
    ...(restoringAlwaysRender?.indices ?? []),
    ...(followAlwaysRender?.indices ?? []),
  ];
  // SCIENT-FORK:END
  const alwaysRenderKeys = [
    ...(citationAlwaysRender?.keys ?? []),
    ...(fullscreenAppRowId === null ? [] : [fullscreenAppRowId]),
    ...new Set(
      [...playingAudioRows].filter(([audio]) => audio.isConnected).map(([, rowId]) => rowId),
    ),
  ];
  const alwaysRender =
    alwaysRenderIndices.length === 0 && alwaysRenderKeys.length === 0
      ? undefined
      : {
          ...(alwaysRenderIndices.length === 0 ? {} : { indices: alwaysRenderIndices }),
          ...(alwaysRenderKeys.length === 0 ? {} : { keys: alwaysRenderKeys }),
        };
  const [minimapHitStripWidth, setMinimapHitStripWidth] = useState(0);
  const [minimapCurrentIndex, setMinimapCurrentIndex] = useState<number | null>(null);
  const handleAnchorReady = (info: { anchorIndex: number | undefined }) => {
    if (anchorMessageId !== null && info.anchorIndex !== undefined) {
      onAnchorReady(anchorMessageId, info.anchorIndex);
    }
  };
  const handleAnchorSizeChanged = (size: number) => {
    if (anchorMessageId !== null) {
      onAnchorSizeChanged(anchorMessageId, size);
    }
  };
  const anchoredEndSpaceConfig = resolveChatListAnchoredEndSpace(
    rows,
    anchorMessageId,
    (row) => (row.kind === "message" && row.message.role === "user" ? row.message.id : null),
    { anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET },
  );
  const anchoredEndSpace = anchoredEndSpaceConfig
    ? {
        ...anchoredEndSpaceConfig,
        onReady: handleAnchorReady,
        onSizeChanged: handleAnchorSizeChanged,
      }
    : undefined;
  const maintainVisibleContentPosition = {
    data: true,
    size: true,
    shouldRestorePosition: shouldRestoreVisibleContentPosition,
  };
  const timelineListFooter = (
    <TimelineListFooter composerInset={anchoredEndSpace ? 0 : contentInsetEndAdjustment}>
      {footer}
    </TimelineListFooter>
  );

  const measureContentOverflow = () =>
    timelineContentOverflowsViewport(listRef.current?.getState?.(), {
      composerInset: contentInsetEndAdjustment,
      anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
    });
  // Read next frame, after LegendList's layout effects settle row positions.
  const contentOverflowFrameRef = useRef<number | null>(null);
  const cancelContentOverflowFrame = () => {
    if (contentOverflowFrameRef.current !== null) {
      cancelAnimationFrame(contentOverflowFrameRef.current);
      contentOverflowFrameRef.current = null;
    }
  };
  const reportContentOverflow = () => {
    if (!onContentOverflowChange || contentOverflowFrameRef.current !== null) return;
    contentOverflowFrameRef.current = requestAnimationFrame(() => {
      contentOverflowFrameRef.current = null;
      onContentOverflowChange(measureContentOverflow());
    });
  };
  useEffect(() => cancelContentOverflowFrame, [cancelContentOverflowFrame]);
  useLayoutEffect(() => {
    cancelContentOverflowFrame();
    onContentOverflowChange?.(measureContentOverflow());
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Added or removed rows change the content height.
  }, [cancelContentOverflowFrame, measureContentOverflow, onContentOverflowChange, rows.length]);

  // SCIENT-FORK:START — remember the reading position by row identity; the unread badge's
  // unit; where the reader rests at the reading end.
  const saveReadingPosition = useSaveReadingPosition({
    listRef,
    paintOnly,
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
  });
  // Each response's latest message: the unit the unread badge counts.
  const responseEndMessageIds = deriveTerminalAssistantMessageIds(timelineEntries);
  // Where the reader last rested at the reading end: the on-screen distance
  // to the end of the last message's text, and where that end sat in the
  // content. Null when not at the end.
  const restingAtReadingEndRef = useRef<RestingAtReadingEnd | null>(null);
  // SCIENT-FORK:END
  const refreshMinimap = useStableCallback(() => {
    const state = listRef.current?.getState?.();
    if (restoringThreadPosition || state?.data !== rows) return;
    if (!state || minimapItems.length === 0) {
      return;
    }

    const firstBufferedIndex = state.startBuffered;
    const firstBufferedRow: HTMLElement | undefined =
      firstBufferedIndex == null ? undefined : state.elementAtIndex(firstBufferedIndex);
    const firstBufferedTop =
      firstBufferedIndex == null ? undefined : state.positionAtIndex(firstBufferedIndex);
    const viewport: HTMLElement | undefined = listRef.current?.getScrollableNode();
    // Cached row positions exclude the header and pending scroll adjustments.
    const scroll =
      firstBufferedRow && viewport && firstBufferedTop !== undefined
        ? firstBufferedTop +
          viewport.getBoundingClientRect().top -
          firstBufferedRow.getBoundingClientRect().top
        : state.scroll;
    const visibleRange = resolveTimelineMinimapVisibleRange({ ...state, scroll });
    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id);
      const inView = isTimelineMinimapRowVisible(
        item.rowIndex,
        visibleRange.start,
        visibleRange.end,
      );
      const next = inView ? "true" : "false";
      // Avoid dirtying style state on every scroll tick for unchanged strips.
      if (strip && strip.dataset.inView !== next) {
        strip.dataset.inView = next;
      }
    }
    const nextCurrentIndex = resolveTimelineMinimapCurrentIndex({
      visibleStart: visibleRange.start,
      visibleEnd: visibleRange.end,
      rowIndices: minimapRowIndices,
    });
    setMinimapCurrentIndex((current) =>
      current === nextCurrentIndex ? current : nextCurrentIndex,
    );
  });

  const minimapRefreshFrameRef = useRef<number | null>(null);
  const scheduleMinimapRefresh = () => {
    if (minimapRefreshFrameRef.current !== null) return;
    // LegendList recycles row containers before React commits their positions.
    minimapRefreshFrameRef.current = requestAnimationFrame(() => {
      minimapRefreshFrameRef.current = null;
      refreshMinimap();
    });
  };

  useEffect(
    () => () => {
      if (minimapRefreshFrameRef.current !== null) {
        cancelAnimationFrame(minimapRefreshFrameRef.current);
        minimapRefreshFrameRef.current = null;
      }
    },
    [],
  );

  const handleScroll = () => {
    const state = listRef.current?.getState?.();
    // SCIENT-FORK:START — Scient's saver owns message identity and active-follow state; skip in-flight placements.
    // An upstream raw save would overwrite it. Share reader input, end reports, unread counts and room release
    // through readerScrolling and readerScrollPolicy.
    if (restoringThreadPosition || positionHistoryLoading || state?.data !== rows) return;
    saveReadingPosition();
    const viewport = listRef.current?.getScrollableNode();
    if (state && viewport && onUnreadBelowChange) {
      const messages = timelineEntries.flatMap((entry) =>
        entry.kind === "message" ? [entry.message] : [],
      );
      const unread = unreadMessagesForThread(listIdentityKey, messages, responseEndMessageIds);
      const rect = viewport.getBoundingClientRect();
      const bounds = rows.flatMap((row, index) => {
        if (row.kind !== "message" || row.message.role !== "assistant") return [];
        const element = state.elementAtIndex(index);
        const measured = element?.getBoundingClientRect();
        const top = measured?.top ?? rect.top + (state.positionAtIndex(index) ?? 0) - state.scroll;
        return [
          {
            id: row.message.id,
            top,
            bottom: measured?.bottom ?? top + (state.sizeAtIndex(index) ?? 0),
          },
        ];
      });
      onUnreadBelowChange(
        countUnreadBelow(
          unread,
          bounds,
          rect.top,
          rect.top + viewport.clientHeight - contentInsetEndAdjustment,
        ),
      );
    }
    if (state && anchorMessageId && !timelinePositioningPending) {
      const last = state.data.length - 1;
      const bottom = (state.positionAtIndex(last) ?? 0) + (state.sizeAtIndex(last) ?? 0);
      // Removing a tail wholly below the viewport cannot clamp the reading position.
      if (bottom >= state.scroll + state.scrollLength) onReleaseUnusedAnchor?.();
    }
    // The reader is at the bottom once the end's text is in view, but for at
    // most its last three lines (readerAtReadingEnd: a running turn's latest
    // content, otherwise the latest turn's answer). Reserved anchor space and
    // what trails a finished answer are not unread content.
    const isAtEnd = readerAtReadingEnd(state, contentInsetEndAdjustment, turnUnfinished);
    if (isAtEnd !== undefined && !citationPositioning) onIsAtEndChange(isAtEnd);
    // Whether the reader rests at the reading end, measured on screen (the
    // list's positions can trail the rendered rows by a frame).
    const restingGap = viewport
      ? readingEndGapOnScreen(state, viewport, contentInsetEndAdjustment)
      : null;
    restingAtReadingEndRef.current =
      restingGap !== null && viewport && restingGap <= readingEndAllowance(state)
        ? {
            gap: restingGap,
            contentEnd: restingGap + viewport.scrollTop,
            rowsKey: timelineRowsKey(state.data),
          }
        : null;
    // Clear the reader's input only once their movement has stopped: the
    // scrollbar released and a few frames in a row without movement. Until
    // then, keep checking every frame.
    const scrollNow = viewport?.scrollTop ?? null;
    if (readerInputRef.current) {
      const still =
        !scrollbarHeldRef.current &&
        scrollNow !== null &&
        lastBookkeepingScrollRef.current !== null &&
        Math.abs(scrollNow - lastBookkeepingScrollRef.current) <= 0.5;
      stillFramesRef.current = still ? stillFramesRef.current + 1 : 0;
      if (stillFramesRef.current >= 3) readerInputRef.current = false;
      else scheduleBookkeepingRef.current();
    }
    lastBookkeepingScrollRef.current = scrollNow;
    // SCIENT-FORK:END
    reportContentOverflow();
    scheduleMinimapRefresh();
  };

  // SCIENT-FORK:START — per-frame position, unread and end bookkeeping.
  const handleScrollOnNextFrame = useReadingBookkeepingFrame({
    handleScroll,
    listRef,
    paintOnly,
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
  });
  useEffect(() => {
    handleScrollOnNextFrame();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new scroll handler or added or removed rows move the scroll position.
  }, [handleScroll, handleScrollOnNextFrame, rows.length]);
  // A resized window or panel changes the viewport without a scroll or row event.
  useEffect(() => {
    const viewport = readingListLoaded ? listRef.current?.getScrollableNode() : null;
    if (!viewport) return;
    return observeResize(viewport, handleScrollOnNextFrame);
  }, [handleScrollOnNextFrame, listRef, readingListLoaded]);
  // SCIENT-FORK:END

  useEffect(() => {
    if (!timelineViewportElement) {
      return;
    }

    const measure = () => {
      const viewportWidth = timelineViewportElement.getBoundingClientRect().width;
      const contentWidth =
        timelineViewportElement
          .querySelector<HTMLElement>("[data-timeline-root]")
          ?.getBoundingClientRect().width ?? viewportWidth;
      const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(
        viewportWidth,
        contentWidth,
      );
      setMinimapHasPersistentGutter((current) =>
        current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
      );
      setMinimapHitStripWidth(resolveTimelineMinimapHitStripWidth(viewportWidth, contentWidth));
      reportContentOverflow();
    };

    const frame = requestAnimationFrame(measure);

    const stopObserving = observeResize(timelineViewportElement, measure);

    return () => {
      cancelAnimationFrame(frame);
      stopObserving();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Rows and chat width resize the content without resizing the viewport.
  }, [timelineViewportElement, rows.length, reportContentOverflow, chatWidth]);

  const sharedState: TimelineRowSharedState = {
    citationRequest: readyCitationRequest,
    listRef,
    timestampFormat,
    routeThreadKey,
    threadRef: citationThreadRef,
    markdownCwd,
    resolvedTheme,
    workspaceRoot,
    skills,
    runs,
    activeThreadEnvironmentId,
    onRevertToTurnCount,
    // SCIENT-FORK:START — expose the fork trigger to rows via context.
    onForkAssistantMessage,
    onForkUserMessage,
    forkOriginThreadId,
    // SCIENT-FORK:END
    onRunShellCommand,
    findActive,
    onImageExpand,
    onFileOpen,
    onUseArtifactTemplate,
    onSendAppMessage,
    onAppFullscreenChange,
    onFileDownload,
    openPullRequest,
    onOpenTurnDiff,
    onOpenThread,
    renderHtmlRender,
    turnItemSource,
    workflowOpening,
    onForkFromRun,
    onRollbackCheckpoint,
    onToggleTurnFold,
    onToggleAttemptFold,
    onToggleWorkGroup,
    onToggleWorkEntry: suspendEndScrollMaintenanceForDisclosure,
    // SCIENT-FORK:START
    onToggleSpawnRow,
    agentPanelModel: agentPanelModel ?? EMPTY_AGENT_PANEL_MODEL,
    expandedSpawnEntryIds: paintedExpandedSpawnEntryIds,
    onOpenAgents,
    // SCIENT-FORK:END
    onCancelWorktreeSetup: onCancelWorktreeSetup ?? null,
    retryableWorkspacePreparationRunIds,
    onRetryWorkspacePreparation: onRetryWorkspacePreparation ?? null,
    onWorktreeSetupWorkLocally: onWorktreeSetupWorkLocally ?? null,
    onOpenWorktreeSetupTerminal: onOpenWorktreeSetupTerminal ?? null,
    workGroupViewState,
  };
  const compactionAwaitingRow =
    isCompacting &&
    !rows.some(
      (row) =>
        (row.kind === "context-compaction" && row.active) ||
        (row.kind === "working" && row.compacting),
    );
  const backgroundWorktreeSetup =
    worktreeSetup !== null &&
    worktreeSetup.phase === "running" &&
    worktreeSetupAgentStarted(worktreeSetup) &&
    latestRun?.startedAt != null
      ? worktreeSetup
      : null;
  // SCIENT-FORK:START — send motion (chat/timelineEntranceMotion.ts).
  const sendMotion = deriveTimelineSendMotion({
    rows,
    timelinePositioningPending,
    anchorMessageId,
    workingRowExit,
    activityInHeader: isPreparingWorktree || compactionAwaitingRow,
  });
  // SCIENT-FORK:END
  const activityState: TimelineRowActivityState = {
    isWorking,
    // SCIENT-FORK:START — send motion.
    sendMotion,
    // SCIENT-FORK:END
    isCompacting: compactionAwaitingRow,
    isRevertingCheckpoint,
    backgroundWorktreeSetup,
    activeTurnInProgress,
    awaitingUser: awaitingUser !== null,
    isPreparingWorktree,
    latestRunId: latestRun?.runId ?? null,
  };
  // Mounted in both the empty and filled timeline so a thread's first turn
  // starts from a baseline instead of a fresh, silent region.
  const activityAnnouncer = (
    <ThreadActivityAnnouncer
      threadKey={paintOnly || !announceTurnStatus ? null : listIdentityKey}
      status={awaitingUser ?? (isWorking ? "working" : "idle")}
      requestId={awaitingRequestId}
      runId={announcedRun?.runId ?? null}
      runStatus={announcedRun?.status ?? null}
      detailBehind={detailBehindShell}
    />
  );
  const listHeaderLeadingContent =
    parentThreadLink === null ? (
      topFadeEnabled ? (
        TIMELINE_LIST_FADE_HEADER
      ) : (
        TIMELINE_LIST_HEADER
      )
    ) : (
      <div className="messages-timeline-row-frame">
        <div className="chat-content-lane pt-1 sm:pt-2">
          <TimelineSystemDivider
            label="Subagent of"
            detail={parentThreadLink.title}
            icon={BotIcon}
            actionLabel="Open parent thread"
            onAction={() => onOpenThread(parentThreadLink.threadId)}
          />
        </div>
      </div>
    );
  const listHeader = (
    <>
      {parentThreadLink === null ? listHeaderLeadingContent : null}
      {historyControls ? <TimelineHistoryControl {...historyControls} /> : null}
      {parentThreadLink !== null ? listHeaderLeadingContent : null}
    </>
  );

  const canvas = useChatCanvas();
  const registerTimeline = canvas?.registerTimeline;
  const setTimelineList = (list: LegendListRef | null) => {
    listRef.current = list;
    registerTimeline?.(list?.getScrollableNode() ?? null);
  };

  useThreadFindPositionReader({
    threadKey: listIdentityKey,
    timelineViewportElement,
    findFoldRunIds,
    timelineEntries,
    latestRun,
    runningRunId,
    isWorking,
    runlessWorkActive,
    rows,
    contentInsetEndAdjustment,
  });

  useThreadFindNavigation({
    listReady: findListReady,
    historyControls,
    entries: timelineEntries,
    container: timelineViewportElement,
    query: normalizedFindQuery,
    match: activeFindMatch,
    navigationId: findNavigationId,
    rowIndex: activeFindMatch ? rows.findIndex((row) => row.id === activeFindMatch.entryId) : -1,
    listRef,
    contentInsetEndAdjustment,
  });

  // LegendList moves rows one commit late; per-row providers prevent thread context leaks.
  const onAudioPlaybackChange = (rowId: string, event: SyntheticEvent) => {
    const audio = event.target;
    if (!(audio instanceof HTMLAudioElement)) return;
    setPlayingAudioRows((current) => {
      const playing = !audio.paused && !audio.ended;
      if (playing === current.has(audio)) return current;
      const next = new Map(current);
      if (playing) next.set(audio, rowId);
      else next.delete(audio);
      return next;
    });
  };
  const onAudioUnmount = useStableCallback((audio: HTMLAudioElement) => {
    setPlayingAudioRows((current) => {
      if (!current.has(audio)) return current;
      const next = new Map(current);
      next.delete(audio);
      return next;
    });
  });
  const renderItem = ({ item }: { item: MessagesTimelineRow }) => (
    <TimelineRowCtx value={sharedState}>
      <div
        className="messages-timeline-row-frame"
        onPlayCapture={(event) => onAudioPlaybackChange(item.id, event)}
        onPauseCapture={(event) => onAudioPlaybackChange(item.id, event)}
        onEndedCapture={(event) => onAudioPlaybackChange(item.id, event)}
      >
        <div
          className="@container/chat-lane chat-content-lane overflow-x-clip"
          data-timeline-root="true"
        >
          <AudioPreviewUnmountContext value={onAudioUnmount}>
            <TimelineRowContent row={item} />
          </AudioPreviewUnmountContext>
        </div>
      </div>
    </TimelineRowCtx>
  );
  const listExtraData = { identity: listIdentityKey, rowCount: rows.length, sharedState };

  const forwardMinimapWheel = (event: WheelEvent) => {
    const scrollNode = listRef.current?.getScrollableNode();
    if (scrollNode) forwardWheelToTimeline(event, scrollNode);
  };

  if (
    rows.length === 0 &&
    !isWorking &&
    parentThreadLink === null &&
    historyControls === undefined &&
    footer === null
  ) {
    // SCIENT-FORK:START — the inner list will remount. Block captures until its new onLoad and
    // restoration complete, so layout at offset zero cannot overwrite the receipt.
    if (readingListLoaded) {
      setReadingListLoaded(false);
      setPositionedThreadKey(null);
    }
    // SCIENT-FORK:END
    if (hideEmptyPlaceholder) {
      return (
        <>
          {activityAnnouncer}
          <div className="h-full min-h-0 bg-background" data-timeline-loading="true" />
        </>
      );
    }
    return (
      <>
        {activityAnnouncer}
        <div
          className="scient-reading-ui flex h-full items-center justify-center ps-(--chat-lane-inset-start) pe-(--chat-lane-inset-end)"
          style={{ paddingBottom: emptyPlaceholderInset }}
        >
          <p className="text-placeholder text-sm">Send a message to start the conversation.</p>
        </div>
      </>
    );
  }

  return (
    <>
      {activityAnnouncer}
      <MarkdownFindContext value={findActive}>
        <TimelineRowActivityCtx value={activityState}>
          <div className="scient-reading-ui h-full min-h-0">
            <TooltipScrollDismissArea
              ref={setTimelineViewportElement}
              className="relative h-full min-h-0"
              data-assistant-citation-viewport="true"
              // SCIENT-FORK:START — Legend coalesces public scroll callbacks into a later frame.
              // Capture the native event now, before a same-frame thread switch can replace rows.
              onScrollCapture={(event) => {
                if (event.target === listRef.current?.getScrollableNode()) saveReadingPosition();
              }}
              // SCIENT-FORK:END
            >
              {onCiteAssistantText && citationThreadRef ? (
                <AssistantSelectionToolbar
                  viewport={timelineViewportElement}
                  threadRef={citationThreadRef}
                  onCite={onCiteAssistantText}
                />
              ) : null}
              <LegendList<MessagesTimelineRow>
                ref={setTimelineList}
                data={rows}
                extraData={listExtraData}
                keyExtractor={keyExtractor}
                getItemType={getItemType}
                renderItem={renderItem}
                estimatedItemSize={90}
                // SCIENT-FORK:START — the restore places the list (chat/readerScrolling.ts).
                initialScrollAtEnd={false}
                // SCIENT-FORK:END
                // Legend needs a data refresh to mount new pins without a scroll event.
                dataVersion={`${readyCitationRequest?.key ?? listIdentityKey}:${alwaysRenderKeys.join(",")}`}
                {...(alwaysRender ? { alwaysRender } : {})}
                // SCIENT-FORK:START — the same thread can temporarily lose its loaded rows.
                // A remounted list must restore its latest receipt, not assume the old DOM
                // survived.
                onLoad={() => {
                  onCitationListLoad();
                  setFindListReady(true);
                  setListState(timelineListStateFor(listIdentityKey));
                  setPositionedThreadKey(null);
                  setReadingListLoaded(true);
                }}
                // SCIENT-FORK:END
                {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
                contentInsetEndAdjustment={anchoredEndSpace ? contentInsetEndAdjustment : 0}
                // SCIENT-FORK:START — never pins to the end; content position is not kept during
                // any restore; scrolls, row sizes and header/footer measurements run the
                // same per-frame bookkeeping. A footer is metadata, never the reading end.
                maintainScrollAtEnd={false}
                maintainVisibleContentPosition={
                  findActive || citationPositioning || restoringThreadPosition
                    ? false
                    : maintainVisibleContentPosition
                }
                maintainScrollAtEndThreshold={1}
                onScroll={handleScrollOnNextFrame}
                onItemSizeChanged={handleScrollOnNextFrame}
                onMetricsChange={handleScrollOnNextFrame}
                // SCIENT-FORK:END
                className={cn(
                  "messages-timeline-scroll scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain [overflow-anchor:none]",
                  topFadeEnabled && "topbar-scroll-fade",
                )}
                ListHeaderComponent={listHeader}
                ListFooterComponent={timelineListFooter}
              />
              <TimelineMinimap
                items={minimapItems}
                hasPersistentGutter={minimapHasPersistentGutter}
                hitStripWidth={minimapHitStripWidth}
                currentIndex={minimapCurrentIndex}
                stripMap={minimapStripMap}
                onWheel={forwardMinimapWheel}
                onSelect={(item) => {
                  onManualNavigation();
                  void listRef.current?.scrollToIndex({
                    index: item.rowIndex,
                    animated: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
                    viewOffset: 24,
                  });
                }}
              />
            </TooltipScrollDismissArea>
          </div>
        </TimelineRowActivityCtx>
      </MarkdownFindContext>
    </>
  );
});

function TimelineHistoryControl(props: MessagesTimelineHistoryControls) {
  if (!props.hasMoreHistory && props.error === null) {
    return null;
  }
  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane flex flex-col gap-1.5 pb-2">
        {props.hasMoreHistory ? (
          <button
            type="button"
            disabled={props.loading}
            aria-label="Load earlier turns"
            onClick={() => props.onLoadEarlier()}
            className="flex w-full cursor-pointer items-center gap-3 py-1.5 text-muted-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
          >
            <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
            <span className="shrink-0">
              {props.loading ? "Loading earlier turns…" : "Load earlier turns"}
            </span>
            <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
          </button>
        ) : null}
        {props.error !== null ? (
          <p role="status" className="text-center text-muted-foreground text-xs">
            {props.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

// LegendList averages by type; length buckets prevent inflated estimates and nested-update loops.
function getItemType(item: MessagesTimelineRow) {
  if (item.kind !== "message") return item.kind;
  const lengthBucket = Math.max(0, Math.floor(Math.log2(item.message.text.length / 1000)));
  return `message:${item.message.role}:${lengthBucket}`;
}

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  const isExpandedToolGroup = row.kind === "work" && row.isExpandedToolGroup;
  const isSubagentGroup = row.kind === "event" && row.projectedItem.item.type === "subagent";
  const isWorkLogRow =
    row.kind === "work" ||
    row.kind === "work-live" ||
    row.kind === "work-toggle" ||
    row.kind === "thinking";
  const isExpandedToolGroupHeader =
    (row.kind === "work-toggle" || row.kind === "work-live" || row.kind === "thinking") &&
    row.expanded === true;

  return (
    <div
      className={cn(
        isWorkLogRow || isSubagentGroup
          ? undefined
          : row.kind === "turn-fold" || row.kind === "working"
            ? "pb-1.5"
            : (row.kind === "message" &&
                  row.message.role === "assistant" &&
                  // SCIENT-FORK:START — a kept answer is spaced like the final answer.
                  !row.showAssistantMeta &&
                  row.keptAnswer !== true) ||
                // SCIENT-FORK:END
                row.kind === "worktree-setup" ||
                row.kind === "event" ||
                row.kind === "attempt-fold" ||
                row.kind === "html-render" ||
                row.kind === "mcp-app"
              ? "pb-2"
              : "pb-4",
        (row.kind === "message" && row.message.role === "assistant") ||
          row.kind === "assistant-meta"
          ? "group/assistant"
          : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={
        row.kind === "message" || row.kind === "assistant-meta" ? row.message.id : undefined
      }
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {isWorkLogRow ? (
        <WorkLogBlock
          continues={row.continuesWorkLog}
          layout={
            isExpandedToolGroup
              ? "group-content"
              : isExpandedToolGroupHeader
                ? "group-header"
                : "standalone"
          }
        >
          {row.kind === "work" ? (
            <WorkGroupSection
              anchorKey={row.id}
              groupedEntries={row.groupedEntries}
              isExpandedToolGroup={row.isExpandedToolGroup}
              displayLabel={row.displayLabel}
            />
          ) : null}
          {row.kind === "work-live" ? <LiveWorkEntryTimelineRow row={row} /> : null}
          {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
          {/* SCIENT-FORK:START — Thinking steps aside while the answer above it appears. */}
          {row.kind === "thinking" ? <FadingThinkingTimelineRow row={row} /> : null}
          {/* SCIENT-FORK:END */}
        </WorkLogBlock>
      ) : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow row={row} /> : null}
      {/* SCIENT-FORK:START — "Conversation forked here" (scient/fork/ForkMarkerSeparator.tsx). */}
      {row.kind === "fork-marker" ? <ForkMarkerTimelineRow row={row} /> : null}
      {/* SCIENT-FORK:END */}
      {row.kind === "attempt-fold" ? <AttemptFoldTimelineRow row={row} /> : null}
      {row.kind === "context-compaction" ? <ContextCompactionTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserMessageRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "assistant-meta" ? <AssistantMetaTimelineRow row={row} /> : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "html-render" ? <HtmlRenderTimelineRow row={row} /> : null}
      {row.kind === "mcp-app" ? <McpAppTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
      {row.kind === "worktree-setup" ? <WorktreeSetupTimelineRow row={row} /> : null}
      {row.kind === "event" ? <V2EventTimelineRow row={row} /> : null}
    </div>
  );
});

function WorktreeSetupTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "worktree-setup" }>;
}) {
  const ctx = use(TimelineRowCtx);
  // SCIENT-FORK:START — live activity (chat/liveActivity.tsx).
  const { sendMotion } = use(TimelineRowActivityCtx);
  // SCIENT-FORK:END
  const terminalId = row.snapshot.setupScript?.terminalId ?? null;
  const openTerminal = ctx.onOpenWorktreeSetupTerminal;
  const onOpenTerminal = openTerminal && terminalId ? () => openTerminal(terminalId) : null;
  return (
    <WorktreeSetupCard
      snapshot={row.snapshot}
      embedded={row.embedded}
      onCancel={row.embedded ? null : ctx.onCancelWorktreeSetup}
      onWorkLocally={
        !row.embedded && row.snapshot.phase === "running" ? ctx.onWorktreeSetupWorkLocally : null
      }
      onOpenTerminal={onOpenTerminal}
      // SCIENT-FORK:START — only the current activity sweeps (chat/liveActivity.tsx).
      sweep={sendMotion.currentActivityRowId === row.id}
      // SCIENT-FORK:END
    />
  );
}

function ContextCompactionTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "context-compaction" }>;
}) {
  // SCIENT-FORK:START — live activity (chat/liveActivity.tsx).
  const { sendMotion } = use(TimelineRowActivityCtx);
  const sweeping = row.active && sendMotion.currentActivityRowId === row.id;
  // SCIENT-FORK:END
  const label =
    row.title && row.label.startsWith("Context compacted")
      ? row.title + row.label.slice("Context compacted".length)
      : row.label;
  const content = (
    <span className="flex min-w-0 items-center gap-1.5">
      {row.failed ? (
        <CircleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
      ) : (
        <ScanTextIcon aria-hidden="true" className={cn("size-3", TRACE_ICON_STROKE)} />
      )}
      {row.tokenCounts ? (
        <>
          {row.title ?? "Context compacted"} {row.tokenCounts.before}
          <ArrowRightIcon aria-hidden="true" className="size-3" />
          {row.tokenCounts.after} tokens
        </>
      ) : (
        label
      )}
      {row.failure ? (
        <span className="min-w-0 truncate opacity-80">&middot; {row.failure}</span>
      ) : null}
    </span>
  );
  return (
    <div
      role="separator"
      aria-label={row.failure ? `${label}: ${row.failure}` : label}
      className={cn(
        "mx-auto flex w-full max-w-(--chat-content-max-width) items-center gap-3 py-1 text-xs",
        row.failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <span className={cn("h-px flex-1", row.failed ? "bg-destructive/30" : "bg-border/70")} />
      {/* SCIENT-FORK:START — only the current activity sweeps; its text rests lighter (chat/liveActivity.tsx). */}
      <span
        ref={sweeping ? observeLiveActivitySweep : undefined}
        className="relative min-w-0 overflow-hidden"
      >
        <span className={sweeping ? "live-activity-rest" : undefined}>{content}</span>
        {sweeping ? <ActivityShimmerOverlay>{content}</ActivityShimmerOverlay> : null}
      </span>
      {/* SCIENT-FORK:END */}
      <span className={cn("h-px flex-1", row.failed ? "bg-destructive/30" : "bg-border/70")} />
    </div>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="group/timeline-row relative flex items-center gap-1 border-b border-border/60 pb-2 pe-0.5 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        onClick={() => ctx.onToggleTurnFold(row.runId)}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span>{row.label}</span>
        <MorphIcon className="size-3.5" icon={row.expanded ? ChevronDown : ChevronRight} />
      </button>
      <TimelineRowTimestamp
        createdAt={row.createdAt}
        timestampFormat={ctx.timestampFormat}
        className="ms-auto"
      />
    </div>
  );
}

function AttemptFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "attempt-fold" }> }) {
  const ctx = use(TimelineRowCtx);

  return (
    <button
      type="button"
      aria-expanded={row.expanded}
      data-scroll-anchor-ignore
      data-superseded-attempt-id={row.attemptId}
      onClick={() => ctx.onToggleAttemptFold(row.attemptId)}
      className="flex w-full cursor-pointer select-none items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
    >
      <MorphIcon
        className="size-3.5 shrink-0 text-muted-foreground"
        icon={row.expanded ? ChevronDown : ChevronRight}
      />
      <span className="text-xs font-medium text-foreground/80">{row.label}</span>
      <span className="text-2xs text-muted-foreground">Cut off by a steer</span>
    </button>
  );
}

const EMPTY_AGENT_PANEL_MODEL = emptyAgentPanelModel();

const NOOP_OPEN_AGENTS = () => {};

function ForkMarkerTimelineRow({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "fork-marker" }>;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <ForkMarkerSeparator
      environmentId={ctx.activeThreadEnvironmentId}
      originThreadId={row.originThreadId ?? ctx.forkOriginThreadId}
    />
  );
}
