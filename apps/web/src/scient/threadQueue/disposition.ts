/**
 * Queue-vs-steer decision for one composer submission. Pure and Scient-owned
 * so the ChatView seam stays a single marked branch. See
 * `docs/internals/scient-thread-queue.md`.
 *
 * - "queue": the thread is busy and the user pressed Enter without the steer
 *   modifier. The message waits in the thread queue until the active turn
 *   settles, then the queue pump sends it in order.
 * - "send": dispatch now through the ordinary `thread.turn.start` path. When
 *   the thread is idle this is the unchanged upstream behavior; when busy it
 *   is a steer, which the provider adapters already support.
 */
export type ComposerSendDisposition = "send" | "queue";

export function resolveComposerSendDisposition(input: {
  readonly threadBusy: boolean;
  readonly steerRequested: boolean;
  readonly hasQueuedItems?: boolean;
  readonly awaitingCompletion?: boolean;
  readonly editingQueuedItem?: boolean;
}): ComposerSendDisposition {
  if (input.editingQueuedItem) return "queue";
  const mustQueue = input.threadBusy || (input.hasQueuedItems && !input.awaitingCompletion);
  return input.steerRequested || !mustQueue ? "send" : "queue";
}

/** True when the keyboard event asks for an immediate steer (Cmd/Ctrl+Enter). */
export function isSteerShortcut(event: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
}): boolean {
  return (event.metaKey || event.ctrlKey) && !event.shiftKey;
}

/** A queue pump may only advance after the previous turn has fully settled. */
export function shouldDispatchNextQueuedMessage(input: {
  readonly threadReady: boolean;
  readonly hasQueuedItem: boolean;
  readonly dispatchBlocked: boolean;
}): boolean {
  return input.threadReady && input.hasQueuedItem && !input.dispatchBlocked;
}
