import {
  GENERAL_CHAT_MOVE_SESSION_STOP_PENDING,
  type OrchestrationProject,
  type OrchestrationThread,
  type ProjectId,
} from "@t3tools/contracts";

export function normalizeScientThreadCreateTarget(input: {
  readonly projectId: ProjectId | null;
  readonly environmentWorkspaceRoot: string;
}) {
  return input.projectId === null
    ? {
        workspaceRoot: input.environmentWorkspaceRoot,
        branch: null,
        worktreePath: null,
      }
    : { workspaceRoot: null };
}

export type ScientGeneralChatMoveRejection =
  | { readonly code: "destination-deleted"; readonly detail: string }
  | { readonly code: "already-project-owned"; readonly detail: string }
  | { readonly code: "provider-active"; readonly detail: string }
  | { readonly code: "work-in-flight"; readonly detail: string };

/** Pure product invariant used by the generic orchestration decider. */
export function validateScientGeneralChatMove(input: {
  readonly thread: Pick<OrchestrationThread, "id" | "projectId" | "session" | "latestTurn">;
  readonly target: Pick<OrchestrationProject, "id" | "deletedAt">;
  readonly hasQueuedTurnStart: boolean;
}): ScientGeneralChatMoveRejection | null {
  if (input.target.deletedAt !== null) {
    return {
      code: "destination-deleted",
      detail: `Project '${input.target.id}' is deleted and cannot receive a General Chat.`,
    };
  }
  if (input.thread.projectId !== null) {
    return {
      code: "already-project-owned",
      detail: `Thread '${input.thread.id}' already belongs to a project and cannot be relocated again.`,
    };
  }
  if (input.thread.session !== null && input.thread.session.status !== "stopped") {
    return {
      code: "provider-active",
      detail: `${GENERAL_CHAT_MOVE_SESSION_STOP_PENDING}: Thread '${input.thread.id}' provider session must be stopped before relocation.`,
    };
  }
  if (input.thread.latestTurn?.state === "running" || input.hasQueuedTurnStart) {
    return {
      code: "work-in-flight",
      detail: `Thread '${input.thread.id}' still has work in flight and cannot be relocated.`,
    };
  }
  return null;
}
