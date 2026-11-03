import {
  AccountsError,
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountSummary,
  type EnvironmentId,
  type PreviewAutomationStatus,
  type PreviewTabId,
  type UniversitySignInInput,
} from "@t3tools/contracts";
import {
  signInReturn,
  universityDetails,
  universitySignInLink,
} from "@t3tools/shared/scientPaperLinks";
import { isIdentityPage, isLoginPlace } from "@t3tools/shared/scientSignInPage";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { anySiteMatches } from "@t3tools/shared/scientSiteMatch";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import { AccountsService } from "./AccountsService.ts";
import { checkAccountNow, userRunInvocation } from "./checkAccounts.ts";
import { SignInDetection, signInDetectionScript } from "./signIn/detection.ts";

/** Often enough that the page the university hands back to is closed before it shows. */
const LOOK_GAP = "400 millis";
/** A person may need to find a phone, or wait for a code by email: fifteen minutes. */
const MOST_LOOKS = 2250;
const MOST_SITES = 16;

const decodeDetection = Schema.decodeUnknownEffect(SignInDetection);

/** Tabs Scient opened for a sign-in, each with the account it signs in, which it may reuse or close. */
const signInTabs = new Map<string, AccountSummary["accountId"]>();

/** The tab each sign-in is happening in, so pressing Sign in again brings it back. */
const underWay = new Map<AccountSummary["accountId"], { threadId: string; tabId: PreviewTabId }>();

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
) => {
  if (typeof tab.url !== "string" || !URL.canParse(tab.url) || signInReturn(tab.url)) return false;
  const { details } = account;
  if (tab.profileId !== (details.profileId ?? DEFAULT_BROWSER_PROFILE_ID)) return false;
  const owner = tab.tabId === undefined ? undefined : signInTabs.get(tab.tabId);
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

const invokeIn = Effect.fn("University.browser")(function* (
  threadId: UniversitySignInInput["threadId"],
  environmentId: EnvironmentId,
) {
  const broker = yield* PreviewAutomationBroker;
  return <A>(
    operation: Parameters<typeof broker.invoke>[0]["operation"],
    input: unknown,
    tabId?: PreviewTabId,
  ) =>
    broker
      .invoke<A>({
        scope: userRunInvocation(threadId, environmentId),
        operation,
        input,
        ...(tabId === undefined ? {} : { tabId }),
        updateCurrentTab: false,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new AccountsError({
              reason: "unavailable",
              message: error.message || "The browser could not open the sign-in.",
            }),
        ),
      );
});

/** Follows the person's tab until the link comes back, noting each page that asked them for something. */
const watchTab = Effect.fn("University.watchTab")(function* (
  input: UniversitySignInInput,
  environmentId: EnvironmentId,
  tabId: PreviewTabId,
) {
  const invoke = yield* invokeIn(input.threadId, environmentId);
  const asked = new Set<string>();
  for (let look = 0; look < MOST_LOOKS; look += 1) {
    const status = yield* invoke<PreviewAutomationStatus>("status", {}, tabId).pipe(Effect.option);
    if (Option.isSome(status)) {
      const tab = status.value.tabs?.find((item) => item.tabId === tabId);
      if (!tab) return undefined;
      if (tab.url && signInReturn(tab.url)) return asked;
    }
    const page = yield* invoke<unknown>(
      "evaluate",
      { expression: signInDetectionScript },
      tabId,
    ).pipe(Effect.flatMap(decodeDetection), Effect.option);
    if (
      Option.isSome(page) &&
      page.value.origin.startsWith("https://") &&
      (page.value.username || page.value.password || page.value.otp)
    )
      asked.add(page.value.origin);
    yield* Effect.sleep(LOOK_GAP);
  }
  return undefined;
});

const finish = Effect.fn("University.finish")(function* <R>(
  input: UniversitySignInInput,
  environmentId: EnvironmentId,
  tabId: PreviewTabId,
  asked: ReadonlySet<string>,
  afterSignIn: Effect.Effect<void, never, R>,
) {
  const invoke = yield* invokeIn(input.threadId, environmentId);
  // The university has answered; the page it handed back to is no sign-in, so it never stays.
  yield* invoke("close", {}, tabId).pipe(Effect.ignore);
  signInTabs.delete(tabId);
  const accounts = yield* AccountsService;
  const current = (yield* accounts.snapshot).accounts.find(
    (item) => item.accountId === input.accountId,
  );
  const details = current && universityDetails(current.details);
  if (!current || !details) return;
  const sites = withSignInService(details.sites, asked);
  if (sites.join("\n") !== details.sites.join("\n"))
    yield* accounts.save({
      accountId: current.accountId,
      name: current.name,
      details: { ...details, sites },
      secrets: {},
    });
  yield* checkAccountNow(current, environmentId).pipe(Effect.ignore);
  const seen = (yield* accounts.snapshot).accounts.find(
    (item) => item.accountId === input.accountId,
  );
  // The network can wave a library link through, but this person just signed in on the way.
  const signedIn = seen?.signIn?.state === "signed-in" || (!details.institution && asked.size > 0);
  // The check already said what it saw; a person's unfinished sign-in is no refused password.
  if (!signedIn) return;
  yield* accounts.recordUse({
    target: { type: "account", accountId: current.accountId },
    action: "sign-in",
    threadId: input.threadId,
    signInOutcome: "signed-in",
    outcome: "ok",
  });
  yield* closeLeftovers(
    invoke,
    { accountId: current.accountId, details: { ...details, sites } },
    tabId,
  );
  yield* afterSignIn;
});

/** Earlier presses of Sign in left their own tabs on the university's page; one sign-in ends them all. */
type Invoke = Effect.Success<ReturnType<typeof invokeIn>>;

const closeLeftovers = Effect.fn("University.closeLeftovers")(function* (
  invoke: Invoke,
  account: Parameters<typeof isSignInTab>[0],
  keep?: PreviewTabId,
) {
  const status = yield* invoke<PreviewAutomationStatus>("status", {}).pipe(Effect.option);
  const leftovers = Option.isSome(status)
    ? (status.value.tabs ?? []).filter((tab) => tab.tabId !== keep && isSignInTab(account, tab))
    : [];
  yield* Effect.forEach(
    leftovers,
    (tab) =>
      invoke("close", {}, tab.tabId).pipe(
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => signInTabs.delete(tab.tabId))),
      ),
    { discard: true },
  );
  return leftovers;
});

