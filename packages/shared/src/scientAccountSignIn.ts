import type { AccountSignIn, AccountSignInState, AccountSummary } from "@t3tools/contracts";
import { loginGroups, loginUserKey } from "./scientLoginIdentity.ts";
import { anySiteMatches, siteMatchesUrl } from "./scientSiteMatch.ts";
import { membershipKeys } from "./scientUniversityGroups.ts";
import { parseUrl } from "./url.ts";

const LIMITED_PAUSE_MS = 60 * 60 * 1000;
const RETRY_PAUSE_MS = 15 * 60 * 1000;
const FIRST_RETRY_MS = 30 * 60 * 1000;
const LATER_RETRY_MS = 24 * 60 * 60 * 1000;
/** A look that finds the same state again is written this often, to date it without constant writes. */
const LOOK_WRITE_MS = 60 * 60 * 1000;

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

/** An attempt that didn't sign in, however long ago: the row offers Sign in again. */
export const signInStopped = (signIn: AccountSignIn | undefined) =>
  signIn !== undefined && ATTEMPT_STATES.has(signIn.state);

/**
 * The person signed this university out themselves. Only their own Sign in (`press`) lifts it:
 * Scient never signs back in by itself, and no look or other attempt replaces it, even one that
 * was under way when they signed out.
 */
export const signedOutOnPurpose = (signIn: AccountSignIn | undefined) =>
  signIn?.state === "signed-out" && signIn.by === "action";

/** A stop that says nothing about what's saved: it lifts by itself after a while. */
const retryable = (account: SignInFields) =>
  account.signIn?.state === "failed" ||
  (account.signIn?.state === "code-rejected" && !signInRefused(account));

/**
 * Whether Scient must not sign in by itself now. A refusal of what's saved, or a refused password
 * (`refusedAt`), waits for a new value; a failure lifts after 30 minutes, then a day after each
 * later one; a limit after its hour; `needs-you` only once someone is there (`attended`). The
 * person's own press always runs.
 */
export const signInHeld = (account: SignInFields, nowMs: number, attended = false) => {
  const { signIn } = account;
  // A password the site refused waits for a new one, whatever its sessions show since.
  if (account.secrets?.["password"]?.refusedAt !== undefined) return true;
  if (!signInStopped(signIn)) return false;
  if (signInRefused(account)) return true;
  if (signIn!.state === "limited") return within(signIn, LIMITED_PAUSE_MS, nowMs);
  if (signIn!.state === "needs-you") return !attended;
  return within(signIn, (signIn!.failures ?? 1) > 1 ? LATER_RETRY_MS : FIRST_RETRY_MS, nowMs);
};

/** True while Scient must not sign in by itself: held, or signed in moments ago. */
export const automaticSignInOnHold = (account: SignInFields, nowMs: number, attended = false) =>
  signInHeld(account, nowMs, attended) || signedInMomentsAgo(account, nowMs);

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

/** Of a page's rows, the profile's, else those of no profile, else another profile's sole one. */
function forProfile<A extends SignInRow>(fitting: ReadonlyArray<A>, profileId: string) {
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
  return forProfile(
    matchingSignIns(accounts, url, profileId).filter((row) => row.secrets.password !== undefined),
    profileId,
  );
}

/** What the person may sign in with on a tab, by the same profile rule: rows with something to type. */
export function signInsForTab<A extends SignInRow>(
  accounts: ReadonlyArray<A>,
  url: string,
  profileId: string,
) {
  return forProfile(
    matchingSignIns(accounts, url, profileId).filter(
      ({ details, secrets }) =>
        details.kind === "website" &&
        (secrets.password !== undefined ||
          (details.username !== undefined && details.origin !== "browser-session")),
    ),
    profileId,
  );
}

