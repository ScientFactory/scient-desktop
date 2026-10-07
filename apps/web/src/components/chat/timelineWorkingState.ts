import type { OrchestrationV2Run } from "@t3tools/contracts";
import { useMemo } from "react";
import type { ChatMessage } from "../../types";
import { promptRunStarting } from "./responseFollow";

/**
 * Whether the timeline shows the thread working. A send turns busy before its
 * prompt is in the list, so a working row shown then would sit above the
 * prompt and jump below it once the prompt arrives. While the send alone makes
 * the thread busy, the row waits for the prompt: the optimistic row, or a
 * newer server user message than the one the dispatch started from.
 *
 * Once the server has admitted the send, the send stops being busy while its
 * run may still be preparing or starting (V2 reports that as connecting, which
 * is not working). The row stays on through that, so it does not drop out
 * and come back when the run starts.
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

/** ChatView's working state for the timeline (see `resolveTimelineWorking`). */
export function useTimelineWorking(input: {
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
  const latest = useMemo(() => {
    const messages = projection?.messages ?? [];
    const promptId = messages.findLast((message) => message.role === "user")?.id ?? null;
    return {
      promptId,
      starting: promptRunStarting({ promptId, runs: projection?.runs ?? [], messages }),
    };
  }, [projection]);
  return resolveTimelineWorking({
    isWorking: threadWorking,
    onlySendBusy,
    dispatchBaselineUserMessageId,
    latestUserMessageId: latest.promptId,
    optimisticPromptShown,
    promptRunStarting: latest.starting,
  });
}
