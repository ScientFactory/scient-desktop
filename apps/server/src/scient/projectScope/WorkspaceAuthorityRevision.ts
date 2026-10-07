import type { ProjectId } from "@t3tools/contracts";

/** The project row and this entry are folded in the same projection transaction. */
export const PROJECT_WORKSPACE_AUTHORITY_PREFIX = "project-workspace-authority:";

export const projectWorkspaceAuthorityKey = (projectId: ProjectId, workspaceRoot: string): string =>
  `${PROJECT_WORKSPACE_AUTHORITY_PREFIX}${JSON.stringify([projectId, workspaceRoot])}`;
