import { MessageId } from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { ChatComposerHandle } from "./ChatComposer";
import { chatActionErrorMessage, getAntigravitySendBlockReason } from "../ChatView.logic";
import { shouldCompactBeforeSend } from "./ContextWindowMeter.logic";
import { declineShownApprovalsBeforeSend } from "./approvalSendGuard";
import { resolveComposerInteractionMode } from "../ChatView.logic";
import { readFileAsDataUrl } from "../../lib/imageCompression";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { prepareComposerContextMessage } from "../../lib/composerContextSend";
import { stripInlineContextReferences } from "../../lib/composerContextReferences";
import { collectSelectedScientSkillNames } from "@t3tools/shared/composerInlineTokens";
import {
  queueSubmissionId,
  acknowledgeQueueSubmission,
  composerSubmissionMatchesDraft,
  consumeExtractedSubmission,
  type ExtractedSubmissionPacket,
} from "../../scient/threadQueue/submission";
import {
  beginExtractedSubmission,
  extractedIntentActionErrors,
  prepareAndBindExtractedSubmission,
  retireAcknowledgedExtractedDraft,
} from "../../scient/threadQueue/extractedIntentSend";
import type { ExtractedIntentRecord } from "../../scient/threadQueue/editJournal";
import {
  finishQueueEdit,
  flushQueueEdit,
  useQueueEditSessions,
  prepareExtractedDraftIntent,
} from "../../scient/threadQueue/editSession";
import { composerTargetKey } from "../../composerDraftStore";
import { CommandId, PlanId } from "@t3tools/contracts";
import { composerCitationsToPlainText } from "@t3tools/shared/composerCitations";
import { isStandaloneForkSlashCommand } from "../../composer-logic";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { randomHex, randomUUID } from "~/lib/utils";
import {
  settleQueueAdmissionPreview,
  shouldPreviewQueueAdmission,
} from "~/scient/threadQueue/optimisticQueuePresentation";
import type { ThreadQueueSendState } from "~/scient/threadQueue/useThreadQueue";
import { getComposerPromptInjectionState, getComposerProviderState } from "./composerProviderState";
import { flushComposerDraftPersistence } from "../../composerDraftStore";

import {
  encodeQueueComposerSnapshot,
  assertQueueEditSelectionProvenance,
} from "../../scient/threadQueue/composerSnapshot";

import {
  mergeDirectPreviewAnnotation,
  resolveBackgroundDraftWorkspaceOptions,
  shouldDockDraftHeroForSubmission,
  buildExpiredTerminalContextToastCopy,
  deriveComposerSendState,
  boundAttachmentIds,
  formatOutgoingPrompt,
  optimisticMessageAttachments,
  planComposerTurn,
  sendTitleFallbackLabels,
  snapshotComposerSend,
  makeThreadErrorSetter,
} from "../ChatView.logic";
import { isUsageLimitsCommand } from "@t3tools/shared/usageLimits";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_MODEL,
  type EnvironmentId,
  type ModelSelection,
  type PreviewAnnotationPayload,
  type ThreadId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";

