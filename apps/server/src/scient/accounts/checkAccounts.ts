import {
  AccountsError,
  DEFAULT_BROWSER_PROFILE_ID,
  ProviderInstanceId,
  ThreadId,
  type AccountCheckState,
  type AccountSummary,
  type AccountsCheckInput,
  type EnvironmentId,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import { automaticSignInOnHold, isGoogleSessionRow } from "./AccountDecisions.ts";
import { AccountsService, type AccountSessionScope } from "./AccountsService.ts";
import { AccountCookies } from "./agent/cookies.ts";
import { classifyProfilePage } from "./agent/profileClassification.ts";
import { ProfileDetection, profileDetectionScript } from "./agent/profileDetection.ts";
import { guardedSignIn } from "./agent/guardedSignIn.ts";
import { matchesAccountOrigin } from "./signIn/origin.ts";

/** A page that a library proxy can reach only when the user's library session is live. */
const LIBRARY_TEST_PAGE = "https://www.nature.com/";
const MAX_CHECKED = 40;
const PAUSE_MS = 1_500;

const decodePage = Schema.decodeUnknownEffect(ProfileDetection);
const decodeCookies = Schema.decodeUnknownEffect(AccountCookies);

/** The user's own check is not an agent's use, so it runs under its own identity. */
const CHECK_THREAD = ThreadId.make("scient-accounts-check");
const session: AccountSessionScope = {
  threadId: CHECK_THREAD,
  projectId: undefined,
  unattended: true,
};

const run = Semaphore.makeUnsafe(1);

/** The browser identity of something the user asked for, which is no agent's run. */
export const userRunInvocation = (threadId: ThreadId, environmentId: EnvironmentId) => ({
  environmentId,
  threadId,
  providerSessionId: `user-run:${threadId}`,
  providerInstanceId: ProviderInstanceId.make("scient"),
  capabilities: new Set(["preview", "accounts"] as const),
  issuedAt: 0,
});

const siteUrl = (site: string) => (site.startsWith("https://") ? site : `https://${site}`);

/** Where the account's session shows. Many sign-in pages stay up for a signed-in user. */
export const checkAddress = (account: AccountSummary) => {
  const { details } = account;
  if (details.kind === "library")
    return details.proxyUrl?.replace("{url}", encodeURIComponent(LIBRARY_TEST_PAGE));
  if (details.kind !== "website") return undefined;
  const site = details.sites[0];
  return site === undefined ? details.loginUrl : siteUrl(site);
};

/** Sign-ins with a known history. Imported password lists are checked one at a time, on request. */
export const worthChecking = (account: AccountSummary) =>
  checkAddress(account) !== undefined &&
  (account.details.kind === "library" ||
    account.secrets.password === undefined ||
    account.lastUsedAt !== undefined ||
    account.lastSignInOutcome !== undefined);

export function sessionState(
  account: Pick<AccountSummary, "details" | "lastSignInOutcome" | "secrets">,
  url: string,
  page: ProfileDetection,
  hasSessionCookie: boolean,
): AccountCheckState {
  const { details } = account;
  if (page.limited) return "limited";
  if (details.kind === "library") {
    if (page.deniedText) return "unknown";
    return page.passwordField || matchesAccountOrigin(page.finalUrl, details.sites)
      ? "signed-out"
      : "signed-in";
  }
  const result = classifyProfilePage(url, page);
  if (result === "sign-in") return "signed-out";
  if (result !== "opens") return "unknown";
  if (page.signOutLink) return "signed-in";
  if (page.signInLink) return "signed-out";
  // Anonymous visitors get protected cookies too, so one proves nothing about a new sign-in.
  const knownSession =
    account.lastSignInOutcome === "signed-in" || account.secrets.password === undefined;
  return hasSessionCookie && knownSession ? "signed-in" : "unknown";
}

const checkOne = Effect.fn("AccountsCheck.one")(function* (listed: AccountSummary, url: string) {
  const accounts = yield* AccountsService;
  // A run can take minutes, and an agent's result since then decides whether to sign in.
  const account =
    (yield* accounts.snapshot).accounts.find((item) => item.accountId === listed.accountId) ??
    listed;
  const broker = yield* PreviewAutomationBroker;
  const scope = yield* AgentInvocationContext;
  const invoke = <A>(
    operation: Parameters<typeof broker.invoke>[0]["operation"],
    input: unknown,
    tabId?: PreviewTabId,
  ) =>
    broker
      .invoke<A>({
        scope,
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
              message: error.message || "The browser could not open this site.",
            }),
        ),
      );
  // A tab without a profile is a throwaway session, so name the one the account lives in.
  const browser = yield* invoke<PreviewAutomationStatus>("status", {});
  const opened = yield* invoke<PreviewAutomationStatus>("open", {
    url,
    profileId:
      ("profileId" in account.details ? account.details.profileId : undefined) ??
      browser.defaultProfileId ??
      DEFAULT_BROWSER_PROFILE_ID,
    open: false,
    reuseExistingTab: false,
  });
  const tabId = opened.tabId;
  if (!tabId)
    return yield* new AccountsError({
      reason: "unavailable",
      message: "No browser tab is available.",
    });
  const tabs = new Set<PreviewTabId>([tabId]);
  return yield* Effect.gen(function* () {
    yield* invoke("accountWaitForLoad", {}, tabId);
    const page = yield* decodePage(
      yield* invoke<unknown>("evaluate", { expression: profileDetectionScript }, tabId),
    );
    const cookies = yield* invoke<unknown>("accountCookies", { urls: [page.finalUrl] }, tabId).pipe(
      Effect.flatMap(decodeCookies),
      Effect.orElseSucceed(() => []),
    );
    const state = sessionState(
      account,
      url,
      page,
      cookies.some((cookie) => cookie.httpOnly),
    );
    const onHold = automaticSignInOnHold(account, yield* Clock.currentTimeMillis);
    if (state !== "signed-out" || account.secrets.password === undefined || onHold) {
      // A hold keeps its own explanation, unless the row would otherwise go on saying signed in.
      if (onHold && state === "signed-out" && account.lastCheck?.state !== "signed-in") return;
      return yield* accounts.recordCheck(account.accountId, {
        state,
        ...(state === "unknown" ? { message: "Couldn't tell from the site's page." } : {}),
        ...(state === "limited"
          ? { message: "The site is limiting access from this network." }
          : {}),
      });
    }
    const result = yield* guardedSignIn(session, account, {
      tabId,
      automatic: true,
      authorized: true,
      engine: { userRun: true },
    });
    if ("tabId" in result) tabs.add(result.tabId);
  }).pipe(
    Effect.ensuring(
      Effect.forEach(tabs, (tab) => invoke("close", {}, tab).pipe(Effect.ignore), {
        discard: true,
      }),
    ),
  );
});

