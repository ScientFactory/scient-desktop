// SCIENT-FORK:START — Scient Accounts: mount approvals above the composer.
import {
  ThreadAccountApprovals,
  ThreadAccountHandoffs,
  useThreadAccountHandoffs,
} from "~/scient/accounts/AccountApprovals";
// SCIENT-FORK:END
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { readThreadProjection } from "../state/entities";
import { deriveTimelineEntriesFromVisibleTurnItemsWithState } from "../session-logic";
import { Button } from "./ui/button";
import { ChevronDownIcon } from "lucide-react";
import { useIncrementalTimelineEntries } from "../hooks/useIncrementalTimelineEntries";
import { previewEnvironment } from "../state/preview";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import * as DateTime from "effect/DateTime";
import { latestTurnUnfinished } from "./chat/readerScrollPolicy";
import { ThreadAnswerAcknowledgement } from "../scient/answerAttention/ThreadAnswerAcknowledgement";
import {
  beginQueueEdit,
  stashRecoveredDraft,
  loadQueueEdits,
  useQueueEditSessions,
  stashProvenanceDraft,
} from "../scient/threadQueue/editSession";
import { nativeQueueEditItem } from "../scient/threadQueue/nativeQueueEditItem";
import { composerTargetKey } from "../composerDraftStore";
import {
  useChatMarkdownSurfaceGuards,
  useChatSurfaceDepartureGuards,
} from "~/scient/fileSurfaces/useChatSurfaceSaveGuards";
import { hasCommittedConversationMessages } from "./chat/composerModelPickerFork";
import { useConversationImportBanner } from "./chat/scient-import/ConversationImportBanner";
import { useFileCitationTarget } from "~/scient/markdownEditor/fileCitationNavigation";
import { readTimelinePosition } from "./chat/timelineScrollAnchoring";
import { useDraftHeroMotion } from "./chat/timelineEntranceMotion";
import { isOnlySendBusy, deriveTimelineWorking } from "./chat/timelineWorkingState";
import {
  ScientChatForkDialog,
  useChatViewForkCommand,
  useClearForkCommandOnThreadChange,
  createForkConversationCommand,
  useForkLanding,
  useForkLandingReveal,
  createForkMessageCommands,
  useForkPdfContinuityPending,
  deriveForkTimelineBaseline,
} from "~/scient/fork/chatViewFork";
import type { ReadingHistoryPage } from "./chat/readerScrolling";
import { useProjectScriptAutoPreview } from "./preview/useProjectScriptAutoPreview";
import { AgentsPanel } from "./AgentsPanel";
import {
  useFilePresentationRequestHandlers,
  useScientRightPanelOpeners,
} from "~/scient/rightPanel/useScientRightPanelOpeners";
import { ScientRightPanelContent } from "~/scient/rightPanel/ScientRightPanelContent";
import { type OptimisticUserMessage } from "~/scient/threadQueue/optimisticQueuePresentation";
import { useLegacyQueueRecoveryError } from "~/scient/threadQueue/useLegacyQueueRecoveryError";
import { ContentDirectionScope } from "../scient/bidi/ContentDirectionScope";
import {
  ScientRevertDialogDiagnostics,
  findFileHistoryIssue,
} from "../scient/chat/ScientRevertDialogDiagnostics";
import { scientFilePanelProps } from "../scient/fileSurfaces/scientFilePanelProps";
import { deriveAgentPanelModel } from "../scient/chat/useAgentPanelModel";
import { ThreadOpenRecorder } from "../scient/chat/ThreadOpenRecorder";
import { tokenLimitBannerItems, deriveTokenLimitNotice } from "../scient/chat/tokenLimitNotice";
import { resolveStaleDraftDefaultModelSelection } from "../lib/chatThreadActions";

import { type EditQueuedRunRequest } from "./chat/QueuedRunsControl";
import { resolveThreadWorkspaceRoot } from "./ChatView.logic";
import { useStopGeneration } from "../scient/chat/useStopGeneration";
import { useEffectiveActiveProviderSkills } from "../scient/skills/useEffectiveActiveProviderSkills";
import {
  useCloseComputeOwnedSurfaces,
  useComputeSessionCommands,
} from "~/scient/compute/useComputeOwnedSurfaces";
import {
  ScientComputeFigureFollower,
  getOpenStaticArtifacts,
} from "~/scient/compute/chatComputeFigureFollower";

import { ThreadFind, ThreadFindCanvas } from "./chat/ThreadFindProvider";
import { THREAD_FIND_BAR_RESERVED_HEIGHT } from "./chat/ThreadFindBar";
import { usageLimitRecoveryBannerItem } from "./chat/UsageLimitRecoveryBanner";
import { resolveDraftHeroState } from "./ChatView.logic";

import { queuedRunEditBlockedReason } from "@t3tools/client-runtime/queued-run-edit";
import { WorkspaceFileDropOverlay } from "./chat/TimelineOverlays";
import { usePasteToFocusComposer } from "./chat/usePasteToFocusComposer";
import { announcedRun, isDetailBehindShell } from "./chat/threadActivityAnnouncement";
import {
  deriveThreadPendingBackgroundTasks,
  deriveWorkspaceMutationId,
  presentThreadShellFromProjection,
} from "./ChatView.logic";
import { usePullRequestDraftThread } from "./chat/usePullRequestDraftThread";
import { useComposerSelection } from "./chat/useComposerSelection";
import { useProjectCloneBanner } from "./chat/useProjectCloneBanner";
import { useAttachmentPreviewHandoff } from "./chat/useAttachmentPreviewHandoff";
import {
  applyOptimisticUserMessagesAction,
  createOptimisticBlobPreviews,
  emptyOptimisticUserMessages,
  reconcileOptimisticUserMessages,
} from "./chat/optimisticUserMessages";
import { useTimelineRewind } from "./chat/useTimelineRewind";
import { useThreadLifecycle } from "./chat/useThreadLifecycle";
import { useRightPanelActions } from "./chat/useRightPanelActions";
import { type TerminalLaunchContext, useChatTerminalActions } from "./chat/useChatTerminalActions";
import { useComposerSend } from "./chat/useComposerSend";
import { useComposerResume } from "./chat/useComposerResume";
import { useImplementPlanInNewThread } from "./chat/useProposedPlanSend";
import { closeThreadFind, openThreadFind, useThreadFindOpen } from "./chat/threadFindStore";
import {
  deriveAvailableRevertTurnCounts,
  recallCheckoutIsRepo,
  rememberCheckoutIsRepo,
} from "./ChatView.logic";
import { useLogicalProjectEnvironments } from "../hooks/useLogicalProjectEnvironments";
import { useStableCallback } from "../hooks/useStableCallback";
import { useProjectScriptEditing } from "./chat/useProjectScriptEditing";
import { RightPanelSurfaceContent } from "./chat/RightPanelSurfaceContent";
import { usePendingThreadRequests } from "./chat/usePendingThreadRequests";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import type { UsageLimitSourceSnapshots } from "@t3tools/contracts";
import { feedbackBannerItem } from "./chat/ComposerFeedback";
import { useUsageLimitsPanel } from "./chat/useUsageLimitsPanel";
import { useWorktreeSetup } from "./chat/useWorktreeSetup";
import { useChatShortcuts } from "./chat/useChatShortcuts";
import { ChatBannerLane } from "./chat/ChatBannerLane";
import * as Schema from "effect/Schema";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  type AssistantCitation,
  type ChatFileAttachment,
  isProviderNativeSubagentThread,
  type EnvironmentId,
  MessageId,
  type ModelSelection,
  type PreviewAnnotationPayload,
  ProviderInstanceId,
  type ServerProvider,
  type ScopedThreadRef,
  type ThreadId,
  ProviderInteractionMode,
  resolveIdleCompaction,
  RuntimeMode,
} from "@t3tools/contracts";

