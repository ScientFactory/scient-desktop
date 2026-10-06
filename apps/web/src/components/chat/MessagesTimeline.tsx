import { activityIssuePolicy } from "@t3tools/client-runtime/work-log/issue-presentation";
import { useBoundedAnswerFollow } from "./useBoundedAnswerFollow";
import { useEntranceMotion } from "./timelineEntranceMotion";
import { useStreamingTextAppearing } from "./useStreamingBlockEntrance";
import { liveFollowOffset } from "./liveFollowOffset";
import {
  findWorkingRow,
  nextWorkingRowExit,
  WORKING_ROW_EXIT_MS,
  withExitingWorkingRow,
  type WorkingRowExitState,
} from "./workingRowExit";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { deriveTerminalAssistantMessageIds } from "@scientfactory/conversation/work-log-grouping";
import { countUnreadBelow, unreadMessagesForThread } from "./unreadTimelineMessages";
import {
  readerAtReadingEnd,
  readingEndAllowance,
  readingEndGapOnScreen,
  readingIdentity,
  resolveReadingRow,
} from "./readerScrollPolicy";
import { ReadOnlySourcePreview } from "../files/AttachmentFilePreview";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  getQuestionAnswerPreview,
  getQuestionAnswerText,
  getQuestionTextPreview,
  hasQuestionAnswer,
} from "@t3tools/client-runtime/work-log/user-input";
import {
  deriveTimelineMinimapItems,
  resolveTimelineMinimapPreview,
  type TimelineMinimapItem,
} from "./timelineMinimapItems";
import {
  COMPOSER_CONTEXT_KINDS,
  type AssistantCitation,
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ToolActivityIcon,
  type TurnId,
  type ThreadId,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import type { CodexArtifactTemplate } from "@t3tools/client-runtime/codex-artifact-templates";
import {
  resolveWorkEntryToolPresentation,
  resolveViewedImageAsset,
  workEntryViewedImagePath,
  summarizeToolGroup,
  omitSupersededLifecycleMarkers,
} from "@t3tools/client-runtime/work-log/presentation";
import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";
import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  emptyAgentPanelModel,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";

const EMPTY_AGENT_PANEL_MODEL = emptyAgentPanelModel();
const NOOP_OPEN_AGENTS = () => {};
const NOOP_USE_ARTIFACT_TEMPLATE = () => {};
const NOOP_OPEN_ATTACHMENT = (_attachment: ChatFileAttachment) => {};
import { resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import { toolActivityFaviconUrl } from "@t3tools/shared/favicon";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { getProjectFaviconCacheKey } from "@t3tools/shared/projectFavicon";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { FileDiff } from "@pierre/diffs/react";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import {
  createMessageAttachmentPreviewProjector,
  deriveTimelineEntries,
  selectMessageImageResources,
  workEntryDisplayIndicatesToolFailure,
  workEntrySignalsSevereFailure,
  workLogEntryIsToolLike,
} from "../../session-logic";
import {
  type ChatMessage,
  type ChatFileAttachment,
  type ChatImageAttachment,
  isFileAttachment,
  isImageAttachment,
  isVideoAttachment,
  type TurnDiffSummary,
} from "../../types";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import ChatMarkdown, { ChatMarkdownAssetImage } from "../ChatMarkdown";
import { ComputerUseAppIcon } from "../Icons";
import { ScientSymbol, ScientSymbolMono } from "../ScientSymbol";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";
import {
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  DownloadIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  MessageCircleIcon,
  Minimize2Icon,
  MousePointerClickIcon,
  PaintbrushIcon,
  SearchIcon,
  SmartphoneIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import type {
  ComposerContextId,
  ComposerContextRecord,
  KnownComposerContextRecord,
} from "@t3tools/contracts";
import { Button } from "../ui/button";
import { useAssetUrlRefresh, useAssetUrls, useAssetUrlState } from "../../assets/assetUrls";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import {
  buildAttachmentVideoAsset,
  buildAttachmentVideoPreview,
  buildExpandedImagePreview,
  ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesCard } from "./ChangedFilesTree";
import { useAtomValue } from "@effect/atom-react";
import { useFileContextMenuHandler } from "../../fileContextMenu";
import { useProject, useThread } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  flushTimelinePositions,
  readTimelinePosition,
  rememberTimelinePosition,
  timelineContentOverflowsViewport,
} from "./timelineScrollAnchoring";
import { MessageCopyButton } from "./MessageCopyButton";
// SCIENT-FORK:START
import { messageCopyHtml } from "~/scient/clipboard/messageCopyHtml";
// SCIENT-FORK:END
import { PierreEntryIcon } from "./PierreEntryIcon";
import { inferEntryKindFromPath } from "../../pierre-icons";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import {
  AssistantCitationSource,
  type AssistantCitationRequest,
  type AssistantCitationTarget,
} from "./AssistantCitationSource";
import { useAssistantCitationTarget, type CitationHistoryPage } from "./useAssistantCitationTarget";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
  deriveUnsettledTurnId,
  type MessagesTimelineRowsProjection,
  liveWorkEntryLabel,
  workEntryIsActiveTurnActivity,
  resolveAssistantMessageCopyState,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapCurrentIndex,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapHitStripWidth,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapInteractiveWidth,
  resolveTimelineMinimapNavigationInteractive,
  resolveTimelineMinimapTopPercent,
  resolveWorkGroupScrollIndex,
  shouldFollowWorkGroupAppend,
  shouldPreserveAssistantLineBreaks,
  toolGroupAction,
  workEntryDisplayLabel,
  workEntryIsVisibleInGroup,
  worktreeSetupAgentStarted,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  TIMELINE_MINIMAP_MIN_ITEMS,
  type TimelineLatestTurn,
  type WorkGroupScrollAnchor,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ScientForkMessageButton } from "./scient-fork/ScientForkMessageButton";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import {
  ContextChipPopover as UserMessageContextPopover,
  ContextChipShell,
  FileChip,
  ImageChipButton,
  PULL_REQUEST_CHIP_KINDS,
  PullRequestChip,
  UnresolvedChip,
} from "../contextChipParts";
import {
  asKnownContextRecord,
  isPullRequestSummaryContext,
  pullRequestContextDisplayState,
  pullRequestContextKindLabel,
  resolveUserMessageContext,
  reviewCommentContextLabel,
  selectedMessageContextFragment,
} from "~/lib/composerContextRecords";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { chatMarkdownClipboardPayload } from "../../markdown-clipboard";
import { ContextChip, ContextChipLabel, type ContextChipKind } from "../ContextChip";
import { createContextPresentationRegistry } from "../contextPresentationRegistry";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useClientSettings } from "~/hooks/useSettings";
import type { ChatMarkdownContextReference } from "../ChatMarkdown";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { ScientChatImageGallery } from "~/scient/images/ScientChatImageGallery";
// SCIENT-FORK:START — website tool icons never fetch a web favicon
import { remoteImageAddress } from "~/scient/presentation/remoteImageAddress";
// SCIENT-FORK:END
import { SkillChipIcon, SkillInlineText } from "./SkillInlineText";
import { agentSpawnRowLabel, deriveAgentSpawnSummary } from "./agentSpawnSummary";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  buildReviewCommentRenderablePatch,
  formatReviewCommentFence,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via Context.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  citationRequest: AssistantCitationTarget | null;
  listRef: React.RefObject<LegendListRef | null>;
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  threadRef: ScopedThreadRef | null;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  activeThreadEnvironmentId: EnvironmentId;
  onRevertToTurnCount: (targetTurnCount: number, messageId: MessageId) => void;
  // SCIENT-FORK:START — optional so non-fork callers/tests are unaffected.
  onForkAssistantMessage?: ((messageId: MessageId) => void) | undefined;
  forkOriginThreadId?: ThreadId | undefined;
  onForkUserMessage?: ((message: ChatMessage) => void) | undefined;
  // SCIENT-FORK:END
  onUseArtifactTemplate: (template: CodexArtifactTemplate) => void;
  onRunShellCommand: ((command: string) => void) | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onFileOpen: (attachment: ChatFileAttachment) => void;
  onFileDownload: (attachment: ChatFileAttachment) => void;
  openPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onToggleTurnFold: (turnId: TurnId) => void;
  onToggleWorkGroup: (groupId: string, anchorKey: string) => void;
  onToggleWorkEntry: (anchorKey: string, collapsed: boolean) => void;
  onToggleSpawnRow: (entryId: string, expanded: boolean) => void;
  onToggleReasoning: (messageId: string, expanded: boolean, anchorKey: string) => void;
  expandedReasoningMessageIds: ReadonlySet<string>;
  workGroupViewState: WorkGroupViewState;
  agentPanelModel: AgentPanelModel;
  expandedSpawnEntryIds: ReadonlySet<string>;
  onOpenAgents: () => void;
  onCancelWorktreeSetup: (() => void) | null;
  onWorktreeSetupWorkLocally: (() => void) | null;
  onOpenWorktreeSetupTerminal: ((terminalId: string) => void) | null;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  /** A thread's first prompt while it is being placed: it plays its entrance. */
  enteringPromptId: string | null;
  /** The answer right above the live "Thinking" row, if any: it hides while that text appears. */
  thinkingFollowsAnswerId: string | null;
  isPreparingWorktree: boolean;
  isCompacting: boolean;
  isRevertingCheckpoint: boolean;
  latestTurnId: TurnId | null;
  unsettledTurnId: TurnId | null;
  /**
   * A worktree setup whose script is still running after the agent took
   * over. The working header shows it as a chip with a popover; the stage
   * list itself has already left the timeline.
   */
  backgroundWorktreeSetup: WorktreeSetupSnapshot | null;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);

interface WorkGroupViewState {
  scrollPositions: Map<string, WorkGroupScrollAnchor>;
  expandedEntries: Set<string>;
}

const WorkGroupViewCtx = createContext<{
  state: WorkGroupViewState;
  onToggleEntry: (collapsed: boolean) => void;
} | null>(null);
const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FADE_HEADER = (
  <div className="h-[var(--workspace-titlebar-scroll-fade-height)]" />
);

