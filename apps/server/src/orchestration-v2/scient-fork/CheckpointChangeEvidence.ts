/**
 * Whether a run checkpoint's `files` are known to list every change the run made. Edit from here
 * rewinds without asking only on this evidence; a diff that failed or had nothing to compare with
 * also leaves `files` empty.
 */
import type { OrchestrationV2Checkpoint } from "@t3tools/contracts";

export function withChangesKnown(
  checkpoint: OrchestrationV2Checkpoint,
  compared: boolean,
): OrchestrationV2Checkpoint {
  return compared && checkpoint.status === "ready"
    ? { ...checkpoint, changesKnown: true }
    : checkpoint;
}

/**
 * For a thread folder whose run reached tracked repositories, or whose repositories could not be
 * listed: they are compared apart, and not always, so the folder's own list may not be all.
 */
export function withoutChangesKnown(
  checkpoint: OrchestrationV2Checkpoint,
): OrchestrationV2Checkpoint {
  const { changesKnown: _changesKnown, ...rest } = checkpoint;
  return rest;
}
