import type {
  EnvironmentId,
  MessageId,
  OrchestrationV2ProjectedTurnItem,
  RunId,
  ScopedThreadRef,
  ServerConfig,
  ThreadId,
} from "@t3tools/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import {
  ScientForkDialog,
  type ForkWorktreeAvailability,
  type ScientForkSource,
} from "~/components/chat/scient-fork/ScientForkWorkspaceModeDialog";
import { resolveForkTargetAfterAttempt } from "~/components/ChatView.logic";
import { useScientThreadFork, type ForkSource } from "~/components/scient-fork/useScientThreadFork";
import type { TimelineLatestRun } from "~/components/chat/MessagesTimeline.logic";
import type { TimelineEntry } from "~/session-logic";
import type { ChatMessage, Thread, TurnDiffSummary } from "~/types";

import {
  findLatestCompletedAssistantMessageId,
  findPrecedingCompletedAssistantMessageId,
} from "./forkCheckpointMessages";

/** What the fork dialog was opened for, on the thread it was opened from. */
export type ForkCommandTarget =
  | {
      readonly threadId: ThreadId;
      readonly environmentId: EnvironmentId;
      readonly kind: "assistant-response";
      readonly messageId: MessageId | null;
      readonly source: ScientForkSource;
    }
  | {
      readonly threadId: ThreadId;
      readonly environmentId: EnvironmentId;
      readonly kind: "user-message";
      readonly messageId: MessageId;
      readonly message: ChatMessage;
      readonly source: ScientForkSource;
    }
  // SCIENT-FORK: the running turn with the work it has done so far.
  | {
      readonly threadId: ThreadId;
      readonly environmentId: EnvironmentId;
      readonly kind: "running-turn";
      readonly runId: RunId;
      readonly source: ScientForkSource;
    };

type SetForkCommandTarget = Dispatch<SetStateAction<ForkCommandTarget | null>>;

/** The fork dialog's target, preview and command for the chat's active thread. */
export function useChatViewForkCommand(input: {
  readonly activeThread: Thread | null | undefined;
  readonly navigate: Parameters<typeof useScientThreadFork>[0]["navigate"];
  readonly serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
}) {
  const { activeThread, navigate, serverConfigs } = input;
  const forkRecoverySupported =
    activeThread != null &&
    serverConfigs.get(activeThread.environmentId)?.environment.capabilities.threadForkRecovery ===
      true;
  const {
    errorUpdate: forkErrorUpdate,
    isForking: isForkingThread,
    forkFromMessage,
    prepareFork,
    preview: forkPreview,
  } = useScientThreadFork({
    origin: activeThread ?? null,
    navigate,
    supportsRecovery: forkRecoverySupported,
  });
  const [forkCommandTarget, setForkCommandTarget] = useState<ForkCommandTarget | null>(null);
  const forkDialogOpen =
    forkCommandTarget !== null &&
    activeThread !== null &&
    activeThread !== undefined &&
    forkCommandTarget.threadId === activeThread.id &&
    forkCommandTarget.environmentId === activeThread.environmentId;
  const forkSource = useMemo(
    (): ForkSource | null =>
      forkCommandTarget === null
        ? null
        : forkCommandTarget.kind === "running-turn"
          ? { kind: "running-turn", runId: forkCommandTarget.runId }
          : forkCommandTarget.kind === "assistant-response"
            ? {
                kind: forkCommandTarget.kind,
                messageId: forkCommandTarget.messageId,
                latest:
                  forkCommandTarget.source === "latest-response" ||
                  forkCommandTarget.source === "new-chat",
              }
            : {
                kind: forkCommandTarget.kind,
                messageId: forkCommandTarget.messageId,
                prompt: forkCommandTarget.message.text,
                attachments: forkCommandTarget.message.attachments ?? [],
              },
    [forkCommandTarget],
  );
  useEffect(() => {
    if (forkDialogOpen && forkSource) void prepareFork(forkSource);
  }, [forkDialogOpen, forkSource, prepareFork]);
  const forkTitleOverrideSupported =
    activeThread !== null &&
    activeThread !== undefined &&
    serverConfigs.get(activeThread.environmentId)?.environment.capabilities
      .threadForkTitleOverride === true;
  return {
    forkRecoverySupported,
    forkErrorUpdate,
    isForkingThread,
    forkFromMessage,
    forkPreview,
    forkCommandTarget,
    setForkCommandTarget,
    forkDialogOpen,
    forkSource,
    forkTitleOverrideSupported,
  };
}

export type ChatViewForkCommand = ReturnType<typeof useChatViewForkCommand>;

