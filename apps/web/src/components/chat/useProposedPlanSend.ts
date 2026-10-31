import { startFanoutThread } from "./chatViewSend";
import { settleQueueAdmissionPreview } from "~/scient/threadQueue/optimisticQueuePresentation";
import { CommandId } from "@t3tools/contracts";
import { composerSubmissionMatchesDraft } from "../../scient/threadQueue/submission";
import { MessageId } from "@t3tools/contracts";
import { useStableCallback } from "../../hooks/useStableCallback";
import { chatActionErrorMessage } from "../ChatView.logic";
import type { ComposerSendInput } from "./useComposerSend";
import type { ChatComposerHandle } from "./ChatComposer";
import { queueSubmissionId } from "../../scient/threadQueue/submission";
import { composerTargetKey } from "../../composerDraftStore";
import { PlanId } from "@t3tools/contracts";
import type { ScientThreadQueueItem } from "@t3tools/contracts";

import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { truncate } from "@t3tools/shared/String";
import { useNavigate } from "@tanstack/react-router";
import type { Dispatch, SetStateAction } from "react";
import { newMessageId } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { buildMessageContext } from "../../lib/composerContextRecords";
import {
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
} from "../../proposedPlan";
import type { LatestProposedPlanState } from "../../session-logic";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { ChatMessage } from "../../types";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  formatOutgoingPrompt,
  type makeThreadErrorSetter,
  waitForStartedServerThread,
} from "../ChatView.logic";
import { draftSendState } from "./chatViewSend";
import type { LocalDispatchActions } from "./useLocalDispatchState";

interface PlanSendBase {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadBranch: string | null;
  readonly activeProposedPlan: LatestProposedPlanState | null;
  readonly isServerThread: boolean;
  readonly isSendBusy: boolean;
  readonly composerRef: ComposerHandleRef;
  readonly beginLocalDispatch: LocalDispatchActions["beginLocalDispatch"];
  readonly resetLocalDispatch: LocalDispatchActions["resetLocalDispatch"];
}

