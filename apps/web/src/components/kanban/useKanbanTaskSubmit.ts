// FILE: useKanbanTaskSubmit.ts
// Purpose: Owns the kanban new-task dialog's draft/create/send lifecycle.
// Layer: Kanban UI hook
// Exports: useKanbanTaskSubmit

import type {
  AssistantDeliveryMode,
  ModelSlug,
  ProjectId,
  ProviderInteractionMode,
  ProviderKind,
  ProviderStartOptions,
  RuntimeMode,
  ServerProviderStatus,
  ThreadId,
} from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";

import type { DraftThreadEnvMode } from "~/composerDraftStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { createAndSendKanbanTask, createKanbanDraftTask } from "~/lib/kanbanTaskCreate";
import { resolveProviderSendAvailabilityWithRefresh } from "~/lib/providerAvailability";
import { buildModelSelection } from "~/providerModelOptions";
import type { KanbanFeedback } from "./KanbanInlineFeedback";

interface UseKanbanTaskSubmitInput {
  readonly selectedProjectId: ProjectId | null;
  readonly hasSendableContent: boolean;
  readonly selectedProvider: ProviderKind;
  readonly selectedModel: ModelSlug | null;
  readonly trimmedPrompt: string;
  readonly scratchThreadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly envMode: DraftThreadEnvMode;
  readonly sendAsDraft: boolean;
  readonly defaultProvider: ProviderKind;
  readonly assistantDeliveryMode: AssistantDeliveryMode;
  readonly providerOptionsForDispatch: ProviderStartOptions | undefined;
  readonly providerStatuses: readonly ServerProviderStatus[];
  readonly onOpenChange: (open: boolean) => void;
}

export function useKanbanTaskSubmit(input: UseKanbanTaskSubmitInput) {
  const {
    selectedProjectId,
    hasSendableContent,
    selectedProvider,
    selectedModel,
    trimmedPrompt,
    scratchThreadId,
    runtimeMode,
    interactionMode,
    envMode,
    sendAsDraft,
    defaultProvider,
    assistantDeliveryMode,
    providerOptionsForDispatch,
    providerStatuses,
    onOpenChange,
  } = input;
  const navigate = useNavigate();
  const [isCreating, setIsCreating] = useState(false);
  const [feedback, setFeedback] = useState<KanbanFeedback | null>(null);
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  // Synchronous re-entry guard: repeated Cmd+Enter can fire before React flushes
  // the loading state, and two passes here would create two tasks.
  const isCreatingRef = useRef(false);
  const clearFeedback = useCallback(() => setFeedback(null), []);

  const canCreate =
    selectedProjectId !== null && hasSendableContent && selectedModel !== null && !isCreating;

  const handleCreate = useCallback(async () => {
    if (
      !selectedProjectId ||
      !hasSendableContent ||
      selectedModel === null ||
      isCreating ||
      isCreatingRef.current
    ) {
      return;
    }

    isCreatingRef.current = true;
    setFeedback(null);
    // The scratch draft carries the full selection (model + reasoning effort +
    // speed) set through the picker; fall back to a bare selection otherwise.
    const scratchState = useComposerDraftStore.getState().draftsByThreadId[scratchThreadId];
    const modelSelection =
      scratchState?.modelSelectionByProvider[selectedProvider] ??
      buildModelSelection(selectedProvider, selectedModel);
    const taskInput = {
      projectId: selectedProjectId,
      prompt: trimmedPrompt,
      sourceComposerThreadId: scratchThreadId,
      modelSelection,
      runtimeMode,
      interactionMode,
      envMode,
    };

    try {
      if (sendAsDraft) {
        createKanbanDraftTask(taskInput);
        onOpenChange(false);
        return;
      }

      // Send now: create + promote + dispatch straight to In Progress.
      const sendAvailability = await resolveProviderSendAvailabilityWithRefresh({
        provider: modelSelection.provider,
        statuses: providerStatuses,
        refreshStatuses: () => refreshProviderStatuses({ silent: true }),
      });
      if (!sendAvailability.usable) {
        setFeedback({
          tone: "error",
          title: sendAvailability.unavailableReason,
          description: "Reconnect the provider, then create the task again.",
        });
        return;
      }

      setIsCreating(true);
      const { threadId, result } = await createAndSendKanbanTask({
        ...taskInput,
        defaultProvider,
        assistantDeliveryMode,
        providerOptions: providerOptionsForDispatch,
      });
      if (result.kind === "dispatched") {
        onOpenChange(false);
        return;
      }
      if (result.kind === "open-thread") {
        onOpenChange(false);
        void navigate({ to: "/$threadId", params: { threadId } });
        return;
      }
      // Promotion/dispatch could not complete faithfully; the draft still
      // exists on the board, so surface the failure and keep the dialog open.
      setFeedback({
        tone: "error",
        title: "Couldn't start the task",
        description:
          result.kind === "error"
            ? result.message
            : "The task was saved to Drafts instead. Open it to send manually.",
      });
    } catch (error: unknown) {
      setFeedback({
        tone: "error",
        title: "Couldn't start the task",
        description: error instanceof Error ? error.message : "Unexpected error.",
      });
    } finally {
      isCreatingRef.current = false;
      setIsCreating(false);
    }
  }, [
    assistantDeliveryMode,
    defaultProvider,
    envMode,
    hasSendableContent,
    interactionMode,
    isCreating,
    navigate,
    onOpenChange,
    providerOptionsForDispatch,
    providerStatuses,
    refreshProviderStatuses,
    runtimeMode,
    scratchThreadId,
    selectedModel,
    selectedProjectId,
    selectedProvider,
    sendAsDraft,
    trimmedPrompt,
  ]);

  return {
    isCreating,
    canCreate,
    handleCreate,
    feedback,
    clearFeedback,
  };
}