// Header row shown when older turns exist beyond the loaded window. Plain
// button, no spinner animation; the label change is the loading indicator.
function TimelineLoadEarlierHeader({
  loading,
  onLoadEarlier,
  fade,
}: {
  loading: boolean;
  onLoadEarlier: () => void;
  fade: boolean;
}) {
  return (
    <div className={fade ? "pt-(--workspace-titlebar-scroll-fade-height)" : "pt-3 sm:pt-4"}>
      <div className="mx-auto w-full max-w-(--chat-max-width) pb-2">
        <button
          type="button"
          onClick={onLoadEarlier}
          disabled={loading}
          className="w-full py-1.5 text-xs text-muted-foreground/60 hover:text-foreground disabled:cursor-default"
        >
          {loading ? "Loading earlier turns…" : "Load earlier turns"}
        </button>
      </div>
    </div>
  );
}
// A thread's first prompt is revealed from the top down as the composer lands.
// Clip and opacity only: a transform would shift where the reveal measures it.
const PROMPT_ENTRANCE_KEYFRAMES: Keyframe[] = [
  { opacity: 0, clipPath: "inset(0 0 100% 0)" },
  { opacity: 1, clipPath: "inset(0 0 0 0)" },
];
const PROMPT_ENTRANCE_TIMING: KeyframeAnimationOptions = { duration: 300, delay: 100 };
// A finished turn's working header closes evenly, without a fast start.
const WORKING_ROW_EXIT_EASING = "cubic-bezier(0.45, 0, 0.55, 1)";
function TimelineListFooter({ composerInset }: { readonly composerInset: number }) {
  return (
    <div aria-hidden>
      <div style={{ height: composerInset }} />
      <div className="h-3 sm:h-4" />
    </div>
  );
}
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
/** Which rows are listed: a new or removed row changes it, a row changing size does not. */
function timelineRowsKey(data: readonly unknown[]) {
  const last = data.at(-1) as { id?: string } | undefined;
  return `${data.length}:${last?.id ?? ""}`;
}
/** Older-history pages a missing saved message may load before falling back. */
const MAX_READING_HISTORY_PAGES = 2;
// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  citationRequest?: AssistantCitationRequest | null;
  citationHistoryLoading?: boolean;
  onCiteAssistantText?: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
  agentPanelModel?: AgentPanelModel;
  onOpenAgents?: () => void;
  isWorking: boolean;
  isPreparingWorktree?: boolean;
  isCompacting?: boolean;
  activeTurnStartedAt: string | null;
  /** Live bootstrap progress for this thread, or null when none is tracked. */
  worktreeSetup?: WorktreeSetupSnapshot | null;
  onCancelWorktreeSetup?: () => void;
  onWorktreeSetupWorkLocally?: () => void;
  onOpenWorktreeSetupTerminal?: (terminalId: string) => void;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  latestTurn: TimelineLatestTurn | null;
  runningTurnId: TurnId | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  routeThreadKey: string;
  /**
   * Thread whose entries are currently painted. Differs from `routeThreadKey`
   * while a jump is still holding the previous list. Identity for row
   * projection and list extraData — do not remount on this value.
   */
  displayThreadKey?: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  supportsConversationRollback: boolean;
  onRevertToTurnCount: (targetTurnCount: number, messageId: MessageId) => void;
  hasForkBaseline?: boolean;
  forkBaselineAssistantMessageId?: MessageId | null;
  forkOriginThreadId?: ThreadId | undefined;
  // SCIENT-FORK:START
  onForkAssistantMessage?: (messageId: MessageId) => void;
  onForkUserMessage?: (message: ChatMessage) => void;
  // SCIENT-FORK:END
  onUseArtifactTemplate?: (template: CodexArtifactTemplate) => void;
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
  anchorMessageId: MessageId | null;
  onAnchorReady: (messageId: MessageId, anchorIndex: number) => void;
  contentInsetEndAdjustment: number;
  timelinePositioningPending?: boolean;
  readingFollowPromptId?: string | null;
  /** The followed prompt is a later one: follow its whole response to the end. */
  readingFollowsResponse?: boolean;
  onReleaseUnusedAnchor?: () => void;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onUnreadBelowChange?: (count: number) => void;
  /**
   * Whether the real rows extend past the viewport above the composer.
   * Reported after scrolls, row size changes, and viewport resizes.
   */
  onContentOverflowChange?: (overflows: boolean) => void;
  onToolOutputCollapsedAtEnd?: () => void;
  onManualNavigation: () => void;
  cancelPositionRestoreRef?: React.RefObject<(() => void) | null>;
  hideEmptyPlaceholder?: boolean;
  positionHistoryLoading?: boolean;
  topFadeEnabled?: boolean;
  /** Non-null when older turns exist beyond the loaded window. */
  loadEarlier?: CitationHistoryPage | null;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  citationRequest = null,
  citationHistoryLoading = false,
  onCiteAssistantText,
  isWorking,
  worktreeSetup = null,
  onCancelWorktreeSetup,
  onWorktreeSetupWorkLocally,
  onOpenWorktreeSetupTerminal,
  isPreparingWorktree = false,
  isCompacting = false,
  activeTurnStartedAt,
  agentPanelModel,
  onOpenAgents = NOOP_OPEN_AGENTS,
  listRef,
  timelineEntries,
  latestTurn,
  runningTurnId,
  turnDiffSummaries,
  routeThreadKey,
  displayThreadKey,
  onOpenTurnDiff,
  supportsConversationRollback,
  onRevertToTurnCount,
  hasForkBaseline,
  forkBaselineAssistantMessageId,
  forkOriginThreadId,
  // SCIENT-FORK:START
  onForkAssistantMessage,
  onForkUserMessage,
  // SCIENT-FORK:END
  onUseArtifactTemplate = NOOP_USE_ARTIFACT_TEMPLATE,
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
  anchorMessageId,
  onAnchorReady,
  contentInsetEndAdjustment,
  timelinePositioningPending = false,
  readingFollowPromptId = null,
  readingFollowsResponse = false,
  onReleaseUnusedAnchor,
  onIsAtEndChange,
  onUnreadBelowChange,
  onContentOverflowChange,
  onToolOutputCollapsedAtEnd,
  onManualNavigation,
  cancelPositionRestoreRef,
  hideEmptyPlaceholder = false,
  positionHistoryLoading = false,
  topFadeEnabled = false,
  loadEarlier = null,
}: MessagesTimelineProps) {
  const listIdentityKey = displayThreadKey ?? routeThreadKey;
  const [listLoadVersion, setListLoadVersion] = useState(0);
  const rememberedPosition = useMemo(
    () => readTimelinePosition(listIdentityKey),
    [listIdentityKey, listLoadVersion],
  );
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<TurnId>>(
    () => rememberedPosition?.disclosures?.turns ?? new Set(),
  );
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(
    () => rememberedPosition?.disclosures?.workGroups ?? new Set(),
  );
  const [expandedSpawnEntryIds, setExpandedSpawnEntryIds] = useState<ReadonlySet<string>>(
    () => rememberedPosition?.disclosures?.spawnEntries ?? new Set(),
  );
  const [expandedReasoningMessageIds, setExpandedReasoningMessageIds] = useState<
    ReadonlySet<string>
  >(() => rememberedPosition?.disclosures?.reasoningMessages ?? new Set());
  const [positionedThreadKey, setPositionedThreadKey] = useState<string | null>(null);
  // Whether the latest turn is unfinished (running, or it ended interrupted or
  // with an error): its latest content is then the reading end.
  const turnUnfinished =
    runningTurnId !== null || latestTurn?.state === "interrupted" || latestTurn?.state === "error";
  const turnUnfinishedRef = useRef(turnUnfinished);
  useLayoutEffect(() => {
    turnUnfinishedRef.current = turnUnfinished;
  });
  const [readingListLoaded, setReadingListLoaded] = useState(false);
  const requestedReadingPages = useRef({ key: listIdentityKey, cursors: new Set<string>() });
  if (requestedReadingPages.current.key !== listIdentityKey) {
    requestedReadingPages.current = { key: listIdentityKey, cursors: new Set() };
  }
  // A saved message that no longer exists (a revert, a deleted turn) must not
  // page in the whole history: after a few pages, a neighbor or the end is used.
  const [readingHistoryPages, setReadingHistoryPages] = useState({
    key: listIdentityKey,
    count: 0,
  });
  const readingHistoryPageCount =
    readingHistoryPages.key === listIdentityKey ? readingHistoryPages.count : 0;
  const restoringThreadPosition = positionedThreadKey !== listIdentityKey;
  const listIdentityRef = useRef(listIdentityKey);
  const previousLatestTurnRef = useRef(latestTurn);
  let paintedExpandedTurnIds = expandedTurnIds;
  let paintedExpandedWorkGroupIds = expandedWorkGroupIds;
  let paintedExpandedSpawnEntryIds = expandedSpawnEntryIds;
  let paintedExpandedReasoningMessageIds = expandedReasoningMessageIds;
  if (listIdentityRef.current !== listIdentityKey) {
    listIdentityRef.current = listIdentityKey;
    setPositionedThreadKey(null);
    previousLatestTurnRef.current = latestTurn;
    paintedExpandedTurnIds = rememberedPosition?.disclosures?.turns ?? new Set();
    paintedExpandedWorkGroupIds = rememberedPosition?.disclosures?.workGroups ?? new Set();
    paintedExpandedSpawnEntryIds = rememberedPosition?.disclosures?.spawnEntries ?? new Set();
    paintedExpandedReasoningMessageIds =
      rememberedPosition?.disclosures?.reasoningMessages ?? new Set();
    setExpandedTurnIds(paintedExpandedTurnIds);
    setExpandedWorkGroupIds(paintedExpandedWorkGroupIds);
    setExpandedSpawnEntryIds(paintedExpandedSpawnEntryIds);
    setExpandedReasoningMessageIds(paintedExpandedReasoningMessageIds);
  }
  const onToggleSpawnRow = useCallback((entryId: string, expanded: boolean) => {
    setExpandedSpawnEntryIds((current) => {
      if (current.has(entryId) === expanded) return current;
      const next = new Set(current);
      if (expanded) next.add(entryId);
      else next.delete(entryId);
      return next;
    });
  }, []);
  const citationThreadRef = useMemo(() => parseScopedThreadKey(routeThreadKey), [routeThreadKey]);
  const openPullRequest = useOpenPrLink(citationThreadRef ?? undefined);
  const expandCitedTurn = useCallback((turnId: TurnId) => {
    setExpandedTurnIds((current) =>
      current.has(turnId) ? current : new Set([...current, turnId]),
    );
  }, []);
  // Nested tool state shares the bounded thread-position cache.
  const workGroupViewState = useMemo<WorkGroupViewState>(
    () =>
      rememberedPosition?.disclosures?.workGroupState ?? {
        scrollPositions: new Map(),
        expandedEntries: new Set(),
      },
    [listIdentityKey, rememberedPosition],
  );
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());
  // Expanding or collapsing a block at the end must not pin the end: the
  // toggled row keeps its place instead (maintainVisibleContentPosition).
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  // Any click or key in the timeline can expand or collapse content (a long
  // message, a plan, tool output). Idle end pinning pauses briefly after one,
  // so the toggled content keeps its place instead of being pinned to its end.
  const [interactionSettling, setInteractionSettling] = useState(false);
  // The reader's own scrolling input, held until their movement has stopped:
  // a drag, an animated wheel notch or key scroll moves for several frames.
  const readerInputRef = useRef(false);
  const scrollbarHeldRef = useRef(false);
  const lastBookkeepingScrollRef = useRef<number | null>(null);
  const stillFramesRef = useRef(0);
  // Schedules a bookkeeping pass; set once the per-frame scheduler exists.
  const scheduleBookkeepingRef = useRef<() => void>(() => {});
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const disclosureSettleFrameRef = useRef<number | null>(null);
  const disclosureSettleSecondFrameRef = useRef<number | null>(null);
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

  const suspendEndScrollMaintenanceForDisclosure = useCallback(
    (anchorKey: string, collapsed = false) => {
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
    },
    [contentInsetEndAdjustment, listRef, onToolOutputCollapsedAtEnd],
  );

  const shouldRestoreVisibleContentPosition = useCallback((row: MessagesTimelineRow) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || row.id === disclosureAnchorKey;
  }, []);

  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      size: true,
      shouldRestorePosition: shouldRestoreVisibleContentPosition,
    }),
    [shouldRestoreVisibleContentPosition],
  );

  const onToggleTurnFold = useCallback(
    (turnId: TurnId) => {
      suspendEndScrollMaintenanceForDisclosure(`turn-fold:${turnId}`);
      setExpandedTurnIds((existing) => {
        const next = new Set(existing);
        if (next.has(turnId)) {
          next.delete(turnId);
        } else {
          next.add(turnId);
        }
        return next;
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );
  const onToggleWorkGroup = useCallback(
    (groupId: string, anchorKey: string) => {
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
    },
    [expandedWorkGroupIds, suspendEndScrollMaintenanceForDisclosure],
  );
  const onToggleReasoning = useCallback(
    (messageId: string, expanded: boolean, anchorKey: string) => {
      suspendEndScrollMaintenanceForDisclosure(anchorKey, !expanded);
      setExpandedReasoningMessageIds((current) => {
        if (current.has(messageId) === expanded) return current;
        const next = new Set(current);
        if (expanded) next.add(messageId);
        else next.delete(messageId);
        return next;
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  // An in-session interrupt leaves its turn expanded so the user keeps their
  // place; the next turn (or a reload, since this is local state) folds it.
  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = latestTurn;
    if (!latestTurn || previous?.turnId === undefined) {
      return;
    }
    if (latestTurn.turnId === previous.turnId) {
      if (previous.state === "running" && latestTurn.state === "interrupted") {
        setExpandedTurnIds((existing) => {
          const next = new Set(existing);
          next.add(latestTurn.turnId);
          return next;
        });
      }
      return;
    }
    setExpandedTurnIds((existing) => {
      if (!existing.has(previous.turnId)) {
        return existing;
      }
      const next = new Set(existing);
      next.delete(previous.turnId);
      return next;
    });
  }, [latestTurn]);

  const rowsProjectionRef = useRef<{
    threadKey: string;
    workspaceRoot: string | undefined;
    projection: MessagesTimelineRowsProjection;
  } | null>(null);
  // Match the row header's liveness, retaining projection input identity
  // across unrelated panel updates.
  const liveAgentTaskKey = useMemo(() => {
    if (agentPanelModel === undefined) return undefined;
    const ids: string[] = [];
    const consider = (agent: { id: string; status: RuntimeSubagent["status"] }) => {
      if (isActiveSubagentStatus(agent.status)) ids.push(agent.id);
    };
    agentPanelModel.directAgents.forEach(consider);
    for (const group of agentPanelModel.workflows) {
      if (!isTerminalSubagentStatus(group.workflow.status)) ids.push(group.workflow.id);
      group.unphasedMembers.forEach(consider);
      group.phases.forEach((phase) => phase.members.forEach(consider));
    }
    return ids.sort().join("\n");
  }, [agentPanelModel]);
  const liveAgentTaskIds = useMemo(
    () =>
      liveAgentTaskKey === undefined
        ? undefined
        : new Set(liveAgentTaskKey.length > 0 ? liveAgentTaskKey.split("\n") : []),
    [liveAgentTaskKey],
  );
  const rawRows = useMemo(() => {
    const previous = rowsProjectionRef.current;
    const projection = deriveMessagesTimelineRowsWithState(
      {
        timelineEntries,
        latestTurn,
        runningTurnId,
        expandedTurnIds: paintedExpandedTurnIds,
        expandedWorkGroupIds: paintedExpandedWorkGroupIds,
        isWorking,
        activeTurnStartedAt,
        turnDiffSummaries,
        supportsConversationRollback,
        hasForkBaseline,
        forkBaselineAssistantMessageId,
        liveAgentTaskIds,
        worktreeSetup,
      },
      previous?.threadKey === listIdentityKey && previous.workspaceRoot === workspaceRoot
        ? previous.projection
        : null,
    );
    rowsProjectionRef.current = { threadKey: listIdentityKey, workspaceRoot, projection };
    return projection.rows;
  }, [
    rowsProjectionRef,
    hasForkBaseline,
    forkBaselineAssistantMessageId,
    listIdentityKey,
    workspaceRoot,
    timelineEntries,
    latestTurn,
    runningTurnId,
    paintedExpandedTurnIds,
    paintedExpandedWorkGroupIds,
    isWorking,
    activeTurnStartedAt,
    turnDiffSummaries,
    supportsConversationRollback,
    liveAgentTaskIds,
    worktreeSetup,
  ]);
  const stableRows = useStableRows(rawRows, listIdentityKey);
  // A finished turn's working header closes its space instead of leaving in one
  // frame, which would snap the answer below it up.
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const currentWorkingRow = useMemo(() => findWorkingRow(stableRows), [stableRows]);
  const [workingRowExit, setWorkingRowExit] = useState<WorkingRowExitState>(() => ({
    threadKey: listIdentityKey,
    last: currentWorkingRow,
    exiting: null,
  }));
  const nextExit = nextWorkingRowExit(workingRowExit, {
    threadKey: listIdentityKey,
    current: currentWorkingRow,
    animate: !prefersReducedMotion,
  });
  if (nextExit !== workingRowExit) setWorkingRowExit(nextExit);
  const exitingWorkingRow = nextExit.exiting;
  useEffect(() => {
    if (!exitingWorkingRow) return;
    const timeout = window.setTimeout(
      () => setWorkingRowExit((state) => (state.exiting ? { ...state, exiting: null } : state)),
      WORKING_ROW_EXIT_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [exitingWorkingRow]);
  const rows = useMemo(
    () => withExitingWorkingRow(stableRows, exitingWorkingRow),
    [stableRows, exitingWorkingRow],
  );
  // A finished reveal (revealed or cancelled) no longer holds off idle end pinning.
  const [finishedRevealPromptId, setFinishedRevealPromptId] = useState<string | null>(null);
  const onRevealFinished = useCallback((promptId: string) => {
    setFinishedRevealPromptId(promptId);
  }, []);
  // A reader who left while following a working thread is brought back to
  // where the follow would be now, and the follow carries on from there.
  const [resumedFollow, setResumedFollow] = useState<{
    threadKey: string;
    promptId: string;
  } | null>(null);
  const resumedFollowPromptId =
    resumedFollow?.threadKey === listIdentityKey ? resumedFollow.promptId : null;
  const isWorkingRef = useRef(isWorking);
  useLayoutEffect(() => {
    isWorkingRef.current = isWorking;
  });
  const followPromptId = readingFollowPromptId ?? resumedFollowPromptId;
  const followsResponse =
    readingFollowPromptId !== null ? readingFollowsResponse : resumedFollowPromptId !== null;
  const revealActive = followPromptId !== null && finishedRevealPromptId !== followPromptId;
  useBoundedAnswerFollow({
    listRef,
    rows,
    promptMessageId: followPromptId,
    responseRunning: isWorking,
    suspended: timelinePositioningPending || restoringThreadPosition || positionHistoryLoading,
    composerInset: contentInsetEndAdjustment,
    followResponse: followsResponse,
    onFinished: onRevealFinished,
  });
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows]);
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
  ]);
  const restoringAlwaysRender = useMemo(
    () =>
      restoringThreadPosition && restoreRowIndex >= 0 ? { indices: [restoreRowIndex] } : undefined,
    [restoreRowIndex, restoringThreadPosition],
  );
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
    // Left while following a working thread: come back to where the follow
    // would be now (it kept going in the reader's absence), not the old spot.
    if (position?.following) {
      void Promise.resolve(list.scrollToEnd({ animated: false })).then(() => {
        if (cancelled) return;
        let stableFrames = 0;
        let remainingFrames = 60;
        const settleLive = () => {
          if (cancelled) return;
          const offset = liveFollowOffset(list, rows, contentInsetEndAdjustment);
          const element = list.getScrollableNode();
          if (offset === null || !element || --remainingFrames <= 0) {
            setPositionedThreadKey(listIdentityKey);
            return;
          }
          if (Math.abs(element.scrollTop - offset) > 1) {
            stableFrames = 0;
            void list.scrollToOffset({ offset, animated: false }).then(() => {
              if (!cancelled) settleFrame = requestAnimationFrame(settleLive);
            });
            return;
          }
          if (++stableFrames < 2) {
            settleFrame = requestAnimationFrame(settleLive);
            return;
          }
          setPositionedThreadKey(listIdentityKey);
          // Still working: the follow carries on from here.
          const prompt = rows.findLast(
            (row) => row.kind === "message" && row.message.role === "user",
          );
          if (isWorkingRef.current && prompt?.kind === "message")
            setResumedFollow({ threadKey: listIdentityKey, promptId: prompt.message.id });
        };
        settleFrame = requestAnimationFrame(settleLive);
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
  ]);

  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  useEffect(() => {
    if (!timelineViewportElement) return;
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
    const ownerDocument = timelineViewportElement.ownerDocument;
    timelineViewportElement.addEventListener("click", settle, { capture: true });
    timelineViewportElement.addEventListener("keydown", settle, { capture: true });
    timelineViewportElement.addEventListener("wheel", input, { capture: true, passive: true });
    timelineViewportElement.addEventListener("touchmove", input, { capture: true, passive: true });
    timelineViewportElement.addEventListener("pointerdown", pressed, { capture: true });
    ownerDocument.addEventListener("keydown", keyed, { capture: true });
    ownerDocument.addEventListener("pointerup", released);
    ownerDocument.addEventListener("pointercancel", released);
    ownerDocument.addEventListener("mouseup", released);
    return () => {
      if (timer !== null) clearTimeout(timer);
      timelineViewportElement.removeEventListener("click", settle, { capture: true });
      timelineViewportElement.removeEventListener("keydown", settle, { capture: true });
      timelineViewportElement.removeEventListener("wheel", input, { capture: true });
      timelineViewportElement.removeEventListener("touchmove", input, { capture: true });
      timelineViewportElement.removeEventListener("pointerdown", pressed, { capture: true });
      ownerDocument.removeEventListener("keydown", keyed, { capture: true });
      ownerDocument.removeEventListener("pointerup", released);
      ownerDocument.removeEventListener("pointercancel", released);
      ownerDocument.removeEventListener("mouseup", released);
    };
  }, [listRef, timelineViewportElement]);
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
    onExpandTurn: expandCitedTurn,
    onManualNavigation,
  });
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false);
  const followPromptIndex = followPromptId
    ? rows.findIndex((row) => row.kind === "message" && row.message.id === followPromptId)
    : -1;
  const followAlwaysRender = useMemo(
    () => (followPromptIndex >= 0 ? { indices: [followPromptIndex] } : undefined),
    [followPromptIndex],
  );
  const alwaysRender = citationAlwaysRender ?? restoringAlwaysRender ?? followAlwaysRender;
  const [minimapHitStripWidth, setMinimapHitStripWidth] = useState(0);
  const [minimapCurrentIndex, setMinimapCurrentIndex] = useState<number | null>(null);
  const handleAnchorReady = useCallback(
    (info: { anchorIndex: number | undefined }) => {
      if (anchorMessageId !== null && info.anchorIndex !== undefined) {
        onAnchorReady(anchorMessageId, info.anchorIndex);
      }
    },
    [anchorMessageId, onAnchorReady],
  );
  const anchoredEndSpace = useMemo(() => {
    const config = resolveChatListAnchoredEndSpace(
      rows,
      anchorMessageId,
      (row) => (row.kind === "message" && row.message.role === "user" ? row.message.id : null),
      { anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET },
    );
    return config ? { ...config, onReady: handleAnchorReady } : undefined;
  }, [anchorMessageId, handleAnchorReady, rows]);
  const timelineListFooter = useMemo(
    () => <TimelineListFooter composerInset={anchoredEndSpace ? 0 : contentInsetEndAdjustment} />,
    [anchoredEndSpace, contentInsetEndAdjustment],
  );

  const measureContentOverflow = useCallback(
    () =>
      timelineContentOverflowsViewport(listRef.current?.getState?.(), {
        composerInset: contentInsetEndAdjustment,
        anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
      }),
    [contentInsetEndAdjustment, listRef],
  );
  // LegendList lays rows out from layout effects, so a read on the next frame
  // sees the settled positions. One frame is shared across bursts of size
  // changes.
  const contentOverflowFrameRef = useRef<number | null>(null);
  const cancelContentOverflowFrame = useCallback(() => {
    if (contentOverflowFrameRef.current !== null) {
      cancelAnimationFrame(contentOverflowFrameRef.current);
      contentOverflowFrameRef.current = null;
    }
  }, []);
  const reportContentOverflow = useCallback(() => {
    if (!onContentOverflowChange || contentOverflowFrameRef.current !== null) return;
    contentOverflowFrameRef.current = requestAnimationFrame(() => {
      contentOverflowFrameRef.current = null;
      onContentOverflowChange(measureContentOverflow());
    });
  }, [measureContentOverflow, onContentOverflowChange]);
  useEffect(() => cancelContentOverflowFrame, [cancelContentOverflowFrame]);
  // The list's own layout effects have already run here, so estimated row
  // positions are in place. Reporting before the first paint lets a thread
  // open in its final composer layout instead of correcting it a frame later.
  // A frame scheduled with the previous inset would overwrite this read, so
  // it is dropped first.
  useLayoutEffect(() => {
    cancelContentOverflowFrame();
    onContentOverflowChange?.(measureContentOverflow());
  }, [cancelContentOverflowFrame, measureContentOverflow, onContentOverflowChange, rows.length]);

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
    const identity = readingIdentity(rows, index, runningTurnId);
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
        turns: paintedExpandedTurnIds,
        workGroups: paintedExpandedWorkGroupIds,
        spawnEntries: paintedExpandedSpawnEntryIds,
        reasoningMessages: paintedExpandedReasoningMessageIds,
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
    runningTurnId,
    turnUnfinished,
    isWorking,
    revealActive,
    rows,
    listIdentityKey,
    anchorMessageId,
    contentInsetEndAdjustment,
    paintedExpandedTurnIds,
    paintedExpandedWorkGroupIds,
    paintedExpandedSpawnEntryIds,
    paintedExpandedReasoningMessageIds,
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
  // Each response's latest message: the unit the unread badge counts.
  const responseEndMessageIds = useMemo(
    () => deriveTerminalAssistantMessageIds(timelineEntries),
    [timelineEntries],
  );
  // Where the reader last rested at the reading end: the on-screen distance
  // to the end of the last message's text, and where that end sat in the
  // content. Null when not at the end.
  const restingAtReadingEndRef = useRef<{
    gap: number;
    contentEnd: number;
    /** The rows at rest (count and last row): only their size changes are kept in view. */
    rowsKey: string;
  } | null>(null);
  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
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
    reportContentOverflow();
    if (!state || minimapItems.length === 0) {
      return;
    }

    const scrollTop = state.scroll ?? 0;
    const scrollBottom = scrollTop + (state.scrollLength ?? 0);

    const itemBounds = minimapItems.map((item) => ({
      top: resolveTimelineRowTop(state, item.rowIndex),
      height: resolveTimelineRowHeight(state, item.rowIndex),
    }));

    for (const [index, item] of minimapItems.entries()) {
      const strip = minimapStripMap.get(item.id);
      const bounds = itemBounds[index];
      const rowTop = bounds?.top ?? null;
      const rowHeight = bounds?.height ?? null;
      const inView =
        rowTop !== null &&
        rowTop < scrollBottom &&
        rowTop + Math.max(1, rowHeight ?? 1) > scrollTop;

      if (strip) {
        strip.dataset.inView = inView ? "true" : "false";
      }
    }
    const nextCurrentIndex = resolveTimelineMinimapCurrentIndex({
      scrollTop,
      scrollBottom,
      itemBounds,
    });
    setMinimapCurrentIndex((current) =>
      current === nextCurrentIndex ? current : nextCurrentIndex,
    );
  }, [
    citationPositioning,
    paintedExpandedTurnIds,
    paintedExpandedWorkGroupIds,
    paintedExpandedSpawnEntryIds,
    paintedExpandedReasoningMessageIds,
    workGroupViewState,
    rows,
    listIdentityKey,
    restoringThreadPosition,
    listRef,
    positionHistoryLoading,
    saveReadingPosition,
    timelineEntries,
    responseEndMessageIds,
    onUnreadBelowChange,
    anchorMessageId,
    timelinePositioningPending,
    onReleaseUnusedAnchor,
    contentInsetEndAdjustment,
    runningTurnId,
    turnUnfinished,
    minimapItems,
    minimapStripMap,
    onIsAtEndChange,
    reportContentOverflow,
  ]);

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
  }, [contentInsetEndAdjustment, listRef]);
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
  }, [handleScrollOnNextFrame]);
  useEffect(
    () => () => {
      if (bookkeepingFrameRef.current !== null) cancelAnimationFrame(bookkeepingFrameRef.current);
    },
    [],
  );
  useEffect(() => {
    handleScrollOnNextFrame();
  }, [handleScroll, handleScrollOnNextFrame, rows.length]);
  // A resized window or panel changes the viewport without a scroll or row event.
  useEffect(() => {
    const viewport = readingListLoaded ? listRef.current?.getScrollableNode() : null;
    if (!viewport) return;
    const observer = new ResizeObserver(() => handleScrollOnNextFrame());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [handleScrollOnNextFrame, listRef, readingListLoaded]);

  useEffect(() => {
    if (!timelineViewportElement) {
      return;
    }

    const measure = () => {
      const viewportWidth = timelineViewportElement.getBoundingClientRect().width;
      // Without a mounted row, treat the column as full width so the strip stays inert.
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

    const observer = new ResizeObserver(measure);
    observer.observe(timelineViewportElement);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [timelineViewportElement, rows.length, reportContentOverflow, chatWidth]);

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      citationRequest: readyCitationRequest,
      listRef,
      timestampFormat,
      routeThreadKey,
      // Keep Markdown callbacks memoized during unrelated activity updates.
      threadRef: citationThreadRef,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      onRevertToTurnCount,
      // SCIENT-FORK:START — expose the fork trigger to rows via context.
      onForkAssistantMessage,
      onForkUserMessage,
      forkOriginThreadId,
      // SCIENT-FORK:END
      onUseArtifactTemplate,
      onRunShellCommand,
      onImageExpand,
      onFileOpen,
      onFileDownload,
      openPullRequest,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      onToggleWorkEntry: suspendEndScrollMaintenanceForDisclosure,
      onToggleSpawnRow,
      onToggleReasoning,
      expandedReasoningMessageIds: paintedExpandedReasoningMessageIds,
      workGroupViewState,
      agentPanelModel: agentPanelModel ?? EMPTY_AGENT_PANEL_MODEL,
      expandedSpawnEntryIds: paintedExpandedSpawnEntryIds,
      onOpenAgents,
      onCancelWorktreeSetup: onCancelWorktreeSetup ?? null,
      onWorktreeSetupWorkLocally: onWorktreeSetupWorkLocally ?? null,
      onOpenWorktreeSetupTerminal: onOpenWorktreeSetupTerminal ?? null,
    }),
    [
      readyCitationRequest,
      listRef,
      timestampFormat,
      routeThreadKey,
      citationThreadRef,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      onRevertToTurnCount,
      // SCIENT-FORK:START
      onForkAssistantMessage,
      onForkUserMessage,
      forkOriginThreadId,
      // SCIENT-FORK:END
      onUseArtifactTemplate,
      onRunShellCommand,
      onImageExpand,
      onFileOpen,
      onFileDownload,
      openPullRequest,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      suspendEndScrollMaintenanceForDisclosure,
      onToggleSpawnRow,
      onToggleReasoning,
      paintedExpandedReasoningMessageIds,
      workGroupViewState,
      agentPanelModel,
      paintedExpandedSpawnEntryIds,
      onOpenAgents,
      onCancelWorktreeSetup,
      onWorktreeSetupWorkLocally,
      onOpenWorktreeSetupTerminal,
    ],
  );
  const backgroundWorktreeSetup =
    worktreeSetup !== null &&
    worktreeSetup.phase === "running" &&
    worktreeSetupAgentStarted(worktreeSetup) &&
    latestTurn?.startedAt != null
      ? worktreeSetup
      : null;
  // Only a first prompt is placed with pending positioning (later ones are revealed).
  const enteringPromptId = timelinePositioningPending ? anchorMessageId : null;
  const thinkingFollowsAnswerId = useMemo(() => {
    const index = rows.findIndex((row) => row.kind === "thinking");
    const previous = index > 0 ? rows[index - 1] : undefined;
    return previous?.kind === "message" && previous.message.role === "assistant"
      ? previous.message.id
      : null;
  }, [rows]);
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      enteringPromptId,
      thinkingFollowsAnswerId,
      isPreparingWorktree,
      isCompacting,
      isRevertingCheckpoint,
      latestTurnId: latestTurn?.turnId ?? null,
      // The same value the row-derivation uses, so a block and the placeholder
      // beside it can never disagree about whether a turn is still live.
      unsettledTurnId: deriveUnsettledTurnId(latestTurn ?? null, runningTurnId),
      backgroundWorktreeSetup,
    }),
    [
      backgroundWorktreeSetup,
      enteringPromptId,
      thinkingFollowsAnswerId,
      isCompacting,
      isRevertingCheckpoint,
      isWorking,
      isPreparingWorktree,
      // Deliberately the fields `deriveUnsettledTurnId` reads, not the object:
      // its identity changes on every thread-shell patch.
      latestTurn?.turnId,
      latestTurn?.state,
      latestTurn?.completedAt,
      runningTurnId,
    ],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div
        className="mx-auto w-full min-w-0 max-w-(--chat-max-width) overflow-x-clip"
        data-timeline-root="true"
      >
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking) {
    // The inner list will remount. Block captures until its new onLoad and
    // restoration complete, so layout at offset zero cannot overwrite the receipt.
    if (readingListLoaded) {
      setReadingListLoaded(false);
      setPositionedThreadKey(null);
    }
    if (hideEmptyPlaceholder) {
      // Occupy the pane with the theme surface so a thread switch cannot
      // punch a hole through to the window chrome (white in light mode).
      return <div className="h-full min-h-0 bg-background" data-timeline-loading="true" />;
    }
    return (
      <div className="scient-reading-ui flex h-full items-center justify-center">
        <p className="text-placeholder text-sm">Send a message to start the conversation.</p>
      </div>
    );
  }

  return (
    <TimelineRowCtx value={sharedState}>
      <TimelineRowActivityCtx value={activityState}>
        <div
          ref={setTimelineViewportElement}
          className="scient-reading-ui relative h-full min-h-0"
          data-assistant-citation-viewport="true"
          onScrollCapture={(event) => {
            // Legend coalesces public scroll callbacks into a later frame. Capture
            // the native event now, before a same-frame thread switch can replace rows.
            if (event.target === listRef.current?.getScrollableNode()) saveReadingPosition();
          }}
        >
          {onCiteAssistantText && citationThreadRef ? (
            <AssistantSelectionToolbar
              viewport={timelineViewportElement}
              threadRef={citationThreadRef}
              onCite={onCiteAssistantText}
            />
          ) : null}
          <LegendList<MessagesTimelineRow>
            ref={listRef}
            data={rows}
            extraData={`${listIdentityKey}:${rows.length}`}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            renderItem={renderItem}
            estimatedItemSize={90}
            initialScrollAtEnd={false}
            // Legend needs a data refresh to mount new pins without a scroll event.
            dataVersion={readyCitationRequest?.key ?? listIdentityKey}
            {...(alwaysRender ? { alwaysRender } : {})}
            onLoad={() => {
              onCitationListLoad();
              // The same thread can temporarily lose its loaded rows. A remounted
              // list must restore its latest receipt, not assume the old DOM survived.
              setListLoadVersion((version) => version + 1);
              setPositionedThreadKey(null);
              setReadingListLoaded(true);
            }}
            {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
            contentInsetEndAdjustment={anchoredEndSpace ? contentInsetEndAdjustment : 0}
            maintainScrollAtEnd={false}
            maintainVisibleContentPosition={
              citationPositioning || restoringThreadPosition
                ? false
                : maintainVisibleContentPosition
            }
            maintainScrollAtEndThreshold={1}
            onScroll={handleScrollOnNextFrame}
            onItemSizeChanged={handleScrollOnNextFrame}
            className={cn(
              "scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain px-3 [overflow-anchor:none] sm:px-5",
              topFadeEnabled && "topbar-scroll-fade",
            )}
            ListHeaderComponent={
              loadEarlier !== null ? (
                <TimelineLoadEarlierHeader
                  loading={loadEarlier.loading}
                  onLoadEarlier={loadEarlier.onLoadEarlier}
                  fade={topFadeEnabled}
                />
              ) : topFadeEnabled ? (
                TIMELINE_LIST_FADE_HEADER
              ) : (
                TIMELINE_LIST_HEADER
              )
            }
            ListFooterComponent={timelineListFooter}
          />
          <TimelineMinimap
            items={minimapItems}
            hasPersistentGutter={minimapHasPersistentGutter}
            hitStripWidth={minimapHitStripWidth}
            currentIndex={minimapCurrentIndex}
            stripMap={minimapStripMap}
            onSelect={(item) => {
              onManualNavigation();
              void listRef.current?.scrollToIndex({
                index: item.rowIndex,
                animated: true,
                viewOffset: 24,
              });
            }}
          />
        </div>
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  );
});

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

