/**
 * Whether the timeline shows the thread working. A send turns busy before its
 * prompt is in the list, so a working row shown then would sit above the
 * prompt and jump below it once the prompt arrives. While the send alone makes
 * the thread busy, the row waits for the prompt: the optimistic row, or a
 * newer server user message than the one the dispatch started from.
 *
 * Nothing is bridged after the send: V2's local dispatch stays busy until the
 * server reports the send's run running (or failed, or settled), so the row
 * does not drop out while that run is queued, preparing or starting.
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
}): boolean {
  if (!input.isWorking) return false;
  if (!input.onlySendBusy) return true;
  return (
    input.optimisticPromptShown || input.latestUserMessageId !== input.dispatchBaselineUserMessageId
  );
}
