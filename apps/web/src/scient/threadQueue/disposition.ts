/**
 * Queue-vs-steer decision for one composer submission. Pure and Scient-owned
 * so the ChatView seam stays a single marked branch. See
 * `docs/internals/scient-thread-queue.md`.
 *
 * - "queue": the thread is busy, or messages are already waiting, and the user
 *   pressed Enter without the steer modifier. The message joins the thread
 *   queue; the server owns ordering and delivery from there.
 * - "send": dispatch now through the ordinary `thread.turn.start` path. When
 *   the thread is idle this is the unchanged upstream behavior; when busy it
 *   is a steer, which the provider adapters already support.
 */
export type ComposerSendDisposition = "send" | "queue";

/**
 * Resolves T3's configurable running-turn shortcut into Scient's explicit
 * server-side steer flag. `alternateRequested` means "the opposite of the
 * configured follow-up behavior"; it never creates a second client queue.
 */
export function resolveComposerSteerRequested(input: {
  readonly threadBusy: boolean;
  readonly followUpBehavior: "queue" | "steer";
  readonly alternateRequested: boolean;
}): boolean {
  if (!input.threadBusy) return false;
  return (input.followUpBehavior === "steer") !== input.alternateRequested;
}

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
