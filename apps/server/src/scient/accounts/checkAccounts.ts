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
import { browserFailure, previewInvoker } from "./agent/broker.ts";
import { isIdentityPage, isLoginPlace } from "@t3tools/shared/scientSignInPage";
import {
  OPEN_ATHENS_CHECK_PAGE,
  openAthensAnswerScript,
  openAthensCheckScript,
  signInReturn,
  universityDetails,
  universitySignInLink,
  usesOpenAthens,
} from "@t3tools/shared/scientPaperLinks";
import { AccountCookies } from "./agent/cookies.ts";
import { classifyProfilePage } from "./agent/profileClassification.ts";
import { ProfileDetection, profileDetectionScript } from "./agent/profileDetection.ts";
import { guardedSignIn } from "./agent/guardedSignIn.ts";
import { matchesAccountOrigin } from "./signIn/origin.ts";

const MAX_CHECKED = 40;
const PAUSE_MS = 1_500;
/** A university's sign-in service answers with a page that posts itself onward. */
const UNIVERSITY_LOOKS = 12;
const STEADY_LOOKS = 4;
/** OpenAthens answers its own check in well under a second. */
const OPEN_ATHENS_LOOKS = 10;

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

const openAthensUniversity = (account: Pick<AccountSummary, "details">) => {
  const institution = universityDetails(account.details)?.institution;
  return institution !== undefined && usesOpenAthens(institution);
};

/**
 * Where the account's session shows. Many sign-in pages stay up for a signed-in user. OpenAthens
 * says itself whether the person is signed in, so its universities are asked there, and no
 * journal is involved.
 */
export const checkAddress = (account: AccountSummary) => {
  const { details } = account;
  if (openAthensUniversity(account)) return OPEN_ATHENS_CHECK_PAGE;
  const university = universityDetails(details);
  if (university) return universitySignInLink(university);
  if (details.kind !== "website") return undefined;
  const site = details.sites[0];
  return site === undefined ? details.loginUrl : siteUrl(site);
};

/** Sign-ins with a known history. Imported password lists are checked one at a time, on request. */
export const worthChecking = (account: AccountSummary) =>
  checkAddress(account) !== undefined &&
  (universityDetails(account.details) !== undefined ||
    account.secrets.password === undefined ||
    account.lastUsedAt !== undefined ||
    account.lastSignInOutcome !== undefined);

/**
 * Only a link that came back counts. A directory link goes to the university's sign-in service on
 * any network, so coming back means that session is alive. A library link may be waved through by
 * the network alone, unless it came back on the library's own address.
 */
const universitySessionState = (
  details: NonNullable<ReturnType<typeof universityDetails>>,
  page: ProfileDetection,
): AccountCheckState => {
  if (page.deniedText) return "unknown";
  const back = signInReturn(page.finalUrl);
  if (back) return details.institution || back === "proxied" ? "signed-in" : "unknown";
  if (!URL.canParse(page.finalUrl)) return "unknown";
  const stopped = new URL(page.finalUrl);
  return page.passwordField ||
    matchesAccountOrigin(page.finalUrl, details.sites) ||
    isIdentityPage(stopped) ||
    isLoginPlace(stopped)
    ? "signed-out"
    : "unknown";
};

