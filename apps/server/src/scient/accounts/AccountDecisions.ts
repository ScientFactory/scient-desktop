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
import type { AccountAccessControls } from "@t3tools/shared/scientAccountAuthorization";

export {
  agentAccessOff,
  authorizationDecision,
  inScope,
} from "@t3tools/shared/scientAccountAuthorization";
export {
  automaticSignInOnHold,
  signedInMomentsAgo,
  signInHeld,
  signInRefused,
  siteLimiting,
  withSignIn,
} from "@t3tools/shared/scientAccountSignIn";
import { anySiteMatches } from "@t3tools/shared/scientSiteMatch";

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

/** The row Scient keeps for a Google address in a profile. A saved password is a separate row. */
export const isGoogleSessionRow = (account: Pick<AccountSummary, "details" | "secrets">) =>
  account.details.kind === "website" &&
  account.details.username !== undefined &&
  account.details.sites.length === 1 &&
  account.details.sites[0] === GOOGLE_SITE &&
  account.secrets.password === undefined;
