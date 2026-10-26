import {
  defaultBrowserProfileRecord,
  type AccountApprovalDecision,
  type AccountControls,
  type AccountTarget,
  type BrowserProfileId,
  type BrowserProfileRecord,
  type GrantScope,
  type ProjectId,
} from "@t3tools/contracts";
import type { AccountAuthorization, AccountSessionScope } from "./AccountsService.ts";

type AccessControls = Pick<AccountControls, "access" | "scope" | "allowedProjects">;

export const inScope = (scope: GrantScope, projectId: ProjectId | undefined) =>
  scope.type === "all-projects" ||
  (projectId !== undefined && scope.projectIds.includes(projectId));

export const effectiveProfile = (
  profiles: ReadonlyArray<BrowserProfileRecord>,
  id: BrowserProfileId,
) => profiles.find((profile) => profile.profileId === id) ?? defaultBrowserProfileRecord(id);

export const agentAccessOff = (enabled: boolean, access: AccountControls["access"]) =>
  !enabled || access === "off";

export const authorizationDecision = (
  enabled: boolean,
  controls: AccessControls,
  scope: AccountSessionScope,
): AccountAuthorization | { readonly decision: "ask" } => {
  if (agentAccessOff(enabled, controls.access)) return { decision: "denied", reason: "off" };
  if (!inScope(controls.scope, scope.projectId))
    return { decision: "denied", reason: "out-of-scope" };
  if (
    controls.access === "allowed" ||
    (scope.projectId !== undefined && controls.allowedProjects?.includes(scope.projectId))
  )
    return { decision: "allowed" };
  return scope.unattended ? { decision: "denied", reason: "declined" } : { decision: "ask" };
};

export const applyApprovalDecision = <T extends AccessControls>(
  controls: T,
  decision: AccountApprovalDecision,
  projectId: ProjectId | undefined,
): T => {
  if (decision === "always") return { ...controls, access: "allowed" };
  if (decision === "project" && projectId !== undefined)
    return {
      ...controls,
      allowedProjects: [...new Set([...(controls.allowedProjects ?? []), projectId])],
    };
  return controls;
};

export const sameTarget = (left: AccountTarget, right: AccountTarget) =>
  left.type === "account"
    ? right.type === "account" && left.accountId === right.accountId
    : right.type === "profile" && left.profileId === right.profileId;

export const siteMatches = (sites: ReadonlyArray<string>, origin: string) => {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.origin !== origin)
      return false;
    return sites.some((site) =>
      site.startsWith("https://")
        ? new URL(site).origin === origin
        : url.hostname === site || url.hostname.endsWith(`.${site}`),
    );
  } catch {
    return false;
  }
};