interface PlanFollowUpSendInput
  extends
    Omit<PlanSendBase, "activeThreadBranch" | "composerRef">,
    Pick<
      ComposerSendInput,
      | "currentRouteThreadKeyRef"
      | "composerDraftTarget"
      | "frameSubmittedMessage"
      | "clearUsageLimitsFor"
      | "acknowledgeActiveThreadWoke"
    > {
  readonly declineApprovalsForSend: (input: {
    sendCtx: ReturnType<ChatComposerHandle["getSendContext"]>;
    pendingApprovalIdsAtSend: ReturnType<
      ChatComposerHandle["getSendContext"]
    >["shownPendingApprovalIds"];
    promptAtSend: string;
  }) => Promise<boolean>;
  readonly localCheckoutBranchMismatch: { readonly currentBranch: string } | null;
  readonly setOptimisticUserMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
  readonly persistThreadSettingsForNextTurn: (input: {
    threadId: EnvironmentThreadShell["id"];
    createdAt: string;
    assertCurrent?: () => void;
    modelSelection?: ModelSelection;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<AtomCommandResult<void, unknown>>;
}

/**
 * Answers a proposed plan on this thread: refine it in plan mode, or implement it here
 * (which links the turn to the plan). Resolves whether the turn started.
 */
export function usePlanFollowUpSend(input: PlanFollowUpSendInput) {
  const {
    environmentId,
    routeThreadKey,
    activeThread,
    activeProposedPlan,
    isServerThread,
    isSendBusy,
    beginLocalDispatch,
    resetLocalDispatch,
    localCheckoutBranchMismatch,
    setOptimisticUserMessages,
    setThreadError,
    persistThreadSettingsForNextTurn,
  } = input;
  const {
    declineApprovalsForSend,
    frameSubmittedMessage,
    clearUsageLimitsFor,
    acknowledgeActiveThreadWoke,
  } = input;
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });

  const onSubmitPlanFollowUp = useStableCallback(
    async ({
      previewQueueAdmission,
      sendCtx,
      runtimeMode,
      promptAtSend,
      pendingApprovalIdsAtSend,
      text,
      context,
      interactionMode: nextInteractionMode,
      selectedScientSkillNames,
      readingPositionAtSend,
      composerSnapshot,
      sourceProposedPlan,
    }: {
      previewQueueAdmission: boolean;
      sendCtx: ReturnType<ChatComposerHandle["getSendContext"]>;
      runtimeMode: RuntimeMode;
      promptAtSend: string;
      pendingApprovalIdsAtSend: ReturnType<
        ChatComposerHandle["getSendContext"]
      >["shownPendingApprovalIds"];
      readingPositionAtSend: Parameters<PlanFollowUpSendInput["frameSubmittedMessage"]>[1];
      text: string;
      context?: ReturnType<typeof buildMessageContext>;
      interactionMode: "default" | "plan";
      selectedScientSkillNames: ReadonlyArray<string>;
      composerSnapshot?: string;
      sourceProposedPlan?: ScientThreadQueueItem["sourceProposedPlan"];
    }): Promise<string | null> => {
      if (!activeThread || !isServerThread || isSendBusy) {
        return null;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return null;
      }

      const draftAtSend = useComposerDraftStore
        .getState()
        .getComposerDraft(input.composerDraftTarget);
      const assertCurrentDraft = () => {
        if (
          input.currentRouteThreadKeyRef.current !== routeThreadKey ||
          !composerSubmissionMatchesDraft(
            draftAtSend,
            useComposerDraftStore.getState().getComposerDraft(input.composerDraftTarget),
          )
        )
          throw new Error("Your draft changed or you left this thread. Send again when ready.");
      };
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
      let submittedMessageId: MessageId | null = null;
      // The parent owns the admission lock until it has processed this receipt.
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
        assertCurrentDraft();
        beginLocalDispatch({ preparingWorktree: false });
        setThreadError(threadIdForSend, null);

        if (!previewQueueAdmission) frameSubmittedMessage(messageIdForSend, readingPositionAtSend);

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
            ...(previewQueueAdmission
              ? { queueAdmission: { threadKey: routeThreadKey, accepted: false } }
              : {}),
          },
        ]);

        assertCurrentDraft();
        const settingsResult = await persistThreadSettingsForNextTurn({
          assertCurrent: assertCurrentDraft,
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
          assertCurrentDraft();
          const branchResult = await updateThreadMetadata({
            environmentId,
            input: { threadId: threadIdForSend, branch: localCheckoutBranchMismatch.currentBranch },
          });
          if (branchResult._tag === "Failure") failure = branchResult;
        }

        if (failure === null) {
          assertCurrentDraft();
          const startResult = await startThreadTurn({
            environmentId,
            input: {
              commandId: CommandId.make(`composer-submission:${submissionId}`),
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
          }
        }

        if (failure === null) {
          setOptimisticUserMessages((existing) =>
            settleQueueAdmissionPreview(existing, messageIdForSend, queued),
          );
          if (queued) {
            resetLocalDispatch();
          } else {
            if (previewQueueAdmission && input.currentRouteThreadKeyRef.current === routeThreadKey)
              frameSubmittedMessage(messageIdForSend, readingPositionAtSend);
            clearUsageLimitsFor(routeThreadKey);
            acknowledgeActiveThreadWoke();
          }
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
        resetLocalDispatch();
        return null;
      });
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

  return onSubmitPlanFollowUp;
}

interface ImplementPlanInNewThreadInput extends PlanSendBase {
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly activeProject: EnvironmentProject | null;
  readonly activeEnvironmentUnavailable: boolean;
  readonly defaultRuntimeMode: RuntimeMode;
}
export function useImplementPlanInNewThread(input: ImplementPlanInNewThreadInput) {
  const {
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
  } = input;
  const navigate = useNavigate();
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const { sendInFlight: sendInFlightRef, uncertainSubmissions } = draftSendState(routeThreadKey);

  return async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable || !sendCtx.interactionModeEnabled) {
      return;
    }

    const createdAt = new Date().toISOString();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: sendCtx.selectedProvider,
      model: sendCtx.selectedModel,
      models: sendCtx.selectedProviderModels,
      effort: sendCtx.selectedPromptEffort,
      text: buildPlanImplementationPrompt(planMarkdown),
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = sendCtx.selectedModelSelection;

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });

    const openThread = (threadId: EnvironmentThreadShell["id"]) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
      });
    };
    const attempt = await settlePromise(async () => {
      const started: { threadId?: EnvironmentThreadShell["id"] } = {};
      const accepted = await startFanoutThread({
        retryKey: JSON.stringify({
          sourceThreadId: activeThread.id,
          planId: activeProposedPlan.id,
          prompt: outgoingImplementationPrompt,
          modelSelection: nextThreadModelSelection,
          runtimeMode: defaultRuntimeMode,
        }),
        model: nextThreadModelSelection.model,
        uncertainSubmissions: uncertainSubmissions.current,
        openThread,
        start: (threadId) => {
          started.threadId = threadId;
          return startThreadTurn({
            environmentId,
            input: {
              threadId,
              message: {
                messageId: newMessageId(),
                role: "user",
                text: outgoingImplementationPrompt,
                attachments: [],
              },
              modelSelection: nextThreadModelSelection,
              titleSeed: nextThreadTitle,
              runtimeMode: defaultRuntimeMode,
              interactionMode: "default",
              // Implementing a plan does not select skills mentioned by the assistant.
              selectedScientSkillNames: [],
              sourceProposedPlan: { threadId: activeThread.id, planId: activeProposedPlan.id },
              bootstrap: {
                createThread: {
                  projectId: activeProject.id,
                  title: nextThreadTitle,
                  modelSelection: nextThreadModelSelection,
                  runtimeMode: defaultRuntimeMode,
                  interactionMode: "default",
                  branch: activeThreadBranch,
                  worktreePath: activeThread.worktreePath,
                  createdAt,
                },
              },
              createdAt,
            },
          });
        },
      });
      if (!accepted || !started.threadId) return;
      const threadId = started.threadId;
      if (input.currentRouteThreadKeyRef.current !== routeThreadKey) return;
      await waitForStartedServerThread(scopeThreadRef(environmentId, threadId));
      if (input.currentRouteThreadKeyRef.current !== routeThreadKey) return;
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
      });
    });
    sendInFlightRef.current = false;
    resetLocalDispatch();
    if (attempt._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open implementation thread",
          description: chatActionErrorMessage(squashAtomCommandFailure(attempt)),
        }),
      );
    }
  };
}