function getItemType(item: MessagesTimelineRow) {
  return item.kind === "message" ? `message:${item.message.role}` : item.kind;
}

interface TimelinePositionState {
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
  readonly positionAtIndex?: (index: number) => number | undefined;
  readonly sizeAtIndex?: (index: number) => number | undefined;
}

function resolveTimelineRowTop(state: TimelinePositionState, rowIndex: number) {
  const top = state.positionAtIndex?.(rowIndex);
  return typeof top === "number" && Number.isFinite(top) ? top : null;
}

function resolveTimelineRowHeight(state: TimelinePositionState, rowIndex: number) {
  const height = state.sizeAtIndex?.(rowIndex);
  return typeof height === "number" && Number.isFinite(height) ? height : null;
}

function timelineMinimapEventTargetsPreview(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-minimap-preview]") !== null;
}

function TimelineMinimap({
  hasPersistentGutter,
  hitStripWidth,
  currentIndex,
  items,
  stripMap,
  onSelect,
}: {
  hasPersistentGutter: boolean;
  hitStripWidth: number;
  currentIndex: number | null;
  items: ReadonlyArray<TimelineMinimapItem>;
  stripMap: Map<string, HTMLSpanElement>;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = useMemo(
    () =>
      resolveTimelineMinimapPreview(
        resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null),
      ),
    [items, resolvedActiveIndex],
  );
  const navigationInteractive = resolveTimelineMinimapNavigationInteractive(hitStripWidth);
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length);
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === items.length - 1
          ? "-100%"
          : "-50%";
  const resolvedCurrentIndex =
    currentIndex !== null && currentIndex >= 0 && currentIndex < items.length ? currentIndex : null;
  const previousItem =
    resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex - 1] ?? null);
  const nextItem = resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex + 1] ?? null);

  const resolveActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return resolveTimelineMinimapIndexFromPointer({
        itemCount: items.length,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      });
    },
    [items.length],
  );

  const updateActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const nextIndex = resolveActiveIndexFromPointer(event);
      setActiveIndex(nextIndex);
    },
    [resolveActiveIndexFromPointer],
  );

  const moveActiveIndex = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        const base = current ?? 0;
        return Math.max(0, Math.min(items.length - 1, base + delta));
      });
    },
    [items.length],
  );

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) {
    return null;
  }

  return (
    <div
      className={cn(
        "group/minimap pointer-events-none absolute inset-y-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
    >
      <div className="relative h-full w-full select-none">
        <div
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2",
            // The strip is width-capped to the side gutter so it never overlays
            // the centered content column; with no usable gutter it goes inert.
            hitStripWidth > 0 ? "pointer-events-auto" : "pointer-events-none",
          )}
          style={{
            height: resolveTimelineMinimapHeightStyle(items.length),
            width: resolveTimelineMinimapInteractiveWidth(hitStripWidth, activeItem !== null),
          }}
        >
          <TimelineMinimapNavigationButton
            direction="previous"
            disabled={previousItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (previousItem) onSelect(previousItem);
            }}
          />
          <button
            aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
            className="absolute inset-y-0 left-0 w-full cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
            onBlur={() => setActiveIndex(null)}
            onClick={(event) => {
              if (timelineMinimapEventTargetsPreview(event.target)) {
                return;
              }
              const nextIndex = resolveActiveIndexFromPointer(event);
              const selectedItem = nextIndex === null ? null : (items[nextIndex] ?? null);
              if (selectedItem) {
                onSelect(selectedItem);
              }
              event.currentTarget.blur();
            }}
            onFocus={() => setActiveIndex((current) => current ?? resolvedCurrentIndex ?? 0)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActiveIndex(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActiveIndex(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActiveIndex(items.length - 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (activeItem) {
                  onSelect(activeItem);
                }
              }
            }}
            onMouseLeave={() => setActiveIndex(null)}
            onMouseMove={updateActiveIndexFromPointer}
            onMouseDown={(event) => {
              if (timelineMinimapEventTargetsPreview(event.target)) {
                return;
              }
              event.preventDefault();
            }}
            type="button"
          >
            <div className="absolute top-0 left-3 h-full w-px bg-border/15" />
            {items.map((item, index) => {
              const top = `${resolveTimelineMinimapTopPercent(index, items.length)}%`;
              const activeDistance =
                resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
              return (
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute left-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150 data-[in-view=true]:bg-foreground/90",
                    activeDistance === 0
                      ? "w-6 bg-muted-foreground/75"
                      : activeDistance === 1
                        ? "w-4"
                        : activeDistance === 2
                          ? "w-2.5"
                          : "w-2",
                  )}
                  data-in-view="false"
                  data-minimap-strip
                  key={item.id}
                  ref={(node) => {
                    if (node) {
                      stripMap.set(item.id, node);
                    } else {
                      stripMap.delete(item.id);
                    }
                  }}
                  style={{ top }}
                />
              );
            })}
            {activeItem ? (
              <span
                className="pointer-events-auto absolute left-8 w-80 cursor-text select-text"
                data-minimap-preview
                onMouseMove={(event) => event.stopPropagation()}
                style={{
                  top: `${activeTopPercent}%`,
                  transform: `translateY(${activeTooltipTranslate})`,
                }}
              >
                <span className="dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl shadow-black/25">
                  <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                    {activeItem.userText ?? "User message"}
                  </span>
                  {activeItem.assistantText ? (
                    <span
                      className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                      style={{
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: 3,
                      }}
                    >
                      {activeItem.assistantText}
                    </span>
                  ) : null}
                </span>
              </span>
            ) : null}
          </button>
          <TimelineMinimapNavigationButton
            direction="next"
            disabled={nextItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (nextItem) onSelect(nextItem);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function TimelineMinimapNavigationButton({
  direction,
  disabled,
  interactive,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  interactive: boolean;
  onClick: () => void;
}) {
  const previous = direction === "previous";
  const label = previous ? "Previous turn" : "Next turn";
  const Icon = previous ? ChevronUpIcon : ChevronDownIcon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "absolute left-1 z-10 inline-flex -translate-x-1/2 opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
              interactive ? "pointer-events-auto" : "pointer-events-none",
              previous ? "bottom-[calc(100%+2px)]" : "top-[calc(100%+2px)]",
            )}
          />
        }
      >
        <Button
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          size="icon-micro"
          type="button"
          variant="ghost-muted"
        >
          <Icon className="size-4 text-foreground/90" />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side={previous ? "top" : "bottom"}>{label}</TooltipPopup>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  const isExpandedToolGroup = row.kind === "work" && row.isExpandedToolGroup;
  const isExpandedToolGroupHeader =
    (row.kind === "work-toggle" && row.expanded) || (row.kind === "work-live" && row.expanded);

  return (
    <div
      className={cn(
        // Commentary (non-terminal assistant) rows carry no metadata row, so
        // they sit closer to the work that follows them.
        isExpandedToolGroup
          ? "pb-1"
          : isExpandedToolGroupHeader
            ? "pb-0"
            : row.kind === "turn-fold" || row.kind === "working"
              ? "pb-1.5"
              : (row.kind === "message" &&
                    row.message.role === "assistant" &&
                    !row.showAssistantMeta) ||
                  (row.kind === "message" && row.message.role === "reasoning") ||
                  row.kind === "work" ||
                  row.kind === "work-live" ||
                  row.kind === "work-toggle" ||
                  row.kind === "turn-plan" ||
                  row.kind === "activity-group" ||
                  row.kind === "thinking" ||
                  row.kind === "worktree-setup"
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
      {row.kind === "work" ? (
        <WorkGroupSection
          anchorKey={row.id}
          groupedEntries={row.groupedEntries}
          isExpandedToolGroup={row.isExpandedToolGroup}
          displayLabel={row.displayLabel}
        />
      ) : null}
      {row.kind === "work-live" ? <LiveWorkEntryTimelineRow row={row} /> : null}
      {row.kind === "activity-group" ? <ActivityGroupTimelineRow row={row} /> : null}
      {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === "fork-marker" ? <ForkMarkerTimelineRow /> : null}
      {row.kind === "context-compaction" ? <ContextCompactionTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "message" && row.message.role === "reasoning" ? (
        <ReasoningTimelineRow row={row} />
      ) : null}
      {row.kind === "assistant-meta" ? <AssistantMetaTimelineRow row={row} /> : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "turn-plan" ? <TurnPlanTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
      {row.kind === "thinking" ? <ThinkingTimelineRow /> : null}
      {row.kind === "worktree-setup" ? <WorktreeSetupTimelineRow row={row} /> : null}
    </div>
  );
});

function ForkMarkerTimelineRow() {
  const ctx = use(TimelineRowCtx);
  return (
    <div className="flex items-center gap-3 px-1 py-3 text-xs text-muted-foreground">
      <div className="h-px flex-1 bg-border/60" />
      <span className="shrink-0 rounded-full border border-border/70 bg-muted/35 px-2.5 py-1">
        {ctx.forkOriginThreadId ? (
          <Link
            to="/$environmentId/$threadId"
            params={{
              environmentId: ctx.activeThreadEnvironmentId,
              threadId: ctx.forkOriginThreadId,
            }}
            className="hover:text-foreground hover:underline"
            aria-label="Open original conversation"
          >
            Conversation forked here
          </Link>
        ) : (
          "Conversation forked here"
        )}
      </span>
      <div className="h-px flex-1 bg-border/60" />
    </div>
  );
}

function WorktreeSetupTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "worktree-setup" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const terminalId = row.snapshot.setupScript?.terminalId ?? null;
  const openTerminal = ctx.onOpenWorktreeSetupTerminal;
  const onOpenTerminal = useMemo(
    () => (openTerminal && terminalId ? () => openTerminal(terminalId) : null),
    [openTerminal, terminalId],
  );
  return (
    <WorktreeSetupCard
      snapshot={row.snapshot}
      embedded={row.embedded}
      onCancel={row.embedded ? null : ctx.onCancelWorktreeSetup}
      onWorkLocally={
        !row.embedded && row.snapshot.phase === "running" ? ctx.onWorktreeSetupWorkLocally : null
      }
      onOpenTerminal={onOpenTerminal}
    />
  );
}

function ContextCompactionTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "context-compaction" }>;
}) {
  return (
    <div
      role="separator"
      aria-label={row.label}
      className="mx-auto flex w-full max-w-(--chat-max-width) items-center gap-3 py-1 text-muted-foreground text-xs"
    >
      <span className="h-px flex-1 bg-border/70" />
      <span className="flex shrink-0 items-center gap-1.5">
        <Minimize2Icon aria-hidden="true" className="size-3" />
        {row.label}
      </span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

function UserVideoAttachment({ file }: { readonly file: ChatFileAttachment }) {
  const ctx = use(TimelineRowCtx);
  const asset = useMemo(
    () =>
      file.downloadable === false
        ? null
        : buildAttachmentVideoAsset(ctx.activeThreadEnvironmentId, file),
    [ctx.activeThreadEnvironmentId, file.downloadable, file.id, file.mimeType, file.name],
  );
  const resource = asset?.resource ?? null;
  const assetUrl = useAssetUrlState(ctx.activeThreadEnvironmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(ctx.activeThreadEnvironmentId, resource);
  const src = assetUrl._tag === "Success" ? assetUrl.url : (file.previewUrl ?? null);

  if (asset === null && src === null) {
    return (
      <div className="flex aspect-[4/3] w-full items-center justify-center rounded-lg border border-border/80 bg-black px-2 py-3 text-center text-2xs text-white/70">
        {file.name}
      </div>
    );
  }

  return (
    <MediaVideoPlayer
      src={src}
      sourceFailed={
        file.previewUrl === undefined && resource !== null && assetUrl._tag === "Failure"
      }
      label={file.name}
      preload="visible"
      onOpen={() => {
        const preview = buildAttachmentVideoPreview(ctx.activeThreadEnvironmentId, file);
        if (preview) ctx.onImageExpand(preview);
      }}
      className="block aspect-[4/3] w-full"
      videoClassName="aspect-auto size-full rounded-lg border border-border/80"
      stateClassName="aspect-auto min-h-full rounded-lg border border-border/80 bg-black text-white"
      onRetry={asset ? refreshAssetUrl : undefined}
      actionsSource={asset ? { kind: "video", name: file.name, src, asset } : undefined}
    />
  );
}

// Screen readers skim a transcript by heading, so every message announces its
// author as one. The thread title in ChatHeader is an <h2>; headings written
// inside a message are exposed below this level. Visually hidden and excluded
// from selection so sighted users and copied text are unaffected.
const MESSAGE_HEADING_LEVEL = 3;

function MessageAuthorHeading({ children }: { children: string }) {
  return <h3 className="sr-only select-none">{children}</h3>;
}

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const { enteringPromptId } = use(TimelineRowActivityCtx);
  const entranceRef = useEntranceMotion(
    enteringPromptId === row.message.id ? `prompt:${row.message.id}` : null,
    PROMPT_ENTRANCE_KEYFRAMES,
    PROMPT_ENTRANCE_TIMING,
  );
  const { onImageExpand, onFileOpen } = ctx;
  const resources = useMemo(
    () => selectMessageImageResources(row.message.attachments),
    [row.message.attachments],
  );
  const previewUrls = useAssetUrls(ctx.activeThreadEnvironmentId, resources);
  const [projectPreviews] = useState(createMessageAttachmentPreviewProjector);
  const messageWithPreviews = useMemo(() => {
    const urlsById = new Map(
      resources.flatMap((resource, index) => {
        const url = previewUrls[index];
        return url ? [[resource.attachmentId, url] as const] : [];
      }),
    );
    return projectPreviews(row.message, (attachment) => urlsById.get(attachment.id));
  }, [previewUrls, projectPreviews, resources, row.message]);
  // The attachment union has an open member, so guards (not literal type
  // comparisons) split it. Unknown types render as inert rows below the files.
  const userImages = useMemo(
    () => (messageWithPreviews.attachments ?? []).filter(isImageAttachment),
    [messageWithPreviews.attachments],
  );
  const userFiles = useMemo(
    () => (row.message.attachments ?? []).filter(isFileAttachment),
    [row.message.attachments],
  );
  const userVideos = userFiles.filter(isVideoAttachment);
  const otherUserFiles = userFiles.filter((file) => !isVideoAttachment(file));
  const unknownAttachments = (row.message.attachments ?? []).filter(
    (attachment) => !isImageAttachment(attachment) && !isFileAttachment(attachment),
  );
  const resolvedContext = useMemo(() => resolveUserMessageContext(row.message), [row.message]);
  const previewImages = useMemo(
    () => userImages.filter((image) => image.name.startsWith("preview-annotation-")),
    [userImages],
  );
  const revertTurnCount = row.revertTurnCount;
  // A file with a chip in the prose needs no standalone row. Media is the exception: the
  // thumbnail is the only way to actually see it, so it shows whether or not it has a chip.
  const chippedAttachmentIds = new Set(
    collectComposerContextReferences(resolvedContext.text).flatMap((occurrence) => {
      const record = asKnownContextRecord(resolvedContext.recordsById.get(occurrence.contextId));
      return record?.kind === "file" || record?.kind === "image" ? [record.attachmentId] : [];
    }),
  );
  const regularImages = userImages.filter((image) => !image.name.startsWith("preview-annotation-"));
  const unchippedFiles = otherUserFiles.filter((file) => !chippedAttachmentIds.has(file.id));
  const annotationRecordIds = useMemo(
    () =>
      resolvedContext.records
        .filter((record) => record.kind === "preview-annotation")
        .map((record) => record.contextId),
    [resolvedContext.records],
  );
  const contextClipboardFragment =
    resolvedContext.records.length === 0
      ? null
      : encodeComposerContextFragment({
          version: 1,
          source: {
            environmentId: ctx.activeThreadEnvironmentId,
            ...(ctx.threadRef ? { threadId: ctx.threadRef.threadId } : {}),
            messageId: row.message.id,
          },
          records: resolvedContext.records,
        });
  // Chips inside the selection copy as their links (data-markdown-copy); the structured
  // fragment rides beside so a paste into a draft brings the payloads along. Only records
  // for chips that are actually inside the selection travel, so copying prose next to an
  // image never starts importing that image somewhere else.
  const onBodyCopyCapture = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (resolvedContext.records.length === 0 || !event.clipboardData) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const copiedMarkdown: string[] = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const container = document.createElement("div");
      container.appendChild(selection.getRangeAt(index).cloneContents());
      for (const element of container.querySelectorAll("[data-markdown-copy]")) {
        copiedMarkdown.push(element.getAttribute("data-markdown-copy") ?? "");
      }
    }
    const fragment = selectedMessageContextFragment({
      markdown: copiedMarkdown.join("\n"),
      records: resolvedContext.records,
      environmentId: ctx.activeThreadEnvironmentId,
      ...(ctx.threadRef ? { threadId: ctx.threadRef.threadId } : {}),
      messageId: row.message.id,
    });
    if (!fragment) return;
    // Claim the copy: without preventDefault the browser default overwrites the
    // custom MIME type. The default content must then be written back explicitly.
    const payload = chatMarkdownClipboardPayload(selection);
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload?.text ?? selection.toString());
    if (payload) {
      event.clipboardData.setData(
        "text/html",
        encodeComposerContextClipboardHtml(payload.text, fragment, payload.html),
      );
    }
    event.clipboardData.setData(COMPOSER_CONTEXT_CLIPBOARD_MIME, fragment);
  };
  const renderContextReference = useCallback(
    (reference: ChatMarkdownContextReference) => {
      const record = asKnownContextRecord(resolvedContext.recordsById.get(reference.contextId));
      // Structured annotations point at the image record, which in turn points at the persisted
      // attachment. Filename and order are compatibility fallbacks for legacy messages only.
      const annotationImage =
        record?.kind === "preview-annotation"
          ? resolvePreviewAnnotationImage({
              record,
              recordsById: resolvedContext.recordsById,
              userImages,
              previewImages,
              annotationRecordIds,
            })
          : null;
      const attachment =
        record?.kind === "image"
          ? (userImages.find((image) => image.id === record.attachmentId) ?? null)
          : record?.kind === "file"
            ? (userFiles.find((file) => file.id === record.attachmentId) ?? null)
            : null;
      return (
        <UserMessageContextReferenceChip
          reference={reference}
          record={record}
          annotationImage={annotationImage}
          attachment={attachment}
          onExpandImage={(image) => {
            const preview = buildExpandedImagePreview(userImages, image.id);
            if (preview) onImageExpand(preview);
          }}
          onOpenFile={onFileOpen}
          onExpandVideo={(file) => {
            const preview = buildAttachmentVideoPreview(ctx.activeThreadEnvironmentId, file);
            if (preview) onImageExpand(preview);
          }}
        />
      );
    },
    [
      resolvedContext.recordsById,
      userImages,
      userFiles,
      previewImages,
      annotationRecordIds,
      onImageExpand,
      onFileOpen,
      ctx.activeThreadEnvironmentId,
    ],
  );

  return (
    <div ref={entranceRef} className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
        <MessageAuthorHeading>You</MessageAuthorHeading>
        <ScientChatImageGallery
          className="mb-2 max-w-[420px]"
          images={regularImages}
          onExpand={(imageId) => {
            const preview = buildExpandedImagePreview(regularImages, imageId);
            if (preview) ctx.onImageExpand(preview);
          }}
        />
        {userVideos.length > 0 && (
          <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
            {userVideos.map((file) => (
              <UserVideoAttachment key={file.id} file={file} />
            ))}
          </div>
        )}
        {unchippedFiles.length > 0 || unknownAttachments.length > 0 ? (
          <div className="mb-2 flex flex-col gap-1">
            {unchippedFiles.map((file) => {
              const fileIdentity = (
                <>
                  <PierreEntryIcon pathValue={file.name} kind="file" theme={ctx.resolvedTheme} />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                </>
              );
              if (file.downloadable !== false) {
                return (
                  <div key={file.id} className="flex min-w-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Preview ${file.name}`}
                      onClick={() => ctx.onFileOpen(file)}
                      className="focus-visible:ring-ring/70 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1 text-left text-sm hover:underline focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
                    >
                      {fileIdentity}
                      <EyeIcon className="size-4 shrink-0" />
                    </button>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label={`Download ${file.name}`}
                            onClick={() => ctx.onFileDownload(file)}
                          />
                        }
                      >
                        <DownloadIcon />
                      </TooltipTrigger>
                      <TooltipPopup side="top">Download {file.name}</TooltipPopup>
                    </Tooltip>
                  </div>
                );
              }

              return (
                <div key={file.id} className="flex min-w-0 items-center gap-2 py-1 text-sm">
                  {fileIdentity}
                </div>
              );
            })}
            {unknownAttachments.map((attachment) => (
              <div key={attachment.id} className="flex min-w-0 items-center gap-2 py-1 text-sm">
                <PierreEntryIcon
                  pathValue={attachment.name}
                  kind="file"
                  theme={ctx.resolvedTheme}
                />
                <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div onCopyCapture={onBodyCopyCapture}>
          <CollapsibleUserMessageBody
            text={resolvedContext.text}
            renderContextReference={renderContextReference}
            skills={ctx.skills}
            markdownCwd={ctx.markdownCwd}
          />
        </div>
      </div>
      <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
              {formatDayAwareTimestamp(row.message.createdAt, ctx.timestampFormat)}
            </TooltipTrigger>
            <TooltipPopup>
              {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
            </TooltipPopup>
          </Tooltip>
          <div className="flex items-center gap-0.5">
            {row.canForkConversation === true && ctx.onForkUserMessage ? (
              <ScientForkMessageButton
                label="Fork conversation from this message"
                onFork={() => ctx.onForkUserMessage?.(row.message)}
              />
            ) : null}
            {typeof revertTurnCount === "number" && (
              <RevertUserMessageButton turnCount={revertTurnCount} messageId={row.message.id} />
            )}
            {resolvedContext.text && (
              <MessageCopyButton
                // Structured paste needs the canonical links to retain their positions.
                text={
                  contextClipboardFragment
                    ? resolvedContext.text
                    : replaceComposerContextReferences(
                        resolvedContext.text,
                        (reference) => reference.label,
                      )
                }
                {...(contextClipboardFragment
                  ? {
                      extraFlavors: { [COMPOSER_CONTEXT_CLIPBOARD_MIME]: contextClipboardFragment },
                    }
                  : {})}
                // SCIENT-FORK:START — right-to-left messages also copy as direction-marked HTML
                resolveHtml={(anchor) =>
                  messageCopyHtml({
                    anchor,
                    messageId: row.message.id,
                    markdown: resolvedContext.text,
                    lineBreaks: true,
                    parseRawHtml: false,
                  })
                }
                // SCIENT-FORK:END
                variant="ghost"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function resolvePreviewAnnotationImage(input: {
  record: Extract<KnownComposerContextRecord, { kind: "preview-annotation" }>;
  recordsById: ReadonlyMap<string, ComposerContextRecord>;
  userImages: ReadonlyArray<ChatImageAttachment>;
  previewImages: ReadonlyArray<ChatImageAttachment>;
  annotationRecordIds: ReadonlyArray<string>;
}): ChatImageAttachment | null {
  const screenshotRecord = input.record.screenshotContextId
    ? asKnownContextRecord(input.recordsById.get(input.record.screenshotContextId))
    : undefined;
  return (
    (screenshotRecord?.kind === "image"
      ? input.userImages.find((image) => image.id === screenshotRecord.attachmentId)
      : undefined) ??
    input.previewImages.find(
      (image) => image.name === `preview-annotation-${input.record.annotationId}.png`,
    ) ??
    input.previewImages[input.annotationRecordIds.indexOf(input.record.contextId)] ??
    null
  );
}

function RevertUserMessageButton({
  turnCount,
  messageId,
}: {
  turnCount: number;
  messageId: MessageId;
}) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activity.isRevertingCheckpoint || activity.isWorking}
            onClick={() => ctx.onRevertToTurnCount(turnCount, messageId)}
            aria-label="Edit from here"
          />
        }
      >
        <Undo2Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Edit from here</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Hover-revealed wall-clock time with a full-date tooltip — the same metadata
 * presentation as message rows, for work entries and turn folds. The parent
 * carries `group/timeline-row`; hover or focus on an existing control reveals
 * the time without adding a tab stop. Hidden timestamps stay outside the row
 * layout. Visibility changes immediately so leaving flow cannot overlap text
 * during a fade-out. Place it before any trailing disclosure control so
 * revealing the time does not move the chevron.
 */
function TimelineRowTimestamp({
  createdAt,
  timestampFormat,
  className,
}: {
  createdAt: string;
  timestampFormat: TimestampFormat;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md text-muted-foreground text-xs tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100",
              className,
            )}
          />
        }
      >
        {formatDayAwareTimestamp(createdAt, timestampFormat)}
      </TooltipTrigger>
      <TooltipPopup>{formatChatTimestampTooltip(createdAt, timestampFormat)}</TooltipPopup>
    </Tooltip>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  const Icon = row.expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="group/timeline-row relative flex items-center gap-1 border-b border-border/60 pb-2 pe-0.5 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        onClick={() => ctx.onToggleTurnFold(row.turnId)}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span>{row.label}</span>
        <Icon className="size-3.5" />
      </button>
      <TimelineRowTimestamp
        createdAt={row.createdAt}
        timestampFormat={ctx.timestampFormat}
        className="ms-auto"
      />
    </div>
  );
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const assistantImages = (row.message.attachments ?? []).filter(isImageAttachment);
  const messageText =
    row.message.text ||
    (row.message.streaming || assistantImages.length > 0 ? "" : "(empty response)");

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        <MessageAuthorHeading>Scient</MessageAuthorHeading>
        <AssistantCitationSource
          messageId={row.message.id}
          {...(ctx.threadRef ? { threadRef: ctx.threadRef } : {})}
          itemKey={row.id}
          request={ctx.citationRequest}
          listRef={ctx.listRef}
        >
          <>
            <ChatMarkdown
              text={messageText}
              cwd={ctx.markdownCwd}
              threadRef={ctx.threadRef ?? undefined}
              isStreaming={Boolean(row.message.streaming)}
              messageId={row.message.id}
              changedFiles={row.assistantTurnChangedFiles}
              directionHint={row.assistantDirectionHint}
              lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
              skills={ctx.skills}
              headingLevelOffset={MESSAGE_HEADING_LEVEL}
              onUseArtifactTemplate={ctx.onUseArtifactTemplate}
              onRunShellCommand={ctx.onRunShellCommand}
              onImageExpand={ctx.onImageExpand}
            />
            <ScientChatImageGallery
              className={messageText.length > 0 ? "mt-3" : undefined}
              images={assistantImages}
              onExpand={(imageId) => {
                const preview = buildExpandedImagePreview(assistantImages, imageId);
                if (preview) ctx.onImageExpand(preview);
              }}
            />
            {/* SCIENT-FORK: the end of the answer's readable content (withReadingEnd). */}
            <span data-reading-end="true" aria-hidden="true" className="block h-0" />
          </>
        </AssistantCitationSource>
        <AssistantChangedFilesSection
          turnSummary={row.assistantTurnDiffSummary}
          routeThreadKey={ctx.routeThreadKey}
          resolvedTheme={ctx.resolvedTheme}
          onOpenTurnDiff={ctx.onOpenTurnDiff}
        />
        {row.showAssistantMeta ? (
          <AssistantMessageMeta
            className="mt-1.5"
            message={row.message}
            showCopyButton={row.showAssistantCopyButton}
            copyStreaming={row.assistantCopyStreaming}
            canForkConversation={row.canForkConversation}
          />
        ) : null}
      </div>
    </>
  );
}

function AssistantMetaTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "assistant-meta" }>;
}) {
  return (
    <div className="px-1">
      <AssistantMessageMeta
        className="mt-0.5"
        message={row.message}
        showCopyButton={row.showAssistantCopyButton}
        copyStreaming={row.assistantCopyStreaming}
        canForkConversation={row.canForkConversation}
        alwaysVisible
      />
    </div>
  );
}