/** Watches one sign-in tab to its end, in the conversation it opened beside. */
export const followSignIn = <R>(
  input: UniversitySignInInput,
  environmentId: EnvironmentId,
  tabId: PreviewTabId,
  afterSignIn: Effect.Effect<void, never, R>,
) =>
  watchTab(input, environmentId, tabId).pipe(
    Effect.flatMap((asked) =>
      asked ? finish(input, environmentId, tabId, asked, afterSignIn) : Effect.void,
    ),
    Effect.provideService(AgentInvocationContext, userRunInvocation(input.threadId, environmentId)),
  );

/**
 * Opens the university's own sign-in beside the conversation and stays out of the way: the person
 * signs in however the university asks, and the sign-in is finished when its link comes back. The
 * tab closes the moment it does, so the person sees their university and then "Signed in".
 */
export const startUniversitySignIn = Effect.fn("University.startSignIn")(function* <R>(
  input: UniversitySignInInput,
  environmentId: EnvironmentId,
  afterSignIn: Effect.Effect<void, never, R>,
) {
  const accounts = yield* AccountsService;
  const account = (yield* accounts.snapshot).accounts.find(
    (item) => item.accountId === input.accountId,
  );
  const details = account && universityDetails(account.details);
  const link = details && universitySignInLink(details);
  if (!details || !link)
    return yield* new AccountsError({
      reason: "invalid-input",
      message: "This account has no university to sign in to.",
    });
  const invoke = yield* invokeIn(input.threadId, environmentId);
  const running = underWay.get(input.accountId);
  if (running?.threadId === input.threadId) {
    const shown = yield* invoke(
      "open",
      { tabId: running.tabId, reuseExistingTab: true, open: true },
      running.tabId,
    ).pipe(Effect.option);
    if (Option.isSome(shown)) return { tabId: running.tabId };
  }
  // A tab left on the university's page from an earlier press is the one to use.
  const status = yield* invoke<PreviewAutomationStatus>("status", {}).pipe(Effect.option);
  const leftover = Option.isSome(status)
    ? status.value.tabs?.find((tab) => isSignInTab({ accountId: input.accountId, details }, tab))
    : undefined;
  const reused = leftover
    ? yield* invoke("navigate", { url: link }, leftover.tabId).pipe(
        Effect.andThen(
          invoke(
            "open",
            { tabId: leftover.tabId, reuseExistingTab: true, open: true },
            leftover.tabId,
          ),
        ),
        Effect.as(leftover.tabId),
        Effect.option,
      )
    : Option.none<PreviewTabId>();
  const opened = Option.isSome(reused)
    ? { tabId: reused.value }
    : yield* invoke<PreviewAutomationStatus>("open", {
        url: link,
        profileId: details.profileId ?? DEFAULT_BROWSER_PROFILE_ID,
        open: true,
        reuseExistingTab: false,
      });
  const tabId = opened.tabId;
  if (!tabId)
    return yield* new AccountsError({
      reason: "unavailable",
      message: "No browser tab is available for the sign-in.",
    });
  signInTabs.set(tabId, input.accountId);
  underWay.set(input.accountId, { threadId: input.threadId, tabId });
  yield* followSignIn(input, environmentId, tabId, afterSignIn).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (underWay.get(input.accountId)?.tabId === tabId) underWay.delete(input.accountId);
      }),
    ),
    Effect.ignore,
    Effect.forkDetach,
  );
  return { tabId };
});
