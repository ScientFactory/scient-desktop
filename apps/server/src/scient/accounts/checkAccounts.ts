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
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import { AccountsService, type AccountSessionScope } from "./AccountsService.ts";
import { AccountCookies } from "./agent/cookies.ts";
import { classifyProfilePage } from "./agent/profileClassification.ts";
import { ProfileDetection, profileDetectionScript } from "./agent/profileDetection.ts";
import { signIn } from "./signIn/engine.ts";
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
  account: Pick<AccountSummary, "details">,
  url: string,
  page: ProfileDetection,
  hasSessionCookie: boolean,
): AccountCheckState {
  const { details } = account;
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
  return hasSessionCookie ? "signed-in" : "unknown";
}

const checkOne = Effect.fn("AccountsCheck.one")(function* (account: AccountSummary, url: string) {
  const accounts = yield* AccountsService;
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
    const rejected = account.lastCheck?.state === "rejected";
    if (state !== "signed-out" || account.secrets.password === undefined || rejected) {
      if (rejected && state === "signed-out") return;
      return yield* accounts.recordCheck(account.accountId, {
        state,
        ...(state === "unknown" ? { message: "Couldn't tell from the site's page." } : {}),
      });
    }
    const values = yield* accounts.resolveSecrets(account.accountId, ["password", "totp"]);
    const result = yield* signIn(session, account, values, tabId, { userRun: true });
    if ("tabId" in result) tabs.add(result.tabId);
    yield* accounts.recordUse({
      target: { type: "account", accountId: account.accountId },
      action: "sign-in",
      threadId: CHECK_THREAD,
      signInOutcome: result.outcome,
      outcome: result.outcome === "signed-in" ? "ok" : "error",
    });
    if (result.outcome !== "signed-in" && "message" in result && result.message)
      yield* accounts.recordCheck(account.accountId, {
        state:
          result.outcome === "needs-user"
            ? "needs-you"
            : result.outcome === "failed"
              ? "unknown"
              : "rejected",
        message: result.message,
      });
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
    Effect.provideService(AgentInvocationContext, {
      environmentId,
      threadId: CHECK_THREAD,
      providerSessionId: "accounts-check",
      providerInstanceId: ProviderInstanceId.make("scient"),
      capabilities: new Set(["preview", "accounts"] as const),
      issuedAt: 0,
    }),
    run.withPermitsIfAvailable(1),
    Effect.map(Option.getOrElse(() => 0)),
  );