import { wasBootstrapThreadDeleted } from "@t3tools/client-runtime/errors";
import { sendApprovalFeedback } from "@t3tools/client-runtime/state/thread-requests";
import {
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import { type SetStateAction, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  type ComposerSubmissionIntent,
  parseStandaloneComposerSlashCommand,
} from "../../composer-logic";
import { resolvePlanFollowUpSubmission } from "../../proposedPlan";
import { type ChatMessage } from "../../types";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { newMessageId, newThreadId } from "~/lib/utils";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  beginBackgroundDraftSubmissionByRef,
  clearBackgroundDraftSubmissionByRef,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  restoreFailedDraftThread,
  composerDraftHasUserContent,
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  DraftId,
} from "../../composerDraftStore";
import { ensureInlineContextReferences } from "../../lib/composerContextReferences";
import {
  buildMessageContext,
  previewAnnotationContextReference,
} from "../../lib/composerContextRecords";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { runMobileComposerTransition } from "./draftHeroTransition";
import { useClientSettingsHydrated, useEnvironmentSettings } from "../../hooks/useSettings";
import { environmentPresentations } from "../../state/presentation";
import {
  approvalRedirectNotice,
  loadBalancingSendWarning,
  multipleModelSendBlock,
  referencedThreadContexts,
} from "./composerSend.logic";
import { usePlanFollowUpSend } from "./useProposedPlanSend";
import { useMultipleModelSend } from "./useMultipleModelSend";
import { type ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import { readEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  threadContextsOutsideEnvironment,
} from "@t3tools/shared/composerContextReferences";
import { draftSendState, prepareTurnAttachments } from "./chatViewSend";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { UnifiedSettings } from "@t3tools/contracts";
import type { Dispatch } from "react";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { SessionPhase } from "../../types";
import type { DraftSessionState } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import type { LatestProposedPlanState } from "../../session-logic";
import type { useDraftEnvironmentRouting } from "./useDraftEnvironmentRouting";
import type { LocalDispatchActions } from "./useLocalDispatchState";
import type { PendingThreadSendState } from "./usePendingThreadRequests";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { useTimelineFollow } from "./useTimelineFollow";
import type { useUsageLimitsPanel } from "./useUsageLimitsPanel";
import type { useWorktreeSetup } from "./useWorktreeSetup";

const ENVIRONMENT_UNAVAILABLE_SEND_TOAST_TRAIL_SIZE = 3;

const selectPlanModeEnabled = (settings: UnifiedSettings) => settings.planModeEnabled;

function readEnvironmentPresentation(environmentId: EnvironmentId) {
  return appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId);
}

function draftHasNonPromptContent(target: ComposerThreadTarget) {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  return draft ? composerDraftHasUserContent({ ...draft, prompt: "" }) : false;
}

type DraftEnvironmentRouting = ReturnType<typeof useDraftEnvironmentRouting>;
type UsageLimitsPanel = ReturnType<typeof useUsageLimitsPanel>;
type TimelineFollow = ReturnType<typeof useTimelineFollow>;

