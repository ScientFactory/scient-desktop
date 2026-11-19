import type { OrchestrationV2Checkpoint } from "../orchestrationV2.ts";

/**
 * A rewind targets a turn boundary that has not been rolled back past. Restoring
 * files also needs its captured snapshot, which oversized or non-Git workspaces lack.
 */
export function checkpointSupportsRewind(
  checkpoint: Pick<OrchestrationV2Checkpoint, "status">,
  restoreFiles: boolean,
): boolean {
  return restoreFiles ? checkpoint.status === "ready" : checkpoint.status !== "stale";
}