import {
  deriveProviderSubagentStatus,
  deriveReportedModelSelection,
  formatModelSelectionEffort,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveLatestThreadRun,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import {
  resolveWorkflowOpening,
  workflowOpeningParentThreadId,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  getUserQueuedThreadRuns,
  threadSupportsProviderHandoff,
} from "@t3tools/client-runtime/state/thread-workflows";
import { resolvePendingHandoff } from "@t3tools/client-runtime/handoff";
import { HandoffRow } from "./chat/V2LifecycleRow";
import {
  codexFeedbackMessage,
  isCompleteTurnItemRow,
  shouldShowLoadEarlierControl,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import { projectScriptCwd, resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveThreadReferenceCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { useAtomValue } from "@effect/atom-react";
import { type SetStateAction, use, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BackgroundThreadContext } from "./chat/backgroundThread";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { assistantCitationFromLocation } from "../lib/assistantCitationNavigation";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { useStore } from "zustand";
import { shallow } from "zustand/vanilla/shallow";
import { useShallow } from "zustand/react/shallow";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { isElectron } from "../env";
import { useDiffPanelStore } from "../diffPanelStore";
import { useActiveThreadRef } from "../hooks/useActiveThreadRef";
import { composerRequiresModifier } from "../composer-logic";
import {
  derivePhase,
  deriveActiveWorkStartedAt,
  deriveCanInterruptRunningThread,
  findLatestProposedPlan,
  findRevertCheckpoint,
  hasActionableProposedPlan,
  isLatestRunSettled,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import { useWorkspaceMutationRefresh } from "../hooks/useWorkspaceMutationRefresh";
import { DEFAULT_INTERACTION_MODE, type ChatMessage } from "../types";
import { buildThreadRouteParams } from "../threadRoutes";
import { useTheme } from "../hooks/useTheme";
import { copyThreadReference } from "../lib/copyThreadReference";
import { subscribeSnapShotComposerFocus } from "../lib/desktopSnapShot";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { FileMetadataThreadProvider } from "../hooks/FileMetadataThreadProvider";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { PopoverCreateHandle } from "./ui/popover";
import {
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadPanelOpen,
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import { isPreviewSupportedInRuntime, useThreadPreviewState } from "../previewStateStore";

import { previewRuntimeTabId } from "../browser/previewRuntimeTabId";
// SCIENT-FORK:START
import { useBrowserHistoryProjectLink } from "~/scient/browser/useBrowserHistoryProjectLink";
import { renameInTabHistory, useRightPanelTabHistory } from "~/scient/rightPanel/tabHistory";
import { PanelFilesLayout } from "~/scient/rightPanel/PanelFilesColumn";
import { usePanelTabShortcuts } from "~/scient/rightPanel/usePanelTabShortcuts";
// SCIENT-FORK:END
import {
  ThreadPreviewMiniPlayer,
  useThreadPreviewCanvasSource,
} from "./preview/ThreadPreviewMiniPlayer";
import { createChatCanvasStore, resolveChatCanvasModel } from "./chat/canvasStore";
import { usePreviewSession } from "./preview/usePreviewSession";
import { getConfiguredPreviewUrls } from "./preview/previewEmptyStateLogic";

import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../previewMiniPlayerStore";
import { threadPullRequestPanelTarget } from "./pullRequest/pullRequestDetail.logic";
import { LinkPullRequestDialogHost } from "./pullRequest/LinkPullRequestDialog";
import { GuestPendingMessages } from "./chat/GuestShareControls";
import { useDeviceState } from "~/state/device";
import { BranchToolbar, type BranchToolbarHandle } from "./BranchToolbar";
import { ComposerContextPermissions } from "./ComposerContextPermissions";
import { resolveCompatibleRuntimeMode } from "./chat/runtimeModeConfig";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import { isEditableFocused } from "../lib/editableFocus";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { shortcutLabelForCommand } from "../keybindings";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { toastManager } from "./ui/toast";
import { projectScriptIdFromCommand } from "~/projectScripts";
import { newMessageId } from "~/lib/utils";
import {
  NO_PROVIDER_MODEL_SELECTION,
  providerInstanceEntriesFor,
  shouldShowInstanceBadge,
} from "../providerInstances";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentSettings,
} from "../hooks/useSettings";
import { useNowMinute } from "../hooks/useNowMinute";
import { usePanelAnimationSettings, usePanelPresence } from "../panelAnimations";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useOpenPanelPullRequestUrl } from "../hooks/useOpenPanelPullRequestUrl";
import { isPreviewFocused } from "../lib/previewFocus";
import { focusTerminalOnThreadEnter, getTerminalFocusOwner } from "../lib/terminalFocus";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  isSameSidebarThreadRef,
  useSidebarPendingFileDropStore,
} from "../sidebarPendingFileDropStore";
import {
  composerDraftHasUserContent,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  DraftId,
} from "../composerDraftStore";
import { type TerminalContextDraft } from "../lib/terminalContext";
import { collectInlineContextIds } from "../lib/composerContextReferences";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useKnownTerminalSessions, useThreadRunningTerminalIds } from "../state/terminalSessions";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "~/state/session";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  serverEnvironment,
} from "../state/server";
import { threadEnvironment, useThreadFamily } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import {
  type EnvironmentPresentation,
  useEnvironment,
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironment,
} from "../state/environments";
import {
  resolveThreadDetailRef,
  useEnvironmentSupportsServerBrowser,
  useProject,
  useQuietThreadProjection,
  useThreadUpdatedAt,
  useThreadLastVisitedAt,
  useQuietThreadVisibleTurnItems,
  useThreadStatus,
  useThreadHistory,
  useQuietThreadShell,
  useThreadCheckpointSummaries,
} from "../state/entities";
import { useEnvironmentShellHasSnapshot } from "../state/shell";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";
import { ExpandedImageDialogHost, openExpandedImagePreview } from "./chat/ExpandedImageDialog";
import {
  BranchRestoreConfirmHost,
  DeviceSetupDialogHost,
  openBranchRestoreConfirm,
  PullRequestThreadDialogHost,
} from "./chat/ChatOverlayHosts";
import type { AssistantCitationRequest } from "./chat/AssistantCitationSource";
import { useCitedHistory } from "./chat/citationProcedure";
import type { MessagesTimelineHistoryControls } from "./chat/MessagesTimeline";
import { ThreadTimeline } from "./chat/ThreadTimeline";
import { ProviderSubagentBar } from "./chat/ProviderSubagentBar";
import { getTriggerDisplayModelName } from "./chat/providerIconUtils";
import { resolveScrollToEndClearance } from "./composerFooterLayout";
import { ChatHeader } from "./chat/ChatHeader";
import { useRemoteOpenState } from "~/remoteOpen";
import { shouldShowOpenInPicker } from "./chat/OpenInPicker.logic";
import { useOpenFavoriteEditorShortcut } from "./chat/OpenInPickerShortcut";
import {
  PanelLayoutControls,
  type PanelLayoutControlsProps,
  RightPanelMaximizeControl,
  ThreadPanelHeaderControl,
  WorkspaceTitlebarControls,
} from "./chat/PanelLayoutControls";
import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { ThreadDetailsPanel } from "./chat/ThreadDetailsPanel";
import { NoActiveThreadState } from "./NoActiveThreadState";
import {
  resolveEffectiveEnvMode,
  resolveLocalCheckoutBranchMismatch,
  shouldShowComposerContextStrip,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";
import {
  getProviderStatusBannerKey,
  shouldShowProviderStatusBanner,
} from "./chat/ProviderStatusBanner";
import {
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
} from "./chat/ThreadErrorBanner";
import { QueuedRunsControl, type QueuedRunsControlHandle } from "./chat/QueuedRunsControl";
import { useThreadLinkedPullRequest } from "./pullRequest/useThreadLinkedPullRequest";
import { useProactivePanels } from "../hooks/useProactivePanels";

import { useRightPanelSurfaceClose } from "../hooks/useRightPanelSurfaceClose";
import type { ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import { ComposerSurface } from "./chat/ComposerSurface";
import { resolveThreadSyncPhase } from "../threadSync";
import {
  hasAvailableCompactionProvider,
  hasDismissedResumeCompaction,
  shouldOfferResumeCompaction,
} from "./chat/ContextWindowMeter.logic";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "../lib/contextWindow";
import {
  MOBILE_COMPOSER_VIEW_TRANSITION_NAME,
  MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
} from "./chat/draftHeroTransition";
import {
  buildLocalDraftThread,
  deriveCommittedServerUserMessageIds,
  dismissBranchMismatchForSession,
  shouldShowPlanFollowUpPrompt,
  shouldRenderPreviewMiniPlayer,
  deriveLockedProvider,
  resolveFileAttachmentUrl,
  resolveComposerInteractionMode,
  resolveComposerProviderSelection,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  startNewThreadForProject,
  codexArtifactTemplatePromptToAppend,
  shouldRefocusComposerOnWindowFocus,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerHandleContext } from "../composerHandleContext";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { assetEnvironment } from "../state/assets";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { observeResize } from "~/lib/observeResize";

import { ChatTerminalDrawers } from "./chat/ChatTerminalDrawers";
import { ChatRightPanel } from "./chat/ChatRightPanel";
import { useDraftEnvironmentRouting } from "./chat/useDraftEnvironmentRouting";
import { branchMismatchBannerItem } from "./chat/ThreadActivityBanners";
import { ThreadNow } from "./chat/ThreadNow";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { useDelayedStatus } from "../hooks/useDelayedStatus";
import { useTimelineFollow } from "./chat/useTimelineFollow";
import {
  type EnvironmentUnavailableState,
  useSystemComposerBanners,
} from "./chat/useSystemComposerBanners";
import { useDraftHeroLayoutTransition } from "./chat/useDraftHeroLayoutTransition";
import { useLocalDispatchState } from "./chat/useLocalDispatchState";
import { draftFanoutSelectionsAtom, draftSendState } from "./chat/chatViewSend";
import {
  chatActionErrorMessage,
  isCompactCommandMessage,
  type LocalThreadErrorEntry,
  makeThreadErrorSetter,
} from "./ChatView.logic";

const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_MODELS: ServerProvider["models"] = [];
const EMPTY_USAGE_LIMIT_SOURCES: UsageLimitSourceSnapshots = [];
import type { CodexArtifactTemplate } from "@t3tools/shared/codexArtifactTemplates";

const EMPTY_FEEDBACK_SUBMISSIONS: ReadonlyArray<CodexFeedbackSubmission> = [];
const EMPTY_TURN_ITEMS: ThreadStructure["turnItems"] = [];
const EMPTY_AUTO_UPDATE_ENVIRONMENTS: ReadonlyArray<EnvironmentPresentation> = [];

const EMPTY_PENDING_FILE_SURFACE_IDS: ReadonlySet<string> = new Set();

type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      routeKind: "draft";
      draftId: DraftId;
    };

function ChatViewContent(props: ChatViewProps) {
  const {
    environmentId,
    threadId,
    routeKind,
    onDiffPanelOpen,
    reserveTitleBarControlInset = true,
    forceExpandedMobileComposer = false,
  } = props;
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const draftId = routeKind === "draft" ? props.draftId : null;
  const handleNewThread = useNewThreadHandler();
  const routeThreadRef = scopeThreadRef(environmentId, threadId);
  const routeThreadKey = scopedThreadKey(routeThreadRef);
  const currentRouteThreadKeyRef = useRef<string | null>(routeThreadKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed route thread key to a ref that async handlers check before applying results
  useLayoutEffect(() => {
    currentRouteThreadKeyRef.current = routeThreadKey;
    return () => {
      currentRouteThreadKeyRef.current = null;
    };
  }, [routeThreadKey]);
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const setThreadRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const interruptThreadTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const loadEarlierThreadHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  // SCIENT-FORK:START — compute session commands used when compute-owned tabs close.
  const computeSessionCommands = useComputeSessionCommands();
  // SCIENT-FORK:END
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const baseComposerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadRef : props.draftId;
  // SCIENT-FORK:START — queued edits live in Scient edit sessions (scient/threadQueue/editSession);
  // the composer keeps the thread's own draft target throughout.
  const queueEditsReady = useQueueEditSessions((state) => state.ready);
  const queueEditStorageError = useQueueEditSessions((state) =>
    state.error &&
    (state.error.targetKey === null ||
      state.error.targetKey === composerTargetKey(baseComposerDraftTarget))
      ? state.error.message
      : null,
  );
  const queueEdit = useQueueEditSessions(
    (state) => state.sessions[composerTargetKey(baseComposerDraftTarget)],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads persisted queued-edit sessions from local storage once on mount
  useEffect(() => {
    void loadQueueEdits();
  }, []);
  const composerDraftTarget = baseComposerDraftTarget;
  // SCIENT-FORK:END
  const draftThread = useComposerDraftStore((store) =>
    routeKind === "server"
      ? store.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  );
  const serverThreadShell = useQuietThreadShell(routeThreadRef);
  const routeThreadDetailRef = resolveThreadDetailRef(routeThreadRef, {
    shellExists: serverThreadShell !== null,
    waitForShell: draftThread !== null,
  });
  const serverThreadProjection = useQuietThreadProjection(routeThreadDetailRef);
  const serverProjection = serverThreadProjection?.projection ?? null;
  // Subagent rows, an open child's own row and its ancestors come from the family when the shell
  // leaves idle children out. Every source agrees on the root, so the key never flips.
  useThreadFamily(
    routeKind === "server" ? environmentId : null,
    serverThreadShell?.lineage.rootThreadId ??
      serverProjection?.thread.lineage.rootThreadId ??
      null,
  );
  // Only the shell-less fallback needs these; with a shell, the shell carries them.
  const fallbackDetailRef = serverThreadShell === null ? routeThreadDetailRef : null;
  const fallbackUpdatedAt = useThreadUpdatedAt(fallbackDetailRef);
  const fallbackLastVisitedAt = useThreadLastVisitedAt(fallbackDetailRef);
  const serverThread =
    serverThreadShell !== null || serverProjection === null || fallbackUpdatedAt === null
      ? serverThreadShell
      : presentThreadShellFromProjection(environmentId, threadId, serverProjection, {
          updatedAt: fallbackUpdatedAt,
          lastVisitedAt: fallbackLastVisitedAt,
        });
  const promptRef = useRef("");
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const reportedModelSelection = serverProjection
    ? deriveReportedModelSelection(serverProjection)
    : null;
  const threadStatus = useThreadStatus(routeThreadDetailRef);
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverProjection !== null,
    shellExists: serverThread !== null,
    status: threadStatus,
  });
  const threadDetailLoading = threadSyncPhase === "loading";
  // Held back briefly, so a quick sync does not flash a status line at the end of the timeline.
  const delayedThreadSyncPhase = useDelayedStatus(routeThreadKey, threadSyncPhase);
  const activeProviderThread = serverProjection?.providerThreads.find(
    (thread) => thread.id === serverProjection.thread.activeProviderThreadId,
  );
  const activeThreadLiveTokenUsage = latestProviderTurnTokenUsage(
    serverProjection?.providerTurns ?? [],
    serverProjection,
    activeProviderThread,
  );
  const serverVisibleTurnItems = useQuietThreadVisibleTurnItems(routeThreadDetailRef);
  const serverThreadHistory = useThreadHistory(routeThreadDetailRef);
  const threadHistoryControls = (() => {
    if (routeThreadDetailRef === null || !shouldShowLoadEarlierControl(serverThreadHistory)) {
      return undefined;
    }
    return {
      hasMoreHistory: serverThreadHistory.hasMoreHistory,
      loading: serverThreadHistory.loading,
      error: serverThreadHistory.error,
      onLoadEarlier: (throughEntryId) => {
        void loadEarlierThreadHistory({
          environmentId: routeThreadDetailRef.environmentId,
          input: {
            threadId: routeThreadDetailRef.threadId,
            ...(throughEntryId === undefined ? {} : { throughEntryId }),
          },
        });
      },
    };
  })() as MessagesTimelineHistoryControls | undefined;
  // SCIENT-FORK:START — older pages for the reading-position restore.
  const loadEarlierTurns = ((): ReadingHistoryPage | null => {
    if (routeThreadDetailRef === null || !shouldShowLoadEarlierControl(serverThreadHistory)) {
      return null;
    }
    return {
      loading: serverThreadHistory.loading,
      cursor: serverThreadHistory.historyCursor,
      onLoadEarlier: () => {
        void loadEarlierThreadHistory({
          environmentId: routeThreadDetailRef.environmentId,
          input: { threadId: routeThreadDetailRef.threadId },
        });
      },
    };
  })();
  // SCIENT-FORK:END
  const committedServerMessageIds = deriveCommittedServerUserMessageIds(serverVisibleTurnItems);
  // Queued messages have no turn item until starting, so cancellation must retire their optimistic rows
  // separately.
  const serverAcknowledgedUserMessageIds = (() => {
    const ids = new Set(committedServerMessageIds);
    for (const message of serverProjection?.messages ?? []) {
      if (message.role === "user") ids.add(message.id);
    }
    return ids;
  })();
  const settings = useEnvironmentSettings(environmentId);
  const clientSettingsHydrated = useClientSettingsHydrated();
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  // Selects primitives: an object here is new on every router store update, which
  // re-renders ChatView on unrelated navigation state changes.
  const citationHref = useLocation({ select: (location) => location.href });
  // SCIENT-FORK:START — a file citation activation re-keys the request too.
  const citationKey = useLocation({
    select: (location) =>
      location.state.fileCitationActivation ??
      location.state.assistantCitationActivation ??
      location.state.__TSR_key,
  });
  // SCIENT-FORK:END
  const citationLocation = { href: citationHref, key: citationKey };
  const citationRequest = (() => {
    const citation = assistantCitationFromLocation(citationLocation.href);
    return citation && citation.environmentId === environmentId && citation.threadId === threadId
      ? { citation, key: citationLocation.key ?? citationLocation.href }
      : null;
  })() as AssistantCitationRequest | null;
  const citationHistory = useCitedHistory(citationRequest);
  const { resolvedTheme } = useTheme();
  const composerExtractedIntent = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.extractedIntent,
  );
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const composerSelectedModelSelection = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return draft?.activeProvider
      ? (draft.modelSelectionByProvider[draft.activeProvider] ?? null)
      : null;
  });
  const composerHasAttachments = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return (draft?.images.length ?? 0) > 0 || (draft?.files.length ?? 0) > 0;
  });
  const referencedThreadContexts = useComposerDraftStore(
    useShallow((store) => {
      const draft = store.getComposerDraft(composerDraftTarget);
      if (!draft?.threadContexts.length) return [];
      // Linked prompts can replace text without pruning stored context records.
      const referenced = new Set(collectInlineContextIds(draft.prompt));
      return draft.threadContexts.filter((record) => referenced.has(record.contextId));
    }),
  );
  const composerHasNonPromptContent = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return draft ? composerDraftHasUserContent({ ...draft, prompt: "" }) : false;
  });
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const composerHasDraftContent = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return draft ? composerDraftHasUserContent(draft) : false;
  });
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const branchToolbarRef = useRef<BranchToolbarHandle>(null);
  const citeAssistantText = (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => {
    const inserted = composerRef.current?.citeAssistantText(citation, sourceAnchor) ?? false;
    if (!inserted) {
      toastManager.add({
        type: "warning",
        title: "The composer is not ready",
        description: "Try citing the selection after the connection or pending input is resolved.",
      });
    }
    return inserted;
  };
  const citeAssistantTextStable = useStableCallback(citeAssistantText);
  const [isWorkspaceFileDragActive, setIsWorkspaceFileDragActive] = useState(false);
  const [optimisticBlobPreviews] = useState(createOptimisticBlobPreviews);
  const [heldOptimisticUserMessages, setHeldOptimisticUserMessages] = useState(() =>
    emptyOptimisticUserMessages(threadId),
  );
  // Acknowledged messages leave the timeline in the same render the server's copy enters it.
  const optimisticState = reconcileOptimisticUserMessages(
    heldOptimisticUserMessages,
    threadId,
    serverAcknowledgedUserMessageIds,
  );
  if (optimisticState !== heldOptimisticUserMessages) {
    // Idempotent, and a discarded render only delays revocation to the thread's end.
    optimisticBlobPreviews.handOff(optimisticState);
    setHeldOptimisticUserMessages(optimisticState);
  }
  // SCIENT-FORK: queue-admission previews ride along on the optimistic messages.
  const optimisticUserMessages: OptimisticUserMessage[] = optimisticState.messages;
  const setOptimisticUserMessages = (action: SetStateAction<ChatMessage[]>) =>
    setHeldOptimisticUserMessages((state) =>
      applyOptimisticUserMessagesAction(state, threadId, action),
    );
  // Draft ids survive promotion and expire on navigation, keeping the pending resend scoped correctly.
  const [workLocallyResendDraftId, setWorkLocallyResendDraftId] = useState<DraftId | null>(null);
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const feedbackSubmissions =
    feedbackSubmissionsByThreadKey[routeThreadKey] ?? EMPTY_FEEDBACK_SUBMISSIONS;
  const feedbackUploading = feedbackSubmissions.some(
    (submission) => submission.status === "uploading",
  );
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [localServerErrorsByThreadKey, setLocalServerErrorsByThreadKey] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const isRevertingCheckpoint = useComposerDraftStore((store) =>
    store.rewindingThreadKeys.has(routeThreadKey),
  );

  const workspaceFileDragRouteKey = `${routeThreadKey}:${draftId ?? ""}`;
  const [workspaceFileDragRoute, setWorkspaceFileDragRoute] = useState(workspaceFileDragRouteKey);
  if (workspaceFileDragRoute !== workspaceFileDragRouteKey) {
    setWorkspaceFileDragRoute(workspaceFileDragRouteKey);
    setIsWorkspaceFileDragActive(false);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window dragend listener that clears the workspace file drag state
  useEffect(() => {
    if (!isWorkspaceFileDragActive) return;
    const clearWorkspaceFileDrag = () => setIsWorkspaceFileDragActive(false);
    window.addEventListener("dragend", clearWorkspaceFileDrag);
    return () => window.removeEventListener("dragend", clearWorkspaceFileDrag);
  }, [isWorkspaceFileDragActive]);
  const prefersPlanSidebarSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const isMobileViewport = useMediaQuery("max-sm");
  const [workspaceLayoutElement, setWorkspaceLayoutElement] = useState<HTMLDivElement | null>(null);
  const threadPanelPopoverAnchorRef = useRef<HTMLElement | null>(null);
  const [terminalUiLaunchContext, setTerminalUiLaunchContext] =
    useState<TerminalLaunchContext | null>(null);
  // Overrides chosen before a server thread's first turn; they belong to that thread only.
  const [pendingServerThreadEnvModeEntry, setPendingServerThreadEnvModeEntry] = useState<{
    readonly threadId: ThreadId;
    readonly mode: DraftThreadEnvMode;
  } | null>(null);
  const [pendingServerThreadBranchEntry, setPendingServerThreadBranchEntry] = useState<{
    readonly threadId: ThreadId;
    readonly branch: string | null;
  } | null>(null);
  const [
    pendingServerThreadStartFromOriginByThreadId,
    setPendingServerThreadStartFromOriginByThreadId,
  ] = useState<Record<string, boolean>>({});
  const legendListRef = useRef<LegendListRef | null>(null);
  const conversationArea = workspaceAreaProps("conversation", 1, "Conversation");
  const composerArea = workspaceAreaProps("composer", 2, "Message input");
  const [composerOverlayElement, setComposerOverlayElement] = useState<HTMLDivElement | null>(null);
  const [composerTimelineInset, setComposerTimelineInset] = useState(0);
  const composerTimelineInsetRef = useRef(0);
  const [composerReservedHeight, setComposerReservedHeight] = useState(0);
  const composerReservedHeightRef = useRef(0);
  const composerExpandedHeightRef = useRef(0);
  const [scrollToEndClearance, setScrollToEndClearance] = useState(0);
  const fanoutSelectionsAtom = draftFanoutSelectionsAtom(routeThreadKey);
  const { sendInFlight: sendInFlightRef } = draftSendState(routeThreadKey);
  const multipleModelSelections = useAtomValue(fanoutSelectionsAtom);
  const setMultipleModelSelections = (
    selections: SetStateAction<ReadonlyArray<ModelSelection> | null>,
  ) => {
    appAtomRegistry.update(fanoutSelectionsAtom, (current) =>
      typeof selections === "function" ? selections(current) : selections,
    );
  };
  const setMultipleModelSelectionsStable = useStableCallback(setMultipleModelSelections);
  const feedbackUploadsInFlightRef = useRef(new Set<string>());

  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef),
  );

  const fallbackDraftProjectRef = draftThread?.projectId
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useProject(fallbackDraftProjectRef);
  const localDraftError = serverThread
    ? null
    : ((draftId ? localDraftErrorsByDraftId[draftId]?.message : null) ?? null);
  const localServerError = localServerErrorsByThreadKey[routeThreadKey]?.message ?? null;

  const promotedDraftError =
    serverThread && draftId ? localDraftErrorsByDraftId[draftId] : undefined;
  if (promotedDraftError !== undefined && draftId) {
    const remainingDraftErrors = { ...localDraftErrorsByDraftId };
    delete remainingDraftErrors[draftId];
    setLocalDraftErrorsByDraftId(remainingDraftErrors);
    const currentEntry = localServerErrorsByThreadKey[routeThreadKey];
    if (
      currentEntry === undefined ||
      (currentEntry.at <= promotedDraftError.at &&
        currentEntry.message !== promotedDraftError.message)
    ) {
      setLocalServerErrorsByThreadKey({
        ...localServerErrorsByThreadKey,
        [routeThreadKey]: promotedDraftError,
      });
    }
  }
  const localDraftThread = draftThread
    ? buildLocalDraftThread(
        threadId,
        draftThread,
        resolveProjectSettings(
          settings,
          fallbackDraftProject?.id ?? null,
          fallbackDraftProject ?? undefined,
        ).settings.defaultModelSelection ?? NO_PROVIDER_MODEL_SELECTION,
      )
    : undefined;
  // Promotion is data-driven: the draft route keeps rendering while the
  // server thread (same pre-allocated ref) starts, so live state must not
  // depend on which route is mounted.
  // The quiet projection above also supplies the shell-less archived-route fallback.
  const activeServerThread = serverThread;
  const isServerThread = activeServerThread !== null;
  const activeThread = activeServerThread ?? localDraftThread;
  // SCIENT-FORK:START — Scient Accounts: sign-ins waiting for the user scroll with the conversation.
  const accountHandoffs = useThreadAccountHandoffs(
    activeThread?.environmentId ?? null,
    activeThread?.id ?? null,
  );
  // SCIENT-FORK:END
  const serverLatestRun =
    serverProjection === null ? null : deriveLatestThreadRun(serverProjection);
  const serverActivityRun =
    serverProjection === null ? null : deriveThreadActivityRun(serverProjection);
  const serverRuntime =
    serverProjection === null ? null : deriveThreadStructureRuntime(serverProjection);
  const runlessWorkStartedAt =
    serverProjection === null ? null : deriveRunlessWorkStartedAt(serverProjection);
  const providerSubagentStatus =
    serverProjection === null ? null : deriveProviderSubagentStatus(serverProjection);
  const isProviderSubagent =
    activeServerThread !== null && isProviderNativeSubagentThread(activeServerThread.source);
  const supportsProviderSwitchingViaHandoff = threadSupportsProviderHandoff(serverProjection);
  // SCIENT-FORK:START — an archived route's detail stands in for its missing shell.
  const activeLatestRun = serverLatestRun ?? activeThread?.latestRun ?? null;
  const activeActivityRun = serverActivityRun ?? activeThread?.latestRun ?? null;
  const activeRuntime = serverRuntime ?? activeThread?.runtime ?? null;
  // SCIENT-FORK:END
  const activeRunningTurnId = activeRuntime?.activeRunId ?? null;
  const hasHeldQueuedRuns =
    isServerThread &&
    serverProjection?.runs.some((run) => run.status === "queued" && run.queueHeld === true) ===
      true;
  // A run the user can pick back up: an interrupted turn, or one that failed
  // because the provider's usage limit was hit.
  const resumableRunId = (() => {
    if (!isServerThread || serverProjection === null) return null;
    const run = latestExecutedRun(serverProjection.runs);
    if (run?.status === "interrupted") return run.id;
    return run?.status === "failed" &&
      serverRuntime?.lastErrorClass === "usage_limit" &&
      latestRootProviderFailure(run, serverProjection.turnItems)?.class === "usage_limit"
      ? run.id
      : null;
  })();
  const parentSubagentThreadId =
    activeThread?.lineage.relationshipToParent === "subagent"
      ? activeThread.lineage.parentThreadId
      : null;
  const parentSubagentEnvironmentId = activeThread?.environmentId ?? null;
  const parentSubagentThreadRef = (() => {
    if (parentSubagentEnvironmentId === null || parentSubagentThreadId === null) {
      return null;
    }
    return scopeThreadRef(parentSubagentEnvironmentId, parentSubagentThreadId);
  })();
  const parentSubagentThread = useQuietThreadShell(parentSubagentThreadRef);
  // Workflow threads open with a script; their replacement plan lives on the parent's coordinator row.
  const workflowOpeningParentId =
    serverProjection === null
      ? null
      : workflowOpeningParentThreadId({
          thread: serverProjection.thread,
          messages: serverProjection.messages,
        });
  const workflowOpeningParentProjection = useQuietThreadProjection(
    workflowOpeningParentId === null || parentSubagentEnvironmentId === null
      ? null
      : scopeThreadRef(parentSubagentEnvironmentId, workflowOpeningParentId),
  );
  const workflowOpening =
    serverProjection === null || workflowOpeningParentId === null
      ? null
      : resolveWorkflowOpening({
          thread: serverProjection.thread,
          messages: serverProjection.messages,
          parentSubagents: workflowOpeningParentProjection?.projection.subagents ?? null,
        });
  // A linked environment's agent may have delegated this thread from there.
  const delegatedFrom = activeThread?.delegatedFrom ?? null;
  const delegatedFromEnvironment = useEnvironment(delegatedFrom?.environmentId ?? null);
  const delegatedFromRef =
    delegatedFrom === null
      ? null
      : scopeThreadRef(delegatedFrom.environmentId, delegatedFrom.threadId);
  // The title it had at delegation, until this client sees the parent itself.
  const delegatedFromThread = useQuietThreadShell(delegatedFromRef);
  const parentThreadLink = (() => {
    if (parentSubagentThreadRef !== null) {
      return {
        title: parentSubagentThread?.title ?? "Parent thread",
        open: (): void => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(parentSubagentThreadRef),
          });
        },
      };
    }
    if (delegatedFrom === null || delegatedFromRef === null) return null;
    const parentRef = delegatedFromRef;
    return {
      title: delegatedFromThread?.title ?? delegatedFrom.title,
      environmentLabel: delegatedFromEnvironment?.label ?? activeThread?.linkOrigin?.label ?? "",
      // Only an environment this client is connected to can open the parent.
      ...(delegatedFromEnvironment === null
        ? {}
        : {
            open: (): void => {
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(parentRef),
              });
            },
          }),
    };
  })();
  // The header's breadcrumb opens a parent in this environment only.
  const headerParentThreadLink =
    parentSubagentThreadRef === null
      ? null
      : {
          threadId: parentSubagentThreadRef.threadId,
          title: parentSubagentThread?.title ?? "Parent thread",
        };
  const hasProjectWorkspace = activeThread?.projectId != null;
  // SCIENT-FORK:START — fork dialog target, preview and command state.
  const forkCommand = useChatViewForkCommand({
    activeThread,
    navigate,
    serverConfigs: new Map(
      environments.flatMap((environment) =>
        environment.serverConfig
          ? [[environment.environmentId, environment.serverConfig] as const]
          : [],
      ),
    ),
  });
  const { isForkingThread, setForkCommandTarget } = forkCommand;
  // SCIENT-FORK:END
  const threadError = isServerThread
    ? (localServerError ?? serverRuntime?.lastError ?? null)
    : localDraftError;
  // SCIENT-FORK:START — the banner key includes the run, so a new run's error shows again.
  const threadErrorBannerKey = getThreadErrorBannerKey(
    routeThreadKey,
    threadError,
    activeLatestRun?.runId,
  );
  // SCIENT-FORK:END
  const visibleThreadError = shouldShowThreadErrorBanner(
    routeThreadKey,
    threadError,
    isThreadErrorBannerDismissedForSession(threadErrorBannerKey),
  )
    ? threadError
    : null;
  // SCIENT-FORK:START — a token-limit stop shows a composer notice, not the error banner.
  const { isTokenLimitError, tokenLimitNoticeKey, hasTokenLimitNotice } = deriveTokenLimitNotice({
    routeThreadKey,
    visibleThreadError,
    threadErrorBannerKey,
    turnItems: serverProjection?.turnItems,
    latestRunId: activeLatestRun?.runId,
    runtimeStatus: activeRuntime?.status,
  });
  // SCIENT-FORK:END
  const [, setThreadErrorBannerDismissTick] = useState(0);
  const threadErrorIsServerRuntimeError =
    localServerError === null && visibleThreadError === serverRuntime?.lastError;
  const defaultRuntimeMode = resolveProjectSettings(settings, activeThread?.projectId ?? null)
    .settings.defaultRuntimeMode;
  const runtimeMode =
    composerRuntimeMode ??
    (isServerThread ? activeThread?.runtimeMode : undefined) ??
    defaultRuntimeMode;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = canWriteSourceControl && isLocalDraftThread;
  const activeThreadId = activeThread?.id ?? null;
  // Turn items can lag projection hydration; keep the environment locked through that gap.
  const activeMessageCount = isServerThread
    ? Math.max(committedServerMessageIds.size, serverProjection?.messages.length ?? 0)
    : 0;
  const hasConversationMessages =
    isServerThread &&
    hasCommittedConversationMessages({
      messages: serverProjection?.messages ?? [],
      runs: serverProjection?.runs ?? [],
      items: serverVisibleTurnItems.map(({ item }) => item),
    });
  const activeThreadEnvironmentId = activeThread?.environmentId ?? null;
  // SCIENT-FORK:START — a fork target belongs to the thread it was opened on.
  useClearForkCommandOnThreadChange(
    setForkCommandTarget,
    activeThreadId,
    activeThreadEnvironmentId,
  );
  // SCIENT-FORK:END
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessionsRaw = useKnownTerminalSessions({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessions = (() => {
    if (activeThreadId === null || activeThreadKnownSessionsRaw === null) {
      return [];
    }
    return activeThreadKnownSessionsRaw.filter(
      (session) => session.target.threadId === activeThreadId,
    );
  })();
  const activeServerOrderedTerminalIds = activeThreadKnownSessions.map(
    (session) => session.target.terminalId,
  );
  const activeTerminalLabelsById = (() => {
    const labels = new Map<string, string>();
    for (const session of activeThreadKnownSessions) {
      labels.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return labels;
  })();
  const activeThreadRef = useActiveThreadRef(activeThread);
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const activeEnvironmentServerBrowser = useEnvironmentSupportsServerBrowser(
    activeThreadRef?.environmentId ?? null,
  );
  const browserAvailable = isPreviewSupportedInRuntime() || activeEnvironmentServerBrowser;
  const activeThreadShell = serverThread;
  const timelineThreadError =
    serverRuntime?.status === "failed" &&
    serverRuntime.lastErrorClass === "usage_limit" &&
    activeThreadShell?.latestRun &&
    visibleThreadError === serverRuntime.lastError
      ? null
      : visibleThreadError;

  // SCIENT-FORK:START — a saved reading position's anchor survives a reload or a thread switch.
  const [timelineAnchor, setTimelineAnchor] = useState<{
    readonly threadKey: string | null;
    readonly messageId: MessageId | null;
  }>({
    threadKey: activeThreadKey,
    messageId:
      (readTimelinePosition(routeThreadKey)?.anchorMessageId as MessageId | undefined) ?? null,
  });
  if (timelineAnchor.threadKey !== activeThreadKey) {
    setTimelineAnchor({
      threadKey: activeThreadKey,
      messageId:
        (readTimelinePosition(routeThreadKey)?.anchorMessageId as MessageId | undefined) ?? null,
    });
  }
  // SCIENT-FORK:END
  const timelineAnchorMessageId = timelineAnchor.messageId;
  // SCIENT-FORK:START — only reader actions or unused anchors release reserved room, never run settlement.
  // The reading end is unfinished-turn content or the latest answer; its last three lines may be hidden.
  // SCIENT-FORK:END
  const activeRightPanelKind = useRightPanelStore((state) =>
    selectActiveRightPanel(state.byThreadKey, activeThreadRef),
  );
  const diffOpen = activeRightPanelKind === "diff";
  const explicitDiffOpenRef = useRef<ScopedThreadRef | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets the diff panel store to branch scope when the diff opens without an explicit request
  useLayoutEffect(() => {
    const explicitThreadRef = explicitDiffOpenRef.current;
    explicitDiffOpenRef.current = null;
    if (diffOpen && activeThreadRef && explicitThreadRef !== activeThreadRef) {
      useDiffPanelStore.getState().selectGitScope(activeThreadRef, "branch");
    }
  }, [activeThreadRef, diffOpen]);
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadRef),
  );
  const shouldUsePlanSidebarSheet = prefersPlanSidebarSheet && rightPanelState.maximized !== true;
  const activeRightPanelSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, activeThreadRef),
  );
  const activePreviewState = useThreadPreviewState(activeThreadRef);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const activePreviewServerEpoch = activePreviewState.serverEpoch;
  const resolvePreviewRuntimeTabId = activeThreadRef
    ? (tabId: string) => previewRuntimeTabId(activeThreadRef, activePreviewServerEpoch, tabId)
    : undefined;
  const activePreviewMiniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, activeThreadRef),
  );
  // SCIENT-FORK:START — static figures open in the panel or the floating preview.
  const openStaticArtifacts = getOpenStaticArtifacts(
    rightPanelState.surfaces,
    activePreviewMiniPlayer,
  );
  // SCIENT-FORK:END
  const panelTerminalIds = new Set(
    rightPanelState.surfaces.flatMap((surface) =>
      surface.kind === "terminal" ? surface.terminalIds : [],
    ),
  );
  const canReuseTerminal = activeThreadKnownSessionsRaw !== null;
  const previewPanelOpen = activeRightPanelKind === "preview" && browserAvailable;
  const rightPanelOpen = rightPanelState.isOpen;
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const rightPanelPresenceValue = {
    activeSurface: activeRightPanelSurface,
    surfaces: rightPanelState.surfaces,
  };
  const rightPanelPresence = usePanelPresence(
    rightPanelOpen && activeThreadRef !== null,
    rightPanelPresenceValue,
    panelAnimationsActive,
    activeThreadKey,
    panelAnimationDurationMs,
  );
  const rightPanelPresent = rightPanelPresence.present;
  const rightPanelControlsInPanel =
    shouldUsePlanSidebarSheet && rightPanelPresent && rightPanelOpen;
  const rightPanelControlsAtRoot = rightPanelPresent && !shouldUsePlanSidebarSheet;
  const renderedRightPanelSurface = rightPanelPresence.value?.activeSurface ?? null;
  const renderedRightPanelSurfaces = rightPanelPresence.value?.surfaces ?? [];
  const previewMiniPlayerVisible =
    activePreviewMiniPlayer?.content.kind === "static-artifact"
      ? !(
          renderedRightPanelSurface?.kind === "scient" &&
          renderedRightPanelSurface.module === "artifact" &&
          renderedRightPanelSurface.artifact.surfaceId ===
            activePreviewMiniPlayer.content.artifact.surfaceId
        )
      : shouldRenderPreviewMiniPlayer(
          activePreviewMiniPlayer?.content ?? null,
          renderedRightPanelSurface,
        );
  const canMaximizeRightPanel = rightPanelOpen;
  const rightPanelMaximized = canMaximizeRightPanel && rightPanelState.maximized === true;
  const inlineRightPanelOwnsTitleBar = rightPanelOpen && !shouldUsePlanSidebarSheet;
  const [threadPanelPopoverHandle] = useState(PopoverCreateHandle);
  const [chatCanvasStore] = useState(createChatCanvasStore);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the preview mini-player store entry once its content opens in the right panel
  useEffect(() => {
    if (!activeThreadRef || !activePreviewMiniPlayer) return;
    const content = activePreviewMiniPlayer.content;
    if (content.kind === "device") return;
    const shouldClose =
      content.kind === "browser"
        ? previewPanelOpen &&
          activeRightPanelSurface?.kind === "preview" &&
          activeRightPanelSurface.resourceId === content.tabId
        : rightPanelOpen &&
          activeRightPanelSurface?.kind === "scient" &&
          activeRightPanelSurface.module === "artifact" &&
          activeRightPanelSurface.artifact.surfaceId === content.artifact.surfaceId;
    if (shouldClose) {
      usePreviewMiniPlayerStore.getState().close(activeThreadRef);
    }
  }, [
    activePreviewMiniPlayer,
    activeRightPanelSurface,
    activeThreadRef,
    previewPanelOpen,
    rightPanelOpen,
  ]);

  const latestRunSettled = isLatestRunSettled(activeLatestRun, activeRuntime);
  const activeThreadProjectId = activeThread?.projectId;
  // SCIENT-FORK:START — a thread without a project has no project ref.
  const activeProjectRef =
    activeThreadEnvironmentId !== null && activeThreadProjectId
      ? scopeProjectRef(activeThreadEnvironmentId, activeThreadProjectId)
      : null;
  // SCIENT-FORK:END
  const activeProject = useProject(activeProjectRef);
  const activeProjectSettings = resolveProjectSettings(
    settings,
    activeProject?.id ?? null,
    activeProject ?? undefined,
  );
  const activeProjectScripts = activeProject ? resolveProjectScripts(settings, activeProject) : [];
  const { projectCloneBannerItem, projectCloneSendBlockReason } =
    useProjectCloneBanner(activeProjectRef);
  const activeProjectDefaultModelSelection = activeProjectSettings.settings.defaultModelSelection;
  // An unpicked draft follows a default changed in Settings. ChatView
  // remounts on return, so this compares state rather than watching changes.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes a changed project default model into the composer draft store for an unpicked draft
  useEffect(() => {
    if (draftId === null || isServerThread) return;
    const nextSelection = resolveStaleDraftDefaultModelSelection(
      useComposerDraftStore.getState().getComposerDraft(draftId),
      activeProjectDefaultModelSelection,
    );
    if (nextSelection) {
      setComposerDraftModelSelection(draftId, nextSelection, { replaceOptions: true });
    }
  }, [activeProjectDefaultModelSelection, draftId, isServerThread, setComposerDraftModelSelection]);
  const handleNewThreadInActiveProject = () => {
    startNewThreadForProject(activeProjectRef, handleNewThread);
  };
  const handleNewThreadInActiveProjectStable = useStableCallback(handleNewThreadInActiveProject);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const activeDraftLogicalProjectKey =
    !isServerThread && activeProject
      ? deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings)
      : undefined;
  const handleOpenDraftProjectSettings = () => {
    if (!activeDraftLogicalProjectKey) return;
    void navigate({
      to: "/projects/$projectKey",
      params: { projectKey: activeDraftLogicalProjectKey },
    });
  };
  const handleOpenDraftProjectSettingsStable = useStableCallback(handleOpenDraftProjectSettings);
  const activeEnvironmentBootstrapComplete = useEnvironmentShellHasSnapshot(
    activeThread?.environmentId ?? null,
  );
  const activeWorkspaceKeyRoot = resolveThreadWorkspaceRoot({
    worktreePath: activeThread?.worktreePath,
    projectCwd: activeProject?.workspaceRoot,
  });
  const activeWorkspaceKey =
    activeThread && activeWorkspaceKeyRoot
      ? `${activeThread.environmentId}:${activeWorkspaceKeyRoot}`
      : null;
  const [pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const pendingFilesDuringCloseRef = useRef(pendingFileSurfaceIdsByProject);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors pending file surfaces into a ref read by the panel close handler
  useLayoutEffect(() => {
    pendingFilesDuringCloseRef.current = pendingFileSurfaceIdsByProject;
  }, [pendingFileSurfaceIdsByProject]);
  const genericPendingFileSurfaceIds = activeWorkspaceKey
    ? (pendingFileSurfaceIdsByProject.get(activeWorkspaceKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS)
    : EMPTY_PENDING_FILE_SURFACE_IDS;
  // SCIENT-FORK:START — Markdown save state for right-panel surfaces.
  const {
    handleMarkdownAttention,
    guards: {
      pendingSurfaceIds: pendingFileSurfaceIds,
      attentionSurfaceIds: markdownAttentionSurfaceIds,
      departureOptions: markdownDepartureOptions,
    },
  } = useChatMarkdownSurfaceGuards({
    activeThreadRef,
    environmentId: activeThread?.environmentId,
    cwd: activeWorkspaceKeyRoot,
    genericPendingIds: genericPendingFileSurfaceIds,
  });
  // SCIENT-FORK:END
  const handleFilePendingChange = (relativePath: string, pending: boolean) => {
    if (!activeWorkspaceKey) return;
    setPendingFileSurfaceIdsByProject((currentByProject) => {
      const current = currentByProject.get(activeWorkspaceKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS;
      const surfaceId = `file:${relativePath}`;
      if (current.has(surfaceId) === pending) return currentByProject;
      const next = new Set(current);
      if (pending) next.add(surfaceId);
      else next.delete(surfaceId);
      const nextByProject = new Map(currentByProject);
      if (next.size === 0) nextByProject.delete(activeWorkspaceKey);
      else nextByProject.set(activeWorkspaceKey, next);
      return nextByProject;
    });
  };
  const handleFilePendingChangeStable = useStableCallback(handleFilePendingChange);
  // SCIENT-FORK:START — leaving a surface, the thread or the app waits for pending saves.
  const {
    runAfterPendingSurfaceSave: runAfterSurfaceSave,
    runAfterPendingFileSave: runAfterFileSave,
  } = useChatSurfaceDepartureGuards({
    activeThreadRef,
    pendingFileSurfaceIds,
    markdownDepartureOptions,
    activeSurfaceId: activeRightPanelSurface?.id ?? null,
    environmentId: activeThread?.environmentId,
    cwd: activeWorkspaceKeyRoot,
    pendingFileSurfaceIdsByProject,
    handleMarkdownAttention,
  });
  const runAfterPendingSurfaceSave: typeof runAfterSurfaceSave = (ids, run) =>
    runAfterSurfaceSave(ids, () => {
      if (currentRouteThreadKeyRef.current === routeThreadKey) run();
    });
  const runAfterPendingFileSave: typeof runAfterFileSave = (id, run) =>
    runAfterFileSave(id, () => {
      if (currentRouteThreadKeyRef.current === routeThreadKey) run();
    });
  // SCIENT-FORK:END
  const openProjectScriptPreview = useProjectScriptAutoPreview({
    activeThreadRef,
    activeTabId: activePreviewState.activeTabId,
    sessions: activePreviewState.sessions,
    openPreview,
    canFocusPreview: () =>
      (activeWorkspaceKey === null ||
        (pendingFilesDuringCloseRef.current.get(activeWorkspaceKey)?.size ?? 0) === 0) &&
      (markdownDepartureOptions.getPendingSurfaceIds?.() ?? pendingFileSurfaceIds).size === 0,
  });
  const configuredPreviewUrls = getConfiguredPreviewUrls(activeProjectScripts);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops file surfaces from the right panel store once bootstrap shows the thread has no workspace
  useEffect(() => {
    if (!activeThreadRef || !activeEnvironmentBootstrapComplete) return;
    useRightPanelStore
      .getState()
      .reconcileFileSurfaces(activeThreadRef, activeWorkspaceKeyRoot !== undefined);
  }, [activeEnvironmentBootstrapComplete, activeThreadRef, activeWorkspaceKeyRoot]);

  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  // SCIENT-FORK:START — browser visits are filed under the thread's project again
  useBrowserHistoryProjectLink({
    threadRef: activeThreadRef,
    projectKey: activeProject
      ? deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings)
      : null,
    settingsHydrated: clientSettingsHydrated,
  });
  // SCIENT-FORK:END
  const activeEnvironment =
    activeThread == null ? null : (environmentById.get(activeThread.environmentId) ?? null);
  const activeEnvironmentUnavailable =
    activeEnvironment !== null && activeEnvironment.connection.phase !== "connected";
  const activeEnvironmentUnavailableLabel = activeEnvironment?.label ?? null;
  const activeEnvironmentUnavailableState = (() => {
    if (!activeEnvironmentUnavailable || !activeEnvironmentUnavailableLabel || !activeEnvironment) {
      return null;
    }

    return {
      environmentId: activeEnvironment.environmentId,
      label: activeEnvironmentUnavailableLabel,
      connection: activeEnvironment.connection,
    };
  })() as EnvironmentUnavailableState | null;
  const activeProjectIsScratch =
    activeProject !== null &&
    isScratchProject(
      activeProject,
      environmentById.get(activeProject.environmentId)?.serverConfig?.scratchWorkspaceRoot ?? null,
    );
  const logicalProjectEnvironments = useLogicalProjectEnvironments(
    activeProject,
    activeProjectIsScratch && draftId !== null,
  );
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;
  const canAutoBalanceEnvironments = hasMultipleEnvironments && !activeProjectIsScratch;
  const activeEnvironmentOption =
    logicalProjectEnvironments.find(
      (environment) => environment.environmentId === activeThread?.environmentId,
    ) ?? null;
  const showComposerEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: hasMultipleEnvironments,
  });

  const { handlePreparedPullRequestThreadStable, openPullRequestDialogStable } =
    usePullRequestDraftThread({
      routeKind,
      draftId,
      settings,
      projectGroupingSettings,
      activeProject,
      activeThreadKey,
      isServerThread,
      canCheckoutPullRequestIntoThread,
    });
  const serverConfig = activeThread
    ? (activeEnvironment?.serverConfig ?? null)
    : (primaryEnvironment?.serverConfig ?? null);
  const providerEnvironmentId = (activeThread ? activeEnvironment : primaryEnvironment)
    ?.environmentId;
  const providerStatuses =
    (providerEnvironmentId === undefined
      ? undefined
      : providersByEnvironment.get(providerEnvironmentId)) ?? EMPTY_PROVIDERS;
  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProjectDefaultModelSelection?.instanceId ??
    null;
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderByThreadId,
    threadProvider,
    providers: providerStatuses,
  });
  const modelPickerLockedProvider = supportsProviderSwitchingViaHandoff ? null : lockedProvider;
  const pullRequestsCapabilityKnown = serverConfig !== null;
  const supportsPullRequests = serverConfig !== null;
  const attachmentEnvironmentConfig = environmentById.get(environmentId)?.serverConfig ?? null;
  const attachmentUploadsCapabilityKnown = attachmentEnvironmentConfig !== null;
  const supportsQuestionAttachments = attachmentEnvironmentConfig !== null;
  const supportsAttachmentUploads = attachmentEnvironmentConfig !== null;
  const advertisedFileAttachmentBytes =
    attachmentEnvironmentConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
  const maxFileAttachmentBytes =
    advertisedFileAttachmentBytes === null
      ? null
      : clampFileAttachmentUploadBytes(advertisedFileAttachmentBytes);
  const envLocked = Boolean(activeThread && (activeMessageCount > 0 || activeRuntime !== null));
  // onEnvironmentChange only retargets an unsent draft. envLocked alone does not
  // rule out a started thread: one whose machine is offline never loads its
  // messages, so it would otherwise be offered a machine picker that does nothing.
  const canChangeEnvironment =
    hasMultipleEnvironments && !envLocked && draftId !== null && !draftThread?.promotedTo;

  const loadBalancingSettings = useClientSettings((settings) => ({
    loadBalancingEnabled: settings.loadBalancingEnabled,
    loadBalancingWeights: settings.loadBalancingWeights,
  }));
  const automaticEnvironment = Boolean(
    clientSettingsHydrated &&
    draftId &&
    !envLocked &&
    canAutoBalanceEnvironments &&
    loadBalancingSettings.loadBalancingEnabled &&
    draftThread?.environmentSelection !== "manual" &&
    (!composerHasAttachments || Boolean(draftThread?.loadBalancedEnvironmentId)) &&
    (!draftThread?.branch || draftThread.environmentSelection === "auto") &&
    !draftThread?.worktreePath,
  );
  const autoUpdateEnvironments = automaticEnvironment
    ? logicalProjectEnvironments.flatMap(({ environmentId }) => {
        const environment = environmentById.get(environmentId);
        return environment ? [environment] : [];
      })
    : EMPTY_AUTO_UPDATE_ENVIRONMENTS;
  const systemComposerBannerItems = useSystemComposerBanners({
    activeEnvironment,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableState,
    activeThreadEnvironmentId: activeThread?.environmentId ?? null,
    serverConfig,
    hasMultipleRegisteredEnvironments: environments.length > 1,
    automaticEnvironment,
    autoUpdateEnvironments,
  });
  const providerInstanceEntries = providerInstanceEntriesFor(
    providerStatuses,
    settings,
    activeProject?.id ?? null,
  );
  const activeThreadModelInstanceId = activeThread?.modelSelection.instanceId;
  const { selectedProviderEntry, requestedDriverKind } = resolveComposerProviderSelection({
    entries: providerInstanceEntries,
    candidateInstanceIds: [
      selectedProviderByThreadId,
      activeRuntime?.providerInstanceId,
      activeThreadModelInstanceId,
      activeProjectDefaultModelSelection?.instanceId,
    ],
    lockedProvider,
    lockedInstanceId: activeRuntime?.providerInstanceId ?? activeThreadModelInstanceId,
  });
  const selectedProvider = selectedProviderEntry?.driverKind ?? requestedDriverKind;
  const activeProviderInstanceId = selectedProviderEntry?.instanceId ?? null;
  const activeProviderStatus = selectedProviderEntry?.snapshot ?? null;
  const { enabled: interactionModeEnabled, interactionMode } = resolveComposerInteractionMode({
    planModeEnabled: settings.planModeEnabled,
    provider: activeProviderStatus,
    interactionMode:
      composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
  });
  const conversationProviderStatus =
    providerStatuses.find((status) => status.instanceId === activeRuntime?.providerInstanceId) ??
    activeProviderStatus;
  const supportsConversationRollback =
    canOperateThread &&
    conversationProviderStatus !== null &&
    conversationProviderStatus.supportsConversationRollback !== false;
  const phase = derivePhase(activeRuntime);
  // SCIENT-FORK:START — saved pre-native queue work that needs recovery says so in the queue.
  const legacyQueueRecoveryError = useLegacyQueueRecoveryError(
    isServerThread ? environmentId : null,
    isServerThread && activeThread ? activeThread.id : null,
  );
  const queueContextKeyRef = useRef(activeThreadKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the active thread key to a ref that async queue handlers check before applying results
  useLayoutEffect(() => {
    queueContextKeyRef.current = activeThreadKey;
  });
  // SCIENT-FORK:END
  const activeContextWindow = deriveLatestContextWindowSnapshot(
    serverVisibleTurnItems,
    activeThreadLiveTokenUsage,
    serverProjection?.providerThreads.find(
      (thread) => thread.id === serverProjection.thread.activeProviderThreadId,
    ),
  );
  const turnDiffSummaries = useThreadCheckpointSummaries(routeThreadDetailRef);
  /**
   * File tools are explicit; completed commands are included because a shell
   * command can mutate the workspace without reporting the paths it touched.
   */
  // SCIENT-FORK:START — a rewind failure stays in its dialog rather than the thread banner.
  const [pendingRevert, setPendingRevert] = useState<{
    turnCount: number;
    messageId: MessageId;
    routeThreadKey: string;
    error?: string;
  } | null>(null);
  // SCIENT-FORK:END
  // SCIENT-FORK:START — a checkpoint the server could not capture leaves a
  // diagnostics affordance in the revert dialog so a missing diff is
  // explainable rather than silent.
  const fileHistoryIssue = findFileHistoryIssue(turnDiffSummaries);
  // SCIENT-FORK:END
  // SCIENT-FORK:START — the agents panel model.
  const agentPanelModel = deriveAgentPanelModel(serverProjection);
  // SCIENT-FORK:END
  const serverThreadId = serverThread?.id;
  const serverThreadEnvironmentId = serverThread?.environmentId;
  const setThreadError = makeThreadErrorSetter({
    routeThreadRef,
    routeThreadKey,
    draftId,
    serverThreadRef:
      serverThreadId !== undefined && serverThreadEnvironmentId !== undefined
        ? { threadId: serverThreadId, environmentId: serverThreadEnvironmentId }
        : null,
    setLocalServerErrorsByThreadKey,
    setLocalDraftErrorsByDraftId,
  });
  const {
    pendingApprovals,
    pendingUserInputs,
    activePendingApproval,
    activePendingUserInput,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    respondingRequestIds,
    onRespondToApproval: onRespondToApprovalStable,
    onDismissUserInput: onDismissUserInputStable,
    onSelectActivePendingUserInputOption: onSelectActivePendingUserInputOptionStable,
    onChangeActivePendingUserInputCustomAnswer,
    onAdvanceActivePendingUserInput,
    onAdvanceActivePendingUserInputStable,
    onPreviousActivePendingUserInputQuestion: onPreviousActivePendingUserInputQuestionStable,
  } = usePendingThreadRequests({
    environmentId,
    activeThreadId,
    serverProjection,
    supportsQuestionAttachments,
    composerDraftTarget,
    setComposerDraftPrompt,
    promptRef,
    composerRef,
  });
  const [heldApprovalRequestIds, setHeldApprovalRequestIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const onHeldRequestIdsChange = useStableCallback((requestIds: ReadonlySet<string>) => {
    setHeldApprovalRequestIds((current) => (shallow(current, requestIds) ? current : requestIds));
  });
  const activeProposedPlan = (() => {
    if (!latestRunSettled) {
      return null;
    }
    return findLatestProposedPlan(serverProjection, activeLatestRun?.runId ?? null);
  })();
  const showPlanFollowUpPrompt = shouldShowPlanFollowUpPrompt({
    pendingUserInputCount: pendingUserInputs.length,
    interactionMode,
    latestTurnSettled: latestRunSettled,
    hasActionableProposedPlan: hasActionableProposedPlan(activeProposedPlan),
    hasComposerAttachments: composerHasAttachments,
  });
  // Answering an approval or question on any client resumes quota spending, so include it in the key.
  const usageLimitsKey =
    activeProviderInstanceId === null || (isServerThread && activeThread === undefined)
      ? null
      : [
          routeThreadKey,
          activeProviderInstanceId,
          activeThread?.latestRun?.runId ?? "",
          activePendingApproval?.requestId ?? activePendingUserInput?.requestId ?? "",
        ].join(":");
  const {
    banner: usageLimitsBanner,
    offered: usageLimitsOffered,
    open: openUsageLimits,
    clearFor: clearUsageLimitsFor,
  } = useUsageLimitsPanel({
    environmentId,
    threadKey: routeThreadKey,
    panelKey: usageLimitsKey,
    providerInstanceId: activeProviderInstanceId,
    providerDriver: activeProviderStatus?.driver ?? null,
    providers: providerStatuses,
    sources: serverConfig?.usageLimitSources ?? EMPTY_USAGE_LIMIT_SOURCES,
  });
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    // SCIENT-FORK:START — the timeline's working row waits for the prompt being sent.
    localDispatchLatestUserMessageId,
    // SCIENT-FORK:END
    isPreparingWorktree: isLocallyPreparingWorktree,
    isSendBusy,
    backgroundSubmissionPending,
  } = useLocalDispatchState({
    routeThreadKey,
    activeThread,
    activeLatestRun,
    latestUserMessageId:
      serverProjection?.messages.findLast((message) => message.role === "user")?.id ?? null,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError,
  });
  const optimisticCompactionMessage = optimisticUserMessages.at(-1);
  const latestServerUserItem = serverVisibleTurnItems.findLast(
    (row) => row.item.type === "user_message",
  )?.item;
  const compactRequestIsActive =
    (isSendBusy &&
      optimisticCompactionMessage !== undefined &&
      isCompactCommandMessage(optimisticCompactionMessage)) ||
    (latestServerUserItem?.type === "user_message" &&
      latestServerUserItem.text.trim().toLowerCase() === "/compact" &&
      latestServerUserItem.attachments.length === 0 &&
      latestServerUserItem.runId === activeActivityRun?.runId &&
      !isLatestRunSettled(activeActivityRun, activeRuntime));
  const compactionSettled = serverVisibleTurnItems.some(
    ({ item }) =>
      item.type === "compaction" &&
      item.runId === activeActivityRun?.runId &&
      (item.status === "completed" ||
        item.status === "failed" ||
        item.status === "interrupted" ||
        item.status === "cancelled"),
  );
  const compactionRunning = serverVisibleTurnItems.some(
    ({ item }) =>
      item.type === "compaction" &&
      item.runId !== null &&
      item.runId === activeRuntime?.activeRunId &&
      item.status === "running",
  );
  const isCompacting =
    (isSendBusy || phase === "connecting" || phase === "running") &&
    (compactionRunning || (compactRequestIsActive && !compactionSettled));
  const activeRunPreparing = activeActivityRun?.status === "preparing";
  // Once the server owns the setup run, follow-ups queue behind it.
  const sendQueuesBehindSetup =
    isServerThread && (activeRunPreparing || activeActivityRun?.status === "starting");
  const [setupQueueSendThreadKey, setSetupQueueSendThreadKey] = useState<string | null>(null);
  const pendingBackgroundTasks = deriveThreadPendingBackgroundTasks(serverProjection);
  const activeWorkStartedAt =
    deriveActiveWorkStartedAt(activeActivityRun, activeRuntime, localDispatchStartedAt) ??
    runlessWorkStartedAt;
  const downloadFileAttachment = async (attachment: ChatFileAttachment) => {
    const connection = readPreparedConnection(environmentId);
    if (!connection) {
      toastManager.add({ type: "error", title: "The environment is not connected." });
      return;
    }

    try {
      const url = await resolveFileAttachmentUrl({
        attachment,
        environmentId,
        httpBaseUrl: connection.httpBaseUrl,
        createAssetUrl: createAttachmentAssetUrl,
      });
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.name;
      anchor.click();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not download " + attachment.name,
        description: error instanceof Error ? error.message : "The attachment is unavailable.",
      });
    }
  };
  const downloadFileAttachmentStable = useStableCallback(downloadFileAttachment);
  const openFileAttachment = (attachment: ChatFileAttachment) => {
    if (activeThreadRef) {
      useRightPanelStore.getState().openAttachment(activeThreadRef, attachment);
      return;
    }
  };
  const openFileAttachmentStable = useStableCallback(openFileAttachment);
  const { timelineAttachmentUrlById } = useAttachmentPreviewHandoff({
    environmentId,
    threadId,
    serverVisibleTurnItems,
    handoff: optimisticState.handoff,
    blobPreviews: optimisticBlobPreviews,
    setOptimisticUserMessages: setHeldOptimisticUserMessages,
  });
  const anchoredTimelineMessages = feedbackSubmissions.flatMap((submission) =>
    submission.status === "interrupted"
      ? []
      : [
          { ...codexFeedbackMessage(submission), runId: null },
          { ...codexFeedbackMessage(submission, "assistant"), runId: null },
        ],
  );
  const timelineEntriesInput = {
    optimisticMessages: optimisticUserMessages,
    anchoredMessages: anchoredTimelineMessages,
    attachmentUrlById: timelineAttachmentUrlById,
    ...(serverProjection === null
      ? {}
      : {
          attempts: serverProjection.attempts,
          nodes: serverProjection.nodes,
          plans: serverProjection.plans,
        }),
  };
  // The structure has no assistant or reasoning text, so those rows stay out of
  // ChatView's own entries (anchoring, rewind, prompt history); ThreadTimeline
  // renders every row from the live turn items.
  const serverTimelineRows = serverVisibleTurnItems.filter(isCompleteTurnItemRow);
  const hasStreamedTimelineRows =
    isServerThread && serverTimelineRows.length !== serverVisibleTurnItems.length;
  const serverTimelineEntries = useIncrementalTimelineEntries(activeThreadKey, {
    ...timelineEntriesInput,
    visibleTurnItems: serverTimelineRows,
  });
  const draftTimelineEntries = optimisticUserMessages.map(
    (message) =>
      ({
        id: message.id,
        kind: "message",
        createdAt: message.createdAt,
        message,
      }) as const,
  );
  const timelineEntries = isServerThread ? serverTimelineEntries : draftTimelineEntries;
  const timelineMessages = timelineEntries.flatMap((entry) =>
    entry.kind === "message" ? [entry.message] : [],
  );
  // SCIENT-FORK:START — a fork opened from the fork dialog shows once, in place.
  const forkLanding = useForkLanding(routeThreadKey);
  // SCIENT-FORK:END
  const timelineEmpty = timelineEntries.length === 0 && !hasStreamedTimelineRows;
  const displayedTimelineKey = activeThreadKey ?? routeThreadKey;
  const displayedThreadRef = parseScopedThreadKey(displayedTimelineKey);
  // SCIENT-FORK:START — the landing fork's messages wait for their own positioned rows.
  const forkLandingReveal = useForkLandingReveal({
    landing: forkLanding,
    threadKey: routeThreadKey,
    threadExists: isServerThread,
    threadDeleted: threadStatus === "deleted",
    detailLoaded: serverProjection !== null,
    displayedThreadKey: activeThreadKey,
    timelineEmpty,
  });
  // SCIENT-FORK:END
  const {
    worktreeSetup,
    // SCIENT-FORK:START — a bootstrap still setting up counts as working before its run exists.
    liveSnapshot: liveWorktreeSetup,
    // SCIENT-FORK:END
    isPreparingWorktree,
    blocksSend: worktreeSetupBlocksSend,
    retryableRunIds: retryableWorkspacePreparationRunIds,
    begin: beginWorktreeSetup,
    cancel: cancelWorktreeSetup,
    retryPreparation: onRetryWorkspacePreparationStable,
    openSetupTerminal: onOpenWorktreeSetupTerminal,
  } = useWorktreeSetup({
    routeThreadRef,
    ownerKey: draftId ?? routeThreadKey,
    activeThread,
    threadRef: activeThreadRef,
    serverProjection,
    activityRun: activeActivityRun,
    localPreparing: isLocallyPreparingWorktree,
    sendQueuesBehindSetup,
    // Include optimistic sends to retire the row before the server echo.
    followUpSent: timelineMessages.filter((message) => message.role === "user").length > 1,
  });
  // SCIENT-FORK:START — working state: a bootstrap still setting up and a fork being prepared
  // count as work, and the reading end follows the latest turn's state.
  // Durable V2 setup snapshots also cover reloads before the first run starts.
  const awaitingBootstrapTurn =
    activeServerThread !== null &&
    activeServerThread.id === routeThreadRef.threadId &&
    activeLatestRun === null &&
    liveWorktreeSetup?.phase === "running";
  const isOriginWorking =
    phase === "running" || isSendBusy || isCompacting || awaitingBootstrapTurn;
  const isWorking = isOriginWorking || isForkingThread;
  const turnUnfinished = latestTurnUnfinished(activeRunningTurnId, activeLatestRun?.status);
  // The timeline's working row waits for the prompt being sent, and stays while its run starts
  // (chat/timelineWorkingState.ts).
  const timelineWorking = deriveTimelineWorking({
    threadWorking: isWorking,
    onlySendBusy: isOnlySendBusy({
      isSendBusy,
      phase,
      isCompacting,
      awaitingBootstrapTurn,
      isForkingThread,
      isRevertingCheckpoint,
      isPreparingWorktree,
    }),
    dispatchBaselineUserMessageId: localDispatchLatestUserMessageId,
    projection: serverProjection,
    optimisticMessages: optimisticUserMessages,
  });
  // SCIENT-FORK:END
  const onCancelWorktreeSetupStable = useStableCallback(() => void cancelWorktreeSetup());
  const [dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey] = useState<string | null>(null);
  const draftHeroDockRequested =
    activeThreadKey !== null && dockedDraftHeroThreadKey === activeThreadKey;
  const isDraftHeroState = resolveDraftHeroState({
    isLocalDraftThread,
    hasTimelineEntries: !timelineEmpty,
    isWorking,
    draftHeroDockRequested,
    backgroundSubmissionPending,
    hasWorktreeSetupCard: worktreeSetup !== null,
  });
  // SCIENT-FORK:START — the draft composer's move always animates, unless motion is reduced.
  const draftHeroMotion = useDraftHeroMotion();
  // SCIENT-FORK:END
  const {
    transitionGroupRef: draftHeroTransitionGroupRef,
    composerAnchorRef: draftHeroComposerAnchorRef,
    captureComposerRect: captureDraftHeroComposerRect,
  } = useDraftHeroLayoutTransition(
    isDraftHeroState,
    // SCIENT-FORK:START — not the opt-in panel animation setting (chat/timelineEntranceMotion.ts).
    draftHeroMotion.animate,
    draftHeroMotion.durationMs,
    // SCIENT-FORK:END
  );
  // SCIENT-FORK:START — the composer's fork command.
  const readLiveTimelineEntries = () => {
    if (!routeThreadDetailRef) return timelineEntries;
    const live = readThreadProjection(routeThreadDetailRef)?.projection;
    if (!live) return timelineEntries;
    return deriveTimelineEntriesFromVisibleTurnItemsWithState({
      ...timelineEntriesInput,
      visibleTurnItems: live.visibleTurnItems,
      attempts: live.attempts,
      nodes: live.nodes,
      plans: live.plans,
    }).entries;
  };
  const onForkConversation = createForkConversationCommand({
    readTimelineEntries: readLiveTimelineEntries,
    timelineEntries,
    activeLatestRun,
    activeRunningTurnId,
    activeThreadId,
    activeThreadEnvironmentId,
    setForkCommandTarget,
  });
  // SCIENT-FORK:END
  const availableRevertTurnCounts = deriveAvailableRevertTurnCounts(serverProjection ?? null);
  // A paged history window cannot identify the first loaded run as the thread start.
  const threadStartCheckpointReady =
    !serverThreadHistory.hasMoreHistory &&
    findRevertCheckpoint(serverProjection?.checkpoints ?? [], 0) !== undefined;

  const workspaceMutationId = deriveWorkspaceMutationId(
    serverVisibleTurnItems,
    turnDiffSummaries.at(-1)?.completedAt ?? null,
  );

  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.workspaceRoot },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const gitStatusCwd = activeThread?.worktreePath ?? gitCwd;
  const gitStatusQuery = useEnvironmentQuery(
    gitStatusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: gitStatusCwd },
        }),
  );
  useWorkspaceMutationRefresh({
    enabled: gitStatusCwd !== null,
    mutationId: workspaceMutationId,
    refresh: gitStatusQuery.refresh,
    resourceKey: `git-status:${activeThreadKey ?? ""}:${gitStatusCwd ?? ""}`,
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const backgroundThread = use(BackgroundThreadContext);
  // SCIENT-FORK:START — Back and Forward for file tabs; stand down in background like other shortcuts
  useRightPanelTabHistory({
    threadRef: backgroundThread ? null : activeThreadRef,
    keybindings,
    runAfterPendingFileSave,
  });
  // SCIENT-FORK:END
  const scriptKeybindings =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.keybindings ??
    DEFAULT_RESOLVED_KEYBINDINGS;
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const remoteOpenState = useRemoteOpenState(activeThread?.environmentId ?? environmentId);
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName: activeProject?.title,
    activeThreadEnvironmentId: activeThread?.environmentId ?? environmentId,
    primaryEnvironmentId,
    remoteOpenMode: remoteOpenState.mode,
  });
  useOpenFavoriteEditorShortcut({
    enabled: showOpenInPicker && !backgroundThread,
    environmentId: activeThread?.environmentId ?? environmentId,
    keybindings,
    availableEditors,
    openInCwd: gitCwd,
  });
  const manualCompactionProviderAvailable = hasAvailableCompactionProvider({
    providers: providerInstanceEntries,
    driverKind: selectedProvider,
    instanceId: activeProviderInstanceId,
    lockedInstanceId: lockedProvider
      ? (activeRuntime?.providerInstanceId ?? activeThread?.modelSelection.instanceId ?? null)
      : null,
  });
  const [resumeCompactionPermanentlyDismissed, setResumeCompactionPermanentlyDismissed] =
    useLocalStorage(
      `t3code:resume-compaction-dismissed:${environmentId}:${activeProviderInstanceId ?? "claudeAgent"}`,
      false,
      Schema.Boolean,
    );
  const nativeResumeCompactionDismissed = hasDismissedResumeCompaction(
    (serverProjection?.runtimeRequests ?? [])
      .filter((request) => request.kind === "user_input" && request.status === "resolved")
      .map((request) => ({
        kind: "user-input.resolved",
        payload: { answers: request.answers },
      })),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists the server-reported resume compaction dismissal to localStorage
  useEffect(() => {
    if (nativeResumeCompactionDismissed && !resumeCompactionPermanentlyDismissed) {
      setResumeCompactionPermanentlyDismissed(true);
    }
  }, [
    nativeResumeCompactionDismissed,
    resumeCompactionPermanentlyDismissed,
    setResumeCompactionPermanentlyDismissed,
  ]);
  // SCIENT-FORK:START — messages present active Scient skills beside provider-native ones.
  const effectiveActiveProviderSkills = useEffectiveActiveProviderSkills({
    environmentId,
    routeKind,
    activeThreadId,
    activeProjectId: activeProject?.id ?? null,
    selectedProvider,
    activeProviderStatus,
    gitCwd,
  });
  // SCIENT-FORK:END
  const providerStatusBannerKey = getProviderStatusBannerKey(activeProviderStatus);
  const [dismissedProviderStatusBannerKey, setDismissedProviderStatusBannerKey] = useState<
    string | null
  >(null);
  if (providerStatusBannerKey === null && dismissedProviderStatusBannerKey !== null) {
    setDismissedProviderStatusBannerKey(null);
  }
  const visibleProviderStatus = shouldShowProviderStatusBanner(
    activeProviderStatus,
    dismissedProviderStatusBannerKey,
  )
    ? activeProviderStatus
    : null;
  const hasTimelineTopBanner =
    (Boolean(visibleThreadError) && !isTokenLimitError) || visibleProviderStatus !== null;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = resolveThreadWorkspaceRoot({
    worktreePath: activeThreadWorktreePath,
    projectCwd: activeProjectCwd,
  });
  useFileCitationTarget(
    activeThreadRef,
    citationLocation,
    activeWorkspaceRoot,
    runAfterPendingFileSave,
  );
  // SCIENT-FORK:START — hold a fork's panel until its pending PDF positions are applied.
  const forkPdfContinuityPending = useForkPdfContinuityPending(
    activeThreadRef,
    activeWorkspaceRoot,
  );
  // SCIENT-FORK:END
  const activeTerminalLaunchContext =
    terminalUiLaunchContext?.threadId === activeThreadId ? terminalUiLaunchContext : null;
  const liveIsGitRepo = gitStatusQuery.data?.isRepo;
  const gitUnavailable = gitStatusQuery.data?.gitAvailability === "missing";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records live git repo status in the session cache read while the status query is unavailable
  useEffect(() => {
    if (gitStatusCwd !== null && liveIsGitRepo !== undefined && !gitUnavailable) {
      rememberCheckoutIsRepo(environmentId, gitStatusCwd, liveIsGitRepo);
    }
  }, [environmentId, gitStatusCwd, gitUnavailable, liveIsGitRepo]);
  // SCIENT-FORK:START — a missing Git install reads as no repository; diffs need a project.
  const isGitRepo = gitUnavailable
    ? false
    : (liveIsGitRepo ?? recallCheckoutIsRepo(environmentId, gitStatusCwd) ?? true);
  const diffAvailable = hasProjectWorkspace && isServerThread && isGitRepo;
  // SCIENT-FORK:END
  // SCIENT-FORK:START — fork baseline and new-worktree availability.
  const {
    hasForkBaseline,
    forkOriginThreadId,
    forkBaselineAssistantMessageId,
    forkWorktreeAvailability,
  } = deriveForkTimelineBaseline({
    readTimelineEntries: readLiveTimelineEntries,
    turnDiffSummaries,
    activeThread,
    serverVisibleTurnItems,
    isGitRepo,
    forkDialogOpen: forkCommand.forkDialogOpen,
    forkCommandTarget: forkCommand.forkCommandTarget,
    timelineEntries,
  });
  // SCIENT-FORK:END
  // Provider-native subagents cannot take messages; approvals and questions go to the top-level parent.
  const showProviderSubagentBar = isProviderSubagent;
  const composerMounted = !showProviderSubagentBar;
  const providerSubagentModels = selectedProviderEntry?.models ?? EMPTY_PROVIDER_MODELS;
  // Providers can report dated model ids or aliases.
  const providerSubagentModelSlug = selectedProviderEntry
    ? resolveSelectableModel(
        selectedProviderEntry.driverKind,
        activeThread?.modelSelection.model,
        providerSubagentModels,
      )
    : null;
  const providerSubagentCatalogModel = providerSubagentModels.find(
    (model) => model.slug === providerSubagentModelSlug,
  );
  const providerSubagentModelLabel = providerSubagentCatalogModel
    ? getTriggerDisplayModelName(providerSubagentCatalogModel, selectedProviderEntry?.driverKind)
    : formatModelSlugName(activeThread?.modelSelection.model ?? "");
  const providerSubagentEffortLabel =
    activeThread === undefined
      ? null
      : formatModelSelectionEffort(
          activeThread.modelSelection,
          providerSubagentModels,
          reportedModelSelection,
        );
  const showComposerContextStrip = shouldShowComposerContextStrip({
    isDraftHeroState,
    persistInActiveThreads: settings.persistComposerContextStrip,
    hasActiveProject: activeProject !== null && !showProviderSubagentBar,
    isGitRepo,
    showEnvironmentIndicator: showComposerEnvironmentIndicator,
  });
  const terminalShortcutLabelOptions = {
    context: {
      terminalFocus: true,
      terminalOpen: Boolean(terminalUiState.terminalOpen),
    },
  };
  const splitTerminalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.split",
    terminalShortcutLabelOptions,
  );
  const splitTerminalVerticalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.splitVertical",
    terminalShortcutLabelOptions,
  );
  const newTerminalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.new",
    terminalShortcutLabelOptions,
  );
  const closeTerminalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.close",
    terminalShortcutLabelOptions,
  );

  const {
    needsLoadBalancing,
    loadBalancing,
    onAutoEnvironmentStable,
    autoEnvironmentLabel,
    isEnvironmentChanging,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
  } = useDraftEnvironmentRouting({
    draftId,
    draftThread,
    envLocked,
    automaticEnvironment,
    logicalProjectEnvironments,
    environmentById,
    providersByEnvironment,
    loadBalancingSettings,
    referencedThreadContexts,
    activeProviderInstanceId,
    selectedProvider,
    composerHasAttachments,
    activeProjectKey: activeProject
      ? `${activeProject.environmentId}:${activeProject.workspaceRoot}`
      : null,
    activeProjectIsScratch,
    projectGroupingSettings,
    sendInFlightRef,
  });

  const composerIdentity = composerTargetKey(composerDraftTarget);
  const previousComposerIdentity = useRef({ thread: activeThreadKey, draft: composerIdentity });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refocuses the composer DOM editor when its draft target changes within the same thread
  useLayoutEffect(() => {
    const previous = previousComposerIdentity.current;
    previousComposerIdentity.current = { thread: activeThreadKey, draft: composerIdentity };
    if (previous.thread === activeThreadKey && previous.draft !== composerIdentity) {
      const composer = composerRef.current;
      if (composer) composer.focusAt(composer.readSnapshot().cursor);
    }
  }, [activeThreadKey, composerIdentity, composerRef]);
  const focusComposer = () => {
    composerRef.current?.focusAtEnd();
  };
  const focusComposerStable = useStableCallback(focusComposer);
  const canInterruptRunningThread =
    canOperateThread && deriveCanInterruptRunningThread(activeThread !== undefined, activeRuntime);
  // SCIENT-FORK:START — the owned acknowledgement composes the original interrupt command.
  const performInterrupt = async () => {
    // SCIENT-FORK:END
    if (
      !activeThread ||
      !readEnvironmentScope(activeThread.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const result = await interruptThreadTurn({
      environmentId,
      input: { threadId: activeThread.id },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to interrupt the current turn.",
      );
    }
    // SCIENT-FORK:START — only an accepted command keeps the acknowledgement.
    return result._tag !== "Failure";
    // SCIENT-FORK:END
  };
  // SCIENT-FORK:START — acknowledge Stop while durable cancellation finishes.
  const performInterruptStable = useStableCallback(performInterrupt);
  const { isStopping, onInterrupt } = useStopGeneration({
    threadKey: activeThreadKey,
    runId: activeRunningTurnId ?? activeLatestRun?.runId ?? null,
    canInterrupt: canInterruptRunningThread,
    projection: serverProjection,
    operation: performInterruptStable,
  });
  // SCIENT-FORK:END
  const onInterruptStable = useStableCallback(onInterrupt);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window listener for the desktop snapshot event that focuses the composer
  useEffect(() => subscribeSnapShotComposerFocus(focusComposerStable), [focusComposerStable]);
  const scheduleComposerFocus = () => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  };
  const scheduleComposerFocusStable = useStableCallback(scheduleComposerFocus);
  const openComposerPermissionsStable = useStableCallback(() =>
    composerRef.current?.openControl("composer.mode"),
  );
  const insertArtifactTemplate = (template: CodexArtifactTemplate) => {
    const composer = composerRef.current;
    if (!composer) return;

    const currentDraft = composer.getSendContext().prompt;
    const prompt = codexArtifactTemplatePromptToAppend(currentDraft, template);
    if (prompt !== null && !composer.insertTextAtEnd(prompt, { ensureLeadingBoundary: true })) {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "The composer is busy; try again once it is ready.",
      });
      return;
    }
    scheduleComposerFocus();
  };
  const insertArtifactTemplateStable = useStableCallback(insertArtifactTemplate);
  const sendAppMessage = async (text: string) => {
    if (!isServerThread || activeThreadId === null) {
      throw new Error("Messages from apps need a started thread.");
    }
    const result = await startThreadTurn({
      environmentId,
      input: {
        threadId: activeThreadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode,
        interactionMode,
        dispatchMode: "queue",
      },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      throw error instanceof Error ? error : new Error("Could not send the app's message.");
    }
  };
  const sendAppMessageStable = useStableCallback(sendAppMessage);
  const queuedRunsControlRef = useRef<QueuedRunsControlHandle>(null);
  // SCIENT-FORK:START — a native queued run is edited through a Scient edit session.
  const beginEditingQueuedRun = (request: EditQueuedRunRequest) => {
    if (!activeThread || serverProjection === null) return;
    const run = serverProjection.runs.find(
      (candidate) => candidate.id === request.runId && candidate.status === "queued",
    );
    const message = serverProjection.messages.find(
      (candidate) => candidate.id === request.messageId,
    );
    if (!run || !message) return;
    const updatedAt = DateTime.formatIso(message.updatedAt);
    void beginQueueEdit(
      routeThreadRef,
      nativeQueueEditItem(run, message, serverProjection.thread),
      { runId: run.id, messageId: message.id, expectedUpdatedAt: updatedAt },
    )
      .then(() => scheduleComposerFocus())
      .catch((cause) => setThreadError(activeThread.id, chatActionErrorMessage(cause)));
  };
  const beginEditingQueuedRunStable = useStableCallback(beginEditingQueuedRun);
  // SCIENT-FORK:END

  const {
    activatePanelTerminalStable,
    addTerminalContextToDraftStable,
    addTerminalSurfaceStable,
    closePanelTerminalStable,
    lastInvokedScriptByProjectId,
    runProjectScriptStable,
    runShellCommandStable,
    splitPanelTerminalStable,
    splitPanelTerminalVerticalStable,
    toggleTerminalVisibilityStable,
    shortcuts: terminalShortcuts,
  } = useChatTerminalActions({
    routeThreadKey,
    currentRouteThreadKeyRef,
    runAfterPendingFileSave,
    openProjectScriptPreview,
    environmentId,
    composerRef,
    terminalUiState,
    activeThread,
    activeThreadId,
    activeThreadRef,
    activeProject,
    activeRightPanelSurface,
    runningTerminalIds,
    activeServerOrderedTerminalIds,
    activeTerminalLabelsById,
    panelTerminalIds,
    canReuseTerminal,
    gitCwd,
    setTerminalUiLaunchContext,
    setThreadError,
  });
  const {
    saveProjectScript: saveProjectScriptStable,
    updateProjectScript: updateProjectScriptStable,
    deleteProjectScript: deleteProjectScriptStable,
  } = useProjectScriptEditing({
    environmentId,
    project: activeProject,
    scripts: activeProjectScripts,
    settings,
  });
  const canOperatePreview = useEnvironmentScope(
    activeThreadRef?.environmentId ?? null,
    AuthPreviewOperateScope,
  );
  // SCIENT-FORK:START — openers for the right-panel surfaces Scient adds.
  const {
    addNewTabSurface,
    addAgentsSurface,
    addDocumentsSurface,
    addSourcesSurface,
    addComputeSurface,
    openScientSourcePdf,
    openFileSurfaceNow,
    openFileSourceSurface,
  } = useScientRightPanelOpeners({
    activeThreadRef,
    activeProject,
    activeWorkspaceRoot,
    runAfterPendingFileSave,
  });
  // SCIENT-FORK:END
  const shownPreviewMiniPlayer =
    activeThreadRef &&
    activePreviewMiniPlayer &&
    previewMiniPlayerVisible &&
    (activePreviewMiniPlayer.content.kind === "device" || canOperatePreview)
      ? activePreviewMiniPlayer
      : null;
  const canvasPreview = useThreadPreviewCanvasSource(activeThreadRef, shownPreviewMiniPlayer);
  const threadPanelInlineOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, activeThreadRef, "inline"),
  );
  // Selects only the mode, so canvas resizes rerender the chat view only when the
  // card switches presentation.
  const threadPanelPresentation = useStore(
    chatCanvasStore,
    (state) =>
      resolveChatCanvasModel({
        measurements: state.measurements,
        detailsCardMeasurement: state.detailsCardMeasurement,
        threadRef: activeThreadRef,
        preview: canvasPreview,
        detailsCardInlineOpen: threadPanelInlineOpen,
      }).detailsCardMode,
  );
  const threadPanelOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(
      state.threadPanelVisibilityByThreadKey,
      activeThreadRef,
      threadPanelPresentation,
    ),
  );
  const supportsThreadPullRequests = serverConfig !== null;
  const visiblePullRequests = visibleThreadPullRequests(
    (activeThreadShell ?? activeThread)?.pullRequests ?? [],
  );
  const visiblePullRequestCount = visiblePullRequests.length;
  const pullRequestsSurfaceAvailable =
    isServerThread && supportsThreadPullRequests && visiblePullRequestCount > 0;
  const { state: deviceState, loaded: deviceStateLoaded } = useDeviceState(
    activeThreadRef?.environmentId ?? null,
  );
  // SCIENT-FORK:START — file surfaces report handled HTML and LaTeX presentation requests.
  const { handleHtmlPresentationRequestHandled, handleLatexPresentationRequestHandled } =
    useFilePresentationRequestHandlers(activeThreadRef);
  // SCIENT-FORK:END
  // The thread's own change request, placed against the project it belongs to. Without a
  // project there is nothing to resolve it against, so the caller falls back to the browser.
  const activeProjectRepository = sourceControlClients.repositorySelector(
    activeProject?.repositoryIdentity,
  );
  const {
    linked: linkedThreadPullRequest,
    linkedKey: linkedThreadPullRequestKey,
    hasDetail: hasLinkedPullRequestDetail,
  } = useThreadLinkedPullRequest({
    serverThreadRef: isServerThread ? activeThreadRef : null,
    environmentId: activeThreadRef?.environmentId ?? null,
    persisted: isServerThread
      ? (activeThreadShell?.linkedPullRequest ?? activeThread?.linkedPullRequest ?? null)
      : (activeThread?.linkedPullRequest ?? null),
    projectId: activeProject?.id ?? null,
    projectRepository: activeProjectRepository,
    threadBranch: activeThread?.branch ?? null,
    gitStatus: gitStatusQuery.data ?? null,
  });
  const proactivePullRequestsKey = pullRequestsSurfaceAvailable
    ? JSON.stringify(
        visiblePullRequests.map((link) => [link.host, link.repository, link.number]).sort(),
      )
    : linkedThreadPullRequestKey;
  useProactivePanels({
    threadRef: isServerThread ? activeThreadRef : null,
    enabled: settings.proactivePanelsEnabled && !shouldUsePlanSidebarSheet,
    settingsHydrated: clientSettingsHydrated,
    threadDetailLoading,
    runningTurnId: activeRunningTurnId,
    latestRun: activeLatestRun,
    latestRunSettled,
    turnDiffSummaries,
    isGitRepo: gitStatusQuery.data?.isRepo,
    linkedPullRequest: linkedThreadPullRequest,
    hasLinkedPullRequestDetail,
    pullRequestsKey: proactivePullRequestsKey,
    pullRequestsCapabilityKnown,
    supportsPullRequests,
    pullRequestsSurfaceAvailable,
    visiblePullRequestCount,
    onDiffPanelOpen,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- consumes a pending maximize request from the right panel store once the panel can maximize
  useEffect(() => {
    if (!canMaximizeRightPanel) return;
    if (useRightPanelStore.getState().consumeMaximizeRequest(routeThreadRef)) {
      useRightPanelStore.getState().setMaximized(routeThreadRef, true);
    }
  }, [canMaximizeRightPanel, routeThreadRef]);
  // SCIENT-FORK:START — compute-owned tabs stop their compute context before they close, and a
  // file edited while that happens keeps its tab.
  const closeComputeOwnedSurfaces = useCloseComputeOwnedSurfaces({
    activeThreadRef,
    activeWorkspaceRoot,
    commands: computeSessionCommands,
  });
  const prepareRightPanelSurfaceClose = (surfaces: readonly RightPanelSurface[]) =>
    closeComputeOwnedSurfaces(surfaces).then(
      (closed) => {
        if (!closed || currentRouteThreadKeyRef.current !== routeThreadKey) return false;
        const pendingSurfaceIds =
          markdownDepartureOptions.getPendingSurfaceIds?.() ?? pendingFileSurfaceIds;
        const latestPendingFiles =
          activeWorkspaceKey === null
            ? undefined
            : pendingFilesDuringCloseRef.current.get(activeWorkspaceKey);
        if (
          surfaces.some(
            (surface) => pendingSurfaceIds.has(surface.id) || latestPendingFiles?.has(surface.id),
          )
        ) {
          toastManager.add({
            type: "info",
            title: "File kept open",
            description: "The file changed while its compute session was stopping.",
          });
          return false;
        }
        return true;
      },
      (error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Unable to close the panel",
          description:
            error instanceof Error ? error.message : "The panel close could not be completed.",
        });
        return false;
      },
    );
  // SCIENT-FORK:END
  const {
    closeSurface: closeRightPanelSurfaceNow,
    closeOtherSurfaces: closeOtherRightPanelSurfacesNow,
    closeSurfacesToRight: closeRightPanelSurfacesToRightNow,
    closeAllSurfaces: closeAllRightPanelSurfacesNow,
  } = useRightPanelSurfaceClose({
    threadRef: activeThreadRef,
    terminalLabelsById: activeTerminalLabelsById,
    // SCIENT-FORK:START
    prepareClose: prepareRightPanelSurfaceClose,
    // SCIENT-FORK:END
  });
  // SCIENT-FORK:START — a surface with a pending save finishes saving before it closes.
  const closeRightPanelSurface = (surface: RightPanelSurface) =>
    runAfterPendingSurfaceSave([surface.id], () => closeRightPanelSurfaceNow(surface));
  const closeRightPanelSurfaceStable = useStableCallback(closeRightPanelSurface);
  const closeOtherRightPanelSurfaces = (surface: RightPanelSurface) =>
    runAfterPendingSurfaceSave(
      rightPanelState.surfaces.filter((entry) => entry.id !== surface.id).map((entry) => entry.id),
      () => closeOtherRightPanelSurfacesNow(surface),
    );
  const closeOtherRightPanelSurfacesStable = useStableCallback(closeOtherRightPanelSurfaces);
  const closeRightPanelSurfacesToRight = (surface: RightPanelSurface) => {
    const surfaceIndex = rightPanelState.surfaces.findIndex((entry) => entry.id === surface.id);
    if (surfaceIndex < 0) return;
    runAfterPendingSurfaceSave(
      rightPanelState.surfaces.slice(surfaceIndex + 1).map((entry) => entry.id),
      () => closeRightPanelSurfacesToRightNow(surface),
    );
  };
  const closeRightPanelSurfacesToRightStable = useStableCallback(closeRightPanelSurfacesToRight);
  const closeAllRightPanelSurfaces = () =>
    runAfterPendingSurfaceSave(
      rightPanelState.surfaces.map((surface) => surface.id),
      () => closeAllRightPanelSurfacesNow(),
    );
  const closeAllRightPanelSurfacesStable = useStableCallback(closeAllRightPanelSurfaces);
  // SCIENT-FORK:END
  const persistThreadSettingsForNextTurn = async (input: {
    threadId: ThreadId;
    createdAt: string;
    assertCurrent?: () => void;
    modelSelection?: ModelSelection;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }): Promise<AtomCommandResult<void, unknown>> => {
    if (!serverThread) {
      return AsyncResult.success(undefined);
    }

    let result: AtomCommandResult<void, unknown> = AsyncResult.success(undefined);
    const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
      currentModelSelection: serverThread.modelSelection,
      ...(input.modelSelection ? { nextModelSelection: input.modelSelection } : {}),
      currentBranch: serverThread.branch,
      ...(input.branch ? { nextBranch: input.branch } : {}),
    });
    if (metadataUpdate) {
      input.assertCurrent?.();
      result = mapAtomCommandResult(
        await updateThreadMetadata({
          environmentId,
          input: {
            threadId: input.threadId,
            ...metadataUpdate,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        return result;
      }
    }

    if (input.runtimeMode !== serverThread.runtimeMode) {
      input.assertCurrent?.();
      result = mapAtomCommandResult(
        await setThreadRuntimeMode({
          environmentId,
          input: {
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            createdAt: input.createdAt,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        return result;
      }
    }

    if (input.interactionMode !== serverThread.interactionMode) {
      input.assertCurrent?.();
      result = mapAtomCommandResult(
        await setThreadInteractionMode({
          environmentId,
          input: {
            threadId: input.threadId,
            interactionMode: input.interactionMode,
            createdAt: input.createdAt,
          },
        }),
        () => undefined,
      );
    }
    return result;
  };

  const {
    showScrollToBottom,
    unreadBelowCount,
    setUnreadBelowCount,
    timelinePositioningPending,
    responseFollow,
    cancelPositionRestoreRef,
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
  } = useTimelineFollow({
    legendListRef,
    composerOverlayElement,
    composerTimelineInset,
    routeThreadKey,
    activeThreadKey,
    isServerThread,
    serverProjection,
    timelineMessages,
    isDraftHeroState,
    hasLatestRun: activeLatestRun !== null,
    turnUnfinished,
    currentRouteThreadKeyRef,
    setTimelineAnchor,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules a frame to focus the composer DOM element when a thread opens with the terminal closed
  useEffect(() => {
    if (!activeThread?.id || terminalUiState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposerStable();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposerStable, terminalUiState.terminalOpen]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window focus listener that refocuses the composer after the window regains focus
  useEffect(() => {
    if (!activeThread?.id || terminalUiState.terminalOpen || isMobileViewport) return;
    let frame: number | null = null;
    const onWindowFocus = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      // Wait an extra frame after window focus so the composer treats focus as an expansion request.
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          if (document.querySelector("[data-mcp-app-fullscreen]") !== null) return;
          if (shouldRefocusComposerOnWindowFocus(document.activeElement)) focusComposerStable();
        });
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposerStable, isMobileViewport, terminalUiState.terminalOpen]);

  // SCIENT-FORK:START — retire admitted previews permanently so editing or deleting a queue row
  // cannot reveal them again.
  const queuedAdmissionIds = new Set(
    serverProjection?.runs
      .filter((run) => run.status === "queued")
      .map((run) => run.userMessageId) ?? [],
  );
  if (
    optimisticUserMessages.some(
      (message) => message.queueAdmission && queuedAdmissionIds.has(message.id),
    )
  ) {
    setOptimisticUserMessages(
      optimisticUserMessages.filter(
        (message) => !message.queueAdmission || !queuedAdmissionIds.has(message.id),
      ),
    );
  }
  // SCIENT-FORK:END

  // Promotion drops draftId while a send may still be dispatching, so key by thread.
  const [localDispatchThreadId, setLocalDispatchThreadId] = useState(threadId);
  if (localDispatchThreadId !== threadId) {
    setLocalDispatchThreadId(threadId);
    resetLocalDispatch();
  }

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
    preparingWorktree: isPreparingWorktree,
  });
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeMessageCount === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  if (
    !canOverrideServerThreadEnvMode &&
    (pendingServerThreadEnvModeEntry !== null || pendingServerThreadBranchEntry !== null)
  ) {
    setPendingServerThreadEnvModeEntry(null);
    setPendingServerThreadBranchEntry(null);
  }
  const pendingServerThreadEnvMode =
    pendingServerThreadEnvModeEntry !== null &&
    pendingServerThreadEnvModeEntry.threadId === activeThread?.id
      ? pendingServerThreadEnvModeEntry.mode
      : null;
  const pendingServerThreadBranchEntryForThread =
    pendingServerThreadBranchEntry?.threadId === activeThread?.id
      ? pendingServerThreadBranchEntry
      : null;
  const setPendingServerThreadBranch = (branch: string | null) => {
    if (activeThread) setPendingServerThreadBranchEntry({ threadId: activeThread.id, branch });
  };
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranchEntryForThread !== null
      ? pendingServerThreadBranchEntryForThread.branch
      : (activeThread?.branch ?? null);
  const startFromOrigin = isLocalDraftThread
    ? (draftThread?.startFromOrigin ?? false)
    : canOverrideServerThreadEnvMode
      ? (pendingServerThreadStartFromOriginByThreadId[activeThread?.id ?? ""] ??
        activeProjectSettings.settings.newWorktreesStartFromOrigin)
      : false;
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });
  const localCheckoutBranchMismatch = isServerThread
    ? resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: envMode,
        activeWorktreePath,
        activeThreadBranch,
        currentGitBranch: gitStatusQuery.data?.refName ?? null,
      })
    : null;
  const publishComposerOverlayHeight = (height: number) => {
    const nextHeight = Math.ceil(height);
    if (nextHeight <= 0) return;
    if (composerTimelineInsetRef.current !== nextHeight) {
      composerTimelineInsetRef.current = nextHeight;
      setComposerTimelineInset(nextHeight);
    }
    // Reserve the expanded composer height for the terminal drawer and empty placeholder.
    // Keep it while the mobile strip collapses, but allow growth from approvals or tasks.
    // A hero overlay fills the pane, so reserve only its stack.
    const stack = composerOverlayElement?.querySelector<HTMLElement>(
      '[data-chat-composer-stack="true"]',
    );
    const expandedComposerHeight =
      isDraftHeroState && stack ? Math.ceil(stack.getBoundingClientRect().height) : nextHeight;
    const mobileCollapsed = Boolean(
      stack?.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
    );
    if (!mobileCollapsed) composerExpandedHeightRef.current = expandedComposerHeight;
    const reservedHeight = Math.max(composerExpandedHeightRef.current, expandedComposerHeight);
    if (composerReservedHeightRef.current !== reservedHeight) {
      composerReservedHeightRef.current = reservedHeight;
      setComposerReservedHeight(reservedHeight);
    }
    const mainSurface = composerOverlayElement?.querySelector<HTMLElement>(
      '[data-chat-composer-main-surface="true"]',
    );
    const button =
      composerOverlayElement?.parentElement?.querySelector<HTMLElement>("[data-scroll-to-end]");
    const clearance =
      composerOverlayElement && mainSurface && button
        ? resolveScrollToEndClearance({
            overlayHeight: nextHeight,
            mainSurfaceTop: mainSurface.getBoundingClientRect().top,
            button: button.getBoundingClientRect(),
            attachments: Array.from(
              composerOverlayElement.querySelectorAll<HTMLElement>(
                '[data-composer-banner-surface="attached"]',
              ),
              (element) => element.getBoundingClientRect(),
            ),
          })
        : nextHeight;
    setScrollToEndClearance(clearance);
  };
  const publishComposerOverlayHeightStable = useStableCallback(publishComposerOverlayHeight);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the composer overlay element before paint for a new thread or composer mount
  useLayoutEffect(() => {
    if (!composerOverlayElement) return;
    composerTimelineInsetRef.current = 0;
    composerReservedHeightRef.current = 0;
    composerExpandedHeightRef.current = 0;
    publishComposerOverlayHeightStable(composerOverlayElement.getBoundingClientRect().height);
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A thread switch or a composer mount/unmount must re-measure the overlay for the new timeline.
    activeThreadKey,
    composerMounted,
    composerOverlayElement,
    publishComposerOverlayHeightStable,
  ]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the composer overlay element's size before paint and publishes its height
  useLayoutEffect(() => {
    if (!composerOverlayElement) return;

    const updateHeight = () => {
      publishComposerOverlayHeightStable(composerOverlayElement.getBoundingClientRect().height);
    };

    updateHeight();
    // The hero overlay fills the pane, so the composer's own growth only shows on its stack.
    const stack = isDraftHeroState
      ? composerOverlayElement.querySelector<HTMLElement>('[data-chat-composer-stack="true"]')
      : null;
    return observeResize(
      stack ? [composerOverlayElement, stack] : composerOverlayElement,
      updateHeight,
    );
  }, [
    composerOverlayElement,
    isDraftHeroState,
    publishComposerOverlayHeightStable,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The scroll-to-bottom button changes the overlay's height without resizing the observed node first.
    showScrollToBottom,
  ]);
  const openPanelPullRequestUrl = useOpenPanelPullRequestUrl(activeThreadRef);
  const activeThreadReferenceCopyTarget =
    activeThreadRef === null || !isServerThread
      ? null
      : resolveThreadReferenceCopyTarget({
          threadRef: activeThreadRef,
          title: activeThread?.title ?? "",
          openPanelPullRequestUrl,
          pullRequests: activeThread?.pullRequests,
          linkedPullRequestUrl: linkedThreadPullRequest?.url ?? null,
        });
  const copyActiveThreadReference = () => {
    if (activeThreadReferenceCopyTarget === null) return;
    void copyThreadReference(activeThreadReferenceCopyTarget);
  };
  const pullRequestPanelTarget = activeThread
    ? threadPullRequestPanelTarget({
        projectId: activeThread.projectId,
        pullRequests: visiblePullRequests,
        linkedPullRequest: linkedThreadPullRequest,
        branchPullRequest: activeThreadShell?.branchPullRequest ?? activeThread.branchPullRequest,
      })
    : null;
  const {
    activateRightPanelSurfaceStable,
    addDeviceSurfaceStable,
    addDiffSurfaceStable,
    addFilesSurfaceStable,
    addPullRequestSurfaceStable,
    addPullRequestsSurfaceStable,
    closePreviewPanelStable,
    copyRightPanelFilePathStable,
    createBrowserSurface,
    createBrowserSurfaceStable,
    moveRightPanelSurfaceStable,
    onOpenToolDiffStable,
    onOpenTurnDiffStable,
    openChangesFromThreadPanelStable,
    openFileSurfaceStable,
    toggleRightPanelMaximizedStable,
    toggleRightPanelStable,
    toggleThreadPanelStable,
    shortcuts: rightPanelShortcuts,
  } = useRightPanelActions({
    diffAvailable,
    activeWorkspaceRoot,
    runAfterPendingFileSave,
    openFileSurfaceNow,
    activeThreadRef,
    activeRightPanelSurface,
    activePreviewState,
    deviceState,
    deviceStateLoaded,
    pullRequestPanelTarget,
    threadPanelPresentation,
    browserAvailable,
    canOperatePreview,
    diffOpen,
    previewPanelOpen,
    rightPanelOpen,
    canMaximizeRightPanel,
    rightPanelMaximized,
    supportsPullRequests,
    pullRequestsSurfaceAvailable,
    explicitDiffOpenRef,
    onDiffPanelOpen,
    closeRightPanelSurface,
  });
  const pullRequestSurfaceAvailable = supportsPullRequests && pullRequestPanelTarget !== null;
  const nowMinute = useNowMinute();
  const {
    acknowledgeActiveThreadWoke,
    activeBranchMismatchKey,
    backgroundWorkNow,
    childInputNow,
    goalNow,
    handleSwitchCheckoutToThread,
    handleSwitchCheckoutToThreadStable,
    isRestoringThreadBranch,
    onOpenRelatedThreadStable,
    sendStandaloneCommand,
    setBranchMismatchDismissTick,
    showBranchMismatchBanner,
    threadStatusLine,
    shortcuts: threadLifecycleShortcuts,
  } = useThreadLifecycle({
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    canOperateThread,
    clientSettingsHydrated,
    activeThread,
    activeThreadId,
    activeThreadRef,
    activeThreadKey,
    activeThreadShell,
    activeLatestRun,
    activeProjectCwd,
    serverConfig,
    runtimeMode,
    isWorking,
    pendingBackgroundTasks,
    turnItems: serverProjection?.turnItems ?? EMPTY_TURN_ITEMS,
    activePendingApproval,
    activePendingUserInput,
    localCheckoutBranchMismatch,
    gitStatusQuery,
    nowMinute,
    composerRef,
    composerDraftTarget,
    sendInFlightRef,
    setOptimisticUserMessages,
    setThreadError,
    clearUsageLimitsFor,
    beginLocalDispatch,
    resetLocalDispatch,
    scheduleComposerFocus,
    scrollToEnd,
    persistThreadSettingsForNextTurn,
  });
  const activeThreadHasCompactableConversation = serverVisibleTurnItems.some(
    ({ item }) =>
      item.type === "user_message" &&
      (item.text.trim().toLowerCase() !== "/compact" || item.attachments.length > 0),
  );
  const pendingHandoffSelection = composerSelectedModelSelection ?? activeThread?.modelSelection;
  const pendingHandoffSelectionUsable = providerInstanceEntries.some(
    (entry) =>
      entry.instanceId === pendingHandoffSelection?.instanceId &&
      entry.enabled &&
      entry.isAvailable,
  );
  const pendingHandoff = resolvePendingHandoff(
    serverProjection,
    pendingHandoffSelectionUsable ? pendingHandoffSelection : null,
    providerStatuses,
  );
  const compactThreadUnavailable =
    !canOperateThread ||
    !activeThread ||
    !activeThreadHasCompactableConversation ||
    !activeProject ||
    !isServerThread ||
    !manualCompactionProviderAvailable ||
    isWorking ||
    isRevertingCheckpoint ||
    threadDetailLoading ||
    isPreparingWorktree ||
    activeEnvironmentUnavailable ||
    feedbackUploading ||
    pendingApprovals.length > 0 ||
    pendingUserInputs.length > 0 ||
    showPlanFollowUpPrompt;
  const compactDisabled = compactThreadUnavailable || composerHasDraftContent;
  const compactDisabledReason = compactDisabled
    ? !canOperateThread
      ? "This connection cannot change threads."
      : composerHasDraftContent
        ? "Send or clear your draft before compacting"
        : !activeProject
          ? "Choose a project before compacting"
          : !manualCompactionProviderAvailable
            ? "Compaction is unavailable for this provider"
            : "Compacting is unavailable right now"
    : null;
  const resumeCompactionTokens =
    activeContextWindow &&
    resolveIdleCompaction(
      settings,
      activeProviderInstanceId ?? ProviderInstanceId.make("claudeAgent"),
    ) !== "off" &&
    !resumeCompactionPermanentlyDismissed &&
    !nativeResumeCompactionDismissed &&
    !compactThreadUnavailable &&
    !hasHeldQueuedRuns &&
    multipleModelSelections === null &&
    shouldOfferResumeCompaction({
      provider: selectedProvider,
      usedTokens: activeContextWindow.usedTokens,
      updatedAt: activeContextWindow.updatedAt,
      promptCacheTtlMs: activeThreadLiveTokenUsage?.promptCacheTtlMs,
      now: `${nowMinute}:00.000Z`,
    })
      ? activeContextWindow.usedTokens
      : null;
  const [fullHistoryThreadKeys, setFullHistoryThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const keepFullHistory = fullHistoryThreadKeys.has(routeThreadKey);
  const setKeepFullHistory = (threadKey: string, keep: boolean) => {
    setFullHistoryThreadKeys((current) => {
      if (current.has(threadKey) === keep) return current;
      const next = new Set(current);
      if (keep) next.add(threadKey);
      else next.delete(threadKey);
      return next;
    });
  };
  const toggleKeepFullHistory = () => setKeepFullHistory(routeThreadKey, !keepFullHistory);
  const toggleKeepFullHistoryStable = useStableCallback(toggleKeepFullHistory);
  const handleRestoreThreadBranch = () => {
    if (!canWriteSourceControl) return;
    if (gitStatusQuery.data?.hasWorkingTreeChanges) {
      if (activeThreadKey !== null) openBranchRestoreConfirm(activeThreadKey);
      return;
    }
    void handleSwitchCheckoutToThread();
  };
  const handleRestoreThreadBranchStable = useStableCallback(handleRestoreThreadBranch);
  const feedbackBannerItems = feedbackSubmissions.flatMap((submission) => {
    const item = feedbackBannerItem(submission, () => {
      setFeedbackSubmissionsByThreadKey((current) => ({
        ...current,
        [routeThreadKey]: (current[routeThreadKey] ?? []).filter(
          (entry) => entry.id !== submission.id,
        ),
      }));
    });
    return item ? [item] : [];
  });
  const limitRecoveryBanner =
    serverRuntime?.status === "failed" &&
    serverRuntime.lastErrorClass === "usage_limit" &&
    activeThreadShell?.latestRun
      ? usageLimitRecoveryBannerItem({
          runId: activeThreadShell.latestRun.runId,
          resetAt: serverRuntime.usageLimitResetAt ?? null,
          stoppedAt: activeThreadShell.latestRun.completedAt ?? activeThreadShell.updatedAt,
          recovery: activeThreadShell.limitRecovery ?? null,
          snoozedUntil: activeThreadShell.snoozedUntil,
          timestampFormat,
          onChange: async (limitRecovery) => {
            const result = await updateThreadMetadata({
              environmentId,
              input: { threadId: activeThreadShell.id, limitRecovery },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          },
        })
      : null;
  // SCIENT-FORK:START — an imported thread says where it came from until its
  // first provider session starts.
  const conversationImportBanner = useConversationImportBanner(activeServerThread);
  // SCIENT-FORK:END
  const composerBannerItems = (() => {
    // SCIENT-FORK:START — the imported-conversation and token-limit notices.
    const conversationImportItems =
      conversationImportBanner === null ? [] : [conversationImportBanner];
    const tokenLimitItems = tokenLimitBannerItems({
      hasTokenLimitNotice,
      tokenLimitNoticeKey,
      onDismissed: () => setThreadErrorBannerDismissTick((tick) => tick + 1),
    });
    // SCIENT-FORK:END
    const limitRecoveryItems = limitRecoveryBanner === null ? [] : [limitRecoveryBanner];
    const usageLimitsItems = usageLimitsBanner === null ? [] : [usageLimitsBanner];
    const projectCloneItems = projectCloneBannerItem === null ? [] : [projectCloneBannerItem];
    if (!localCheckoutBranchMismatch || !showBranchMismatchBanner || !activeBranchMismatchKey) {
      return [
        ...feedbackBannerItems,
        ...limitRecoveryItems,
        ...usageLimitsItems,
        ...projectCloneItems,
        ...systemComposerBannerItems,
        ...tokenLimitItems,
        ...conversationImportItems,
      ];
    }
    return [
      ...conversationImportItems,
      ...feedbackBannerItems,
      ...limitRecoveryItems,
      ...usageLimitsItems,
      ...projectCloneItems,
      ...systemComposerBannerItems,
      ...tokenLimitItems,
      branchMismatchBannerItem({
        mismatchKey: activeBranchMismatchKey,
        mismatch: localCheckoutBranchMismatch,
        restoreDisabled: !canWriteSourceControl || isRestoringThreadBranch,
        restoring: isRestoringThreadBranch,
        onRestore: handleRestoreThreadBranchStable,
        onDismiss: () => {
          dismissBranchMismatchForSession(activeBranchMismatchKey);
          setBranchMismatchDismissTick((tick) => tick + 1);
        },
      }),
    ];
  })() as ComposerBannerStackItem[];

  if (
    terminalUiLaunchContext !== null &&
    (terminalUiLaunchContext.threadId !== activeThreadId ||
      !terminalUiState.terminalOpen ||
      (activeProjectCwd !== null &&
        projectScriptCwd({
          project: { cwd: activeProjectCwd },
          worktreePath: activeThreadWorktreePath,
        }) === terminalUiLaunchContext.cwd &&
        (activeThreadWorktreePath ?? null) === terminalUiLaunchContext.worktreePath))
  ) {
    setTerminalUiLaunchContext(null);
  }

  // Entering a thread with its drawer open focuses the drawer terminal; opening
  // it from a handler requests focus there. A closed drawer leaves focus to the
  // composer effect above.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the open drawer terminal when entering a thread
  useEffect(() => {
    if (activeThreadRef) return focusTerminalOnThreadEnter(activeThreadRef);
  }, [activeThreadRef]);

  const getShortcutContext = (eventTarget: EventTarget | null = document.activeElement) => ({
    terminalFocus: getTerminalFocusOwner() !== null,
    terminalOpen: Boolean(terminalUiState.terminalOpen),
    previewFocus: isPreviewFocused(),
    previewOpen: previewPanelOpen,
    editableFocus: isEditableFocused(eventTarget),
    modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
    composerFocus: document.activeElement?.getAttribute("data-testid") === "composer-editor",
    draftThreadRoute: routeKind === "draft",
    turnRunning: phase === "running",
    composerRequiresModifier: composerRequiresModifier(settings.sendShortcut, promptRef.current),
    isWeb: !isElectron,
    isDesktop: isElectron,
  });
  const getShortcutContextStable = useStableCallback(getShortcutContext);
  // SCIENT-FORK:START — messages present active Scient skills beside provider-native ones.
  const timelineSkills = effectiveActiveProviderSkills;
  // SCIENT-FORK:END
  const threadFindEnabled = isServerThread && serverConfig?.threadFind === true;
  const isThreadFindActive = useThreadFindOpen(activeThreadRef, threadFindEnabled);

  // SCIENT-FORK:START — side-panel tab shortcuts and duplicating a tab (scient/rightPanel)
  const panelTabs = usePanelTabShortcuts({
    threadRef: activeThreadRef,
    panelOpen: rightPanelOpen,
    surfaces: renderedRightPanelSurfaces,
    activeSurface: renderedRightPanelSurface,
    activate: activateRightPanelSurfaceStable,
    addNewTab: addNewTabSurface,
    canOperatePreview,
    browserAvailable,
    runAfterPendingFileSave,
    openPreview,
    previewSessions: activePreviewState.sessions,
    addTerminal: addTerminalSurfaceStable,
  });
  // SCIENT-FORK:END
  useChatShortcuts({
    enabled: activeThreadId !== null && !backgroundThread,
    keybindings,
    scriptKeybindings,
    getShortcutContext,
    threadFindActive: isThreadFindActive,
    composerRef,
    branchToolbarRef,
    closeThreadFind: () => {
      closeThreadFind();
      focusComposerStable();
    },
    commands: {
      ...terminalShortcuts,
      ...rightPanelShortcuts,
      ...threadLifecycleShortcuts,
      "thread.copyReference": ({ event }) => {
        if (!event.repeat) copyActiveThreadReference();
      },
      "chat.find": () => {
        if (!isServerThread || serverConfig?.threadFind !== true || activeThreadKey === null)
          return false;
        openThreadFind(activeThreadKey);
      },
      // SCIENT-FORK:START
      ...panelTabs.shortcuts,
      // SCIENT-FORK:END
      "composer.cycleHost": ({ event }) => {
        if (!canChangeEnvironment) return false;
        if (event.repeat) return;
        const currentId = readPendingEnvironmentChange()?.environmentId ?? environmentId;
        const index = logicalProjectEnvironments.findIndex(
          (env) => env.environmentId === currentId,
        );
        const next = logicalProjectEnvironments[(index + 1) % logicalProjectEnvironments.length];
        if (next) onEnvironmentChangeStable(next.environmentId);
      },
      "composer.branch": ({ event }) => {
        if (!event.repeat) branchToolbarRef.current?.openBranchPicker();
      },
      "composer.previousWorktree": ({ event }) => {
        if (!event.repeat) branchToolbarRef.current?.usePreviousWorktree();
      },
      "thread.steerQueuedMessage": ({ event }) =>
        routeKind !== "draft" && queuedRunsControlRef.current?.steerNext(event.repeat) === true,
      "thread.editQueuedMessage": ({ event }) =>
        routeKind !== "draft" &&
        // SCIENT-FORK:START — Edit Queued Message takes the latest message wherever the caret is.
        // SCIENT-FORK:END
        queuedRunsControlRef.current?.editLatest(event.repeat) === true,
      "thread.stop": ({ event }) => {
        if (!canInterruptRunningThread) return false;
        if (!event.repeat) void onInterruptStable();
      },
    },
    fallback: (command) => {
      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject || !canOperateTerminal) return undefined;
      const script = activeProjectScripts.find((entry) => entry.id === scriptId);
      return script ? () => void runProjectScriptStable(script) : undefined;
    },
  });

  // A focused desktop browser page forwards these chords as menu actions.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to desktop bridge menu actions that toggle the right panel
  useEffect(() => {
    return window.desktopBridge?.onMenuAction((action) => {
      if (action === "rightPanel.toggle") toggleRightPanelStable();
      else if (action === "rightPanel.toggleMaximized") toggleRightPanelMaximizedStable();
    });
  }, [toggleRightPanelStable, toggleRightPanelMaximizedStable]);

  usePasteToFocusComposer(activeThreadId, composerRef);
  const { onRevertToTurnCountStable, onRevertTimelineTurnStable } = useTimelineRewind({
    setPendingRevert,
    hasProjectWorkspace,
    environmentId,
    routeThreadRef,
    routeThreadKey,
    currentRouteThreadKeyRef,
    serverProjection,
    activeThread,
    timelineMessages,
    phase,
    isSendBusy,
    isRevertingCheckpoint,
    supportsConversationRollback,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    promptRef,
    composerRef,
    composerDraftTarget,
    setThreadError,
  });
  const onCompactContext = () => {
    if (compactDisabled) return;
    void sendStandaloneCommand("/compact", "Failed to compact context.");
  };

  const {
    getModelDisabledReason,
    handleInteractionModeChange,
    handleInteractionModeChangeStable,
    handleRuntimeModeChangeStable,
    onEnvModeChangeStable,
    onProviderModelSelectStable,
    onStartFromOriginChange,
    openProviderSetupStable,
    toggleInteractionModeStable,
  } = useComposerSelection({
    environmentId,
    composerDraftTarget,
    draftThread,
    activeThread,
    activeRuntime,
    activeProjectSettings,
    settings,
    providerStatuses,
    lockedProvider,
    supportsProviderSwitchingViaHandoff,
    multipleModelSelections,
    runtimeMode,
    interactionMode,
    interactionModeEnabled,
    isLocalDraftThread,
    canOverrideServerThreadEnvMode,
    setPendingServerThreadEnvModeEntry,
    setPendingServerThreadStartFromOriginByThreadId,
    scheduleComposerFocus,
  });
  const { onResume, isResuming } = useComposerResume({
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    activeThread,
    resumableRunId,
    hasHeldQueuedRuns,
    isSendBusy,
    isRevertingCheckpoint,
    threadDetailLoading,
    activeEnvironmentUnavailable,
    runtimeMode,
    interactionMode,
    localCheckoutBranchMismatch,
    composerRef,
    persistThreadSettingsForNextTurn,
    clearUsageLimitsFor,
    scrollToEnd,
    setThreadError,
  });
  const onImplementPlanInNewThread = useImplementPlanInNewThread({
    currentRouteThreadKeyRef,
    environmentId,
    routeThreadKey,
    activeThread,
    activeThreadBranch,
    activeProposedPlan,
    isServerThread,
    isSendBusy,
    composerRef,
    beginLocalDispatch,
    resetLocalDispatch,
    activeProject,
    activeEnvironmentUnavailable,
    defaultRuntimeMode,
  });
  const { onSend } = useComposerSend({
    queueEditsReady,
    queueContextKeyRef,
    serverProjection,
    hasHeldQueuedRuns,
    onForkConversation,
    captureSendReadingPosition,
    frameSubmittedMessage,
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    draftId,
    draftThread,
    activeThread,
    activeThreadKey,
    activeThreadBranch,
    activeProject,
    activeProjectDefaultModelSelection,
    activeProposedPlan,
    activeMessageCount,
    isServerThread,
    isLocalDraftThread,
    isGitRepo,
    phase,
    sendEnvMode,
    startFromOrigin,
    localCheckoutBranchMismatch,
    logicalProjectEnvironments,
    providerInstanceEntries,
    composerRef,
    composerDraftTarget,
    promptRef,
    feedbackUploadsInFlightRef,
    isRevertingCheckpoint,
    threadDetailLoading,
    activeEnvironmentUnavailable,
    isSendBusy,
    sendQueuesBehindSetup,
    isDraftHeroState,
    panelAnimationsActive,
    panelAnimationDurationMs,
    keepFullHistory,
    resumeCompactionTokens,
    showPlanFollowUpPrompt,
    usageLimitsKey,
    usageLimitsOffered,
    openUsageLimits,
    clearUsageLimitsFor,
    needsLoadBalancing,
    loadBalancing,
    readPendingEnvironmentChange,
    pendingApprovals,
    respondingRequestIds,
    activePendingProgress,
    onAdvanceActivePendingUserInput,
    onRespondToApproval: onRespondToApprovalStable,
    beginLocalDispatch,
    resetLocalDispatch,
    beginWorktreeSetup,
    captureDraftHeroComposerRect,
    setDockedDraftHeroThreadKey,
    setSetupQueueSendThreadKey,
    setOptimisticUserMessages,
    optimisticBlobPreviews: {
      track: (message) => optimisticBlobPreviews.track(threadId, message),
      release: (message) => optimisticBlobPreviews.release(threadId, message),
    },
    setFeedbackSubmissionsByThreadKey,
    setThreadError,
    setKeepFullHistory,
    acknowledgeActiveThreadWoke,
    handleInteractionModeChange,
    handleNewThreadInActiveProject,
    persistThreadSettingsForNextTurn,
  });
  const onImplementPlanInNewThreadStable = useStableCallback(onImplementPlanInNewThread);

  const onWorktreeSetupWorkLocally = () => {
    if (!worktreeSetup || worktreeSetup.phase !== "running" || !draftId) {
      return;
    }
    void cancelWorktreeSetup().then((cancelled) => {
      if (cancelled) setWorkLocallyResendDraftId(draftId);
    });
  };
  const onWorktreeSetupWorkLocallyStable = useStableCallback(onWorktreeSetupWorkLocally);
  const onComposerSendStable = onSend;
  const sendPreviewAnnotationStable = useStableCallback(
    (annotation: PreviewAnnotationPayload, image: ComposerImageAttachment | null) => {
      void onSend(undefined, "auto", "foreground", { annotation, image });
    },
  );
  const onComposerResumeStable = useStableCallback(onResume);
  const onComposerCompactContextStable = useStableCallback(onCompactContext);
  // SCIENT-FORK:START — the reading end owns scrolling; pending guest messages do not follow.
  const pendingGuestMessageCount =
    serverProjection?.thread.guestShare?.messages.filter((message) => message.status === "pending")
      .length ?? 0;
  // SCIENT-FORK:END

  const queuedRunsControl =
    isServerThread && activeThread ? (
      <>
        <QueuedRunsControl
          ref={queuedRunsControlRef}
          steerShortcutLabel={shortcutLabelForCommand(keybindings, "thread.steerQueuedMessage", {
            context: { terminalFocus: false },
          })}
          editShortcutLabel={shortcutLabelForCommand(keybindings, "thread.editQueuedMessage", {
            context: { composerFocus: true },
          })}
          environmentId={activeThread.environmentId}
          threadId={activeThread.id}
          optimisticMessages={optimisticUserMessages}
          // SCIENT-FORK:START — queued edits live in Scient edit sessions (scient/threadQueue/editSession).
          error={legacyQueueRecoveryError ?? queueEditStorageError}
          editingRunId={queueEdit?.nativeRun?.runId ?? null}
          onEditQueuedRun={beginEditingQueuedRunStable}
          onCancelEdit={() => {
            if (queueEdit)
              void stashRecoveredDraft(queueEdit).catch((cause) =>
                setThreadError(threadId, chatActionErrorMessage(cause)),
              );
          }}
          // SCIENT-FORK:END
          editBlockedReason={queuedRunEditBlockedReason({
            openQuestionCount: pendingUserInputs.length,
          })}
          timestampFormat={timestampFormat}
          onOpenThread={onOpenRelatedThreadStable}
        />
      </>
    ) : null;

  const resendAfterWorkLocallyStable = useStableCallback(() => {
    setWorkLocallyResendDraftId(null);
    void onComposerSendStable();
  });
  const workLocallyResendReady =
    workLocallyResendDraftId !== null &&
    workLocallyResendDraftId === draftId &&
    isLocalDraftThread &&
    !isSendBusy &&
    !isRevertingCheckpoint &&
    !threadDetailLoading &&
    clientSettingsHydrated &&
    !needsLoadBalancing &&
    !activeEnvironmentUnavailable &&
    !activePendingProgress &&
    !feedbackUploading;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- switches the draft to local mode, then resends the waiting message once sending is idle
  useEffect(() => {
    if (
      !workLocallyResendReady ||
      sendInFlightRef.current ||
      feedbackUploadsInFlightRef.current.has(routeThreadKey)
    ) {
      return;
    }
    if (sendEnvMode !== "local") {
      setDraftThreadContext(composerDraftTarget, { envMode: "local", startFromOrigin: false });
      return;
    }
    resendAfterWorkLocallyStable();
  }, [
    composerDraftTarget,
    feedbackUploadsInFlightRef,
    resendAfterWorkLocallyStable,
    sendInFlightRef,
    routeThreadKey,
    sendEnvMode,
    setDraftThreadContext,
    workLocallyResendReady,
  ]);

  const onExpandTimelineImage = (preview: ExpandedImagePreview) => {
    openExpandedImagePreview(routeThreadKey, preview);
  };
  const onExpandTimelineImageStable = useStableCallback(onExpandTimelineImage);
  // SCIENT-FORK:START — timeline row fork actions.
  const { onForkAssistantMessage, onForkUserMessage, onForkFromRun } = createForkMessageCommands({
    activeThreadId,
    activeThreadEnvironmentId,
    setForkCommandTarget,
    activeRunningTurnId,
    readTimelineEntries: readLiveTimelineEntries,
  });
  const onForkFromRunStable = useStableCallback(onForkFromRun);
  // SCIENT-FORK:END
  // SCIENT-FORK: a landing fork hides its sync status until its rows are positioned.
  const shownThreadSyncPhase =
    activeEnvironmentUnavailable || forkLandingReveal.syncStatusHidden
      ? null
      : delayedThreadSyncPhase;
  const hasThreadNow =
    childInputNow !== null ||
    backgroundWorkNow !== null ||
    goalNow !== null ||
    shownThreadSyncPhase !== null;
  const queuedRunCount = serverProjection ? getUserQueuedThreadRuns(serverProjection).length : 0;
  // The queue control is mounted for every server thread but joins the footer only while it shows
  // something, by its own rule: an optimistic message stops counting once the server has it.
  const hasQueuedTurns =
    queuedRunCount > 0 ||
    optimisticUserMessages.some(
      (message) =>
        // SCIENT-FORK: admission previews wait in the queue until the receipt places them.
        (message.inputIntent === "queued_turn" || message.queueAdmission !== undefined) &&
        !serverProjection?.messages.some((committed) => committed.id === message.id),
    ) ||
    // SCIENT-FORK: queue notices and a detached queued edit show without queued rows.
    (legacyQueueRecoveryError ?? queueEditStorageError ?? null) !== null ||
    (queueEdit?.nativeRun?.runId ?? null) !== null;
  const scrollToEndSummary =
    [
      childInputNow === null ? null : "Subagent waiting",
      queuedRunCount === 0 ? null : `${queuedRunCount} queued`,
    ]
      .filter((part) => part !== null)
      .join(" · ") || null;
  // The end of the timeline holds the thread's present and next turns: what it is doing now,
  // its lifecycle status, guest messages awaiting you, then your queued messages.
  const timelineFooter =
    pendingHandoff === null &&
    !hasThreadNow &&
    threadStatusLine === null &&
    pendingGuestMessageCount === 0 &&
    // SCIENT-FORK:START — Scient Accounts: sign-ins waiting for the user.
    accountHandoffs.handoffs.length === 0 &&
    // SCIENT-FORK:END
    !hasQueuedTurns ? null : (
      <>
        {pendingHandoff === null ? null : (
          <div className="chat-content-lane">
            <HandoffRow
              environmentId={environmentId}
              endpoints={pendingHandoff}
              providers={providerStatuses}
              pending
            />
          </div>
        )}
        <ThreadNow
          key={routeThreadKey}
          attention={childInputNow}
          work={backgroundWorkNow}
          syncPhase={shownThreadSyncPhase}
          goal={goalNow}
        />
        {/* SCIENT-FORK:START — Scient Accounts: sign-ins waiting for the user. */}
        {activeThread ? (
          <ThreadAccountHandoffs
            environmentId={activeThread.environmentId}
            handoffs={accountHandoffs.handoffs}
            canWrite={accountHandoffs.canWrite}
          />
        ) : null}
        {/* SCIENT-FORK:END */}
        {threadStatusLine}
        {pendingGuestMessageCount > 0 && isServerThread && activeThread ? (
          <GuestPendingMessages
            threadRef={scopeThreadRef(activeThread.environmentId, activeThread.id)}
            onImageExpand={onExpandTimelineImageStable}
            onFileOpen={openFileAttachmentStable}
          />
        ) : null}
        {hasQueuedTurns ? queuedRunsControl : null}
      </>
    );
  const pendingSidebarFileDrops = useSidebarPendingFileDropStore((state) => state.pending);
  const consumePendingFileDrop = useSidebarPendingFileDropStore(
    (state) => state.consumePendingFileDrop,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands pending sidebar file drops to the composer's imperative API once it mounts
  useEffect(() => {
    if (pendingSidebarFileDrops.length === 0) return;
    if (
      typeof composerDraftTarget === "string" ||
      !pendingSidebarFileDrops.some((drop) =>
        isSameSidebarThreadRef(composerDraftTarget, drop.threadRef),
      )
    ) {
      return;
    }
    if (!activeThread) return;
    if (!composerRef.current) {
      const raf = window.requestAnimationFrame(() => {
        if (!composerRef.current || typeof composerDraftTarget === "string") return;
        const files = consumePendingFileDrop(composerDraftTarget);
        if (files !== null) composerRef.current?.addDroppedFiles(files);
      });
      return () => window.cancelAnimationFrame(raf);
    }
    const files = consumePendingFileDrop(composerDraftTarget);
    if (files !== null) composerRef.current.addDroppedFiles(files);
  }, [
    activeThread,
    composerDraftTarget,
    composerRef,
    consumePendingFileDrop,
    pendingSidebarFileDrops,
  ]);

  const addDroppedFilesToComposer = useStableCallback(
    (files: Parameters<ChatComposerHandle["addDroppedFiles"]>[0]) =>
      composerRef.current?.addDroppedFiles(files),
  );
  const addDroppedFoldersToComposer = useStableCallback(
    (folders: Parameters<ChatComposerHandle["addDroppedFolders"]>[0]) =>
      composerRef.current?.addDroppedFolders(folders),
  );

  if (!activeThread) {
    // SCIENT-FORK: a landing fork's shell is on its way; the pane stays plain meanwhile.
    return forkLanding.pending ? null : <NoActiveThreadState />;
  }

  const rightPanelContent = activeThreadRef ? (
    // SCIENT-FORK:START — the agents panel and Scient-owned surfaces render from their modules.
    renderedRightPanelSurface?.kind === "agents" ? (
      <AgentsPanel
        model={agentPanelModel}
        environmentId={activeThreadRef.environmentId}
        threadId={activeThreadRef.threadId}
      />
    ) : renderedRightPanelSurface?.kind === "scient" ? (
      <ScientRightPanelContent
        surface={renderedRightPanelSurface}
        activeThreadRef={activeThreadRef}
        activeThread={activeThread}
        activeProject={activeProject}
        activeWorkspaceRoot={activeWorkspaceRoot}
        availableEditors={availableEditors}
        keybindings={keybindings}
        closeRightPanelSurface={closeRightPanelSurface}
        openScientSourcePdf={openScientSourcePdf}
        openFileSourceSurface={openFileSourceSurface}
      />
    ) : (
      // SCIENT-FORK:END
      <RightPanelSurfaceContent
        surface={renderedRightPanelSurface}
        activeSurfaceId={activeRightPanelSurface?.id ?? null}
        threadRef={activeThreadRef}
        environmentId={activeThread.environmentId}
        visible={rightPanelOpen}
        composerDraftTarget={composerDraftTarget}
        keybindings={keybindings}
        configuredPreviewUrls={configuredPreviewUrls}
        workspaceMutationId={workspaceMutationId}
        getShortcutContext={getShortcutContextStable}
        onSendAnnotation={sendPreviewAnnotationStable}
        onCloseSurface={closeRightPanelSurface}
        terminal={{
          launchContext: activeTerminalLaunchContext ?? null,
          keybindings,
          onAddTerminalContext: addTerminalContextToDraftStable,
          onSplitTerminal: splitPanelTerminalStable,
          onSplitTerminalVertical: splitPanelTerminalVerticalStable,
          onNewTerminal: addTerminalSurfaceStable,
          onActiveTerminalChange: activatePanelTerminalStable,
          onCloseTerminal: closePanelTerminalStable,
          splitShortcutLabel: splitTerminalShortcutLabel ?? undefined,
          splitVerticalShortcutLabel: splitTerminalVerticalShortcutLabel ?? undefined,
          newShortcutLabel: newTerminalShortcutLabel ?? undefined,
          closeShortcutLabel: closeTerminalShortcutLabel ?? undefined,
        }}
        pullRequest={{
          capabilityKnown: pullRequestsCapabilityKnown,
          supported: supportsPullRequests,
          projectId: activeThread.projectId,
          pullRequests: visiblePullRequests,
          linkedPullRequest: linkedThreadPullRequest,
          branchPullRequest: activeThreadShell?.branchPullRequest ?? activeThread.branchPullRequest,
          onBack:
            pullRequestsSurfaceAvailable && visiblePullRequestCount > 1
              ? addPullRequestsSurfaceStable
              : undefined,
        }}
        files={{
          projectName: activeProject?.title ?? null,
          workspaceRoot: activeWorkspaceRoot,
          availableEditors,
          pendingSurfaceIds: pendingFileSurfaceIds,
          onOpenFile: openFileSurfaceStable,
          onPendingChange: handleFilePendingChangeStable,
          // SCIENT-FORK:START — citations, presentation requests, in-place renames and sources.
          scientPanelProps: (surface) =>
            scientFilePanelProps(surface, {
              projectName: activeProject?.title ?? null,
              workspaceRoot: activeWorkspaceRoot,
              onCiteFile: (citation, anchor) =>
                composerRef.current?.citeText(citation, anchor) ?? false,
              // A rename carries the tab's Back and Forward history with it.
              onFileRenamed: (fromPath, toPath) =>
                renameInTabHistory(activeThreadRef, fromPath, toPath, () =>
                  useRightPanelStore
                    .getState()
                    .renameFileSurface(activeThreadRef, fromPath, toPath),
                ),
              onFileMoved: (fromPath, toPath) =>
                renameInTabHistory(activeThreadRef, fromPath, toPath, () =>
                  useRightPanelStore
                    .getState()
                    .renameFileSurface(activeThreadRef, fromPath, toPath, { keepState: true }),
                ),
              onOpenFileSource: openFileSourceSurface,
              onHtmlPresentationRequestHandled: handleHtmlPresentationRequestHandled,
              onLatexPresentationRequestHandled: handleLatexPresentationRequestHandled,
            }),
          // SCIENT-FORK:END
        }}
      />
    )
  ) : null;
  const panelToggleControlProps = {
    terminalAvailable: activeProject !== null,
    terminalOpen: terminalUiState.terminalOpen,
    terminalShortcutLabel: shortcutLabelForCommand(keybindings, "terminal.toggle"),
    threadPanelOpen,
    threadPanelPresentation,
    threadPanelPopoverHandle,
    threadPanelShortcutLabel: shortcutLabelForCommand(keybindings, "threadPanel.toggle"),
    rightPanelAvailable: activeProject !== null,
    rightPanelOpen,
    rightPanelShortcutLabel: shortcutLabelForCommand(keybindings, "rightPanel.toggle"),
    onToggleTerminal: toggleTerminalVisibilityStable,
    onToggleThreadPanel: toggleThreadPanelStable,
    onToggleRightPanel: toggleRightPanelStable,
  } satisfies PanelLayoutControlsProps;
  const panelToggleControls = (
    <PanelLayoutControls
      {...panelToggleControlProps}
      showThreadPanelControl={!inlineRightPanelOwnsTitleBar}
    />
  );
  const threadPanelHeaderControl = <ThreadPanelHeaderControl {...panelToggleControlProps} />;
  const panelLayoutControls = (
    <WorkspaceTitlebarControls
      showMaximizeControl={!shouldUsePlanSidebarSheet}
      rightPanelOpen={rightPanelOpen}
      animationsActive={panelAnimationsActive}
      maximized={rightPanelMaximized}
      onToggleMaximized={toggleRightPanelMaximizedStable}
    >
      {panelToggleControls}
    </WorkspaceTitlebarControls>
  );
  const workspaceFileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: setIsWorkspaceFileDragActive,
    addFiles: addDroppedFilesToComposer,
    addFolders: addDroppedFoldersToComposer,
  });

  const content = (
    <div
      ref={setWorkspaceLayoutElement}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      <ThreadAnswerAcknowledgement threadRef={routeThreadDetailRef} />
      <DeviceSetupDialogHost
        threadKey={activeThreadKey}
        threadRef={activeThreadRef}
        state={deviceState}
      />
      {rightPanelControlsAtRoot ? panelLayoutControls : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
          rightPanelMaximized ? "w-0 flex-none" : "flex-1",
        )}
        data-chat-column-maximized-away={rightPanelMaximized ? "true" : "false"}
        data-chat-column
        inert={rightPanelMaximized}
      >
        <header
          ref={threadPanelPopoverAnchorRef}
          data-chat-header
          className={cn(
            "relative bg-background [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
            isElectron
              ? cn(
                  "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 sm:px-5",
                  reserveTitleBarControlInset &&
                    !inlineRightPanelOwnsTitleBar &&
                    "wco:pr-(--workspace-native-controls-inset)",
                )
              : "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {isElectron && rightPanelControlsAtRoot ? (
            <span
              aria-hidden
              className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
            />
          ) : null}
          {!rightPanelControlsAtRoot && !rightPanelControlsInPanel ? panelLayoutControls : null}
          {inlineRightPanelOwnsTitleBar ? threadPanelHeaderControl : null}
          <ChatHeader
            activeThreadEnvironmentId={activeThread.environmentId}
            activeThreadId={activeThread.id}
            conversationImport={
              activeServerThread?.source.conversationImport ??
              activeServerThread?.source.forkLineage?.sourceImport ??
              null
            }
            importSessionStarted={activeServerThread?.activeProviderThreadId != null}
            isServerThread={isServerThread}
            activeThreadTitle={activeThread.title}
            activeThreadLinkOrigin={activeThreadShell?.linkOrigin?.label ?? null}
            activeProject={activeProject ?? null}
            parentThreadLink={headerParentThreadLink}
            onOpenThread={onOpenRelatedThreadStable}
            rightPanelOpen={inlineRightPanelOwnsTitleBar}
            onNewThreadInProject={handleNewThreadInActiveProjectStable}
            {...(activeDraftLogicalProjectKey
              ? { onOpenProjectSettings: handleOpenDraftProjectSettingsStable }
              : {})}
          />
        </header>

        <div className="relative flex min-h-0 min-w-0 flex-1">
          <ThreadFindCanvas
            findOptions={{
              skills: timelineSkills,
              progressive: serverConfig?.threadFindProgressive === true,
              thread: activeThreadRef,
              enabled: threadFindEnabled,
            }}
            store={chatCanvasStore}
            threadRef={activeThreadRef}
            preview={canvasPreview}
            detailsCardTopInset={isThreadFindActive ? THREAD_FIND_BAR_RESERVED_HEIGHT : 0}
            composerOverlayElement={isDraftHeroState ? null : composerOverlayElement}
            data-chat-workspace-drop-target="true"
            onDragEnter={workspaceFileDropHandlers.onDragEnter}
            onDragOver={workspaceFileDropHandlers.onDragOver}
            onDragLeave={workspaceFileDropHandlers.onDragLeave}
            onDrop={workspaceFileDropHandlers.onDrop}
          >
            <ThreadFind onClose={focusComposerStable} />
            {isWorkspaceFileDragActive ? <WorkspaceFileDropOverlay /> : null}
            <ChatBannerLane
              providerStatus={visibleProviderStatus}
              providerStatusBannerKey={providerStatusBannerKey}
              setDismissedProviderStatusBannerKey={setDismissedProviderStatusBannerKey}
              onOpenProviderSetup={openProviderSetupStable}
              threadId={activeThread.id}
              threadError={timelineThreadError}
              threadErrorClass={
                threadErrorIsServerRuntimeError ? (serverRuntime?.lastErrorClass ?? null) : null
              }
              threadErrorCode={
                threadErrorIsServerRuntimeError ? (serverRuntime?.lastErrorCode ?? null) : null
              }
              threadErrorBannerKey={threadErrorBannerKey}
              setThreadError={setThreadError}
              setThreadErrorBannerDismissTick={setThreadErrorBannerDismissTick}
            />
            <div
              {...conversationArea}
              // SCIENT-FORK:START — a fork landing stays inert and hidden until it is positioned.
              inert={forkLanding.pending}
              className={cn(
                "relative flex min-h-0 flex-1 flex-col bg-background",
                forkLandingReveal.messagesClassName,
              )}
              // SCIENT-FORK:END
            >
              <ThreadTimeline
                pendingApprovals={pendingApprovals}
                heldApprovalRequestIds={heldApprovalRequestIds}
                respondingRequestIds={respondingRequestIds}
                onRespondToApproval={onRespondToApprovalStable}
                canOperateThread={canOperateThread}
                // SCIENT-FORK:START — the agents panel.
                agentPanelModel={agentPanelModel}
                onOpenAgents={addAgentsSurface}
                // SCIENT-FORK:END
                threadDetailRef={routeThreadDetailRef}
                entriesInput={timelineEntriesInput}
                draftEntries={isServerThread ? null : draftTimelineEntries}
                activeThreadKey={activeThreadKey}
                syncing={threadSyncPhase !== null}
                detailLoading={threadDetailLoading}
                citationRequest={citationRequest}
                citationHistory={citationHistory}
                onCiteAssistantText={citeAssistantTextStable}
                {...(activeProject ? { onRunShellCommand: runShellCommandStable } : {})}
                // SCIENT-FORK:START — the working row waits for the sent prompt and its run's start.
                isWorking={timelineWorking}
                // SCIENT-FORK:END
                runlessWorkActive={runlessWorkStartedAt !== null}
                isCompacting={isCompacting}
                awaitingUser={
                  activePendingApproval !== null
                    ? "approval"
                    : activePendingUserInput !== null ||
                        // A secret request has no runtime request; the shell carries it.
                        activeThreadShell?.hasPendingUserInput === true
                      ? "input"
                      : null
                }
                awaitingRequestId={
                  activePendingApproval?.requestId ?? activePendingUserInput?.requestId ?? null
                }
                activeTurnStartedAt={activeWorkStartedAt}
                worktreeSetup={worktreeSetup}
                onCancelWorktreeSetup={onCancelWorktreeSetupStable}
                retryableWorkspacePreparationRunIds={retryableWorkspacePreparationRunIds}
                onRetryWorkspacePreparation={onRetryWorkspacePreparationStable}
                {...(draftId
                  ? { onWorktreeSetupWorkLocally: onWorktreeSetupWorkLocallyStable }
                  : {})}
                {...(onOpenWorktreeSetupTerminal ? { onOpenWorktreeSetupTerminal } : {})}
                isPreparingWorktree={isPreparingWorktree}
                footer={timelineFooter}
                listRef={legendListRef}
                runs={serverProjection?.runs ?? []}
                latestRun={activeActivityRun}
                announcedRun={announcedRun(activeActivityRun, serverProjection?.runs ?? [])}
                // The detail's own run: activeLatestRun falls back to the shell's run while the
                // detail loads, which would make that incomplete frame look current.
                detailBehindShell={isDetailBehindShell(
                  serverLatestRun,
                  activeThreadShell?.latestRun ?? null,
                )}
                runningRunId={activeRunningTurnId}
                turnDiffSummaries={turnDiffSummaries}
                activeThreadEnvironmentId={
                  displayedThreadRef?.environmentId ?? activeThread.environmentId
                }
                routeThreadKey={displayedTimelineKey}
                displayThreadKey={displayedTimelineKey}
                announceTurnStatus={!isProviderSubagent}
                onOpenToolDiff={onOpenToolDiffStable}
                onOpenTurnDiff={onOpenTurnDiffStable}
                onOpenThread={onOpenRelatedThreadStable}
                parentThreadLink={parentThreadLink}
                workflowOpening={workflowOpening}
                onForkFromRun={onForkFromRunStable}
                supportsConversationRollback={supportsConversationRollback}
                threadStartCheckpointReady={threadStartCheckpointReady}
                availableRevertTurnCounts={availableRevertTurnCounts}
                onRevertToTurnCount={onRevertTimelineTurnStable}
                onUseArtifactTemplate={insertArtifactTemplateStable}
                onSendAppMessage={sendAppMessageStable}
                // A fork being prepared copies this history: no rewinding until it is done.
                isRevertingCheckpoint={isRevertingCheckpoint || isForkingThread}
                // SCIENT-FORK:START — conversation fork actions.
                hasForkBaseline={hasForkBaseline}
                forkOriginThreadId={forkOriginThreadId}
                forkBaselineAssistantMessageId={forkBaselineAssistantMessageId}
                onForkAssistantMessage={onForkAssistantMessage}
                onForkUserMessage={onForkUserMessage}
                // SCIENT-FORK:END
                onImageExpand={onExpandTimelineImageStable}
                onFileOpen={openFileAttachmentStable}
                onFileDownload={downloadFileAttachmentStable}
                markdownCwd={gitCwd ?? undefined}
                resolvedTheme={resolvedTheme}
                timestampFormat={timestampFormat}
                workspaceRoot={activeWorkspaceRoot}
                skills={timelineSkills}
                anchorMessageId={timelineAnchorMessageId}
                onAnchorReady={onTimelineAnchorReadyStable}
                onAnchorSizeChanged={onTimelineAnchorSizeChangedStable}
                contentInsetEndAdjustment={composerTimelineInset}
                // SCIENT-FORK:START — no live-follow flag (the timeline never pins to its end);
                // placement in flight, the send follow (chat/responseFollow.ts) and releasing
                // unused reserved room.
                timelinePositioningPending={timelinePositioningPending}
                readingFollowPromptId={responseFollow.promptId}
                responseFollow={responseFollow.timeline}
                onReleaseUnusedAnchor={releaseUnusedTimelineAnchor}
                // SCIENT-FORK:END
                onIsAtEndChange={onIsAtEndChange}
                // SCIENT-FORK:START — the unread count below, for the Scroll to end control.
                onUnreadBelowChange={setUnreadBelowCount}
                // SCIENT-FORK:END
                // SCIENT-FORK:START — the reader's navigation cancels placement and the follow.
                onManualNavigation={cancelTimelinePositioning}
                // SCIENT-FORK:END
                cancelPositionRestoreRef={cancelPositionRestoreRef}
                // SCIENT-FORK:START
                onPositionedThreadKeyChange={forkLandingReveal.onPositionedThreadKeyChange}
                // SCIENT-FORK:END
                hideEmptyPlaceholder={isDraftHeroState || threadDetailLoading}
                // SCIENT-FORK:START — the restore waits for history, and may page in older turns.
                positionHistoryLoading={threadDetailLoading}
                // SCIENT-FORK:END
                emptyPlaceholderInset={composerReservedHeight}
                topFadeEnabled={!hasTimelineTopBanner}
                // SCIENT-FORK:START — older pages for the restore.
                loadEarlier={loadEarlierTurns}
                // SCIENT-FORK:END
                {...(threadHistoryControls === undefined
                  ? {}
                  : { historyControls: threadHistoryControls })}
              />

              {showScrollToBottom && !isThreadFindActive && (
                <div
                  className="chat-scroll-to-bottom pointer-events-none absolute z-30 flex justify-center py-1.5"
                  style={{ bottom: scrollToEndClearance + 4 }}
                >
                  <Button
                    data-scroll-to-end="true"
                    // SCIENT-FORK:START — the label says how many answers are unread below.
                    aria-label={
                      unreadBelowCount > 0
                        ? `Scroll to end, ${unreadBelowCount} unread ${unreadBelowCount === 1 ? "message" : "messages"} below`
                        : "Scroll to end"
                    }
                    // SCIENT-FORK:END
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => scrollToEnd(true)}
                    className="pointer-events-auto"
                    size="xs"
                    variant="glass"
                  >
                    <ChevronDownIcon className="size-3.5" />
                    Scroll to end
                    {scrollToEndSummary === null ? null : (
                      <span className="text-muted-foreground">
                        <span aria-hidden>· </span>
                        {scrollToEndSummary}
                      </span>
                    )}
                  </Button>
                  {/* SCIENT-FORK:START — the unread count badge. */}
                  {unreadBelowCount > 0 && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-info/20 bg-background/90 bg-linear-to-b from-info/5 to-info/5 px-1 text-3xs leading-none font-semibold text-info-foreground tabular-nums backdrop-blur-sm"
                    >
                      {unreadBelowCount > 99 ? "99+" : unreadBelowCount}
                    </span>
                  )}
                  {/* SCIENT-FORK:END */}
                </div>
              )}
            </div>

            <div
              {...composerArea}
              ref={setComposerOverlayElement}
              inert={isRevertingCheckpoint}
              data-chat-composer-overlay="true"
              className={
                isDraftHeroState
                  ? "pointer-events-none absolute inset-0 z-20 flex items-center"
                  : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
              }
            >
              <div ref={draftHeroTransitionGroupRef} className="chat-composer-lane w-full">
                <div
                  data-chat-composer-stack="true"
                  className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)"
                >
                  {isDraftHeroState ? (
                    <div className="absolute inset-x-0 bottom-full">
                      <div
                        className="pb-4 group-has-data-[composer-shoulder-tab]/composer-stack:pb-0"
                        style={
                          forceExpandedMobileComposer
                            ? { viewTransitionName: MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME }
                            : undefined
                        }
                      >
                        <DraftHeroHeadline
                          draftId={draftId}
                          activeProjectRef={activeProjectRef}
                          activeProjectTitle={activeProject?.title ?? null}
                        />
                      </div>
                    </div>
                  ) : null}
                  <div
                    ref={draftHeroComposerAnchorRef}
                    className="relative z-10"
                    style={
                      forceExpandedMobileComposer
                        ? { viewTransitionName: MOBILE_COMPOSER_VIEW_TRANSITION_NAME }
                        : undefined
                    }
                  >
                    {/* SCIENT-FORK:START — Scient Accounts: approvals belong to the active thread. */}
                    {activeThread ? (
                      <div className="mx-auto w-full max-w-3xl">
                        <ThreadAccountApprovals
                          environmentId={activeThread.environmentId}
                          threadId={activeThread.id}
                        />
                      </div>
                    ) : null}
                    {/* SCIENT-FORK:END */}
                    <ComposerSurface.Shell contextRow={showComposerContextStrip}>
                      <ComposerSurface.Host>
                        <div className="relative z-10">
                          {showProviderSubagentBar ? (
                            <ProviderSubagentBar
                              provider={selectedProviderEntry ?? null}
                              showInstanceBadge={
                                selectedProviderEntry !== undefined &&
                                shouldShowInstanceBadge(
                                  selectedProviderEntry,
                                  providerInstanceEntries,
                                )
                              }
                              modelLabel={providerSubagentModelLabel}
                              effortLabel={providerSubagentEffortLabel}
                              status={providerSubagentStatus}
                              onOpenParent={parentThreadLink?.open ?? null}
                            />
                          ) : null}
                          {!composerMounted ? null : (
                            <ChatComposer
                              key={composerTargetKey(composerDraftTarget)}
                              {...(queueEdit?.transferred || composerExtractedIntent
                                ? {
                                    onStashRecoveredDraft: () =>
                                      queueEdit?.transferred
                                        ? stashRecoveredDraft(queueEdit)
                                        : stashProvenanceDraft(composerDraftTarget),
                                  }
                                : {})}
                              canOperateThread={canOperateThread}
                              reportedModelSelection={reportedModelSelection}
                              multipleModelSelections={multipleModelSelections}
                              supportsMultipleModels={
                                serverConfig?.environment.capabilities.requiredWorktreeBootstrap ===
                                true
                              }
                              onMultipleModelSelectionsChange={setMultipleModelSelectionsStable}
                              composerRef={composerRef}
                              composerDraftTarget={composerDraftTarget}
                              environmentId={environmentId}
                              attachmentUploadsCapabilityKnown={attachmentUploadsCapabilityKnown}
                              supportsAttachmentUploads={supportsAttachmentUploads}
                              supportsQuestionAttachments={supportsQuestionAttachments}
                              maxFileAttachmentBytes={maxFileAttachmentBytes}
                              routeKind={routeKind}
                              routeThreadRef={routeThreadRef}
                              draftId={draftId}
                              activeThreadId={activeThreadId}
                              activeThread={activeThread}
                              activeThreadShell={activeThreadShell}
                              promptHistoryMessages={timelineMessages}
                              // SCIENT-FORK:START — conversation fork availability.
                              hasConversationMessages={hasConversationMessages}
                              // SCIENT-FORK:END
                              forceExpandedOnMobile={
                                forceExpandedMobileComposer && isDraftHeroState
                              }
                              projectSelectionRequired={
                                isLocalDraftThread &&
                                activeThread?.projectId !== null &&
                                activeProject === null
                              }
                              phase={phase}
                              isCompacting={isCompacting}
                              canInterrupt={canInterruptRunningThread}
                              // SCIENT-FORK:START — explicit Stop acknowledgement.
                              isStopping={isStopping}
                              // SCIENT-FORK:END
                              isSendBusy={
                                (isSendBusy && !sendQueuesBehindSetup) ||
                                (setupQueueSendThreadKey !== null &&
                                  setupQueueSendThreadKey === activeThreadKey) ||
                                isResuming ||
                                // SCIENT-FORK:START — sends wait for queued-edit sessions to load.
                                !queueEditsReady
                                // SCIENT-FORK:END
                              }
                              canResume={resumableRunId !== null || hasHeldQueuedRuns}
                              isRevertingCheckpoint={isRevertingCheckpoint}
                              sendDisabledReason={
                                !canOperateThread
                                  ? "This connection cannot change threads."
                                  : isEnvironmentChanging
                                    ? "Preparing machine"
                                    : isRevertingCheckpoint
                                      ? "Rewinding conversation"
                                      : feedbackUploading
                                        ? "Sending feedback"
                                        : threadDetailLoading
                                          ? "Messages loading"
                                          : worktreeSetupBlocksSend
                                            ? "Preparing worktree"
                                            : projectCloneSendBlockReason
                              }
                              isPreparingWorktree={isPreparingWorktree && !sendQueuesBehindSetup}
                              bannerItems={composerBannerItems}
                              resumeCompactionTokens={resumeCompactionTokens}
                              keepFullHistory={keepFullHistory}
                              onToggleKeepFullHistory={toggleKeepFullHistoryStable}
                              onUsageLimitsCommand={
                                usageLimitsOffered &&
                                usageLimitsKey !== null &&
                                !composerHasNonPromptContent
                                  ? openUsageLimits
                                  : undefined
                              }
                              environmentUnavailable={activeEnvironmentUnavailableState}
                              activePendingApproval={activePendingApproval}
                              pendingApprovals={pendingApprovals}
                              onHeldRequestIdsChange={onHeldRequestIdsChange}
                              pendingUserInputs={pendingUserInputs}
                              activePendingProgress={activePendingProgress}
                              activePendingResolvedAnswers={activePendingResolvedAnswers}
                              activePendingIsResponding={activePendingIsResponding}
                              activePendingDraftAnswers={activePendingDraftAnswers}
                              activePendingQuestionIndex={activePendingQuestionIndex}
                              respondingRequestIds={respondingRequestIds}
                              showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                              activeProposedPlan={activeProposedPlan}
                              threadSyncPhase={
                                activeEnvironmentUnavailable ? null : threadSyncPhase
                              }
                              runtimeMode={runtimeMode}
                              defaultRuntimeMode={defaultRuntimeMode}
                              interactionMode={interactionMode}
                              lockedProvider={modelPickerLockedProvider}
                              providerStatuses={providerStatuses as ServerProvider[]}
                              providerCatalogKnown={serverConfig !== null}
                              activeProjectDefaultModelSelection={
                                activeProjectDefaultModelSelection
                              }
                              activeThreadModelSelection={activeThread?.modelSelection}
                              activeProjectId={activeProject?.id ?? null}
                              activeContextWindow={activeContextWindow}
                              compactThreadUnavailable={compactThreadUnavailable}
                              compactDisabled={compactDisabled}
                              compactDisabledReason={compactDisabledReason}
                              resolvedTheme={resolvedTheme}
                              settings={settings}
                              keybindings={keybindings}
                              terminalOpen={Boolean(terminalUiState.terminalOpen)}
                              gitCwd={gitCwd}
                              pullRequestProjectId={
                                supportsPullRequests ? (activeProject?.id ?? null) : null
                              }
                              pullRequestRepository={
                                supportsPullRequests ? activeProjectRepository : null
                              }
                              threadPullRequests={(activeThreadShell ?? activeThread)?.pullRequests}
                              onComposerOverlayHeightChange={publishComposerOverlayHeightStable}
                              permissionsShownInStrip={showComposerContextStrip && !isServerThread}
                              promptRef={promptRef}
                              composerImagesRef={composerImagesRef}
                              composerFilesRef={composerFilesRef}
                              composerTerminalContextsRef={composerTerminalContextsRef}
                              onPageScrollKeyDown={onComposerPageScrollKeyDownStable}
                              onPageScrollKeyUp={onComposerPageScrollKeyUpStable}
                              onPageScrollRelease={onComposerPageScrollReleaseStable}
                              onCompactContext={onComposerCompactContextStable}
                              onSend={onComposerSendStable}
                              onResume={onComposerResumeStable}
                              onInterrupt={onInterruptStable}
                              onImplementPlanInNewThread={onImplementPlanInNewThreadStable}
                              // SCIENT-FORK:START — conversation fork from the composer.
                              onForkConversation={onForkConversation}
                              // SCIENT-FORK:END
                              onSelectActivePendingUserInputOption={
                                onSelectActivePendingUserInputOptionStable
                              }
                              onAdvanceActivePendingUserInput={
                                onAdvanceActivePendingUserInputStable
                              }
                              onDismissActivePendingUserInput={onDismissUserInputStable}
                              onPreviousActivePendingUserInputQuestion={
                                onPreviousActivePendingUserInputQuestionStable
                              }
                              onChangeActivePendingUserInputCustomAnswer={
                                onChangeActivePendingUserInputCustomAnswer
                              }
                              onProviderModelSelect={onProviderModelSelectStable}
                              onOpenProviderSetup={openProviderSetupStable}
                              getModelDisabledReason={getModelDisabledReason}
                              toggleInteractionMode={toggleInteractionModeStable}
                              handleRuntimeModeChange={handleRuntimeModeChangeStable}
                              handleInteractionModeChange={handleInteractionModeChangeStable}
                              focusComposer={focusComposerStable}
                              scheduleComposerFocus={scheduleComposerFocusStable}
                              setThreadError={setThreadError}
                              onExpandImage={onExpandTimelineImageStable}
                              onFileOpen={openFileAttachmentStable}
                            />
                          )}
                        </div>
                      </ComposerSurface.Host>
                      <div className="min-h-0">
                        <div
                          data-terminal-open={terminalUiState.terminalOpen ? "true" : undefined}
                          className="relative z-0"
                        >
                          {showComposerContextStrip && (
                            <div className="pointer-events-auto">
                              <BranchToolbar
                                forceNewWorktree={multipleModelSelections !== null}
                                ref={branchToolbarRef}
                                environmentId={activeThread.environmentId}
                                threadId={activeThread.id}
                                projectId={activeThread.projectId}
                                worktreePath={activeThread.worktreePath}
                                isServerThread={isServerThread}
                                showGitControls={isGitRepo}
                                {...(routeKind === "draft" && draftId ? { draftId } : {})}
                                onEnvModeChange={onEnvModeChangeStable}
                                startFromOrigin={startFromOrigin}
                                onStartFromOriginChange={onStartFromOriginChange}
                                envMode={envMode}
                                {...(canOverrideServerThreadEnvMode
                                  ? {
                                      activeThreadBranchOverride: activeThreadBranch,
                                      onActiveThreadBranchOverrideChange:
                                        setPendingServerThreadBranch,
                                    }
                                  : {})}
                                envLocked={envLocked}
                                onComposerFocusRequest={scheduleComposerFocusStable}
                                {...(canCheckoutPullRequestIntoThread
                                  ? { onCheckoutPullRequestRequest: openPullRequestDialogStable }
                                  : {})}
                                {...(canChangeEnvironment
                                  ? { onEnvironmentChange: onEnvironmentChangeStable }
                                  : {})}
                                autoEnvironmentLabel={autoEnvironmentLabel}
                                onAutoEnvironment={
                                  draftId &&
                                  !envLocked &&
                                  canAutoBalanceEnvironments &&
                                  loadBalancingSettings.loadBalancingEnabled
                                    ? onAutoEnvironmentStable
                                    : undefined
                                }
                                availableEnvironments={logicalProjectEnvironments}
                                {...(isServerThread
                                  ? {}
                                  : {
                                      trailing: (
                                        <ComposerContextPermissions
                                          runtimeMode={
                                            resolveCompatibleRuntimeMode(
                                              runtimeMode,
                                              activeProviderStatus?.supportedRuntimeModes,
                                            ).mode
                                          }
                                          onOpen={openComposerPermissionsStable}
                                        />
                                      ),
                                    })}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </ComposerSurface.Shell>
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* SCIENT-FORK:START — keeps open compute figures current. */}
            <ScientComputeFigureFollower
              activeThreadRef={activeThreadRef}
              activeWorkspaceRoot={activeWorkspaceRoot}
              openStaticArtifacts={openStaticArtifacts}
            />
            {/* SCIENT-FORK:END */}

            {canOperatePreview && activeThreadRef && activeEnvironmentServerBrowser ? (
              <PreviewSessionSync threadRef={activeThreadRef} />
            ) : null}
            {activeThreadRef && shownPreviewMiniPlayer ? (
              <ThreadPreviewMiniPlayer
                key={`${activeThreadKey}:${shownPreviewMiniPlayer.content.id}`}
                threadRef={activeThreadRef}
                miniPlayer={shownPreviewMiniPlayer}
              />
            ) : null}

            <BranchRestoreConfirmHost
              threadKey={activeThreadKey}
              threadBranch={localCheckoutBranchMismatch?.threadBranch ?? ""}
              canWriteSourceControl={canWriteSourceControl}
              onConfirm={handleSwitchCheckoutToThreadStable}
            />

            <ThreadDetailsPanel
              anchor={threadPanelPopoverAnchorRef}
              handle={threadPanelPopoverHandle}
              forceNewWorktree={multipleModelSelections !== null}
              environmentId={activeThread.environmentId}
              threadId={activeThread.id}
              projectId={activeThread.projectId}
              worktreePath={activeThread.worktreePath}
              isServerThread={isServerThread}
              {...(draftId ? { draftId } : {})}
              activeProjectName={activeProject?.title}
              activeProjectScripts={activeProject ? activeProjectScripts : undefined}
              preferredScriptId={
                activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
              }
              keybindings={keybindings}
              availableEditors={availableEditors}
              showOpenInPicker={showOpenInPicker}
              openInShortcutEnabled={
                !(
                  rightPanelOpen &&
                  renderedRightPanelSurface?.kind === "file" &&
                  renderedRightPanelSurface.attachment === undefined
                )
              }
              gitCwd={gitCwd}
              isGitRepo={isGitRepo}
              envLocked={envLocked}
              availableEnvironments={logicalProjectEnvironments}
              autoEnvironmentLabel={autoEnvironmentLabel}
              onAutoEnvironment={
                draftId &&
                !envLocked &&
                canAutoBalanceEnvironments &&
                loadBalancingSettings.loadBalancingEnabled
                  ? onAutoEnvironmentStable
                  : undefined
              }
              {...(canChangeEnvironment ? { onEnvironmentChange: onEnvironmentChangeStable } : {})}
              onEnvModeChange={onEnvModeChangeStable}
              envMode={envMode}
              {...(canOverrideServerThreadEnvMode
                ? {
                    activeThreadBranchOverride: activeThreadBranch,
                    onActiveThreadBranchOverrideChange: setPendingServerThreadBranch,
                  }
                : {})}
              startFromOrigin={startFromOrigin}
              onStartFromOriginChange={onStartFromOriginChange}
              {...(canCheckoutPullRequestIntoThread
                ? { onCheckoutPullRequestRequest: openPullRequestDialogStable }
                : {})}
              onComposerFocusRequest={scheduleComposerFocusStable}
              {...(isServerThread && isGitRepo
                ? { onOpenChanges: openChangesFromThreadPanelStable }
                : {})}
              onRunProjectScript={runProjectScriptStable}
              onAddProjectScript={saveProjectScriptStable}
              onUpdateProjectScript={updateProjectScriptStable}
              onDeleteProjectScript={deleteProjectScriptStable}
            />

            <PullRequestThreadDialogHost
              threadKey={activeThreadKey}
              environmentId={activeThread.environmentId}
              threadId={activeThread.id}
              cwd={activeProject?.workspaceRoot ?? null}
              onPrepared={handlePreparedPullRequestThreadStable}
            />
          </ThreadFindCanvas>
        </div>

        <ChatTerminalDrawers
          activeThreadKey={activeThreadKey}
          activeTerminalOpen={Boolean(terminalUiState.terminalOpen)}
          composerHeight={composerReservedHeight}
          launchContext={activeTerminalLaunchContext ?? null}
          splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
          splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
          newShortcutLabel={newTerminalShortcutLabel ?? undefined}
          closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
          keybindings={keybindings}
          onAddTerminalContext={addTerminalContextToDraftStable}
        />
      </div>

      {rightPanelPresent && activeThreadRef ? (
        <ChatRightPanel
          sheet={shouldUsePlanSidebarSheet}
          workspaceLayoutElement={workspaceLayoutElement}
          widthStorageKey={`t3code:preview-panel-width:${activeThreadKey}`}
          sheetAnimationDurationMs={panelAnimationsActive ? panelAnimationDurationMs : 0}
          onCloseSheet={closePreviewPanelStable}
          open={rightPanelOpen}
          keybindings={keybindings}
          getShortcutContext={getShortcutContextStable}
          maximized={rightPanelMaximized}
          layoutControls={
            rightPanelOpen ? (
              <div className="mr-px flex items-center gap-1">
                <RightPanelMaximizeControl
                  maximized={rightPanelMaximized}
                  onToggle={toggleRightPanelMaximizedStable}
                />
                {panelToggleControls}
              </div>
            ) : null
          }
          surfaces={renderedRightPanelSurfaces}
          environmentId={activeThreadRef.environmentId}
          activeSurfaceId={renderedRightPanelSurface?.id ?? null}
          pendingSurfaceIds={genericPendingFileSurfaceIds}
          attentionSurfaceIds={markdownAttentionSurfaceIds}
          previewSessions={activePreviewState.sessions}
          desktopByTabId={activePreviewState.desktopByTabId}
          previewRuntimeTabId={resolvePreviewRuntimeTabId}
          terminalLabelsById={activeTerminalLabelsById}
          onActivate={activateRightPanelSurfaceStable}
          onCloseSurface={closeRightPanelSurfaceStable}
          onRenameDevice={(surfaceId, title) => {
            if (activeThreadRef)
              useRightPanelStore.getState().renameDevice(activeThreadRef, surfaceId, title);
          }}
          onCloseOtherSurfaces={closeOtherRightPanelSurfacesStable}
          onCloseSurfacesToRight={closeRightPanelSurfacesToRightStable}
          onCloseAllSurfaces={closeAllRightPanelSurfacesStable}
          onMoveSurface={moveRightPanelSurfaceStable}
          onCopyFilePath={copyRightPanelFilePathStable}
          onAddBrowser={() => createBrowserSurface()}
          onAddBrowserInProfile={createBrowserSurfaceStable}
          onAddTerminal={addTerminalSurfaceStable}
          onAddDiff={addDiffSurfaceStable}
          onAddFiles={addFilesSurfaceStable}
          onAddPullRequest={addPullRequestSurfaceStable}
          onAddPullRequests={addPullRequestsSurfaceStable}
          onAddAgents={addAgentsSurface}
          onAddSources={addSourcesSurface}
          // SCIENT-FORK:START — "+" and its shortcut open the launcher as a tab
          onAddNewTab={addNewTabSurface}
          onDuplicateSurface={panelTabs.duplicateSurface}
          // SCIENT-FORK:END
          onAddDocuments={addDocumentsSurface}
          documentsAvailable={activeWorkspaceRoot !== undefined}
          onAddCompute={addComputeSurface}
          onAddDevice={addDeviceSurfaceStable}
          browserAvailable={canOperatePreview && browserAvailable}
          terminalAvailable={activeProject !== null && canOperateTerminal}
          diffAvailable={diffAvailable}
          filesAvailable={activeWorkspaceRoot !== undefined}
          pullRequestAvailable={pullRequestSurfaceAvailable}
          pullRequestsAvailable={pullRequestsSurfaceAvailable}
          agentsAvailable
          liveAgentCount={agentPanelModel.liveCount}
          sourcesAvailable={activeProject !== null && activeWorkspaceRoot !== undefined}
          computeAvailable={activeProject !== null && activeWorkspaceRoot !== undefined}
          deviceAvailable={activeThreadRef !== null}
        >
          {/* SCIENT-FORK:START — the project's file list can sit beside any tab */}
          {forkPdfContinuityPending ? null : (
            <PanelFilesLayout
              surface={renderedRightPanelSurface}
              environmentId={activeThreadRef.environmentId}
              cwd={activeWorkspaceRoot}
              projectName={activeProject?.title ?? null}
              workspaceMutationId={workspaceMutationId}
              onOpenFile={openFileSurfaceStable}
              onOpenFileSource={openFileSourceSurface}
            >
              {rightPanelContent}
            </PanelFilesLayout>
          )}
          {/* SCIENT-FORK:END */}
        </ChatRightPanel>
      ) : null}

      {/* SCIENT-FORK:START - retain the rewind dialog until the shared overlay host supports failure retention and file-history diagnostics. */}
      <AlertDialog
        open={pendingRevert !== null && pendingRevert.routeThreadKey === routeThreadKey}
        onOpenChange={(open) => {
          if (!open && !isRevertingCheckpoint) setPendingRevert(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Edit from here?</AlertDialogTitle>
            <AlertDialogDescription>
              Rewind chat to before this message. Your prompt and attachments return to the
              composer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ScientRevertDialogDiagnostics
            fileHistoryIssue={fileHistoryIssue}
            error={pendingRevert?.error}
          />
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button variant="outline" disabled={isRevertingCheckpoint} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={isRevertingCheckpoint}
              onClick={() => {
                if (!pendingRevert || pendingRevert.routeThreadKey !== routeThreadKey) return;
                void onRevertToTurnCountStable(
                  pendingRevert.turnCount,
                  pendingRevert.messageId,
                  true,
                );
              }}
            >
              Revert files too
            </Button>
            <Button
              disabled={isRevertingCheckpoint}
              onClick={() => {
                if (!pendingRevert || pendingRevert.routeThreadKey !== routeThreadKey) return;
                void onRevertToTurnCountStable(
                  pendingRevert.turnCount,
                  pendingRevert.messageId,
                  false,
                );
              }}
            >
              Revert and keep changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {/* SCIENT-FORK:END */}
      <LinkPullRequestDialogHost />
      {/* SCIENT-FORK:START — useAcknowledgeAnswer is the automatic visit writer; upstream's
          ThreadVisitWatermark would mark a background window or an unloaded answer read.
          Opens still rank threads in search, recorded without moving the watermark. */}
      <ThreadOpenRecorder threadRef={routeThreadRef} />
      {/* SCIENT-FORK:END */}
      <ExpandedImageDialogHost threadKey={routeThreadKey} />
      {/* SCIENT-FORK:START — the fork dialog. */}
      <ScientChatForkDialog
        fork={forkCommand}
        activeThread={activeThread}
        activeThreadId={activeThreadId}
        activeThreadEnvironmentId={activeThreadEnvironmentId}
        activeThreadRef={activeThreadRef}
        activeWorkspaceRoot={activeWorkspaceRoot}
        forkWorktreeAvailability={forkWorktreeAvailability}
      />
      {/* SCIENT-FORK:END */}
    </div>
  );
  return (
    <FileMetadataThreadProvider
      threadRef={activeThreadRef}
      cwd={activeWorkspaceRoot}
      checkpoints={serverProjection?.checkpoints}
    >
      {content}
    </FileMetadataThreadProvider>
  );
}

function PreviewSessionSync(props: { readonly threadRef: ScopedThreadRef }) {
  usePreviewSession(props.threadRef);
  return null;
}

// SCIENT-FORK: chat follows the user's content direction.
export default function ChatView(props: ChatViewProps) {
  const contentDirection = useClientSettings((settings) => settings.contentDirection);

  return (
    <ContentDirectionScope direction={contentDirection}>
      <ChatViewContent {...props} />
    </ContentDirectionScope>
  );
}
