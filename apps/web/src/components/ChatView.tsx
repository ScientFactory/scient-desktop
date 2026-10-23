import { useThreadSnoozeClock } from "./chat/useThreadSnoozeClock";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { prepareComposerContextMessage } from "../lib/composerContextSend";
import { stripInlineContextReferences } from "../lib/composerContextReferences";
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
import { useAcknowledgeAnswer } from "../scient/answerAttention/useAcknowledgeAnswer";
import { collectSelectedScientSkillNames } from "@t3tools/shared/composerInlineTokens";
import {
  queueSubmissionId,
  acknowledgeQueueSubmission,
  composerSubmissionMatchesDraft,
  consumeExtractedSubmission,
  type ExtractedSubmissionPacket,
} from "../scient/threadQueue/submission";
import {
  beginExtractedSubmission,
  extractedIntentActionErrors,
  prepareAndBindExtractedSubmission,
  retireAcknowledgedExtractedDraft,
} from "../scient/threadQueue/extractedIntentSend";
import type { ExtractedIntentRecord } from "../scient/threadQueue/editJournal";
import {
  beginQueueEdit,
  stashRecoveredDraft,
  finishQueueEdit,
  flushQueueEdit,
  loadQueueEdits,
  useQueueEditSessions,
  prepareExtractedDraftIntent,
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
import { threadShellFromProjection } from "@t3tools/shared/orchestrationV2ThreadShell";
import { CommandId, PlanId, type ProviderOptionSelection } from "@t3tools/contracts";
import { useFileCitationTarget } from "~/scient/markdownEditor/fileCitationNavigation";
import { composerCitationsToPlainText } from "@t3tools/shared/composerCitations";
import { isStandaloneForkSlashCommand } from "../composer-logic";
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
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import type { CitationHistoryPage } from "./chat/useAssistantCitationTarget";
import { useProjectScriptAutoPreview } from "./preview/useProjectScriptAutoPreview";
import {
  copyFilePathToClipboard,
  resolveFilePathCopyValue,
  type FilePathCopyFormat,
  type FileSurfacePath,
} from "./files/filePathClipboard";
import { AgentsPanel } from "./AgentsPanel";
import { randomHex, randomUUID } from "~/lib/utils";
import {
  useFilePresentationRequestHandlers,
  useScientRightPanelOpeners,
} from "~/scient/rightPanel/useScientRightPanelOpeners";
import { ScientRightPanelContent } from "~/scient/rightPanel/ScientRightPanelContent";
import { ThreadQueueStrip } from "~/scient/threadQueue/ThreadQueueStrip";
import {
  deriveQueueAcknowledgedUserMessages,
  pendingQueueAdmissionPreviews,
  settleQueueAdmissionPreview,
  shouldPreviewQueueAdmission,
  type OptimisticUserMessage,
} from "~/scient/threadQueue/optimisticQueuePresentation";
import { useThreadQueue } from "~/scient/threadQueue/useThreadQueue";
import {
  editQueuedMessageShortcut,
  steerQueuedMessageShortcut,
} from "~/scient/threadQueue/queueShortcuts";
import type { ScientThreadQueueItem } from "@t3tools/contracts";
import { ContentDirectionScope } from "../scient/bidi/ContentDirectionScope";
import {
  ScientRevertDialogDiagnostics,
  findFileHistoryIssue,
} from "../scient/chat/ScientRevertDialogDiagnostics";
import { scientFilePanelProps } from "../scient/fileSurfaces/scientFilePanelProps";
import { deriveAgentPanelModel } from "../scient/chat/useAgentPanelModel";
import { tokenLimitBannerItems, deriveTokenLimitNotice } from "../scient/chat/tokenLimitNotice";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
} from "./chat/composerProviderState";
import { resolveStaleDraftDefaultModelSelection } from "../lib/chatThreadActions";
import { flushComposerDraftPersistence } from "../composerDraftStore";

import {
  encodeQueueComposerSnapshot,
  assertQueueEditSelectionProvenance,
} from "../scient/threadQueue/composerSnapshot";

import { useThread } from "../state/entities";
import { type EditQueuedRunRequest } from "./chat/QueuedRunsControl";
import { useThreadTimelineEntries } from "./chat/useThreadTimelineEntries";
import { shouldCompactBeforeSend } from "./chat/ContextWindowMeter.logic";
import {
  getAntigravitySendBlockReason,
  snapshotComposerSend,
  planComposerTurn,
  boundAttachmentIds,
  optimisticMessageAttachments,
  sendTitleFallbackLabels,
  resolveThreadWorkspaceRoot,
} from "./ChatView.logic";
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

import { ThreadFind, ThreadFindCanvas, type ThreadFindControls } from "./chat/ThreadFindProvider";
import { THREAD_FIND_BAR_RESERVED_HEIGHT } from "./chat/ThreadFindBar";
import { usageLimitRecoveryBannerItem } from "./chat/UsageLimitRecoveryBanner";
import {
  isThreadWokeUnseen,
  mergeDirectPreviewAnnotation,
  resolveBackgroundDraftWorkspaceOptions,
  resolveDraftHeroState,
  shouldDockDraftHeroForSubmission,
} from "./ChatView.logic";

import {
  isPaintOnlyThreadTimeline,
  peekHeldThreadTimeline,
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resolveExplicitDiffOpenOnActivate,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
  recallCheckoutIsRepo,
  rememberCheckoutIsRepo,
} from "./ChatView.logic";
import { useLogicalProjectEnvironments } from "../hooks/useLogicalProjectEnvironments";
import { useStableCallback } from "../hooks/useStableCallback";
import { useProjectScriptEditing } from "./chat/useProjectScriptEditing";
import { RightPanelSurfaceContent } from "./chat/RightPanelSurfaceContent";
import { useThreadTerminalActions } from "./terminal/useThreadTerminalActions";
import { usePendingThreadRequests } from "./chat/usePendingThreadRequests";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import type { UsageLimitSourceSnapshots } from "@t3tools/contracts";
import { isUsageLimitsCommand } from "@t3tools/shared/usageLimits";
import { feedbackBannerItem } from "./chat/ComposerFeedback";
import { useUsageLimitsPanel } from "./chat/useUsageLimitsPanel";
import { useWorktreeSetup } from "./chat/useWorktreeSetup";
import { useChatShortcuts, type ChatShortcutHandler } from "./chat/useChatShortcuts";
import {
  pasteTextToFocusComposer,
  shouldRedirectInputToComposer,
} from "./chat/composerFocusRedirect";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import * as Schema from "effect/Schema";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthPreviewOperateScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  type AssistantCitation,
  type ChatFileAttachment,
  DEFAULT_MODEL,
  isProviderNativeSubagentThread,
  type EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderTurn,
  type ProjectScript,
  type PreviewAnnotationPayload,
  ProviderInstanceId,
  type ServerProvider,
  type ScopedThreadRef,
  type ThreadId,
  type RunId,
  type RunAttemptId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";

import { wasBootstrapThreadDeleted } from "@t3tools/client-runtime/errors";
import { readPastedComposerContext } from "./composerInlineTokenPaste";
import { isPasteAsTextShortcut } from "@t3tools/client-runtime/text-paste";
import { effectiveSnoozed, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { declineShownApprovalsBeforeSend } from "./chat/approvalSendGuard";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useAcknowledgeThreadWoke, useThreadActions } from "../hooks/useThreadActions";
import {
  deriveProviderSubagentStatus,
  deriveReportedModelSelection,
  formatModelSelectionEffort,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveLatestThreadRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import {
  resolveWorkflowOpening,
  workflowOpeningParentThreadId,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { threadSupportsProviderHandoff } from "@t3tools/client-runtime/state/thread-workflows";
import { resolvePendingHandoff } from "@t3tools/client-runtime/handoff";
import { HandoffRow } from "./chat/V2LifecycleRow";
import {
  parseCodexFeedbackCommand,
  shouldShowLoadEarlierControl,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { resolveThreadLastVisitedAt } from "./Sidebar.logic";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  createModelSelection,
  formatModelSlugName,
  resolveSelectableModel,
} from "@t3tools/shared/model";
import {
  projectScriptCwd,
  projectScriptTerminalInput,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  latestUnheldRun,
  usageLimitRunPresentedAsLatest,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import { truncate } from "@t3tools/shared/String";
import { resolveThreadReferenceCopyTarget } from "@t3tools/shared/threadReference";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { useAtomValue } from "@effect/atom-react";
import { type SetStateAction, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { assistantCitationFromLocation } from "../lib/assistantCitationNavigation";
import { isMacPlatform } from "../lib/utils";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { useShallow } from "zustand/react/shallow";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { useDiffPanelStore } from "../diffPanelStore";
import { useActiveThreadRef } from "../hooks/useActiveThreadRef";
import {
  type ComposerSubmissionIntent,
  collapseExpandedComposerCursor,
  composerRequiresModifier,
  parseStandaloneComposerSlashCommand,
} from "../composer-logic";
import {
  derivePhase,
  selectHandoffImageResources,
  deriveActivePlanState,
  selectComposerTasksPlan,
  deriveActiveWorkStartedAt,
  deriveCanInterruptRunningThread,
  findLatestProposedPlan,
  findRevertCheckpoint,
  hasActionableProposedPlan,
  isLatestRunSettled,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import { useUiStateStore } from "../uiStateStore";
import { useWorkspaceMutationRefresh } from "../hooks/useWorkspaceMutationRefresh";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import { DEFAULT_INTERACTION_MODE, MAX_TERMINALS_PER_GROUP, type ChatMessage } from "../types";
import { useTheme } from "../hooks/useTheme";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { settleAndAdvance } from "../settleAndAdvance";
import { subscribeSnapShotComposerFocus } from "../lib/desktopSnapShot";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { FileMetadataThreadProvider } from "../hooks/FileMetadataThreadProvider";
import {
  RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
  type ThreadPanelPresentation,
} from "../rightPanelLayout";
import { PopoverCreateHandle } from "./ui/popover";
import {
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadPanelOpen,
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  isPreviewSupportedInRuntime,
  setActivePreviewTab,
  useThreadPreviewState,
} from "../previewStateStore";
import { BrowserSettingsReadError } from "../browser/openFileInPreview";

import { previewRuntimeTabId } from "../browser/previewRuntimeTabId";
import { addBrowserSurface } from "./preview/addBrowserSurface";
// SCIENT-FORK:START
import { useBrowserHistoryProjectLink } from "~/scient/browser/useBrowserHistoryProjectLink";
import { renameInTabHistory, useRightPanelTabHistory } from "~/scient/rightPanel/tabHistory";
import {
  PanelFilesLayout,
  panelFilesToggleApplies,
  usePanelFilesOpen,
} from "~/scient/rightPanel/PanelFilesColumn";
import {
  adjacentPanelSurface,
  canDuplicatePanelSurface,
} from "~/scient/rightPanel/panelTabCommands";
import { duplicatePanelSurface } from "~/scient/rightPanel/panelTabDuplication";
// SCIENT-FORK:END
import { ThreadPreviewMiniPlayer } from "./preview/ThreadPreviewMiniPlayer";
import { usePreviewSession } from "./preview/usePreviewSession";
import { subscribePreviewAction } from "./preview/previewActionBus";
import { getConfiguredPreviewUrls } from "./preview/previewEmptyStateLogic";

import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../previewMiniPlayerStore";
import { threadPullRequestPanelTarget } from "./pullRequest/pullRequestDetail.logic";
import { LinkPullRequestDialogHost } from "./pullRequest/LinkPullRequestDialog";
import { useDeviceState } from "~/state/device";
import { BranchToolbar, type BranchToolbarHandle } from "./BranchToolbar";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import { isEditableFocused } from "../lib/editableFocus";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { shortcutLabelForCommand } from "../keybindings";
import {
  AlarmClockIcon,
  CheckCircle2Icon,
  PaperclipIcon,
  ChevronDownIcon,
  DownloadIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { projectScriptIdFromCommand } from "~/projectScripts";
import { newDraftId, newMessageId, newThreadId } from "~/lib/utils";
import { registerFaviconProjectForThread } from "~/browserFaviconStore";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  shouldShowInstanceBadge,
  sortProviderInstanceEntries,
} from "../providerInstances";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentSettings,
} from "../hooks/useSettings";
import { useNowMinute } from "../hooks/useNowMinute";
import { usePanelAnimationSettings, usePanelPresence } from "../panelAnimations";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useRemoveClonedProject } from "../hooks/useRemoveClonedProject";
import { useOpenPanelPullRequestUrl } from "../hooks/useOpenPanelPullRequestUrl";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import { confirmTerminalClose } from "../lib/terminalCloseConfirm";
import { isPreviewFocused } from "../lib/previewFocus";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import { findReusableProjectScriptTerminal } from "../lib/projectScriptTerminal";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import {
  isSameSidebarThreadRef,
  useSidebarPendingFileDropStore,
} from "../sidebarPendingFileDropStore";
import {
  beginBackgroundDraftSubmissionByRef,
  clearBackgroundDraftSubmissionByRef,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  restoreFailedDraftThread,
  composerDraftHasUserContent,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  DraftId,
} from "../composerDraftStore";
import { type TerminalContextDraft, type TerminalContextSelection } from "../lib/terminalContext";
import {
  collectInlineContextIds,
  ensureInlineContextReferences,
} from "../lib/composerContextReferences";
import {
  buildMessageContext,
  previewAnnotationContextReference,
} from "../lib/composerContextRecords";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useKnownTerminalSessions, useThreadRunningTerminalIds } from "../state/terminalSessions";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "~/state/session";
import {
  environmentServerConfigsAtom,
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  serverEnvironment,
} from "../state/server";
import { threadEnvironment } from "../state/threads";

import { vcsEnvironment } from "../state/vcs";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useProjectClone } from "../state/projectClones";
import { projectCloneDisplayName, projectCloneProgressSummary } from "@t3tools/contracts";
import { dismissProjectFileCopy, useProjectFileCopy } from "../lib/addProjectToMachine";
import {
  type EnvironmentPresentation,
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironment,
} from "../state/environments";
import {
  resolveThreadDetailRef,
  useEnvironmentSupportsServerBrowser,
  useProject,
  useThreadProjection,
  useThreadStatus,
  useThreadHistory,
  useQuietThreadShell,
  useChildThreadInputs,
  useThreadVisibleTurnItems,
  useThreadCheckpointSummaries,
  readThreadShell,
  waitForThreadShell,
} from "../state/entities";
import { environmentShell, useEnvironmentShellHasSnapshot } from "../state/shell";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";
import { ExpandedImageDialogHost, openExpandedImagePreview } from "./chat/ExpandedImageDialog";
import {
  BranchRestoreConfirmHost,
  DeviceSetupDialogHost,
  openBranchRestoreConfirm,
  openDeviceSetupDialog,
  openPullRequestThreadDialog,
  PullRequestThreadDialogHost,
} from "./chat/ChatOverlayHosts";
import type { AssistantCitationRequest } from "./chat/AssistantCitationSource";
import { MessagesTimeline, type MessagesTimelineHistoryControls } from "./chat/MessagesTimeline";
import { ProviderSubagentBar } from "./chat/ProviderSubagentBar";
import { getTriggerDisplayModelName } from "./chat/providerIconUtils";
import {
  overlayComposerIsResting,
  resolveComposerTimelineInset,
  resolveScrollToEndClearance,
} from "./composerFooterLayout";
import { ChatHeader } from "./chat/ChatHeader";
import { useRemoteOpenState } from "~/remoteOpen";
import { shouldShowOpenInPicker } from "./chat/OpenInPicker.logic";
import { useOpenFavoriteEditorShortcut } from "./chat/OpenInPickerShortcut";
import {
  PanelLayoutControls,
  type PanelLayoutControlsProps,
  RightPanelMaximizeControl,
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
  ProviderStatusBanner,
  shouldShowProviderStatusBanner,
} from "./chat/ProviderStatusBanner";
import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  ThreadErrorBanner,
} from "./chat/ThreadErrorBanner";
import { QueuedRunsControl, type QueuedRunsControlHandle } from "./chat/QueuedRunsControl";
import { useThreadLinkedPullRequest } from "./pullRequest/useThreadLinkedPullRequest";
import { useProactivePanels } from "../hooks/useProactivePanels";

import { useRightPanelSurfaceClose } from "../hooks/useRightPanelSurfaceClose";
import { useAgentOpenedPreviews } from "./preview/useAgentOpenedPreviews";
import type { ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import { ThreadStatusLine } from "./chat/ThreadStatusLine";
import { formatRelativeTimeLabel, formatRelativeTimeUntilLabel } from "../timestampFormat";
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
  runMobileComposerTransition,
} from "./chat/draftHeroTransition";
import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import {
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  collectUserMessageBlobPreviewUrls,
  deriveCommittedServerUserMessageIds,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  isBranchMismatchDismissedForSession,
  shouldShowBranchMismatchBanner,
  shouldShowPlanFollowUpPrompt,
  shouldRenderPreviewMiniPlayer,
  getStartedThreadModelChangeBlockReason,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  deriveLockedProvider,
  readFileAsDataUrl,
  resolveFileAttachmentUrl,
  resolveComposerInteractionMode,
  resolveComposerProviderSelection,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  startNewThreadForProject,
  codexArtifactTemplatePromptToAppend,
  waitForStartedServerThread,
  shouldRefocusComposerOnWindowFocus,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerHandleContext } from "../composerHandleContext";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "../lib/attachmentUploadQueue";
import { previewEnvironment } from "../state/preview";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { fileAttachmentCapabilityBlockReason } from "./chat/composerAttachmentFiles";
import { assetEnvironment } from "../state/assets";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { Button } from "./ui/button";
import { useAssetUrls } from "../assets/assetUrls";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  threadContextsOutsideEnvironment,
} from "@t3tools/shared/composerContextReferences";
import { observeResize } from "~/lib/observeResize";

import { ChatTerminalDrawers } from "./chat/ChatTerminalDrawers";
import { ChatRightPanel } from "./chat/ChatRightPanel";
import { useDraftEnvironmentRouting } from "./chat/useDraftEnvironmentRouting";
import {
  backgroundWorkBannerItem,
  branchMismatchBannerItem,
  childInputBannerItem,
  goalBannerItem,
} from "./chat/ThreadActivityBanners";
import { useTimelineFollow } from "./chat/useTimelineFollow";
import {
  type EnvironmentUnavailableState,
  useSystemComposerBanners,
} from "./chat/useSystemComposerBanners";
import { useDraftHeroLayoutTransition } from "./chat/useDraftHeroLayoutTransition";
import { useLocalDispatchState } from "./chat/useLocalDispatchState";
import {
  draftFanoutSelectionsAtom,
  draftSendState,
  rewindToMessage,
  startFanoutThread,
  restoreComposerDraft,
} from "./chat/chatViewSend";
import {
  chatActionErrorMessage,
  formatOutgoingPrompt,
  isCompactCommandMessage,
  type LocalThreadErrorEntry,
  makeModelDisabledReason,
  makeThreadErrorSetter,
} from "./ChatView.logic";

const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_MODELS: ServerProvider["models"] = [];
const EMPTY_USAGE_LIMIT_SOURCES: UsageLimitSourceSnapshots = [];
import type { CodexArtifactTemplate } from "@t3tools/shared/codexArtifactTemplates";

const EMPTY_FEEDBACK_SUBMISSIONS: ReadonlyArray<CodexFeedbackSubmission> = [];
const RELATED_THREAD_SHELL_WAIT_MS = 1_000;
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const EMPTY_AUTO_UPDATE_ENVIRONMENTS: ReadonlyArray<EnvironmentPresentation> = [];

const EMPTY_PENDING_FILE_SURFACE_IDS: ReadonlySet<string> = new Set();

const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

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

interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
}

