import type { ScientThreadQueueItem } from "@t3tools/contracts";

import type { QueuedRunsControlHandle } from "~/components/chat/QueuedRunsControl";

/**
 * Steer Queued Message: the native queue head first, otherwise the Scient
 * strip's first message. A repeat is consumed without acting again. Returns
 * false when there is nothing to steer, so the key keeps its native meaning.
 */
export function steerQueuedMessageShortcut(input: {
  readonly repeat: boolean;
  readonly nativeQueue: QueuedRunsControlHandle | null;
  readonly stripHead: ScientThreadQueueItem | undefined;
  readonly steerStripItem: (item: ScientThreadQueueItem) => void;
}): boolean {
  if (input.nativeQueue?.steerNext(input.repeat) === true) return true;
  if (!input.stripHead) return false;
  if (!input.repeat) input.steerStripItem(input.stripHead);
  return true;
}

/**
 * Edit Queued Message: the latest native queued message, wherever the caret
 * is. Returns false when nothing can be edited (no queue, or an edit is open).
 */
export function editQueuedMessageShortcut(input: {
  readonly repeat: boolean;
  readonly nativeQueue: QueuedRunsControlHandle | null;
}): boolean {
  return input.nativeQueue?.editLatest(input.repeat) === true;
}
