import type { AccountControls, GrantScope, ProjectId } from "@t3tools/contracts";

/** What an agent's use of an account or browser profile comes to, Ask aside. */
export type AccountAuthorization =
  | { readonly decision: "allowed" }
  | {
      readonly decision: "denied";
      readonly reason: "off" | "declined" | "out-of-scope" | "timed-out";
    };

export type AccountAccessControls = Pick<AccountControls, "access" | "scope" | "allowedProjects">;

export const inScope = (scope: GrantScope, projectId: ProjectId | undefined) =>
  scope.type === "all-projects" ||
  (projectId !== undefined && scope.projectIds.includes(projectId));

export const agentAccessOff = (enabled: boolean, access: AccountControls["access"]) =>
  !enabled || access === "off";

/**
 * Whether an agent may use something now: the global switch, Off, the project scope, Allowed or
 * allowed for this project, then Ask. `granted` is a once-grant for this conversation, which only
 * the server keeps; it turns Ask into Allowed.
 */
export const authorizationDecision = (
  enabled: boolean,
  controls: AccountAccessControls,
  scope: { readonly projectId: ProjectId | undefined; readonly unattended: boolean },
  granted = false,
): AccountAuthorization | { readonly decision: "ask" } => {
  if (agentAccessOff(enabled, controls.access)) return { decision: "denied", reason: "off" };
  if (!inScope(controls.scope, scope.projectId))
    return { decision: "denied", reason: "out-of-scope" };
  if (
    granted ||
    controls.access === "allowed" ||
    (scope.projectId !== undefined && controls.allowedProjects?.includes(scope.projectId))
  )
    return { decision: "allowed" };
  return scope.unattended ? { decision: "denied", reason: "declined" } : { decision: "ask" };
};