/** Each choice's label: its username, with where it signs in when two choices share one. */
export function signInChoiceLabels(
  choices: ReadonlyArray<Pick<SignInRow, "accountId" | "details">>,
) {
  const name = ({ details }: (typeof choices)[number]) =>
    (details.kind === "website" ? details.username : undefined) ?? "";
  const place = ({ details }: (typeof choices)[number]) => {
    if (details.kind !== "website") return "";
    const address = parseUrl(details.loginUrl ?? "");
    if (address) return `${address.host}${address.pathname === "/" ? "" : address.pathname}`;
    const site = details.sites[0] ?? "";
    return parseUrl(site.includes("://") ? site : `https://${site}`)?.host ?? site;
  };
  return new Map(
    choices.map((choice) => {
      const shared = choices.filter((other) => name(other) === name(choice)).length > 1;
      const label = [name(choice), shared ? place(choice) : ""].filter(Boolean).join(" · ");
      return [choice.accountId, label] as const;
    }),
  );
}

const originOf = (url: string) => parseUrl(url)?.origin ?? url;

type WebsiteRow = Extract<SignInRow["details"], { kind: "website" }>;

/** Where a row that is not a login signs in, and who. */
function siteAttemptKey(details: WebsiteRow, username: string) {
  const learned = details.sites.find((site) => site.startsWith("https://"));
  return `${originOf(details.loginUrl ?? learned ?? `https://${details.sites[0] ?? ""}`)}|${username}`;
}

/**
 * One real site and identity, for one attempt at a time and one fallback a day: a university's
 * rows, and any login copied beside them, their membership (`membershipKeys`); a login's copies
 * their group's (the login identity); any other row its site and username, compared as logins
 * compare them (`loginUserKey`).
 */
export function attemptKeys(rows: ReadonlyArray<AccountSummary>) {
  const memberships = membershipKeys(rows);
  const groupOf = new Map(memberships);
  for (const group of loginGroups(rows)) {
    // A login copied beside a university row signs in as that membership.
    const key =
      group.map((row) => memberships.get(row.accountId)).find(Boolean) ??
      `login|${group.map((row) => row.accountId).sort()[0]}`;
    for (const row of group) groupOf.set(row.accountId, key);
  }
  return ({ accountId, details }: Pick<SignInRow, "accountId" | "details">) =>
    groupOf.get(accountId) ??
    (details.kind === "website"
      ? siteAttemptKey(details, loginUserKey(details.username))
      : accountId);
}

/**
 * The one way an account's sign-in state changes: after a finished sign-in (`attempt`, written
 * `by: "action"` with a new `at` every time; `press` when the person signed in themselves) or a
 * look at the site (`look`, which writes nothing when it finds the same state within the hour).
 * Returns `summary` itself when nothing changes.
 */
export const withSignIn = (
  summary: AccountSummary,
  next: AccountSignIn,
  nowMs: number,
  source: "attempt" | "press" | "look",
): AccountSummary => {
  if (source !== "press" && signedOutOnPurpose(summary.signIn)) return summary;
  // A refusal outlasts every look, a working session included: none says the saved password works.
  if (source === "look" && signInRefused(summary)) return summary;
  // Only a working session seen replaces a hold by a look; nothing else seen is a user action.
  if (source === "look" && next.state !== "signed-in" && signInStopped(summary.signIn))
    return summary;
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
    summary.signIn.unreachable === next.unreachable &&
    within(summary.signIn, LOOK_WRITE_MS, nowMs)
  )
    return summary;
  // Failures in a row space out their retries; anything else starts the count again.
  const failures =
    source !== "look" && retryable({ secrets: summary.secrets, signIn: { ...next, state } })
      ? (summary.signIn && retryable(summary) ? (summary.signIn.failures ?? 1) : 0) + 1
      : undefined;
  const { failures: _failures, ...seen } = next;
  return {
    ...summary,
    signIn: {
      ...seen,
      state,
      by: source === "look" ? "look" : "action",
      ...(failures === undefined ? {} : { failures }),
    },
  };
};
