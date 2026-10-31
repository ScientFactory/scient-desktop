import {
  defaultBrowserProfileRecord,
  GOOGLE_SITE,
  type AccountApprovalDecision,
  type AccountCheckState,
  type AccountControls,
  type AccountSummary,
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

/** What a finished sign-in says about the account's status. */
export const outcomeCheckState = (
  outcome: NonNullable<AccountSummary["lastSignInOutcome"]>,
): AccountCheckState =>
  outcome === "signed-in"
    ? "signed-in"
    : outcome === "needs-user"
      ? "needs-you"
      : outcome === "limited"
        ? "limited"
        : outcome === "failed"
          ? "unknown"
          : "rejected";

/** An unchanged answer from Google is written this often, to date it without constant writes. */
export const GOOGLE_RECHECK_WRITE_MS = 60 * 60 * 1000;

/** The row Scient keeps for a Google address in a profile. A saved password is a separate row. */
export const isGoogleSessionRow = (account: Pick<AccountSummary, "details" | "secrets">) =>
  account.details.kind === "website" &&
  account.details.username !== undefined &&
  account.details.sites.length === 1 &&
  account.details.sites[0] === GOOGLE_SITE &&
  account.secrets.password === undefined;

const LIMITED_PAUSE_MS = 60 * 60 * 1000;
const RETRY_PAUSE_MS = 15 * 60 * 1000;

export const siteLimiting = (account: Pick<AccountSummary, "lastCheck">, nowMs: number) =>
  account.lastCheck?.state === "limited" &&
  nowMs - Date.parse(account.lastCheck.at) < LIMITED_PAUSE_MS;

/**
 * True while Scient must not try this sign-in by itself. A refused one can lock the account, a
 * site limiting automation stays limited for longer when pushed, and one that failed or needed the
 * user will do the same again.
 */
export const signInOnHold = (
  account: Pick<AccountSummary, "lastSignInOutcome" | "lastCheck">,
  nowMs: number,
) => {
  const recent =
    account.lastCheck !== undefined && nowMs - Date.parse(account.lastCheck.at) < RETRY_PAUSE_MS;
  return (
    account.lastSignInOutcome === "password-rejected" ||
    account.lastSignInOutcome === "code-rejected" ||
    account.lastCheck?.state === "rejected" ||
    siteLimiting(account, nowMs) ||
    (recent && (account.lastCheck?.state === "needs-you" || account.lastSignInOutcome === "failed"))
  );
};
