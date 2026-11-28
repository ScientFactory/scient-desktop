import {
  defaultBrowserProfileRecord,
  GOOGLE_SITE,
  type AccountApprovalDecision,
  type AccountSignInOutcome,
  type AccountSignInState,
  type AccountSummary,
  type AccountTarget,
  type BrowserProfileId,
  type BrowserProfileRecord,
  type ProjectId,
} from "@t3tools/contracts";
import {
  agentAccessOff,
  type AccountAccessControls,
} from "@t3tools/shared/scientAccountAuthorization";

export {
  agentAccessOff,
  authorizationDecision,
  inScope,
} from "@t3tools/shared/scientAccountAuthorization";
export {
  automaticSignInOnHold,
  signedInMomentsAgo,
  signedOutOnPurpose,
  signInHeld,
  signInRefused,
  siteLimiting,
  withSignIn,
} from "@t3tools/shared/scientAccountSignIn";
import { anySiteMatches } from "@t3tools/shared/scientSiteMatch";

/**
 * Whether a key may sit in an agent's provider variable: a provider serves every project, so the
 * key must reach every project, with agent access on.
 */
export const keyReachesProviders = (
  enabled: boolean,
  controls: Pick<AccountAccessControls, "access" | "scope">,
) => !agentAccessOff(enabled, controls.access) && controls.scope.type === "all-projects";

export const effectiveProfile = (
  profiles: ReadonlyArray<BrowserProfileRecord>,
  id: BrowserProfileId,
) => profiles.find((profile) => profile.profileId === id) ?? defaultBrowserProfileRecord(id);

export const applyApprovalDecision = <T extends AccountAccessControls>(
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

/**
 * The person's answer to turning an Off item on for agents: Always makes it Allowed; this project
 * or this conversation make it Ask, allowed there (the conversation's grant is kept apart).
 */
export const turnOnDecision = <T extends AccountAccessControls>(
  controls: T,
  decision: AccountApprovalDecision,
  projectId: ProjectId | undefined,
): T =>
  decision === "deny"
    ? controls
    : decision === "always"
      ? { ...controls, access: "allowed" }
      : applyApprovalDecision({ ...controls, access: "ask" }, decision, projectId);

export const sameTarget = (left: AccountTarget, right: AccountTarget) =>
  left.type === "account"
    ? right.type === "account" && left.accountId === right.accountId
    : right.type === "profile" && left.profileId === right.profileId;

/** `anySiteMatches` for a value that must be a bare origin, such as a page origin from the client. */
export const siteMatches = (sites: ReadonlyArray<string>, origin: string) =>
  URL.canParse(origin) && new URL(origin).origin === origin && anySiteMatches(sites, origin);

/** The state a finished sign-in leaves on the account. */
export const outcomeSignInState = (outcome: AccountSignInOutcome): AccountSignInState =>
  outcome === "needs-user" ? "needs-you" : outcome;

/** An unchanged answer from Google is written this often, to date it without constant writes. */
export const GOOGLE_RECHECK_WRITE_MS = 60 * 60 * 1000;
/** A Google sign-out stands once two of Google's answers this far apart agree. */
export const GOOGLE_OUT_CONFIRM_MS = 60_000;

/** The row Scient keeps for a Google address in a profile. A saved password is a separate row. */
export const isGoogleSessionRow = (account: Pick<AccountSummary, "details" | "secrets">) =>
  account.details.kind === "website" &&
  account.details.username !== undefined &&
  account.details.sites.length === 1 &&
  account.details.sites[0] === GOOGLE_SITE &&
  account.secrets.password === undefined;