function AssistantMessageMeta({
  className,
  message,
  showCopyButton,
  copyStreaming,
  canForkConversation,
  alwaysVisible = false,
}: {
  className?: string;
  message: ChatMessage;
  showCopyButton: boolean;
  copyStreaming: boolean;
  canForkConversation?: boolean | undefined;
  alwaysVisible?: boolean;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200",
        alwaysVisible
          ? "opacity-100"
          : "opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100",
        className,
      )}
    >
      <AssistantCopyButton
        message={message}
        showCopyButton={showCopyButton}
        streaming={copyStreaming}
      />
      {canForkConversation === true && ctx.onForkAssistantMessage ? (
        <ScientForkMessageButton onFork={() => ctx.onForkAssistantMessage?.(message.id)} />
      ) : null}
      {!message.streaming && (
        <Tooltip>
          <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
            {formatDayAwareTimestamp(message.updatedAt, ctx.timestampFormat)}
          </TooltipTrigger>
          <TooltipPopup>
            {formatChatTimestampTooltip(message.updatedAt, ctx.timestampFormat)}
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

function AssistantCopyButton({
  message,
  showCopyButton,
  streaming,
}: {
  message: ChatMessage;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: message.text ?? null,
    showCopyButton,
    streaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return (
    <MessageCopyButton
      text={assistantCopyState.text ?? ""}
      // SCIENT-FORK:START — right-to-left messages also copy as direction-marked HTML
      resolveHtml={(anchor) =>
        messageCopyHtml({
          anchor,
          messageId: message.id,
          markdown: assistantCopyState.text ?? "",
          lineBreaks: shouldPreserveAssistantLineBreaks(assistantCopyState.text ?? ""),
          parseRawHtml: true,
        })
      }
      // SCIENT-FORK:END
      variant="ghost"
    />
  );
}

function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
      />
    </div>
  );
}

/** Inline folded plan chip: one row per turn that produced plan/todo steps. */
const TurnPlanTimelineRow = memo(function TurnPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "turn-plan" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { steps } = row.turnPlan.plan;
  const completedCount = steps.filter((step) => step.status === "completed").length;
  const allDone = completedCount === steps.length;
  const label =
    steps.find((step) => step.status === "inProgress")?.step ??
    steps.find((step) => step.status === "pending")?.step ??
    steps.at(-1)?.step ??
    "Plan";
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="min-w-0 px-1 py-0.5">
      <button
        type="button"
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-0.5 py-0.5 text-left text-xs leading-5 transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Chevron className="size-3.5 shrink-0 text-muted-foreground/65" />
        {steps.length > 1 ? (
          <span aria-hidden className="flex shrink-0 items-center gap-0.5">
            {steps.map((step) => (
              <span
                key={step.step}
                className={cn(
                  "h-[3px] w-2.5 rounded-full",
                  step.status === "completed"
                    ? "bg-success"
                    : step.status === "inProgress"
                      ? "bg-primary"
                      : "bg-muted-foreground/25",
                )}
              />
            ))}
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 truncate",
            allDone ? "text-muted-foreground/65" : "font-medium text-foreground/85",
          )}
        >
          {label}
        </span>
        {steps.length > 1 ? (
          <span className="shrink-0 text-muted-foreground/50 tabular-nums">
            {completedCount}/{steps.length}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="mt-0.5 space-y-px pl-6">
          {steps.map((step) => (
            <div key={step.step} className="flex items-baseline gap-2 text-xs leading-5">
              <span
                className={cn(
                  "w-3 shrink-0 text-center font-mono text-3xs",
                  step.status === "completed"
                    ? "text-success"
                    : step.status === "inProgress"
                      ? "text-primary"
                      : "text-muted-foreground/40",
                )}
                aria-hidden
              >
                {step.status === "completed" ? "✓" : step.status === "inProgress" ? "●" : "○"}
              </span>
              <span
                className={cn(
                  "min-w-0",
                  step.status === "completed"
                    ? "text-muted-foreground/55"
                    : step.status === "inProgress"
                      ? "text-foreground/90"
                      : "text-muted-foreground/70",
                )}
              >
                {step.step}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
});

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const { isCompacting, isPreparingWorktree, backgroundWorktreeSetup } =
    use(TimelineRowActivityCtx);
  const exiting = Boolean(row.exiting);
  // One span for every label so the setup-to-working handoff swaps text in
  // place instead of remounting the row. The label carries the same live
  // shine as the thinking traces for as long as the turn works.
  const shimmer = !exiting;
  const label = isPreparingWorktree ? (
    "Setting up worktree…"
  ) : isCompacting ? (
    <CompactingLabel />
  ) : row.createdAt ? (
    <>
      Working for <WorkingTimer createdAt={row.createdAt} />
    </>
  ) : (
    "Working..."
  );
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!exiting || !root || typeof root.animate !== "function") return;
    // Fade out while the space closes; the negative margin takes the row's
    // bottom padding along, so nothing is left to snap when it leaves.
    root.animate(
      [
        { height: `${root.getBoundingClientRect().height}px`, opacity: 1, marginBottom: "0px" },
        { height: "0px", opacity: 0, marginBottom: "-6px" },
      ],
      { duration: WORKING_ROW_EXIT_MS, easing: WORKING_ROW_EXIT_EASING, fill: "forwards" },
    );
  }, [exiting]);
  return (
    <div
      ref={rootRef}
      className={cn("border-b border-border/60 pb-2 pt-1", exiting && "overflow-hidden")}
    >
      <div className="flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
        <span
          ref={shimmer ? observeVisibleAnimation : undefined}
          className="relative shrink-0 overflow-hidden whitespace-nowrap"
        >
          {label}
          {shimmer ? <ActivityShimmerOverlay>{label}</ActivityShimmerOverlay> : null}
        </span>
        {backgroundWorktreeSetup ? (
          <BackgroundWorktreeSetupChip snapshot={backgroundWorktreeSetup} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Trailing chip in the working header while a setup script still runs after
 * the agent started. Opens the stage list and live output in a popover; the
 * chip leaves with the script, so nothing lingers in the timeline.
 */
function BackgroundWorktreeSetupChip({ snapshot }: { snapshot: WorktreeSetupSnapshot }) {
  const ctx = use(TimelineRowCtx);
  const terminalId = snapshot.setupScript?.terminalId ?? null;
  const openTerminal = ctx.onOpenWorktreeSetupTerminal;
  const onOpenTerminal = useMemo(
    () => (openTerminal && terminalId ? () => openTerminal(terminalId) : null),
    [openTerminal, terminalId],
  );
  const scriptName = snapshot.setupScript?.name ?? "Setup script";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="micro"
            className="ml-auto min-w-0 shrink-0"
            aria-label={`${scriptName} is still running. Show setup progress.`}
          />
        }
      >
        <Spinner size="xs" className="shrink-0" />
        <span className="truncate">{scriptName}</span>
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="lg" padding="compact">
        <WorktreeSetupCard
          snapshot={snapshot}
          embedded
          onCancel={null}
          onWorkLocally={null}
          onOpenTerminal={onOpenTerminal}
        />
      </PopoverPopup>
    </Popover>
  );
}

function ActivityGroupTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "activity-group" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const work = omitSupersededLifecycleMarkers(
    row.entries.flatMap((entry) =>
      entry.kind === "work" && workEntryIsVisibleInGroup(entry.entry, row.active)
        ? [entry.entry]
        : [],
    ),
    (entry) => entry,
  );
  const thoughtCount = row.entries.filter((entry) => entry.kind === "message").length;
  const lastThoughtIndex = row.entries.findLastIndex((entry) => entry.kind === "message");
  const trailingWork = omitSupersededLifecycleMarkers(
    row.entries
      .slice(lastThoughtIndex + 1)
      .flatMap((entry) =>
        entry.kind === "work" && workEntryIsVisibleInGroup(entry.entry, row.active)
          ? [entry.entry]
          : [],
      ),
    (entry) => entry,
  );
  const liveWork = trailingWork.findLast(workEntryIsActiveTurnActivity) ?? trailingWork.at(-1);
  const thinking = row.active && liveWork === undefined;
  const iconWork = row.active ? liveWork : work.at(-1);
  const failed = iconWork !== undefined && workEntryDisplayIndicatesToolFailure(iconWork);
  const label = row.active
    ? liveWork
      ? liveWorkEntryLabel(liveWork, ctx.workspaceRoot, true)
      : "Thinking"
    : work.length > 0
      ? summarizeToolGroup(work)
      : `Thought${thoughtCount > 1 ? ` (×${thoughtCount})` : ""}`;
  const details: ReactNode[] = [];
  if (row.expanded) {
    for (let index = 0; index < row.entries.length; index += 1) {
      const entry = row.entries[index]!;
      if (entry.kind === "work") {
        const entries = [entry.entry];
        while (row.entries[index + 1]?.kind === "work") {
          const next = row.entries[++index]!;
          if (next.kind === "work") entries.push(next.entry);
        }
        details.push(
          <WorkGroupSection
            key={entry.id}
            anchorKey={entry.id}
            disclosureAnchorKey={row.id}
            groupedEntries={omitSupersededLifecycleMarkers(entries, (entry) => entry)}
            isExpandedToolGroup
          />,
        );
      } else {
        const messages = [entry.message];
        while (row.entries[index + 1]?.kind === "message") {
          const next = row.entries[++index]!;
          if (next.kind === "message") messages.push(next.message);
        }
        details.push(
          <ReasoningTraceBlock
            key={entry.id}
            anchorKey={row.id}
            messages={messages}
            live={row.active && index === row.entries.length - 1}
            showHeader={work.length > 0}
          />,
        );
      }
    }
  }
  return (
    <div>
      <button
        type="button"
        className="group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        aria-label={failed ? `${label}, tool call failed` : undefined}
        aria-expanded={row.expanded}
        onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
      >
        <LiveActivityRow
          label={label}
          iconName={iconWork ? workEntryIconName(iconWork) : "brain"}
          toolIcon={iconWork?.toolIcon ?? iconWork?.toolSource?.icon}
          failed={failed}
          active={row.active}
          shimmer={thinking}
        />
      </button>
      {row.expanded ? <div className="mt-2">{details}</div> : null}
    </div>
  );
}

function ThinkingTimelineRow() {
  const { isCompacting, isPreparingWorktree, thinkingFollowsAnswerId } =
    use(TimelineRowActivityCtx);
  // While the answer above it is appearing line by line, the flowing text shows
  // the work; the row fades out (keeping its place) and returns when the agent
  // thinks or uses tools again.
  const answerAppearing = useStreamingTextAppearing(thinkingFollowsAnswerId);
  // Reserve the activity row during setup so the handoff keeps the same height.
  return (
    <div
      className={cn(
        "min-h-7 transition-opacity duration-300 ease-in-out motion-reduce:transition-none",
        answerAppearing && "opacity-0",
      )}
      aria-hidden={answerAppearing || undefined}
    >
      {isPreparingWorktree || isCompacting ? null : (
        <LiveActivityRow label="Thinking" iconName="brain" active shimmer />
      )}
    </div>
  );
}

function remarkThoughtPreview(fallback: string) {
  return (tree: Root) => {
    const plainText = (node: Root | RootContent): string => {
      if (node.type === "html" || node.type === "definition") return "";
      if ("alt" in node) return node.alt ?? "";
      if ("value" in node) return node.value;
      if ("children" in node) {
        const separator = ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(
          node.type,
        )
          ? " "
          : "";
        return node.children.map(plainText).join(separator);
      }
      return node.type === "break" ? " " : "";
    };
    tree.children = [
      { type: "text", value: plainText(tree).replace(/\s+/g, " ").trim() || fallback },
    ];
  };
}

/**
 * Thinking inside a tool group has its own disclosure, preserved across recycling.
 * A group whose row already reads "Thought" (no visible tool) skips the header.
 */
function ReasoningTraceBlock({
  anchorKey,
  messages,
  live,
  showHeader,
}: {
  anchorKey: string;
  messages: ReadonlyArray<ChatMessage>;
  live: boolean;
  showHeader: boolean;
}) {
  const ctx = use(TimelineRowCtx);
  const { isWorking, unsettledTurnId } = use(TimelineRowActivityCtx);
  const first = messages[0]!;
  const expanded = !showHeader || ctx.expandedReasoningMessageIds.has(first.id);
  const streaming =
    live &&
    messages.some((reasoningMessage) => reasoningMessage.streaming) &&
    isWorking &&
    first.turnId !== null &&
    first.turnId === unsettledTurnId;
  if (
    messages.every((reasoningMessage) => reasoningMessage.text.trim().length === 0) &&
    !streaming
  ) {
    return null;
  }
  const label = streaming ? "Thinking" : "Thought";
  const collapsedPreview = messages.find((message) => message.text.trim().length > 0)?.text.trim();
  const headerText = expanded ? (
    label
  ) : (
    <ReactMarkdown remarkPlugins={[remarkGfm, [remarkThoughtPreview, label]]}>
      {collapsedPreview ?? label}
    </ReactMarkdown>
  );
  return (
    <div className="flex flex-col">
      {showHeader ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => ctx.onToggleReasoning(first.id, !expanded, anchorKey)}
          className="flex min-h-6 cursor-pointer select-none items-center gap-1.5 rounded-md py-1 ps-0.5 pe-2 text-start text-sm leading-relaxed transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <span className="flex size-6 shrink-0 items-center justify-center text-trace-icon">
            <BrainIcon aria-hidden className="block size-4 shrink-0 stroke-2 opacity-70" />
          </span>
          <span
            ref={streaming ? observeVisibleAnimation : undefined}
            className="relative min-w-0 flex-1 truncate text-trace-label"
          >
            {headerText}
            {streaming ? <ActivityShimmerOverlay>{headerText}</ActivityShimmerOverlay> : null}
          </span>
          <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
            <ChevronRightIcon
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-90",
              )}
            />
          </span>
        </button>
      ) : null}
      {expanded ? (
        <div className="ms-7 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text">
          {messages.map((reasoningMessage) => (
            <ChatMarkdown
              key={reasoningMessage.id}
              className="text-foreground"
              text={reasoningMessage.text}
              cwd={ctx.markdownCwd}
              threadRef={ctx.threadRef ?? undefined}
              isStreaming={streaming && reasoningMessage.streaming}
              lineBreaks
              skills={ctx.skills}
              headingLevelOffset={MESSAGE_HEADING_LEVEL}
              onUseArtifactTemplate={ctx.onUseArtifactTemplate}
              onImageExpand={ctx.onImageExpand}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A provider's thinking trace. Collapsed by default: reasoning is context for
 * the answer, not the answer. The open/closed flag lives on the list so it
 * survives row recycling in the virtualizer.
 */
const ReasoningTimelineRow = memo(function ReasoningTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "message" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const { message } = row;
  const expanded = ctx.expandedReasoningMessageIds.has(message.id);
  const { onToggleReasoning } = ctx;
  const toggle = useCallback(() => {
    onToggleReasoning(message.id, !expanded, row.id);
  }, [expanded, message.id, row.id, onToggleReasoning]);

  if (message.text.trim().length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-col", expanded && "mb-1")}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={toggle}
        className="flex cursor-pointer select-none items-center gap-1.5 rounded-md px-0.5 py-1 text-start transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-trace-icon">
          <BrainIcon aria-hidden className="block size-4 shrink-0 stroke-2 opacity-70" />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="relative min-w-0 flex-1 truncate text-trace-label text-sm leading-relaxed">
            Thought
          </span>
          <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
            <ChevronRightIcon
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-90",
              )}
            />
          </span>
        </span>
      </button>
      {expanded ? (
        <div className="mt-1 ms-7 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text">
          <ChatMarkdown
            className="text-secondary-label"
            text={message.text}
            cwd={ctx.markdownCwd}
            threadRef={ctx.threadRef ?? undefined}
            lineBreaks
            skills={ctx.skills}
            headingLevelOffset={MESSAGE_HEADING_LEVEL}
            onUseArtifactTemplate={ctx.onUseArtifactTemplate}
            onImageExpand={ctx.onImageExpand}
          />
        </div>
      ) : null}
    </div>
  );
});

function CompactingLabel() {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Minimize2Icon aria-hidden="true" className="size-3" />
      Compacting…
    </span>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking labels — update their own text nodes so elapsed-time display
// does not create a React commit every second while a response is streaming.
// ---------------------------------------------------------------------------

/** Live elapsed time for the "Working for" label. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

/** A step this young shows no timer: only one that runs long needs to prove it is alive. */
const LIVE_STEP_TIMER_AFTER_MS = 10_000;

function liveStepElapsedSuffix(startedAt: string): string {
  const elapsedMs = Date.now() - Date.parse(startedAt);
  return Number.isFinite(elapsedMs) && elapsedMs >= LIVE_STEP_TIMER_AFTER_MS
    ? ` · ${formatWorkingTimerNow(startedAt)}`
    : "";
}

/**
 * How long a step that is still running has run, once it has run long enough
 * to wonder. Ticks through DOM writes, like the turn's own timer.
 */
function LiveStepElapsed({ startedAt }: { startedAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = liveStepElapsedSuffix(startedAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = liveStepElapsedSuffix(startedAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <span ref={textRef} className="shrink-0 whitespace-pre tabular-nums">
      {initialText}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Renders standalone activity or one bounded, virtualized expanded tool group. */
const WorkGroupSection = memo(function WorkGroupSection({
  anchorKey,
  disclosureAnchorKey = anchorKey,
  groupedEntries,
  isExpandedToolGroup,
  displayLabel,
}: {
  anchorKey: string;
  disclosureAnchorKey?: string;
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
  isExpandedToolGroup: boolean;
  displayLabel?: string | undefined;
}) {
  const { workspaceRoot, routeThreadKey, onToggleWorkEntry } = use(TimelineRowCtx);
  const onToggleStandaloneEntry = useCallback(
    (collapsed: boolean) => onToggleWorkEntry(disclosureAnchorKey, collapsed),
    [disclosureAnchorKey, onToggleWorkEntry],
  );
  const nonEmptyEntries = useMemo(
    () => groupedEntries.filter((entry) => workEntryIsVisibleInGroup(entry, isExpandedToolGroup)),
    [groupedEntries, isExpandedToolGroup],
  );

  if (nonEmptyEntries.length === 0) return null;
  if (isExpandedToolGroup) {
    return (
      <ExpandedWorkGroupEntries
        key={`${routeThreadKey}:${anchorKey}`}
        anchorKey={anchorKey}
        disclosureAnchorKey={disclosureAnchorKey}
        entries={nonEmptyEntries}
        workspaceRoot={workspaceRoot}
      />
    );
  }

  return (
    <section className="-mx-1 space-y-0.5 px-1 py-0.5" aria-label="Activity">
      <div className="space-y-px">
        {nonEmptyEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={workEntry.id}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
            isExpandedToolGroupEntry={false}
            displayLabel={displayLabel}
            onToggleEntry={onToggleStandaloneEntry}
          />
        ))}
      </div>
    </section>
  );
});

function ExpandedWorkGroupEntries({
  anchorKey,
  disclosureAnchorKey,
  entries,
  workspaceRoot,
}: {
  anchorKey: string;
  disclosureAnchorKey: string;
  entries: TimelineWorkEntry[];
  workspaceRoot: string | undefined;
}) {
  const { workGroupViewState: viewState, onToggleWorkEntry } = use(TimelineRowCtx);
  const [initialScrollIndex] = useState(() =>
    resolveWorkGroupScrollIndex(entries, viewState.scrollPositions.get(anchorKey)),
  );
  const [restoringPosition, setRestoringPosition] = useState(initialScrollIndex !== undefined);
  const listRef = useRef<LegendListRef>(null);
  const [fades, setFades] = useState({ top: false, bottom: false, viewportHeight: 0 });
  const [appendState, setAppendState] = useState({ entries, follow: false });
  // Capture the pre-change edge once per incoming array, before new layout
  // metrics arrive. Edge/viewport changes never turn a status update into a follow.
  if (appendState.entries !== entries) {
    setAppendState({
      entries,
      follow:
        fades.viewportHeight > 0 &&
        shouldFollowWorkGroupAppend(appendState.entries, entries, fades.bottom ? Infinity : 0),
    });
  }

  const groupView = useMemo(
    () => ({
      state: viewState,
      onToggleEntry: (collapsed: boolean) => onToggleWorkEntry(disclosureAnchorKey, collapsed),
    }),
    [disclosureAnchorKey, onToggleWorkEntry, viewState],
  );
  const updateScrollFades = useCallback(() => {
    const element = listRef.current?.getScrollableNode();
    if (!element) return;
    const distanceFromEnd = element.scrollHeight - element.clientHeight - element.scrollTop;
    const viewportHeight = element.clientHeight;
    const top = element.scrollTop > 1;
    const bottom = distanceFromEnd > 1;
    setFades((previous) =>
      previous.top === top &&
      previous.bottom === bottom &&
      previous.viewportHeight === viewportHeight
        ? previous
        : { top, bottom, viewportHeight },
    );
  }, []);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState();
    const position = state && resolveWorkGroupScrollAnchor(state);
    if (position) {
      viewState.scrollPositions.set(anchorKey, {
        entryId: position.rowId,
        offset: position.offsetWithinRow,
      });
    }
    updateScrollFades();
  }, [anchorKey, updateScrollFades, viewState]);

  const handleLoad = useCallback(() => {
    const list = listRef.current;
    const element = list?.getScrollableNode();
    if (initialScrollIndex && list && element) {
      // Bootstrap can report the restored target before the DOM has applied it.
      // Reconcile once at load, before releasing the measured anchor row.
      const offset = Math.max(
        0,
        Math.min(list.getState().scroll, element.scrollHeight - element.clientHeight),
      );
      if (Math.abs(element.scrollTop - offset) > 1) {
        void list.scrollToOffset({ offset, animated: false });
      }
    }
    setRestoringPosition(false);
  }, [initialScrollIndex]);

  useLayoutEffect(() => {
    const element = listRef.current?.getScrollableNode();
    if (!element) return;
    updateScrollFades();
    const observer = new ResizeObserver(updateScrollFades);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [updateScrollFades]);

  const renderEntry = useCallback(
    ({ item }: { item: TimelineWorkEntry }) => (
      <SimpleWorkEntryRow
        key={item.id}
        workEntry={item}
        workspaceRoot={workspaceRoot}
        isExpandedToolGroupEntry
      />
    ),
    [workspaceRoot],
  );

  return (
    <WorkGroupViewCtx value={groupView}>
      <LegendList
        ref={listRef}
        data={entries}
        extraData={workspaceRoot}
        keyExtractor={workEntryKey}
        renderItem={renderEntry}
        estimatedItemSize={28}
        drawDistance={240}
        recycleItems
        {...(initialScrollIndex ? { initialScrollIndex } : {})}
        maintainScrollAtEnd={
          appendState.follow ? { animated: false, on: { dataChange: true } } : false
        }
        maintainScrollAtEndThreshold={1 / Math.max(1, fades.viewportHeight)}
        // Measure the restored row even when an intra-row offset puts its
        // estimated bounds outside the list's small bootstrap render window.
        {...(restoringPosition && initialScrollIndex
          ? { alwaysRender: { indices: [initialScrollIndex.index] } }
          : {})}
        maintainVisibleContentPosition
        onLoad={handleLoad}
        onScroll={handleScroll}
        onLayout={updateScrollFades}
        tabIndex={0}
        role="region"
        aria-label="Tool calls"
        data-tool-group-scroll
        className={cn(
          "scrollbar-gutter-stable max-h-[min(18rem,50dvh)] scroll-py-6 overflow-x-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          getVirtualizedScrollFadeClassName(fades),
        )}
      />
    </WorkGroupViewCtx>
  );
}

const workEntryKey = (entry: TimelineWorkEntry) => entry.id;

function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}

const failedToolIconClassName = "text-tool-error-icon/40";

/** Image icons and the gradient computer-use mark cannot take a currentColor
 *  tint, so failed rows using them get a trailing x instead. */
function toolIconAcceptsTint(
  iconName: WorkEntryIconName,
  toolIcon: ToolActivityIcon | undefined,
): boolean {
  return toolIcon === undefined && iconName !== "computer";
}

function LiveActivityRow({
  label,
  iconName,
  toolIcon,
  failed = false,
  active = false,
  shimmer = false,
}: {
  label: ReactNode;
  iconName?: WorkEntryIconName;
  toolIcon?: ToolActivityIcon | undefined;
  failed?: boolean;
  active?: boolean;
  shimmer?: boolean;
}) {
  const animated = active && !failed;
  const showShimmer = animated && shimmer;
  return (
    <div
      ref={animated ? observeVisibleAnimation : undefined}
      className="relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed"
    >
      <LiveActivityContent
        label={label}
        iconName={iconName}
        toolIcon={toolIcon}
        failed={failed}
        announceFailure={failed}
        active={animated && !shimmer}
      />
      {showShimmer ? (
        <ActivityShimmerOverlay>
          <LiveActivityContent label={label} iconName={iconName} toolIcon={toolIcon} highlighted />
        </ActivityShimmerOverlay>
      ) : null}
    </div>
  );
}

function LiveActivityContent({
  label,
  iconName,
  toolIcon,
  failed = false,
  announceFailure = false,
  active = false,
  highlighted = false,
}: {
  label: ReactNode;
  iconName: WorkEntryIconName | undefined;
  toolIcon?: ToolActivityIcon | undefined;
  failed?: boolean;
  announceFailure?: boolean;
  active?: boolean;
  highlighted?: boolean;
}) {
  const showTrailingFailureMark =
    failed && iconName !== undefined && !toolIconAcceptsTint(iconName, toolIcon);

  return (
    <span
      className={cn(
        "flex min-h-6 min-w-0 items-center gap-1.5 py-1",
        iconName ? "px-0.5" : "px-1",
        highlighted ? "text-foreground" : "text-trace-label",
      )}
    >
      {iconName ? (
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center",
            failed ? failedToolIconClassName : highlighted ? "text-foreground" : "text-trace-icon",
          )}
          role={announceFailure ? "img" : undefined}
          aria-label={announceFailure ? "Tool call failed" : undefined}
        >
          <ToolActivityIconView
            icon={toolIcon}
            fallbackName={iconName}
            className="block size-4 shrink-0 stroke-2"
            muted={!highlighted}
          />
        </span>
      ) : null}
      <span className={cn("min-w-0 flex-1 truncate", active && "live-tool-shine")}>{label}</span>
      {showTrailingFailureMark ? (
        <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
      ) : null}
    </span>
  );
}

function LiveWorkEntryTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "work-live" }> }) {
  const ctx = use(TimelineRowCtx);
  if (row.entry.agentSpawn) {
    return (
      <AgentSpawnRow
        workEntry={row.entry}
        active={row.active}
        onToggleEntry={(collapsed) => ctx.onToggleWorkEntry(row.id, collapsed)}
      />
    );
  }
  const questionHeading = row.entry.questionAnswer
    ? getQuestionTextPreview(row.entry.questionAnswer)
    : "";
  const label = questionHeading || liveWorkEntryLabel(row.entry, ctx.workspaceRoot, row.active);
  const failed = workEntryDisplayIndicatesToolFailure(row.entry);

  return (
    <button
      type="button"
      className="group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-label={failed ? `${label}, tool call failed` : undefined}
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    >
      <LiveActivityRow
        label={
          row.entry.questionAnswer && hasQuestionAnswer(row.entry.questionAnswer) ? (
            <span className="flex min-w-0 gap-1.5">
              <span className="min-w-0 truncate">{label}</span>
              <span className="min-w-0 truncate text-foreground">
                {getQuestionAnswerPreview(row.entry.questionAnswer)}
              </span>
            </span>
          ) : row.active && row.entry.toolLifecycleStatus === "inProgress" ? (
            <span className="flex min-w-0">
              <span className="min-w-0 truncate">{label}</span>
              <LiveStepElapsed startedAt={row.entry.startedAt ?? row.entry.createdAt} />
            </span>
          ) : (
            label
          )
        }
        iconName={workEntryIconName(row.entry)}
        toolIcon={row.entry.toolIcon ?? row.entry.toolSource?.icon}
        failed={failed}
        active={row.active}
      />
    </button>
  );
}