export interface ComposerSendInput {
  readonly queueEditsReady: boolean;
  readonly queueContextKeyRef: { readonly current: string | null };
  readonly threadQueue: ThreadQueueSendState;
  readonly serverProjection: ThreadStructure | null;
  readonly hasHeldQueuedRuns: boolean;
  readonly onForkConversation: () => void;
  readonly captureSendReadingPosition: TimelineFollow["captureSendReadingPosition"];
  readonly frameSubmittedMessage: TimelineFollow["frameSubmittedMessage"];

  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadKey: string | null;
  readonly activeThreadBranch: string | null;
  readonly activeProject: EnvironmentProject | null;
  readonly activeProjectDefaultModelSelection: ModelSelection | null;
  readonly activeProposedPlan: LatestProposedPlanState | null;
  readonly activeMessageCount: number;
  readonly isServerThread: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly phase: SessionPhase;
  readonly sendEnvMode: DraftThreadEnvMode;
  readonly startFromOrigin: boolean;
  readonly localCheckoutBranchMismatch: {
    readonly threadBranch: string;
    readonly currentBranch: string;
  } | null;
  readonly logicalProjectEnvironments: ReturnType<typeof useLogicalProjectEnvironments>;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly promptRef: { current: string };
  readonly feedbackUploadsInFlightRef: { readonly current: Set<string> };
  readonly isConnecting: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly threadDetailLoading: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly isSendBusy: boolean;
  readonly sendQueuesBehindSetup: boolean;
  readonly isDraftHeroState: boolean;
  readonly panelAnimationsActive: boolean;
  readonly panelAnimationDurationMs: number;
  readonly keepFullHistory: boolean;
  readonly resumeCompactionTokens: number | null;
  readonly showPlanFollowUpPrompt: boolean;
  readonly usageLimitsKey: string | null;
  readonly usageLimitsOffered: boolean;
  readonly openUsageLimits: UsageLimitsPanel["open"];
  readonly clearUsageLimitsFor: UsageLimitsPanel["clearFor"];
  readonly needsLoadBalancing: boolean;
  readonly loadBalancing: DraftEnvironmentRouting["loadBalancing"];
  readonly readPendingEnvironmentChange: DraftEnvironmentRouting["readPendingEnvironmentChange"];
  readonly pendingApprovals: PendingThreadSendState["pendingApprovals"];
  readonly respondingRequestIds: PendingThreadSendState["respondingRequestIds"];
  readonly activePendingProgress: PendingThreadSendState["activePendingProgress"];
  readonly onAdvanceActivePendingUserInput: PendingThreadSendState["onAdvanceActivePendingUserInput"];
  readonly onRespondToApproval: PendingThreadSendState["onRespondToApproval"];
  readonly beginLocalDispatch: LocalDispatchActions["beginLocalDispatch"];
  readonly resetLocalDispatch: LocalDispatchActions["resetLocalDispatch"];
  readonly beginWorktreeSetup: ReturnType<typeof useWorktreeSetup>["begin"];
  readonly captureDraftHeroComposerRect: () => void;
  readonly setDockedDraftHeroThreadKey: Dispatch<SetStateAction<string | null>>;
  readonly setSetupQueueSendThreadKey: Dispatch<SetStateAction<string | null>>;
  readonly setOptimisticUserMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  readonly setFeedbackSubmissionsByThreadKey: Dispatch<
    SetStateAction<Record<string, ReadonlyArray<CodexFeedbackSubmission>>>
  >;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
  readonly setKeepFullHistory: (threadKey: string, keep: boolean) => void;
  readonly acknowledgeActiveThreadWoke: () => void;
  readonly handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  readonly handleNewThreadInActiveProject: () => void;
  readonly persistThreadSettingsForNextTurn: (input: {
    threadId: ThreadId;
    createdAt: string;
    assertCurrent?: () => void;
    modelSelection?: ModelSelection;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<AtomCommandResult<void, unknown>>;
}

/**
 * Recovery may yield or replace the draft. A send keeps its captured context and
 * only consumes that draft after an admission receipt.
 */
export function useComposerSend(input: ComposerSendInput) {
  const {
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
    isConnecting,
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
    setFeedbackSubmissionsByThreadKey,
    setThreadError,
    setKeepFullHistory,
    acknowledgeActiveThreadWoke,
    handleInteractionModeChange,
    handleNewThreadInActiveProject,
    persistThreadSettingsForNextTurn,
  } = input;
  const {
    queueEditsReady,
    queueContextKeyRef,
    threadQueue,
    serverProjection,
    hasHeldQueuedRuns,
    onForkConversation,
    captureSendReadingPosition,
    frameSubmittedMessage,
  } = input;
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();
  const clientSettingsHydrated = useClientSettingsHydrated();
  const planModeEnabled = useEnvironmentSettings(environmentId, selectPlanModeEnabled);
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const uploadThreadFeedback = useOrchestrationCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const sendToMultipleModels = useMultipleModelSend({
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    draftId,
    composerDraftTarget,
    composerRef,
    promptRef,
    startFromOrigin,
    resetLocalDispatch,
    setThreadError,
  });
  const { sendInFlight: sendInFlightRef } = draftSendState(routeThreadKey);
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const activeProjectRef = activeProject
    ? scopeProjectRef(activeProject.environmentId, activeProject.id)
    : null;
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const composerSendGenerationRef = useRef(0);
  const environmentUnavailableSendToastSlotRef = useRef(0);
  // A send awaits uploads before it declines, so it reads the approvals pending by then.
  const pendingApprovalsRef = useRef(pendingApprovals);
  const respondingRequestIdsRef = useRef(respondingRequestIds);
  useLayoutEffect(() => {
    pendingApprovalsRef.current = pendingApprovals;
    respondingRequestIdsRef.current = respondingRequestIds;
  }, [pendingApprovals, respondingRequestIds]);

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
    const notice = approvalRedirectNotice(result);
    if (notice !== null) {
      toastManager.add({
        type: "info",
        title: notice,
        description: "Send again when it's ready.",
      });
    }
    return false;
  };

  const onSubmitPlanFollowUp = usePlanFollowUpSend({
    environmentId,
    routeThreadKey,
    activeThread,
    activeProposedPlan,
    isServerThread,
    isSendBusy,
    isConnecting,
    beginLocalDispatch,
    resetLocalDispatch,
    localCheckoutBranchMismatch,
    setOptimisticUserMessages,
    setThreadError,
    persistThreadSettingsForNextTurn,
    currentRouteThreadKeyRef,
    composerDraftTarget,
    declineApprovalsForSend,
    frameSubmittedMessage,
    threadQueue,
    clearUsageLimitsFor,
    acknowledgeActiveThreadWoke,
  });
  // A follow-up returns its durable admission identity so only an accepted send
  // retires a queue edit and clears its matching draft.
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
      const directPrompt = options?.directPrompt?.trim() || null;
      let queueEdit =
        directPrompt === null
          ? useQueueEditSessions.getState().sessions[composerTargetKey(composerDraftTarget)]
          : undefined;
      const readingPositionAtSend = captureSendReadingPosition();
      // SCIENT-FORK:END
      if (
        !useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.extractedIntent &&
        usageLimitsOffered &&
        usageLimitsKey !== null &&
        !directAnnotation &&
        directPrompt === null &&
        !draftHasNonPromptContent(composerDraftTarget) &&
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
      if (!sendCtx || sendCtx.pendingAttachments) return;
      const approvalFeedbackTarget =
        directPrompt === null && !directAnnotation
          ? pendingApprovalsRef.current.find(
              (approval) =>
                approval.responseCapability === "live" &&
                approval.supportsFeedback &&
                approval.requestId === sendCtx.shownPendingApprovalIds[0],
            )
          : undefined;
      const threadContextsAtSend = referencedThreadContexts(sendCtx);
      const draftSnapshotForSend = useComposerDraftStore
        .getState()
        .getComposerDraft(composerDraftTarget);
      const runtimeMode = draftSnapshotForSend?.runtimeMode ?? activeThread.runtimeMode;
      const isCurrentDraft = () =>
        currentRouteThreadKeyRef.current === routeThreadKey &&
        (directPrompt !== null ||
          composerSubmissionMatchesDraft(
            draftSnapshotForSend,
            useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
          ));
      const assertCurrentDraft = () => {
        if (!isCurrentDraft())
          throw new Error("Your draft changed or you left this thread. Send again when ready.");
      };
      const steerRequested =
        options?.steer === true ||
        (dispatchMode === "steer" && (sendCtx?.shownPendingApprovalIds.length ?? 0) > 0);
      // SCIENT-FORK:START — an extracted queue intent is retried or bound before this send, and a
      // queue edit is flushed; both settle before the send continues.
      sendInFlightRef.current = true;
      await (async () => {
        try {
          const intakeResult = await settlePromise(() =>
            beginExtractedSubmission({
              target: composerDraftTarget,
              queueEdit,
              hasSeparateAction: () => Boolean(steerRequested || directAnnotation || directPrompt),
              dispatch: startThreadTurn,
              onDraftCleared: () => {
                if (currentRouteThreadKeyRef.current === routeThreadKey) {
                  promptRef.current = "";
                  composerRef.current?.resetCursorState();
                }
              },
            }),
          );
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
          if (!isCurrentDraft()) return;
          if (queueEdit && !queueEdit.transferred) {
            const editToFlush = queueEdit;
            const flushResult = await settlePromise(() => flushQueueEdit(editToFlush));
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
          if (!isCurrentDraft()) return;
          if (needsLoadBalancing) {
            toastManager.add({
              type: "warning",
              ...loadBalancingSendWarning({
                pending: loadBalancing.pending,
                threadContexts: threadContextsAtSend,
                candidateEnvironments: logicalProjectEnvironments,
              }),
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
          const multipleModelBlock =
            multipleModelSelections === null
              ? null
              : multipleModelSendBlock({
                  selectionCount: multipleModelSelections.length,
                  serverSupportsWorktreeBootstrap:
                    readEnvironmentPresentation(environmentId)?.serverConfig?.environment
                      .capabilities.requiredWorktreeBootstrap === true,
                  isLocalDraftThread,
                  hasProject: Boolean(activeProject),
                  isGitRepo,
                  branch: activeThreadBranch,
                });
          if (multipleModelBlock === "server-outdated") {
            setThreadError(activeThread.id, "Update this server before starting multiple models.");
            return;
          }
          if (multipleModelBlock === "needs-new-git-thread") {
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
            threadContexts: sendContextThreadContexts,
            selectedProvider: ctxSelectedProvider,
            selectedModel: ctxSelectedModel,
            selectedProviderModels: ctxSelectedProviderModels,
            selectedPromptEffort: ctxSelectedPromptEffort,
            selectedModelSelection: ctxSelectedModelSelection,
            interactionMode: sendInteractionMode,
            interactionModeEnabled: sendInteractionModeEnabled,
          } = sendCtx;
          // SCIENT-FORK:START — a direct prompt (e.g. a queue steer) sends only its own text.
          const composerThreadContexts = directPrompt === null ? sendContextThreadContexts : [];
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
          const strandedThread = threadContextsOutsideEnvironment({
            text: promptForSend,
            records: composerThreadContexts,
            environmentId,
          })[0];
          if (strandedThread) {
            const owner =
              readEnvironmentPresentation(strandedThread.environmentId)?.entry.target.label ??
              "its machine";
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
              previewQueueAdmission: shouldPreviewQueueAdmission({
                ordinaryServerSend: sendCtx.shownPendingApprovalIds.length === 0,
                phase,
                hasWaitingItems:
                  serverProjection?.runs.some((run) => run.status === "queued") === true,
                awaitingCompletion: hasHeldQueuedRuns,
              }),
              sendCtx,
              runtimeMode,
              promptAtSend,
              pendingApprovalIdsAtSend,
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
              sourceProposedPlan:
                queueEdit?.extractedItem?.sourceProposedPlan ??
                (followUp.interactionMode === "default"
                  ? { threadId: activeThread.id, planId: activeProposedPlan.id }
                  : undefined),
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
                  useComposerDraftStore
                    .getState()
                    .setInteractionMode(composerDraftTarget, followUp.interactionMode);
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
          const submissionTargetKey = composerTargetKey(
            scopeThreadRef(environmentId, threadIdForSend),
          );
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
              setThreadError(
                threadIdForSend,
                cause instanceof Error ? cause.message : String(cause),
              );
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
            const config =
              appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
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
              planModeEnabled: planModeEnabled,
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
                planModeEnabled: planModeEnabled,
                provider: provider.snapshot,
                interactionMode: sendInteractionMode,
              }).interactionMode,
            });
          }

          // Feedback declines the shown request for good, so it runs only after local commands and
          // every rejection above have accepted the send. A captured queue record is not feedback:
          // it keeps its own redirect, declining shown approvals and dispatching as recorded.
          if (approvalFeedbackTarget !== undefined && !queueEdit && !extractedIntent) {
            if (
              composerImages.length > 0 ||
              effectiveComposerFiles.length > 0 ||
              effectiveComposerTerminalContexts.length > 0 ||
              composerPreviewAnnotations.length > 0 ||
              effectiveReviewComments.length > 0 ||
              composerThreadContexts.length > 0
            ) {
              setThreadError(
                activeThread.id,
                "Send approval feedback without attachments or added context.",
              );
              return;
            }
            const currentApproval = pendingApprovalsRef.current.find(
              (approval) => approval.requestId === approvalFeedbackTarget.requestId,
            );
            if (
              !isCurrentDraft() ||
              promptRef.current !== promptForSend ||
              composerRef.current?.hasPendingAttachments() ||
              composerRef.current?.getSendContext().shownPendingApprovalIds[0] !==
                approvalFeedbackTarget.requestId ||
              currentApproval?.responseCapability !== "live" ||
              !currentApproval.supportsFeedback ||
              respondingRequestIdsRef.current.includes(approvalFeedbackTarget.requestId)
            )
              return;
            const feedbackDraftAtReply = useComposerDraftStore
              .getState()
              .getComposerDraft(composerDraftTarget);
            const feedbackResult = await settlePromise(() =>
              sendApprovalFeedback(currentApproval, trimmed, onRespondToApprovalStable),
            );
            if (
              feedbackResult._tag === "Success" &&
              feedbackResult.value &&
              isCurrentDraft() &&
              useComposerDraftStore.getState().getComposerDraft(composerDraftTarget) ===
                feedbackDraftAtReply &&
              promptRef.current === promptForSend &&
              !composerRef.current?.hasPendingAttachments()
            ) {
              promptRef.current = "";
              clearComposerDraftContent(composerDraftTarget);
              composerRef.current?.resetCursorState();
            }
            return;
          }
          const sendGeneration = ++composerSendGenerationRef.current;
          let submittedMessageId: MessageId | null = null;
          let requestAccepted = false;
          // SCIENT-FORK:START — the attempt runs as one settled unit: anything thrown fails it, and the
          // release below still runs, like the finally it replaces.
          const sendAttempt = await settlePromise(async () => {
            assertCurrentDraft();
            if (extractedIntent)
              extractedIntent = await prepareExtractedDraftIntent(extractedIntent.intentId);
            if (queueEdit) await flushQueueEdit(queueEdit);
            assertCurrentDraft();
            // SCIENT-FORK:END
            const attachmentCapabilitiesBeforeUpload = readLiveAttachmentCapabilities();
            if (attachmentCapabilitiesBeforeUpload.fileBlockReason !== null) {
              setThreadError(threadIdForSend, attachmentCapabilitiesBeforeUpload.fileBlockReason);
              return;
            }
            const turnUsesAttachmentUploads =
              composerFilesSnapshot.length > 0
                ? attachmentCapabilitiesBeforeUpload.supportsAttachmentUploads
                : readLiveAttachmentCapabilities().supportsAttachmentUploads;
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
                setThreadError(threadIdForSend, attachmentCapabilitiesAfterUpload.fileBlockReason);
                return;
              }
              if (
                getUploadedAttachments({ environmentId, images: composerAttachmentsSnapshot }) ===
                null
              ) {
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

            assertCurrentDraft();
            const attachmentCapabilitiesBeforeDispatch = readLiveAttachmentCapabilities();
            if (
              !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
              attachmentCapabilitiesBeforeDispatch.fileBlockReason !== null
            ) {
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
                preparingWorktree:
                  multipleModelSelections !== null || Boolean(baseBranchForWorktree),
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
              if (
                steerRequested ||
                directAnnotation ||
                extractedIntent ||
                multipleModelSelections !== null
              )
                return undefined;
              return queueSubmissionId(submissionTargetKey, {
                threadId: threadIdForSend,
                sourceProposedPlan: queueEdit?.extractedItem?.sourceProposedPlan,
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
              if (!sendQueuesBehindSetup) resetLocalDispatch();
              setThreadError(
                threadIdForSend,
                chatActionErrorMessage(squashAtomCommandFailure(submissionIdentityResult)),
              );
              return;
            }
            const submissionId = submissionIdentityResult.value;
            assertCurrentDraft();
            const messageIdForSend = submissionId ? MessageId.make(submissionId) : newMessageId();
            submittedMessageId = messageIdForSend;
            // SCIENT-FORK:END
            const messageCreatedAt = new Date().toISOString();
            const turnAttachmentsPromise = prepareTurnAttachments({
              environmentId,
              attachments: composerAttachmentsSnapshot,
              usesAttachmentUploads: turnUsesAttachmentUploads,
            });
            if (multipleModelSelections !== null && activeProject) {
              await sendToMultipleModels({
                threadId: threadIdForSend,
                project: activeProject,
                branch: activeThreadBranch!,
                selections: multipleModelSelections,
                targets: multipleTargets,
                sendSnapshot,
                createdAt: messageCreatedAt,
                attachmentsPromise: turnAttachmentsPromise,
                usesAttachmentUploads: turnUsesAttachmentUploads,
                readFileBlockReason: () => readLiveAttachmentCapabilities().fileBlockReason,
                buildOutgoingMessageContext,
                selectedScientSkillNames,
                runtimeMode,
                isCurrentDraft: isCurrentDraft,
                isCurrentSend: () => composerSendGenerationRef.current === sendGeneration,
              });
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
                awaitingCompletion: isServerThread
                  ? hasHeldQueuedRuns
                  : threadQueue.awaitingCompletion,
              });
            if (!previewQueueAdmission)
              frameSubmittedMessage(messageIdForSend, readingPositionAtSend);
            // SCIENT-FORK:END
            setOptimisticUserMessages((existing) => [
              ...existing,
              {
                id: messageIdForSend,
                role: "user",
                text: outgoingMessageText,
                ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
                ...(outgoingMessageContext !== undefined
                  ? { context: outgoingMessageContext }
                  : {}),
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
              assertCurrentDraft();
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
              assertCurrentDraft();
              const settingsResult = await persistThreadSettingsForNextTurn({
                assertCurrent: assertCurrentDraft,
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
              assertCurrentDraft();
              const branchResult = await updateThreadMetadata({
                environmentId,
                input: {
                  threadId: threadIdForSend,
                  branch: localCheckoutBranchMismatch.currentBranch,
                },
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
              assertCurrentDraft();
              const compactResult = await startThreadTurn({
                environmentId,
                input: {
                  commandId: CommandId.make(
                    submissionId ? `composer-compaction:${submissionId}` : randomUUID(),
                  ),
                  threadId: threadIdForSend,
                  message: {
                    messageId: newMessageId(),
                    role: "user",
                    text: "/compact",
                    attachments: [],
                    idleCompaction: "onReturn",
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
                    extractedIntent
                      ? `extracted-intent:${extractedIntent.intentId}`
                      : submissionId
                        ? `composer-submission:${submissionId}`
                        : randomUUID(),
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
                        boundAttachmentIds(
                          turnAttachmentsResult.value,
                          composerAttachmentsSnapshot,
                        ),
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
              assertCurrentDraft();
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
                  if (previewQueueAdmission && currentRouteThreadKeyRef.current === routeThreadKey)
                    frameSubmittedMessage(messageIdForSend, readingPositionAtSend);
                  clearUsageLimitsFor(routeThreadKey);
                  acknowledgeActiveThreadWoke();
                }
                if (turnUsesAttachmentUploads && canAcknowledge) {
                  releaseDraftAttachments(composerAttachmentsSnapshot);
                }
                // SCIENT-FORK:END
                if (backgroundThreadRef) {
                  if (
                    backgroundDraftOpened ||
                    currentRouteThreadKeyRef.current !== routeThreadKey
                  ) {
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
                      description:
                        error instanceof Error ? error.message : "Failed to send message.",
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
            setSetupQueueSendThreadKey((current) => (current === activeThreadKey ? null : current));
          }
          // SCIENT-FORK:END
        } catch (error) {
          if (currentRouteThreadKeyRef.current === routeThreadKey) {
            setThreadError(activeThread.id, chatActionErrorMessage(error));
          }
        }
      })().finally(() => {
        sendInFlightRef.current = false;
      });
    },
  );

  return { onSend };
}
