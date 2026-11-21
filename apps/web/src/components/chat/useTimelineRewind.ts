import { msg } from "gt-react";
import { m } from "~/i18n/messages";
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
import { openRevertConfirm, settleRevertConfirm } from "./ChatOverlayHosts";
import { assetEnvironment } from "../../state/assets";
import { readEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { rewindToMessage } from "./chatViewSend";
import { makeThreadErrorSetter } from "../ChatView.logic";
// SCIENT-FORK:START
import { editFromHereSkipsDialog, sendIfStillDirect } from "../../scient/chat/editFromHereRewind";
// SCIENT-FORK:END
interface TimelineRewindInput {
  readonly hasProjectWorkspace: boolean;
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
  const { hasProjectWorkspace } = input;
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  const revertThreadCheckpoint = useOrchestrationCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  // SCIENT-FORK:START — reads the thread as last rendered, so a rewind decides again after waiting.
  const editFromHereSkipsDialogNow = useStableCallback((turnCount: number) =>
    editFromHereSkipsDialog({
      projection: serverProjection,
      worktreePath: activeThread?.worktreePath ?? null,
      turnCount,
    }),
  );
  // SCIENT-FORK:END

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
      openRevertConfirm(routeThreadKey, {
        turnCount,
        messageId,
        error: m(
          msg(
            "This provider does not support reverting conversation history. Start a new thread instead.",
          ),
        ),
      });
      return;
    }
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      openRevertConfirm(routeThreadKey, {
        turnCount,
        messageId,
        error: m(
          msg("Reconnect {environment} before rewinding.", {
            environment: activeEnvironmentUnavailableLabel,
          }),
        ),
      });
      return;
    }
    if (phase === "running" || isSendBusy) {
      openRevertConfirm(routeThreadKey, {
        turnCount,
        messageId,
        error: m(msg("Stop the current turn before rewinding.")),
      });
      return;
    }
    // SCIENT-FORK:START — when the dialog could only rewind the chat and no later turn changed
    // files, Edit from here rewinds as "Rewind chat" does. The dialog then opens only if the rewind
    // fails, or if by the time it is sent a later turn did change files.
    const direct = restoreFiles === undefined && editFromHereSkipsDialogNow(turnCount);
    const restore = direct ? false : restoreFiles;
    if (restore === undefined) {
      openRevertConfirm(routeThreadKey, { turnCount, messageId });
      return;
    }
    // A retry clears the last failure while the dialog stays open.
    if (!direct) openRevertConfirm(routeThreadKey, { turnCount, messageId });
    const decision = { changed: false };
    // SCIENT-FORK:END
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
      // SCIENT-FORK:START
      restoreFiles: restore,
      // SCIENT-FORK:END
      // Keep the live checkpoint identity when command context refetches a bounded window.
      checkpoint: findRevertCheckpoint(serverProjection, turnCount),
      draftTarget: composerDraftTarget,
      composerHasPendingAttachments: composerRef.current?.hasPendingAttachments() === true,
      createAssetUrl: createAttachmentAssetUrl,
      // SCIENT-FORK:START — a direct rewind decides again just before it is sent.
      revertThreadCheckpoint: direct
        ? sendIfStillDirect(
            revertThreadCheckpoint,
            () => editFromHereSkipsDialogNow(turnCount),
            () => {
              decision.changed = true;
            },
          )
        : revertThreadCheckpoint,
      // SCIENT-FORK:END
    });
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
    // SCIENT-FORK:START — the rewind dialog stays open on failure and shows why; success closes it.
    // A failure on a thread the user has left lands in that thread's banner, as in T3. A direct
    // rewind's failure opens the dialog to show it, as does a later turn's change found meanwhile.
    if (decision.changed) {
      openRevertConfirm(routeThreadKey, { turnCount, messageId });
    } else if (
      direct &&
      rewind.error !== null &&
      currentRouteThreadKeyRef.current === routeThreadKey
    ) {
      openRevertConfirm(routeThreadKey, { turnCount, messageId, error: rewind.error });
    } else if (!settleRevertConfirm(routeThreadKey, rewind.error) && rewind.error !== null) {
      setThreadError(activeThread.id, rewind.error);
    }
    if (rewind.error !== null) return;
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
  const onConfirmRevert = (turnCount: number, messageId: MessageId, restoreFiles: boolean) => {
    void onRevertToTurnCount(turnCount, messageId, restoreFiles);
  };
  const onConfirmRevertStable = useStableCallback(onConfirmRevert);
  const onRevertTimelineTurn = (targetTurnCount: number, messageId: MessageId) => {
    void onRevertToTurnCountStable(targetTurnCount, messageId);
  };
  const onRevertTimelineTurnStable = useStableCallback(onRevertTimelineTurn);
  return {
    onConfirmRevertStable,
    onRevertTimelineTurnStable,
  };
}
