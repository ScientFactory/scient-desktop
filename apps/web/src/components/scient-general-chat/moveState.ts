import type { OrchestrationSessionStatus, ProjectId } from "@t3tools/contracts";

export type ScientGeneralChatPendingMove = {
  readonly projectId: ProjectId;
  readonly phase: "stopping" | "moving" | "awaiting-projection";
};

export function resolveScientGeneralChatMoveProgress(input: {
  readonly pendingMove: ScientGeneralChatPendingMove | null;
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly currentProjectId: ProjectId | null;
}): "submit-move" | "complete" | null {
  if (input.pendingMove?.phase === "stopping" && input.sessionStatus === "stopped") {
    return "submit-move";
  }
  if (
    input.pendingMove?.phase === "awaiting-projection" &&
    input.currentProjectId === input.pendingMove.projectId
  ) {
    return "complete";
  }
  return null;
}