export function sessionState(
  account: Pick<AccountSummary, "details" | "lastSignInOutcome" | "secrets">,
  url: string,
  page: ProfileDetection,
  hasSessionCookie: boolean,
): AccountCheckState {
  const { details } = account;
  if (page.limited) return "limited";
  const university = universityDetails(details);
  if (university) return universitySessionState(university, page);
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

/** A check that can't tell leaves a university's last known state, with the date it was seen. */
const keepsLastSeen = (account: AccountSummary, state: AccountCheckState) =>
  state === "unknown" &&
  universityDetails(account.details) !== undefined &&
  account.lastCheck?.state === "signed-in";

/** OpenAthens' own answer, read from its page in the person's profile. */
const askOpenAthens = Effect.fn("AccountsCheck.openAthens")(function* (
  invoke: <A>(
    operation: "evaluate",
    input: unknown,
    tabId?: PreviewTabId,
  ) => Effect.Effect<A, AccountsError>,
  tabId: PreviewTabId,
) {
  yield* invoke<unknown>("evaluate", { expression: openAthensCheckScript }, tabId);
  for (let look = 0; look < OPEN_ATHENS_LOOKS; look++) {
    yield* Effect.sleep("300 millis");
    const answer = yield* invoke<unknown>(
      "evaluate",
      { expression: openAthensAnswerScript },
      tabId,
    ).pipe(Effect.orElseSucceed(() => null));
    if (answer === true) return "signed-in" as const;
    if (answer === false) return "signed-out" as const;
    if (answer === "unclear") break;
  }
  return "unknown" as const;
});

const checkOne = Effect.fn("AccountsCheck.one")(function* (listed: AccountSummary, url: string) {
  const accounts = yield* AccountsService;
  // A run can take minutes, and an agent's result since then decides whether to sign in.
  const account =
    (yield* accounts.snapshot).accounts.find((item) => item.accountId === listed.accountId) ??
    listed;
  const broker = yield* PreviewAutomationBroker;
  const scope = yield* AgentInvocationContext;
  const invoke = previewInvoker(broker, scope, {
    updateCurrentTab: false,
    mapError: browserFailure("The browser could not open this site."),
  });
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
    const look = invoke<unknown>("evaluate", { expression: profileDetectionScript }, tabId).pipe(
      Effect.flatMap(decodePage),
    );
    const readPage = Effect.gen(function* () {
      let page: ProfileDetection | undefined;
      if (universityDetails(account.details)) {
        let steady = 0;
        for (let turn = 0; turn < UNIVERSITY_LOOKS; turn++) {
          const seen = yield* look.pipe(Effect.option);
          const next = Option.getOrUndefined(seen);
          steady = next && next.finalUrl === page?.finalUrl ? steady + 1 : 0;
          page = next ?? page;
          if (next && (signInReturn(next.finalUrl) || next.passwordField || steady >= STEADY_LOOKS))
            break;
          yield* invoke("accountWaitForLoad", { settleMs: 1000 }, tabId).pipe(Effect.ignore);
        }
      }
      page ??= yield* look;
      const cookies = yield* invoke<unknown>(
        "accountCookies",
        { urls: [page.finalUrl] },
        tabId,
      ).pipe(
        Effect.flatMap(decodeCookies),
        Effect.orElseSucceed(() => []),
      );
      return sessionState(
        account,
        url,
        page,
        cookies.some((cookie) => cookie.httpOnly),
      );
    });
    const openAthens = openAthensUniversity(account);
    const state: AccountCheckState = openAthens
      ? yield* askOpenAthens(invoke, tabId)
      : yield* readPage;
    const onHold = automaticSignInOnHold(account, yield* Clock.currentTimeMillis);
    if (keepsLastSeen(account, state)) return;
    if (state !== "signed-out" || account.secrets.password === undefined || onHold) {
      // A hold keeps its own explanation, unless the row would otherwise go on saying signed in.
      if (onHold && state === "signed-out" && account.lastCheck?.state !== "signed-in") return;
      return yield* accounts.recordCheck(account.accountId, {
        state,
        ...(state === "unknown"
          ? {
              message: openAthens
                ? "OpenAthens didn't answer."
                : "Couldn't tell from the site's page.",
            }
          : {}),
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
    // Nothing reached the site, so nothing else says what was seen here.
    else yield* accounts.recordCheck(account.accountId, { state, message: result.message });
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
            keepsLastSeen(account, "unknown")
              ? Effect.void
              : accounts.recordCheck(account.accountId, {
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

/** One account looked at now, in a hidden tab, for a sign-in that just finished. */
export const checkAccountNow = (account: AccountSummary, environmentId: EnvironmentId) => {
  const url = checkAddress(account);
  return url === undefined
    ? Effect.void
    : checkOne(account, url).pipe(
        Effect.provideService(
          AgentInvocationContext,
          userRunInvocation(CHECK_THREAD, environmentId),
        ),
      );
};

/**
 * Opens each browser sign-in in its own profile, one at a time, and keeps what it found on the
 * account. A signed-out account with a saved password gets one unattended sign-in; one the site
 * already rejected gets none. Runs only when the user asks.
 */
export const checkAccounts = (input: AccountsCheckInput, environmentId: EnvironmentId) =>
  runCheck(input).pipe(
    Effect.provideService(AgentInvocationContext, userRunInvocation(CHECK_THREAD, environmentId)),
    run.withPermitsIfAvailable(1),
    Effect.map(
      Option.match({
        onNone: () => ({ checked: 0, alreadyRunning: true }),
        onSome: (checked) => ({ checked }),
      }),
    ),
  );
