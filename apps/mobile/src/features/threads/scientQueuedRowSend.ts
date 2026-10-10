/**
 * SCIENT-OWNED rule for Send on a mobile queue row, matching the web strip.
 * Kept free of React Native imports so it runs in unit tests.
 */
import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";
import { canSendQueuedRun, isQueueUsageLimitProven } from "@t3tools/shared/scientQueuedRunSend";

/** Whether a queued row offers Send, for a held queue on an idle thread. */
export function canSendScientQueuedRow(input: {
  readonly projection: OrchestrationV2ThreadProjection | null | undefined;
  readonly isHeld: boolean;
  readonly shellLastErrorClass: string | null | undefined;
  readonly runId: RunId;
  readonly busy: boolean;
  readonly isEditing: boolean;
}): boolean {
  if (!input.isHeld || input.busy || input.isEditing || input.projection == null) return false;
  return canSendQueuedRun(input.projection, input.runId, {
    usageLimited: isQueueUsageLimitProven(input.projection, input.shellLastErrorClass),
  });
}
