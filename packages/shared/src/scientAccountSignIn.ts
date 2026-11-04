import type { AccountSignIn, AccountSignInState, AccountSummary } from "@t3tools/contracts";
import { universityDetails } from "./scientPaperLinks.ts";
import { anySiteMatches, siteMatchesUrl } from "./scientSiteMatch.ts";

const LIMITED_PAUSE_MS = 60 * 60 * 1000;
const RETRY_PAUSE_MS = 15 * 60 * 1000;
/** A look that finds the same state again is written this often, to date it without constant writes. */
const LOOK_WRITE_MS = 60 * 60 * 1000;

/** How an imported or copied session row's `unknown` detail begins. */
export const IMPORTED_FROM = "Imported from";
export const COPIED_FROM = "Copied from";

type SignInFields = Pick<AccountSummary, "signIn"> & Partial<Pick<AccountSummary, "secrets">>;

/** What a sign-in attempt leaves besides `signed-in`. A look can also find a limit or `needs-you`. */
const ATTEMPT_STATES: ReadonlySet<AccountSignInState> = new Set([
  "needs-you",
  "password-rejected",
  "code-rejected",
  "limited",
  "failed",
]);

const within = (signIn: AccountSignIn | undefined, ms: number, nowMs: number) =>
  signIn !== undefined && nowMs - Date.parse(signIn.at) < ms;

/** The site said it is limiting automation, within the hour. */
export const siteLimiting = (account: Pick<AccountSummary, "signIn">, nowMs: number) =>
  account.signIn?.state === "limited" && within(account.signIn, LIMITED_PAUSE_MS, nowMs);

/**
 * The site refused what's saved, so nothing should try it again until that changes: a rejected
 * password, or a rejected code while a code secret is saved. Only a new attempt or a save that
 * changes the password or code replaces it; nothing seen on the site does (see `withSignIn`).
 */
export const signInRefused = (account: SignInFields) =>
  account.signIn?.state === "password-rejected" ||
  // A one-time code the user typed says nothing about what's saved, and nothing here can change it.
  (account.signIn?.state === "code-rejected" && account.secrets?.totp !== undefined);

/** Signed in within 15 minutes and needed again: something keeps ending it. */
export const signedInMomentsAgo = (account: Pick<AccountSummary, "signIn">, nowMs: number) =>
  account.signIn?.state === "signed-in" && within(account.signIn, RETRY_PAUSE_MS, nowMs);

/**
 * An attempt that didn't sign in holds the sign-in until a user action resets it: signing in by
 * hand, changing the saved password or 2FA key, or pressing Sign in or Check. No timer lifts it.
 */
export const signInHeld = (signIn: AccountSignIn | undefined) =>
  signIn !== undefined && ATTEMPT_STATES.has(signIn.state);

/** True while Scient must not sign in by itself: held, or signed in moments ago. */
export const automaticSignInOnHold = (account: SignInFields, nowMs: number) =>
  signInHeld(account.signIn) || signedInMomentsAgo(account, nowMs);

type SignInRow = Pick<AccountSummary, "accountId" | "details" | "secrets" | "lastUsedAt">;

/**
 * The website sign-ins for a page, in one order: this profile's first, then those matching the
 * page's exact origin, then the most recently used.
 */
export function matchingSignIns<A extends SignInRow>(
  accounts: ReadonlyArray<A>,
  url: string,
  profileId: string,
) {
  const sameProfile = ({ details }: A) =>
    "profileId" in details && details.profileId === profileId ? 1 : 0;
  const exact = ({ details }: A) =>
    "sites" in details &&
    details.sites.some((site) => site.startsWith("https://") && siteMatchesUrl(site, url))
      ? 1
      : 0;
  return accounts
    .filter(({ details }) => details.kind === "website" && anySiteMatches(details.sites, url))
    .sort(
      (a, b) =>
        sameProfile(b) - sameProfile(a) ||
        exact(b) - exact(a) ||
        (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "") ||
        a.accountId.localeCompare(b.accountId),
    );
}

/**
 * The saved passwords Scient may type on a page in a profile: that profile's, else those of no
 * profile, else another profile's only when it is the only one for the site, so two people's
 * sign-ins never mix. More than one means the caller has to choose.
 */
export function signInsForPage<A extends SignInRow>(
  accounts: ReadonlyArray<A>,
  url: string,
  profileId: string,
) {
  const fitting = matchingSignIns(accounts, url, profileId).filter(
    (row) => row.secrets.password !== undefined,
  );
  const inProfile = (id: string | undefined) =>
    fitting.filter(
      ({ details }) => ("profileId" in details ? details.profileId : undefined) === id,
    );
  const own = inProfile(profileId);
  if (own.length) return own;
  const shared = inProfile(undefined);
  if (shared.length) return shared;
  return fitting.length === 1 ? fitting : [];
}

const originOf = (url: string) => (URL.canParse(url) ? new URL(url).origin : url);

/**
 * One real site and identity: where the sign-in happens and who. Duplicate rows, and two
 * universities on one identity provider, share it, so they share one attempt.
 */
export function attemptKey(account: Pick<AccountSummary, "details">) {
  const { details } = account;
  if (details.kind !== "website") return undefined;
  const university = universityDetails(details);
  const learned = details.sites.find((site) => site.startsWith("https://"));
  const origin = university
    ? learned
      ? originOf(learned)
      : (university.institution?.entityId ??
        (university.proxyUrl ? originOf(university.proxyUrl.replace("{url}", "")) : ""))
    : originOf(details.loginUrl ?? learned ?? `https://${details.sites[0] ?? ""}`);
  return `${origin}|${(details.username ?? "").toLowerCase()}`;
}

/**
 * The one way an account's sign-in state changes: after a finished sign-in (`attempt`, written
 * `by: "action"` with a new `at` every time) or a look at the site (`look`, which writes nothing when
 * it finds the same state within the hour). Returns `summary` itself when nothing changes.
 */
export const withSignIn = (
  summary: AccountSummary,
  next: AccountSignIn,
  nowMs: number,
  source: "attempt" | "look",
): AccountSummary => {
  // A refusal outlasts every look, a working session included: none says the saved password works.
  if (source === "look" && signInRefused(summary)) return summary;
  // Only a working session seen replaces a hold by a look; nothing else seen is a user action.
  if (source === "look" && next.state !== "signed-in" && signInHeld(summary.signIn)) return summary;
  // While the site is limiting, only a session seen working, or a refusal, replaces the limit.
  if (
    next.state !== "signed-in" &&
    !signInRefused({ secrets: summary.secrets, signIn: next }) &&
    siteLimiting(summary, nowMs)
  )
    return summary;
  // Ended moments after signing in: saying only "signed out" would lift the hold on signing back in.
  const state =
    next.state === "signed-out" && signedInMomentsAgo(summary, nowMs) ? "needs-you" : next.state;
  if (
    source === "look" &&
    summary.signIn?.state === state &&
    within(summary.signIn, LOOK_WRITE_MS, nowMs)
  )
    return summary;
  return { ...summary, signIn: { ...next, state, by: source === "attempt" ? "action" : "look" } };
};
