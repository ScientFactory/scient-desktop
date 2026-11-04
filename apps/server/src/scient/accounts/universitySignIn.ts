import {
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountSignInAttempt,
  type AccountSummary,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";
import { signInReturn, universityDetails } from "@t3tools/shared/scientPaperLinks";
import { isIdentityPage, isLoginPlace } from "@t3tools/shared/scientSignInPage";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { anySiteMatches } from "@t3tools/shared/scientSiteMatch";

const MOST_SITES = 16;

const onOpenAthens = (url: string) =>
  URL.canParse(url) &&
  new URL(url).protocol === "https:" &&
  (new URL(url).hostname === "openathens.net" || new URL(url).hostname.endsWith(".openathens.net"));

/**
 * A sign-in service whose session a script must not take while a university is connected: any
 * sign-in or identity page, the addresses learned from the person's own sign-in, and OpenAthens.
 * It doesn't depend on what the account's list of sites still holds, so a full list can't open
 * a gap.
 */
export const isUniversitySignInService = (accounts: ReadonlyArray<AccountSummary>, url: string) => {
  if (!URL.canParse(url)) return false;
  const page = new URL(url);
  return accounts.some(({ details }) => {
    const university = universityDetails(details);
    if (!university) return false;
    return (
      onOpenAthens(url) ||
      isLoginPlace(page) ||
      isIdentityPage(page) ||
      anySiteMatches(signInOrigins(university.sites), url)
    );
  });
};

/** OpenAthens' own sign-in pages, on the way to the university's. */
const isOpenAthensSignIn = (url: string) => {
  if (!URL.canParse(url)) return false;
  const { hostname, pathname } = new URL(url);
  return (
    hostname === "login.openathens.net" ||
    (hostname === "my.openathens.net" && pathname.startsWith("/auth"))
  );
};

/** The exact addresses that asked the person to sign in, as learned from their own sign-in. */
const signInOrigins = (sites: ReadonlyArray<string>) =>
  sites.filter((site) => site.startsWith("https://"));

/**
 * A tab still on this university's sign-in, left from an earlier press: in the account's profile,
 * on a page that asked the person to sign in before. A course page or mail on the same domain is
 * never one.
 */
export const isSignInTab = (
  account: {
    readonly accountId?: AccountSummary["accountId"];
    readonly details: {
      readonly sites: ReadonlyArray<string>;
      readonly profileId?: string | undefined;
    };
  },
  tab: {
    readonly tabId?: string;
    readonly url: string | null;
    readonly profileId?: string | undefined;
  },
  attempts: ReadonlyArray<Pick<AccountSignInAttempt, "tabId" | "accountId">>,
) => {
  if (typeof tab.url !== "string" || !URL.canParse(tab.url) || signInReturn(tab.url)) return false;
  const { details } = account;
  if (tab.profileId !== (details.profileId ?? DEFAULT_BROWSER_PROFILE_ID)) return false;
  const owner = attempts.find((attempt) => attempt.tabId === tab.tabId)?.accountId;
  // Another university's sign-in in progress is theirs.
  if (owner !== undefined) return owner === account.accountId;
  if (isOpenAthensSignIn(tab.url)) return true;
  // After a restart, a tab is known by the page it shows: a sign-in page at a learned address.
  const page = new URL(tab.url);
  return (
    anySiteMatches(signInOrigins(details.sites), tab.url) &&
    (isLoginPlace(page) || isIdentityPage(page))
  );
};

/** The university's own pages and sign-in, which are never brought in through itself. */
export const isUniversityPage = (details: { readonly sites: ReadonlyArray<string> }, url: string) =>
  isOpenAthensSignIn(url) || onOpenAthens(url) || anySiteMatches(details.sites, url);

/**
 * Sites with the sign-in service added, where the person's password was asked for. Each exact
 * address is kept even under a domain the sites already cover: it is what keeps that session out
 * of scripts.
 */
export const withSignInService = (
  sites: ReadonlyArray<string>,
  seen: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const fresh = [...seen].filter((origin) => !sites.includes(origin));
  const merged = [...sites, ...fresh];
  if (merged.length <= MOST_SITES) return merged;
  // Full: the sign-in addresses stay, newest first, with the university's own domain; other
  // domains make room.
  const learned = signInOrigins(merged);
  const [home, ...domains] = merged.filter((site) => !site.startsWith("https://"));
  const kept = new Set([
    ...(home === undefined ? [] : [home]),
    ...learned.slice(-(MOST_SITES - (home === undefined ? 0 : 1))),
  ]);
  for (const domain of domains) if (kept.size < MOST_SITES) kept.add(domain);
  return merged.filter((site) => kept.has(site));
};

/** Earlier presses of Sign in left their own tabs on the university's page; one sign-in ends them all. */
export const closeLeftovers = Effect.fn("University.closeLeftovers")(function* <E, R>(
  invoke: <A>(
    operation: "status" | "close",
    input: object,
    tabId?: PreviewTabId,
  ) => Effect.Effect<A, E, R>,
  account: Parameters<typeof isSignInTab>[0],
  attempts: Parameters<typeof isSignInTab>[2],
  keep?: PreviewTabId,
) {
  const status = yield* invoke<PreviewAutomationStatus>("status", {}).pipe(Effect.option);
  const leftovers = Option.isSome(status)
    ? (status.value.tabs ?? []).filter(
        (tab) => tab.tabId !== keep && isSignInTab(account, tab, attempts),
      )
    : [];
  yield* Effect.forEach(leftovers, (tab) => invoke("close", {}, tab.tabId).pipe(Effect.ignore), {
    discard: true,
  });
  return leftovers;
});

/** A page of a university's own sign-in: OpenAthens, or an address learned from a sign-in there. */
export const onUniversitySignIn = (accounts: ReadonlyArray<AccountSummary>, url: string) =>
  isOpenAthensSignIn(url) ||
  onOpenAthens(url) ||
  accounts.some(({ details }) => {
    const university = universityDetails(details);
    return university !== undefined && anySiteMatches(signInOrigins(university.sites), url);
  });
