import type { WorktreeSetupSnapshot } from "@t3tools/contracts";

import type { MessagesTimelineRow } from "../../components/chat/MessagesTimeline.logic";

/**
 * Scient setup scripts may keep running after the agent starts. Once the turn
 * has taken over, a script still running (or one that failed) keeps its card.
 */
export function hasPostHandoffSetupScript(
  worktreeSetup: WorktreeSetupSnapshot | null | undefined,
  setupHandedOff: boolean,
): boolean {
  const setupScriptStage = worktreeSetup?.stages.find((stage) => stage.id === "setup-script");
  return (
    setupHandedOff &&
    (setupScriptStage?.status === "running" || setupScriptStage?.status === "failed")
  );
}

/**
 * Preserve that durable status card under the working header, while the rows
 * keep upstream's stable pre-handoff layout.
 */
export function insertPostHandoffSetupRow(
  rows: MessagesTimelineRow[],
  worktreeSetup: WorktreeSetupSnapshot,
  rowId: string,
): void {
  const setupRow = {
    kind: "worktree-setup",
    id: rowId,
    createdAt: worktreeSetup.startedAt,
    snapshot: worktreeSetup,
    embedded: true,
  } as const;
  const workingRowIndex = rows.findIndex((row) => row.kind === "working");
  if (workingRowIndex >= 0) {
    rows.splice(workingRowIndex + 1, 0, setupRow);
  } else {
    rows.push(setupRow);
  }
}