const runCheck = Effect.fn("AccountsCheck.run")(function* (input: AccountsCheckInput) {
  const accounts = yield* AccountsService;
  const snapshot = yield* accounts.snapshot;
  const chosen = snapshot.accounts
    .filter((account) =>
      input.accountId === undefined
        ? worthChecking(account)
        : account.accountId === input.accountId,
    )
    // Google says itself whether these work (`accounts.googleSessions.seen`).
    .filter((account) => !isGoogleSessionRow(account))
    .slice(0, MAX_CHECKED);
  yield* Effect.forEach(
    chosen,
    (account, index) =>
      Effect.gen(function* () {
        const url = checkAddress(account);
        if (url === undefined) return;
        if (index > 0) yield* Effect.sleep(PAUSE_MS);
        yield* checkOne(account, url).pipe(
          Effect.catch((error) =>
            accounts.recordCheck(account.accountId, {
              state: "unknown",
              message: error.message || "The browser could not open this site.",
            }),
          ),
        );
      }),
    { discard: true },
  );
  return chosen.length;
});

/**
 * Opens each browser sign-in in its own profile, one at a time, and keeps what it found on the
 * account. A signed-out account with a saved password gets one unattended sign-in; one the site
 * already rejected gets none. Runs only when the user asks.
 */
export const checkAccounts = (input: AccountsCheckInput, environmentId: EnvironmentId) =>
  runCheck(input).pipe(
    Effect.provideService(AgentInvocationContext, userRunInvocation(CHECK_THREAD, environmentId)),
    run.withPermitsIfAvailable(1),
    Effect.map(Option.getOrElse(() => 0)),
  );
