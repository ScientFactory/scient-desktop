import type { Dispatch, SetStateAction } from "react";
import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { SessionPhase } from "../../types";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { readLocalApi } from "../../localApi";
import { findRevertCheckpoint } from "../../session-logic";
import { type ChatMessage } from "../../types";
import { useComposerDraftStore } from "../../composerDraftStore";
import { threadEnvironment } from "../../state/threads";
import { assetEnvironment } from "../../state/assets";
import { readEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { rewindToMessage } from "./chatViewSend";
import { makeThreadErrorSetter } from "../ChatView.logic";
interface TimelineRewindInput {
  readonly hasProjectWorkspace: boolean;
  readonly setPendingRevert: Dispatch<
    SetStateAction<{
      turnCount: number;
      messageId: MessageId;
      routeThreadKey: string;
      error?: string;
    } | null>
  >;
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly serverProjection: ThreadStructure | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly phase: SessionPhase;
  readonly isSendBusy: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly supportsConversationRollback: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableLabel: string | null;
  readonly promptRef: { current: string };
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

/**
 * Going back in a thread's timeline: reverting to an earlier turn (restoring that message into
 * the composer).
 */
export function useTimelineRewind(input: TimelineRewindInput) {
  const {
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
  } = input;
  const { setPendingRevert, hasProjectWorkspace } = input;
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  const revertThreadCheckpoint = useOrchestrationCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });

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
    if (phase === "running" || isSendBusy) {
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
      isCurrentRoute: () => currentRouteThreadKeyRef.current === routeThreadKey,
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
  const onRevertTimelineTurn = (targetTurnCount: number, messageId: MessageId) => {
    void onRevertToTurnCountStable(targetTurnCount, messageId);
  };
  const onRevertTimelineTurnStable = useStableCallback(onRevertTimelineTurn);
  return {
    onRevertToTurnCountStable,
    onRevertTimelineTurnStable,
  };
}