function toolGroupSummaryIconName(
  kind: Extract<TimelineRow, { kind: "work-toggle" }>["summaryKind"],
): WorkEntryIconName {
  switch (kind) {
    case "pull-request":
    case "link-pr":
    case "unlink-pr":
    case "list-prs":
      return "pull-request";
    case "read":
      return "eye";
    case "edit":
      return "square-pen";
    case "command":
      return "terminal";
    case "browser":
      return "browser";
    case "device":
      return "device";
    case "search":
      return "globe";
    case "code-search":
      return "search";
    case "other":
      return "wrench";
    case "dynamic-tool":
      return "scient-mono";
    case "agent-tool":
      return "bot";
    case "tone-tool":
      return "zap";
    case "update":
    case "mixed":
      return "hammer";
  }
}

function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <button
      type="button"
      className="group/tool-group group/timeline-row relative flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-1 text-left text-sm leading-relaxed transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-label={row.hasFailure ? `${row.summary}, tool call failed` : undefined}
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-trace-icon">
        <ToolActivityIconView
          icon={row.toolIcon}
          fallbackName={
            row.summaryToolIcon ?? row.toolSurface ?? toolGroupSummaryIconName(row.summaryKind)
          }
          className="size-4 shrink-0 stroke-2"
          muted
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-trace-label">{row.summary}</span>
      <TimelineRowTimestamp createdAt={row.createdAt} timestampFormat={ctx.timestampFormat} />
    </button>
  );
}

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

/** Inner component that only mounts when there are actual changed files,
 *  so the store subscription is unconditional (no hooks after early return). */