/** A fork target belongs to the thread it was opened on; switching threads drops it. */
export function useClearForkCommandOnThreadChange(
  setForkCommandTarget: SetForkCommandTarget,
  activeThreadId: ThreadId | null,
  activeThreadEnvironmentId: EnvironmentId | null,
): void {
  useEffect(() => {
    setForkCommandTarget((current) =>
      current &&
      (current.threadId !== activeThreadId || current.environmentId !== activeThreadEnvironmentId)
        ? null
        : current,
    );
  }, [activeThreadId, activeThreadEnvironmentId, setForkCommandTarget]);
}

/** The composer's fork command: the running turn while it works, else the latest answer. */
export function useForkConversationCommand(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly activeLatestRun: TimelineLatestRun | null;
  readonly activeRunningTurnId: RunId | null;
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadEnvironmentId: EnvironmentId | null;
  readonly setForkCommandTarget: SetForkCommandTarget;
}) {
  const {
    timelineEntries,
    activeLatestRun,
    activeRunningTurnId,
    activeThreadId,
    activeThreadEnvironmentId,
    setForkCommandTarget,
  } = input;
  const latestCompletedAssistantMessageId = useMemo(
    () =>
      findLatestCompletedAssistantMessageId({
        timelineEntries,
        latestRun: activeLatestRun,
        runningRunId: activeRunningTurnId,
      }),
    [activeLatestRun, activeRunningTurnId, timelineEntries],
  );
  return useCallback(
    (options?: { readonly preserveComposerDraft?: boolean }) => {
      if (!activeThreadId || !activeThreadEnvironmentId) return;
      // While the agent works, a fork carries its work in progress.
      if (activeRunningTurnId !== null && !options?.preserveComposerDraft) {
        setForkCommandTarget({
          threadId: activeThreadId,
          environmentId: activeThreadEnvironmentId,
          kind: "running-turn",
          runId: activeRunningTurnId,
          source: "running-turn",
        });
        return;
      }
      setForkCommandTarget({
        threadId: activeThreadId,
        environmentId: activeThreadEnvironmentId,
        kind: "assistant-response",
        messageId: latestCompletedAssistantMessageId,
        source: options?.preserveComposerDraft ? "new-chat" : "latest-response",
      });
    },
    [
      activeThreadId,
      activeThreadEnvironmentId,
      activeRunningTurnId,
      latestCompletedAssistantMessageId,
      setForkCommandTarget,
    ],
  );
}

/** A fork's inherited baseline and whether the open fork target can start a new worktree. */
export function useForkTimelineBaseline(input: {
  readonly turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  readonly activeThread: Thread | null | undefined;
  readonly serverVisibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly isGitRepo: boolean;
  readonly forkDialogOpen: boolean;
  readonly forkCommandTarget: ForkCommandTarget | null;
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
}) {
  const {
    turnDiffSummaries,
    activeThread,
    serverVisibleTurnItems,
    isGitRepo,
    forkDialogOpen,
    forkCommandTarget,
    timelineEntries,
  } = input;
  const forkCheckpointByAssistantMessageId = useMemo(
    () =>
      new Map(
        turnDiffSummaries.flatMap((checkpoint) =>
          checkpoint.assistantMessageId
            ? [[checkpoint.assistantMessageId, checkpoint] as const]
            : [],
        ),
      ),
    [turnDiffSummaries],
  );
  const hasForkBaseline = activeThread?.lineage.relationshipToParent === "fork";
  const forkOriginThreadId =
    activeThread?.source.forkLineage?.originThreadId ??
    (hasForkBaseline ? (activeThread?.lineage.parentThreadId ?? undefined) : undefined);
  const forkBaselineAssistantMessageId = useMemo(() => {
    const recorded = activeThread?.source.forkLineage?.baselineAssistantMessageId;
    if (recorded != null) return recorded;
    const inherited = serverVisibleTurnItems.findLast(
      (row) => row.visibility === "inherited" && row.item.type === "assistant_message",
    )?.item;
    return inherited?.type === "assistant_message" ? inherited.messageId : null;
  }, [activeThread?.source.forkLineage, serverVisibleTurnItems]);
  const forkWorktreeAvailability: ForkWorktreeAvailability = useMemo(() => {
    if (!isGitRepo) {
      return { available: false, reason: "no-git-repository" };
    }

    const target = forkDialogOpen ? forkCommandTarget : null;
    const checkpointAssistantMessageId =
      target?.kind === "assistant-response"
        ? target.messageId
        : target?.kind === "user-message"
          ? findPrecedingCompletedAssistantMessageId({
              timelineEntries,
              sourceUserMessageId: target.messageId,
            })
          : null;
    const checkpoint = checkpointAssistantMessageId
      ? forkCheckpointByAssistantMessageId.get(checkpointAssistantMessageId)
      : null;
    if (checkpoint?.status === "ready" && checkpoint.checkpointRef !== null) {
      return { available: true };
    }
    return { available: false, reason: "no-checkpoint" };
  }, [
    forkDialogOpen,
    forkCommandTarget,
    isGitRepo,
    timelineEntries,
    forkCheckpointByAssistantMessageId,
  ]);
  return {
    hasForkBaseline,
    forkOriginThreadId,
    forkBaselineAssistantMessageId,
    forkWorktreeAvailability,
  };
}