const ENVIRONMENT_UNAVAILABLE_SEND_TOAST_TRAIL_SIZE = 3;
const EMPTY_HELD_TURN_DIFF_SUMMARIES: readonly never[] = [];
const noopHeldTurnDiff = (_turnId: RunId, _filePath?: string) => {};
const noopHeldRevert = (_targetTurnCount: number) => {};
const noopHeldAttachment = (_attachment: ChatFileAttachment) => {};

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
  const hasTerminalWriteAccess = () =>
    readEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canReadTerminal = useEnvironmentScope(environmentId, AuthTerminalReadScope);
  const draftId = routeKind === "draft" ? props.draftId : null;
  const handleNewThread = useNewThreadHandler();
  const { settleThread, pinThread, confirmAndUnpinThread } = useThreadActions();
  const routeThreadRef = scopeThreadRef(environmentId, threadId);
  const routeThreadKey = scopedThreadKey(routeThreadRef);
  const currentRouteThreadKeyRef = useRef<string | null>(routeThreadKey);
  useLayoutEffect(() => {
    currentRouteThreadKeyRef.current = routeThreadKey;
    return () => {
      currentRouteThreadKeyRef.current = null;
    };
  }, [routeThreadKey]);
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useOrchestrationCommand(threadEnvironment.delete, { reportFailure: false });
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const switchGitRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const setThreadRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const resumeThreadQueue = useOrchestrationCommand(threadEnvironment.resumeThreadQueue, {
    reportFailure: false,
  });
  const uploadThreadFeedback = useOrchestrationCommand(threadEnvironment.uploadFeedback, {
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
  const revertThreadCheckpoint = useOrchestrationCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
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
  const serverThreadProjection = useThreadProjection(routeThreadDetailRef);
  const serverProjection = serverThreadProjection?.projection ?? null;
  const serverThread = (() => {
    if (serverThreadShell !== null || serverProjection === null) {
      return serverThreadShell;
    }
    const latestRun = deriveLatestThreadRun(serverProjection);
    const runtime = deriveThreadRuntime(serverProjection);
    const pendingRuntimeRequest =
      serverProjection.runtimeRequests.findLast((request) => request.status === "pending") ?? null;
    // Direct links can hydrate detail before the thread enters the shell index.
    return {
      ...presentThreadShell(environmentId, {
        ...serverProjection.thread,
        latestRunId: latestRun?.runId ?? null,
        activeRunId: runtime?.activeRunId ?? null,
        status: runtime?.status ?? "idle",
        pendingRuntimeRequest,
        latestVisibleMessage: null,
        latestUserMessageAt:
          serverProjection.messages.findLast((message) => message.role === "user")?.updatedAt ??
          null,
        hasActionableProposedPlan: serverProjection.plans.some(
          (plan) => plan.kind === "proposed_plan" && plan.status === "active",
        ),
        providerInstanceHistory: [
          ...new Set(
            serverProjection.providerThreads
              .filter((thread) => thread.appThreadId === threadId && thread.ownerNodeId === null)
              .map((thread) => thread.providerInstanceId),
          ),
        ],
        goal:
          serverProjection.providerThreads.find(
            (thread) => thread.id === serverProjection.thread.activeProviderThreadId,
          )?.goal ?? null,
        itemCount: serverProjection.turnItems.length,
        visibleItemCount: serverProjection.visibleTurnItems.length,
        updatedAt: serverProjection.updatedAt,
      }),
      latestRun,
      runtime,
    };
  })();
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
  const activeProviderThread = serverProjection?.providerThreads.find(
    (thread) => thread.id === serverProjection.thread.activeProviderThreadId,
  );
  const activeThreadLiveTokenUsage = latestProviderTurnTokenUsage(
    serverProjection?.providerTurns ?? [],
    serverProjection,
    activeProviderThread,
  );
  const serverVisibleTurnItems = useThreadVisibleTurnItems(routeThreadDetailRef);
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
  // SCIENT-FORK:START — older pages for the reading-position restore and for citations.
  const loadEarlierTurns = ((): CitationHistoryPage | null => {
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
  // Queued messages have no turn item until their run starts, so the
  // turn-item-derived set alone can never retire their optimistic rows —
  // cancelling such a run would leave a phantom "pending" queue row behind.
  const serverAcknowledgedUserMessageIds = (() => {
    const ids = new Set(committedServerMessageIds);
    for (const message of serverProjection?.messages ?? []) {
      if (message.role === "user") ids.add(message.id);
    }
    return ids;
  })();
  // SCIENT-FORK:START — the queue strip hides a preview once the server owns
  // the message; the acknowledged user rows are that source of truth.
  const serverAcknowledgedUserMessages = deriveQueueAcknowledgedUserMessages(
    serverProjection?.messages ?? [],
  );
  // SCIENT-FORK:END
  const settings = useEnvironmentSettings(environmentId);
  const clientSettingsHydrated = useClientSettingsHydrated();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  const router = useRouter();
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
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  );
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const branchToolbarRef = useRef<BranchToolbarHandle>(null);
  const pasteAsTextShortcutUntilRef = useRef(0);
  const [restingComposerControlsHost, setRestingComposerControlsHost] =
    useState<HTMLDivElement | null>(null);
  const [restingComposerControlsVisible, setRestingComposerControlsVisible] = useState(false);
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
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<OptimisticUserMessage[]>([]);
  // Set by "Work locally": the draft whose restored message should be resent
  // once the cancelled dispatch has settled and the draft is in local mode.
  // Keyed by draft id so a bootstrap rotating the thread id keeps it, while
  // moving to another draft drops it without an effect.
  const [workLocallyResendDraftId, setWorkLocallyResendDraftId] = useState<DraftId | null>(null);
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const feedbackSubmissions =
    feedbackSubmissionsByThreadKey[routeThreadKey] ?? EMPTY_FEEDBACK_SUBMISSIONS;
  const feedbackUploading = feedbackSubmissions.some(
    (submission) => submission.status === "uploading",
  );
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  useLayoutEffect(() => {
    optimisticUserMessagesRef.current = optimisticUserMessages;
  });
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [localServerErrorsByThreadKey, setLocalServerErrorsByThreadKey] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const isRevertingCheckpoint = useComposerDraftStore((store) =>
    store.rewindingThreadKeys.has(routeThreadKey),
  );

  const workspaceFileDragRouteKey = `${routeThreadKey}:${draftId ?? ""}`;
  const [workspaceFileDragRoute, setWorkspaceFileDragRoute] = useState(workspaceFileDragRouteKey);
  if (workspaceFileDragRoute !== workspaceFileDragRouteKey) {
    setWorkspaceFileDragRoute(workspaceFileDragRouteKey);
    setIsWorkspaceFileDragActive(false);
  }

  useEffect(() => {
    if (!isWorkspaceFileDragActive) return;
    const clearWorkspaceFileDrag = () => setIsWorkspaceFileDragActive(false);
    window.addEventListener("dragend", clearWorkspaceFileDrag);
    return () => window.removeEventListener("dragend", clearWorkspaceFileDrag);
  }, [isWorkspaceFileDragActive]);
  const shouldUsePlanSidebarSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const isMobileViewport = useMediaQuery("max-sm");
  const [workspaceLayoutElement, setWorkspaceLayoutElement] = useState<HTMLDivElement | null>(null);
  const threadPanelPopoverAnchorRef = useRef<HTMLElement | null>(null);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [terminalUiLaunchContext, setTerminalUiLaunchContext] =
    useState<TerminalLaunchContext | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
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
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const legendListRef = useRef<LegendListRef | null>(null);
  const getTimelineScrollableNode = () => legendListRef.current?.getScrollableNode() ?? null;
  const getTimelineScrollableNodeStable = useStableCallback(getTimelineScrollableNode);
  const [composerOverlayElement, setComposerOverlayElement] = useState<HTMLDivElement | null>(null);
  const [composerTimelineInset, setComposerTimelineInset] = useState(0);
  const composerTimelineInsetRef = useRef(0);
  const [composerReservedHeight, setComposerReservedHeight] = useState(0);
  const composerReservedHeightRef = useRef(0);
  const composerExpandedHeightRef = useRef(0);
  const composerRestingRef = useRef(false);
  const composerMountedRef = useRef(true);
  const [scrollToEndClearance, setScrollToEndClearance] = useState(0);
  const [timelineOverflows, setTimelineOverflows] = useState(false);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({});
  const fanoutSelectionsAtom = draftFanoutSelectionsAtom(routeThreadKey);
  const { sendInFlight: sendInFlightRef, uncertainSubmissions: uncertainMultipleSubmissionsRef } =
    draftSendState(routeThreadKey);
  const [resumingThreadKeys, setResumingThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const isResuming = resumingThreadKeys.has(routeThreadKey);
  const composerSendGenerationRef = useRef(0);
  const multipleModelSelections = useAtomValue(fanoutSelectionsAtom);
  const setMultipleModelSelections = (
    selections: SetStateAction<ReadonlyArray<ModelSelection> | null>,
  ) => {
    appAtomRegistry.update(fanoutSelectionsAtom, (current) =>
      typeof selections === "function" ? selections(current) : selections,
    );
  };
  const setMultipleModelSelectionsStable = useStableCallback(setMultipleModelSelections);
  const readMultipleModelSelections = () => appAtomRegistry.get(fanoutSelectionsAtom);
  const environmentUnavailableSendToastSlotRef = useRef(0);
  const feedbackUploadsInFlightRef = useRef(new Set<string>());
  const terminalUiOpenByThreadRef = useRef<Record<string, boolean>>({});

  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef),
  );
  const storeSetTerminalOpen = useTerminalUiStateStore((s) => s.setTerminalOpen);
  const storeEnsureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  const storeSplitTerminal = useTerminalUiStateStore((s) => s.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore((s) => s.splitTerminalVertical);
  const storeNewTerminal = useTerminalUiStateStore((s) => s.newTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((s) => s.closeTerminal);

  const fallbackDraftProjectRef = draftThread?.projectId
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useProject(fallbackDraftProjectRef);
  const localDraftError = serverThread
    ? null
    : ((draftId ? localDraftErrorsByDraftId[draftId]?.message : null) ?? null);
  const localServerError = localServerErrorsByThreadKey[routeThreadKey]?.message ?? null;
  // A draft promoted to its server thread carries its pending error across.
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
  // SCIENT-FORK:START — archived routes can have detail without an active shell.
  // Use the same conversion as the server, never a V1-shaped loading thread.
  const routedServerThread = useThread(routeThreadRef, { waitForShell: draftThread !== null });
  const activeServerThread =
    serverThread ??
    (routedServerThread === null
      ? null
      : presentThreadShell(
          routedServerThread.environmentId,
          threadShellFromProjection(routedServerThread.projection),
        ));
  const isServerThread = activeServerThread !== null;
  const activeThread = activeServerThread ?? localDraftThread;
  // SCIENT-FORK:END
  const serverLatestRun =
    serverProjection === null ? null : deriveLatestThreadRun(serverProjection);
  const serverActivityRun =
    serverProjection === null ? null : deriveThreadActivityRun(serverProjection);
  const serverRuntime = serverProjection === null ? null : deriveThreadRuntime(serverProjection);
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
  // A workflow coordinator's thread opens with its script; the plan that replaces it lives on
  // the parent's coordinator row, so the parent's detail loads only for such a thread.
  const workflowOpeningParentId =
    serverProjection === null
      ? null
      : workflowOpeningParentThreadId({
          thread: serverProjection.thread,
          messages: serverProjection.messages,
        });
  const workflowOpeningParentProjection = useThreadProjection(
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
  const parentThreadLink =
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
  const defaultRuntimeMode = resolveProjectSettings(settings, activeThread?.projectId ?? null)
    .settings.defaultRuntimeMode;
  const runtimeMode =
    composerRuntimeMode ??
    (isServerThread ? activeThread?.runtimeMode : undefined) ??
    defaultRuntimeMode;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = canWriteSourceControl && isLocalDraftThread;
  const activeThreadId = activeThread?.id ?? null;
  // Prefer the larger of turn-item-committed ids and projection messages so
  // env lock does not unlock while turn items lag projection hydration.
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
  // SCIENT-FORK:START — archived threads (detail, no shell) keep their terminals.
  const terminalActions = useThreadTerminalActions(activeThreadRef, { includeDetail: true });
  // SCIENT-FORK:END
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
  // SCIENT-FORK:START — reserved room is released by the reader, Scroll to end or an unused
  // anchor (MessagesTimeline's onReleaseUnusedAnchor), not when its run settles. The reading
  // end is an unfinished turn's latest content, otherwise the latest answer's text; up to
  // its last three lines may be hidden (chat/readerScrollPolicy.ts).
  // SCIENT-FORK:END
  const activeRightPanelKind = useRightPanelStore((state) =>
    selectActiveRightPanel(state.byThreadKey, activeThreadRef),
  );
  const diffOpen = activeRightPanelKind === "diff";
  const explicitDiffOpenRef = useRef<ScopedThreadRef | null>(null);
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
  const activeRightPanelSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, activeThreadRef),
  );
  const activePreviewState = useThreadPreviewState(activeThreadRef);
  const openProjectScriptPreview = useProjectScriptAutoPreview({
    activeThreadRef,
    activeTabId: activePreviewState.activeTabId,
    sessions: activePreviewState.sessions,
    openPreview,
  });
  const activePreviewServerEpoch = activePreviewState.serverEpoch;
  const previewSessionsReady = !activeEnvironmentServerBrowser || activePreviewState.listLoaded;
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
  const canMaximizeRightPanel = rightPanelOpen && !shouldUsePlanSidebarSheet;
  const rightPanelMaximized = canMaximizeRightPanel && rightPanelState.maximized === true;
  const inlineRightPanelOwnsTitleBar = rightPanelOpen && !shouldUsePlanSidebarSheet;
  const [threadPanelPresentation, setThreadPanelPresentation] =
    useState<ThreadPanelPresentation>("inline");
  const [threadPanelPopoverHandle] = useState(PopoverCreateHandle);
  const threadPanelOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(
      state.threadPanelVisibilityByThreadKey,
      activeThreadRef,
      threadPanelPresentation,
    ),
  );

  useEffect(() => {
    if (!activeThreadRef || !previewSessionsReady) return;
    const hiddenTabIds = new Set(
      Object.values(activePreviewState.sessions)
        .filter((session) => session.runtime === "server" && session.reveal === false)
        .map((session) => session.tabId),
    );
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(
        activeThreadRef,
        Object.keys(activePreviewState.sessions),
        hiddenTabIds,
      );
  }, [activePreviewState.sessions, activeThreadRef, previewSessionsReady]);

  useEffect(() => {
    if (!activeThreadRef || !activePreviewMiniPlayer) return;
    const content = activePreviewMiniPlayer.content;
    if (content.kind === "device") return;
    const shouldClose =
      content.kind === "browser"
        ? (previewSessionsReady && !activePreviewState.sessions[content.tabId]) ||
          (previewPanelOpen &&
            activeRightPanelSurface?.kind === "preview" &&
            activeRightPanelSurface.resourceId === content.tabId)
        : rightPanelOpen &&
          activeRightPanelSurface?.kind === "scient" &&
          activeRightPanelSurface.module === "artifact" &&
          activeRightPanelSurface.artifact.surfaceId === content.artifact.surfaceId;
    if (shouldClose) {
      usePreviewMiniPlayerStore.getState().close(activeThreadRef);
    }
  }, [
    activePreviewMiniPlayer,
    activePreviewState.sessions,
    activeRightPanelSurface,
    activeThreadRef,
    previewPanelOpen,
    rightPanelOpen,
    previewSessionsReady,
  ]);

  // SCIENT-FORK: an open thread acknowledges its answer.
  useAcknowledgeAnswer(routedServerThread);
  const latestRunSettled = isLatestRunSettled(activeLatestRun, activeRuntime);
  const activePlan = deriveActivePlanState(serverProjection, activeActivityRun?.runId);
  const activeActivityRunSettled = isLatestRunSettled(activeActivityRun, activeRuntime);
  const composerTasksPlan = selectComposerTasksPlan(
    serverProjection,
    activePlan,
    activeActivityRun?.runId ?? null,
    activeActivityRunSettled,
  );
  const activeComposerTasksProgress = (() => {
    if (!composerTasksPlan) return null;
    const live = !activeActivityRunSettled && composerTasksPlan.runId === activeActivityRun?.runId;
    const totalSteps = composerTasksPlan.steps.length;
    if (totalSteps === 0) return null;
    const completedSteps = composerTasksPlan.steps.filter(
      (step) => step.status === "completed",
    ).length;
    const step =
      composerTasksPlan.steps.find((candidate) => candidate.status === "inProgress")?.step ??
      composerTasksPlan.steps.find((candidate) => candidate.status === "pending")?.step ??
      composerTasksPlan.steps.at(-1)!.step;
    return { step, completedSteps, totalSteps, live };
  })();
  const activeComposerTaskSteps =
    activeComposerTasksProgress && composerTasksPlan ? composerTasksPlan.steps : null;
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
  const activeProjectClone = useProjectClone(activeProjectRef);
  const cancelProjectClone = useAtomCommand(sourceControlEnvironment.cancelProjectClone, {
    reportFailure: false,
  });
  const retryProjectClone = useAtomCommand(sourceControlEnvironment.retryProjectClone, {
    reportFailure: false,
  });
  const removeClonedProject = useRemoveClonedProject();
  const runProjectCloneAction = async (
    title: string,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
  ): Promise<void> => {
    const result = await action();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };
  const runProjectCloneActionStable = useStableCallback(runProjectCloneAction);
  const activeProjectFileCopy = useProjectFileCopy(activeProjectRef);
  const projectCloneSendBlockReason =
    activeProjectClone?.phase === "running"
      ? "Cloning repository"
      : activeProjectClone !== null && activeProjectClone.phase !== "done"
        ? "Repository not cloned"
        : activeProjectFileCopy?.phase === "copying"
          ? "Copying files"
          : null;
  const projectCloneBannerItem = (() => {
    if (activeProjectFileCopy?.phase === "failed" && activeProjectRef) {
      return {
        id: `project-file-copy:${activeProjectRef.projectId}`,
        variant: "error",
        icon: <DownloadIcon />,
        title: activeProjectFileCopy.title,
        description: activeProjectFileCopy.failures.join("\n"),
        onDismiss: () => dismissProjectFileCopy(activeProjectRef),
      };
    }
    if (!activeProjectClone || !activeProjectRef || activeProjectClone.phase === "done") {
      return null;
    }
    const name = projectCloneDisplayName(activeProjectClone);
    const { environmentId, projectId } = activeProjectRef;
    if (activeProjectClone.phase === "running") {
      return {
        id: `project-clone:${projectId}`,
        variant: "info",
        priority: "activity",
        icon: <DownloadIcon />,
        title: `Cloning ${name}`,
        description: projectCloneProgressSummary(activeProjectClone),
        actions: (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void runProjectCloneActionStable("Failed to cancel clone", () =>
                cancelProjectClone({ environmentId, input: { projectId } }),
              )
            }
          >
            Cancel
          </Button>
        ),
      };
    }
    const cancelled = activeProjectClone.phase === "cancelled";
    return {
      id: `project-clone:${projectId}`,
      variant: cancelled ? "warning" : "error",
      icon: <DownloadIcon />,
      title: cancelled ? `Cancelled cloning ${name}` : `Failed to clone ${name}`,
      description: cancelled ? "Retry to bring in the repository." : activeProjectClone.error,
      actions: (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void removeClonedProject({ environmentId, projectId })}
          >
            Remove project
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void runProjectCloneActionStable("Failed to retry clone", () =>
                retryProjectClone({ environmentId, input: { projectId } }),
              )
            }
          >
            Retry
          </Button>
        </>
      ),
    };
  })() as ComposerBannerStackItem | null;
  const activeProjectDefaultModelSelection = activeProjectSettings.settings.defaultModelSelection;
  // An unpicked draft follows a default changed in Settings. ChatView
  // remounts on return, so this compares state rather than watching changes.
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
  useEffect(() => {
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
  const { runAfterPendingSurfaceSave, runAfterPendingFileSave } = useChatSurfaceDepartureGuards({
    pendingFileSurfaceIds,
    markdownDepartureOptions,
    activeSurfaceId: activeRightPanelSurface?.id ?? null,
    environmentId: activeThread?.environmentId,
    cwd: activeWorkspaceKeyRoot,
    pendingFileSurfaceIdsByProject,
    handleMarkdownAttention,
  });
  // SCIENT-FORK:END
  const configuredPreviewUrls = getConfiguredPreviewUrls(activeProjectScripts);

  useEffect(() => {
    if (!activeThreadRef || !activeEnvironmentBootstrapComplete) return;
    useRightPanelStore
      .getState()
      .reconcileFileSurfaces(activeThreadRef, activeWorkspaceKeyRoot !== undefined);
  }, [activeEnvironmentBootstrapComplete, activeThreadRef, activeWorkspaceKeyRoot]);

  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  useEffect(() => {
    if (!activeThreadRef || !activeProjectRef) return;
    registerFaviconProjectForThread(activeThreadRef, activeProjectRef);
  }, [activeProjectRef, activeThreadRef]);
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
  const openPullRequestDialog = (reference?: string) => {
    if (!canCheckoutPullRequestIntoThread) {
      return;
    }
    if (activeThreadKey === null) return;
    openPullRequestThreadDialog(activeThreadKey, reference);
  };
  const openPullRequestDialogStable = useStableCallback(openPullRequestDialog);

  const openOrReuseProjectDraftThread = async (input: {
    branch: string;
    worktreePath: string | null;
    envMode: DraftThreadEnvMode;
  }) => {
    if (!activeProject) {
      throw new Error("No active project is available for this pull request.");
    }
    const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id);
    const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
      activeProject,
      projectGroupingSettings,
    );
    const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey);
    if (storedDraftSession) {
      setDraftThreadContext(storedDraftSession.draftId, input);
      setLogicalProjectDraftThreadId(
        logicalProjectKey,
        activeProjectRef,
        storedDraftSession.draftId,
        {
          threadId: storedDraftSession.threadId,
          ...input,
        },
      );
      if (routeKind !== "draft" || draftId !== storedDraftSession.draftId) {
        await navigate({
          to: "/draft/$draftId",
          params: buildDraftThreadRouteParams(storedDraftSession.draftId),
        });
      }
      return storedDraftSession.threadId;
    }

    const activeDraftSession = routeKind === "draft" && draftId ? getDraftSession(draftId) : null;
    if (!isServerThread && activeDraftSession?.logicalProjectKey === logicalProjectKey && draftId) {
      setDraftThreadContext(draftId, input);
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
        threadId: activeDraftSession.threadId,
        createdAt: activeDraftSession.createdAt,
        runtimeMode: activeDraftSession.runtimeMode,
        interactionMode: activeDraftSession.interactionMode,
        ...input,
      });
      return activeDraftSession.threadId;
    }

    const nextDraftId = newDraftId();
    const nextThreadId = newThreadId();
    setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
      threadId: nextThreadId,
      createdAt: new Date().toISOString(),
      runtimeMode: resolveProjectSettings(settings, activeProject.id, activeProject).settings
        .defaultRuntimeMode,
      interactionMode: DEFAULT_INTERACTION_MODE,
      ...input,
    });
    await navigate({
      to: "/draft/$draftId",
      params: buildDraftThreadRouteParams(nextDraftId),
    });
    return nextThreadId;
  };

  const handlePreparedPullRequestThread = async (input: {
    branch: string;
    worktreePath: string | null;
  }) => {
    await openOrReuseProjectDraftThread({
      branch: input.branch,
      worktreePath: input.worktreePath,
      envMode: input.worktreePath ? "worktree" : "local",
    });
  };
  const handlePreparedPullRequestThreadStable = useStableCallback(handlePreparedPullRequestThread);

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
  const supportsPullRequests = serverConfig?.environment.capabilities.pullRequests === true;
  const attachmentEnvironmentConfig = environmentById.get(environmentId)?.serverConfig ?? null;
  const attachmentUploadsCapabilityKnown = attachmentEnvironmentConfig !== null;
  const supportsQuestionAttachments =
    attachmentEnvironmentConfig?.environment.capabilities.questionAttachments === true;
  const supportsAttachmentUploads =
    attachmentEnvironmentConfig?.environment.capabilities.attachmentUploads === true;
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
  const providerInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providerStatuses),
      settings,
      activeProject?.id ?? null,
    ),
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
  // SCIENT-FORK:START — Scient thread queue: pending composer payloads for
  // this thread. Server-thread-scoped only; local draft threads have no
  // queue surface.
  const threadQueue = useThreadQueue({
    environmentId: isServerThread ? environmentId : null,
    threadId: isServerThread && activeThread ? activeThread.id : null,
    threadBusy: phase === "running",
  });
  const queueContextKeyRef = useRef(activeThreadKey);
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
  const workspaceMutationId = (() => {
    let itemId: string | null = null;
    for (let index = serverVisibleTurnItems.length - 1; index >= 0; index -= 1) {
      const item = serverVisibleTurnItems[index]?.item;
      if (!item) continue;
      if (item.type !== "command_execution" && item.type !== "file_change") continue;
      if (item.status === "pending" || item.status === "running" || item.status === "waiting") {
        continue;
      }
      itemId = item.id;
      break;
    }
    const latestCheckpointCompletedAt = turnDiffSummaries.at(-1)?.completedAt ?? null;
    return itemId === null && latestCheckpointCompletedAt === null
      ? null
      : JSON.stringify([itemId, latestCheckpointCompletedAt]);
  })();
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
    activeThread,
    serverProjection,
    supportsQuestionAttachments,
    composerDraftTarget,
    setComposerDraftPrompt,
    promptRef,
    composerRef,
  });
  // A send awaits uploads before it declines, so it reads the approvals pending by then.
  const pendingApprovalsRef = useRef(pendingApprovals);
  const respondingRequestIdsRef = useRef(respondingRequestIds);
  useLayoutEffect(() => {
    pendingApprovalsRef.current = pendingApprovals;
    respondingRequestIdsRef.current = respondingRequestIds;
  }, [pendingApprovals, respondingRequestIds]);
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
  // A pending approval or question is part of the key: once it is answered,
  // from this client or any other, the agent resumes and spends quota.
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
  const pendingBackgroundTasks = (() => {
    if (serverProjection === null || serverProjection === undefined) {
      return [];
    }
    const sessionError =
      serverProjection.providerSessions.findLast(
        (session) => session.providerInstanceId === serverProjection.thread.providerInstanceId,
      )?.lastError ?? null;
    const latestRun =
      usageLimitRunPresentedAsLatest(
        serverProjection.runs,
        serverProjection.turnItems,
        sessionError,
      ) ?? latestUnheldRun(serverProjection.runs);
    return [
      ...derivePendingBackgroundWork({
        latestRun,
        providerThreads: serverProjection.providerThreads,
        turnItems: serverProjection.turnItems,
        activeProviderThreadId: serverProjection.thread.activeProviderThreadId,
        runs: serverProjection.runs,
        pullRequests: serverProjection.thread.pullRequests,
      }),
    ];
  })();
  const activeWorkStartedAt =
    deriveActiveWorkStartedAt(activeActivityRun, activeRuntime, localDispatchStartedAt) ??
    runlessWorkStartedAt;
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoff = (
    messageId: MessageId,
    previewUrls?: ReadonlyArray<string>,
  ) => {
    delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
    const currentPreviewUrls =
      previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    setAttachmentPreviewHandoffByMessageId((existing) => {
      if (!(messageId in existing)) {
        return existing;
      }
      const next = { ...existing };
      delete next[messageId];
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
    for (const previewUrl of currentPreviewUrls) {
      revokeBlobPreviewUrl(previewUrl);
    }
  };
  const clearAttachmentPreviewHandoffStable = useStableCallback(clearAttachmentPreviewHandoff);
  const clearAttachmentPreviewHandoffs = () => {
    attachmentPreviewPromotionInFlightByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  };
  const clearAttachmentPreviewHandoffsStable = useStableCallback(clearAttachmentPreviewHandoffs);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffsStable();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffsStable]);
  const handoffAttachmentPreviews = (messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const nextPreviewUrlSet = new Set(previewUrls);
    for (const previewUrl of previousPreviewUrls) {
      if (!nextPreviewUrlSet.has(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
  };
  const handoffAttachmentPreviewsStable = useStableCallback(handoffAttachmentPreviews);
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
  const serverAttachmentResources = selectHandoffImageResources(
    Object.keys(attachmentPreviewHandoffByMessageId).length === 0
      ? undefined
      : serverVisibleTurnItems.flatMap(({ item }) =>
          item.type === "user_message"
            ? [{ id: item.messageId, role: "user" as const, attachments: item.attachments }]
            : [],
        ),
    attachmentPreviewHandoffByMessageId,
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = new Map(
    serverAttachmentResources.flatMap((resource, index) => {
      const url = serverAttachmentUrls[index];
      return url ? [[resource.attachmentId, url] as const] : [];
    }),
  );
  useEffect(() => {
    if (typeof Image === "undefined" || serverVisibleTurnItems.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];
    const userMessagesById = new Map(
      serverVisibleTurnItems.flatMap((row) =>
        row.item.type === "user_message" ? [[String(row.item.messageId), row.item] as const] : [],
      ),
    );

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]) {
        continue;
      }

      const serverMessage = userMessagesById.get(messageId);
      if (serverMessage === undefined || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        attachment.type === "image"
          ? [serverAttachmentUrlById.get(attachment.id)].filter(
              (previewUrl): previewUrl is string => previewUrl !== undefined,
            )
          : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true;

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          clearAttachmentPreviewHandoffStable(messageId as MessageId, handoffPreviewUrls);
        })
        .catch(() => {
          if (!cancelled) {
            delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
          }
        });

      cleanups.push(() => {
        cancelled = true;
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [
    attachmentPreviewHandoffByMessageId,
    clearAttachmentPreviewHandoffStable,
    serverAttachmentUrlById,
    serverVisibleTurnItems,
  ]);
  const { serverEntries: serverTimelineEntries, optimisticMessages: timelineOptimisticMessages } =
    useThreadTimelineEntries({
      threadKey: activeThreadKey,
      visibleTurnItems: serverVisibleTurnItems,
      projection: serverProjection,
      serverAttachmentUrlById,
      attachmentPreviewHandoffByMessageId,
      feedbackSubmissions,
      optimisticMessages: optimisticUserMessages,
    });
  const draftTimelineEntries = timelineOptimisticMessages.map(
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
  const displayedTimeline = resolveThreadSwitchTimeline({
    loading: timelineEntries.length === 0 && threadSyncPhase !== null,
    activeThreadKey,
    nextEntries: timelineEntries,
    rememberedForActive: peekRememberedThreadTimeline<typeof timelineEntries>(activeThreadKey),
    // SCIENT-FORK: a landing fork never holds the origin's rows under its own header.
    ...(forkLanding.heldTimeline ? { lastReady: forkLanding.heldTimeline } : {}),
  });
  const displayedTimelineKey = displayedTimeline.displayThreadKey ?? routeThreadKey;
  const paintOnlyDisplayedTimeline = isPaintOnlyThreadTimeline(
    displayedTimeline.displayThreadKey,
    activeThreadKey,
  );
  const displayedThreadRef = parseScopedThreadKey(displayedTimelineKey);
  // SCIENT-FORK:START — the landing fork's messages wait for their own positioned rows.
  const forkLandingReveal = useForkLandingReveal({
    landing: forkLanding,
    threadKey: routeThreadKey,
    threadExists: isServerThread,
    threadDeleted: threadStatus === "deleted",
    detailLoaded: serverProjection !== null,
    displayedThreadKey: displayedTimeline.displayThreadKey,
    timelineEmpty: timelineEntries.length === 0,
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
    // Counts the optimistic send too, so the row retires the moment the
    // follow-up is on screen rather than when the server echoes it back.
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
    phase === "running" || isSendBusy || isConnecting || isCompacting || awaitingBootstrapTurn;
  const isWorking = isOriginWorking || isForkingThread;
  const turnUnfinished = latestTurnUnfinished(activeRunningTurnId, activeLatestRun?.status);
  // The timeline's working row waits for the prompt being sent, and stays while its run starts
  // (chat/timelineWorkingState.ts).
  const timelineWorking = deriveTimelineWorking({
    threadWorking: isWorking,
    onlySendBusy: isOnlySendBusy({
      isSendBusy,
      phase,
      isConnecting,
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
    hasTimelineEntries: timelineEntries.length > 0,
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
  const onForkConversation = createForkConversationCommand({
    timelineEntries,
    activeLatestRun,
    activeRunningTurnId,
    activeThreadId,
    activeThreadEnvironmentId,
    setForkCommandTarget,
  });
  // SCIENT-FORK:END
  const availableRevertTurnCounts = (() => {
    const available = new Set<number>();
    const providerThread = serverProjection?.providerThreads.find(
      (candidate) => candidate.id === serverProjection.thread.activeProviderThreadId,
    );
    if (
      !providerThread?.providerSessionId ||
      providerThread.providerInstanceId !== serverProjection?.thread.modelSelection.instanceId
    )
      return available;
    available.add(0);
    const attemptsById = new Map(serverProjection.attempts.map((attempt) => [attempt.id, attempt]));
    const providerTurnsById = new Map<
      OrchestrationV2ProviderTurn["id"],
      OrchestrationV2ProviderTurn
    >();
    const latestTurnByAttempt = new Map<RunAttemptId, OrchestrationV2ProviderTurn>();
    for (const turn of serverProjection.providerTurns) {
      providerTurnsById.set(turn.id, turn);
      if (turn.runAttemptId === null) continue;
      const latest = latestTurnByAttempt.get(turn.runAttemptId);
      if (latest === undefined || turn.ordinal > latest.ordinal) {
        latestTurnByAttempt.set(turn.runAttemptId, turn);
      }
    }
    for (const run of serverProjection.runs) {
      if (run.activeAttemptId === null) continue;
      const attempt = attemptsById.get(run.activeAttemptId);
      const providerTurn =
        latestTurnByAttempt.get(run.activeAttemptId) ??
        (attempt?.providerTurnId == null
          ? undefined
          : providerTurnsById.get(attempt.providerTurnId));
      // A ready file checkpoint alone cannot restore the provider conversation.
      if (providerTurn?.providerThreadId === providerThread.id) available.add(run.ordinal);
    }
    return available;
  })();
  // A paged history window cannot identify the first loaded run as the thread start.
  const threadStartCheckpointReady =
    !serverThreadHistory.hasMoreHistory &&
    findRevertCheckpoint(serverProjection?.checkpoints ?? [], 0) !== undefined;

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
  // SCIENT-FORK:START — Back and Forward for file tabs
  useRightPanelTabHistory({ threadRef: activeThreadRef, keybindings, runAfterPendingFileSave });
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
    enabled: showOpenInPicker,
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
  useLayoutEffect(() => {
    if (
      threadDetailLoading ||
      timelineEntries.length === 0 ||
      timelineHasEphemeralPreviewUrls(timelineEntries)
    ) {
      return;
    }
    rememberReadyThreadTimeline({
      threadKey: activeThreadKey,
      entries: timelineEntries,
      markdownCwd: gitCwd,
      workspaceRoot: activeWorkspaceRoot ?? null,
    });
  }, [activeThreadKey, activeWorkspaceRoot, gitCwd, threadDetailLoading, timelineEntries]);
  const heldPaintContext = paintOnlyDisplayedTimeline
    ? peekHeldThreadTimeline<typeof timelineEntries>()
    : null;
  const activeTerminalLaunchContext =
    terminalUiLaunchContext?.threadId === activeThreadId ? terminalUiLaunchContext : null;
  const liveIsGitRepo = gitStatusQuery.data?.isRepo;
  const gitUnavailable = gitStatusQuery.data?.gitAvailability === "missing";
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
    turnDiffSummaries,
    activeThread,
    serverVisibleTurnItems,
    isGitRepo,
    forkDialogOpen: forkCommand.forkDialogOpen,
    forkCommandTarget: forkCommand.forkCommandTarget,
    timelineEntries,
  });
  // SCIENT-FORK:END
  // A provider-native subagent cannot take messages: a status bar replaces the
  // composer and its strips. Its approvals and questions are asked on the
  // top-level parent thread.
  const showProviderSubagentBar = isProviderSubagent;
  const composerMounted = !showProviderSubagentBar;
  const providerSubagentModels = selectedProviderEntry?.models ?? EMPTY_PROVIDER_MODELS;
  // Providers can report a dated id or alias (claude-haiku-4-5-20251001).
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
    ? getTriggerDisplayModelName(providerSubagentCatalogModel)
    : formatModelSlugName(activeThread?.modelSelection.model ?? "");
  const providerSubagentEffortLabel =
    activeThread === undefined
      ? null
      : formatModelSelectionEffort(
          activeThread.modelSelection,
          providerSubagentModels,
          reportedModelSelection,
        );
  const mountComposerContextStrip = shouldShowComposerContextStrip({
    isDraftHeroState,
    persistInActiveThreads: settings.persistComposerContextStrip,
    hasActiveProject: activeProject !== null && !showProviderSubagentBar,
    isGitRepo,
    showEnvironmentIndicator: showComposerEnvironmentIndicator,
    hostsRestingComposerControls: routeKind === "server",
  });
  const showComposerContextStrip = shouldShowComposerContextStrip({
    isDraftHeroState,
    persistInActiveThreads: settings.persistComposerContextStrip,
    hasActiveProject: activeProject !== null && !showProviderSubagentBar,
    isGitRepo,
    showEnvironmentIndicator: showComposerEnvironmentIndicator,
    hostsRestingComposerControls: routeKind === "server" && restingComposerControlsVisible,
  });
  const mountComposerModelStrip =
    routeKind === "server" && !mountComposerContextStrip && !showProviderSubagentBar;
  const showComposerModelStrip = mountComposerModelStrip && restingComposerControlsVisible;
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
  const onToggleDiff = () => {
    if (!diffAvailable) {
      return;
    }
    if (!activeThreadRef) return;
    runAfterPendingFileSave("diff", () => {
      if (!diffOpen) {
        onDiffPanelOpen?.();
      }
      useRightPanelStore.getState().toggle(activeThreadRef, "diff");
    });
  };
  const onToggleDiffStable = useStableCallback(onToggleDiff);

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

  const activeTerminalGroup =
    terminalUiState.terminalGroups.find(
      (group) => group.id === terminalUiState.activeTerminalGroupId,
    ) ??
    terminalUiState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalUiState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;

  const composerIdentity = composerTargetKey(composerDraftTarget);
  const previousComposerIdentity = useRef({ thread: activeThreadKey, draft: composerIdentity });
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
  useEffect(() => subscribeSnapShotComposerFocus(focusComposerStable), [focusComposerStable]);
  const scheduleComposerFocus = () => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  };
  const scheduleComposerFocusStable = useStableCallback(scheduleComposerFocus);
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
  const addTerminalContextToDraft = (selection: TerminalContextSelection) => {
    composerRef.current?.addTerminalContext(selection);
  };
  const addTerminalContextToDraftStable = useStableCallback(addTerminalContextToDraft);
  const setTerminalOpen = (open: boolean) => {
    if (!activeThreadRef) return;
    storeSetTerminalOpen(activeThreadRef, open);
  };
  const setTerminalOpenStable = useStableCallback(setTerminalOpen);
  const toggleTerminalVisibility = () => {
    if (!activeThreadRef) return;
    const nextOpen = !terminalUiState.terminalOpen;
    if (
      nextOpen &&
      !readEnvironmentScope(environmentId, AuthTerminalReadScope) &&
      !hasTerminalWriteAccess()
    )
      return;
    if (nextOpen && hasTerminalWriteAccess() && terminalUiState.terminalIds.length === 0) {
      // Server-created setup terminals exist before this client's drawer mounts.
      // Reuse them before allocating a shell from the still-empty UI state.
      const existingTerminalId =
        runningTerminalIds.find((id) => !panelTerminalIds.has(id)) ??
        activeServerOrderedTerminalIds.find((id) => !panelTerminalIds.has(id));
      if (existingTerminalId !== undefined) {
        storeEnsureTerminal(activeThreadRef, existingTerminalId, { open: true, active: true });
        return;
      }
      void terminalActions.launchTerminal({
        place: (terminalId) => storeEnsureTerminal(activeThreadRef, terminalId, { open: true }),
      })?.result;
      return;
    }
    setTerminalOpen(nextOpen);
  };
  const toggleTerminalVisibilityStable = useStableCallback(toggleTerminalVisibility);
  const splitTerminal = (direction: "horizontal" | "vertical" = "horizontal") => {
    if (!activeThreadRef || hasReachedSplitLimit) return;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) =>
        direction === "vertical"
          ? storeSplitTerminalVertical(activeThreadRef, terminalId)
          : storeSplitTerminal(activeThreadRef, terminalId),
    });
    if (!launched) return;
    setTerminalFocusRequestId((value) => value + 1);
    void launched.result;
  };
  const splitTerminalStable = useStableCallback(splitTerminal);
  const createNewTerminal = () => {
    if (!activeThreadRef) return;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) => storeNewTerminal(activeThreadRef, terminalId),
    });
    if (!launched) return;
    setTerminalFocusRequestId((value) => value + 1);
    void launched.result;
  };
  const createNewTerminalStable = useStableCallback(createNewTerminal);
  const closeTerminal = (terminalId: string) => {
    if (!hasTerminalWriteAccess() || !activeThreadRef) return;
    terminalActions.closeTerminalSession(terminalId);
    storeCloseTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  };
  const runProjectScript = async (
    script: ProjectScript,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      worktreePath?: string | null;
      preferNewTerminal?: boolean;
      rememberAsLastInvoked?: boolean;
      shellHistory?: "preserve" | "suppress";
    },
  ) => {
    if (!hasTerminalWriteAccess() || !activeThreadId || !activeProject || !activeThread) return;
    if (options?.rememberAsLastInvoked !== false) {
      setLastInvokedScriptByProjectId((current) => {
        if (current[activeProject.id] === script.id) return current;
        return { ...current, [activeProject.id]: script.id };
      });
    }
    const targetCwd = options?.cwd ?? gitCwd ?? activeProject.workspaceRoot;
    const reusableTerminalId =
      options?.preferNewTerminal ||
      !canReuseTerminal ||
      !readEnvironmentScope(environmentId, AuthTerminalReadScope)
        ? null
        : findReusableProjectScriptTerminal({
            // Server sessions cover drawer terminals this client has not opened yet, such as a
            // worktree setup shell; the helper drops the panel-owned ones.
            drawerTerminalIds: [
              ...new Set([...terminalUiState.terminalIds, ...activeServerOrderedTerminalIds]),
            ],
            activeTerminalId: terminalUiState.activeTerminalId,
            panelTerminalIds,
            runningTerminalIds,
          });
    const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

    setTerminalUiLaunchContext({
      threadId: activeThreadId,
      cwd: targetCwd,
      worktreePath: targetWorktreePath,
    });
    if (!activeThreadRef) {
      return;
    }
    setTerminalFocusRequestId((value) => value + 1);

    const launched = terminalActions.launchTerminal({
      // The drawer opens with the target already placed: opening it empty would claim
      // DEFAULT_THREAD_TERMINAL_ID, which a right-panel terminal may already own.
      place: (terminalId) =>
        reusableTerminalId === null
          ? storeNewTerminal(activeThreadRef, terminalId)
          : storeEnsureTerminal(activeThreadRef, terminalId, { open: true }),
      ...(reusableTerminalId === null
        ? { size: { cols: SCRIPT_TERMINAL_COLS, rows: SCRIPT_TERMINAL_ROWS } }
        : { terminalId: reusableTerminalId }),
      location: { cwd: targetCwd, worktreePath: targetWorktreePath },
      ...(options?.env ? { extraEnv: options.env } : {}),
    });
    if (!launched) return;
    const targetTerminalId = launched.terminalId;
    const openResult = await launched.result;
    if (openResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(openResult)) {
        const error = squashAtomCommandFailure(openResult);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
      return;
    }

    const writeResult = await terminalActions.writeToTerminal(
      targetTerminalId,
      options?.shellHistory === "preserve"
        ? `${script.command}\r`
        : projectScriptTerminalInput(script.command),
    );
    if (!writeResult) return;
    if (writeResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(writeResult)) {
        const error = squashAtomCommandFailure(writeResult);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
      return;
    }
    await openProjectScriptPreview(script, activeThreadRef);
  };
  const runProjectScriptStable = useStableCallback(runProjectScript);

  const runProjectScriptRef = useRef(runProjectScriptStable);
  useLayoutEffect(() => {
    runProjectScriptRef.current = runProjectScriptStable;
  }, [runProjectScriptStable]);
  const runShellCommand = (command: string) => {
    void runProjectScriptRef.current(
      {
        id: "chat-code-block",
        name: "Chat code block",
        command,
        icon: "play",
        runOnWorktreeCreate: false,
      },
      { rememberAsLastInvoked: false, shellHistory: "preserve" },
    );
  };
  const runShellCommandStable = useStableCallback(runShellCommand);

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

  const handleRuntimeModeChange = (mode: RuntimeMode) => {
    if (mode === runtimeMode) return;
    setComposerDraftRuntimeMode(composerDraftTarget, mode);
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
    }
    scheduleComposerFocus();
  };
  const handleRuntimeModeChangeStable = useStableCallback(handleRuntimeModeChange);

  const handleInteractionModeChange = (mode: ProviderInteractionMode) => {
    if (mode === "plan" && !interactionModeEnabled) return;
    if (mode === interactionMode) return;
    setComposerDraftInteractionMode(composerDraftTarget, mode);
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, { interactionMode: mode });
    }
    scheduleComposerFocus();
  };
  const handleInteractionModeChangeStable = useStableCallback(handleInteractionModeChange);
  const toggleInteractionMode = () => {
    if (!interactionModeEnabled) return;
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  };
  const toggleInteractionModeStable = useStableCallback(toggleInteractionMode);
  const openProviderSetup = (instanceId: ProviderInstanceId) => {
    void navigate({
      to: "/settings/providers",
      search: { environmentId, instanceId },
    });
  };
  const openProviderSetupStable = useStableCallback(openProviderSetup);
  const canOperatePreview = useEnvironmentScope(
    activeThreadRef?.environmentId ?? null,
    AuthPreviewOperateScope,
  );
  const createBrowserSurface = (profileId?: string) => {
    if (!activeThreadRef || !canOperatePreview) return;
    runAfterPendingFileSave(null, () => {
      void addBrowserSurface({
        threadRef: activeThreadRef,
        openPreview,
        ...(profileId === undefined ? {} : { profileId }),
      }).then((result) => {
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        if (error instanceof BrowserSettingsReadError) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to open browser",
              description: error.message,
            }),
          );
        }
      });
    });
  };
  const createBrowserSurfaceStable = useStableCallback(createBrowserSurface);
  const addDiffSurface = () => {
    if (!activeThreadRef || !diffAvailable) return;
    runAfterPendingFileSave("diff", () => {
      useDiffPanelStore.getState().selectGitScope(activeThreadRef, "unstaged");
      useRightPanelStore.getState().open(activeThreadRef, "diff");
      onDiffPanelOpen?.();
    });
  };
  const addDiffSurfaceStable = useStableCallback(addDiffSurface);
  const addFilesSurface = () => {
    if (!activeThreadRef || activeWorkspaceRoot === undefined) return;
    runAfterPendingFileSave("files", () => {
      useRightPanelStore.getState().open(activeThreadRef, "files");
    });
  };
  const addFilesSurfaceStable = useStableCallback(addFilesSurface);
  const openChangesFromThreadPanel = () => {
    addDiffSurface();
  };
  const openChangesFromThreadPanelStable = useStableCallback(openChangesFromThreadPanel);
  // SCIENT-FORK:START — the switch for the file list beside side-panel tabs
  const [panelFilesOpen, setPanelFilesOpen] = usePanelFilesOpen();
  // SCIENT-FORK:END
  // SCIENT-FORK:START — a second copy of a browser or terminal tab; like opening
  // a browser, it waits for a pending file save first
  const duplicateRightPanelSurface = (surface: RightPanelSurface) => {
    if (!activeThreadRef) return;
    if (surface.kind === "preview" && !canOperatePreview) return;
    runAfterPendingFileSave(null, () => {
      duplicatePanelSurface({
        surface,
        threadRef: activeThreadRef,
        openPreview,
        previewSessions: activePreviewState.sessions,
        addTerminal: addTerminalSurfaceStable,
      });
    });
  };
  // SCIENT-FORK:END
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
  const supportsThreadPullRequests =
    serverConfig?.environment.capabilities.threadPullRequests === true;
  const visiblePullRequests = visibleThreadPullRequests(
    (activeThreadShell ?? activeThread)?.pullRequests ?? [],
  );
  const visiblePullRequestCount = visiblePullRequests.length;
  const pullRequestsSurfaceAvailable =
    isServerThread && supportsThreadPullRequests && visiblePullRequestCount > 0;
  const addPullRequestsSurface = () => {
    if (!activeThreadRef || !pullRequestsSurfaceAvailable) return;
    runAfterPendingFileSave("pull-requests", () => {
      useRightPanelStore.getState().open(activeThreadRef, "pull-requests");
    });
  };
  const addPullRequestsSurfaceStable = useStableCallback(addPullRequestsSurface);
  const { state: deviceState, loaded: deviceStateLoaded } = useDeviceState(
    activeThreadRef?.environmentId ?? null,
  );
  const addDeviceSurface = () => {
    if (!activeThreadRef) return;
    if (!deviceState.onboardingCompleted || deviceState.hostStatus === "disabled") {
      openDeviceSetupDialog(scopedThreadKey(activeThreadRef));
      return;
    }
    useRightPanelStore.getState().open(activeThreadRef, "device");
  };
  const addDeviceSurfaceStable = useStableCallback(addDeviceSurface);
  useAgentOpenedPreviews({
    threadRef: activeThreadRef,
    deviceState,
    deviceStateLoaded,
    previewState: activePreviewState,
    serverBrowserAvailable: activeEnvironmentServerBrowser,
    panelSurfaces: rightPanelState.surfaces,
    // SCIENT-FORK:START — the floating player holds tagged content (browser, device or figure).
    miniPlayerSource: activePreviewMiniPlayer?.content ?? null,
    // SCIENT-FORK:END
    sheetLayout: shouldUsePlanSidebarSheet,
  });
  const openFileSurface = (relativePath: string) => {
    runAfterPendingFileSave(`file:${relativePath}`, () => {
      openFileSurfaceNow(relativePath);
    });
  };
  const openFileSurfaceStable = useStableCallback(openFileSurface);
  // SCIENT-FORK:START — file surfaces report handled HTML and LaTeX presentation requests.
  const { handleHtmlPresentationRequestHandled, handleLatexPresentationRequestHandled } =
    useFilePresentationRequestHandlers(activeThreadRef);
  // SCIENT-FORK:END
  // The thread's own change request, placed against the project it belongs to. Without a
  // project there is nothing to resolve it against, so the caller falls back to the browser.
  const activeProjectRepository = sourceControlRepositorySelector(
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
  const closePreviewPanel = () => {
    if (!activeThreadRef) return;
    runAfterPendingFileSave(null, () => {
      // Closing the panel on a live browser or device floats it instead of dropping it.
      if (activeRightPanelSurface?.kind === "preview" && activeRightPanelSurface.resourceId) {
        usePreviewMiniPlayerStore
          .getState()
          .open(activeThreadRef, browserMiniPlayerSource(activeRightPanelSurface.resourceId));
      } else if (activeRightPanelSurface?.kind === "device" && activeRightPanelSurface.target) {
        usePreviewMiniPlayerStore
          .getState()
          .open(activeThreadRef, { kind: "device", ...activeRightPanelSurface.target });
      }
      useRightPanelStore.getState().setMaximized(activeThreadRef, false);
      useRightPanelStore.getState().close(activeThreadRef);
    });
  };
  const closePreviewPanelStable = useStableCallback(closePreviewPanel);
  const togglePreviewPanel = () => {
    if (!activeThreadRef || !browserAvailable) return;
    if (previewPanelOpen) {
      closePreviewPanel();
      return;
    }
    if (!canOperatePreview) return;
    const activeTabId = activePreviewState.activeTabId;
    if (activeTabId) {
      runAfterPendingFileSave(null, () => {
        useRightPanelStore.getState().openBrowser(activeThreadRef, activeTabId);
      });
    } else {
      createBrowserSurface();
    }
  };
  const togglePreviewPanelStable = useStableCallback(togglePreviewPanel);
  const addTerminalSurface = () => {
    if (!activeThreadRef) return;
    // SCIENT-FORK:START — a pending file save settles before a terminal tab takes over.
    runAfterPendingFileSave(null, () => {
      const launched = terminalActions.launchTerminal({
        place: (terminalId) =>
          useRightPanelStore.getState().openTerminal(activeThreadRef, terminalId),
      });
      if (!launched) return;
      setTerminalFocusRequestId((value) => value + 1);
      void launched.result;
    });
    // SCIENT-FORK:END
  };
  const addTerminalSurfaceStable = useStableCallback(addTerminalSurface);
  const splitPanelTerminal = (direction: "horizontal" | "vertical" = "horizontal") => {
    if (
      !activeThreadRef ||
      activeRightPanelSurface?.kind !== "terminal" ||
      activeRightPanelSurface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
    ) {
      return;
    }
    const surfaceId = activeRightPanelSurface.id;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) =>
        useRightPanelStore
          .getState()
          .splitTerminal(activeThreadRef, surfaceId, terminalId, direction),
    });
    if (!launched) return;
    setTerminalFocusRequestId((value) => value + 1);
    void launched.result;
  };
  const splitPanelTerminalStable = useStableCallback(splitPanelTerminal);
  const splitPanelTerminalVertical = () => {
    splitPanelTerminal("vertical");
  };
  const splitPanelTerminalVerticalStable = useStableCallback(splitPanelTerminalVertical);
  const activatePanelTerminal = (terminalId: string) => {
    if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
    useRightPanelStore
      .getState()
      .activateTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  };
  const activatePanelTerminalStable = useStableCallback(activatePanelTerminal);
  const closePanelTerminal = (terminalId: string) => {
    if (
      !hasTerminalWriteAccess() ||
      !activeThreadRef ||
      activeRightPanelSurface?.kind !== "terminal"
    )
      return;
    terminalActions.closeTerminalSession(terminalId);
    storeCloseTerminal(activeThreadRef, terminalId);
    useRightPanelStore
      .getState()
      .closeTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  };
  const closePanelTerminalStable = useStableCallback(closePanelTerminal);
  const requestCloseTerminal = (terminalId: string) => {
    if (!hasTerminalWriteAccess()) return;
    const label = activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
    void confirmTerminalClose([label]).then((confirmed) => {
      if (confirmed && readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        closeTerminal(terminalId);
      }
    });
  };
  const requestCloseTerminalStable = useStableCallback(requestCloseTerminal);
  const requestClosePanelTerminal = (terminalId: string) => {
    if (!hasTerminalWriteAccess()) return;
    const label = activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
    void confirmTerminalClose([label]).then((confirmed) => {
      if (confirmed && readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        closePanelTerminal(terminalId);
      }
    });
  };
  const requestClosePanelTerminalStable = useStableCallback(requestClosePanelTerminal);
  const activateRightPanelSurface = (surface: RightPanelSurface) => {
    if (!activeThreadRef) return;
    runAfterPendingFileSave(surface.id, () => {
      explicitDiffOpenRef.current = resolveExplicitDiffOpenOnActivate({
        surfaceKind: surface.kind,
        diffOpen,
        activeThreadRef,
      });
      useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
      if (surface.kind === "preview" && surface.resourceId) {
        setActivePreviewTab(activeThreadRef, surface.resourceId);
      }
      if (surface.kind === "terminal") {
        setTerminalFocusRequestId((value) => value + 1);
      }
      if (surface.kind === "diff" && !diffOpen) {
        onDiffPanelOpen?.();
      }
    });
  };
  const activateRightPanelSurfaceStable = useStableCallback(activateRightPanelSurface);
  const toggleRightPanel = () => {
    if (!activeThreadRef) return;
    if (rightPanelOpen) {
      closePreviewPanel();
      return;
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadRef);
  };
  const toggleRightPanelStable = useStableCallback(toggleRightPanel);
  const toggleThreadPanel = () => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().toggleThreadPanel(activeThreadRef, threadPanelPresentation);
  };
  const toggleThreadPanelStable = useStableCallback(toggleThreadPanel);
  useEffect(() => {
    if (!canMaximizeRightPanel) return;
    if (useRightPanelStore.getState().consumeMaximizeRequest(routeThreadRef)) {
      useRightPanelStore.getState().setMaximized(routeThreadRef, true);
    }
  }, [canMaximizeRightPanel, routeThreadRef]);
  const toggleRightPanelMaximized = () => {
    if (!canMaximizeRightPanel || !activeThreadRef) return;
    useRightPanelStore.getState().setMaximized(activeThreadRef, !rightPanelMaximized);
  };
  const toggleRightPanelMaximizedStable = useStableCallback(toggleRightPanelMaximized);
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
        if (!closed) return false;
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
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to close the panel",
            description:
              error instanceof Error ? error.message : "The panel close could not be completed.",
          }),
        );
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
  const moveRightPanelSurface = (surfaceId: string, toIndex: number) => {
    if (activeThreadRef)
      useRightPanelStore.getState().moveSurface(activeThreadRef, surfaceId, toIndex);
  };
  const moveRightPanelSurfaceStable = useStableCallback(moveRightPanelSurface);
  const copyRightPanelFilePath = (path: FileSurfacePath, format: FilePathCopyFormat) => {
    const value = resolveFilePathCopyValue({
      path,
      workspaceRoot: activeWorkspaceRoot,
      format,
    });
    if (value === null) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy full path",
          description: "This thread has no active workspace path.",
        }),
      );
      return;
    }
    void copyFilePathToClipboard({ value, format });
  };
  const copyRightPanelFilePathStable = useStableCallback(copyRightPanelFilePath);
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (action === "toggle-panel") togglePreviewPanelStable();
      }),
    [togglePreviewPanelStable],
  );
  const persistThreadSettingsForNextTurn = async (input: {
    threadId: ThreadId;
    createdAt: string;
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
      currentBranch: serverThread.branch,
      ...(input.branch ? { nextBranch: input.branch } : {}),
    });
    if (metadataUpdate) {
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
  } = useTimelineFollow({
    legendListRef,
    composerRef,
    composerOverlayElement,
    composerTimelineInset,
    routeThreadKey,
    activeThreadKey,
    activeThreadId: activeThread?.id,
    isServerThread,
    serverProjection,
    timelineMessages,
    isDraftHeroState,
    hasLatestRun: activeLatestRun !== null,
    turnUnfinished,
    currentRouteThreadKeyRef,
    setTimelineAnchor,
  });

  useEffect(() => {
    if (!activeThread?.id || terminalUiState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposerStable();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposerStable, terminalUiState.terminalOpen]);

  useEffect(() => {
    if (!activeThread?.id || terminalUiState.terminalOpen || isMobileViewport) return;
    let frame: number | null = null;
    const onWindowFocus = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      // The element that held focus receives it again after the window's own event, and the
      // composer ignores that same frame so a restored focus does not lift a scroll-collapsed
      // composer. Wait one more frame so this focus counts as a request to expand it.
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

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeMessageCount === 0) {
      return;
    }
    const removedMessages = optimisticUserMessages.filter((message) =>
      serverAcknowledgedUserMessageIds.has(message.id),
    );
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverAcknowledgedUserMessageIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviewsStable(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeMessageCount,
    activeThread?.id,
    serverAcknowledgedUserMessageIds,
    handoffAttachmentPreviewsStable,
    optimisticUserMessages,
  ]);

  // SCIENT-FORK:START — retire admitted previews permanently so editing or deleting a queue row
  // cannot reveal them again.
  const queuedAdmissionIds = new Set(
    isServerThread
      ? (serverProjection?.runs
          .filter((run) => run.status === "queued")
          .map((run) => run.userMessageId) ?? [])
      : threadQueue.items.map((item) => item.messageId),
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

  // Keyed on the thread, not the draft: a draft's promotion to its server
  // route keeps this instance and drops `draftId`, and the send it is still
  // dispatching must survive that swap.
  const [optimisticThreadId, setOptimisticThreadId] = useState(threadId);
  const [retiredOptimisticMessages, setRetiredOptimisticMessages] = useState<
    ReadonlyArray<ChatMessage>
  >([]);
  if (optimisticThreadId !== threadId) {
    setOptimisticThreadId(threadId);
    setRetiredOptimisticMessages(optimisticUserMessages);
    setOptimisticUserMessages([]);
    resetLocalDispatch();
  }
  useEffect(() => {
    for (const message of retiredOptimisticMessages) {
      revokeUserMessagePreviewUrls(message);
    }
  }, [retiredOptimisticMessages]);

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
    const isResting = overlayComposerIsResting({
      composerMounted: composerMountedRef.current,
      composerReportedResting: composerRestingRef.current,
    });
    const modelStrip = composerOverlayElement?.querySelector<HTMLElement>(
      '[data-composer-model-strip="true"]',
    );
    const restingOnlyHeight =
      modelStrip && isResting
        ? Math.max(
            0,
            modelStrip.offsetHeight + Number.parseFloat(getComputedStyle(modelStrip).marginTop),
          )
        : 0;
    const noticeStack = composerOverlayElement?.querySelector<HTMLElement>(
      '[data-composer-banner-stack="true"]',
    );
    const expandedNoticesHeight = noticeStack
      ? Math.max(
          0,
          noticeStack.getBoundingClientRect().height -
            Number.parseFloat(getComputedStyle(noticeStack).minHeight),
        )
      : 0;
    const nextInset = resolveComposerTimelineInset({
      currentInset: composerTimelineInsetRef.current,
      overlayHeight: height,
      isResting,
      restingOnlyHeight,
      expandedNoticesHeight,
    });
    if (composerTimelineInsetRef.current !== nextInset) {
      composerTimelineInsetRef.current = nextInset;
      setComposerTimelineInset(nextInset);
    }
    // The terminal drawer and the empty placeholder lay out against the
    // expanded composer. The timeline inset already holds it through the
    // desktop resting row; remembering it while the mobile strip is collapsed
    // keeps both still when focus moves between the composer and the
    // terminal, instead of re-clamping the drawer against each intermediate
    // composer height. A collapsed strip can still grow (approvals, tasks), so
    // the reservation follows it up. A hero composer's overlay fills the pane,
    // so only its stack counts there.
    const stack = composerOverlayElement?.querySelector<HTMLElement>(
      '[data-chat-composer-stack="true"]',
    );
    const expandedComposerHeight =
      isDraftHeroState && stack ? Math.ceil(stack.getBoundingClientRect().height) : nextInset;
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
    const button = composerOverlayElement?.parentElement?.querySelector<HTMLElement>(
      'button[aria-label="Scroll to end"]',
    );
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
  // The composer reports its resting flag from a layout effect, which runs
  // before this component's own layout effects and before any resize
  // observation, so every measurement below sees the flag for its layout.
  const onComposerRestingChange = (resting: boolean) => {
    composerRestingRef.current = resting;
  };
  const onComposerRestingChangeStable = useStableCallback(onComposerRestingChange);
  useLayoutEffect(() => {
    if (!composerOverlayElement) return;
    composerTimelineInsetRef.current = 0;
    composerReservedHeightRef.current = 0;
    composerExpandedHeightRef.current = 0;
    publishComposerOverlayHeightStable(composerOverlayElement.getBoundingClientRect().height);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A thread switch must re-measure the overlay for the new timeline.
  }, [activeThreadKey, composerOverlayElement, publishComposerOverlayHeightStable]);

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
  useLayoutEffect(() => {
    if (composerMountedRef.current === composerMounted) return;
    composerMountedRef.current = composerMounted;
    if (!composerOverlayElement) return;
    composerTimelineInsetRef.current = 0;
    composerReservedHeightRef.current = 0;
    composerExpandedHeightRef.current = 0;
    publishComposerOverlayHeightStable(composerOverlayElement.getBoundingClientRect().height);
  }, [composerMounted, composerOverlayElement, publishComposerOverlayHeightStable]);
  const openPanelPullRequestUrl = useOpenPanelPullRequestUrl(activeThreadRef);
  const activeThreadReferenceCopyTarget =
    activeThreadId === null || !isServerThread
      ? null
      : resolveThreadReferenceCopyTarget({
          threadId: activeThreadId,
          openPanelPullRequestUrl,
          pullRequests: activeThread?.pullRequests,
          linkedPullRequestUrl: linkedThreadPullRequest?.url ?? null,
        });
  const copyActiveThreadReference = () => {
    const target = activeThreadReferenceCopyTarget;
    if (target === null) return;
    void writeTextToClipboard(target.value, target.clipboardTarget).then(
      (didCopy) => {
        if (!didCopy) return;
        toastManager.add({
          type: "success",
          title: target.successTitle,
          description: target.value,
        });
      },
      (error) => {
        console.error(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: target.failureTitle,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  };
  const copyActiveThreadReferenceStable = useStableCallback(copyActiveThreadReference);
  const pullRequestPanelTarget = activeThread
    ? threadPullRequestPanelTarget({
        projectId: activeThread.projectId,
        pullRequests: visiblePullRequests,
        linkedPullRequest: linkedThreadPullRequest,
        branchPullRequest: activeThreadShell?.branchPullRequest ?? activeThread.branchPullRequest,
      })
    : null;
  const addPullRequestSurface = () => {
    if (!supportsPullRequests || activeThreadRef === null || pullRequestPanelTarget === null)
      return;
    useRightPanelStore.getState().openPullRequest(activeThreadRef, pullRequestPanelTarget);
  };
  const addPullRequestSurfaceStable = useStableCallback(addPullRequestSurface);
  const pullRequestSurfaceAvailable = supportsPullRequests && pullRequestPanelTarget !== null;
  const supportsSettlement = serverConfig?.environment.capabilities.threadSettlement === true;
  const supportsSnooze = serverConfig?.environment.capabilities.threadSnooze === true;
  const supportsPinning = serverConfig?.environment.capabilities.threadPinning === true;
  const activeThreadPinned = supportsPinning && activeThreadShell?.pinnedAt != null;
  const nowMinute = useNowMinute();
  const snoozeClock = useThreadSnoozeClock(
    activeThreadShell,
    supportsSnooze ? (activeThreadShell?.snoozedUntil ?? null) : null,
  );
  const activeThreadSnoozed =
    activeThreadShell !== null &&
    supportsSnooze &&
    effectiveSnoozed(activeThreadShell, { now: snoozeClock });
  const activeThreadWokeAt =
    activeThreadShell !== null && supportsSnooze
      ? threadWokeAt(activeThreadShell, { now: snoozeClock })
      : null;
  const acknowledgeThreadWoke = useAcknowledgeThreadWoke();
  const acknowledgeActiveThreadWoke = () => {
    if (activeThreadRef === null || activeThreadWokeAt === null) return;
    acknowledgeThreadWoke(activeThreadRef, activeThreadWokeAt);
  };
  const acknowledgeActiveThreadWokeStable = useStableCallback(acknowledgeActiveThreadWoke);
  const activeThreadLocalVisitedAt = useUiStateStore((store) =>
    activeThreadKey === null ? undefined : store.threadLastVisitedAtById[activeThreadKey],
  );
  const activeThreadLastVisitedAt = resolveThreadLastVisitedAt(
    activeThreadShell?.lastVisitedAt,
    activeThreadLocalVisitedAt,
  );
  const activeThreadWokeVisible = isThreadWokeUnseen({
    wokeAt: activeThreadWokeAt,
    settled: activeThreadShell?.settledOverride === "settled",
    lastVisitedAt: activeThreadLastVisitedAt,
    latestRunCompletedAt: activeLatestRun?.completedAt ?? null,
  });
  const activeThreadSettled =
    supportsSettlement && activeThreadShell?.settledOverride === "settled";
  const unsettleThreadMutation = useOrchestrationCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });
  const [unsettlingThreadKey, setUnsettlingThreadKey] = useState<string | null>(null);
  const isUnsettling = unsettlingThreadKey !== null && unsettlingThreadKey === activeThreadKey;
  const handleUnsettleActiveThread = async () => {
    if (
      !activeThreadRef ||
      !readEnvironmentScope(activeThreadRef.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsettlingThreadKey(threadKey);
    // Commands settle into a result, so this always runs.
    const result = await unsettleThreadMutation({
      environmentId: activeThreadRef.environmentId,
      input: { threadId: activeThreadRef.threadId, reason: "user" },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to un-settle thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
    setUnsettlingThreadKey((current) => (current === threadKey ? null : current));
  };
  const handleUnsettleActiveThreadStable = useStableCallback(handleUnsettleActiveThread);
  const unsnoozeThreadMutation = useOrchestrationCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  });
  const [unsnoozingThreadKey, setUnsnoozingThreadKey] = useState<string | null>(null);
  const isUnsnoozing = unsnoozingThreadKey !== null && unsnoozingThreadKey === activeThreadKey;
  const handleUnsnoozeActiveThread = async () => {
    if (
      !activeThreadRef ||
      !readEnvironmentScope(activeThreadRef.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsnoozingThreadKey(threadKey);
    // Commands settle into a result, so this always runs.
    const recovery = activeThreadShell?.limitRecovery;
    const recoveryOwnsSnooze =
      recovery?.snooze === true &&
      recovery.runId === activeThreadShell?.latestRun?.runId &&
      activeThreadShell?.snoozedUntil != null &&
      Date.parse(activeThreadShell.snoozedUntil) === Date.parse(recovery.resetAt);
    const result = recoveryOwnsSnooze
      ? await updateThreadMetadata({
          environmentId: activeThreadRef.environmentId,
          input: {
            threadId: activeThreadRef.threadId,
            limitRecovery: { runId: recovery.runId, resetAt: recovery.resetAt, snooze: false },
          },
        })
      : await unsnoozeThreadMutation({
          environmentId: activeThreadRef.environmentId,
          input: { threadId: activeThreadRef.threadId, reason: "user" },
        });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to wake thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
    setUnsnoozingThreadKey((current) => (current === threadKey ? null : current));
  };
  const handleUnsnoozeActiveThreadStable = useStableCallback(handleUnsnoozeActiveThread);
  const [isRestoringThreadBranch, setIsRestoringThreadBranch] = useState(false);
  const [revealedBranchMismatchKey, setRevealedBranchMismatchKey] = useState<string | null>(null);
  const [, setBranchMismatchDismissTick] = useState(0);
  const composerHasDraftContent = useComposerDraftStore((store) =>
    composerDraftHasUserContent(store.getComposerDraft(composerDraftTarget)),
  );
  const activeBranchMismatchKey = branchMismatchKey(
    activeThread?.id ?? null,
    localCheckoutBranchMismatch,
  );
  const showBranchMismatchBanner = shouldShowBranchMismatchBanner({
    hasMismatch: localCheckoutBranchMismatch !== null,
    isDismissed: isBranchMismatchDismissedForSession(activeBranchMismatchKey),
    composerHasContent: composerHasDraftContent,
    wasShownForCurrentMismatch:
      revealedBranchMismatchKey !== null && revealedBranchMismatchKey === activeBranchMismatchKey,
  });
  const nextRevealedBranchMismatchKey = showBranchMismatchBanner
    ? activeBranchMismatchKey
    : revealedBranchMismatchKey !== activeBranchMismatchKey
      ? null
      : revealedBranchMismatchKey;
  if (nextRevealedBranchMismatchKey !== revealedBranchMismatchKey) {
    setRevealedBranchMismatchKey(nextRevealedBranchMismatchKey);
  }
  const handleSwitchCheckoutToThread = async () => {
    if (!canWriteSourceControl) return;
    if (
      !activeProjectCwd ||
      !activeThread ||
      !localCheckoutBranchMismatch ||
      isRestoringThreadBranch
    ) {
      return;
    }
    setIsRestoringThreadBranch(true);
    const checkoutResult = await switchGitRef({
      environmentId,
      input: {
        cwd: activeProjectCwd,
        refName: localCheckoutBranchMismatch.threadBranch,
      },
    });
    if (checkoutResult._tag === "Failure") {
      setIsRestoringThreadBranch(false);
      if (!isAtomCommandInterrupted(checkoutResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch checkout",
            description: chatActionErrorMessage(squashAtomCommandFailure(checkoutResult)),
          }),
        );
      }
      return;
    }

    if (!readEnvironmentScope(environmentId, AuthSourceControlWriteScope)) {
      setIsRestoringThreadBranch(false);
      return;
    }
    const nextBranch = checkoutResult.value.refName ?? localCheckoutBranchMismatch.threadBranch;
    if (nextBranch !== activeThread.branch) {
      const updateResult = await updateThreadMetadata({
        environmentId,
        input: { threadId: activeThread.id, branch: nextBranch, worktreePath: null },
      });
      if (updateResult._tag === "Failure") {
        setIsRestoringThreadBranch(false);
        if (!isAtomCommandInterrupted(updateResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Checkout switched, but the thread could not be updated",
              description: chatActionErrorMessage(squashAtomCommandFailure(updateResult)),
            }),
          );
        }
        gitStatusQuery.refresh();
        return;
      }
    }
    gitStatusQuery.refresh();
    setIsRestoringThreadBranch(false);
    scheduleComposerFocus();
  };
  const handleSwitchCheckoutToThreadStable = useStableCallback(() => {
    void handleSwitchCheckoutToThread();
  });
  // The interrupt path also accepts a completed run while its provider still
  // has background work.
  const activeBackgroundTasks = !isWorking && activeThread ? pendingBackgroundTasks : [];
  const [stoppingBackgroundWorkKey, setStoppingBackgroundWorkKey] = useState<string | null>(null);
  const isStoppingBackgroundWork =
    stoppingBackgroundWorkKey === `${environmentId}:${activeThreadId}`;
  const handleStopBackgroundWork = async () => {
    if (!activeThread || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    const requestKey = `${environmentId}:${activeThread.id}`;
    setStoppingBackgroundWorkKey(requestKey);
    const result = await interruptThreadTurn({
      environmentId,
      input: { threadId: activeThread.id },
    });
    // Acceptance does not confirm termination. Allow retry while the provider
    // finishes stopping the tasks or reports a failure.
    setStoppingBackgroundWorkKey((current) => (current === requestKey ? null : current));
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to stop background work.",
        );
      }
    }
  };
  const handleStopBackgroundWorkStable = useStableCallback(handleStopBackgroundWork);
  const openRelatedThreadGenerationRef = useRef(0);
  const onOpenRelatedThread = async (threadId: ThreadId) => {
    const generation = ++openRelatedThreadGenerationRef.current;
    const threadRef = scopeThreadRef(environmentId, threadId);
    const isEnvironmentLive = () =>
      appAtomRegistry.get(environmentShell.stateValueAtom(environmentId)).status === "live";
    // A just-launched child can reach this timeline before its shell syncs.
    if (isEnvironmentLive() && readThreadShell(threadRef) === null) {
      const location = router.latestLocation;
      await waitForThreadShell(threadRef, RELATED_THREAD_SHELL_WAIT_MS);
      if (
        generation !== openRelatedThreadGenerationRef.current ||
        currentRouteThreadKeyRef.current !== routeThreadKey ||
        router.latestLocation !== location
      ) {
        return;
      }
    }
    const shell = readThreadShell(threadRef);
    if (shell === null ? isEnvironmentLive() : shell.deletedAt != null) {
      toastManager.add({ type: "info", title: "This thread is no longer available" });
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };
  const onOpenRelatedThreadStable = useStableCallback(onOpenRelatedThread);
  const childThreadInputs = useChildThreadInputs(activeThreadRef);
  const childInputBanner = childInputBannerItem({
    childThreadInputs,
    parentAwaitingUser: Boolean(
      activePendingApproval || activePendingUserInput || activeThreadShell?.hasPendingUserInput,
    ),
    onOpenThread: onOpenRelatedThreadStable,
  });

  const sendStandaloneCommand = async (text: string, failureMessage: string) => {
    if (!activeThread || !clientSettingsHydrated || sendInFlightRef.current) return;
    const context = composerRef.current?.getSendContext();
    if (!context?.providerAvailable) return;

    const threadId = activeThread.id;
    const messageId = newMessageId();
    const createdAt = new Date().toISOString();
    sendInFlightRef.current = true;
    beginLocalDispatch();
    setThreadError(threadId, null);
    setOptimisticUserMessages((messages) => [
      ...messages,
      {
        id: messageId,
        role: "user",
        text,
        runId: null,
        createdAt,
        updatedAt: createdAt,
        streaming: false,
      },
    ]);
    scrollToEnd();
    // Commands settle into a result, so this always runs.
    const settingsResult = await persistThreadSettingsForNextTurn({
      threadId,
      createdAt,
      ...(localCheckoutBranchMismatch ? { branch: localCheckoutBranchMismatch.currentBranch } : {}),
      runtimeMode,
      interactionMode: context.interactionMode,
    });
    const result =
      settingsResult._tag === "Failure"
        ? settingsResult
        : await startThreadTurn({
            environmentId,
            input: {
              threadId,
              message: { messageId, role: "user", text, attachments: [] },
              modelSelection: context.selectedModelSelection,
              runtimeMode,
              interactionMode: context.interactionMode,
              createdAt,
            },
          });
    if (result._tag === "Failure") {
      setOptimisticUserMessages((messages) =>
        messages.filter((message) => message.id !== messageId),
      );
      resetLocalDispatch();
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(threadId, error instanceof Error ? error.message : failureMessage);
      }
    } else {
      clearUsageLimitsFor(routeThreadKey);
    }
    sendInFlightRef.current = false;
  };
  const sendStandaloneCommandStable = useStableCallback(sendStandaloneCommand);
  const activeGoal = activeThreadShell?.goal ?? null;
  const goalBanner =
    activeThread && activeGoal !== null
      ? goalBannerItem({
          threadId: activeThread.id,
          goal: activeGoal,
          isWorking,
          onSendCommand: sendStandaloneCommandStable,
        })
      : null;

  const backgroundWorkBanner = activeThread
    ? backgroundWorkBannerItem({
        threadId: activeThread.id,
        tasks: activeBackgroundTasks,
        stopDisabled: !canOperateThread || isStoppingBackgroundWork,
        stopping: isStoppingBackgroundWork,
        onStop: handleStopBackgroundWorkStable,
        onOpenThread: onOpenRelatedThreadStable,
      })
    : null;
  // The relative times read the clock; nowMinute re-renders them on the minute.
  const snoozedUntil = activeThreadShell?.snoozedUntil ?? null;
  const settledAt = activeThreadShell?.settledAt ?? null;
  const threadStatusLine = activeThreadSnoozed ? (
    <ThreadStatusLine
      icon={<AlarmClockIcon />}
      label={snoozedUntil ? `Snoozed, ${formatRelativeTimeUntilLabel(snoozedUntil)}` : "Snoozed"}
      clockMinute={nowMinute}
      actionLabel={isUnsnoozing ? "Waking..." : "Wake now"}
      actionDisabled={!canOperateThread || isUnsnoozing}
      onAction={() => void handleUnsnoozeActiveThreadStable()}
    />
  ) : activeThreadSettled ? (
    <ThreadStatusLine
      icon={<CheckCircle2Icon />}
      label={settledAt ? `Settled ${formatRelativeTimeLabel(settledAt)}` : "Settled"}
      clockMinute={nowMinute}
      actionLabel={isUnsettling ? "Un-settling..." : "Un-settle"}
      actionDisabled={!canOperateThread || isUnsettling}
      onAction={() => void handleUnsettleActiveThreadStable()}
    />
  ) : activeThreadWokeVisible ? (
    <ThreadStatusLine
      icon={<AlarmClockIcon />}
      label="Woke from snooze"
      actionLabel="Dismiss"
      onAction={acknowledgeActiveThreadWokeStable}
    />
  ) : null;
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
    const backgroundWorkItems = [childInputBanner, goalBanner, backgroundWorkBanner].filter(
      (item) => item !== null,
    );
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
        ...backgroundWorkItems,
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
      ...backgroundWorkItems,
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

  // A launch context only overrides the drawer's cwd until the thread's own
  // location catches up, the drawer closes, or the thread changes.
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

  useEffect(() => {
    if (!activeThreadKey) return;
    const previous = terminalUiOpenByThreadRef.current[activeThreadKey] ?? false;
    const current = Boolean(terminalUiState.terminalOpen);

    if (!previous && current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposerStable();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalUiOpenByThreadRef.current[activeThreadKey] = current;
  }, [activeThreadKey, focusComposerStable, terminalUiState.terminalOpen]);

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
  const threadFindControlsRef = useRef<ThreadFindControls | null>(null);
  const [isThreadFindActive, setIsThreadFindActive] = useState(false);
  const openThreadFind = () => threadFindControlsRef.current?.open();
  const openThreadFindStable = useStableCallback(openThreadFind);
  const closeThreadFind = () => threadFindControlsRef.current?.close();
  const closeThreadFindStable = useStableCallback(closeThreadFind);

  const toastPinFailure = (title: string) => (result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };
  const openTerminalIfClosed = () => {
    if (!terminalUiState.terminalOpen) setTerminalOpenStable(true);
  };
  const openComposerControl = (command: Parameters<ChatComposerHandle["openControl"]>[0]) =>
    (({ event }) => {
      if (!event.repeat) composerRef.current?.openControl(command);
    }) satisfies ChatShortcutHandler;
  useChatShortcuts({
    enabled: activeThreadId !== null,
    keybindings,
    scriptKeybindings,
    getShortcutContext: getShortcutContextStable,
    threadFindActive: isThreadFindActive,
    typeIntoComposer: (key) => composerRef.current?.insertTextAtEnd(key) === true,
    closeThreadFind: () => {
      closeThreadFindStable();
      focusComposerStable();
    },
    commands: {
      "thread.copyReference": ({ event }) => {
        if (!event.repeat) copyActiveThreadReferenceStable();
      },
      "thread.settle": () => {
        if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return false;
        if (!isServerThread || !activeThreadRef || !supportsSettlement) return;
        if (activeThreadSettled) {
          void handleUnsettleActiveThreadStable();
          return;
        }
        if (settleAndAdvance(activeThreadRef)) return;
        void settleThread(activeThreadRef).then(toastPinFailure("Failed to settle thread"));
      },
      "thread.pin": () => {
        if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return false;
        if (!isServerThread || !activeThreadRef || !supportsPinning) return;
        void (
          activeThreadPinned ? confirmAndUnpinThread(activeThreadRef) : pinThread(activeThreadRef)
        ).then(
          toastPinFailure(activeThreadPinned ? "Failed to unpin thread" : "Failed to pin thread"),
        );
      },
      "terminal.toggle": () => {
        if (!terminalUiState.terminalOpen && !canReadTerminal && !canOperateTerminal) return false;
        toggleTerminalVisibilityStable();
      },
      "chat.find": () => {
        if (!isServerThread || serverConfig?.threadFind !== true) return false;
        openThreadFindStable();
      },
      "rightPanel.toggle": () => toggleRightPanelStable(),
      "rightPanel.toggleMaximized": ({ event }) => {
        if (!event.repeat) toggleRightPanelMaximizedStable();
      },
      "threadPanel.toggle": () => toggleThreadPanelStable(),
      "rightPanel.close": ({ event }) => {
        if (!activeRightPanelSurface) return false;
        if (!event.repeat) closeRightPanelSurfaceStable(activeRightPanelSurface);
      },
      // SCIENT-FORK:START — side-panel tab commands: an open panel's tab bar
      // handles a new tab itself, a closed panel opens with one
      "rightPanel.new": ({ event }) => {
        if (rightPanelOpen || !activeThreadRef) return false;
        if (!event.repeat) addNewTabSurface();
      },
      "rightPanel.nextTab": () => {
        if (!rightPanelOpen) return false;
        const target = adjacentPanelSurface(
          renderedRightPanelSurfaces,
          renderedRightPanelSurface?.id ?? null,
          1,
        );
        if (!target) return false;
        activateRightPanelSurfaceStable(target);
      },
      "rightPanel.previousTab": () => {
        if (!rightPanelOpen) return false;
        const target = adjacentPanelSurface(
          renderedRightPanelSurfaces,
          renderedRightPanelSurface?.id ?? null,
          -1,
        );
        if (!target) return false;
        activateRightPanelSurfaceStable(target);
      },
      "rightPanel.duplicateTab": ({ event }) => {
        if (!rightPanelOpen || !renderedRightPanelSurface) return false;
        if (
          !canDuplicatePanelSurface(renderedRightPanelSurface, {
            browserAvailable: canOperatePreview && browserAvailable,
          })
        ) {
          return false;
        }
        if (!event.repeat) duplicateRightPanelSurface(renderedRightPanelSurface);
      },
      "rightPanel.toggleFiles": ({ event }) => {
        if (!rightPanelOpen || !panelFilesToggleApplies(renderedRightPanelSurface)) return false;
        if (!event.repeat) setPanelFilesOpen(!panelFilesOpen);
      },
      // SCIENT-FORK:END
      "terminal.split": ({ terminalFocusOwner }) => {
        if (!canOperateTerminal) return false;
        if (terminalFocusOwner === "right-panel") return void splitPanelTerminalStable();
        openTerminalIfClosed();
        splitTerminalStable();
      },
      "terminal.splitVertical": ({ terminalFocusOwner }) => {
        if (!canOperateTerminal) return false;
        if (terminalFocusOwner === "right-panel") return void splitPanelTerminalStable("vertical");
        openTerminalIfClosed();
        splitTerminalStable("vertical");
      },
      "terminal.close": ({ terminalFocusOwner }) => {
        if (!canOperateTerminal) return false;
        if (terminalFocusOwner === "right-panel" && activeRightPanelSurface?.kind === "terminal") {
          requestClosePanelTerminalStable(activeRightPanelSurface.activeTerminalId);
          return;
        }
        if (terminalUiState.terminalOpen)
          requestCloseTerminalStable(terminalUiState.activeTerminalId);
      },
      "terminal.new": ({ terminalFocusOwner }) => {
        if (!canOperateTerminal) return false;
        if (terminalFocusOwner === "right-panel") return void addTerminalSurfaceStable();
        openTerminalIfClosed();
        createNewTerminalStable();
      },
      "diff.toggle": () => onToggleDiffStable(),
      "modelPicker.toggle": ({ event }) => {
        if (!event.repeat) composerRef.current?.toggleModelPicker();
      },
      "composer.increaseEffort": ({ event }) => {
        if (!event.repeat) composerRef.current?.stepReasoningEffort(1);
      },
      "composer.decreaseEffort": ({ event }) => {
        if (!event.repeat) composerRef.current?.stepReasoningEffort(-1);
      },
      "composer.host": openComposerControl("composer.host"),
      "composer.effort": openComposerControl("composer.effort"),
      "composer.mode": openComposerControl("composer.mode"),
      "composer.workspace": openComposerControl("composer.workspace"),
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
      // SCIENT-FORK:START — queue shortcuts are decided by the Scient queue (threadQueue/queueShortcuts).
      "thread.steerQueuedMessage": ({ event }) =>
        steerQueuedMessageShortcut({
          repeat: event.repeat,
          nativeQueue: queuedRunsControlRef.current,
          stripHead: threadQueue.items[0],
          steerStripItem: (item) =>
            void threadQueue.control("steer", item.queueItemId).catch((cause) => {
              if (activeThreadId) setThreadError(activeThreadId, chatActionErrorMessage(cause));
            }),
        }),
      "thread.editQueuedMessage": ({ event }) =>
        editQueuedMessageShortcut({
          repeat: event.repeat,
          nativeQueue: queuedRunsControlRef.current,
        }),
      // SCIENT-FORK:END
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
  useEffect(() => {
    return window.desktopBridge?.onMenuAction((action) => {
      if (action === "rightPanel.toggle") toggleRightPanelStable();
      else if (action === "rightPanel.toggleMaximized") toggleRightPanelMaximizedStable();
    });
  }, [toggleRightPanelStable, toggleRightPanelMaximizedStable]);

  // Paste-to-focus: the resting composer blurs on a click into the timeline,
  // so a paste that follows has no editable target and would be dropped.
  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if (
        shouldRedirectInputToComposer(event) &&
        isPasteAsTextShortcut(event, isMacPlatform(navigator.platform))
      ) {
        pasteAsTextShortcutUntilRef.current = Date.now() + 1_000;
      }
    };
    const handler = (event: ClipboardEvent) => {
      if (!activeThreadId || isCommandPaletteOpen()) return;
      if (getTerminalFocusOwner() !== null) return;
      if (composerRef.current?.isModelPickerOpen()) return;
      const text = pasteTextToFocusComposer(event);
      const clipboardData = event.clipboardData;
      if (text === null || clipboardData === null) return;
      const bypassAutoAttachment = Date.now() <= pasteAsTextShortcutUntilRef.current;
      pasteAsTextShortcutUntilRef.current = 0;
      if (
        ((readPastedComposerContext(clipboardData)?.records.length ?? 0) === 0 &&
          composerRef.current?.pasteTextAtEnd(text, { bypassAutoAttachment })) ||
        composerRef.current?.insertTextAtEnd(text, { clipboardData })
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", keyHandler, true);
    window.addEventListener("paste", handler, true);
    return () => {
      window.removeEventListener("keydown", keyHandler, true);
      window.removeEventListener("paste", handler, true);
    };
  }, [activeThreadId, composerRef]);

  if (pendingRevert && pendingRevert.routeThreadKey !== routeThreadKey) {
    setPendingRevert(null);
  }

  const onRevertToTurnCount = async (
    turnCount: number,
    messageId: MessageId,
    restoreFiles?: boolean,
  ) => {
    const localApi = readLocalApi();
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !hasProjectWorkspace ||
      !localApi ||
      !activeThread ||
      isRevertingCheckpoint
    ) {
      return;
    }
    const message = timelineMessages.find((message) => message.id === messageId);
    if (!message || message.role !== "user") return;

    if (!supportsConversationRollback) {
      setPendingRevert({
        turnCount,
        messageId,
        routeThreadKey,
        error:
          "This provider does not support reverting conversation history. Start a new thread instead.",
      });
      return;
    }
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setPendingRevert({
        turnCount,
        messageId,
        routeThreadKey,
        error: `Reconnect ${activeEnvironmentUnavailableLabel} before rewinding.`,
      });
      return;
    }
    if (phase === "running" || isSendBusy || isConnecting) {
      setPendingRevert({
        turnCount,
        messageId,
        routeThreadKey,
        error: "Stop the current turn before rewinding.",
      });
      return;
    }
    if (restoreFiles === undefined) {
      setPendingRevert({ turnCount, messageId, routeThreadKey });
      return;
    }

    setPendingRevert({ turnCount, messageId, routeThreadKey });
    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    const rewind = await rewindToMessage({
      message,
      environmentId,
      routeThreadRef,
      threadId: activeThread.id,
      turnCount,
      restoreFiles,
      // Keep the live checkpoint identity when command context refetches a bounded window.
      checkpoint: findRevertCheckpoint(serverProjection?.checkpoints ?? [], turnCount),
      draftTarget: composerDraftTarget,
      composerHasPendingAttachments: composerRef.current?.hasPendingAttachments() === true,
      createAssetUrl: createAttachmentAssetUrl,
      revertThreadCheckpoint,
    });
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
    // SCIENT-FORK:START — the rewind dialog stays open on failure and shows why; success closes it.
    const rewindError = rewind.error;
    setPendingRevert((current) =>
      current?.routeThreadKey !== routeThreadKey
        ? current
        : rewindError === null
          ? null
          : { ...current, error: rewindError },
    );
    if (rewindError !== null) return;
    // SCIENT-FORK:END
    if (currentRouteThreadKeyRef.current === routeThreadKey) {
      const nextPrompt = rewind.prompt;
      promptRef.current = nextPrompt;
      composerRef.current?.resetCursorState({ prompt: nextPrompt, cursor: nextPrompt.length });
      requestAnimationFrame(() => {
        if (currentRouteThreadKeyRef.current === routeThreadKey) composerRef.current?.focusAtEnd();
      });
    }
  };
  const onRevertToTurnCountStable = useStableCallback(onRevertToTurnCount);

  const onRollbackCheckpoint = async (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => {
    if (!activeThread || isRevertingCheckpoint) return;
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
      );
      return;
    }
    if (phase === "running" || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    const localApi = readLocalApi();
    const confirmed =
      localApi == null
        ? window.confirm("Roll back this thread to the selected checkpoint?")
        : await localApi.dialogs.confirm(
            "Roll back this thread to the selected checkpoint?\nThis action cannot be undone.",
          );
    if (!confirmed) return;

    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    const result = await revertThreadCheckpoint({
      environmentId,
      input: {
        threadId: activeThread.id,
        checkpointId: input.checkpointId,
        scopeId: input.scopeId,
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to revert thread state.",
      );
    }
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
  };

  const onForkFromRun = async (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => {
    if (!activeThread || activeEnvironmentUnavailable) return;
    const targetThreadId = newThreadId();
    const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
    const result = await forkThreadFromRun({
      environmentId,
      input: {
        sourceThreadId: input.sourceThreadId,
        targetThreadId,
        runId: input.runId,
        title: `${activeThread.title} fork`,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to fork this response.",
        );
      }
      return;
    }
    const targetThreadReady = await waitForThreadShell(targetThreadRef);
    if (!targetThreadReady) {
      setThreadError(
        activeThread.id,
        "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
      );
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetThreadRef),
    });
  };
  const onForkFromRunStable = useStableCallback(onForkFromRun);
  const onCompactContext = async () => {
    const readingPositionAtSend = captureSendReadingPosition();
    if (compactDisabled || !activeThread || !clientSettingsHydrated || sendInFlightRef.current) {
      return;
    }
    const context = composerRef.current?.getSendContext();
    if (!context?.providerAvailable) return;

    // Compaction is a standalone command; the draft and its attachments stay local.
    const threadId = activeThread.id;
    const messageId = newMessageId();
    const createdAt = new Date().toISOString();
    sendInFlightRef.current = true;
    beginLocalDispatch();
    setThreadError(threadId, null);
    setOptimisticUserMessages((messages) => [
      ...messages,
      {
        id: messageId,
        role: "user",
        text: "/compact",
        runId: null,
        createdAt,
        updatedAt: createdAt,
        streaming: false,
      },
    ]);
    frameSubmittedMessage(messageId, readingPositionAtSend);
    // Commands settle into a result, so this always runs.
    const settingsResult = await persistThreadSettingsForNextTurn({
      threadId,
      createdAt,
      ...(localCheckoutBranchMismatch ? { branch: localCheckoutBranchMismatch.currentBranch } : {}),
      runtimeMode,
      interactionMode: context.interactionMode,
    });
    const result =
      settingsResult._tag === "Failure"
        ? settingsResult
        : await startThreadTurn({
            environmentId,
            input: {
              threadId,
              message: { messageId, role: "user", text: "/compact", attachments: [] },
              modelSelection: context.selectedModelSelection,
              runtimeMode,
              interactionMode: context.interactionMode,
              createdAt,
            },
          });
    if (result._tag === "Failure") {
      setOptimisticUserMessages((messages) =>
        messages.filter((message) => message.id !== messageId),
      );
      resetLocalDispatch();
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          threadId,
          error instanceof Error ? error.message : "Failed to compact context.",
        );
      }
    } else {
      clearUsageLimitsFor(routeThreadKey);
      if ("queued" in result.value && result.value.queued === true) {
        setOptimisticUserMessages((messages) =>
          messages.filter((message) => message.id !== messageId),
        );
        resetLocalDispatch();
        void threadQueue.refresh();
      }
    }
    sendInFlightRef.current = false;
  };

  const onResume = async () => {
    if (
      !activeThread ||
      (resumableRunId === null && !hasHeldQueuedRuns) ||
      isSendBusy ||
      isResuming ||
      isConnecting ||
      isRevertingCheckpoint ||
      threadDetailLoading ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }
    const threadId = activeThread.id;
    const modelSelection = composerRef.current?.getSendContext().selectedModelSelection;
    sendInFlightRef.current = true;
    setResumingThreadKeys((current) => new Set(current).add(routeThreadKey));
    setThreadError(threadId, null);
    // Commands settle into a result, so this always runs.
    const resume = async () => {
      if (resumableRunId === null) {
        return resumeThreadQueue({ environmentId, input: { threadId } });
      }
      const createdAt = new Date().toISOString();
      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId,
        createdAt,
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode,
      });
      if (settingsResult._tag === "Failure") return settingsResult;
      const turnResult = await startThreadTurn({
        environmentId,
        input: {
          threadId,
          manualContinuationOfRunId: resumableRunId,
          ...(modelSelection ? { modelSelection } : {}),
          message: {
            messageId: newMessageId(),
            role: "user",
            text: "Continue where you left off.",
            attachments: [],
          },
          runtimeMode,
          interactionMode,
          dispatchMode: "start",
        },
      });
      if (turnResult._tag === "Failure" || !hasHeldQueuedRuns) return turnResult;
      clearUsageLimitsFor(routeThreadKey);
      return resumeThreadQueue({ environmentId, input: { threadId } });
    };
    const result = await resume();
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          threadId,
          error instanceof Error ? error.message : "Could not resume thread.",
        );
      }
    } else {
      clearUsageLimitsFor(routeThreadKey);
      if (currentRouteThreadKeyRef.current === routeThreadKey) scrollToEnd();
    }
    sendInFlightRef.current = false;
    setResumingThreadKeys((current) => {
      const next = new Set(current);
      next.delete(routeThreadKey);
      return next;
    });
  };

  // SCIENT-FORK: the same accepted-send guard covers ordinary and plan follow-ups.
  const declineApprovalsForSend = async ({
    sendCtx,
    pendingApprovalIdsAtSend,
    promptAtSend,
    promptForSend = promptAtSend,
    annotationImageId,
  }: {
    sendCtx: ReturnType<ChatComposerHandle["getSendContext"]>;
    pendingApprovalIdsAtSend: ReturnType<
      ChatComposerHandle["getSendContext"]
    >["shownPendingApprovalIds"];
    promptAtSend: string;
    promptForSend?: string;
    annotationImageId?: string | undefined;
  }) => {
    const imageIds = sendCtx.images.map((image) => image.id);
    const fileIds = sendCtx.files.map((file) => file.id);
    const attachmentIds = [...imageIds, ...fileIds];
    const annotationIds =
      annotationImageId && !imageIds.includes(annotationImageId)
        ? [...imageIds, annotationImageId, ...fileIds]
        : attachmentIds;
    const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
      left.length === right.length && left.every((id, index) => id === right[index]);
    const result = await declineShownApprovalsBeforeSend({
      shownApprovalIds: sendCtx.shownPendingApprovalIds,
      pendingApprovalIdsAtSend,
      readPendingApprovals: () => pendingApprovalsRef.current,
      readRespondingIds: () => respondingRequestIdsRef.current,
      readDraft: () => useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
      isCurrentSend: () => {
        if (
          currentRouteThreadKeyRef.current !== routeThreadKey ||
          composerRef.current?.hasPendingAttachments() === true
        )
          return false;
        const current = composerRef.current?.getSendContext();
        if (!current) return false;
        const currentIds = [...current.images, ...current.files].map((attachment) => attachment.id);
        return (
          (promptRef.current === promptAtSend || promptRef.current === promptForSend) &&
          (sameIds(currentIds, attachmentIds) || sameIds(currentIds, annotationIds))
        );
      },
      respond: onRespondToApprovalStable,
    });
    if (result === "ready") return true;
    setDockedDraftHeroThreadKey((key) => (key === activeThreadKey ? null : key));
    if (result !== "decline-failed") {
      toastManager.add({
        type: "info",
        title:
          result === "changed"
            ? "Your message changed or you left this thread, so it wasn't sent."
            : result === "responding"
              ? "An approval is already being answered, so your message wasn't sent."
              : "Another approval arrived, so your message wasn't sent.",
        description: "Send again when it's ready.",
      });
    }
    return false;
  };

  // A follow-up returns its durable admission identity so only an accepted send
  // retires a queue edit and clears its matching draft.
  const onSubmitPlanFollowUp = useStableCallback(
    async ({
      text,
      context,
      interactionMode: nextInteractionMode,
      selectedScientSkillNames,
      readingPositionAtSend,
      composerSnapshot,
      sourceProposedPlan,
    }: {
      readingPositionAtSend?: ReturnType<typeof captureSendReadingPosition>;
      text: string;
      context?: ReturnType<typeof buildMessageContext>;
      interactionMode: "default" | "plan";
      selectedScientSkillNames: ReadonlyArray<string>;
      composerSnapshot?: string;
      sourceProposedPlan?: ScientThreadQueueItem["sourceProposedPlan"];
    }): Promise<string | null> => {
      if (
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return null;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return null;
      }

      const promptAtSend = promptRef.current;
      const pendingApprovalIdsAtSend = pendingApprovalsRef.current.map(
        (approval) => approval.requestId,
      );
      const sendCtx = composerRef.current?.getSendContext();
      if (!sendCtx?.providerAvailable || !sendCtx.interactionModeEnabled) {
        return null;
      }
      const {
        selectedProvider: ctxSelectedProvider,
        selectedModel: ctxSelectedModel,
        selectedProviderModels: ctxSelectedProviderModels,
        selectedPromptEffort: ctxSelectedPromptEffort,
        selectedModelSelection: ctxSelectedModelSelection,
      } = sendCtx;

      const followUpThread = activeThread;
      const threadIdForSend = followUpThread.id;
      const outgoingMessageText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: trimmed,
      });
      sendInFlightRef.current = true;
      let submittedMessageId: MessageId | null = null;
      // Anything thrown fails the follow-up; the release below still runs.
      const attempt = await settlePromise(async (): Promise<string | null> => {
        const messageCreatedAt = new Date().toISOString();
        const sourcePlan =
          sourceProposedPlan ??
          (nextInteractionMode === "default" && activeProposedPlan
            ? { threadId: followUpThread.id, planId: activeProposedPlan.id }
            : undefined);
        const identity = await settlePromise(() =>
          queueSubmissionId(composerTargetKey(scopeThreadRef(environmentId, threadIdForSend)), {
            threadId: threadIdForSend,
            text: outgoingMessageText,
            context,
            composerSnapshot,
            modelSelection: ctxSelectedModelSelection,
            runtimeMode,
            interactionMode: nextInteractionMode,
            selectedScientSkillNames,
            sourceProposedPlan: sourcePlan,
          }),
        );
        if (identity._tag === "Failure") {
          sendInFlightRef.current = false;
          setThreadError(
            threadIdForSend,
            chatActionErrorMessage(squashAtomCommandFailure(identity)),
          );
          return null;
        }
        const submissionId = identity.value;
        const messageIdForSend = MessageId.make(submissionId);
        submittedMessageId = messageIdForSend;
        if (
          !(await declineApprovalsForSend({
            sendCtx,
            pendingApprovalIdsAtSend,
            promptAtSend,
          }))
        )
          return null;
        beginLocalDispatch({ preparingWorktree: false });
        setThreadError(threadIdForSend, null);

        frameSubmittedMessage(
          messageIdForSend,
          readingPositionAtSend ?? captureSendReadingPosition(),
        );

        setOptimisticUserMessages((existing) => [
          ...existing,
          {
            id: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            ...(context ? { context } : {}),
            runId: null,
            createdAt: messageCreatedAt,
            updatedAt: messageCreatedAt,
            streaming: false,
          },
        ]);

        const settingsResult = await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          ...(localCheckoutBranchMismatch
            ? { branch: localCheckoutBranchMismatch.currentBranch }
            : {}),
          runtimeMode,
          interactionMode: nextInteractionMode,
        });
        let failure: AtomCommandResult<unknown, unknown> | null =
          settingsResult._tag === "Failure" ? settingsResult : null;
        let queued = false;
        if (failure === null && localCheckoutBranchMismatch) {
          const branchResult = await updateThreadMetadata({
            environmentId,
            input: { threadId: threadIdForSend, branch: localCheckoutBranchMismatch.currentBranch },
          });
          if (branchResult._tag === "Failure") failure = branchResult;
        }

        if (failure === null) {
          const startResult = await startThreadTurn({
            environmentId,
            input: {
              threadId: threadIdForSend,
              selectedScientSkillNames,
              message: {
                messageId: messageIdForSend,
                role: "user",
                text: outgoingMessageText,
                ...(context ? { context } : {}),
                attachments: [],
              },
              modelSelection: ctxSelectedModelSelection,
              titleSeed: followUpThread.title,
              runtimeMode,
              interactionMode: nextInteractionMode,
              ...(sendCtx.shownPendingApprovalIds.length > 0
                ? { dispatchMode: "steer" as const }
                : {}),
              ...(sourcePlan
                ? { sourceProposedPlan: { ...sourcePlan, planId: PlanId.make(sourcePlan.planId) } }
                : {}),
              createdAt: messageCreatedAt,
            },
          });
          failure = startResult._tag === "Failure" ? startResult : null;
          if (startResult._tag === "Success") {
            queued = "queued" in startResult.value && startResult.value.queued === true;
            setComposerDraftInteractionMode(
              scopeThreadRef(followUpThread.environmentId, threadIdForSend),
              nextInteractionMode,
            );
          }
        }

        if (failure === null) {
          if (queued) {
            setOptimisticUserMessages((existing) =>
              existing.filter((message) => message.id !== messageIdForSend),
            );
            resetLocalDispatch();
            void threadQueue.refresh();
          } else {
            clearUsageLimitsFor(routeThreadKey);
            acknowledgeActiveThreadWoke();
          }
          sendInFlightRef.current = false;
          resetLocalDispatch();
          return submissionId;
        }

        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        );
        if (!isAtomCommandInterrupted(failure)) {
          const error = squashAtomCommandFailure(failure);
          setThreadError(
            threadIdForSend,
            error instanceof Error ? error.message : "Failed to send plan follow-up.",
          );
        }
        sendInFlightRef.current = false;
        resetLocalDispatch();
        return null;
      });
      sendInFlightRef.current = false;
      if (attempt._tag === "Failure") {
        const failedMessageId = submittedMessageId;
        if (failedMessageId !== null) {
          setOptimisticUserMessages((existing) =>
            existing.filter((message) => message.id !== failedMessageId),
          );
        }
        setThreadError(threadIdForSend, chatActionErrorMessage(squashAtomCommandFailure(attempt)));
        resetLocalDispatch();
        return null;
      }
      return attempt.value;
    },
  );
  const onSend = useStableCallback(
    async (
      e?: { preventDefault: () => void },
      dispatchMode: ComposerDispatchMode = "auto",
      submissionIntent: ComposerSubmissionIntent = "foreground",
      directAnnotation?: {
        annotation: PreviewAnnotationPayload;
        image: ComposerImageAttachment | null;
      },
      // SCIENT-FORK:START — explicit steer bypasses normal server admission.
      options?: { steer?: boolean; directPrompt?: string },
      // SCIENT-FORK:END
    ) => {
      e?.preventDefault();
      const promptAtSend = promptRef.current;
      const pendingApprovalIdsAtSend = pendingApprovalsRef.current.map(
        (approval) => approval.requestId,
      );
      // SCIENT-FORK:START — the composer's queue edit, reading position and direct prompt are
      // captured before any await.
      let queueEdit =
        useQueueEditSessions.getState().sessions[composerTargetKey(composerDraftTarget)];
      const readingPositionAtSend = captureSendReadingPosition();
      const directPrompt = options?.directPrompt?.trim() || null;
      // SCIENT-FORK:END
      if (
        !useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.extractedIntent &&
        usageLimitsOffered &&
        usageLimitsKey !== null &&
        !directAnnotation &&
        directPrompt === null &&
        !composerHasNonPromptContent &&
        isUsageLimitsCommand(promptRef.current)
      ) {
        if (openUsageLimits()) {
          promptRef.current = "";
          setComposerDraftPrompt(composerDraftTarget, "");
          composerRef.current?.resetCursorState();
        }
        return;
      }

      const notifyDirectAnnotationAttached = () => {
        if (!directAnnotation) return;
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "Annotation attached to draft",
            description: "Sending is unavailable right now. Finish the current action, then send.",
          }),
        );
      };
      if (
        !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
        !activeThread ||
        !queueEditsReady ||
        (isSendBusy && !sendQueuesBehindSetup) ||
        isConnecting ||
        isRevertingCheckpoint ||
        !clientSettingsHydrated ||
        threadDetailLoading ||
        readPendingEnvironmentChange() !== null ||
        sendInFlightRef.current ||
        feedbackUploadsInFlightRef.current.has(routeThreadKey)
      ) {
        notifyDirectAnnotationAttached();
        return;
      }
      // Capture before queue recovery yields: submitting releases the typing hold,
      // but a revealed question must not replace this draft's attachment snapshot.
      const sendCtx = composerRef.current?.getSendContext();
      const steerRequested =
        options?.steer === true ||
        (dispatchMode === "steer" && (sendCtx?.shownPendingApprovalIds.length ?? 0) > 0);
      // SCIENT-FORK:START — an extracted queue intent is retried or bound before this send, and a
      // queue edit is flushed; both settle before the send continues.
      sendInFlightRef.current = true;
      const intakeResult = await settlePromise(() =>
        beginExtractedSubmission({
          target: composerDraftTarget,
          queueEdit,
          hasSeparateAction: () => Boolean(steerRequested || directAnnotation || directPrompt),
          dispatch: startThreadTurn,
          onDraftCleared: () => {
            promptRef.current = "";
            composerRef.current?.resetCursorState();
          },
        }),
      );
      sendInFlightRef.current = false;
      if (intakeResult._tag === "Failure") {
        setThreadError(
          activeThread.id,
          chatActionErrorMessage(squashAtomCommandFailure(intakeResult)),
        );
        return;
      }
      let extractedIntent: ExtractedIntentRecord | undefined = intakeResult.value.intent;
      const retryResult = intakeResult.value.retryResult;
      if (retryResult) {
        if (retryResult._tag === "Failure") {
          setThreadError(
            activeThread.id,
            chatActionErrorMessage(squashAtomCommandFailure(retryResult)),
          );
        }
        return;
      }
      if (queueEdit && !queueEdit.transferred) {
        const editToFlush = queueEdit;
        sendInFlightRef.current = true;
        const flushResult = await settlePromise(() => flushQueueEdit(editToFlush));
        sendInFlightRef.current = false;
        if (flushResult._tag === "Failure") {
          setThreadError(
            activeThread.id,
            chatActionErrorMessage(squashAtomCommandFailure(flushResult)),
          );
          return;
        }
        queueEdit = flushResult.value;
      }
      // SCIENT-FORK:END
      if (needsLoadBalancing) {
        toastManager.add({
          type: "warning",
          title: loadBalancing.pending
            ? "Checking machine resources"
            : "Choose a machine to continue",
          description: loadBalancing.pending
            ? "Resource checks are still running. You can choose a machine in the composer."
            : referencedThreadContexts.length > 0 &&
                !logicalProjectEnvironments.some((candidate) =>
                  referencedThreadContexts.every(
                    (record) => record.environmentId === candidate.environmentId,
                  ),
                )
              ? "No machine can read every attached thread. Choose a machine in the composer or remove the threads."
              : "No eligible machine has available resources. Choose a machine in the composer to override.",
        });
        return;
      }
      if (activeEnvironmentUnavailable) {
        const toastSlot = environmentUnavailableSendToastSlotRef.current;
        environmentUnavailableSendToastSlotRef.current =
          (toastSlot + 1) % ENVIRONMENT_UNAVAILABLE_SEND_TOAST_TRAIL_SIZE;
        toastManager.add({
          ...stackedThreadToast({
            type: "warning",
            title: "Not connected: message not sent",
            description: "Reconnecting to the environment. Try again once it is connected.",
          }),
          id: `chat-send-environment-unavailable:${toastSlot}`,
        });
        return;
      }
      if (activePendingProgress && sendCtx?.answeringPendingUserInput !== false) {
        if (directAnnotation) {
          notifyDirectAnnotationAttached();
          return;
        }
        onAdvanceActivePendingUserInput();
        return;
      }
      const runtimeMode =
        useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.runtimeMode ??
        activeThread.runtimeMode;
      if (!sendCtx?.providerAvailable || sendCtx.pendingAttachments) {
        notifyDirectAnnotationAttached();
        return;
      }
      const multipleModelSelections =
        directPrompt === null ? sendCtx.multipleModelSelections : null;
      if (extractedIntent && multipleModelSelections !== null) {
        setThreadError(activeThread.id, extractedIntentActionErrors.multipleModels);
        return;
      }
      if (
        multipleModelSelections !== null &&
        serverConfig?.environment.capabilities.requiredWorktreeBootstrap !== true
      ) {
        setThreadError(activeThread.id, "Update this server before starting multiple models.");
        return;
      }
      if (
        multipleModelSelections !== null &&
        (!isLocalDraftThread ||
          !activeProject ||
          !isGitRepo ||
          !activeThreadBranch ||
          multipleModelSelections.length === 0)
      ) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Choose models and a base branch",
            description:
              "Multiple models need a new thread in a Git project. Each gets its own worktree.",
          }),
        );
        return;
      }
      const {
        images: sendContextImages,
        files: composerFiles,
        terminalContexts: composerTerminalContexts,
        previewAnnotations: sendContextPreviewAnnotations,
        reviewComments: composerReviewComments,
        threadContexts: composerThreadContexts,
        selectedProvider: ctxSelectedProvider,
        selectedModel: ctxSelectedModel,
        selectedProviderModels: ctxSelectedProviderModels,
        selectedPromptEffort: ctxSelectedPromptEffort,
        selectedModelSelection: ctxSelectedModelSelection,
        interactionMode: sendInteractionMode,
        interactionModeEnabled: sendInteractionModeEnabled,
      } = sendCtx;
      // SCIENT-FORK:START — a direct prompt (e.g. a queue steer) sends only its own text.
      const effectiveSendContextImages = directPrompt === null ? sendContextImages : [];
      const effectiveComposerFiles = directPrompt === null ? composerFiles : [];
      const effectiveComposerTerminalContexts =
        directPrompt === null ? composerTerminalContexts : [];
      const effectivePreviewAnnotations =
        directPrompt === null ? sendContextPreviewAnnotations : [];
      const effectiveReviewComments = directPrompt === null ? composerReviewComments : [];
      // SCIENT-FORK:END
      const { images: composerImages, previewAnnotations: composerPreviewAnnotations } =
        mergeDirectPreviewAnnotation({
          images: effectiveSendContextImages,
          fileCount: effectiveComposerFiles.length,
          previewAnnotations: effectivePreviewAnnotations,
          direct: directAnnotation,
        });
      // A direct "send annotation" writes the draft and sends in the same tick; the reference
      // must be in the text now, not after the next render.
      const promptForSend =
        directPrompt ??
        (directAnnotation
          ? ensureInlineContextReferences(sendCtx.prompt, [
              previewAnnotationContextReference(directAnnotation.annotation),
            ])
          : sendCtx.prompt);
      const draftSnapshotForSend = useComposerDraftStore
        .getState()
        .getComposerDraft(composerDraftTarget);
      const strandedThread = threadContextsOutsideEnvironment({
        text: promptForSend,
        records: composerThreadContexts,
        environmentId,
      })[0];
      if (strandedThread) {
        const owner = environmentById.get(strandedThread.environmentId)?.label ?? "its machine";
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Attached thread is on another machine",
            description: `This machine's agent can't read "${strandedThread.title}". Remove it, or switch back to ${owner} to send.`,
          }),
        );
        return;
      }
      const {
        trimmedPrompt: trimmed,
        sendableTerminalContexts: sendableComposerTerminalContexts,
        expiredTerminalContextCount,
        hasSendableContent,
      } = deriveComposerSendState({
        prompt: promptForSend,
        imageCount: composerImages.length + effectiveComposerFiles.length,
        terminalContexts: effectiveComposerTerminalContexts,
        elementContextCount: composerPreviewAnnotations.length + effectiveReviewComments.length,
      });
      const standaloneForkCommand =
        !directAnnotation &&
        directPrompt === null &&
        composerImages.length === 0 &&
        sendableComposerTerminalContexts.length === 0 &&
        composerPreviewAnnotations.length === 0 &&
        effectiveReviewComments.length === 0 &&
        isStandaloneForkSlashCommand(trimmed);
      if (standaloneForkCommand && extractedIntent) {
        setThreadError(activeThread.id, extractedIntentActionErrors.fork);
        return;
      }
      if (standaloneForkCommand) {
        promptRef.current = "";
        clearComposerDraftContent(composerDraftTarget);
        composerRef.current?.resetCursorState();
        onForkConversation();
        return;
      }
      const feedbackCommand =
        directPrompt === null &&
        ctxSelectedProvider === "codex" &&
        composerImages.length === 0 &&
        effectiveComposerFiles.length === 0 &&
        sendableComposerTerminalContexts.length === 0 &&
        composerPreviewAnnotations.length === 0 &&
        effectiveReviewComments.length === 0
          ? parseCodexFeedbackCommand(trimmed)
          : null;
      if (feedbackCommand && extractedIntent) {
        setThreadError(activeThread.id, extractedIntentActionErrors.feedback);
        return;
      }
      if (feedbackCommand && multipleModelSelections === null) {
        if (!isServerThread || activeThread.activeProviderThreadId === null) {
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Start a Codex thread first",
              description: "Send a message before you submit feedback.",
            }),
          );
          return;
        }
        feedbackUploadsInFlightRef.current.add(routeThreadKey);
        const feedbackAttempt = await settlePromise(async () => {
          await submitCodexFeedback({
            submission: {
              id: newMessageId(),
              command: trimmed,
              createdAt: new Date().toISOString(),
            },
            clearDraft: () => {
              promptRef.current = "";
              clearComposerDraftContent(composerDraftTarget);
              composerRef.current?.resetCursorState();
            },
            onUpdate: (submission) => {
              setFeedbackSubmissionsByThreadKey((current) => {
                const existing = current[routeThreadKey] ?? [];
                const found = existing.some((entry) => entry.id === submission.id);
                return {
                  ...current,
                  [routeThreadKey]: found
                    ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                    : [...existing, submission],
                };
              });
            },
            upload: () =>
              uploadThreadFeedback({
                environmentId: activeThread.environmentId,
                input: { threadId: activeThread.id, ...feedbackCommand },
              }),
          });
        });
        feedbackUploadsInFlightRef.current.delete(routeThreadKey);
        if (feedbackAttempt._tag === "Failure") {
          setThreadError(
            activeThread.id,
            chatActionErrorMessage(squashAtomCommandFailure(feedbackAttempt)),
          );
        }

        return;
      }
      if (!sendCtx.providerAvailable) {
        notifyDirectAnnotationAttached();
        return;
      }
      if (
        !directAnnotation &&
        directPrompt === null &&
        !extractedIntent &&
        sendInteractionModeEnabled &&
        showPlanFollowUpPrompt &&
        activeProposedPlan &&
        composerImages.length === 0 &&
        effectiveComposerFiles.length === 0
      ) {
        const followUp = resolvePlanFollowUpSubmission({
          draftText: promptForSend,
          planMarkdown: activeProposedPlan.planMarkdown,
        });
        const outgoingFollowUpText = formatOutgoingPrompt({
          provider: ctxSelectedProvider,
          model: ctxSelectedModel,
          models: ctxSelectedProviderModels,
          effort: ctxSelectedPromptEffort,
          text: followUp.text.trim(),
        });
        if (composerRef.current?.validateProviderInput(outgoingFollowUpText) === false) {
          return;
        }
        const followUpSubmissionId = await onSubmitPlanFollowUp({
          text: followUp.text,
          readingPositionAtSend,
          context: buildMessageContext({
            terminalContexts: sendableComposerTerminalContexts,
            reviewComments: composerReviewComments,
            previewAnnotations: composerPreviewAnnotations,
            threadContexts: composerThreadContexts,
          }),
          interactionMode: followUp.interactionMode,
          selectedScientSkillNames: followUp.selectedScientSkillNames,
          sourceProposedPlan: queueEdit?.extractedItem?.sourceProposedPlan,
          composerSnapshot: encodeQueueComposerSnapshot({
            prompt: promptForSend,
            terminalContexts: sendableComposerTerminalContexts,
            reviewComments: composerReviewComments,
            previewAnnotations: [...composerPreviewAnnotations],
          }),
        });
        // SCIENT-FORK:START — an admitted follow-up retires its queue edit and clears its draft.
        if (followUpSubmissionId) {
          const editToFinish = queueEdit;
          const followUpThreadId = activeThread.id;
          const acknowledged = await settlePromise(async () => {
            if (editToFinish) await finishQueueEdit(editToFinish, draftSnapshotForSend);
            if (
              composerSubmissionMatchesDraft(
                draftSnapshotForSend,
                useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
              )
            ) {
              clearComposerDraftContent(composerDraftTarget);
              flushComposerDraftPersistence();
              if (queueContextKeyRef.current === activeThreadKey) {
                promptRef.current = "";
                composerRef.current?.resetCursorState();
              }
            }
            acknowledgeQueueSubmission(
              composerTargetKey(scopeThreadRef(environmentId, followUpThreadId)),
              followUpSubmissionId,
            );
          });
          if (acknowledged._tag === "Failure") {
            setThreadError(
              followUpThreadId,
              chatActionErrorMessage(squashAtomCommandFailure(acknowledged)),
            );
          } else if (
            submissionIntent === "background" &&
            currentRouteThreadKeyRef.current === routeThreadKey
          ) {
            handleNewThreadInActiveProject();
          }
        }
        // SCIENT-FORK:END
        return;
      }
      const standaloneSlashCommand =
        directPrompt === null &&
        sendInteractionModeEnabled &&
        composerImages.length === 0 &&
        effectiveComposerFiles.length === 0 &&
        sendableComposerTerminalContexts.length === 0 &&
        composerPreviewAnnotations.length === 0 &&
        effectiveReviewComments.length === 0
          ? parseStandaloneComposerSlashCommand(trimmed)
          : null;
      if (standaloneSlashCommand && !extractedIntent && multipleModelSelections === null) {
        handleInteractionModeChange(standaloneSlashCommand);
        promptRef.current = "";
        clearComposerDraftContent(composerDraftTarget);
        composerRef.current?.resetCursorState();
        return;
      }
      if (!hasSendableContent) {
        if (expiredTerminalContextCount > 0) {
          const toastCopy = buildExpiredTerminalContextToastCopy(
            expiredTerminalContextCount,
            "empty",
          );
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: toastCopy.title,
              description: toastCopy.description,
            }),
          );
        }
        return;
      }
      if (activeThread.projectId !== null && !activeProject) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Choose a project first",
            description: "This draft no longer points to an available project.",
          }),
        );
        return;
      }
      const threadIdForSend = activeThread.id;
      const sendSnapshot = snapshotComposerSend({
        prompt: promptForSend,
        images: composerImages,
        files: effectiveComposerFiles,
        terminalContexts: effectiveComposerTerminalContexts,
        sendableTerminalContexts: sendableComposerTerminalContexts,
        previewAnnotations: composerPreviewAnnotations,
        reviewComments: effectiveReviewComments,
        threadContexts: composerThreadContexts,
      });
      const {
        files: composerFilesSnapshot,
        attachments: composerAttachmentsSnapshot,
        terminalContexts: composerTerminalContextsSnapshot,
        previewAnnotations: composerPreviewAnnotationsSnapshot,
        reviewComments: composerReviewCommentsSnapshot,
        threadContexts: composerThreadContextsSnapshot,
        messageText: messageTextForSend,
      } = sendSnapshot;
      const submissionTargetKey = composerTargetKey(scopeThreadRef(environmentId, threadIdForSend));
      const selectedScientSkillNames = collectSelectedScientSkillNames(promptForSend);
      // Explicit actions and captured queue records retain their own admission and retry payload.
      const compactBeforeSend = shouldCompactBeforeSend({
        ordinaryServerSend:
          isServerThread && !steerRequested && !directAnnotation && directPrompt === null,
        hasCapturedQueueSubmission: Boolean(queueEdit || extractedIntent),
        multipleModels: multipleModelSelections !== null,
        resumeCompactionTokens,
        keepFullHistory,
        messageText: messageTextForSend,
      });
      const { missingWorktreeBaseBranch, baseBranchForWorktree, turnDispatchMode } =
        planComposerTurn({
          messageText: messageTextForSend,
          sendQueuesBehindSetup,
          isServerThread,
          activeMessageCount,
          sendEnvMode,
          worktreePath: activeThread.worktreePath,
          activeThreadBranch,
          // Scient owns eligibility; the shared planner owns worktree and dispatch mechanics.
          resumeCompactionTokens: compactBeforeSend ? resumeCompactionTokens : null,
          keepFullHistory,
          phase,
          dispatchMode,
        });
      if (missingWorktreeBaseBranch) {
        setThreadError(
          threadIdForSend,
          "Select a base branch before sending in New worktree mode.",
        );
        return;
      }

      if (queueEdit) {
        try {
          assertQueueEditSelectionProvenance(queueEdit.composerSeparated, promptForSend);
        } catch (cause) {
          setThreadError(threadIdForSend, cause instanceof Error ? cause.message : String(cause));
          return;
        }
      }
      // Records bind attachments by the id each side knows: the local id for the optimistic
      // row, the upload id (or local id on the data-URL path) on the wire; the server
      // rebinds them to the persisted id.
      const buildOutgoingMessageContext = (attachmentIds: ReadonlyArray<string>) =>
        buildMessageContext({
          terminalContexts: composerTerminalContextsSnapshot,
          reviewComments: composerReviewCommentsSnapshot,
          previewAnnotations: composerPreviewAnnotationsSnapshot,
          threadContexts: composerThreadContextsSnapshot,
          attachments: composerAttachmentsSnapshot.map((attachment, index) => ({
            attachment,
            attachmentId: attachmentIds[index] ?? attachment.id,
          })),
        });
      const outgoingMessageContext = buildOutgoingMessageContext(
        composerAttachmentsSnapshot.map((attachment) => attachment.id),
      );
      const outgoingMessageText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: messageTextForSend || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      });
      if (composerRef.current?.validateProviderInput(outgoingMessageText) === false) {
        return;
      }

      const readLiveAttachmentCapabilities = () => {
        const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
        const liveSupportsAttachmentUploads =
          config?.environment.capabilities.attachmentUploads === true;
        return {
          supportsAttachmentUploads: liveSupportsAttachmentUploads,
          fileBlockReason: fileAttachmentCapabilityBlockReason({
            files: composerFilesSnapshot,
            attachmentUploadsCapabilityKnown: config !== null,
            supportsAttachmentUploads: liveSupportsAttachmentUploads,
            maxFileAttachmentBytes:
              config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
          }),
        };
      };

      const multipleTargets: Array<{
        readonly selection: ModelSelection;
        readonly text: string;
        readonly interactionMode: ProviderInteractionMode;
      }> = [];
      for (const selection of multipleModelSelections ?? []) {
        const provider = providerInstanceEntries.find(
          (entry) => entry.instanceId === selection.instanceId,
        );
        if (!provider?.enabled || !provider.isAvailable || provider.status !== "ready") {
          setThreadError(threadIdForSend, `Provider for ${selection.model} is unavailable.`);
          return;
        }
        const providerBlockReason = getAntigravitySendBlockReason(
          provider.snapshot,
          selection.model,
        );
        if (providerBlockReason) {
          setThreadError(threadIdForSend, providerBlockReason);
          return;
        }
        const providerState = getComposerProviderState({
          provider: provider.driverKind,
          model: selection.model,
          models: provider.models,
          modelOptions: selection.options,
          promptInjectionState: getComposerPromptInjectionState(messageTextForSend),
          planModeEnabled: settings.planModeEnabled,
        });
        const text = formatOutgoingPrompt({
          provider: provider.driverKind,
          model: selection.model,
          models: provider.models,
          effort: providerState.promptEffort,
          text: messageTextForSend || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
        });
        if (composerRef.current?.validateProviderInput(text) === false) return;
        multipleTargets.push({
          selection: createModelSelection(
            selection.instanceId,
            selection.model,
            providerState.modelOptionsForDispatch,
          ),
          text,
          interactionMode: resolveComposerInteractionMode({
            planModeEnabled: settings.planModeEnabled,
            provider: provider.snapshot,
            interactionMode: sendInteractionMode,
          }).interactionMode,
        });
      }

      sendInFlightRef.current = true;
      const sendGeneration = ++composerSendGenerationRef.current;
      let submittedMessageId: MessageId | null = null;
      let requestAccepted = false;
      // SCIENT-FORK:START — the attempt runs as one settled unit: anything thrown fails it, and the
      // release below still runs, like the finally it replaces.
      const sendAttempt = await settlePromise(async () => {
        if (extractedIntent)
          extractedIntent = await prepareExtractedDraftIntent(extractedIntent.intentId);
        if (queueEdit) await flushQueueEdit(queueEdit);
        // SCIENT-FORK:END
        const attachmentCapabilitiesBeforeUpload = readLiveAttachmentCapabilities();
        if (attachmentCapabilitiesBeforeUpload.fileBlockReason !== null) {
          sendInFlightRef.current = false;
          setThreadError(threadIdForSend, attachmentCapabilitiesBeforeUpload.fileBlockReason);
          return;
        }
        const turnUsesAttachmentUploads =
          composerFilesSnapshot.length > 0
            ? attachmentCapabilitiesBeforeUpload.supportsAttachmentUploads
            : supportsAttachmentUploads;
        if (turnUsesAttachmentUploads && composerAttachmentsSnapshot.length > 0) {
          for (const attachment of composerAttachmentsSnapshot) {
            const upload =
              readAttachmentUpload(attachment.id)?.status === "failed"
                ? retryAttachmentUpload
                : startAttachmentUpload;
            upload({
              environmentId,
              image: attachment,
              draftTarget: composerDraftTarget,
            });
          }
          await awaitAttachmentUploads(
            composerAttachmentsSnapshot.map((attachment) => attachment.id),
          );
          const attachmentCapabilitiesAfterUpload = readLiveAttachmentCapabilities();
          if (attachmentCapabilitiesAfterUpload.fileBlockReason !== null) {
            sendInFlightRef.current = false;
            setThreadError(threadIdForSend, attachmentCapabilitiesAfterUpload.fileBlockReason);
            return;
          }
          if (
            getUploadedAttachments({ environmentId, images: composerAttachmentsSnapshot }) === null
          ) {
            sendInFlightRef.current = false;
            setThreadError(threadIdForSend, "Retry or remove failed uploads before sending.");
            return;
          }
        }

        // SCIENT-FORK:START — a multiple-model send from a draft is a background submission.
        const resolvedSubmissionIntent =
          (multipleModelSelections !== null || submissionIntent === "background") &&
          isLocalDraftThread
            ? "background"
            : "foreground";
        // SCIENT-FORK:END
        if (
          shouldDockDraftHeroForSubmission({
            isDraftHeroState,
            activeThreadKey,
            submissionIntent: resolvedSubmissionIntent,
          }) &&
          activeThreadKey
        ) {
          let resolveDockStarted: (() => void) | undefined;
          const dockStarted = new Promise<void>((resolve) => {
            resolveDockStarted = resolve;
          });
          const dockTransition = runMobileComposerTransition(
            () => {
              flushSync(() => {
                captureDraftHeroComposerRect();
                setDockedDraftHeroThreadKey(activeThreadKey);
              });
              resolveDockStarted?.();
            },
            {
              active: panelAnimationsActive,
              durationMs: panelAnimationDurationMs,
            },
          );
          void dockTransition.catch(() => resolveDockStarted?.());
          await dockStarted;
        }

        const attachmentCapabilitiesBeforeDispatch = readLiveAttachmentCapabilities();
        if (
          !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
          attachmentCapabilitiesBeforeDispatch.fileBlockReason !== null
        ) {
          sendInFlightRef.current = false;
          setThreadError(
            threadIdForSend,
            attachmentCapabilitiesBeforeDispatch.fileBlockReason ??
              "This connection cannot change threads.",
          );
          setDockedDraftHeroThreadKey((currentThreadKey) =>
            currentThreadKey === activeThreadKey ? null : currentThreadKey,
          );
          return;
        }
        if (
          !(await declineApprovalsForSend({
            sendCtx,
            pendingApprovalIdsAtSend,
            promptAtSend,
            promptForSend,
            annotationImageId: directAnnotation?.image?.id,
          }))
        )
          return;

        if (sendQueuesBehindSetup) {
          setSetupQueueSendThreadKey(activeThreadKey);
        } else {
          beginLocalDispatch({
            preparingWorktree: multipleModelSelections !== null || Boolean(baseBranchForWorktree),
            submissionIntent: resolvedSubmissionIntent,
          });
          beginWorktreeSetup(
            multipleModelSelections === null && baseBranchForWorktree
              ? { environmentId: activeThread.environmentId, threadId: threadIdForSend }
              : null,
          );
        }

        // SCIENT-FORK:START — an ordinary send has a durable queue submission identity, so an
        // ambiguous response cannot submit twice.
        const submissionIdentityResult = await settlePromise(async () => {
          if (steerRequested || directAnnotation) return undefined;
          return queueSubmissionId(submissionTargetKey, {
            threadId: threadIdForSend,
            sourceProposedPlan:
              extractedIntent?.sourceProposedPlan ?? queueEdit?.extractedItem?.sourceProposedPlan,
            text: outgoingMessageText,
            context: outgoingMessageContext,
            modelSelection: ctxSelectedModelSelection,
            runtimeMode,
            interactionMode: sendInteractionMode,
            selectedScientSkillNames,
            ...(multipleModelSelections !== null ? { multipleModels: true } : {}),
            attachments: await Promise.all(
              composerAttachmentsSnapshot.map(async (attachment) => ({
                type: attachment.type,
                id: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                data: attachment.file ? await readFileAsDataUrl(attachment.file) : attachment,
                source: attachment.source,
              })),
            ),
          });
        });
        if (submissionIdentityResult._tag === "Failure") {
          sendInFlightRef.current = false;
          if (!sendQueuesBehindSetup) resetLocalDispatch();
          setThreadError(
            threadIdForSend,
            chatActionErrorMessage(squashAtomCommandFailure(submissionIdentityResult)),
          );
          return;
        }
        const submissionId = submissionIdentityResult.value;
        const messageIdForSend = submissionId ? MessageId.make(submissionId) : newMessageId();
        submittedMessageId = messageIdForSend;
        // SCIENT-FORK:END
        const messageCreatedAt = new Date().toISOString();
        const turnAttachmentsPromise = Promise.all(
          composerAttachmentsSnapshot.map(async (attachment) => {
            if (turnUsesAttachmentUploads) {
              const uploaded = getUploadedAttachments({ environmentId, images: [attachment] })?.[0];
              if (!uploaded) {
                throw new Error(`Attachment '${attachment.name}' did not finish uploading.`);
              }
              return uploaded;
            }
            if (attachment.type !== "image") {
              throw new Error("This server does not support file attachments.");
            }
            return {
              type: "image" as const,
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              dataUrl: await readFileAsDataUrl(attachment.file),
              ...(attachment.source ? { source: attachment.source } : {}),
            };
          }),
        );
        if (multipleModelSelections !== null) {
          const projectForMultipleModels = activeProject;
          if (!projectForMultipleModels) return;
          const failedSelections: ModelSelection[] = [];
          let clearedDraft = false;
          let releasedComposer = false;
          let canRestoreDraft = () => false;
          let startedCount = 0;
          // Anything thrown here (an attachment the server can no longer take)
          // fails every selection; the draft restore below still runs.
          const sendResult = await settlePromise(async () => {
            const attachments = await turnAttachmentsPromise;
            const fileBlockReason = readLiveAttachmentCapabilities().fileBlockReason;
            if (fileBlockReason !== null) throw new Error(fileBlockReason);
            const context = buildOutgoingMessageContext(
              boundAttachmentIds(attachments, composerAttachmentsSnapshot),
            );
            const title = deriveThreadTitleSeed({
              text: composerCitationsToPlainText(stripInlineContextReferences(trimmed)),
              attachments: composerAttachmentsSnapshot,
            });
            promptRef.current = "";
            clearComposerDraftContent(composerDraftTarget);
            composerRef.current?.resetCursorState();
            clearedDraft = true;
            const clearedDraftSnapshot = useComposerDraftStore
              .getState()
              .getComposerDraft(composerDraftTarget);
            const submittedSelections = readMultipleModelSelections();
            canRestoreDraft = () =>
              currentRouteThreadKeyRef.current === routeThreadKey &&
              composerSendGenerationRef.current === sendGeneration &&
              useComposerDraftStore.getState().getComposerDraft(composerDraftTarget) ===
                clearedDraftSnapshot &&
              readMultipleModelSelections() === submittedSelections;
            setThreadError(threadIdForSend, null);
            const starts = Promise.all(
              multipleTargets.map(async (target) => {
                const started = await startFanoutThread({
                  retryKey: JSON.stringify([
                    routeThreadKey,
                    target.selection.instanceId,
                    target.selection.model,
                  ]),
                  model: target.selection.model,
                  uncertainSubmissions: uncertainMultipleSubmissionsRef.current,
                  start: (targetThreadId) => {
                    return startThreadTurn({
                      environmentId,
                      input: {
                        threadId: targetThreadId,
                        // SCIENT-FORK:START — selected Scient skills and a named temporary branch.
                        selectedScientSkillNames,
                        // SCIENT-FORK:END
                        message: {
                          messageId: newMessageId(),
                          role: "user",
                          ...prepareComposerContextMessage({
                            environmentId,
                            text: target.text,
                            context,
                          }),
                          attachments,
                        },
                        modelSelection: target.selection,
                        titleSeed: title,
                        runtimeMode,
                        interactionMode: target.interactionMode,
                        bootstrap: {
                          createThread: {
                            projectId: projectForMultipleModels.id,
                            title,
                            modelSelection: target.selection,
                            runtimeMode,
                            interactionMode: target.interactionMode,
                            branch: activeThreadBranch,
                            worktreePath: null,
                            createdAt: messageCreatedAt,
                          },
                          prepareWorktree: {
                            projectCwd: projectForMultipleModels.workspaceRoot,
                            baseBranch: activeThreadBranch!,
                            requireWorktree: true,
                            // SCIENT-FORK:START
                            branch: buildTemporaryWorktreeBranchName(randomHex),
                            // SCIENT-FORK:END
                            ...(startFromOrigin ? { startFromOrigin: true } : {}),
                          },
                          runSetupScript: true,
                        },
                        createdAt: messageCreatedAt,
                      },
                    });
                  },
                  openThread: (threadId) =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
                    }),
                });
                if (started) startedCount += 1;
                else failedSelections.push(target.selection);
              }),
            );
            sendInFlightRef.current = false;
            if (!sendQueuesBehindSetup) resetLocalDispatch();
            releasedComposer = true;
            await starts;
            if (startedCount > 0) {
              toastManager.add(
                stackedThreadToast({
                  type: "success",
                  title: `Started ${startedCount} ${startedCount === 1 ? "thread" : "threads"} in background`,
                }),
              );
            }
            if (failedSelections.length === 0 && turnUsesAttachmentUploads) {
              releaseDraftAttachments(composerAttachmentsSnapshot);
            }
          });
          if (sendResult._tag === "Failure") {
            const error = squashAtomCommandFailure(sendResult);
            failedSelections.push(...multipleModelSelections);
            setThreadError(
              threadIdForSend,
              error instanceof Error ? error.message : "Failed to send messages.",
            );
          }
          const restoreFailedDraft = () => {
            setMultipleModelSelections(failedSelections);
            if (clearedDraft) {
              restoreComposerDraft(composerDraftTarget, sendSnapshot);
              if (composerRef.current && currentRouteThreadKeyRef.current === routeThreadKey) {
                promptRef.current = messageTextForSend;
                composerRef.current.resetCursorState({
                  cursor: collapseExpandedComposerCursor(
                    messageTextForSend,
                    messageTextForSend.length,
                  ),
                  prompt: messageTextForSend,
                  detectTrigger: true,
                });
              }
            }
          };
          if (failedSelections.length > 0) {
            if (canRestoreDraft() && composerRef.current) {
              restoreFailedDraft();
            } else if (clearedDraft) {
              const recoveryToastId = toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "A background prompt could not be sent",
                  description:
                    "Your newer draft is unchanged. Restore the failed prompt when this composer is empty.",
                  timeout: 0,
                  actionProps: {
                    children: "Restore prompt",
                    onClick: () => {
                      if (
                        !draftId ||
                        !useComposerDraftStore.getState().getDraftSession(draftId) ||
                        sendInFlightRef.current ||
                        composerDraftHasUserContent(
                          useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
                        )
                      ) {
                        toastManager.update(recoveryToastId, {
                          description:
                            "Return to the original draft and send or clear its current prompt before restoring.",
                        });
                        return;
                      }
                      restoreFailedDraft();
                      void navigate({ to: "/draft/$draftId", params: { draftId } });
                      toastManager.close(recoveryToastId);
                    },
                  },
                }),
              );
            }
          }
          if (!releasedComposer) {
            sendInFlightRef.current = false;
            if (!sendQueuesBehindSetup) resetLocalDispatch();
          }
          return;
        }
        const optimisticAttachments = optimisticMessageAttachments(composerAttachmentsSnapshot);
        // SCIENT-FORK:START — a send the server will queue previews in the queue strip and is
        // framed only once it starts; a send that starts now is framed immediately.
        const previewQueueAdmission =
          compactBeforeSend ||
          sendQueuesBehindSetup ||
          shouldPreviewQueueAdmission({
            ordinaryServerSend: isServerThread && !steerRequested && !directAnnotation,
            phase,
            hasWaitingItems: isServerThread
              ? serverProjection?.runs.some((run) => run.status === "queued") === true
              : threadQueue.items.length > 0,
            awaitingCompletion: isServerThread ? hasHeldQueuedRuns : threadQueue.awaitingCompletion,
          });
        if (!previewQueueAdmission) frameSubmittedMessage(messageIdForSend, readingPositionAtSend);
        // SCIENT-FORK:END
        setOptimisticUserMessages((existing) => [
          ...existing,
          {
            id: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
            ...(outgoingMessageContext !== undefined ? { context: outgoingMessageContext } : {}),
            runId: null,
            createdAt: messageCreatedAt,
            updatedAt: messageCreatedAt,
            streaming: false,
            ...(previewQueueAdmission
              ? { queueAdmission: { threadKey: routeThreadKey, accepted: false } }
              : {}),
          },
        ]);
        setThreadError(threadIdForSend, null);
        if (expiredTerminalContextCount > 0) {
          const toastCopy = buildExpiredTerminalContextToastCopy(
            expiredTerminalContextCount,
            "omitted",
          );
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: toastCopy.title,
              description: toastCopy.description,
            }),
          );
        }

        const title = deriveThreadTitleSeed({
          text: composerCitationsToPlainText(stripInlineContextReferences(trimmed)),
          attachments: composerAttachmentsSnapshot,
          fallbackLabels: sendTitleFallbackLabels(sendSnapshot),
        });
        const threadCreateModelSelection = createModelSelection(
          ctxSelectedModelSelection.instanceId,
          ctxSelectedModel || activeProjectDefaultModelSelection?.model || DEFAULT_MODEL,
          ctxSelectedModelSelection.options,
        );

        let failure: AtomCommandResult<unknown, unknown> | null = null;
        // SCIENT-FORK:START — steer retains its explicit settings path. Ordinary settings are
        // committed by the server only when the submitted payload is admitted to start.
        if (
          (steerRequested || directAnnotation) &&
          !sendQueuesBehindSetup &&
          activeMessageCount === 0 &&
          isServerThread
        ) {
          const titleResult = await updateThreadMetadata({
            environmentId,
            input: {
              threadId: threadIdForSend,
              title,
            },
          });
          if (titleResult._tag === "Failure") {
            failure = titleResult;
          }
        }

        if (failure === null && isServerThread && (steerRequested || directAnnotation)) {
          const settingsResult = await persistThreadSettingsForNextTurn({
            threadId: threadIdForSend,
            createdAt: messageCreatedAt,
            ...(ctxSelectedModel ? { modelSelection: ctxSelectedModelSelection } : {}),
            ...(localCheckoutBranchMismatch
              ? { branch: localCheckoutBranchMismatch.currentBranch }
              : {}),
            runtimeMode,
            interactionMode: sendInteractionMode,
          });
          if (settingsResult._tag === "Failure") {
            failure = settingsResult;
          }
        }
        if (
          failure === null &&
          isServerThread &&
          !steerRequested &&
          !directAnnotation &&
          localCheckoutBranchMismatch
        ) {
          const branchResult = await updateThreadMetadata({
            environmentId,
            input: { threadId: threadIdForSend, branch: localCheckoutBranchMismatch.currentBranch },
          });
          if (branchResult._tag === "Failure") failure = branchResult;
        }
        // SCIENT-FORK:END

        const turnAttachmentsResult = await settlePromise(async () => {
          const turnAttachments = await turnAttachmentsPromise;
          const liveFileBlockReason = readLiveAttachmentCapabilities().fileBlockReason;
          if (liveFileBlockReason !== null) {
            throw new Error(liveFileBlockReason);
          }
          return turnAttachments;
        });
        if (failure === null && turnAttachmentsResult._tag === "Failure") {
          failure = turnAttachmentsResult;
        }

        if (failure === null && compactBeforeSend) {
          const compactResult = await startThreadTurn({
            environmentId,
            input: {
              commandId: CommandId.make(randomUUID()),
              threadId: threadIdForSend,
              message: {
                messageId: newMessageId(),
                role: "user",
                text: "/compact",
                attachments: [],
              },
              modelSelection: ctxSelectedModelSelection,
              runtimeMode,
              interactionMode: sendInteractionMode,
            },
          });
          if (compactResult._tag === "Failure") failure = compactResult;
        }

        let turnStartSucceeded = false;
        let backgroundDraftOpened = false;
        if (failure === null && turnAttachmentsResult._tag === "Success") {
          // SCIENT-FORK:START — a draft without a project starts no project thread.
          const shouldCreateThread = isLocalDraftThread && activeThread.projectId !== null;
          // SCIENT-FORK:END
          const bootstrap =
            shouldCreateThread || baseBranchForWorktree
              ? {
                  ...(shouldCreateThread
                    ? {
                        createThread: {
                          projectId: activeThread.projectId,
                          title,
                          modelSelection: threadCreateModelSelection,
                          runtimeMode,
                          interactionMode: sendInteractionMode,
                          branch: activeThreadBranch,
                          worktreePath: activeThread.worktreePath,
                          createdAt: activeThread.createdAt,
                        },
                      }
                    : {}),
                  ...(baseBranchForWorktree && activeProject
                    ? {
                        prepareWorktree: {
                          projectCwd: activeProject.workspaceRoot,
                          baseBranch: baseBranchForWorktree,
                          // SCIENT-FORK:START
                          branch: buildTemporaryWorktreeBranchName(randomHex),
                          // SCIENT-FORK:END
                          ...(startFromOrigin ? { startFromOrigin: true } : {}),
                        },
                        runSetupScript: true,
                      }
                    : {}),
                }
              : undefined;
          const backgroundThreadRef =
            resolvedSubmissionIntent === "background"
              ? scopeThreadRef(activeThread.environmentId, threadIdForSend)
              : null;
          if (backgroundThreadRef) {
            beginBackgroundDraftSubmissionByRef(backgroundThreadRef);
          }
          // SCIENT-FORK:START — the turn packet carries the extracted intent's durable command id,
          // its source plan and the selected Scient skills.
          const extractedSourcePlan =
            extractedIntent?.sourceProposedPlan ?? queueEdit?.extractedItem?.sourceProposedPlan;
          const preparedPacket: ExtractedSubmissionPacket = {
            environmentId,
            input: {
              commandId: CommandId.make(
                extractedIntent ? `extracted-intent:${extractedIntent.intentId}` : randomUUID(),
              ),
              threadId: threadIdForSend,
              ...(extractedSourcePlan
                ? {
                    sourceProposedPlan: {
                      ...extractedSourcePlan,
                      planId: PlanId.make(extractedSourcePlan.planId),
                    },
                  }
                : {}),
              selectedScientSkillNames,
              message: {
                messageId: messageIdForSend,
                role: "user",
                attachments: turnAttachmentsResult.value,
                ...prepareComposerContextMessage({
                  environmentId,
                  text: outgoingMessageText,
                  context: buildOutgoingMessageContext(
                    boundAttachmentIds(turnAttachmentsResult.value, composerAttachmentsSnapshot),
                  ),
                }),
              },
              modelSelection: ctxSelectedModelSelection,
              titleSeed: title,
              runtimeMode,
              interactionMode: sendInteractionMode,
              dispatchMode: steerRequested || directAnnotation ? "steer" : turnDispatchMode,
              ...(bootstrap ? { bootstrap } : {}),
              createdAt: messageCreatedAt,
            },
          };
          if (extractedIntent) {
            extractedIntent = await prepareAndBindExtractedSubmission(
              extractedIntent,
              preparedPacket,
              draftSnapshotForSend,
            );
          }
          const startPromise = startThreadTurn(preparedPacket);
          // SCIENT-FORK:END
          if (backgroundThreadRef) {
            markPromotedDraftThreadByRef(backgroundThreadRef);
            const backgroundProjectRef = activeProjectRef;
            if (backgroundProjectRef) {
              const backgroundWorkspaceOptions = resolveBackgroundDraftWorkspaceOptions({
                envMode: sendEnvMode,
                branch: activeThreadBranch,
                startFromOrigin,
              });
              try {
                backgroundDraftOpened = Boolean(
                  await handleNewThread(backgroundProjectRef, backgroundWorkspaceOptions),
                );
              } catch (error) {
                clearBackgroundDraftSubmissionByRef(backgroundThreadRef);
                toastManager.add(
                  stackedThreadToast({
                    type: "warning",
                    title: "Could not open a fresh composer",
                    description: error instanceof Error ? error.message : undefined,
                  }),
                );
              }
            }
          }
          const startResult = await startPromise;
          if (startResult._tag === "Failure") {
            failure = startResult;
          } else {
            turnStartSucceeded = true;
            setKeepFullHistory(routeThreadKey, false);
            // SCIENT-FORK:START — an admitted send retires its extracted intent and queue edit, then
            // clears the draft it was sent from (only if the draft is unchanged since).
            requestAccepted = true;
            if (extractedIntent) await consumeExtractedSubmission(extractedIntent);
            const queued = "queued" in startResult.value && startResult.value.queued === true;
            let canAcknowledge = true;
            const editToFinish = queueEdit;
            if (editToFinish) {
              const finishedQueueEdit = await settlePromise(() =>
                finishQueueEdit(editToFinish, draftSnapshotForSend),
              );
              if (finishedQueueEdit._tag === "Failure") {
                canAcknowledge = false;
                setThreadError(
                  threadIdForSend,
                  chatActionErrorMessage(squashAtomCommandFailure(finishedQueueEdit)),
                );
              }
            }
            if (
              canAcknowledge &&
              directPrompt === null &&
              composerSubmissionMatchesDraft(
                draftSnapshotForSend,
                useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
              )
            ) {
              clearComposerDraftContent(composerDraftTarget);
              flushComposerDraftPersistence();
              if (queueContextKeyRef.current === activeThreadKey) {
                promptRef.current = "";
                composerRef.current?.resetCursorState();
              }
            }
            if (extractedIntent) {
              await retireAcknowledgedExtractedDraft(
                composerDraftTarget,
                extractedIntent,
                draftSnapshotForSend,
              );
            }
            if (submissionId && canAcknowledge) {
              try {
                acknowledgeQueueSubmission(submissionTargetKey, submissionId);
              } catch (cause) {
                setThreadError(threadIdForSend, chatActionErrorMessage(cause));
              }
            }
            setOptimisticUserMessages((existing) =>
              settleQueueAdmissionPreview(existing, messageIdForSend, queued),
            );
            if (queued) {
              if (!sendQueuesBehindSetup) resetLocalDispatch();
              void threadQueue.refresh();
            } else {
              if (previewQueueAdmission)
                frameSubmittedMessage(messageIdForSend, readingPositionAtSend);
              clearUsageLimitsFor(routeThreadKey);
              acknowledgeActiveThreadWoke();
            }
            if (turnUsesAttachmentUploads && canAcknowledge) {
              releaseDraftAttachments(composerAttachmentsSnapshot);
            }
            // SCIENT-FORK:END
            if (backgroundThreadRef) {
              if (backgroundDraftOpened || currentRouteThreadKeyRef.current !== routeThreadKey) {
                finalizePromotedDraftThreadByRef(backgroundThreadRef);
              } else {
                clearBackgroundDraftSubmissionByRef(backgroundThreadRef);
              }
              if (backgroundDraftOpened) {
                toastManager.add(
                  stackedThreadToast({
                    type: "success",
                    title: "Started in background",
                    timeout: 5_000,
                    actionProps: {
                      children: "Open",
                      onClick: () => {
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: buildThreadRouteParams(backgroundThreadRef),
                        });
                      },
                    },
                  }),
                );
              }
            } else if (
              submissionIntent === "background" &&
              currentRouteThreadKeyRef.current === routeThreadKey
            ) {
              handleNewThreadInActiveProject();
            }
          }
        }

        if (failure !== null) {
          if (resolvedSubmissionIntent === "background" && draftId && draftThread) {
            restoreFailedDraftThread(
              draftId,
              draftThread,
              wasBootstrapThreadDeleted(squashAtomCommandFailure(failure))
                ? newThreadId()
                : threadIdForSend,
            );
            clearBackgroundDraftSubmissionByRef(scopeThreadRef(environmentId, threadIdForSend));
          }
          // SCIENT-FORK:START — nothing has been cleared before admission, including attachment
          // bytes. Remove the optimistic row without overwriting any typing during flight.
          setOptimisticUserMessages((existing) =>
            existing.filter((message) => message.id !== messageIdForSend),
          );
          // SCIENT-FORK:END
          if (!isAtomCommandInterrupted(failure)) {
            const error = squashAtomCommandFailure(failure);
            if (
              resolvedSubmissionIntent !== "background" &&
              isLocalDraftThread &&
              draftId &&
              wasBootstrapThreadDeleted(error)
            ) {
              const failedDraftSession = getDraftSession(draftId);
              if (failedDraftSession?.threadId === threadIdForSend) {
                setLogicalProjectDraftThreadId(
                  failedDraftSession.logicalProjectKey,
                  {
                    environmentId: failedDraftSession.environmentId,
                    projectId: failedDraftSession.projectId,
                  },
                  draftId,
                  {
                    threadId: newThreadId(),
                    createdAt: new Date().toISOString(),
                  },
                );
              }
            }
            setThreadError(
              threadIdForSend,
              error instanceof Error ? error.message : "Failed to send message.",
            );
            if (backgroundDraftOpened && draftId) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Background task failed",
                  description: error instanceof Error ? error.message : "Failed to send message.",
                  actionProps: {
                    children: "Open draft",
                    onClick: () => {
                      void navigate({ to: "/draft/$draftId", params: { draftId } });
                    },
                  },
                }),
              );
            }
          }
        }
        if (!turnStartSucceeded) {
          setDockedDraftHeroThreadKey((currentThreadKey) =>
            currentThreadKey === activeThreadKey ? null : currentThreadKey,
          );
          if (!sendQueuesBehindSetup) resetLocalDispatch();
        }
        if (turnStartSucceeded && submissionId && !sendQueuesBehindSetup) resetLocalDispatch();
      });
      // SCIENT-FORK:START — a thrown attempt removes its unadmitted row and reports the cause.
      if (sendAttempt._tag === "Failure") {
        const failedMessageId = submittedMessageId;
        if (!requestAccepted && failedMessageId !== null) {
          setOptimisticUserMessages((existing) =>
            existing.filter((message) => message.id !== failedMessageId),
          );
        }
        setThreadError(
          threadIdForSend,
          chatActionErrorMessage(squashAtomCommandFailure(sendAttempt)),
        );
        if (!sendQueuesBehindSetup) resetLocalDispatch();
      }
      // Release only this settled attempt. Its durable identity handles an
      // ambiguous response; navigation does not manufacture another send.
      if (composerSendGenerationRef.current === sendGeneration) {
        sendInFlightRef.current = false;
        setSetupQueueSendThreadKey((current) => (current === activeThreadKey ? null : current));
      }
      // SCIENT-FORK:END
    },
  );

  const editQueuedItem = (item: ScientThreadQueueItem) => {
    if (!isServerThread || !activeThreadId) return;
    if (activePendingProgress || pendingApprovals.length > 0 || isConnecting || isSendBusy) {
      setThreadError(
        activeThreadId,
        "Finish the current approval or question before editing a queued message.",
      );
      return;
    }
    void beginQueueEdit(routeThreadRef, item)
      .then(() => threadQueue.refresh())
      .catch((cause) => {
        setThreadError(activeThreadId, chatActionErrorMessage(cause));
      });
  };

  const deleteQueuedItem = (item: ScientThreadQueueItem) => {
    if (!isServerThread || !activeThreadId) return;
    void threadQueue.remove(item.queueItemId).catch((cause) => {
      setThreadError(activeThreadId, chatActionErrorMessage(cause));
    });
  };
  // SCIENT-FORK:END

  const onImplementPlanInNewThread = useStableCallback(async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable || !sendCtx.interactionModeEnabled) {
      return;
    }
    const {
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = ctxSelectedModelSelection;

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    const createResult = await createThread({
      environmentId,
      input: {
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode: defaultRuntimeMode,
        interactionMode: "default",
        branch: activeThreadBranch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      },
    });
    let failure: AtomCommandResult<unknown, unknown> | null =
      createResult._tag === "Failure" ? createResult : null;

    if (failure === null) {
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode: defaultRuntimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        },
      });
      failure = startResult._tag === "Failure" ? startResult : null;
    }

    if (failure === null) {
      const startedResult = await settlePromise(() =>
        waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId)),
      );
      failure = startedResult._tag === "Failure" ? startedResult : null;
    }

    if (failure === null) {
      const navigateResult = await settlePromise(() =>
        navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        }),
      );
      failure = navigateResult._tag === "Failure" ? navigateResult : null;
    }

    if (failure !== null) {
      const cleanupResult = await deleteThread({
        environmentId,
        input: {
          threadId: nextThreadId,
        },
      });
      if (cleanupResult._tag === "Failure" && !isAtomCommandInterrupted(cleanupResult)) {
        console.warn(
          "Failed to clean up implementation thread after start failure.",
          squashAtomCommandFailure(cleanupResult),
        );
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start implementation thread",
            description:
              error instanceof Error
                ? error.message
                : "An error occurred while creating the new thread.",
          }),
        );
      }
    }
    finish();
  });
  const onImplementPlanInNewThreadStable = onImplementPlanInNewThread;

  // Keyed on the fields it reads: the thread and runtime objects change with
  // every streamed event, and a new function re-renders the whole model picker.
  const hasStartedSession = activeRuntime !== null;
  const runtimeProviderInstanceId = activeRuntime?.providerInstanceId ?? null;
  const currentModelSelection = activeThread?.modelSelection ?? null;
  const getModelDisabledReason = makeModelDisabledReason(
    currentModelSelection
      ? {
          providers: providerStatuses,
          hasStartedSession,
          supportsProviderSwitchingViaHandoff,
          currentModelSelection,
          currentProviderInstanceId: runtimeProviderInstanceId,
        }
      : null,
  );

  const onProviderModelSelect = (
    instanceId: ProviderInstanceId,
    model: string,
    options?: ReadonlyArray<ProviderOptionSelection> | { focusComposer?: boolean },
  ) => {
    if (!activeThread) return;
    // SCIENT-FORK:START — the picker can pass the model's options directly.
    const modelOptions = Array.isArray(options)
      ? (options as ReadonlyArray<ProviderOptionSelection>)
      : undefined;
    const focusOptions =
      options !== undefined && !Array.isArray(options)
        ? (options as { focusComposer?: boolean })
        : undefined;
    const shouldFocusComposer = focusOptions?.focusComposer !== false;
    // SCIENT-FORK:END
    const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
    const resolvedDriverKind = entry?.driver ?? null;
    if (
      !supportsProviderSwitchingViaHandoff &&
      lockedProvider !== null &&
      resolvedDriverKind !== null &&
      resolvedDriverKind !== lockedProvider
    ) {
      if (shouldFocusComposer) scheduleComposerFocus();
      return;
    }
    if (
      !supportsProviderSwitchingViaHandoff &&
      lockedProvider !== null &&
      activeRuntime?.providerInstanceId
    ) {
      const currentEntry = providerStatuses.find(
        (snapshot) => snapshot.instanceId === activeRuntime.providerInstanceId,
      );
      if (
        currentEntry?.continuation?.groupKey &&
        entry?.continuation?.groupKey &&
        currentEntry.continuation.groupKey !== entry.continuation.groupKey
      ) {
        if (shouldFocusComposer) scheduleComposerFocus();
        return;
      }
    }
    const resolvedModel = resolveAppModelSelectionForInstance(
      instanceId,
      settings,
      providerStatuses,
      model,
    );
    if (!resolvedModel) {
      if (shouldFocusComposer) scheduleComposerFocus();
      return;
    }
    // SCIENT-FORK: an explicit options payload from the picker wins; otherwise
    // restore this model's own remembered options.
    const rememberedOptions =
      useComposerDraftStore.getState().stickyOptionsByModelByProvider[instanceId]?.[resolvedModel];
    const selectedOptions =
      modelOptions ??
      (rememberedOptions !== undefined && rememberedOptions.length > 0
        ? [...rememberedOptions]
        : undefined);
    const nextModelSelection: ModelSelection =
      selectedOptions !== undefined
        ? { instanceId, model: resolvedModel, options: selectedOptions }
        : { instanceId, model: resolvedModel };
    const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
      providers: providerStatuses,
      hasStartedSession: activeRuntime !== null,
      supportsProviderSwitchingViaHandoff,
      currentModelSelection: activeThread.modelSelection,
      currentProviderInstanceId: activeRuntime?.providerInstanceId ?? null,
      nextModelSelection,
    });
    if (modelChangeBlockReason) {
      toastManager.add({
        type: "warning",
        title: modelChangeBlockReason.title,
        description: modelChangeBlockReason.description,
      });
      if (shouldFocusComposer) scheduleComposerFocus();
      return;
    }
    setComposerDraftModelSelection(
      scopeThreadRef(activeThread.environmentId, activeThread.id),
      nextModelSelection,
      { explicit: true, replaceOptions: true },
    );
    setStickyComposerModelSelection(nextModelSelection);
    if (shouldFocusComposer) scheduleComposerFocus();
  };
  const onProviderModelSelectStable = useStableCallback(onProviderModelSelect);
  const onEnvModeChange = (mode: DraftThreadEnvMode) => {
    if (multipleModelSelections !== null) return;
    if (canOverrideServerThreadEnvMode) {
      if (activeThread) setPendingServerThreadEnvModeEntry({ threadId: activeThread.id, mode });
      scheduleComposerFocus();
      return;
    }
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, {
        envMode: mode,
        startFromOrigin: resolveNewDraftStartFromOrigin({
          envMode: mode,
          newWorktreesStartFromOrigin: activeProjectSettings.settings.newWorktreesStartFromOrigin,
        }),
        ...(mode === "worktree" && draftThread?.worktreePath ? { worktreePath: null } : {}),
      });
    }
    scheduleComposerFocus();
  };
  const onEnvModeChangeStable = useStableCallback(onEnvModeChange);

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
  // One-shot: the resend "Work locally" queued fires once, then the marker clears.
  const resendAfterWorkLocallyStable = useStableCallback(() => {
    setWorkLocallyResendDraftId(null);
    void onComposerSendStable();
  });
  const workLocallyResendReady =
    workLocallyResendDraftId !== null &&
    workLocallyResendDraftId === draftId &&
    isLocalDraftThread &&
    !isSendBusy &&
    !isConnecting &&
    !isRevertingCheckpoint &&
    !threadDetailLoading &&
    clientSettingsHydrated &&
    !needsLoadBalancing &&
    !activeEnvironmentUnavailable &&
    !activePendingProgress &&
    !feedbackUploading;
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

  const onStartFromOriginChange = (nextStartFromOrigin: boolean) => {
    if (canOverrideServerThreadEnvMode && activeThread) {
      setPendingServerThreadStartFromOriginByThreadId((current) =>
        current[activeThread.id] === nextStartFromOrigin
          ? current
          : { ...current, [activeThread.id]: nextStartFromOrigin },
      );
      return;
    }
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, {
        startFromOrigin: nextStartFromOrigin,
      });
    }
  };

  const onExpandTimelineImage = (preview: ExpandedImagePreview) => {
    openExpandedImagePreview(routeThreadKey, preview);
  };
  const onExpandTimelineImageStable = useStableCallback(onExpandTimelineImage);
  const onOpenTurnDiff = (runId: RunId, filePath?: string) => {
    if (!diffAvailable || !activeThreadRef) return;
    runAfterPendingFileSave("diff", () => {
      const diffOpen =
        selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, activeThreadRef) ===
        "diff";
      explicitDiffOpenRef.current = diffOpen ? null : activeThreadRef;
      useDiffPanelStore.getState().selectTurn(activeThreadRef, runId, filePath);
      useRightPanelStore.getState().open(activeThreadRef, "diff");
      onDiffPanelOpen?.();
    });
  };
  const onOpenTurnDiffStable = useStableCallback(onOpenTurnDiff);
  const onTimelineRollbackCheckpoint = (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => {
    if (!paintOnlyDisplayedTimeline) void onRollbackCheckpoint(input);
  };
  const onTimelineRollbackCheckpointStable = useStableCallback(onTimelineRollbackCheckpoint);
  const onRevertTimelineTurn = (targetTurnCount: number, messageId: MessageId) => {
    void onRevertToTurnCountStable(targetTurnCount, messageId);
  };
  const onRevertTimelineTurnStable = useStableCallback(onRevertTimelineTurn);
  // SCIENT-FORK:START — timeline row fork actions.
  const { onForkAssistantMessage, onForkUserMessage } = createForkMessageCommands({
    activeThreadId,
    activeThreadEnvironmentId,
    setForkCommandTarget,
  });
  // SCIENT-FORK:END
  const pendingSidebarFileDrops = useSidebarPendingFileDropStore((state) => state.pending);
  const consumePendingFileDrop = useSidebarPendingFileDropStore(
    (state) => state.consumePendingFileDrop,
  );
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
          focusRequestId: terminalFocusRequestId,
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
  const threadPanelHeaderControl = (
    <div
      className="absolute top-[var(--workspace-controls-top)] right-[calc(env(safe-area-inset-right)+0.75rem)] z-50 flex h-[var(--workspace-topbar-height)] items-center [-webkit-app-region:no-drag]"
      data-workspace-titlebar-controls
    >
      <PanelLayoutControls
        {...panelToggleControlProps}
        showTerminalControl={false}
        showRightPanelControl={false}
      />
    </div>
  );
  const panelLayoutControls = (
    <div
      className={cn(
        "pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]",
      )}
      data-workspace-titlebar-controls
    >
      {!shouldUsePlanSidebarSheet ? (
        <span
          aria-hidden={!rightPanelOpen}
          className={cn(
            "flex shrink-0",
            panelAnimationsActive &&
              "motion-safe:transition-opacity motion-safe:duration-(--panel-animation-duration) motion-safe:ease-out",
            rightPanelOpen
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none absolute right-full mr-1 opacity-0",
          )}
          inert={!rightPanelOpen}
        >
          <RightPanelMaximizeControl
            maximized={rightPanelMaximized}
            onToggle={toggleRightPanelMaximizedStable}
          />
        </span>
      ) : null}
      <div className="pointer-events-auto flex h-full items-center">{panelToggleControls}</div>
    </div>
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
            activeProject={activeProject ?? null}
            parentThreadLink={parentThreadLink}
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
              enabled:
                isServerThread && serverConfig?.threadFind === true && !paintOnlyDisplayedTimeline,
              content: serverProjection ?? undefined,
            }}
            controlsRef={threadFindControlsRef}
            onOpenChange={setIsThreadFindActive}
            detailsCardTopInset={isThreadFindActive ? THREAD_FIND_BAR_RESERVED_HEIGHT : 0}
            composerOverlayElement={isDraftHeroState ? null : composerOverlayElement}
            data-chat-workspace-drop-target="true"
            onDragEnter={workspaceFileDropHandlers.onDragEnter}
            onDragOver={workspaceFileDropHandlers.onDragOver}
            onDragLeave={workspaceFileDropHandlers.onDragLeave}
            onDrop={workspaceFileDropHandlers.onDrop}
          >
            <ThreadFind onClose={focusComposerStable} />
            {isWorkspaceFileDragActive ? (
              <div
                className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
                data-chat-workspace-drop-overlay="true"
              >
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
                >
                  <PaperclipIcon className="size-4 text-primary" aria-hidden="true" />
                  Drop files to attach
                </div>
              </div>
            ) : null}
            <div className="chat-banner-lane pointer-events-none absolute top-0 z-30 flex flex-col">
              <ProviderStatusBanner
                status={visibleProviderStatus}
                onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
                onOpenProviderSetup={openProviderSetupStable}
              />
              <ThreadErrorBanner
                error={isTokenLimitError ? null : timelineThreadError}
                errorClass={
                  localServerError === null && visibleThreadError === serverRuntime?.lastError
                    ? (serverRuntime?.lastErrorClass ?? null)
                    : null
                }
                // SCIENT-FORK: the ChatGPT-specific usage-limit notice used to be
                // detected from thread activities, which upstream replaced with the
                // thread projection. The `usage_limit` error class above still renders
                // the warning variant; the provider-specific ChatGPT button does not.
                onDismiss={() => {
                  setThreadError(activeThread.id, null);
                  dismissThreadErrorBannerForSession(threadErrorBannerKey);
                  setThreadErrorBannerDismissTick((tick) => tick + 1);
                }}
              />
            </div>
            {/* SCIENT-FORK:START — hidden while a landing fork settles, then shown once. */}
            <div
              inert={forkLanding.pending}
              className={cn(
                "relative flex min-h-0 flex-1 flex-col bg-background",
                forkLandingReveal.messagesClassName,
              )}
            >
              {/* SCIENT-FORK:END */}
              <MessagesTimeline
                agentPanelModel={agentPanelModel}
                onOpenAgents={addAgentsSurface}
                citationRequest={paintOnlyDisplayedTimeline ? null : citationRequest}
                citationHistoryLoading={threadDetailLoading}
                {...(!paintOnlyDisplayedTimeline
                  ? {
                      onCiteAssistantText: citeAssistantTextStable,
                      ...(activeProject ? { onRunShellCommand: runShellCommandStable } : {}),
                    }
                  : {})}
                // SCIENT-FORK:START — the working row waits for the sent prompt and its run's start.
                isWorking={!paintOnlyDisplayedTimeline && timelineWorking}
                // SCIENT-FORK:END
                runlessWorkActive={runlessWorkStartedAt !== null}
                activeTurnInProgress={
                  !paintOnlyDisplayedTimeline && (isWorking || !latestRunSettled)
                }
                isCompacting={!paintOnlyDisplayedTimeline && isCompacting}
                awaitingUser={
                  !paintOnlyDisplayedTimeline &&
                  (activePendingApproval !== null ||
                    activePendingUserInput !== null ||
                    // A secret request has no runtime request; the shell carries it.
                    activeThreadShell?.hasPendingUserInput === true)
                }
                activeTurnStartedAt={paintOnlyDisplayedTimeline ? null : activeWorkStartedAt}
                worktreeSetup={paintOnlyDisplayedTimeline ? null : worktreeSetup}
                onCancelWorktreeSetup={onCancelWorktreeSetupStable}
                {...(paintOnlyDisplayedTimeline
                  ? {}
                  : {
                      retryableWorkspacePreparationRunIds,
                      onRetryWorkspacePreparation: onRetryWorkspacePreparationStable,
                    })}
                {...(draftId
                  ? { onWorktreeSetupWorkLocally: onWorktreeSetupWorkLocallyStable }
                  : {})}
                {...(onOpenWorktreeSetupTerminal ? { onOpenWorktreeSetupTerminal } : {})}
                isPreparingWorktree={!paintOnlyDisplayedTimeline && isPreparingWorktree}
                footer={
                  paintOnlyDisplayedTimeline ? null : pendingHandoff === null ? (
                    threadStatusLine
                  ) : (
                    <>
                      <div className="chat-content-lane">
                        <HandoffRow
                          environmentId={environmentId}
                          endpoints={pendingHandoff}
                          providers={providerStatuses}
                          pending
                        />
                      </div>
                      {threadStatusLine}
                    </>
                  )
                }
                listRef={legendListRef}
                timelineEntries={displayedTimeline.entries}
                contextTransfers={
                  paintOnlyDisplayedTimeline ? undefined : serverProjection?.contextTransfers
                }
                runs={paintOnlyDisplayedTimeline ? [] : (serverProjection?.runs ?? [])}
                latestRun={paintOnlyDisplayedTimeline ? null : activeActivityRun}
                runningRunId={paintOnlyDisplayedTimeline ? null : activeRunningTurnId}
                turnDiffSummaries={
                  paintOnlyDisplayedTimeline ? EMPTY_HELD_TURN_DIFF_SUMMARIES : turnDiffSummaries
                }
                activeThreadEnvironmentId={
                  displayedThreadRef?.environmentId ?? activeThread.environmentId
                }
                routeThreadKey={displayedTimelineKey}
                displayThreadKey={displayedTimelineKey}
                paintOnly={paintOnlyDisplayedTimeline}
                onOpenTurnDiff={
                  paintOnlyDisplayedTimeline ? noopHeldTurnDiff : onOpenTurnDiffStable
                }
                onOpenThread={onOpenRelatedThreadStable}
                parentThreadLink={paintOnlyDisplayedTimeline ? null : parentThreadLink}
                workflowOpening={paintOnlyDisplayedTimeline ? null : workflowOpening}
                onForkFromRun={paintOnlyDisplayedTimeline ? async () => {} : onForkFromRunStable}
                onRollbackCheckpoint={onTimelineRollbackCheckpointStable}
                supportsConversationRollback={
                  !paintOnlyDisplayedTimeline && supportsConversationRollback
                }
                threadStartCheckpointReady={threadStartCheckpointReady}
                availableRevertTurnCounts={availableRevertTurnCounts}
                onRevertToTurnCount={
                  paintOnlyDisplayedTimeline ? noopHeldRevert : onRevertTimelineTurnStable
                }
                {...(!paintOnlyDisplayedTimeline
                  ? {
                      onUseArtifactTemplate: insertArtifactTemplateStable,
                      onSendAppMessage: sendAppMessageStable,
                    }
                  : {})}
                // A fork being prepared copies this history: no rewinding until it is done.
                isRevertingCheckpoint={
                  !paintOnlyDisplayedTimeline && (isRevertingCheckpoint || isForkingThread)
                }
                {...(!paintOnlyDisplayedTimeline
                  ? {
                      hasForkBaseline,
                      forkOriginThreadId,
                      forkBaselineAssistantMessageId,
                      onForkAssistantMessage,
                      onForkUserMessage,
                    }
                  : {})}
                onImageExpand={onExpandTimelineImageStable}
                onFileOpen={
                  paintOnlyDisplayedTimeline ? noopHeldAttachment : openFileAttachmentStable
                }
                onFileDownload={
                  paintOnlyDisplayedTimeline ? noopHeldAttachment : downloadFileAttachmentStable
                }
                markdownCwd={
                  paintOnlyDisplayedTimeline
                    ? (heldPaintContext?.markdownCwd ?? undefined)
                    : (gitCwd ?? undefined)
                }
                resolvedTheme={resolvedTheme}
                timestampFormat={timestampFormat}
                workspaceRoot={
                  paintOnlyDisplayedTimeline
                    ? (heldPaintContext?.workspaceRoot ?? undefined)
                    : activeWorkspaceRoot
                }
                skills={paintOnlyDisplayedTimeline ? EMPTY_PROVIDER_SKILLS : timelineSkills}
                anchorMessageId={paintOnlyDisplayedTimeline ? null : timelineAnchorMessageId}
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
                onContentOverflowChange={setTimelineOverflows}
                onToolOutputCollapsedAtEnd={onToolOutputCollapsedAtEndStable}
                // SCIENT-FORK:START — the reader's navigation cancels placement and the follow.
                onManualNavigation={cancelTimelinePositioning}
                // SCIENT-FORK:END
                cancelPositionRestoreRef={cancelPositionRestoreRef}
                // SCIENT-FORK:START
                onPositionedThreadKeyChange={forkLandingReveal.onPositionedThreadKeyChange}
                // SCIENT-FORK:END
                hideEmptyPlaceholder={isDraftHeroState || threadDetailLoading}
                // SCIENT-FORK:START — the restore waits for history, and may page in older turns.
                positionHistoryLoading={paintOnlyDisplayedTimeline || threadDetailLoading}
                // SCIENT-FORK:END
                emptyPlaceholderInset={composerReservedHeight}
                topFadeEnabled={!hasTimelineTopBanner}
                // SCIENT-FORK:START — older pages for the restore and for citations.
                loadEarlier={paintOnlyDisplayedTimeline ? null : loadEarlierTurns}
                // SCIENT-FORK:END
                {...(paintOnlyDisplayedTimeline || threadHistoryControls === undefined
                  ? {}
                  : { historyControls: threadHistoryControls })}
              />

              {showScrollToBottom && !isThreadFindActive && (
                <div
                  className="chat-scroll-to-bottom pointer-events-none absolute z-30 flex justify-center py-1.5"
                  style={{ bottom: scrollToEndClearance + 4 }}
                >
                  <Button
                    // SCIENT-FORK:START — the label says how many answers are unread below.
                    aria-label={
                      unreadBelowCount > 0
                        ? `Scroll to end, ${unreadBelowCount} unread ${unreadBelowCount === 1 ? "message" : "messages"} below`
                        : "Scroll to end"
                    }
                    // SCIENT-FORK:END
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => {
                      composerRef.current?.restoreAfterTimelineReachedEnd();
                      scrollToEnd(true);
                    }}
                    className="pointer-events-auto"
                    size="xs"
                    variant="glass"
                  >
                    <ChevronDownIcon className="size-3.5" />
                    Scroll to end
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
                    {/* SCIENT-FORK:START — queued messages strip, stacked on top of the composer */}
                    <div className="mx-auto w-full max-w-3xl">
                      {isServerThread && activeThread ? (
                        <QueuedRunsControl
                          error={threadQueue.error ?? queueEditStorageError}
                          ref={queuedRunsControlRef}
                          steerShortcutLabel={shortcutLabelForCommand(
                            keybindings,
                            "thread.steerQueuedMessage",
                            { context: { terminalFocus: false } },
                          )}
                          editShortcutLabel={shortcutLabelForCommand(
                            keybindings,
                            "thread.editQueuedMessage",
                            { context: { composerFocus: true } },
                          )}
                          environmentId={activeThread.environmentId}
                          threadId={activeThread.id}
                          optimisticMessages={optimisticUserMessages}
                          editingRunId={queueEdit?.nativeRun?.runId ?? null}
                          onEditQueuedRun={beginEditingQueuedRunStable}
                          onCancelEdit={() => {
                            if (queueEdit)
                              void stashRecoveredDraft(queueEdit).catch((cause) =>
                                setThreadError(threadId, chatActionErrorMessage(cause)),
                              );
                          }}
                        />
                      ) : (
                        <ThreadQueueStrip
                          items={threadQueue.items}
                          pendingMessages={pendingQueueAdmissionPreviews(
                            optimisticUserMessages,
                            routeThreadKey,
                            threadQueue.items,
                            serverAcknowledgedUserMessages,
                          ).map((message) => ({
                            id: message.id,
                            text: message.text,
                            attachmentCount: message.attachments?.length ?? 0,
                            accepted: message.queueAdmission?.accepted === true,
                          }))}
                          error={threadQueue.error ?? queueEditStorageError}
                          threadBusy={phase === "running" || phase === "connecting"}
                          supportsExplicitSend={
                            environmentById.get(environmentId)?.serverConfig?.environment
                              .capabilities.threadQueueExplicitSend === true
                          }
                          awaitingCompletion={threadQueue.awaitingCompletion}
                          paused={threadQueue.paused !== null}
                          dispatchingItemId={threadQueue.pendingSendItemId}
                          onSend={(item) => {
                            void threadQueue.control("send", item.queueItemId).catch(() => {});
                          }}
                          onSteer={(item) => {
                            void threadQueue.control("steer", item.queueItemId).catch(() => {});
                          }}
                          retryable={threadQueue.paused !== null}
                          onRetry={() => {
                            void threadQueue.control("resume").catch(() => {});
                          }}
                          onEdit={editQueuedItem}
                          onDelete={deleteQueuedItem}
                          onReorder={(ids) => {
                            void threadQueue.reorder(ids).catch((cause) => {
                              if (activeThreadId)
                                setThreadError(activeThreadId, chatActionErrorMessage(cause));
                            });
                          }}
                        />
                      )}
                    </div>
                    {/* SCIENT-FORK:END */}
                    <ComposerSurface.Shell
                      contextStrip={showComposerContextStrip || showComposerModelStrip}
                    >
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
                              onOpenParent={
                                parentThreadLink
                                  ? () => onOpenRelatedThread(parentThreadLink.threadId)
                                  : null
                              }
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
                              activeProjectId={activeProject?.id ?? null}
                              activeThreadEnvironmentId={activeThread?.environmentId}
                              activeThread={activeThread}
                              activeThreadShell={activeThreadShell}
                              promptHistoryMessages={timelineMessages}
                              hasConversationMessages={hasConversationMessages}
                              isServerThread={isServerThread}
                              isLocalDraftThread={isLocalDraftThread}
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
                              isConnecting={isConnecting || !queueEditsReady}
                              isSendBusy={
                                (isSendBusy && !sendQueuesBehindSetup) ||
                                (setupQueueSendThreadKey !== null &&
                                  setupQueueSendThreadKey === activeThreadKey) ||
                                isResuming
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
                              queuedRunsControl={null}
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
                              // SCIENT-FORK:START
                              syncStatusHidden={forkLandingReveal.syncStatusHidden}
                              // SCIENT-FORK:END
                              runtimeMode={runtimeMode}
                              interactionMode={interactionMode}
                              lockedProvider={modelPickerLockedProvider}
                              providerStatuses={providerStatuses as ServerProvider[]}
                              providerCatalogKnown={serverConfig !== null}
                              activeProjectDefaultModelSelection={
                                activeProjectDefaultModelSelection
                              }
                              activeThreadModelSelection={activeThread?.modelSelection}
                              activeContextWindow={activeContextWindow}
                              activeTasksProgress={activeComposerTasksProgress}
                              activeTaskSteps={activeComposerTaskSteps}
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
                              restingControlsHost={restingComposerControlsHost}
                              restingControlsHaveLeadingContext={
                                mountComposerContextStrip &&
                                (isGitRepo || showComposerEnvironmentIndicator)
                              }
                              onRestingControlsVisibilityChange={setRestingComposerControlsVisible}
                              getTimelineScrollableNode={getTimelineScrollableNodeStable}
                              isTimelineAtLogicalEnd={isTimelineAtLogicalEndStable}
                              timelineOverflows={timelineOverflows}
                              onComposerOverlayHeightChange={publishComposerOverlayHeightStable}
                              onRestingChange={onComposerRestingChangeStable}
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
                              onForkConversation={onForkConversation}
                              onRespondToApproval={onRespondToApprovalStable}
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
                          {mountComposerModelStrip ? (
                            <ComposerSurface.ContextStrip
                              data-composer-model-strip="true"
                              aria-hidden={showComposerModelStrip ? undefined : true}
                              inert={showComposerModelStrip ? undefined : true}
                              className={cn(
                                "group-data-model-strip-transition/composer-surface:before:backdrop-blur-(--glass-blur) group-data-model-strip-transition/composer-surface:before:bg-(--chat-composer-glass-surface)/(--glass-opacity)",
                                !showComposerModelStrip &&
                                  "pointer-events-none invisible absolute inset-x-0 top-full",
                              )}
                            >
                              <div
                                ref={setRestingComposerControlsHost}
                                className="min-w-0 flex-1"
                              />
                            </ComposerSurface.ContextStrip>
                          ) : null}
                          {mountComposerContextStrip && (
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
                                composerControlsHostRef={setRestingComposerControlsHost}
                                contextStripVisible={showComposerContextStrip}
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
            {activeThreadRef &&
            activePreviewMiniPlayer &&
            previewMiniPlayerVisible &&
            (activePreviewMiniPlayer.content.kind === "device" || canOperatePreview) ? (
              <ThreadPreviewMiniPlayer
                key={`${activeThreadKey}:${activePreviewMiniPlayer.content.id}`}
                threadRef={activeThreadRef}
                miniPlayer={activePreviewMiniPlayer}
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
              onPresentationChange={setThreadPanelPresentation}
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
          focusRequestId={terminalFocusRequestId}
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
              <div className="mr-px flex items-center">{panelToggleControls}</div>
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
          onDuplicateSurface={duplicateRightPanelSurface}
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
          {/* SCIENT-FORK:START — file history diagnostics and the last rewind failure. */}
          <ScientRevertDialogDiagnostics
            fileHistoryIssue={fileHistoryIssue}
            error={pendingRevert?.error}
          />
          {/* SCIENT-FORK:END */}
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
                void onRevertToTurnCount(pendingRevert.turnCount, pendingRevert.messageId, true);
              }}
            >
              Revert files too
            </Button>
            <Button
              disabled={isRevertingCheckpoint}
              onClick={() => {
                if (!pendingRevert || pendingRevert.routeThreadKey !== routeThreadKey) return;
                void onRevertToTurnCount(pendingRevert.turnCount, pendingRevert.messageId, false);
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
          ThreadVisitWatermark would mark a background window or an unloaded answer read. */}
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