function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const ctx = use(TimelineRowCtx);
  const persistedExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.turnId],
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const allDirectoriesExpanded = persistedExpanded ?? false;

  const thread = useThread(ctx.threadRef);
  const activeProject = useProject(
    thread && thread.projectId
      ? { environmentId: thread.environmentId, projectId: thread.projectId }
      : null,
  );
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(ctx.activeThreadEnvironmentId),
  );
  const onFileContextMenu = useFileContextMenuHandler(ctx.activeThreadEnvironmentId);

  return (
    <ChangedFilesCard
      turnId={turnSummary.turnId}
      files={checkpointFiles}
      allDirectoriesExpanded={allDirectoriesExpanded}
      resolvedTheme={resolvedTheme}
      onToggleAllDirectories={() =>
        setExpanded(routeThreadKey, turnSummary.turnId, !allDirectoriesExpanded)
      }
      onOpenTurnDiff={onOpenTurnDiff}
      onFileContextMenu={(filePath, event) =>
        onFileContextMenu(
          {
            environmentId: ctx.activeThreadEnvironmentId,
            filePath,
            workspaceRoot: ctx.workspaceRoot,
            repositoryRoot:
              thread?.worktreePath == null
                ? activeProject?.repositoryIdentity?.rootPath
                : undefined,
          },
          event,
        )
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

function UserMessageMentionChip(props: {
  record: Extract<KnownComposerContextRecord, { kind: "mention" }>;
  copyMarkdown: string;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="mention"
            render={<button type="button" />}
            aria-label={`Preview ${props.record.path}`}
            data-markdown-copy={props.copyMarkdown}
            onClick={() => {
              if (ctx.threadRef)
                useRightPanelStore.getState().openFile(ctx.threadRef, props.record.path);
            }}
          >
            <PierreEntryIcon
              pathValue={props.record.path}
              kind={inferEntryKindFromPath(props.record.path)}
              theme={ctx.resolvedTheme}
            />
            <ContextChipLabel>{props.record.label}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup>{props.record.path}</TooltipPopup>
    </Tooltip>
  );
}

function UserMessageContextChip(props: {
  icon: ReactNode;
  label: string;
  kindLabel?: string;
  copyMarkdown: string;
  tooltip?: string;
  kind: ContextChipKind;
}) {
  return (
    <ContextChipShell
      kind={props.kind}
      icon={props.icon}
      label={props.label}
      aria-label={props.kindLabel ? `${props.kindLabel}, ${props.label}` : undefined}
      data-markdown-copy={props.copyMarkdown}
      tooltip={props.tooltip}
    />
  );
}

function UserMessagePullRequestContextChip(props: {
  record: Extract<KnownComposerContextRecord, { kind: "review-comment" }>;
  copyMarkdown: string;
  kind: ContextChipKind;
}) {
  const { activeThreadEnvironmentId, openPullRequest } = use(TimelineRowCtx);
  const metadata = props.record.pullRequest;
  if (metadata === undefined) return null;
  return (
    <PullRequestChip
      metadata={metadata}
      environmentId={activeThreadEnvironmentId}
      label={reviewCommentContextLabel(props.record)}
      kindLabel={pullRequestContextKindLabel(props.record)}
      kind={props.kind}
      copyMarkdown={props.copyMarkdown}
      onOpen={openPullRequest}
    />
  );
}

function UserMessagePreviewAnnotationDetails(props: {
  record: Extract<KnownComposerContextRecord, { kind: "preview-annotation" }>;
  image: ChatImageAttachment | null;
}) {
  const ctx = use(TimelineRowCtx);
  const visibleElements = props.record.elements ?? [];
  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border/70 bg-background/70">
      {props.image?.previewUrl ? (
        <button
          type="button"
          className="block max-h-64 w-full cursor-zoom-in overflow-hidden border-b border-border/70 bg-muted"
          aria-label={`Preview ${props.image.name}`}
          onClick={() => {
            if (!props.image) return;
            const preview = buildExpandedImagePreview([props.image], props.image.id);
            if (preview) ctx.onImageExpand(preview);
          }}
        >
          <img
            src={props.image.previewUrl}
            alt="Annotated preview crop"
            className="max-h-64 w-full object-contain"
            crossOrigin="anonymous"
          />
        </button>
      ) : (
        <div className="border-b border-border/70 bg-muted/40 px-3 py-2 text-secondary-label text-xs">
          Screenshot unavailable
        </div>
      )}
      <div className="min-w-0 px-3 py-2.5">
        <div className="text-message-foreground text-xs font-medium">
          {props.record.pageTitle?.trim() || props.record.pageUrl || "Preview annotation"}
        </div>
        {props.record.comment ? (
          <div className="mt-1 whitespace-pre-wrap wrap-break-word text-sm">
            {props.record.comment}
          </div>
        ) : null}
        <div className="mt-1 flex items-center gap-2 text-secondary-label text-3xs">
          {props.record.targetSummary ? (
            <span className="truncate">{props.record.targetSummary}</span>
          ) : null}
          {(props.record.styleChanges?.length ?? 0) > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <PaintbrushIcon className="size-3" />
              {props.record.styleChanges?.length ?? 0}
            </span>
          ) : null}
        </div>
        {visibleElements.length > 0 ? (
          <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
            {visibleElements.map((element) => {
              const source = element.source;
              const sourceLabel = source?.fileName
                ? `${source.fileName}${source.lineNumber === null ? "" : `:${source.lineNumber}`}`
                : null;
              return (
                <div
                  key={`${element.selector}\u0000${element.tagName}\u0000${sourceLabel ?? ""}\u0000${element.htmlPreview}`}
                  className="min-w-0"
                >
                  <div className="flex min-w-0 items-center gap-2 text-xs">
                    <code className="truncate text-message-foreground">
                      {element.selector || `<${element.tagName}>`}
                    </code>
                    {sourceLabel ? (
                      <span className="ml-auto shrink-0 text-secondary-label">{sourceLabel}</span>
                    ) : null}
                  </div>
                  {element.htmlPreview?.trim() ? (
                    <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/60 px-2 py-1.5 text-3xs leading-relaxed">
                      {element.htmlPreview.trim()}
                    </pre>
                  ) : null}
                </div>
              );
            })}
            {(props.record.elements?.length ?? 0) > visibleElements.length ? (
              <div className="text-secondary-label text-3xs">
                {(props.record.elements?.length ?? 0) - visibleElements.length} more selected
                elements
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function UserMessageElementDetails({
  record,
}: {
  record: Extract<KnownComposerContextRecord, { kind: "element" }>;
}) {
  const sourceLabel = record.source?.fileName
    ? `${record.source.fileName}${record.source.lineNumber === null ? "" : `:${record.source.lineNumber}`}`
    : null;
  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border/70 bg-background/70">
      <div className="border-b border-border/70 px-3 py-2.5">
        <div className="truncate text-message-foreground text-xs font-medium">
          {record.pageTitle?.trim() || record.pageUrl}
        </div>
        <div className="mt-0.5 truncate text-secondary-label text-3xs">{record.pageUrl}</div>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <code className="truncate text-message-foreground">
            {record.selector || `<${record.tagName}>`}
          </code>
          {sourceLabel ? (
            <span className="ml-auto shrink-0 text-secondary-label">{sourceLabel}</span>
          ) : null}
        </div>
        {record.htmlPreview?.trim() ? (
          <div className="flex h-40 flex-col overflow-hidden rounded border border-border">
            <ReadOnlySourcePreview name="element.html" text={record.htmlPreview} />
          </div>
        ) : null}
        {record.styles?.trim() ? (
          <div className="flex h-32 flex-col overflow-hidden rounded border border-border">
            <ReadOnlySourcePreview name="styles.css" text={record.styles} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface UserMessageContextRenderContext {
  reference: ChatMarkdownContextReference;
  annotationImage: ChatImageAttachment | null;
  attachment: ChatImageAttachment | ChatFileAttachment | null;
  resolvedTheme: "light" | "dark";
  copyMarkdown: string;
  onExpandImage: (image: ChatImageAttachment) => void;
  onExpandVideo: (file: ChatFileAttachment) => void;
  onOpenFile: (file: ChatFileAttachment) => void;
}

function UnavailableUserMessageContextChip(props: UserMessageContextRenderContext) {
  return (
    <UnresolvedChip
      label={props.reference.label}
      copyMarkdown={props.copyMarkdown}
      tooltip="This context is no longer available."
    />
  );
}

const userMessageContextPresentationRegistry = createContextPresentationRegistry<
  KnownComposerContextRecord,
  UserMessageContextRenderContext,
  ReactNode
>({
  requiredKinds: COMPOSER_CONTEXT_KINDS,
  handlers: [
    {
      kind: "mention",
      canRender: (record) => record.kind === "mention",
      render: (record, context) =>
        record.kind === "mention" ? (
          <UserMessageMentionChip record={record} copyMarkdown={context.copyMarkdown} />
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "skill",
      canRender: (record) => record.kind === "skill",
      render: (record, context) =>
        record.kind === "skill" ? (
          <UserMessageContextChip
            icon={<SkillChipIcon />}
            label={record.label || record.name}
            kindLabel="Skill"
            tooltip={`$${record.name}`}
            copyMarkdown={context.copyMarkdown}
            kind="skill"
          />
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "image",
      canRender: (record, context) =>
        record.kind === "image" &&
        context.attachment !== null &&
        isImageAttachment(context.attachment),
      render: (record, context) => {
        if (
          record.kind !== "image" ||
          context.attachment === null ||
          !isImageAttachment(context.attachment)
        ) {
          return <UnavailableUserMessageContextChip {...context} />;
        }
        const attachment = context.attachment;
        return (
          <ImageChipButton
            name={record.name}
            previewUrl={attachment.previewUrl}
            size={formatAttachmentSize(record.sizeBytes)}
            data-markdown-copy={context.copyMarkdown}
            onClick={() => context.onExpandImage(attachment)}
          />
        );
      },
    },
    {
      kind: "file",
      // A file chip names its attachment by id, so it renders whatever came back under that id.
      // `isFileAttachment` excludes pictures, which a legacy `file` attachment may still be.
      canRender: (record, context) =>
        record.kind === "file" && context.attachment !== null && context.attachment.type === "file",
      render: (record, context) => {
        if (
          record.kind !== "file" ||
          context.attachment === null ||
          context.attachment.type !== "file"
        ) {
          return <UnavailableUserMessageContextChip {...context} />;
        }
        const attachment = context.attachment;
        const isVideo = isVideoAttachment(attachment);
        const disabled =
          attachment.downloadable === false && (!isVideo || attachment.previewUrl === undefined);
        const size = formatAttachmentSize(record.sizeBytes);
        return (
          <FileChip
            name={record.name}
            size={size}
            isVideo={isVideo}
            theme={context.resolvedTheme}
            disabled={disabled}
            accessibleLabel={`${isVideo ? "Video" : "File"} attachment, ${record.name}, ${size}`}
            copyMarkdown={context.copyMarkdown}
            onOpen={() =>
              isVideo ? context.onExpandVideo(attachment) : context.onOpenFile(attachment)
            }
            tooltip={`${record.name}\n${size}`}
          />
        );
      },
    },
    {
      kind: "terminal",
      canRender: (record) => record.kind === "terminal",
      render: (record, context, definition) =>
        record.kind === "terminal" ? (
          <span data-markdown-copy={context.copyMarkdown}>
            <TerminalContextInlineChip
              label={record.label}
              terminalLabel={record.terminalLabel}
              lineStart={record.lineStart}
              lineEnd={record.lineEnd}
              text={record.text}
              detailsMode={definition.capabilities.details}
            />
          </span>
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "element",
      canRender: (record) => record.kind === "element",
      render: (record, context) =>
        record.kind === "element" ? (
          <UserMessageContextPopover
            copyMarkdown={context.copyMarkdown}
            accessibleLabel={`Browser element, ${record.label}`}
            kind="element"
            icon={<MousePointerClickIcon />}
            label={record.label}
          >
            <UserMessageElementDetails record={record} />
          </UserMessageContextPopover>
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "review-comment",
      canRender: (record) => record.kind === "review-comment",
      render: (record, context) => {
        if (record.kind !== "review-comment") {
          return <UnavailableUserMessageContextChip {...context} />;
        }
        const isPullRequest = isPullRequestSummaryContext(record);
        const label = reviewCommentContextLabel(record);
        const kindLabel = isPullRequest ? pullRequestContextKindLabel(record) : "Review comment";
        const pullRequestState = pullRequestContextDisplayState(record) ?? "unknown";
        if (isPullRequest && record.pullRequest !== undefined) {
          return (
            <UserMessagePullRequestContextChip
              record={record}
              copyMarkdown={context.copyMarkdown}
              kind={PULL_REQUEST_CHIP_KINDS[pullRequestState]}
            />
          );
        }
        return (
          <UserMessageContextPopover
            copyMarkdown={context.copyMarkdown}
            accessibleLabel={`${kindLabel}, ${label}${record.pullRequest ? `, ${record.pullRequest.title}` : ""}`}
            kind={isPullRequest ? PULL_REQUEST_CHIP_KINDS[pullRequestState] : "review-comment"}
            icon={isPullRequest ? <PullRequestGlyph.pullRequest /> : <MessageCircleIcon />}
            label={label}
          >
            <UserMessageReviewCommentCard
              comment={{
                id: record.contextId,
                sectionId: record.sectionId,
                sectionTitle: record.sectionTitle,
                filePath: record.filePath,
                startIndex: record.startIndex,
                endIndex: record.endIndex,
                rangeLabel: record.rangeLabel,
                text: record.text,
                diff: record.diff,
                ...(record.fenceLanguage !== undefined
                  ? { fenceLanguage: record.fenceLanguage }
                  : {}),
                ...(record.pullRequest !== undefined ? { pullRequest: record.pullRequest } : {}),
              }}
            />
          </UserMessageContextPopover>
        );
      },
    },
    {
      kind: "preview-annotation",
      canRender: (record) => record.kind === "preview-annotation",
      render: (record, context) =>
        record.kind === "preview-annotation" ? (
          <UserMessageContextPopover
            copyMarkdown={context.copyMarkdown}
            accessibleLabel={`Preview annotation, ${record.label}`}
            kind="preview-annotation"
            icon={<MousePointerClickIcon />}
            label={record.label}
          >
            <UserMessagePreviewAnnotationDetails record={record} image={context.annotationImage} />
          </UserMessageContextPopover>
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
  ],
  fallback: (_kind, _record, context) => <UnavailableUserMessageContextChip {...context} />,
});

/** One inline context chip in a sent message, dispatched by the shared presentation registry. */
function UserMessageContextReferenceChip(props: {
  reference: ChatMarkdownContextReference;
  record: KnownComposerContextRecord | undefined;
  annotationImage: ChatImageAttachment | null;
  attachment: ChatImageAttachment | ChatFileAttachment | null;
  onExpandImage: (image: ChatImageAttachment) => void;
  onExpandVideo: (file: ChatFileAttachment) => void;
  onOpenFile: (file: ChatFileAttachment) => void;
}) {
  const { resolvedTheme } = use(TimelineRowCtx);
  const copyMarkdown = formatComposerContextReference({
    kind: props.reference.kind,
    contextId: props.reference.contextId as ComposerContextId,
    label: props.reference.label,
  });
  return userMessageContextPresentationRegistry.render(props.reference.kind, props.record, {
    reference: props.reference,
    annotationImage: props.annotationImage,
    attachment: props.attachment,
    resolvedTheme,
    copyMarkdown,
    onExpandImage: props.onExpandImage,
    onExpandVideo: props.onExpandVideo,
    onOpenFile: props.onOpenFile,
  });
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }

  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  renderContextReference: (reference: ChatMarkdownContextReference) => ReactNode;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasVisibleBody = props.text.trim().length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody
            text={props.text}
            renderContextReference={props.renderContextReference}
            skills={props.skills}
            markdownCwd={props.markdownCwd}
          />
        </div>
      ) : null}
      {canCollapse || props.footer ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2",
            canCollapse && props.footer ? "justify-between" : "justify-end",
          )}
          data-user-message-footer="true"
        >
          {canCollapse ? (
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  renderContextReference?: (reference: ChatMarkdownContextReference) => ReactNode;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  if (props.text.length === 0) {
    return null;
  }
  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.markdownCwd}
      threadRef={ctx.threadRef ?? undefined}
      skills={props.skills}
      className="text-message-foreground"
      lineBreaks
      parseRawHtml={false}
      renderContextReference={props.renderContextReference}
      headingLevelOffset={MESSAGE_HEADING_LEVEL}
    />
  );
});

function UserMessageReviewCommentCard({ comment }: { comment: ReviewCommentContext }) {
  const ctx = use(TimelineRowCtx);
  const fenceLanguage = comment.fenceLanguage ?? "diff";
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
  );

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="text-message-foreground text-xs font-medium">
          {formatWorkspaceRelativePath(comment.filePath, ctx.workspaceRoot)}
        </div>
        <div className="text-secondary-label text-2xs">
          {comment.sectionTitle} · {comment.rangeLabel}
        </div>
      </div>
      {comment.text.length > 0 && (
        <div className="whitespace-pre-wrap wrap-break-word text-sm">
          <SkillInlineText text={comment.text} skills={ctx.skills} />
        </div>
      )}
      {fenceLanguage !== "diff" && comment.diff.trim().length > 0 && (
        <ChatMarkdown
          text={formatReviewCommentFence(fenceLanguage, comment.diff)}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={ctx.skills}
          className="text-message-foreground"
        />
      )}
      {renderablePatch?.kind === "files" && (
        <DiffWorkerPoolProvider>
          {renderablePatch.files.map((fileDiff) => (
            <FileDiff
              key={resolveFileDiffPath(fileDiff)}
              fileDiff={fileDiff}
              options={{
                collapsed: false,
                diffStyle: "unified",
                theme: resolveDiffThemeName(ctx.resolvedTheme),
                preferredHighlighter: PREFERRED_HIGHLIGHTER,
              }}
            />
          ))}
        </DiffWorkerPoolProvider>
      )}
      {renderablePatch?.kind === "raw" && (
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
          {renderablePatch.text}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[], identity: string): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });
  const prevIdentity = useRef(identity);

  return useMemo(() => {
    const previous =
      prevIdentity.current === identity
        ? prevState.current
        : { byId: new Map<string, MessagesTimelineRow>(), result: [] };
    prevIdentity.current = identity;
    const nextState = computeStableMessagesTimelineRows(rows, previous);
    prevState.current = nextState;
    return nextState.result;
  }, [identity, rows]);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  return formatDuration(elapsedSeconds * 1_000);
}

function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}

type WorkEntryIconName =
  | "bot"
  | "brain"
  | "browser"
  | "check"
  | "circle-alert"
  | "computer"
  | "device"
  | "eye"
  | "globe"
  | "hammer"
  | "message-circle"
  | "search"
  | "square-pen"
  | "terminal"
  | "pull-request"
  | "scient-mono"
  | "scient"
  | "wrench"
  | "x"
  | "zap";

function ToolActivityIconView(props: {
  icon: ToolActivityIcon | undefined;
  fallbackName: WorkEntryIconName;
  className: string;
  muted: boolean;
}) {
  const { resolvedTheme } = use(TimelineRowCtx);
  const fallbackClassName = cn(props.className, props.muted && "opacity-70 light:brightness-50");
  if (!props.icon) {
    return <WorkEntryIcon name={props.fallbackName} className={fallbackClassName} />;
  }
  if (props.icon._tag === "website") {
    // SCIENT-FORK:START — only local icon bytes (`data:`, the app's own assets); a web
    // favicon would tell the site when this conversation was opened.
    const faviconSrc = toolActivityFaviconUrl(props.icon, resolvedTheme, 32);
    const src = faviconSrc !== null && remoteImageAddress(faviconSrc) === null ? faviconSrc : null;
    // SCIENT-FORK:END
    return src ? (
      <ToolActivityImageIcon
        key={src}
        cacheKey={src}
        src={src}
        fallbackName={props.fallbackName}
        className={props.className}
        muted={props.muted}
      />
    ) : (
      <WorkEntryIcon name={props.fallbackName} className={fallbackClassName} />
    );
  }
  if (props.icon._tag === "themed-logo") {
    const src =
      resolvedTheme === "dark"
        ? (props.icon.logoUrlDark ?? props.icon.logoUrl)
        : props.icon.logoUrl;
    return (
      <ToolActivityImageIcon
        key={src}
        cacheKey={src}
        src={src}
        fallbackName={props.fallbackName}
        className={props.className}
        muted={props.muted}
      />
    );
  }
  return (
    <NativeAppToolActivityIcon
      app={props.icon.app}
      fallbackName={props.fallbackName}
      className={props.className}
      muted={props.muted}
    />
  );
}

function NativeAppToolActivityIcon(props: {
  app: Extract<ToolActivityIcon, { readonly _tag: "native-app" }>["app"];
  fallbackName: WorkEntryIconName;
  className: string;
  muted: boolean;
}) {
  const { activeThreadEnvironmentId } = use(TimelineRowCtx);
  const asset = useAssetUrlState(activeThreadEnvironmentId, {
    _tag: "native-app-icon",
    app: props.app,
  });
  if (asset._tag !== "Success") {
    return (
      <WorkEntryIcon
        name={props.fallbackName}
        className={cn(props.className, props.muted && "opacity-70 light:brightness-50")}
      />
    );
  }
  const cacheKey = getProjectFaviconCacheKey(
    activeThreadEnvironmentId,
    JSON.stringify(props.app),
    asset.url,
  );
  return (
    <ToolActivityImageIcon
      key={cacheKey}
      cacheKey={cacheKey}
      src={asset.url}
      fallbackName={props.fallbackName}
      className={props.className}
      muted={props.muted}
    />
  );
}

const loadedToolActivityIconSrcs = new Map<string, string>();

function ToolActivityImageIcon(props: {
  cacheKey: string;
  src: string;
  fallbackName: WorkEntryIconName;
  className: string;
  muted: boolean;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(
    () => loadedToolActivityIconSrcs.get(props.cacheKey) ?? null,
  );
  const isLoading = displayedSrc !== props.src;
  const handleLoadError = (failedSrc: string) => {
    if (loadedToolActivityIconSrcs.get(props.cacheKey) === failedSrc) {
      loadedToolActivityIconSrcs.delete(props.cacheKey);
    }
    setDisplayedSrc((currentSrc) => (currentSrc === failedSrc ? null : currentSrc));
  };
  return (
    <>
      {displayedSrc === null ? (
        <WorkEntryIcon
          name={props.fallbackName}
          className={cn(props.className, props.muted && "opacity-70 light:brightness-50")}
        />
      ) : null}
      {displayedSrc ? (
        <span
          className={cn(
            props.className,
            "inline-block overflow-hidden rounded-xs bg-background",
            props.muted && "opacity-70",
          )}
        >
          <img
            src={displayedSrc}
            alt=""
            aria-hidden
            decoding="async"
            referrerPolicy="no-referrer"
            className={cn("block size-full object-contain", props.muted && "light:brightness-50")}
            onError={() => handleLoadError(displayedSrc)}
          />
        </span>
      ) : null}
      {isLoading ? (
        <img
          src={props.src}
          alt=""
          aria-hidden
          decoding="async"
          referrerPolicy="no-referrer"
          className="hidden"
          onLoad={() => {
            loadedToolActivityIconSrcs.set(props.cacheKey, props.src);
            setDisplayedSrc(props.src);
          }}
          onError={() => handleLoadError(props.src)}
        />
      ) : null}
    </>
  );
}

function WorkEntryIcon({ name, className }: { name: WorkEntryIconName; className: string }) {
  switch (name) {
    case "pull-request":
      return <PullRequestGlyph.pullRequest className={className} aria-hidden />;
    case "bot":
      return <BotIcon className={className} aria-hidden />;
    case "brain":
      return <BrainIcon className={className} aria-hidden />;
    case "browser":
      return <GlobeIcon className={className} aria-hidden />;
    case "computer":
      return <ComputerUseAppIcon className={className} />;
    case "device":
      return <SmartphoneIcon className={className} aria-hidden />;
    case "scient":
      return <ScientSymbol className={className} />;
    case "scient-mono":
      return <ScientSymbolMono className={className} />;
    case "check":
      return <CheckIcon className={className} aria-hidden />;
    case "circle-alert":
      return <CircleAlertIcon className={className} aria-hidden />;
    case "eye":
      return <EyeIcon className={className} aria-hidden />;
    case "globe":
      return <GlobeIcon className={className} aria-hidden />;
    case "hammer":
      return <HammerIcon className={className} aria-hidden />;
    case "message-circle":
      return <MessageCircleIcon className={className} aria-hidden />;
    case "search":
      return <SearchIcon className={className} aria-hidden />;
    case "square-pen":
      return <SquarePenIcon className={className} aria-hidden />;
    case "terminal":
      return <TerminalIcon className={className} aria-hidden />;
    case "wrench":
      return <WrenchIcon className={className} aria-hidden />;
    case "x":
      return <XIcon className={className} aria-hidden />;
    case "zap":
      return <ZapIcon className={className} aria-hidden />;
  }
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  iconName: WorkEntryIconName;
  className: string;
} {
  if (tone === "error") {
    return {
      iconName: "circle-alert",
      className: "text-foreground",
    };
  }
  if (tone === "thinking") {
    return {
      iconName: "brain",
      className: "text-trace-icon",
    };
  }
  if (tone === "info") {
    return {
      iconName: "check",
      className: "text-trace-icon",
    };
  }
  return {
    iconName: "zap",
    className: "text-foreground",
  };
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function buildToolCallExpandedBody(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
  visibleLabel: string,
  viewedImagePath: string | null,
): string | null {
  const blocks: string[] = [];
  const seen = new Set<string>([visibleLabel.trim()]);
  const addBlock = (value: string | null | undefined) => {
    const text = value?.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    blocks.push(text);
  };
  if (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) {
    addBlock(`MCP call\n${JSON.stringify(workEntry.toolData, null, 2)}`);
  }
  const command = workEntry.command?.trim();
  const raw = workEntryRawCommand(workEntry);
  if (command === visibleLabel.trim()) {
    seen.add(command);
  } else {
    addBlock(raw ?? command);
  }
  const detail = workEntry.detail?.trim();
  if (detail !== viewedImagePath?.trim()) {
    addBlock(detail);
  }
  const viewedImagePaths = new Set(
    viewedImagePath
      ? [viewedImagePath.trim(), formatWorkspaceRelativePath(viewedImagePath, workspaceRoot)]
      : [],
  );
  const changedFiles = (workEntry.changedFiles ?? []).flatMap((filePath) => {
    const formattedPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
    return viewedImagePaths.has(filePath) ||
      viewedImagePaths.has(formattedPath) ||
      filePath.trim() === detail ||
      formattedPath === detail
      ? []
      : [formattedPath];
  });
  if (changedFiles.length > 0) {
    addBlock([...new Set(changedFiles)].join("\n"));
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

const toolCallExpandedBodyClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-2xs leading-relaxed select-text";

function workEntryIconName(workEntry: TimelineWorkEntry): WorkEntryIconName {
  if (
    workEntry.questionAnswer ||
    workEntry.sourceActivityKind === "user-input.requested" ||
    workEntry.sourceActivityKind === "user-input.resolved"
  ) {
    return "message-circle";
  }
  if (workEntry.toolSurface) return workEntry.toolSurface;
  const toolPresentation = resolveWorkEntryToolPresentation(workEntry);
  if (toolPresentation) return toolPresentation.icon;
  const action = toolGroupAction(workEntry);
  if (action !== "other") return toolGroupSummaryIconName(action);

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return "wrench";
    case "dynamic_tool_call":
      return "scient-mono";
    case "collab_agent_tool_call":
      return "bot";
  }

  // Subagent lifecycle rows (grouped by taskId) get agent identity chrome.
  if (workEntry.taskId) {
    return "bot";
  }

  return workToneIcon(workEntry.tone).iconName;
}

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * Click handler for expanded row labels, which turn text selection back on.
 * Only a click that ends a real selection is withheld from the row toggle, so
 * an ordinary click on the label still bubbles and collapses the row it opened.
 */
const stopRowToggleWhileSelectingText = (e: MouseEvent<HTMLElement>) => {
  const selection = e.currentTarget.ownerDocument.getSelection();
  if (selection && !selection.isCollapsed) {
    e.stopPropagation();
  }
};

/** One tool row per batch, with member results available on expansion. */
const AgentSpawnRow = memo(function AgentSpawnRow(props: {
  workEntry: TimelineWorkEntry;
  active?: boolean | undefined;
  onToggleEntry?: ((collapsed: boolean) => void) | undefined;
}) {
  const { workEntry } = props;
  const { agentPanelModel, expandedSpawnEntryIds, onToggleSpawnRow, onOpenAgents } =
    use(TimelineRowCtx);
  const spawn = workEntry.agentSpawn;
  if (!spawn) {
    return null;
  }
  const expanded = expandedSpawnEntryIds.has(workEntry.id);

  const memberIds = new Set(spawn.agentTaskIds);
  const workflowGroup = spawn.workflowId
    ? agentPanelModel.workflows.find((group) => group.workflow.id === spawn.workflowId)
    : undefined;
  const agents = workflowGroup
    ? [...workflowGroup.phases.flatMap((phase) => phase.members), ...workflowGroup.unphasedMembers]
    : agentPanelModel.directAgents.filter((agent) => memberIds.has(agent.id));
  const agentCount = Math.max(
    agents.length,
    Math.max(memberIds.size - (spawn.workflowId ? 1 : 0), 0),
  );
  const summary = deriveAgentSpawnSummary({
    agents,
    agentCount,
    coordinatorStatus: workflowGroup?.workflow.status,
  });
  const { live } = summary;
  const failed = summary.tone === "failed";
  const workflowName =
    workflowGroup?.workflow.workflowName ?? workflowGroup?.workflow.title ?? null;
  const label = agentSpawnRowLabel(summary, workflowName);
  // The longest-running agent still at work: a quiet row keeps counting.
  const workingSince = agents
    .filter((agent) => isActiveSubagentStatus(agent.status) && agent.startedAt !== null)
    .map((agent) => agent.startedAt!)
    .toSorted()[0];
  const toggleExpanded = () => {
    props.onToggleEntry?.(expanded);
    onToggleSpawnRow(workEntry.id, !expanded);
  };

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={toggleExpanded}
        className="flex cursor-pointer select-none rounded-md text-left transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <LiveActivityRow
          label={
            live && workingSince ? (
              <span className="flex min-w-0">
                <span className="min-w-0 truncate">{label}</span>
                <span className="shrink-0 whitespace-pre tabular-nums">
                  {" · "}
                  <WorkingTimer createdAt={workingSince} />
                </span>
              </span>
            ) : (
              label
            )
          }
          iconName="bot"
          active={live && props.active !== false}
          failed={failed}
        />
      </button>
      {expanded ? (
        <div className="ms-7 mt-0.5 flex flex-col">
          {agents.map((agent) => (
            <AgentSpawnMemberRow key={agent.id} agent={agent} onToggleEntry={props.onToggleEntry} />
          ))}
          <button
            type="button"
            onClick={onOpenAgents}
            className="mt-1 self-start rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Open Agents panel ›
          </button>
        </div>
      ) : null}
    </div>
  );
});

const AGENT_MEMBER_STATUS_LABEL: Record<RuntimeSubagent["status"], string> = {
  pending: "Working",
  running: "Working",
  waiting: "Working",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

function AgentSpawnMemberRow({
  agent,
  onToggleEntry,
}: {
  agent: RuntimeSubagent;
  onToggleEntry?: ((collapsed: boolean) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const activeStatus = isActiveSubagentStatus(agent.status);
  const activity = activeStatus
    ? (agent.progress ?? (agent.lastToolName ? `▸ ${agent.lastToolName}` : null))
    : (agent.error ?? agent.result ?? agent.progress ?? null);
  const durationMs =
    agent.startedAt && agent.completedAt
      ? Date.parse(agent.completedAt) - Date.parse(agent.startedAt)
      : null;
  const meta = [
    durationMs !== null && durationMs >= 0 ? formatDuration(durationMs) : null,
    agent.usage && agent.usage.totalTokens > 0
      ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // Settled members show their metrics; anything other than success keeps
  // the status word so the outcome remains explicit.
  const statusLabel =
    activeStatus || !meta
      ? AGENT_MEMBER_STATUS_LABEL[agent.status]
      : agent.status === "completed"
        ? meta
        : `${AGENT_MEMBER_STATUS_LABEL[agent.status]} · ${meta}`;
  const role =
    agent.role && agent.role.trim().toLowerCase() !== agent.title.trim().toLowerCase()
      ? agent.role
      : null;
  const firstLine = activity?.split("\n").find((line) => line.trim().length > 0) ?? null;
  const body = [activity?.trim() || null, formatSubagentModelLabel(agent.model, agent.effort)]
    .filter(Boolean)
    .join("\n\n");
  const canExpand = body.length > 0;
  const toggleOpen = () => {
    onToggleEntry?.(open);
    setOpen((value) => !value);
  };

  return (
    <div
      role={canExpand ? "button" : undefined}
      tabIndex={canExpand ? 0 : undefined}
      aria-label={canExpand ? `${agent.title}, ${statusLabel}` : undefined}
      aria-expanded={canExpand ? open : undefined}
      onClick={canExpand ? toggleOpen : undefined}
      onKeyDown={
        canExpand
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleOpen();
              }
            }
          : undefined
      }
      className={cn(
        "flex flex-col rounded-md px-1 py-1 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
    >
      <div className="flex select-none items-center gap-1.5">
        <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm leading-relaxed">
          <span
            className={cn(
              "min-w-0 truncate",
              agent.status === "failed" ? failedToolIconClassName : "text-foreground/80",
            )}
          >
            {agent.title}
          </span>
          {role ? (
            <span className="scient-reading-micro max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-muted-foreground">
              {role}
            </span>
          ) : null}
        </p>
        <span className="scient-reading-compact shrink-0 font-mono tabular-nums text-muted-foreground">
          {activeStatus && agent.startedAt ? (
            <>
              {`${statusLabel} · `}
              <WorkingTimer createdAt={agent.startedAt} />
            </>
          ) : (
            statusLabel
          )}
        </span>
      </div>
      {!open && firstLine ? (
        <p className="truncate text-xs text-muted-foreground">{firstLine}</p>
      ) : null}
      {open ? (
        <div
          className="mt-1 cursor-default rounded-md bg-muted/40 px-3 py-2"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <pre className={toolCallExpandedBodyClassName}>{body}</pre>
        </div>
      ) : null}
    </div>
  );
}

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  isExpandedToolGroupEntry: boolean;
  displayLabel?: string | undefined;
  onToggleEntry?: ((collapsed: boolean) => void) | undefined;
}) {
  const { workEntry, workspaceRoot, isExpandedToolGroupEntry, displayLabel } = props;
  // Before any hooks: spawn rows render their own component.
  if (workEntry.agentSpawn) {
    return (
      <AgentSpawnRow
        workEntry={workEntry}
        active={!isExpandedToolGroupEntry}
        onToggleEntry={props.onToggleEntry}
      />
    );
  }
  return (
    <PlainWorkEntryRow
      workEntry={workEntry}
      workspaceRoot={workspaceRoot}
      isExpandedToolGroupEntry={isExpandedToolGroupEntry}
      displayLabel={displayLabel}
      onToggleEntry={props.onToggleEntry}
    />
  );
});

const PlainWorkEntryRow = memo(function PlainWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  isExpandedToolGroupEntry: boolean;
  displayLabel?: string | undefined;
  onToggleEntry?: ((collapsed: boolean) => void) | undefined;
}) {
  const { workEntry, workspaceRoot, isExpandedToolGroupEntry, displayLabel } = props;
  const { threadRef, onImageExpand, timestampFormat } = use(TimelineRowCtx);
  const groupView = use(WorkGroupViewCtx);
  const [expanded, setExpanded] = useState(
    () => groupView?.state.expandedEntries.has(workEntry.id) ?? false,
  );
  const toggleExpanded = () => {
    const next = !expanded;
    if (groupView) {
      groupView.onToggleEntry(!next);
      if (next) groupView.state.expandedEntries.add(workEntry.id);
      else groupView.state.expandedEntries.delete(workEntry.id);
    } else {
      props.onToggleEntry?.(!next);
    }
    setExpanded(next);
  };
  const iconConfig = workToneIcon(workEntry.tone);
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const showFailedIndicator = workEntryDisplayIndicatesToolFailure(workEntry);
  const showDestructiveRowStyle = showFailedIndicator && workEntrySignalsSevereFailure(workEntry);
  const entryIconName =
    showWarningIndicator || showDestructiveRowStyle ? "circle-alert" : workEntryIconName(workEntry);
  const entryToolIcon =
    showWarningIndicator || showDestructiveRowStyle
      ? undefined
      : (workEntry.toolIcon ?? workEntry.toolSource?.icon);
  // The question is the row's identity: a generic "User input submitted"
  // label buries what was asked, so lead with the question text and keep the
  // answer as the trailing preview.
  const questionHeading = workEntry.questionAnswer
    ? getQuestionTextPreview(workEntry.questionAnswer)
    : "";
  const previewText =
    displayLabel ?? (questionHeading || workEntryDisplayLabel(workEntry, workspaceRoot));
  const answerPreview =
    workEntry.questionAnswer && hasQuestionAnswer(workEntry.questionAnswer)
      ? getQuestionAnswerPreview(workEntry.questionAnswer)
      : null;
  const viewedImagePath = workEntryViewedImagePath(workEntry);
  const viewedImage =
    viewedImagePath && threadRef
      ? resolveViewedImageAsset(viewedImagePath, {
          threadId: threadRef.threadId,
          workspaceRoot,
        })
      : null;
  const canExpand =
    Boolean(workEntry.questionAnswer) ||
    (showFailedIndicator && previewText.trim().length > 0) ||
    (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) ||
    Boolean(
      workEntryRawCommand(workEntry) ||
      workEntry.command?.trim() ||
      workEntry.detail?.trim() ||
      workEntry.externalUrl ||
      workEntry.changedFiles?.length ||
      viewedImage,
    );
  const expandedBody = expanded
    ? buildToolCallExpandedBody(
        workEntry,
        workspaceRoot,
        previewText,
        viewedImage ? viewedImagePath : null,
      )
    : null;
  // Reserve destructive row styling for severe failures, not routine tool errors.
  const iconWrapperClass = cn(
    "flex size-6 shrink-0 items-center justify-center",
    showWarningIndicator
      ? "text-warning"
      : showDestructiveRowStyle
        ? "text-destructive"
        : showFailedIndicator
          ? failedToolIconClassName
          : workEntry.tone === "tool"
            ? "text-trace-icon"
            : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : workLogEntryIsToolLike(workEntry)
        ? "text-trace-label"
        : "text-secondary-label";
  const accessiblePreview = [previewText, answerPreview].filter(Boolean).join(": ");
  const failureLabel = activityIssuePolicy(workEntry.sourceActivityKind)
    ? "Operation failed"
    : "Tool call failed";
  const accessibleDisplayText = showFailedIndicator
    ? `${accessiblePreview}, ${failureLabel.toLowerCase()}`
    : accessiblePreview;
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": accessibleDisplayText,
        "aria-expanded": expanded,
        onClick: toggleExpanded,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleExpanded();
          }
        },
      }
    : {};

  return (
    <div
      className={cn(
        "group/timeline-row relative flex flex-col rounded-md px-0.5 transition-colors",
        isExpandedToolGroupEntry ? "py-0.5" : "py-1",
        expanded && "mb-1",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
      {...rowToggleProps}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span
          className={iconWrapperClass}
          role={showFailedIndicator ? "img" : undefined}
          aria-label={showFailedIndicator ? failureLabel : undefined}
        >
          <ToolActivityIconView
            icon={entryToolIcon}
            fallbackName={entryIconName}
            className="block size-4 shrink-0 stroke-2"
            muted
          />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed">
              <span
                className={cn(
                  answerPreview ? "min-w-0" : "min-w-0 flex-1",
                  expanded ? "whitespace-pre-wrap break-words select-text" : "truncate",
                  headingClass,
                )}
                onClick={expanded ? stopRowToggleWhileSelectingText : undefined}
                onPointerDown={expanded ? stopRowToggle : undefined}
              >
                {previewText}
              </span>
              {answerPreview ? (
                <span
                  className={cn(
                    "min-w-0 truncate",
                    !expanded &&
                      workEntry.questionAnswer &&
                      hasQuestionAnswer(workEntry.questionAnswer)
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {answerPreview}
                </span>
              ) : null}
            </p>
          </div>
          {showFailedIndicator &&
          !showDestructiveRowStyle &&
          !toolIconAcceptsTint(entryIconName, entryToolIcon) ? (
            <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
          ) : null}
          <TimelineRowTimestamp createdAt={workEntry.createdAt} timestampFormat={timestampFormat} />
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center",
              !canExpand && "invisible",
            )}
            aria-hidden
          >
            <ChevronRightIcon
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-90",
              )}
            />
          </span>
        </div>
      </div>
      {expanded && viewedImage && threadRef ? (
        <div
          className="mt-1 ms-7 cursor-default"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <ChatMarkdownAssetImage
            environmentId={threadRef.environmentId}
            resource={viewedImage.resource}
            alt={viewedImage.alt}
            srcFragment={viewedImage.srcFragment}
            workspaceRoot={workspaceRoot}
            maxHeightRem={16}
            onImageExpand={onImageExpand}
          />
        </div>
      ) : null}
      {expanded && workEntry.questionAnswer ? (
        <QuestionAnswerHistory answer={workEntry.questionAnswer} />
      ) : null}
      {expanded && workEntry.externalUrl ? (
        <div className="mt-1 ms-7 cursor-default" onClick={stopRowToggle}>
          <a
            className="text-sm text-primary underline underline-offset-2"
            href={workEntry.externalUrl.href}
            target="_blank"
            rel="noreferrer"
            onClick={stopRowToggle}
          >
            Open in browser
          </a>
        </div>
      ) : null}
      {expanded && canExpand && expandedBody && !workEntry.questionAnswer ? (
        <div
          className="mt-1 ms-7 cursor-default rounded-md bg-muted/40 px-3 py-2"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre>
        </div>
      ) : null}
    </div>
  );
});

function QuestionAnswerHistory({
  answer,
}: {
  answer: import("@t3tools/contracts").UserInputAttachmentAnswerPayload;
}) {
  const { activeThreadEnvironmentId } = use(TimelineRowCtx);
  const attachments = useMemo(() => Object.values(answer.attachmentsByQuestionId).flat(), [answer]);
  const resources = useMemo(
    () =>
      attachments.map((attachment) => ({
        _tag: "attachment" as const,
        attachmentId: attachment.id,
      })),
    [attachments],
  );
  const urls = useAssetUrls(activeThreadEnvironmentId, resources);
  return (
    <div className="ms-7 mt-2 space-y-2" onClick={stopRowToggle}>
      {[
        ...new Set([
          ...Object.keys(answer.questionTextById ?? {}),
          ...Object.keys(answer.answers),
          ...Object.keys(answer.attachmentsByQuestionId),
        ]),
      ].map((questionId) => (
        <div key={questionId} className="space-y-1">
          {answer.questionTextById?.[questionId] ? (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {answer.questionTextById[questionId]}
            </p>
          ) : null}
          {getQuestionAnswerText(answer.answers[questionId]) ? (
            <p className="ms-3 whitespace-pre-wrap text-sm text-muted-foreground">
              {getQuestionAnswerText(answer.answers[questionId])}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {(answer.attachmentsByQuestionId[questionId] ?? []).map((attachment) => {
              const url = urls[attachments.indexOf(attachment)];
              return (
                <a
                  key={attachment.id}
                  href={url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm underline"
                >
                  {attachment.type === "image" && url ? (
                    <img
                      src={url}
                      alt={attachment.name}
                      className="h-20 max-w-32 rounded object-contain"
                    />
                  ) : (
                    attachment.name
                  )}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