/** Timeline row actions that open the fork dialog for one response or prompt. */
export function useForkMessageCommands(input: {
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadEnvironmentId: EnvironmentId | null;
  readonly setForkCommandTarget: SetForkCommandTarget;
}) {
  const { activeThreadId, activeThreadEnvironmentId, setForkCommandTarget } = input;
  const onForkAssistantMessage = useCallback(
    (sourceAssistantMessageId: MessageId) => {
      if (!activeThreadId || !activeThreadEnvironmentId) return;
      setForkCommandTarget({
        threadId: activeThreadId,
        environmentId: activeThreadEnvironmentId,
        kind: "assistant-response",
        messageId: sourceAssistantMessageId,
        source: "this-response",
      });
    },
    [activeThreadId, activeThreadEnvironmentId, setForkCommandTarget],
  );
  const onForkUserMessage = useCallback(
    (message: ChatMessage) => {
      if (!activeThreadId || !activeThreadEnvironmentId) return;
      setForkCommandTarget({
        threadId: activeThreadId,
        environmentId: activeThreadEnvironmentId,
        kind: "user-message",
        messageId: message.id,
        message,
        source: "this-message",
      });
    },
    [activeThreadId, activeThreadEnvironmentId, setForkCommandTarget],
  );
  return { onForkAssistantMessage, onForkUserMessage };
}

/** The chat's fork dialog for the target the fork command opened. */
export function ScientChatForkDialog(input: {
  readonly fork: ChatViewForkCommand;
  readonly activeThread: Thread | null | undefined;
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadEnvironmentId: EnvironmentId | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeWorkspaceRoot: string | undefined;
  readonly forkWorktreeAvailability: ForkWorktreeAvailability;
}) {
  const {
    fork: {
      forkDialogOpen,
      isForkingThread,
      forkCommandTarget,
      forkTitleOverrideSupported,
      forkPreview,
      forkRecoverySupported,
      forkErrorUpdate,
      setForkCommandTarget,
      forkSource,
      forkFromMessage,
    },
    activeThread,
    activeThreadId,
    activeThreadEnvironmentId,
    activeThreadRef,
    activeWorkspaceRoot,
    forkWorktreeAvailability,
  } = input;
  return (
    <ScientForkDialog
      open={forkDialogOpen}
      origin={activeThread ?? null}
      disabled={isForkingThread}
      source={forkCommandTarget?.source ?? "latest-response"}
      titleOverrideSupported={forkTitleOverrideSupported}
      worktreeAvailability={
        forkPreview?.options && (forkRecoverySupported || forkPreview.locked)
          ? forkPreview.options.newWorktree
            ? { available: true }
            : {
                available: false,
                // A running-turn fork snapshots files, so only a missing
                // Git repository can rule a new worktree out.
                reason:
                  forkCommandTarget?.kind === "running-turn"
                    ? "no-git-repository"
                    : "no-checkpoint",
              }
          : forkWorktreeAvailability
      }
      checking={forkPreview?.checking ?? true}
      locked={forkPreview?.locked ?? false}
      retryTitle={forkPreview?.retryTitle}
      retryWorkspaceMode={forkPreview?.retryWorkspaceMode}
      error={
        forkErrorUpdate?.environmentId === activeThread?.environmentId &&
        forkErrorUpdate?.threadId === activeThread?.id &&
        forkErrorUpdate?.key === forkPreview?.key
          ? forkErrorUpdate?.message
          : forkPreview?.options?.reason
      }
      onOpenChange={(open) => {
        // Closing while the fork is being made dismisses the dialog only.
        if (!open) setForkCommandTarget(null);
      }}
      onConfirm={(confirmation, beforeNavigate, confirmSkippedImages) => {
        const target = forkCommandTarget;
        if (
          !target ||
          !forkSource ||
          target.threadId !== activeThreadId ||
          target.environmentId !== activeThreadEnvironmentId
        )
          return;
        return forkFromMessage(
          forkSource,
          {
            ...confirmation,
            beforeNavigate,
            confirmSkippedImages,
            ...(target.kind === "assistant-response" &&
            target.source === "new-chat" &&
            activeThreadRef
              ? { composerDraftSource: activeThreadRef }
              : {}),
          },
          activeWorkspaceRoot,
        ).then((outcome) => {
          setForkCommandTarget((current) =>
            resolveForkTargetAfterAttempt(current, target, outcome),
          );
          return outcome;
        });
      }}
    />
  );
}
