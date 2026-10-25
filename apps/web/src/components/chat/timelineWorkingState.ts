import type { OrchestrationV2Run } from "@t3tools/contracts";

import type { ChatMessage, SessionPhase } from "../../types";
import { promptRunStarting } from "./responseFollow";

/**
 * Wait for the optimistic/new server prompt before showing send-only busy state, or the working row
 * jumps across it. After admission keep it through V2 connecting/preparing until the run starts,
 * avoiding a busy-row flicker.
 */
export function resolveTimelineWorking(input: {
  isWorking: boolean;
  /** Busy only because a send is being dispatched: no run, setup or other cause. */
  onlySendBusy: boolean;
  /** The thread's latest user message id when the dispatch began. */
  dispatchBaselineUserMessageId: string | null;
  /** The thread's latest user message id now. */
  latestUserMessageId: string | null;
  /** A prompt sent from this window is shown before the server has it. */
  optimisticPromptShown: boolean;
  /** The latest prompt's own V2 run is preparing or starting. */
  promptRunStarting: boolean;
}): boolean {
  if (input.promptRunStarting) return true;
  if (!input.isWorking) return false;
  if (!input.onlySendBusy) return true;
  return (
    input.optimisticPromptShown || input.latestUserMessageId !== input.dispatchBaselineUserMessageId
  );
}

/**
 * ChatView is busy only because a send is being dispatched: no run, connection,
 * compaction, bootstrap turn, fork, checkpoint revert or worktree preparation.
 */
export function isOnlySendBusy(state: {
  isSendBusy: boolean;
  phase: SessionPhase;
  isConnecting: boolean;
  isCompacting: boolean;
  awaitingBootstrapTurn: boolean;
  isForkingThread: boolean;
  isRevertingCheckpoint: boolean;
  isPreparingWorktree: boolean;
}): boolean {
  return (
    state.isSendBusy &&
    state.phase !== "running" &&
    !state.isConnecting &&
    !state.isCompacting &&
    !state.awaitingBootstrapTurn &&
    !state.isForkingThread &&
    !state.isRevertingCheckpoint &&
    !state.isPreparingWorktree
  );
}

/** ChatView's working state for the timeline (see `resolveTimelineWorking`). */
export function deriveTimelineWorking(input: {
  /** The thread is working by ChatView's own rule. */
  threadWorking: boolean;
  /** Busy only because a send is being dispatched: no run, setup or other cause. */
  onlySendBusy: boolean;
  /** The thread's latest user message id when the active dispatch began. */
  dispatchBaselineUserMessageId: string | null;
  /** The thread's V2 projection, once loaded. */
  projection: {
    readonly messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "runId">>;
    readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "userMessageId" | "status">>;
  } | null;
  optimisticMessages: ReadonlyArray<{ readonly queueAdmission?: unknown }>;
}): boolean {
  const { threadWorking, onlySendBusy, dispatchBaselineUserMessageId, projection } = input;
  const optimisticPromptShown = input.optimisticMessages.some((message) => !message.queueAdmission);
  const latest = (() => {
    const messages = projection?.messages ?? [];
    const promptId = messages.findLast((message) => message.role === "user")?.id ?? null;
    return {
      promptId,
      starting: promptRunStarting({ promptId, runs: projection?.runs ?? [], messages }),
    };
  })();
  return resolveTimelineWorking({
    isWorking: threadWorking,
    onlySendBusy,
    dispatchBaselineUserMessageId,
    latestUserMessageId: latest.promptId,
    optimisticPromptShown,
    promptRunStarting: latest.starting,
  });
}
